// -----------------------------------------------------------------------------
// The failures of the hub, by kind. A message never holds what the hub sent
// (only a status code or a fingerprint, both harmless).
//   unreachable  no TCP connection (refused, no route, name unknown)
//   timeout      no TLS handshake or no WebSocket upgrade in time
//   certificate  the certificate is not the pinned one (`fingerprint`)
//   rate         HTTP 429 on the upgrade (`retryAfter` in ms, if given)
//   server       HTTP 5xx on the upgrade
//   http         another HTTP status instead of an upgrade (`status`)
//   format       not a WebSocket (a bad upgrade, a binary frame, bad UTF-8)
//   tooLarge     a message or an answer over the limits
//   closed       the connection closed or broke
// -----------------------------------------------------------------------------

export class PulseError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'PulseError';
    this.kind = kind;
    for (const key of ['status', 'retryAfter', 'fingerprint']) {
      if (extra[key] !== undefined) {
        this[key] = extra[key];
      }
    }
  }
}

/** Retry-After in ms (seconds or an HTTP date), or undefined. */
export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 64) {
    return undefined;
  }
  if (/^\d{1,9}$/.test(value.trim())) {
    return Number(value.trim()) * 1000;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}
