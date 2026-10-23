// -----------------------------------------------------------------------------
// The WebSocket client against a real TLS server on 127.0.0.1 (the simulated
// hub): one TCP connection per session, the certificate checked before any
// byte is written, the upgrade answers, the limits of the frames.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFingerprint } from '../src/config.js';
import { openHubSocket, parseHead } from '../src/pulse/ws.js';
import { frame, startHub } from './helpers/fakeHub.js';

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function open(hub, extra = {}) {
  const messages = [];
  const closes = [];
  return openHubSocket({
    host: '127.0.0.1',
    port: hub.port,
    path: '/rpc',
    timeoutMs: 3000,
    onMessage: (text) => messages.push(text),
    onClose: (err) => closes.push(err),
    ...extra,
  }).then((opened) => ({ ...opened, messages, closes }));
}

test('first use: the fingerprint is given, one TCP connection, messages both ways', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const { connection, fingerprint, messages } = await open(hub);
  assert.equal(fingerprint, normalizeFingerprint(hub.cert.fingerprint256));
  assert.equal(await connection.send('{"method":"shadow","src":"app","id":1}'), 'written');
  await until(() => messages.length === 1);
  assert.match(messages[0], /"reported"/);
  assert.equal(hub.connections, 1, 'never a second connection');
  connection.close();
  assert.equal(await connection.send('x'), 'closed');
});

test('another certificate: refused before any byte is written', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const pin = normalizeFingerprint('AB'.repeat(32));
  await assert.rejects(open(hub, { pin }), (err) => {
    assert.equal(err.kind, 'certificate');
    assert.equal(err.fingerprint, normalizeFingerprint(hub.cert.fingerprint256));
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hub.sockets.size, 0, 'no upgrade was written');
  assert.deepEqual(hub.received, []);
});

test('the pinned certificate is accepted', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const pin = normalizeFingerprint(hub.cert.fingerprint256);
  const { connection } = await open(hub, { pin });
  connection.close();
});

test('429 and 5xx on the upgrade are told as such, with Retry-After', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  hub.mode = 429;
  hub.retryAfter = '120';
  await assert.rejects(open(hub), (err) => err.kind === 'rate' && err.retryAfter === 120_000);
  hub.mode = 503;
  await assert.rejects(open(hub), (err) => err.kind === 'server' && err.status === 503);
  hub.mode = 404;
  await assert.rejects(open(hub), (err) => err.kind === 'http' && err.status === 404);
});

test('a message over the limit closes the connection before it is buffered', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const { closes } = await open(hub, { maxMessageBytes: 1024 });
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeUInt32BE(10_000_000, 6);
  hub.sendRaw(header);
  await until(() => closes.length === 1);
  assert.equal(closes[0].kind, 'tooLarge');
});

test('a masked or binary frame from the hub is refused', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const { closes } = await open(hub);
  hub.sendRaw(frame('x', 0x2));
  await until(() => closes.length === 1);
  assert.equal(closes[0].kind, 'format');
});

test('a message split into many small chunks is read once', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const { messages } = await open(hub);
  const bytes = frame(JSON.stringify({ result: { reported: { name: 'x'.repeat(3000) } } }));
  for (let i = 0; i < bytes.length; i += 7) {
    hub.sendRaw(bytes.subarray(i, i + 7));
  }
  await until(() => messages.length === 1);
  assert.equal(JSON.parse(messages[0]).result.reported.name.length, 3000);
});

test('the head of the upgrade answer is parsed strictly', () => {
  assert.equal(parseHead('HTTP/1.1 101 OK\r\nUpgrade: websocket').status, 101);
  assert.equal(parseHead('nope'), undefined);
  assert.equal(parseHead('HTTP/1.1 101 OK\r\nbroken'), undefined);
  const head = parseHead('HTTP/1.1 101 OK\r\n__proto__: x\r\nA: 1\r\nA: 2');
  assert.equal(head.headers.a, '1');
  assert.equal(Object.getPrototypeOf(head.headers), null);
});
