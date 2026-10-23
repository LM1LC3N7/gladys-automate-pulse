// -----------------------------------------------------------------------------
// The integration: one Pulse Hub v2 (its IP address in the configuration),
// one WebSocket to it, its "shadow" asked every poll interval, one Gladys
// device per shade (a shutter), the transport badges, the "Test the
// connection" and "Trust the new certificate" buttons, and the commands
// (open, close, stop, position). index.js only wires the SDK handlers to it.
//
// Connection: the certificate of the hub is self-signed, so it is pinned
// (learned at the first connection, or typed); another one is a final stop
// kept in /data, lifted only by the user. Never connected sooner than the
// interval after the last try (the Test button, a reconnection to Gladys, a
// configuration saved unchanged, a restart: the time of the last try is kept
// in /data); failures wait 10 s, 30 s, 1, 2, 5 min; a 429 or 5xx to the
// upgrade pauses 1 min to 6 h, kept in /data. A reconnection to Gladys clears
// nothing and reads nothing.
//
// Commands:
//   - a move (open, close, position) is decided on the hub's own report in
//     this session: the hub identity (MAC) of the device, the shade present;
//     written within 3.5 s of the click or refused unsent; "accepted" once the
//     hub reports the shade moving or at the position asked (by 4.3 s), else
//     "sent, without confirmation"; never retried. The position is confirmed
//     only by a report equal to it;
//   - STOP never waits for anything but the connection: no queue, no report
//     needed (the identity of the hub behind the pinned certificate is kept in
//     /data), through a pause (one connection try), and cancels every move of
//     that shade not written yet;
//   - the ack never waits for a publication to Gladys.
// A report of an older session or configuration publishes nothing (epoch and
// generation checked).
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { connectionKey, normalizeConfig } from './config.js';
import { COVER_STATE, FEATURES, HUB, LIMITS, SECOND, TIMINGS } from './constants.js';
import { buildDevice, numberIn, parseExternalId, shadeIds } from './devices.js';
import { ERRORS, T, age, join, reasonOf, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';
import {
  askShadow,
  batteryPercent,
  closedFor,
  movePayload,
  parseMessage,
  positionOf,
  queryPayload,
  reportOf,
  stopPayload,
} from './pulse/protocol.js';
import { fetchNames as fetchNamesOnSerial } from './pulse/serial.js';
import { openHubSocket } from './pulse/ws.js';

/** The fields kept from a feature created in Gladys, when it is published again as it is. */
const KEPT_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'unit',
  'read_only',
  'has_feedback',
  'keep_history',
];

const COMMAND_KEYS = new Set([FEATURES.STATE, FEATURES.POSITION]);
const PAUSE_KINDS = new Set(['rate', 'server']);

export class PulseApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'automate-pulse' }),
    store = fileStore(),
    now = Date.now,
    timers = globalThis,
    openSocket = openHubSocket,
    fetchNames = fetchNamesOnSerial,
    serialPort = HUB.serialPort,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.timers = timers;
    this.openSocket = openSocket;
    this.fetchNames = fetchNames;
    this.serialPort = serialPort;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.connKey = undefined;
    this.memory = undefined;
    this.generation = 0;
    this.started = false;
    /** The open session: { conn, epoch, openedAt, lastReportAt, identity } */
    this.session = undefined;
    this.epoch = 0;
    this.connecting = undefined;
    /** When the hub was last connected to by this process (exact). */
    this.lastAttemptAt = -Infinity;
    this.nextAttemptAt = -Infinity;
    this.failures = 0;
    this.lastError = undefined;
    this.timer = undefined;
    this.readTimer = undefined;
    /** The last report of the hub in this session: { name, model, firmware }. */
    this.hubInfo = undefined;
    /** shade id -> { id, name, nameTries, type, voltage, closed, moving, online, readAt, detailsAskedAt } */
    this.shades = new Map();
    this.names = new Map();
    this.namesAt = -Infinity;
    this.namesRunning = false;
    this.reportSeq = 0;
    /** Promises waiting for a report or a connection: { check, resolve } */
    this.waiters = new Set();
    /** shade id -> follow-up timers */
    this.followUps = new Map();
    /** shade id -> the percent closed asked by the last move accepted */
    this.targets = new Map();
    /** shade id -> the position read when the last move did not reach its target */
    this.notReached = new Map();
    /** shade ids whose command was sent without confirmation */
    this.unconfirmed = new Set();
    /** shade id -> moves not written yet (a STOP cancels them) */
    this.tickets = new Map();
    /** device external id -> device published in this run (a publication never shrinks) */
    this.known = new Map();
    this.lastStatus = undefined;
    this.published = undefined;
    this.badges = undefined;
    this.trustClick = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = this.generation;
    if (!this.memory) {
      this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
      // Written at most once a minute: the real last try may be up to a
      // minute later than the one kept.
      if (this.memory.lastAttemptAt > 0) {
        this.lastAttemptAt = Math.min(
          this.now(),
          this.memory.lastAttemptAt + TIMINGS.attemptPersistEvery,
        );
      }
    }
    if (generation !== this.generation) {
      return;
    }
    this.config = normalizeConfig(raw);
    this.connKey = connectionKey(this.config);
    const changed = this.memory.certChanged;
    if (changed && this.config.pin === changed.fingerprint) {
      // The user typed the fingerprint the status showed: that one is pinned.
      this.memory.certChanged = null;
      this.memory.pin = changed.fingerprint;
      await this.saveMemory();
      this.logger.info(`Certificate ${changed.fingerprint} typed by the user: pinned`);
    }
    if (generation !== this.generation) {
      return;
    }
    this.failures = 0;
    this.lastError = undefined;
    this.nextAttemptAt = -Infinity;
    this.published = undefined;
    this.badges = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    await this.publishAll();
    if (generation !== this.generation) {
      return;
    }
    this.scheduleConnect();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    this.closeSession();
    for (const handles of this.followUps.values()) {
      for (const handle of handles) {
        this.timers.clearTimeout(handle);
      }
    }
    this.followUps.clear();
    for (const waiter of this.waiters) {
      waiter.resolve(false);
    }
    this.waiters.clear();
    this.publisher.stop();
    if (this.memory && this.lastAttemptAt > this.memory.lastAttemptAt) {
      this.memory.lastAttemptAt = this.lastAttemptAt;
      return this.saveMemory();
    }
    return Promise.resolve();
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Closes the session (if any) without counting it as a failure. */
  closeSession() {
    if (this.readTimer) {
      this.timers.clearTimeout(this.readTimer);
      this.readTimer = undefined;
    }
    const session = this.session;
    this.session = undefined;
    this.epoch += 1;
    session?.conn.close();
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery tab, badges) and the
   * last states, without connecting to the hub again.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw, { republish: true });
  }

  /** A configuration saved: a new address or fingerprint starts over; the rest applies at once. */
  async configUpdated(raw = {}, { republish = false } = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    const next = normalizeConfig(raw);
    if (connectionKey(next) !== this.connKey) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = next;
    if (previous.pollInterval !== next.pollInterval && this.session) {
      this.scheduleRead(this.session.epoch);
    }
    if (republish) {
      this.published = undefined;
      this.badges = undefined;
      this.lastStatus = undefined;
    } else if (previous.language !== next.language) {
      this.published = undefined;
    }
    await this.publishAll({ states: republish });
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** How long a report stays recent: two intervals and a minute. */
  freshFor() {
    return 2 * this.interval + TIMINGS.attemptPersistEvery;
  }

  pause() {
    const pause = this.memory?.pause;
    return pause && this.now() < pause.until ? pause : undefined;
  }

  /** The certificate met when it is not the pinned one, until the user vouches for it. */
  certStop() {
    const changed = this.memory?.certChanged;
    return changed && this.config.pin !== changed.fingerprint ? changed : undefined;
  }

  pin() {
    return this.config.pin ?? this.memory?.pin ?? undefined;
  }

  // --- Connection ------------------------------------------------------------

  /** When the next connection may start (Infinity: none until the user acts). */
  nextConnectAt() {
    if (!this.config.address || this.certStop()) {
      return Infinity;
    }
    const pause = this.pause();
    return Math.max(this.nextAttemptAt, this.lastAttemptAt + this.interval, pause?.until ?? 0);
  }

  scheduleConnect() {
    this.clearTimer();
    if (this.session || this.connecting) {
      return;
    }
    const at = this.nextConnectAt();
    if (at === Infinity) {
      return;
    }
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.connect().catch(() => this.logger.error('Connection failed'));
        }
      },
      Math.max(0, at - this.now()),
    );
  }

  /** One connection at a time: a call during one joins it. */
  connect(options = {}) {
    if (this.session) {
      return Promise.resolve(true);
    }
    if (!this.connecting) {
      this.connecting = this.doConnect(options).finally(() => {
        this.connecting = undefined;
        this.wake();
      });
    }
    return this.connecting;
  }

  async doConnect({ timeout = TIMINGS.connectTimeout } = {}) {
    const generation = this.generation;
    const address = this.config.address;
    if (!address || this.certStop()) {
      return false;
    }
    // Written BEFORE the connection: a restart in the middle never connects sooner.
    const now = this.now();
    this.lastAttemptAt = now;
    if (now - this.memory.lastAttemptAt >= TIMINGS.attemptPersistEvery) {
      this.memory.lastAttemptAt = now;
      await this.saveMemory();
    }
    if (generation !== this.generation) {
      return false;
    }
    const pin = this.pin();
    const epoch = ++this.epoch;
    let opened;
    try {
      opened = await this.openSocket({
        host: address.host,
        port: address.port,
        path: HUB.wsPath,
        pin,
        timeoutMs: Math.max(200, timeout),
        maxMessageBytes: LIMITS.messageBytes,
        onMessage: (text) => this.onMessage(epoch, text),
        onClose: (err) => this.onClosed(epoch, err),
      });
    } catch (err) {
      if (generation === this.generation) {
        await this.connectFailed(err);
      }
      return false;
    }
    if (generation !== this.generation || epoch !== this.epoch) {
      opened.connection.close();
      return false;
    }
    // A connection timer still pending (a STOP or the Test button connected first) is dropped.
    this.clearTimer();
    this.session = {
      conn: opened.connection,
      epoch,
      openedAt: this.now(),
      lastReportAt: undefined,
      identity: undefined,
    };
    this.lastError = undefined;
    let save = false;
    if (!pin) {
      this.memory.pin = opened.fingerprint;
      save = true;
      this.logger.info(`Certificate of the hub pinned (SHA-256 ${opened.fingerprint})`);
    }
    if (this.memory.pause) {
      // The hub accepted the connection: its pause is over.
      this.memory.pause = null;
      save = true;
    }
    if (save) {
      await this.saveMemory();
    }
    if (this.session?.epoch !== epoch) {
      return false;
    }
    this.logger.info('Connected to the hub');
    // The first read of this connection, then one every interval.
    this.ask(epoch);
    this.scheduleRead(epoch);
    this.publishAll().catch(() => {});
    return true;
  }

  async connectFailed(err) {
    this.lastError = err;
    if (err?.kind === 'certificate') {
      this.memory.certChanged = { fingerprint: err.fingerprint };
      await this.saveMemory();
      this.logger.warn(
        `The hub shows another certificate (SHA-256 ${err.fingerprint}): stopped until it is trusted`,
      );
    } else if (PAUSE_KINDS.has(err?.kind)) {
      const failures = (this.memory.pause?.failures ?? 0) + 1;
      const asked = err.retryAfter ?? TIMINGS.pauseMin * 2 ** Math.min(failures - 1, 10);
      const wait = Math.min(
        TIMINGS.pauseMax,
        Math.max(TIMINGS.pauseMin, this.interval, Math.min(asked, TIMINGS.pauseMax)),
      );
      this.memory.pause = { until: this.now() + wait, failures };
      await this.saveMemory();
      this.logger.warn(`Hub: ${reasonOf(err).en}, paused for ${age(wait)}`);
    } else {
      const wait = Math.max(
        this.interval,
        TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
      );
      this.failures += 1;
      this.nextAttemptAt = this.now() + wait;
      this.logger.warn(`Hub: ${reasonOf(err).en}; next try in ${age(wait)}`);
    }
    await this.publishAll();
    this.scheduleConnect();
  }

  /** The session ended (closed by the hub, broken, or silent). */
  onClosed(epoch, err) {
    if (this.session?.epoch !== epoch) {
      return;
    }
    const lived = this.now() - this.session.openedAt;
    if (this.readTimer) {
      this.timers.clearTimeout(this.readTimer);
      this.readTimer = undefined;
    }
    this.session = undefined;
    this.epoch += 1;
    if (lived >= TIMINGS.stableSession) {
      this.failures = 0;
    }
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
    );
    this.failures += 1;
    this.nextAttemptAt = this.now() + wait;
    this.lastError = err ?? { kind: 'closed' };
    this.logger.warn(`Hub: ${reasonOf(this.lastError).en}; next try in ${age(wait)}`);
    this.wake();
    this.badges = undefined;
    this.publishAll()
      .catch(() => {})
      .finally(() => {
        if (!this.session) {
          this.scheduleConnect();
        }
      });
  }

  /** The reads of the session: one "shadow" per interval; a silent hub is dropped. */
  scheduleRead(epoch) {
    if (this.readTimer) {
      this.timers.clearTimeout(this.readTimer);
    }
    this.readTimer = this.timers.setTimeout(() => {
      this.readTimer = undefined;
      const session = this.session;
      if (session?.epoch !== epoch) {
        return;
      }
      const silentFor = this.now() - (session.lastReportAt ?? session.openedAt);
      if (silentFor > Math.max(3 * this.interval, TIMINGS.silenceMin)) {
        // Counted first (the close below then belongs to no session).
        this.onClosed(epoch, { kind: 'silent' });
        session.conn.close();
        return;
      }
      this.ask(epoch);
      this.askDetails(epoch);
      this.scheduleRead(epoch);
    }, this.interval);
  }

  /** Asks the hub for its shadow (a read). */
  ask(epoch) {
    const session = this.session;
    if (session?.epoch === epoch) {
      session.conn.send(askShadow(this.now())).catch(() => {});
    }
  }

  /**
   * The battery and the motor type come with `vo`, which the hub sends
   * rarely: asked for one shade per read, each at most once an hour
   * (aiopulse2).
   */
  askDetails(epoch) {
    const session = this.session;
    if (session?.epoch !== epoch) {
      return;
    }
    for (const shade of this.shades.values()) {
      if (!shade.type && this.now() - shade.detailsAskedAt >= TIMINGS.detailsEvery) {
        shade.detailsAskedAt = this.now();
        session.conn.send(queryPayload(shade.id, this.now())).catch(() => {});
        return;
      }
    }
  }

  // --- Reports ---------------------------------------------------------------

  onMessage(epoch, text) {
    if (this.session?.epoch !== epoch) {
      return;
    }
    const report = reportOf(parseMessage(text));
    if (!report) {
      this.logger.debug('Message of the hub not understood');
      return;
    }
    this.session.lastReportAt = this.now();
    // Numbered: a command is accepted only by a report received after its write.
    this.reportSeq += 1;
    this.applyReport(report);
  }

  applyReport(report) {
    const session = this.session;
    if (!report.identity) {
      session.identity = undefined;
      session.noIdentity = true;
      this.wake();
      this.publishAll().catch(() => {});
      return;
    }
    session.noIdentity = false;
    if (session.identity && session.identity !== report.identity) {
      this.logger.warn('Another hub answers on this connection now');
    }
    if (session.identity !== report.identity) {
      this.shades.clear();
    }
    session.identity = report.identity;
    if (this.memory.hub !== report.identity) {
      this.memory.hub = report.identity;
      this.saveMemory().catch(() => {});
    }
    this.hubInfo = { name: report.name, model: report.model, firmware: report.firmware };
    const now = this.now();
    const next = new Map();
    for (const [id, read] of report.shades) {
      const shade = this.shades.get(id) ?? {
        id,
        name: this.names.get(id),
        nameTries: 0,
        type: undefined,
        voltage: undefined,
        closed: undefined,
        moving: false,
        online: false,
        readAt: undefined,
        detailsAskedAt: -Infinity,
      };
      shade.closed = read.closed;
      shade.moving = read.moving;
      shade.online = read.online;
      shade.readAt = now;
      shade.readSeq = this.reportSeq;
      if (read.details) {
        shade.type = read.details.type;
        shade.voltage = read.details.voltage;
      }
      next.set(id, shade);
      this.confirm(shade);
    }
    this.shades = next;
    this.wake();
    this.fetchMissingNames();
    this.publishAll().catch(() => {});
  }

  /** A move is confirmed only by a position read equal to the one asked. */
  confirm(shade) {
    const id = shade.id;
    const target = this.targets.get(id);
    if (shade.closed === undefined) {
      return;
    }
    if (target === undefined) {
      if (!shade.moving) {
        this.unconfirmed.delete(id);
      }
      if (this.notReached.has(id) && this.notReached.get(id) !== positionOf(shade.closed)) {
        this.notReached.delete(id);
      }
    } else if (Math.abs(target - shade.closed) <= LIMITS.positionTolerance) {
      this.targets.delete(id);
      this.unconfirmed.delete(id);
      this.notReached.delete(id);
    }
  }

  /** The names of the shades, read on the serial port (spaced, three tries each). */
  fetchMissingNames() {
    if (this.namesRunning || !this.config.address) {
      return;
    }
    const missing = [...this.shades.values()].filter(
      (s) => !s.name && s.nameTries < TIMINGS.namesTries,
    );
    if (missing.length === 0) {
      return;
    }
    const first = missing.some((s) => s.nameTries === 0);
    if (!first && this.now() - this.namesAt < TIMINGS.namesEvery) {
      return;
    }
    const generation = this.generation;
    this.namesRunning = true;
    this.namesAt = this.now();
    this.fetchNames({
      host: this.config.address.host,
      port: this.serialPort,
      ids: missing.map((s) => s.id),
    })
      .catch(() => new Map())
      .then((names) => {
        this.namesRunning = false;
        if (generation !== this.generation) {
          return undefined;
        }
        for (const shade of missing) {
          const name = names.get(shade.id);
          if (name) {
            this.names.set(shade.id, name);
            const current = this.shades.get(shade.id);
            if (current) {
              current.name = name;
            }
          }
          shade.nameTries += 1;
        }
        return this.publishAll();
      })
      .catch(() => {});
  }

  // --- Waiting ---------------------------------------------------------------

  /** Checks the waiters after a report or a change of connection. */
  wake() {
    for (const waiter of [...this.waiters]) {
      if (waiter.check()) {
        this.waiters.delete(waiter);
        waiter.resolve(true);
      }
    }
  }

  /** Resolves true once `check()` holds (checked at each report), false after `ms`. */
  waitFor(check, ms) {
    if (check()) {
      return Promise.resolve(true);
    }
    if (ms <= 0) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const waiter = {
        check,
        resolve: (value) => {
          this.timers.clearTimeout(handle);
          resolve(value);
        },
      };
      const handle = this.timers.setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(false);
      }, ms);
      this.waiters.add(waiter);
    });
  }

  // --- Status ----------------------------------------------------------------

  /** `[connected, message]`. */
  status() {
    const config = this.config;
    const notes = [
      config.credentialsInHost ? T.credentialsInHost : undefined,
      config.invalid ? T.invalid(config.invalid) : undefined,
      config.local ? T.local : undefined,
      config.pinInvalid ? T.pinInvalid : undefined,
    ];
    if (!config.address) {
      return [false, join(T.noAddress, ...notes)];
    }
    const changed = this.certStop();
    if (changed) {
      return [
        false,
        join(
          config.pin
            ? T.certificateNotTyped(changed.fingerprint)
            : T.certificateChanged(changed.fingerprint),
          ...notes,
        ),
      ];
    }
    const session = this.session;
    if (session?.identity) {
      const shades = [...this.shades.values()];
      return [
        true,
        join(
          T.connected({
            name: this.hubInfo?.name,
            shades: shades.length,
            online: shades.filter((s) => s.online).length,
            interval: config.pollInterval,
          }),
          ...notes,
        ),
      ];
    }
    if (session?.noIdentity) {
      return [false, join(T.noIdentity, ...notes)];
    }
    const pause = this.pause();
    if (pause) {
      return [
        false,
        join(
          T.paused(age(pause.until - this.now()), reasonOf(this.lastError ?? { kind: 'rate' })),
          ...notes,
        ),
      ];
    }
    if (!session && this.lastError) {
      const wait = age(Math.max(0, this.nextConnectAt() - this.now()));
      return [false, join(T.unreachable(reasonOf(this.lastError), wait), ...notes)];
    }
    return [false, join(T.connecting, ...notes)];
  }

  async updateStatus() {
    let connected;
    let message;
    try {
      [connected, message] = this.status();
    } catch (err) {
      this.logger.error(`Status failed: ${err?.message ?? 'error'}`);
      [connected, message] = [false, ERRORS.generic];
    }
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Gladys ----------------------------------------------------------------

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  async publishAll({ states = true } = {}) {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    if (states) {
      this.queueStates();
      await this.flush();
    }
    await this.publishBadges();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /**
   * The Discovery tab: one device per shade of the hub, once its name was
   * asked. A created device never loses a feature (Gladys would otherwise
   * mark it changed, and "Update" would drop their history), and a device
   * seen earlier in this run stays.
   */
  async publishDevices() {
    const hub = this.session?.identity;
    if (hub) {
      const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
      for (const shade of this.shades.values()) {
        if (!shade.name && shade.nameTries === 0) {
          continue;
        }
        const device = buildDevice(this.gladys, hub, shade, {
          language: this.config.language,
          model: this.hubInfo?.model,
        });
        const published = new Set(device.features.map((f) => f.external_id));
        const before = this.known.get(device.external_id);
        const kept = [
          ...(created.get(device.external_id)?.features ?? []),
          ...(before?.features ?? []),
        ];
        for (const feature of kept) {
          if (!published.has(feature.external_id)) {
            const copy = {};
            for (const field of KEPT_FIELDS) {
              if (feature[field] !== undefined && feature[field] !== null) {
                copy[field] = feature[field];
              }
            }
            device.features.push(copy);
            published.add(feature.external_id);
          }
        }
        this.known.set(device.external_id, device);
      }
    }
    const devices = [...this.known.values()];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** The values of the shades reported recently and reachable, for the created features only. */
  queueStates(created = this.createdFeatures()) {
    const hub = this.session?.identity;
    if (!hub) {
      return;
    }
    for (const shade of this.shades.values()) {
      if (
        !shade.online ||
        shade.readAt === undefined ||
        this.now() - shade.readAt > this.freshFor()
      ) {
        continue;
      }
      const ids = shadeIds(this.gladys, hub, shade.id);
      const position = ids.feature(FEATURES.POSITION);
      if (shade.closed !== undefined && created.has(position)) {
        this.publisher.push(position, { state: positionOf(shade.closed) });
      }
      const battery = ids.feature(FEATURES.BATTERY);
      const percent = batteryPercent(shade.type, shade.voltage);
      if (percent !== undefined && created.has(battery)) {
        this.publisher.push(battery, { state: percent });
      }
    }
  }

  /** The badge of a created shade. */
  badgeOf(target) {
    const hub = this.session?.identity;
    const shade = hub === target.hub ? this.shades.get(target.shade) : undefined;
    if (!shade || !shade.online) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    if (this.unconfirmed.has(shade.id)) {
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.unconfirmed };
    }
    if (this.notReached.has(shade.id)) {
      return {
        transport: DEVICE_TRANSPORTS.LOCAL,
        degraded: true,
        message: T.badge.notReached(this.notReached.get(shade.id)),
      };
    }
    return { transport: DEVICE_TRANSPORTS.LOCAL };
  }

  async publishBadges() {
    // Not tried yet since the start: no badge rather than a wrong one.
    if (!this.session?.identity && !this.lastError && !this.certStop()) {
      return;
    }
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      const target = parseExternalId(this.gladys, device?.external_id);
      if (!target || target.key !== undefined) {
        continue;
      }
      entries.push({ external_id: device.external_id, ...this.badgeOf(target) });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badges) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badges = json;
    } catch (err) {
      this.logger.warn(`Transport badges failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its last values and its badge at once. */
  async deviceCreated(device) {
    this.badges = undefined;
    const created = this.createdFeatures();
    for (const feature of device?.features ?? []) {
      created.add(feature.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadges();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    this.badges = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
    await this.updateStatus();
  }

  /** The Discovery tab asks for a scan: the shades of the last report, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration buttons -------------------------------------------------

  /**
   * "Test the connection": the status of the open session; else a connection
   * now, unless the last try was less than an interval ago, a pause holds, or
   * another certificate waits for the user.
   */
  async testConnection() {
    if (!this.config.address || this.certStop() || this.session || this.pause()) {
      await this.updateStatus();
      return this.status()[1];
    }
    const now = this.now();
    const at = Math.max(this.lastAttemptAt + this.interval, this.nextAttemptAt);
    if (now < at) {
      await this.updateStatus();
      return join(T.test.recent(age(at - now)), this.status()[1]);
    }
    this.clearTimer();
    const ok = await this.connect();
    if (ok) {
      await this.waitFor(
        () => !this.session || Boolean(this.session.identity || this.session.noIdentity),
        TIMINGS.connectTimeout,
      );
    }
    await this.publishAll();
    return this.status()[1];
  }

  /**
   * "Trust the new certificate": the first press shows the fingerprint met,
   * the second (within 60 s) pins exactly that one and connects.
   */
  async trustCertificate() {
    const changed = this.memory?.certChanged;
    if (!changed) {
      return T.trustNothing;
    }
    const { fingerprint } = changed;
    if (this.config.pin && this.config.pin !== fingerprint) {
      return T.trustTyped(fingerprint);
    }
    const click = this.trustClick;
    if (!click || click.fingerprint !== fingerprint || this.now() - click.at > TIMINGS.trustClick) {
      this.trustClick = { fingerprint, at: this.now() };
      return T.trustConfirm(fingerprint);
    }
    this.trustClick = undefined;
    this.memory.pin = fingerprint;
    this.memory.certChanged = null;
    await this.saveMemory();
    this.logger.info(`Certificate ${fingerprint} trusted by the user`);
    this.lastError = undefined;
    this.lastStatus = undefined;
    await this.updateStatus();
    this.scheduleConnect();
    return T.trustDone(fingerprint);
  }

  // --- Commands --------------------------------------------------------------

  refusal(text) {
    const error = new Error(word(text, this.config.language));
    error.refusal = true;
    return error;
  }

  /** What a command asks: { kind: 'stop' } | { kind: 'move', closed }. */
  planOf(key, value) {
    if (key === FEATURES.STATE) {
      const v = numberIn(value, -1, 1);
      if (v === COVER_STATE.STOP) {
        return { kind: 'stop' };
      }
      if (v === COVER_STATE.OPEN) {
        return { kind: 'move', closed: 0 };
      }
      if (v === COVER_STATE.CLOSE) {
        return { kind: 'move', closed: 100 };
      }
      throw this.refusal(ERRORS.badValue);
    }
    const v = numberIn(value, 0, 100);
    if (v === undefined) {
      throw this.refusal(ERRORS.badValue);
    }
    return { kind: 'move', closed: closedFor(v) };
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseExternalId(this.gladys, feature?.external_id);
    if (!target || !COMMAND_KEYS.has(target.key)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const plan = this.planOf(target.key, value);
    if (plan.kind === 'stop') {
      return this.stopNow(target, received);
    }
    return this.move(target, plan, received);
  }

  /** Whether the session may carry a move to this shade: the hub of the device reported it. */
  ready(target) {
    const session = this.session;
    return Boolean(
      session?.conn.open && session.identity === target.hub && this.shades.has(target.shade),
    );
  }

  async move(target, plan, received) {
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const ticket = { cancelled: false, generation: this.generation };
    if (!this.tickets.has(target.shade)) {
      this.tickets.set(target.shade, new Set());
    }
    this.tickets.get(target.shade).add(ticket);
    try {
      const check = () => {
        if (ticket.cancelled) {
          throw this.refusal(ERRORS.stopped);
        }
        if (ticket.generation !== this.generation) {
          throw this.refusal(ERRORS.configChanged);
        }
        if (this.certStop()) {
          throw this.refusal(ERRORS.certificate);
        }
        const session = this.session;
        if (!session?.conn.open) {
          throw this.refusal(ERRORS.notConnected);
        }
        if (!session.identity) {
          throw this.refusal(ERRORS.identityUnknown);
        }
        if (session.identity !== target.hub) {
          throw this.refusal(ERRORS.otherHub);
        }
        if (!this.shades.has(target.shade)) {
          throw this.refusal(ERRORS.unknownShade);
        }
        if (this.now() > sendBy) {
          throw this.refusal(ERRORS.tooSlow);
        }
      };
      if (!this.ready(target) && (this.connecting || (this.session && !this.session.identity))) {
        // A connection or its first report under way: waited for, within the deadline.
        await this.waitFor(
          () => ticket.cancelled || this.ready(target) || (!this.connecting && !this.session),
          sendBy - 200 - this.now(),
        );
      }
      // The very last check, right before the bytes leave (synchronous with the write).
      check();
      const session = this.session;
      const sentAt = this.now();
      const seq = this.reportSeq;
      const written = session.conn.send(movePayload(target.shade, plan.closed, sentAt));
      const result = await written;
      const name = `Shade ${target.shade}: ${100 - plan.closed} % open`;
      if (result === 'closed') {
        this.logger.warn(`${name} NOT sent (connection closed)`);
        throw this.refusal(ERRORS.notSent);
      }
      this.targets.set(target.shade, plan.closed);
      this.notReached.delete(target.shade);
      this.followUp(target.shade);
      if (result === 'failed') {
        return this.unconfirmedAfter(target.shade, name);
      }
      // Accepted once the hub reports the shade moving, or already there.
      this.ask(session.epoch);
      const accepted = await this.waitFor(() => {
        const shade = this.shades.get(target.shade);
        return Boolean(
          shade &&
          shade.readSeq > seq &&
          (shade.moving ||
            (shade.closed !== undefined &&
              Math.abs(shade.closed - plan.closed) <= LIMITS.positionTolerance)),
        );
      }, answerBy - this.now());
      if (!accepted) {
        return this.unconfirmedAfter(target.shade, name);
      }
      this.logger.info(`${name} sent and accepted`);
      return undefined;
    } finally {
      this.tickets.get(target.shade)?.delete(ticket);
    }
  }

  /** A command that may have reached the hub, not confirmed: never told "not sent". */
  unconfirmedAfter(shadeId, name) {
    this.unconfirmed.add(shadeId);
    this.badges = undefined;
    this.publishBadges().catch(() => {});
    this.logger.warn(`${name} sent, NOT confirmed`);
    throw this.refusal(ERRORS.sentUnconfirmed);
  }

  /**
   * STOP: no queue, no report needed (the hub behind the pinned certificate
   * is the one kept in /data), through a pause (one connection try). Every
   * move of that shade not written yet is cancelled first, even when this
   * STOP fails.
   */
  async stopNow(target, received) {
    for (const pending of this.tickets.get(target.shade) ?? []) {
      pending.cancelled = true;
    }
    this.wake();
    this.targets.delete(target.shade);
    this.notReached.delete(target.shade);
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    if (this.certStop()) {
      throw this.refusal(ERRORS.certificate);
    }
    if (!this.config.address) {
      throw this.refusal(ERRORS.notConnected);
    }
    if (!this.session?.conn.open) {
      // One try, now, whatever the pause or the backoff (the hub is never
      // asked anything else by it).
      this.clearTimer();
      await this.connect({ timeout: sendBy - 200 - this.now() });
    }
    const session = this.session;
    if (!session?.conn.open) {
      throw this.refusal(ERRORS.notConnected);
    }
    const hub = session.identity ?? this.memory.hub;
    if (hub && hub !== target.hub) {
      throw this.refusal(ERRORS.otherHub);
    }
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    const seq = this.reportSeq;
    const result = await session.conn.send(stopPayload(target.shade, this.now()));
    const name = `Shade ${target.shade}: stop`;
    if (result === 'closed') {
      this.logger.warn(`${name} NOT sent (connection closed)`);
      throw this.refusal(ERRORS.notSent);
    }
    this.followUp(target.shade);
    if (result === 'failed') {
      return this.unconfirmedAfter(target.shade, name);
    }
    this.ask(session.epoch);
    const still = await this.waitFor(() => {
      const shade = this.shades.get(target.shade);
      return Boolean(shade && shade.readSeq > seq && !shade.moving);
    }, answerBy - this.now());
    if (!still) {
      return this.unconfirmedAfter(target.shade, name);
    }
    this.logger.info(`${name} sent, the shade is still`);
    return undefined;
  }

  /**
   * Reads after a command, spaced over the travel of the shade; one series
   * per shade (a new command replaces it). After the last one, a position
   * asked and not read is shown on the badge.
   */
  followUp(shadeId) {
    const generation = this.generation;
    for (const handle of this.followUps.get(shadeId) ?? []) {
      this.timers.clearTimeout(handle);
    }
    const handles = new Set();
    this.followUps.set(shadeId, handles);
    TIMINGS.followUps.forEach((delay, index) => {
      const last = index === TIMINGS.followUps.length - 1;
      const handle = this.timers.setTimeout(() => {
        handles.delete(handle);
        if (generation !== this.generation || !this.session) {
          return;
        }
        if (last && this.targets.has(shadeId)) {
          // The travel is over and the position asked was never read.
          this.targets.delete(shadeId);
          const shade = this.shades.get(shadeId);
          if (shade?.closed !== undefined) {
            this.notReached.set(shadeId, positionOf(shade.closed));
            this.unconfirmed.delete(shadeId);
          }
          this.badges = undefined;
          this.publishBadges().catch(() => {});
        }
        this.ask(this.session.epoch);
      }, delay);
      handles.add(handle);
    });
  }
}
