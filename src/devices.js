// -----------------------------------------------------------------------------
// The shades of the hub -> Gladys devices (pure).
//
// One Gladys device per shade, a `shutter` (never a switch nor a binary: a
// "turn everything off" never reaches it):
//   state     shutter/state     open, close, stop (write only)
//   position  shutter/position  0 closed .. 100 open (read and write)
//   battery   battery/integer   % (battery motors only, read only)
// Position: Gladys 100 = open = hub `mp` 0; Gladys 0 = closed = `mp` 100.
//
// Identity rule (frozen: it fixes the external ids): the identity of the hub
// (its MAC address, else "id-" and its hubId, see src/pulse/protocol.js), a
// dash, and the id of the shade as the hub gives it (case kept):
//   device   ext:<selector>:shade:<hub>-<shade id>
//   feature  <device>:<key>
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURES } from './constants.js';
import { label } from './i18n.js';
import { SHADE_ID, TYPES, hasBattery } from './pulse/protocol.js';

const HUB = /^([0-9a-f]{12}|id-[a-z0-9_-]{1,32})$/;

/** The ids of a shade: `{ device, feature(key) }`. */
export const shadeIds = (gladys, hub, shade) => gladys.externalIds('shade', `${hub}-${shade}`);

/** The hub, the shade and the feature key of an external id of this integration, or undefined. */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 200) {
    return undefined;
  }
  const prefix = gladys.externalIds('shade', 'x').device.slice(0, -1);
  if (!externalId.startsWith(prefix)) {
    return undefined;
  }
  const [platform, key, ...rest] = externalId.slice(prefix.length).split(':');
  const at = platform.lastIndexOf('-');
  const hub = platform.slice(0, at);
  const shade = platform.slice(at + 1);
  if (at <= 0 || !HUB.test(hub) || !SHADE_ID.test(shade) || rest.length > 0) {
    return undefined;
  }
  return { hub, shade, key };
}

/** The name of a shade in Gladys: its name in the app, else "Shade" and its id. */
export const nameOf = (shade, language = 'fr') =>
  shade.name || `${language === 'en' ? 'Shade' : 'Store'} ${shade.id}`;

/** The Gladys device of a shade: `{ id, name?, type? }`. */
export function buildDevice(gladys, hub, shade, { language = 'fr', model = '' } = {}) {
  const ids = shadeIds(gladys, hub, shade.id);
  const params = [
    { name: 'PULSE_HUB', value: hub },
    { name: 'PULSE_SHADE', value: shade.id },
  ];
  if (shade.type) {
    params.push({ name: 'PULSE_MOTOR', value: TYPES[shade.type] ?? `unknown ${shade.type}` });
  }
  if (model) {
    params.push({ name: 'PULSE_HUB_MODEL', value: model });
  }
  const features = [
    {
      name: label(FEATURES.STATE, language),
      external_id: ids.feature(FEATURES.STATE),
      category: C.SHUTTER,
      type: T.SHUTTER.STATE,
      min: -1,
      max: 1,
      read_only: false,
      has_feedback: false,
      keep_history: false,
    },
    {
      name: label(FEATURES.POSITION, language),
      external_id: ids.feature(FEATURES.POSITION),
      category: C.SHUTTER,
      type: T.SHUTTER.POSITION,
      min: 0,
      max: 100,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
  ];
  if (hasBattery(shade.type)) {
    features.push({
      name: label(FEATURES.BATTERY, language),
      external_id: ids.feature(FEATURES.BATTERY),
      category: C.BATTERY,
      type: T.BATTERY.INTEGER,
      unit: U.PERCENT,
      min: 0,
      max: 100,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
  }
  return {
    name: nameOf(shade, language),
    external_id: ids.device,
    should_poll: false,
    params,
    features,
  };
}

/** A value of a command: a finite number, never null nor '' nor a boolean (they are not 0). */
export function numberIn(value, min, max) {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  if (value === null || value === undefined || typeof value === 'boolean') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}
