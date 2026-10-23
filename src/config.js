// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. Nothing secret:
// the hub has no password; its certificate fingerprint is public.
// -----------------------------------------------------------------------------

import { HUB, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  hub_address: '',
  certificate_fingerprint: '',
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A text read from the hub, without control characters, trimmed and cut. */
export function cleanText(value, max) {
  if (typeof value !== 'string') {
    return '';
  }
  let out = '';
  for (const char of value.slice(0, max * 2)) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      out += char;
    }
  }
  return out.trim().slice(0, max);
}

/**
 * The address typed by the user: an IPv4 address or a host name, with an
 * optional port (443 by default). A pasted URL ("wss://192.168.1.50/rpc") is
 * reduced to its host. Credentials in it are refused and never shown; names
 * in .local are refused (mDNS does not resolve in the container).
 * @returns {{ address?: { host: string, port: number }, invalid?: string, credentials?: boolean, local?: boolean }}
 */
export function parseHost(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return {};
  }
  if (text.includes('@')) {
    return { credentials: true };
  }
  if (text.length > 260) {
    return { invalid: `${text.slice(0, 40)}…` };
  }
  const shown = text.slice(0, 60);
  text = text.replace(/^(https?|wss?):\/\//i, '').replace(/[/?#].*$/, '');
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(text.toLowerCase());
  if (!match) {
    return { invalid: shown };
  }
  const [, host, portText] = match;
  const port = portText === undefined ? HUB.wsPort : Number(portText);
  if (port < 1 || port > 65535 || host.length > 253) {
    return { invalid: shown };
  }
  if (/\.local\.?$/.test(host)) {
    return { local: true, invalid: shown };
  }
  const valid =
    IPV4.test(host) || (!/^[\d.]+$/.test(host) && host.split('.').every((l) => LABEL.test(l)));
  return valid ? { address: { host, port } } : { invalid: shown };
}

/** `host` or `host:port` (port 443 left out). */
export const addressKey = (address) =>
  address ? (address.port === HUB.wsPort ? address.host : `${address.host}:${address.port}`) : '';

/**
 * A SHA-256 fingerprint, upper case with colons (as Node gives it), or
 * undefined. Accepts it typed with colons, spaces or nothing in between.
 */
export function normalizeFingerprint(value) {
  if (typeof value !== 'string' || value.length > 200) {
    return undefined;
  }
  const hex = value.replace(/[\s:]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) {
    return undefined;
  }
  return hex.match(/../g).join(':');
}

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

const bounded = (value, { default: fallback, min, max }) => {
  const number = numberOf(value);
  return number === undefined ? fallback : Math.min(max, Math.max(min, Math.round(number)));
};

/**
 * @returns {{ address?: { host: string, port: number }, key: string,
 *   invalid?: string, local: boolean, credentialsInHost: boolean,
 *   pin?: string, pinInvalid: boolean, pollInterval: number, language: 'fr'|'en' }}
 */
export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value != null) {
      c[key] = value;
    }
  }
  const parsed = parseHost(typeof c.hub_address === 'string' ? c.hub_address : '');
  const typedPin = typeof c.certificate_fingerprint === 'string' ? c.certificate_fingerprint : '';
  const pin = normalizeFingerprint(typedPin);
  return {
    address: parsed.address,
    key: addressKey(parsed.address),
    invalid: parsed.invalid,
    local: Boolean(parsed.local),
    credentialsInHost: Boolean(parsed.credentials),
    pin,
    pinInvalid: typedPin.trim() !== '' && !pin,
    pollInterval: bounded(c.poll_interval, POLL_INTERVAL),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What the connection depends on: a change of any of these starts over. */
export const connectionKey = (config) => JSON.stringify([config.key, config.pin ?? '']);
