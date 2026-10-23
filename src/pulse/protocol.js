// -----------------------------------------------------------------------------
// The messages of the Pulse Hub v2, ported from aiopulse2 (Apache-2.0,
// sillyfrog): what is asked, and how a "shadow" answer reads. Pure functions.
//
//   ask the state      {"method":"shadow","src":"app","id":<seconds>}
//   move a shade       {"method":"shadow","args":{"desired":{"shades":{"<id>":{"movePercent":<0..100>}}},"timeStamp":<s>}}
//   stop a shade       … {"<id>":{"stopShade":true}} …
//   ask its details    … {"<id>":{"query":true}} …   (battery and motor type)
//   the answer         {"result":{"reported":{"name","hubId","mac","firmware":{"version"},
//                        "mfi":{"model"},"matter":{"vendorID","productID"},
//                        "shades":{"<id>":{"mp","is","ol","rs","vo"}}}}}
//     mp  percent CLOSED (0 open .. 100 closed)
//     is  true when the shade is still ("in position"), false while it moves
//     ol  online (the hub reaches the motor)
//     rs  radio signal
//     vo  "<volts><type letter><version>", like "12.1D07"
//
// Values from the network are copied key by key (never merged, never used as
// object keys of a plain object); ids are checked before use.
// -----------------------------------------------------------------------------

import { cleanText } from '../config.js';
import { LIMITS } from '../constants.js';

/** A shade id as the hub gives it (three characters in the serial protocol). */
export const SHADE_ID = /^[A-Za-z0-9]{1,8}$/;

/** Motor types (aiopulse2 const.TYPES). */
export const TYPES = {
  A: 'AC motor',
  U: 'DC motor (U)',
  B: 'Hub/Gateway',
  C: 'Curtain motor',
  D: 'DC motor',
  d: 'DC motor (lower)',
  S: 'Socket',
  L: 'Lighting devices',
};

/** The motor types that run on a battery (aiopulse2 Roller.has_battery). */
const BATTERY_TYPES = new Set(['D', 'U', 'd']);

/** Below this voltage, the smaller 8.3 V battery (aiopulse2 BATTERY_8V_MAX_VOLTAGE). */
const BATTERY_8V_MAX_VOLTAGE = 9.0;

/** Matter vendor/product ids -> model (aiopulse2, for the Pulse Pro Hub). */
const MATTER_MODELS = new Map([['4938:1', 'Pulse Pro Hub']]);

const seconds = (now) => Math.floor(now / 1000);

export const askShadow = (now) =>
  JSON.stringify({ method: 'shadow', src: 'app', id: seconds(now) });

const desired = (shadeId, order, now) =>
  JSON.stringify({
    method: 'shadow',
    args: { desired: { shades: { [shadeId]: order } }, timeStamp: now / 1000 },
  });

/** Moves a shade to a percent CLOSED (0 open .. 100 closed), an integer. */
export function movePayload(shadeId, closedPercent, now) {
  if (!SHADE_ID.test(shadeId) || !Number.isInteger(closedPercent)) {
    throw new TypeError('bad move');
  }
  if (closedPercent < 0 || closedPercent > 100) {
    throw new RangeError('bad move');
  }
  return desired(shadeId, { movePercent: closedPercent }, now);
}

export function stopPayload(shadeId, now) {
  if (!SHADE_ID.test(shadeId)) {
    throw new TypeError('bad stop');
  }
  return desired(shadeId, { stopShade: true }, now);
}

export function queryPayload(shadeId, now) {
  if (!SHADE_ID.test(shadeId)) {
    throw new TypeError('bad query');
  }
  return desired(shadeId, { query: true }, now);
}

const own = (object, key) =>
  object && typeof object === 'object' && Object.hasOwn(object, key) ? object[key] : undefined;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * JSON of a message. A message missing closing braces (Pulse Pro Hub 1.1.0,
 * aiopulse2) gets them back, a few at most; the braces are counted in one
 * pass (inside strings too, as aiopulse2 does: the parse decides).
 */
export function parseMessage(text) {
  if (typeof text !== 'string' || text.length > LIMITS.messageBytes) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    let open = 0;
    let close = 0;
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (c === 0x7b) {
        open += 1;
      } else if (c === 0x7d) {
        close += 1;
      }
    }
    const missing = open - close;
    if (missing <= 0 || missing > LIMITS.missingBraces) {
      return undefined;
    }
    try {
      return JSON.parse(text + '}'.repeat(missing));
    } catch {
      return undefined;
    }
  }
}

/** The MAC address of the hub: 12 lower-case hexadecimal digits, or undefined. */
export function macOf(value) {
  if (typeof value !== 'string' || value.length > 32) {
    return undefined;
  }
  const mac = value.replace(/[:-]/g, '').toLowerCase();
  return /^[0-9a-f]{12}$/.test(mac) && mac !== '000000000000' ? mac : undefined;
}

/**
 * The identity of the hub (frozen: it fixes the external ids): its MAC
 * address, lower case without separators; when missing, its `hubId` when it
 * is plain (letters, digits, '-', '_', 32 at most), lower case, prefixed
 * "id-". Neither: undefined (nothing published, the reports still read).
 */
export function hubIdentityOf(reported) {
  const mac = macOf(own(reported, 'mac'));
  if (mac) {
    return mac;
  }
  const id = hubIdOf(own(reported, 'hubId'));
  return id ? `id-${id}` : undefined;
}

/** The hubId when it is plain (letters, digits, '-', '_', 32 at most), lower case. */
export function hubIdOf(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value)
    ? value.toLowerCase()
    : undefined;
}

/**
 * Whether two sets of identity facts `{ mac, hubId }` PROVE two different
 * hubs: only facts of the same nature that differ (the MAC first; the hubId
 * only when one MAC is missing). A missing or unreadable fact proves nothing
 * (review B1: a value that cannot be read is not "another device").
 */
export function provenOther(known, read) {
  if (known.mac && read.mac) {
    return known.mac !== read.mac;
  }
  if (known.hubId && read.hubId) {
    return known.hubId !== read.hubId;
  }
  return false;
}

/** "12.1D07" -> { voltage: 12.1, type: 'D', version: '07' }, or undefined. */
export function voltageOf(value) {
  if (typeof value !== 'string' || value.length > 32) {
    return undefined;
  }
  const match = /^([.0-9]{1,8})([A-Za-z])(\d{2})/.exec(value);
  if (!match) {
    return undefined;
  }
  const voltage = Number(match[1]);
  if (!Number.isFinite(voltage) || voltage < 0 || voltage > 100) {
    return undefined;
  }
  return { voltage, type: match[2], version: match[3] };
}

/**
 * The battery level of a battery motor, in percent, a rough approximation
 * of the app from the voltage (aiopulse2 Roller.battery_percent), or
 * undefined (no battery, or no voltage).
 */
export function batteryPercent(type, voltage) {
  if (!BATTERY_TYPES.has(type) || !voltage) {
    return undefined;
  }
  const percent = Math.trunc(
    voltage < BATTERY_8V_MAX_VOLTAGE ? 42.8 * voltage - 255 : 27.4 * voltage - 255,
  );
  return Math.min(100, Math.max(0, percent));
}

export const hasBattery = (type) => BATTERY_TYPES.has(type);

/**
 * A percent closed read from the hub: an integer 0..100, or undefined. Only a
 * number or a string of digits: '' or ' ' are unknown (Number('') is 0, which
 * would read "fully open" and could confirm an "open" — review I3).
 */
export function closedOf(value) {
  let n = NaN;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^\d{1,3}$/.test(value)) {
    n = Number(value);
  }
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return undefined;
  }
  return Math.round(n);
}

/**
 * A "shadow" answer as a plain record, or undefined when it is not one:
 * { name, identity, model, firmware, shades: Map<id, { closed, moving,
 *   online, details?: { voltage, type, version } }>, dropped }.
 * aiopulse2 defaults: `mp` missing = 100 (here: unknown, never guessed),
 * `is` missing = still, `ol` missing = offline.
 */
export function reportOf(message) {
  const reported = own(own(message, 'result'), 'reported');
  if (!isObject(reported)) {
    return undefined;
  }
  let model = cleanText(own(own(reported, 'mfi'), 'model'), LIMITS.name);
  if (!model) {
    const matter = own(reported, 'matter');
    const key = `${own(matter, 'vendorID')}:${own(matter, 'productID')}`;
    model = MATTER_MODELS.get(key) ?? '';
  }
  const shades = new Map();
  let dropped = 0;
  const raw = own(reported, 'shades');
  if (isObject(raw)) {
    for (const id of Object.keys(raw)) {
      if (!SHADE_ID.test(id)) {
        dropped += 1;
        continue;
      }
      if (shades.size >= LIMITS.shades) {
        dropped += 1;
        continue;
      }
      const shade = raw[id];
      if (!isObject(shade)) {
        dropped += 1;
        continue;
      }
      shades.set(id, {
        closed: closedOf(own(shade, 'mp')),
        moving: own(shade, 'is') === false,
        online: own(shade, 'ol') === true,
        details: voltageOf(own(shade, 'vo')),
      });
    }
  }
  return {
    name: cleanText(own(reported, 'name'), LIMITS.name),
    identity: hubIdentityOf(reported),
    mac: macOf(own(reported, 'mac')),
    hubId: hubIdOf(own(reported, 'hubId')),
    model,
    firmware: cleanText(own(own(reported, 'firmware'), 'version'), 32),
    shades,
    dropped,
  };
}

/** Gladys position (0 closed .. 100 open) <-> percent closed of the hub. */
export const positionOf = (closed) => 100 - closed;
export const closedFor = (position) => 100 - Math.round(position);

/**
 * The names of the serial protocol (port 1487): "!<id>NAME<name>;" answers
 * to "!<id>NAME?;". Split on ';' in one pass; anything else is skipped.
 * @returns {Map<string, string>}
 */
export function namesOf(text) {
  const names = new Map();
  if (typeof text !== 'string') {
    return names;
  }
  for (const part of text.split(';')) {
    const match = /^!([A-Za-z0-9]{3})NAME(.+)$/s.exec(part.trim());
    if (match && match[2] !== '?') {
      const name = cleanText(match[2], LIMITS.name);
      if (name) {
        names.set(match[1], name);
      }
    }
  }
  return names;
}

/** The serial question for the names of these shades (ids of three characters only). */
export const askNames = (ids) =>
  ids
    .filter((id) => /^[A-Za-z0-9]{3}$/.test(id))
    .map((id) => `!${id}NAME?;`)
    .join('');
