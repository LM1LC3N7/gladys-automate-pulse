// -----------------------------------------------------------------------------
// PulseApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a simulated hub on 127.0.0.1 (a real TLS WebSocket and
// the serial name server), a fake clock and a memory store. The timers of the
// app are recorded, never fired by themselves.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import { createServer as createNetServer } from 'node:net';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PulseApp } from '../src/app.js';
import { normalizeFingerprint } from '../src/config.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { fetchNames } from '../src/pulse/serial.js';
import { openHubSocket } from '../src/pulse/ws.js';
import { memoryStore } from '../src/store.js';
import { HUB_ID, startHub } from './helpers/fakeHub.js';

const SELECTOR = 'automate-pulse';
const id = (shade, key) => `ext:${SELECTOR}:shade:${HUB_ID}-${shade}${key ? `:${key}` : ''}`;

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

async function setup(
  t,
  {
    hub,
    store = memoryStore(),
    devices = [],
    config = {},
    connect = true,
    clock = fakeClock(),
  } = {},
) {
  hub ??= await startHub();
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { hub_address: `127.0.0.1:${hub.port}`, language: 'en', ...config },
    devices,
  });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const pins = [];
  const timeouts = [];
  const timers = {
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, at: clock.now(), cleared: false };
      timeouts.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cleared = true;
    },
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const app = new PulseApp({
    gladys,
    logger,
    store,
    now: clock.now,
    timers,
    serialPort: hub.serialPort,
    // The real serial exchange, with a short silence before it ends.
    fetchNames: (options) => fetchNames({ ...options, idle: 50 }),
    // The real client; the pin of each connection is recorded.
    openSocket: (options) => {
      pins.push(options.pin);
      return openHubSocket(options);
    },
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(async () => {
    await app.stop();
    await hub.close();
  });
  if (connect) {
    await app.connect();
    await until(() => app.session?.identity && gladys.fake.discoveredDevices.length > 0);
  }
  /** Fires the pending timers of this delay (not cleared). */
  const fire = (ms) => {
    for (const timer of timeouts.filter((x) => x.ms === ms && !x.cleared)) {
      timer.cleared = true;
      timer.fn();
    }
  };
  return { gladys, app, hub, logs, store, clock, timeouts, fire, pins };
}

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

const deviceOf = (gladys, shade) =>
  gladys.fake.devices.find((d) => d.external_id === id(shade)) ??
  gladys.fake.discoveredDevices.find((d) => d.external_id === id(shade));
const featureOf = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));
const press = async (gladys, shade, key, value) => {
  const device = deviceOf(gladys, shade);
  const ack = await gladys.fake.setValue(device, featureOf(device, key), value);
  if (!ack?.success) {
    throw new Error(String(ack?.error ?? 'failed'));
  }
};
const status = (gladys) => gladys.fake.connectionStatus;
const orders = (hub) =>
  hub.received
    .map((text) => JSON.parse(text))
    .filter((j) => j.args)
    .map((j) => j.args.desired.shades);

test('each shade becomes a shutter of the Discovery tab, named from the hub', async (t) => {
  const { gladys, hub, store } = await setup(t);
  const device = deviceOf(gladys, 'ABC');
  assert.equal(device.name, 'Salon');
  assert.deepEqual(
    device.features.map((f) => [f.external_id.split(':').at(-1), f.category, f.type]),
    [
      ['state', 'shutter', 'state'],
      ['position', 'shutter', 'position'],
      ['battery', 'battery', 'integer'],
    ],
    'never a switch nor a binary',
  );
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.en, /1 shade\(s\), 1 reachable/);
  assert.equal(hub.connections, 1);
  assert.equal(hub.serialConnections, 1);
  assert.equal(store.data.pin, normalizeFingerprint(hub.cert.fingerprint256));
  assert.equal(store.data.hub, HUB_ID);
});

test('the position and the battery are published once the device is created', async (t) => {
  const { gladys, app } = await setup(t);
  await createAll(gladys);
  await app.flush();
  const states = gladys.fake.states;
  const last = (feature) => states.filter((s) => s.device_feature_external_id === feature).at(-1);
  assert.equal(last(id('ABC', 'position')).state, 0, 'mp 100 = closed = position 0');
  assert.equal(last(id('ABC', 'battery')).state, 76);
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');
});

test('a move is written within the deadline, accepted once the hub reports it moving', async (t) => {
  const { gladys, hub, app } = await setup(t);
  await createAll(gladys);
  await press(gladys, 'ABC', 'position', 70);
  assert.deepEqual(orders(hub).at(-1), { ABC: { movePercent: 30 } });
  assert.equal(app.targets.get('ABC'), 30, 'not confirmed until a report equals it');
  // The hub gets there: the next report confirms it.
  hub.shades.ABC.mp = 30;
  hub.shades.ABC.is = true;
  app.ask(app.session.epoch);
  await until(() => !app.targets.has('ABC'));
  await press(gladys, 'ABC', 'state', 1);
  assert.deepEqual(orders(hub).at(-1), { ABC: { movePercent: 0 } });
  // Still again before the next order (a moving shade proves nothing by moving).
  hub.shades.ABC.is = true;
  app.ask(app.session.epoch);
  await until(() => !app.shades.get('ABC').moving);
  await press(gladys, 'ABC', 'state', -1);
  assert.deepEqual(orders(hub).at(-1), { ABC: { movePercent: 100 } });
  assert.equal(hub.connections, 1);
});

test('a hub that does not report: "sent, without confirmation", never "not sent"', async (t) => {
  const { gladys, hub, app, fire } = await setup(t);
  await createAll(gladys);
  hub.mode = 'silent';
  const pending = press(gladys, 'ABC', 'position', 100);
  await until(() => orders(hub).length === 1);
  fire(TIMINGS.commandAnswerBy);
  await assert.rejects(pending, /without confirmation/);
  assert.ok(app.unconfirmed.has('ABC'));
  await until(() => gladys.fake.transports.at(-1)?.degraded === true);
});

test('bad values and read-only features are refused, nothing sent', async (t) => {
  const { gladys, hub } = await setup(t);
  await createAll(gladys);
  for (const value of [null, '', true, 2, 'x']) {
    await assert.rejects(press(gladys, 'ABC', 'state', value));
  }
  await assert.rejects(press(gladys, 'ABC', 'position', 101));
  await assert.rejects(press(gladys, 'ABC', 'battery', 1), /read only|lecture seule/);
  assert.deepEqual(orders(hub), []);
});

test('STOP is written at once and confirmed by a still shade', async (t) => {
  const { gladys, hub } = await setup(t);
  await createAll(gladys);
  hub.shades.ABC.is = false;
  await press(gladys, 'ABC', 'state', 0);
  assert.deepEqual(orders(hub).at(-1), { ABC: { stopShade: true } });
});

test('STOP cancels a move waiting for the first report of a session', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { store });
  await createAll(first.gladys);
  const devices = first.gladys.fake.devices;
  await first.app.stop();
  // A restart: the hub answers nothing at first.
  const hub = first.hub;
  hub.mode = 'silent';
  const { gladys, app, clock } = await setup(t, { hub, store, devices, connect: false });
  await app.connect();
  assert.ok(app.session && !app.session.identity);
  const move = press(gladys, 'ABC', 'position', 50);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stop = press(gladys, 'ABC', 'state', 0);
  await assert.rejects(move, /stop|arrÃªt/i);
  // The STOP left before any report (the hub of the device is the one kept in /data).
  await until(() => orders(hub).some((o) => o.ABC?.stopShade));
  assert.ok(!orders(hub).some((o) => o.ABC?.movePercent === 50), 'the move never left');
  hub.mode = 'normal';
  // The requests left unanswered: a new one only a second later (one at a time).
  clock.advance(TIMINGS.askGap);
  app.ask(app.session.epoch);
  await stop;
});

test('another certificate: final stop, nothing written, lifted by two presses', async (t) => {
  const store = memoryStore({ pin: 'AB'.repeat(32) });
  const { gladys, app, hub, timeouts } = await setup(t, { store, connect: false });
  const pending = timeouts.length;
  assert.equal(await app.connect(), false);
  const fingerprint = normalizeFingerprint(hub.cert.fingerprint256);
  assert.deepEqual(store.data.certChanged, { fingerprint });
  assert.equal(hub.sockets.size, 0);
  assert.deepEqual(hub.received, []);
  await until(() => status(gladys)?.message.en.includes(fingerprint));
  assert.equal(status(gladys).connected, false);
  assert.equal(timeouts.length, pending, 'never tried again by itself');
  // A configuration saved unchanged lifts nothing.
  await gladys.fake.configUpdated({ hub_address: `127.0.0.1:${hub.port}` });
  assert.ok(store.data.certChanged);
  assert.match(await app.trustCertificate().then((m) => m.en), /Press again/);
  assert.match(await app.trustCertificate().then((m) => m.en), /trusted/);
  assert.equal(store.data.pin, fingerprint);
  assert.equal(store.data.certChanged, null);
  assert.equal(await app.connect(), true);
});

test('a typed fingerprint equal to the one met lifts the stop', async (t) => {
  const store = memoryStore({ pin: 'AB'.repeat(32) });
  const { app, hub } = await setup(t, { store, connect: false });
  await app.connect();
  assert.ok(store.data.certChanged);
  await app.configUpdated({
    hub_address: `127.0.0.1:${hub.port}`,
    certificate_fingerprint: hub.cert.fingerprint256,
  });
  assert.equal(store.data.certChanged, null);
  assert.equal(await app.connect(), true);
});

test('429 on the upgrade: a pause kept in /data; STOP still makes one try', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { store });
  await createAll(first.gladys);
  const devices = first.gladys.fake.devices;
  await first.app.stop();
  const hub = first.hub;
  hub.mode = 429;
  hub.retryAfter = '600';
  const { gladys, app, clock } = await setup(t, { hub, store, devices, connect: false });
  clock.advance(10 * 60_000);
  await app.connect();
  assert.equal(store.data.pause.until, clock.now() + 600_000);
  await until(() => /asked to wait/.test(gladys.fake.connectionStatus?.message.en));
  const before = hub.connections;
  assert.equal(await app.testConnection().then(() => hub.connections), before, 'no try');
  await assert.rejects(press(gladys, 'ABC', 'state', 0), /not connected|pas connectÃ©/);
  assert.equal(hub.connections, before + 1, 'exactly one try for the STOP');
  // Another click right after: no new connection within 5 s (review m8).
  await assert.rejects(press(gladys, 'ABC', 'state', 0), /not connected|pas connectÃ©/);
  assert.equal(hub.connections, before + 1);
  clock.advance(TIMINGS.stopConnectEvery);
  await assert.rejects(press(gladys, 'ABC', 'state', 0), /not connected|pas connectÃ©/);
  assert.equal(hub.connections, before + 2);
  hub.mode = 'normal';
  await assert.rejects(press(gladys, 'ABC', 'position', 10), /not connected|pas connectÃ©/);
  assert.equal(hub.connections, before + 2, 'a move never connects');
});

test('a reconnection to Gladys connects to nothing and republishes the status', async (t) => {
  const { gladys, hub } = await setup(t);
  await gladys.disconnect();
  await gladys.connect();
  await until(() => status(gladys)?.connected === true);
  assert.equal(hub.connections, 1);
});

test('the Test button never connects sooner than the interval', async (t) => {
  const { app, hub, clock } = await setup(t, { connect: false });
  await app.connect();
  app.closeSession();
  const message = await app.testConnection();
  assert.match(message.en, /less than an interval/);
  assert.equal(hub.connections, 1);
  clock.advance(10_000);
  await app.testConnection();
  assert.equal(hub.connections, 2);
});

test('after a restart, the first connection waits for the time kept in /data', async (t) => {
  const store = memoryStore();
  const clock = fakeClock();
  const first = await setup(t, { store, clock });
  await first.app.stop();
  const { timeouts } = await setup(t, { hub: first.hub, store, clock, connect: false });
  const connectTimer = timeouts.at(-1);
  assert.ok(connectTimer.ms >= 10_000, `waits ${connectTimer.ms} ms`);
});

test('a message of an older session publishes nothing', async (t) => {
  const { app } = await setup(t);
  const old = app.session.epoch;
  app.closeSession();
  const text = JSON.stringify({
    result: { reported: { mac: 'aa:bb:cc:00:11:22', shades: { XYZ: { mp: 1, ol: true } } } },
  });
  app.onMessage(old, text);
  assert.equal(app.shades.has('XYZ'), false);
});

test('a created device never loses a feature', async (t) => {
  const first = await setup(t);
  await createAll(first.gladys);
  const devices = structuredClone(first.gladys.fake.devices);
  devices[0].features.push({
    name: 'Old',
    external_id: id('ABC', 'old'),
    category: 'battery',
    type: 'integer',
    unit: 'percent',
    min: 0,
    max: 100,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  });
  await first.app.stop();
  const { gladys } = await setup(t, { hub: first.hub, devices, clock: fakeClock(2e12) });
  assert.ok(featureOf(deviceOf(gladys, 'ABC'), 'old'));
  assert.ok(
    gladys.fake.discoveredDevices[0].features.some((f) => f.external_id === id('ABC', 'old')),
  );
});

test('a silent hub is dropped and tried again later, never sooner than the backoff', async (t) => {
  const { app, hub, clock, timeouts, fire } = await setup(t);
  hub.mode = 'silent';
  clock.advance(TIMINGS.silenceMin + 1);
  fire(10_000);
  assert.equal(app.session, undefined);
  assert.equal(app.lastError.kind, 'silent');
  await until(() => app.timer);
  assert.ok(timeouts.includes(app.timer));
  assert.ok(app.timer.ms >= 10_000, `retry in ${app.timer.ms} ms`);
});

// --- Review 1 ------------------------------------------------------------------

const asks = (hub) => hub.received.filter((x) => x.includes('"src":"app"')).length;

/** Makes a shade of the simulated hub deaf: orders are received but change nothing. */
function deaf(shade, values) {
  const state = { ...values };
  for (const key of ['is', 'mp', 'target']) {
    Object.defineProperty(shade, key, {
      enumerable: key !== 'target',
      configurable: true,
      get: () => state[key],
      set: (v) => {
        if (!state.deaf) state[key] = v;
      },
    });
  }
  return state;
}

test('B1: a report without the MAC is not another hub: STOP written, one identity, /data untouched', async (t) => {
  const { gladys, app, hub, store } = await setup(t);
  await createAll(gladys);
  hub.shades.ABC.is = false;
  hub.mac = undefined; // the hubId is still there
  const saves = store.saves;
  app.ask(app.session.epoch);
  await until(() => app.shades.get('ABC').moving);
  assert.equal(app.session.identity, HUB_ID);
  await press(gladys, 'ABC', 'state', 0);
  assert.ok(orders(hub).some((o) => o.ABC?.stopShade));
  assert.equal(store.data.hub, HUB_ID);
  assert.equal(store.saves, saves, '/data not written again');
  assert.ok(!gladys.fake.discoveredDevices.some((d) => d.external_id.includes(':shade:id-')));
});

test('B1: reports flipping mac/hubId write /data at most once', async (t) => {
  const { app, hub, store } = await setup(t);
  const saves = store.saves;
  const base = hub.reported().result.reported;
  for (let i = 0; i < 200; i += 1) {
    const r = structuredClone(base);
    if (i % 2) delete r.mac;
    hub.broadcast(JSON.stringify({ result: { reported: r } }));
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(store.saves - saves <= 1, `${store.saves - saves} saves`);
  assert.equal(app.session.identity, HUB_ID);
});

test('B1: after a restart, a first report without the MAC keeps the identity kept in /data', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { store });
  await createAll(first.gladys);
  const devices = first.gladys.fake.devices;
  await first.app.stop();
  const hub = first.hub;
  hub.mac = undefined;
  const { gladys, app } = await setup(t, { hub, store, devices });
  assert.equal(app.session.identity, HUB_ID);
  assert.equal(store.data.hub, HUB_ID);
  assert.ok(gladys.fake.discoveredDevices.every((d) => d.external_id.includes(HUB_ID)));
});

test('B1: a report without any identity does not lift the check; a different MAC is another hub', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { store });
  await createAll(first.gladys);
  const devices = first.gladys.fake.devices;
  await first.app.stop();
  const hub = first.hub;
  const reported = hub.reported;
  hub.reported = () => {
    const r = reported();
    delete r.result.reported.mac;
    delete r.result.reported.hubId;
    return r;
  };
  const { gladys, app } = await setup(t, { hub, store, devices, connect: false });
  await app.connect();
  await until(() => app.session?.noIdentity);
  assert.equal(app.session.identity, undefined, 'the check is not lifted');
  // The STOP goes anyway (the hub kept in /data).
  hub.reported = reported;
  hub.mac = '11:22:33:44:55:66';
  const stop = press(gladys, 'ABC', 'state', 0);
  await until(() => orders(hub).some((o) => o.ABC?.stopShade));
  await stop.catch(() => {});
  await until(() => app.session.identity === '112233445566');
  await assert.rejects(press(gladys, 'ABC', 'state', 0), /Another hub/);
});

test('I1: a shade already moving proves nothing: "sent, without confirmation"', async (t) => {
  const { gladys, app, hub, fire } = await setup(t);
  await createAll(gladys);
  const s = deaf(hub.shades.ABC, { is: false, mp: 60 });
  s.deaf = true;
  // The app has seen it moving (closing, from the remote) before the order.
  app.ask(app.session.epoch);
  await until(() => app.shades.get('ABC').moving);
  const pending = press(gladys, 'ABC', 'position', 100);
  await until(() => orders(hub).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  fire(TIMINGS.commandAnswerBy);
  await assert.rejects(pending, /without confirmation/);
});

test('I2: a STOP lost with its connection is written again on the next session', async (t) => {
  const { gladys, hub, fire, timeouts } = await setup(t);
  await createAll(gladys);
  const s = deaf(hub.shades.ABC, { is: false, mp: 40 });
  const push = hub.received.push.bind(hub.received);
  hub.received.push = (text) => {
    if (text.includes('stopShade') && !s.dropped) {
      s.deaf = true;
      s.dropped = true;
      setImmediate(() => hub.dropAll());
    }
    return push(text);
  };
  const pending = press(gladys, 'ABC', 'state', 0);
  await until(() => timeouts.some((x) => x.ms === TIMINGS.commandAnswerBy && !x.cleared));
  fire(TIMINGS.commandAnswerBy);
  await assert.rejects(pending, /without confirmation/);
  s.deaf = false;
  // Reopened at once (one try, outside the backoff), the STOP written first.
  await until(() => orders(hub).filter((o) => o.ABC?.stopShade).length >= 2);
  assert.equal(hub.connections, 2);
});

test('I3: an empty or blank position is unknown, never "open"', async (t) => {
  const { gladys, app, hub } = await setup(t);
  await createAll(gladys);
  hub.shades.ABC.mp = '';
  app.ask(app.session.epoch);
  await until(() => app.shades.get('ABC').closed === undefined);
  await app.flush();
  const positions = gladys.fake.states.filter(
    (x) => x.device_feature_external_id === id('ABC', 'position'),
  );
  assert.ok(positions.every((x) => x.state === 0));
});

test('I4: a scene moving 20 shades asks the hub a handful of times, not 20 per step', async (t) => {
  const shades = {};
  const names = {};
  for (let i = 0; i < 20; i += 1) {
    const sid = `S${String(i).padStart(2, '0')}`;
    shades[sid] = { mp: 100, is: true, ol: true, vo: '12.1D07' };
    names[sid] = `Shade ${i}`;
  }
  const hub = await startHub({ shades, names });
  const { gladys, fire } = await setup(t, { hub });
  await until(() => gladys.fake.discoveredDevices.length === 20);
  await createAll(gladys);
  const before = asks(hub);
  await Promise.all(Object.keys(shades).map((sid) => press(gladys, sid, 'position', 100)));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const atOnce = asks(hub) - before;
  assert.ok(atOnce <= 3, `${atOnce} requests for 20 moves`);
  fire(1500);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(asks(hub) - before - atOnce <= 1, 'one request for the follow-up step');
});

test('I5: a typed fingerprint, once verified, is kept: emptying the field never relearns', async (t) => {
  const store = memoryStore();
  const hub = await startHub();
  const fp = normalizeFingerprint(hub.cert.fingerprint256);
  const { app, pins, clock } = await setup(t, {
    hub,
    store,
    config: { certificate_fingerprint: fp },
  });
  assert.equal(pins.at(-1), fp);
  assert.equal(store.data.pin, fp);
  await app.configUpdated({ hub_address: `127.0.0.1:${hub.port}`, certificate_fingerprint: '' });
  clock.advance(60_000);
  await app.connect();
  assert.equal(pins.at(-1), fp, 'the next connection checks the same pin');
});

test('m7: a wrong typed fingerprint, then the field emptied: back to the pinned one without trust', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { store });
  await first.app.stop();
  const hub = first.hub;
  const { app } = await setup(t, {
    hub,
    store,
    config: { certificate_fingerprint: 'CD'.repeat(32) },
    connect: false,
  });
  await app.connect();
  assert.ok(store.data.certChanged);
  await app.configUpdated({ hub_address: `127.0.0.1:${hub.port}`, certificate_fingerprint: '' });
  assert.equal(store.data.certChanged, null);
  assert.equal(await app.connect(), true);
});

test('m1: a STOP behind a slow connection answers within its own deadline', async (t) => {
  const sockets = new Set();
  const black = createNetServer((s) => sockets.add(s));
  await new Promise((resolve) => black.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const s of sockets) s.destroy();
    black.close();
  });
  const hub = await startHub();
  const store = memoryStore({ hub: HUB_ID, pin: normalizeFingerprint(hub.cert.fingerprint256) });
  const devices = [
    {
      name: 'Salon',
      external_id: id('ABC'),
      features: [
        { external_id: id('ABC', 'state'), category: 'shutter', type: 'state', read_only: false },
      ],
    },
  ];
  const { gladys, app } = await setup(t, {
    hub,
    store,
    devices,
    connect: false,
    config: { hub_address: `127.0.0.1:${black.address().port}` },
  });
  const scheduled = app.connect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const started = Date.now();
  const ack = await gladys.fake.setValue(devices[0], devices[0].features[0], 0);
  const took = Date.now() - started;
  assert.equal(ack.success, false);
  assert.ok(took < 4000, `took ${took} ms`);
  await scheduled;
});

test('m2: a move written just before a STOP keeps no target', async (t) => {
  const { gladys, app, hub, fire } = await setup(t);
  await createAll(gladys);
  const move = press(gladys, 'ABC', 'position', 50).catch(() => {});
  const stop = press(gladys, 'ABC', 'state', 0).catch(() => {});
  await until(() => orders(hub).length === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  fire(TIMINGS.commandAnswerBy);
  await Promise.all([move, stop]);
  assert.deepEqual(
    orders(hub).map((o) => Object.keys(o.ABC)[0]),
    ['movePercent', 'stopShade'],
  );
  assert.equal(app.targets.has('ABC'), false);
});

test('I2: a STOP is written again while the next reports show the shade moving, bounded', async (t) => {
  const { gladys, app, hub, clock, fire, timeouts } = await setup(t);
  await createAll(gladys);
  const s = deaf(hub.shades.ABC, { is: false, mp: 40 });
  s.deaf = true;
  const pending = press(gladys, 'ABC', 'state', 0);
  await until(() => timeouts.some((x) => x.ms === TIMINGS.commandAnswerBy && !x.cleared));
  for (let i = 0; i < 6; i += 1) {
    clock.advance(TIMINGS.askGap);
    app.ask(app.session.epoch);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  fire(TIMINGS.commandAnswerBy);
  await assert.rejects(pending, /without confirmation/);
  const stops = orders(hub).filter((o) => o.ABC?.stopShade).length;
  assert.equal(stops, 1 + TIMINGS.stopReaffirmMax);
  // Still at last: the hold is lifted.
  s.deaf = false;
  hub.shades.ABC.is = true;
  clock.advance(TIMINGS.askGap);
  app.ask(app.session.epoch);
  await until(() => !app.stopHolds.has('ABC'));
});
