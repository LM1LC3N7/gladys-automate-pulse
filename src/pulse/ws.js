// -----------------------------------------------------------------------------
// The WebSocket of the Pulse Hub v2 (wss://<hub>:443/rpc), written by hand on
// ONE node:tls socket so that every limit is ours:
//   - the certificate of the hub is self-signed (aiopulse2 turns the check
//     off): it is pinned instead. Its SHA-256 fingerprint is compared with the
//     pin right after the TLS handshake, BEFORE any byte is written; none
//     pinned yet: the caller learns it (first use);
//   - the upgrade is written on that same socket (no http.request, no agent:
//     never a second connection, never one without the check);
//   - the answer to the upgrade is bounded (8 KB), checked (101, the accept
//     key, no extension, no subprotocol); a 429 or a 5xx is told as such;
//   - frames from the hub must not be masked, a message larger than the limit
//     closes the connection before it is buffered, control frames are small,
//     the text must be valid UTF-8, the bytes are copied once.
// No custom User-Agent (none is sent), no compression.
// The frame parser is taken from LM1LC3N7/gladys-system-bridge (same author,
// Apache-2.0).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { normalizeFingerprint } from '../config.js';
import { LIMITS } from '../constants.js';
import { PulseError, retryAfterMs } from './errors.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Frames one message may be split into. */
export const MAX_FRAGMENTS = 1_024;
/** Pings answered in a row without a message in between: beyond, the connection is closed. */
export const MAX_PINGS_IN_A_ROW = 100;
/** A pong is written only while less than this waits in the socket (a peer that does not read). */
export const MAX_PENDING_WRITE_BYTES = 64 * 1024;
const CLOSE_GRACE = 2_000;
const OPCODES = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

/**
 * Opens the WebSocket of the hub. Resolves `{ connection, fingerprint }` once
 * the upgrade is accepted; rejects with a PulseError. `pin` (a normalized
 * fingerprint, or undefined for a first use) is checked before anything is
 * written.
 */
export function openHubSocket({
  host,
  port,
  path,
  pin,
  timeoutMs,
  maxMessageBytes = LIMITS.messageBytes,
  onMessage,
  onClose,
  connect = tlsConnect,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let fingerprint;
    let head = [];
    let headBytes = 0;
    const key = randomBytes(16).toString('base64');
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    const socket = connect({
      host,
      port,
      // Self-signed: the chain cannot be checked, the pin is (below).
      rejectUnauthorized: false,
      servername: isIP(host) ? undefined : host,
    });
    const fail = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new PulseError('timeout', 'no WebSocket upgrade in time')),
      timeoutMs,
    );
    socket.on('error', (err) => {
      const kind = UNREACHABLE_CODES.has(err?.code) ? 'unreachable' : 'closed';
      fail(new PulseError(kind, `connection failed (${String(err?.code ?? 'error')})`));
    });
    socket.on('close', () => fail(new PulseError('closed', 'connection closed')));
    socket.once('secureConnect', () => {
      fingerprint = normalizeFingerprint(socket.getPeerCertificate?.()?.fingerprint256);
      if (!fingerprint) {
        fail(new PulseError('format', 'no certificate'));
        return;
      }
      if (pin && pin !== fingerprint) {
        fail(new PulseError('certificate', 'not the pinned certificate', { fingerprint }));
        return;
      }
      const hostHeader = `${isIP(host) === 6 ? `[${host}]` : host}${port === 443 ? '' : `:${port}`}`;
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`,
      );
    });
    const onData = (chunk) => {
      if (settled) {
        return;
      }
      head.push(chunk);
      headBytes += chunk.length;
      const all = Buffer.concat(head, headBytes);
      const end = all.indexOf('\r\n\r\n');
      if (end < 0) {
        if (headBytes > LIMITS.upgradeBytes) {
          fail(new PulseError('tooLarge', 'upgrade answer too large'));
        } else {
          // Kept as one buffer: at most 8 KB are ever searched again.
          head = [all];
        }
        return;
      }
      if (end > LIMITS.upgradeBytes) {
        fail(new PulseError('tooLarge', 'upgrade answer too large'));
        return;
      }
      socket.off('data', onData);
      const answer = parseHead(all.subarray(0, end).toString('latin1'));
      const rest = all.subarray(end + 4);
      if (!answer) {
        fail(new PulseError('format', 'not an HTTP answer'));
        return;
      }
      const { status, headers } = answer;
      if (status !== 101) {
        if (status === 429) {
          fail(
            new PulseError('rate', 'HTTP 429', {
              status,
              retryAfter: retryAfterMs(headers['retry-after']),
            }),
          );
        } else if (status >= 500 && status <= 599) {
          fail(
            new PulseError('server', `HTTP ${status}`, {
              status,
              retryAfter: retryAfterMs(headers['retry-after']),
            }),
          );
        } else {
          fail(new PulseError('http', `HTTP ${status} instead of a WebSocket`, { status }));
        }
        return;
      }
      const connection = String(headers.connection ?? '')
        .toLowerCase()
        .split(',')
        .map((token) => token.trim());
      if (
        String(headers.upgrade ?? '').toLowerCase() !== 'websocket' ||
        !connection.includes('upgrade') ||
        headers['sec-websocket-accept'] !== accept ||
        headers['sec-websocket-extensions'] !== undefined ||
        headers['sec-websocket-protocol'] !== undefined
      ) {
        fail(new PulseError('format', 'not a valid WebSocket upgrade'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      resolve({
        fingerprint,
        connection: new WebSocketConnection(socket, rest, { maxMessageBytes, onMessage, onClose }),
      });
    };
    socket.on('data', onData);
  });
}

/** The status and the headers (lower-case names, the first of each) of an HTTP answer head. */
export function parseHead(text) {
  const lines = text.split('\r\n');
  const match = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(lines[0] ?? '');
  if (!match || lines.length > 100) {
    return undefined;
  }
  const headers = Object.create(null);
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    if (at <= 0) {
      return undefined;
    }
    const name = line.slice(0, at).trim().toLowerCase();
    if (!(name in headers)) {
      headers[name] = line.slice(at + 1).trim();
    }
  }
  return { status: Number(match[1]), headers };
}

export class WebSocketConnection {
  #socket;
  #chunks = [];
  #head = 0;
  #offset = 0;
  #buffered = 0;
  #fragments = null;
  #fragmentBytes = 0;
  #pongPending = false;
  #partial = null;
  #pingsInARow = 0;
  #closeTimer = null;
  #finished = false;
  #decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(socket, head, { maxMessageBytes, onMessage, onClose }) {
    this.#socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.open = true;
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this.#receive(chunk));
    socket.on('error', (err) =>
      this.#finish(new PulseError('closed', `connection lost (${String(err?.code ?? 'error')})`)),
    );
    socket.on('close', () => this.#finish(new PulseError('closed', 'connection closed')));
    if (head?.length) {
      this.#receive(head);
    }
  }

  /**
   * Sends a text message. Resolves 'written' once handed to the socket,
   * 'closed' when the connection was not open (nothing left), 'failed' when
   * the write broke (some bytes may have left).
   */
  send(text) {
    if (!this.open) {
      return Promise.resolve('closed');
    }
    const frame = this.#frame(OPCODES.TEXT, Buffer.from(text, 'utf8'));
    return new Promise((resolve) => {
      try {
        this.#socket.write(frame, (err) => resolve(err ? 'failed' : 'written'));
      } catch {
        resolve('failed');
      }
    });
  }

  /** Close (normal closure), then destroy the socket if the hub does not answer. */
  close() {
    if (!this.open) {
      return;
    }
    this.open = false;
    const code = Buffer.alloc(2);
    code.writeUInt16BE(1000);
    try {
      this.#socket.write(this.#frame(OPCODES.CLOSE, code));
      this.#socket.end();
    } catch {
      // Already gone: destroyed below.
    }
    this.#closeTimer = setTimeout(() => this.#socket.destroy(), CLOSE_GRACE);
    this.#closeTimer.unref?.();
    this.#finish(new PulseError('closed', 'connection closed by Gladys'));
  }

  #finish(err) {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.open = false;
    this.#chunks = [];
    this.#head = 0;
    this.#offset = 0;
    this.#buffered = 0;
    this.#fragments = null;
    this.#partial = null;
    if (!this.#closeTimer) {
      this.#socket.destroy();
    } else {
      this.#socket.once('close', () => clearTimeout(this.#closeTimer));
    }
    try {
      this.onClose?.(err);
    } catch {
      // The owner's handler never breaks the socket handling.
    }
  }

  #fail(kind, message) {
    if (this.#finished) {
      return;
    }
    this.open = false;
    this.#socket.destroy();
    this.#finish(new PulseError(kind, message));
  }

  /** A masked client frame (RFC 6455: every client frame is masked). */
  #frame(opcode, payload) {
    const length = payload.length;
    const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
    const header = Buffer.alloc(2 + extra + 4);
    header[0] = 0x80 | opcode;
    if (extra === 0) {
      header[1] = 0x80 | length;
    } else if (extra === 2) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(length, 6);
    }
    const mask = randomBytes(4);
    mask.copy(header, 2 + extra);
    const masked = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) {
      masked[i] = payload[i] ^ mask[i & 3];
    }
    return Buffer.concat([header, masked]);
  }

  /** Copies the first `n` buffered bytes; `consume` removes them (an index, never Array.shift). */
  #read(n, consume) {
    const out = Buffer.allocUnsafe(n);
    let copied = 0;
    let index = this.#head;
    let offset = this.#offset;
    while (copied < n) {
      const chunk = this.#chunks[index];
      const take = Math.min(chunk.length - offset, n - copied);
      chunk.copy(out, copied, offset, offset + take);
      copied += take;
      offset += take;
      if (offset === chunk.length) {
        index += 1;
        offset = 0;
      }
    }
    if (consume) {
      this.#buffered -= n;
      this.#head = index;
      this.#offset = offset;
      if (this.#head >= 64 && this.#head * 2 >= this.#chunks.length) {
        this.#chunks = this.#chunks.slice(this.#head);
        this.#head = 0;
      }
    }
    return out;
  }

  #receive(chunk) {
    if (this.#finished) {
      return;
    }
    if (this.#partial) {
      // A frame whose header is known: its bytes go straight into its buffer.
      const frame = this.#partial;
      const take = Math.min(chunk.length, frame.payload.length - frame.filled);
      chunk.copy(frame.payload, frame.filled, 0, take);
      frame.filled += take;
      if (frame.filled < frame.payload.length) {
        return;
      }
      this.#partial = null;
      this.#frameReceived(frame.fin, frame.opcode, frame.payload);
      if (take === chunk.length) {
        return;
      }
      chunk = chunk.subarray(take);
      if (this.#finished) {
        return;
      }
    }
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    while (!this.#finished && this.#buffered >= 2) {
      const head = this.#read(Math.min(this.#buffered, 10), false);
      const fin = (head[0] & 0x80) !== 0;
      const opcode = head[0] & 0x0f;
      if ((head[0] & 0x70) !== 0) {
        return this.#fail('format', 'reserved bits set');
      }
      if ((head[1] & 0x80) !== 0) {
        return this.#fail('format', 'masked server frame');
      }
      if (![0x0, 0x1, 0x8, 0x9, 0xa].includes(opcode)) {
        return this.#fail('format', 'unexpected frame');
      }
      let length = head[1] & 0x7f;
      let headerLength = 2;
      if (length === 126) {
        if (head.length < 4) {
          return undefined;
        }
        length = head.readUInt16BE(2);
        headerLength = 4;
      } else if (length === 127) {
        if (head.length < 10) {
          return undefined;
        }
        if (head.readUInt32BE(2) !== 0) {
          return this.#fail('tooLarge', 'message too large');
        }
        length = head.readUInt32BE(6);
        headerLength = 10;
      }
      const control = opcode >= 0x8;
      if (control && (!fin || length > 125)) {
        return this.#fail('format', 'invalid control frame');
      }
      if (!control && this.#fragmentBytes + length > this.maxMessageBytes) {
        return this.#fail('tooLarge', 'message too large');
      }
      if (opcode === OPCODES.CONTINUATION && !fin && length === 0) {
        return this.#fail('format', 'empty continuation');
      }
      if (opcode === OPCODES.CLOSE && length === 1) {
        return this.#fail('format', 'invalid close frame');
      }
      if (this.#buffered < headerLength) {
        return undefined;
      }
      this.#read(headerLength, true);
      if (this.#buffered < length) {
        const payload = Buffer.allocUnsafe(length);
        const filled = this.#buffered;
        if (filled > 0) {
          this.#read(filled, true).copy(payload, 0);
        }
        this.#chunks = [];
        this.#head = 0;
        this.#offset = 0;
        this.#partial = { fin, opcode, payload, filled };
        return undefined;
      }
      const payload = length > 0 ? this.#read(length, true) : Buffer.alloc(0);
      this.#frameReceived(fin, opcode, payload);
    }
    return undefined;
  }

  #frameReceived(fin, opcode, payload) {
    switch (opcode) {
      case OPCODES.TEXT:
        if (this.#fragments) {
          return this.#fail('format', 'unexpected text frame');
        }
        if (fin) {
          return this.#deliver(payload);
        }
        this.#fragments = [payload];
        this.#fragmentBytes = payload.length;
        return undefined;
      case OPCODES.CONTINUATION:
        if (!this.#fragments) {
          return this.#fail('format', 'unexpected continuation');
        }
        if (this.#fragments.length >= MAX_FRAGMENTS) {
          return this.#fail('tooLarge', 'too many fragments');
        }
        this.#fragments.push(payload);
        this.#fragmentBytes += payload.length;
        if (fin) {
          const message = Buffer.concat(this.#fragments, this.#fragmentBytes);
          this.#fragments = null;
          this.#fragmentBytes = 0;
          this.#deliver(message);
        }
        return undefined;
      case OPCODES.PING:
        this.#pingsInARow += 1;
        if (this.#pingsInARow > MAX_PINGS_IN_A_ROW) {
          return this.#fail('format', 'too many pings');
        }
        if ((this.#socket.writableLength ?? 0) > MAX_PENDING_WRITE_BYTES) {
          return this.#fail('format', 'peer does not read');
        }
        if (this.open && !this.#pongPending) {
          this.#pongPending = true;
          this.#socket.write(this.#frame(OPCODES.PONG, payload), () => {
            this.#pongPending = false;
          });
        }
        return undefined;
      case OPCODES.PONG:
        return undefined;
      case OPCODES.CLOSE:
        if (this.open) {
          this.open = false;
          try {
            this.#socket.write(this.#frame(OPCODES.CLOSE, payload.subarray(0, 2)));
            this.#socket.end();
          } catch {
            // Gone already.
          }
        }
        this.#socket.destroy();
        return this.#finish(new PulseError('closed', 'connection closed by the hub'));
      default:
        return this.#fail('format', 'unexpected frame');
    }
  }

  #deliver(payload) {
    let text;
    try {
      text = this.#decoder.decode(payload);
    } catch {
      return this.#fail('format', 'invalid UTF-8');
    }
    this.#pingsInARow = 0;
    try {
      this.onMessage?.(text);
    } catch {
      // The owner's handler never breaks the frame parsing.
    }
    return undefined;
  }
}
