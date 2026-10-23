// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), so that a restart never connects to the hub before its time,
// never trusts another certificate by itself, and so that "Stop" works before
// the first report:
//   - `lastAttemptAt`: when the hub was last connected to (written BEFORE the
//     connection, at most once a minute: src/app.js waits that minute more
//     after a restart);
//   - `pause`: the end of a pause asked by the hub (429, 5xx), bounded;
//   - `pin`: the SHA-256 fingerprint of the certificate of the hub, learned at
//     the first connection (or vouched for by the user);
//   - `certChanged`: another certificate met (its fingerprint): a final stop,
//     lifted only by the user (that fingerprint typed, or the button pressed
//     twice);
//   - `hub`: the identity of the hub met behind that certificate (frozen: the
//     external ids; never downgraded), and the facts read from it (`hubMac`,
//     `hubId`), merged while nothing contradicts them.
// Nothing secret: the hub has no password. Readable by the container user
// only (0600).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { normalizeFingerprint } from './config.js';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/automate-pulse-state.json';

export function fileStore(path = process.env.DATA_FILE || STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 16 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/**
 * The persisted state, repaired and bounded: a pause never more than 6 h
 * away, a last attempt never in the future (a clock that jumped, a file
 * edited by hand).
 */
export function normalizeMemory(raw, now) {
  const data = object(raw);
  const pause = object(data.pause);
  const changed = normalizeFingerprint(object(data.certChanged).fingerprint);
  return {
    lastAttemptAt: Math.min(
      Math.max(0, Number.isFinite(data.lastAttemptAt) ? data.lastAttemptAt : 0),
      now,
    ),
    pause:
      Number.isFinite(pause.until) && pause.until > now
        ? {
            until: Math.min(pause.until, now + TIMINGS.pauseMax),
            failures:
              Number.isInteger(pause.failures) && pause.failures > 0
                ? Math.min(pause.failures, 20)
                : 1,
          }
        : null,
    pin: normalizeFingerprint(data.pin) ?? null,
    certChanged: changed ? { fingerprint: changed } : null,
    hub:
      typeof data.hub === 'string' && /^([0-9a-f]{12}|id-[a-z0-9_-]{1,32})$/.test(data.hub)
        ? data.hub
        : null,
    // The identity facts read from that hub (review B1): compared by nature,
    // a missing one proves nothing.
    hubMac:
      typeof data.hubMac === 'string' && /^[0-9a-f]{12}$/.test(data.hubMac) ? data.hubMac : null,
    hubId:
      typeof data.hubId === 'string' && /^[a-z0-9_-]{1,32}$/.test(data.hubId) ? data.hubId : null,
  };
}
