// -----------------------------------------------------------------------------
// A simulated Pulse Hub v2 on 127.0.0.1 (never the network): a real TLS server
// with a self-signed certificate, the WebSocket upgrade at /rpc, the "shadow"
// answers of aiopulse2's protocol, and the serial-like name server. It counts
// the TCP connections and records every message it receives.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { selfSigned } from './selfSigned.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const HUB_MAC = 'aa:bb:cc:00:11:22';
export const HUB_ID = 'aabbcc001122';

/** An unmasked server frame. */
export function frame(text, opcode = 0x1) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(length, 6);
  }
  return Buffer.concat([header, payload]);
}

/** Decodes the masked client frames of a buffer: { messages, rest }. */
function decode(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 6) {
    const opcode = buffer[offset] & 0x0f;
    let length = buffer[offset + 1] & 0x7f;
    let at = offset + 2;
    if (length === 126) {
      length = buffer.readUInt16BE(at);
      at += 2;
    } else if (length === 127) {
      length = buffer.readUInt32BE(at + 4);
      at += 8;
    }
    if (buffer.length < at + 4 + length) {
      break;
    }
    const mask = buffer.subarray(at, at + 4);
    const payload = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) {
      payload[i] = buffer[at + 4 + i] ^ mask[i & 3];
    }
    messages.push({ opcode, text: payload.toString('utf8') });
    offset = at + 4 + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

/**
 * @param {object} options
 * @param {Record<string, object>} options.shades id -> { mp, is, ol, vo }
 * @param {Record<string, string>} options.names id -> name (serial port)
 */
export async function startHub({
  shades = { ABC: { mp: 100, is: true, ol: true, vo: '12.1D07' } },
  names = { ABC: 'Salon' },
  mac = HUB_MAC,
  cert = selfSigned('pulse-hub'),
} = {}) {
  const hub = {
    shades: structuredClone(shades),
    names: { ...names },
    mac,
    cert,
    connections: 0,
    serialConnections: 0,
    received: [],
    sockets: new Set(),
    /** 'normal' | 'silent' (answers no shadow) | number (HTTP status of the upgrade) */
    mode: 'normal',
    retryAfter: undefined,
    /** Moves are applied at once when true; else the shade only starts moving. */
    instant: false,
    /** What a stop does to a moving shade. */
    reported() {
      return {
        result: {
          reported: {
            name: 'Pulse Hub',
            hubId: 'H1',
            mac: hub.mac,
            firmware: { version: '1.2.3' },
            mfi: { model: 'Pulse 2' },
            shades: hub.shades,
          },
        },
      };
    },
    broadcast(text) {
      for (const socket of hub.sockets) {
        socket.write(frame(text));
      }
    },
    sendRaw(bytes) {
      for (const socket of hub.sockets) {
        socket.write(bytes);
      }
    },
    dropAll() {
      for (const socket of hub.sockets) {
        socket.destroy();
      }
    },
  };

  const onMessage = (socket, text) => {
    hub.received.push(text);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const order = json?.args?.desired?.shades;
    if (order) {
      for (const [id, what] of Object.entries(order)) {
        const shade = hub.shades[id];
        if (!shade) continue;
        if (what.movePercent !== undefined) {
          if (hub.instant) {
            shade.mp = what.movePercent;
            shade.is = true;
          } else {
            shade.is = false;
            shade.target = what.movePercent;
          }
        }
        if (what.stopShade) {
          shade.is = true;
        }
      }
      return;
    }
    if (json?.method === 'shadow' && hub.mode === 'normal') {
      const { reported } = hub.reported().result;
      const copy = structuredClone(reported);
      for (const shade of Object.values(copy.shades)) delete shade.target;
      socket.write(frame(JSON.stringify({ result: { reported: copy } })));
    }
  };

  const all = new Set();
  const track = (socket) => {
    all.add(socket);
    socket.on('close', () => all.delete(socket));
  };
  const server = createTlsServer({ key: cert.key, cert: cert.cert }, (socket) => {
    hub.connections += 1;
    track(socket);
    socket.on('error', () => {});
    let head = Buffer.alloc(0);
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (!upgraded) {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        const text = head.subarray(0, end).toString('latin1');
        const key = /sec-websocket-key: (.+)/i.exec(text)?.[1]?.trim();
        if (typeof hub.mode === 'number') {
          const retry = hub.retryAfter ? `Retry-After: ${hub.retryAfter}\r\n` : '';
          socket.end(`HTTP/1.1 ${hub.mode} No\r\n${retry}Content-Length: 0\r\n\r\n`);
          return;
        }
        if (!text.startsWith('GET /rpc HTTP/1.1') || !key) {
          socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        upgraded = true;
        hub.sockets.add(socket);
        socket.on('close', () => hub.sockets.delete(socket));
        buffer = head.subarray(end + 4);
      } else {
        buffer = Buffer.concat([buffer, chunk]);
      }
      const { messages, rest } = decode(buffer);
      buffer = rest;
      for (const message of messages) {
        if (message.opcode === 0x1) onMessage(socket, message.text);
        if (message.opcode === 0x8) socket.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  hub.port = server.address().port;

  const serial = createNetServer((socket) => {
    hub.serialConnections += 1;
    track(socket);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      for (const match of chunk.toString('latin1').matchAll(/!(\w{3})NAME\?;/g)) {
        const name = hub.names[match[1]];
        if (name) socket.write(Buffer.from(`!${match[1]}NAME${name};`, 'utf8'));
      }
    });
  });
  await new Promise((resolve) => serial.listen(0, '127.0.0.1', resolve));
  hub.serialPort = serial.address().port;

  hub.close = async () => {
    for (const socket of all) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => serial.close(resolve));
  };
  return hub;
}
