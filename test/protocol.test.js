// -----------------------------------------------------------------------------
// The pure parts: the messages of the hub (aiopulse2's protocol), the
// configuration, the devices and the store.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig, normalizeFingerprint, parseHost } from '../src/config.js';
import { buildDevice, numberIn, parseExternalId } from '../src/devices.js';
import {
  askNames,
  batteryPercent,
  hubIdentityOf,
  movePayload,
  namesOf,
  parseMessage,
  queryPayload,
  reportOf,
  stopPayload,
  voltageOf,
  closedOf,
  provenOther,
} from '../src/pulse/protocol.js';

test('a position: a number or digits only; blank is unknown, never 0 (review I3)', () => {
  assert.equal(closedOf(''), undefined);
  assert.equal(closedOf(' '), undefined);
  assert.equal(closedOf(null), undefined);
  assert.equal(closedOf('40'), 40);
  assert.equal(closedOf(40.4), 40);
  assert.equal(closedOf('4e1'), undefined);
  assert.equal(closedOf(101), undefined);
});

test('another hub only on facts of the same nature that differ (review B1)', () => {
  const known = { mac: 'aabbcc001122', hubId: 'h1' };
  assert.equal(provenOther(known, { hubId: 'h1' }), false);
  assert.equal(provenOther(known, {}), false);
  assert.equal(provenOther(known, { mac: 'aabbcc001122', hubId: 'zz' }), false, 'the MAC rules');
  assert.equal(provenOther(known, { mac: '112233445566' }), true);
  assert.equal(provenOther(known, { hubId: 'h2' }), true);
  assert.equal(provenOther({ mac: 'aabbcc001122' }, { hubId: 'h2' }), false);
});
import { normalizeMemory } from '../src/store.js';

test('the payloads of aiopulse2', () => {
  assert.deepEqual(JSON.parse(movePayload('ABC', 40, 1_700_000_000_500)), {
    method: 'shadow',
    args: { desired: { shades: { ABC: { movePercent: 40 } } }, timeStamp: 1_700_000_000.5 },
  });
  assert.deepEqual(JSON.parse(stopPayload('ABC', 0)).args.desired.shades.ABC, {
    stopShade: true,
  });
  assert.deepEqual(JSON.parse(queryPayload('ABC', 0)).args.desired.shades.ABC, { query: true });
  assert.throws(() => movePayload('ABC', 101, 0));
  assert.throws(() => movePayload('ABC', 50.5, 0));
  assert.throws(() => movePayload('__proto__', 50, 0));
  assert.throws(() => stopPayload('A"B', 0));
});

test('a shadow answer as a record; ids checked, no prototype pollution', () => {
  const text = JSON.stringify({
    result: {
      reported: {
        name: 'Hub\u0007',
        hubId: 'H1',
        mac: 'AA:BB:CC:00:11:22',
        firmware: { version: '1.0' },
        shades: {
          ABC: { mp: 30, is: false, ol: true, vo: '12.1D07' },
          DEF: { is: true },
          ['__proto__']: { mp: 1 },
          'x y': { mp: 1 },
        },
      },
    },
  }).replace('"x y"', '"__proto__":{"polluted":1},"x y"');
  const report = reportOf(parseMessage(text));
  assert.equal(report.name, 'Hub');
  assert.equal(report.identity, 'aabbcc001122');
  assert.deepEqual([...report.shades.keys()], ['ABC', 'DEF']);
  assert.deepEqual(report.shades.get('ABC'), {
    closed: 30,
    moving: true,
    online: true,
    details: { voltage: 12.1, type: 'D', version: '07' },
  });
  assert.equal(report.shades.get('DEF').closed, undefined, 'mp missing is unknown, never 100');
  assert.equal(report.shades.get('DEF').online, false);
  assert.equal({}.polluted, undefined);
  assert.equal(reportOf({ result: {} }), undefined);
  assert.equal(reportOf(undefined), undefined);
});

test('a message missing a few closing braces is repaired (Pulse Pro Hub), not more', () => {
  assert.deepEqual(parseMessage('{"result":{"reported":{"name":"x"'), {
    result: { reported: { name: 'x' } },
  });
  assert.equal(parseMessage(`${'{"a":'.repeat(20)}1`), undefined);
  assert.equal(parseMessage('not json'), undefined);
});

test('the hub identity: the MAC, else the hub id, else nothing', () => {
  assert.equal(hubIdentityOf({ mac: 'aa-bb-cc-00-11-22' }), 'aabbcc001122');
  assert.equal(hubIdentityOf({ mac: '00:00:00:00:00:00', hubId: 'Hub_1' }), 'id-hub_1');
  assert.equal(hubIdentityOf({ hubId: 'a b' }), undefined);
  assert.equal(hubIdentityOf({}), undefined);
});

test('battery: aiopulse2 formula, battery motors only', () => {
  assert.equal(batteryPercent('D', 12.1), 76);
  assert.equal(batteryPercent('U', 8.3), 100);
  assert.equal(batteryPercent('d', 6), 1);
  assert.equal(batteryPercent('D', 5), 0);
  assert.equal(batteryPercent('A', 12), undefined);
  assert.equal(voltageOf('abc'), undefined);
  assert.equal(voltageOf('999.9D07'), undefined);
});

test('names of the serial port', () => {
  assert.equal(askNames(['ABC', 'TOOLONG', 'D;F']), '!ABCNAME?;');
  const names = namesOf('!ABCNAMESalon;!DEFNAME?;junk;!GHINAMEChambre \u0001;');
  assert.deepEqual(
    [...names],
    [
      ['ABC', 'Salon'],
      ['GHI', 'Chambre'],
    ],
  );
});

test('the configuration', () => {
  assert.deepEqual(parseHost('wss://192.168.1.50/rpc'), {
    address: { host: '192.168.1.50', port: 443 },
  });
  assert.deepEqual(parseHost('hub.lan:8443').address, { host: 'hub.lan', port: 8443 });
  assert.equal(parseHost('pulse.local').local, true);
  assert.equal(parseHost('user:pw@hub').credentials, true);
  const config = normalizeConfig({
    hub_address: '192.168.1.50',
    certificate_fingerprint: 'ab'.repeat(32),
    poll_interval: '1',
  });
  assert.equal(config.key, '192.168.1.50');
  assert.equal(config.pin, normalizeFingerprint('AB'.repeat(32)));
  assert.equal(config.pollInterval, 5);
  assert.equal(normalizeConfig({ certificate_fingerprint: 'nope' }).pinInvalid, true);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 10);
});

test('devices: shutter, never a switch; ids round trip', () => {
  const gladys = createFakeGladys({ selector: 'automate-pulse' });
  const device = buildDevice(gladys, 'aabbcc001122', { id: 'ABC', name: 'Salon', type: 'D' });
  assert.equal(device.external_id, 'ext:automate-pulse:shade:aabbcc001122-ABC');
  assert.deepEqual(
    device.features.map((f) => [f.category, f.type, f.unit]),
    [
      ['shutter', 'state', undefined],
      ['shutter', 'position', undefined],
      ['battery', 'integer', 'percent'],
    ],
  );
  assert.equal(buildDevice(gladys, 'id-h1', { id: 'ABC', type: 'A' }).features.length, 2);
  assert.equal(buildDevice(gladys, 'id-h1', { id: 'ABC' }, { language: 'en' }).name, 'Shade ABC');
  assert.deepEqual(parseExternalId(gladys, 'ext:automate-pulse:shade:id-h1-ABC:position'), {
    hub: 'id-h1',
    shade: 'ABC',
    key: 'position',
  });
  assert.equal(parseExternalId(gladys, 'ext:automate-pulse:shade:nohub:state'), undefined);
  assert.equal(numberIn(null, 0, 100), undefined);
  assert.equal(numberIn('', 0, 100), undefined);
  assert.equal(numberIn(true, 0, 100), undefined);
  assert.equal(numberIn('40', 0, 100), 40);
});

test('the store is repaired and bounded', () => {
  const now = 1_000_000;
  const memory = normalizeMemory(
    {
      lastAttemptAt: now + 5000,
      pause: { until: now + 100 * 3_600_000, failures: 3 },
      pin: 'ab'.repeat(32),
      certChanged: { fingerprint: 'bad' },
      hub: '../x',
      extra: 'dropped',
    },
    now,
  );
  assert.equal(memory.lastAttemptAt, now);
  assert.equal(memory.pause.until, now + 6 * 3_600_000);
  assert.equal(memory.pin, normalizeFingerprint('AB'.repeat(32)));
  assert.equal(memory.certChanged, null);
  assert.equal(memory.hub, null);
  assert.equal('extra' in memory, false);
});
