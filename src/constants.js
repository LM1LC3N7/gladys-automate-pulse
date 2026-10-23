// -----------------------------------------------------------------------------
// Keys shared with the manifest (frozen: users store them in their
// configuration), the vocabulary of the Pulse Hub v2 and the tuning of the
// integration.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
  TRUST_CERTIFICATE: 'trust_certificate',
};

/** Languages of the feature names (manifest `language` options). */
export const LANGUAGES = ['fr', 'en'];

/** Bounds of the read interval (seconds), mirrored by the manifest. */
export const POLL_INTERVAL = { min: 5, max: 300, default: 10 };

/**
 * The Pulse Hub v2 (aiopulse2, Apache-2.0, the library of the Home Assistant
 * integration): a WebSocket over TLS at wss://<hub>:443/rpc (a self-signed
 * certificate, pinned here), JSON messages. The client asks for the "shadow"
 * (the state of the hub and of every shade) and the hub answers
 * `{ result: { reported: { … } } }`. The names of the shades are only given
 * by a second, serial-like protocol on TCP port 1487.
 */
export const HUB = {
  wsPort: 443,
  wsPath: '/rpc',
  serialPort: 1487,
};

/** The feature keys (frozen: the external ids end with them). */
export const FEATURES = {
  STATE: 'state',
  POSITION: 'position',
  BATTERY: 'battery',
};

/** Gladys COVER_STATE values (shutter `state`). */
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin for the other paths. */
  statesPerMinute: 250,
  /** Size of one WebSocket message of the hub (the shadow of 64 shades is a few KB). */
  messageBytes: 256 * 1024,
  /** Size of the HTTP answer to the WebSocket upgrade. */
  upgradeBytes: 8 * 1024,
  /** Bytes read from the serial port (names) in one exchange. */
  serialBytes: 8 * 1024,
  /** Shades of one hub taken into account (the app allows 30 per hub). */
  shades: 64,
  /** Characters of a name read from the hub kept in Gladys. */
  name: 60,
  /** Characters of a transport badge message (SDK limit). */
  badgeMessage: 200,
  /** Distance (in percent) under which a position read equals the one asked. */
  positionTolerance: 2,
  /** Closing braces a truncated message may miss (the fix of aiopulse2 for Pulse Pro 1.1.0). */
  missingBraces: 8,
};

export const TIMINGS = {
  /** The pending states are sent at this pace. */
  flushInterval: SECOND,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * MINUTE,
  /** TCP + TLS + WebSocket upgrade. */
  connectTimeout: 5 * SECOND,
  /** The last connection time is written to /data at most this often. */
  attemptPersistEvery: MINUTE,
  /** Delays after a failed connection (never sooner than the interval). */
  backoff: [10 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** Bounds of the pause after a 429 or a 5xx (Retry-After, or doubled from the min). */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /** A session without any report for this long (and three intervals) is closed. */
  silenceMin: 30 * SECOND,
  /** A session that lived this long resets the backoff. */
  stableSession: MINUTE,
  /**
   * Gladys acks a set_value within 5 s: a command not written within 3.5 s
   * of its arrival is refused, never sent late; its confirmation is awaited
   * until 4.3 s.
   */
  commandSendBy: 3500,
  commandAnswerBy: 4300,
  /** The shade is read again at these delays after a command (a blind moves for up to a minute). */
  followUps: [1500, 4 * SECOND, 10 * SECOND, 25 * SECOND, 50 * SECOND],
  /** Details (battery, motor type) asked again for a shade at most this often (aiopulse2: 1 h). */
  detailsEvery: HOUR,
  /** Names asked on the serial port: one exchange, and at most this often while one is missing. */
  serialTimeout: 4 * SECOND,
  serialIdle: 1500,
  namesEvery: 10 * MINUTE,
  namesTries: 3,
  /** A first click on "Trust the new certificate" waits this long for the second one. */
  trustClick: MINUTE,
  /**
   * One state request of the hub at a time (it covers every shade): another
   * one within this gap waits for the answer (review I4).
   */
  askGap: SECOND,
  /** A STOP not seen still is written again on the next reports for this long (review I2). */
  stopHold: MINUTE,
  /** At most this many STOPs written again for one click. */
  stopReaffirmMax: 3,
  /** A STOP (or its reaffirmation) opens at most one connection this often (review m8). */
  stopConnectEvery: 5 * SECOND,
  /** The Discovery tab is sent at most `discoveryBurst` times per `discoveryWindow` (review m4). */
  discoveryBurst: 5,
  discoveryWindow: 10 * SECOND,
  /** Reports that arrive before the session is set (same TLS packet as the upgrade). */
  earlyMessages: 4,
};
