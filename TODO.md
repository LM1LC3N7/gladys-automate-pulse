# TODO — Automate Pulse Hub v2

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test` (Node
  22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own, no forum post from a module session (one
  post per wave in /t/10385).

## Status

- [x] **Milestone 1 — core** (2026-10-23): WebSocket client on one TLS socket
      (pinned self-signed certificate, bounded upgrade and frames), aiopulse2
      protocol (shadow, movePercent, stopShade, query, brace repair), names on
      port 1487, one shutter per shade (state, position, battery), commands
      with deadlines and acceptance, STOP outside any queue, pause 429/5xx and
      last try in /data, certificate change as a final stop with a two-press
      trust button, Test button, en/fr, docs, cover. Tested against a
      simulated hub on 127.0.0.1 only.
- [x] **Milestone 1 fixes — review 1** (2026-10-23): identity kept unless
      proven different (B1), acceptance only on a change the order caused
      (I1), STOP held and written again, first on the next session, session
      reopened at once after a drop (I2), blank `mp` unknown (I3), one shared
      state request and one follow-up schedule for the hub (I4), typed
      fingerprint kept in /data (I5), m1-m8, burst test of the frames right
      behind the upgrade.
- [ ] **Milestone 2 — real hub**: run against a real Pulse Hub v2 (and a Pulse
      Pro Hub) and compare with the app (see "To check"); turn the answers
      (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: several hubs, tilt (`tiltpercent` of the serial
      protocol) if a real hub reports it, the radio signal as a sensor if
      useful.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public.

## To check on a real hub

- Whether the hub pushes reports by itself, or only answers the shadow
  request (aiopulse2 asks every 2 s; 10 s here by default).
- The certificate of the hub: is it the same on every hub (then the pin only
  proves "a Pulse hub", and the MAC check of the report does the rest)? Does
  it change after a firmware update (then the user sees the trust button)?
- The shade ids (three characters in the serial protocol): the same keys in
  the WebSocket `shades`?
- `is` during a move and right after a `movePercent` (the acceptance waits for
  `is: false` or the position); the time a full travel takes (follow-up reads
  at 1.5, 4, 10, 25, 50 s).
- Whether the hub answers a `query` with `vo` quickly, and the voltages of the
  battery motors (the percent is aiopulse2's estimate).
- Port 1487: still open on recent firmware? The answer format of the names.
- HTTP 429/5xx on the upgrade: never seen; handled as a pause anyway.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-automate-pulse:0.1.0`): the first patch release
  gives 0.1.1.
- **aiopulse2 (Apache-2.0)** is ported, not run (Python). Credited in
  THIRD_PARTY_NOTICES.md, copied into the image. Local only, `transports:
["local"]`.
- **WebSocket written by hand** on one `tls.connect` socket (no `http.request`,
  no agent: never a second connection, lesson of lot 13); the frame parser
  comes from gladys-system-bridge. Tested against a real TLS server on
  loopback that counts the connections.
- **Certificate pinned** (aiopulse2 does not check it at all): learned at the
  first connection (trust on first use), or typed in the optional field;
  checked before any byte is written. Another one is a final stop in /data:
  never relearned by itself, a config save lifts nothing; lifted only by
  typing exactly that fingerprint or pressing the trust button twice within
  60 s (it pins exactly the fingerprint shown). Nothing is secret otherwise
  (the hub has no password): no `secret` field.
- **Shutter, never switch/binary**; position only in `shutter` (Gladys 100 =
  open = `mp` 0). `mp` missing is "unknown", never 100 (aiopulse2's default).
  Battery as `battery/integer` % (unit of the core for that category) for
  motor types D, U, d only; it may appear after the device was created
  (details come with `vo`, asked at most once an hour per shade): the user
  then updates the device (no feature is ever removed).
- **Identity rule** (frozen: it fixes the external ids): hub MAC (12 hex, lower
  case) else `id-<hubId>` (plain, lower case), a dash, the shade id as given
  (case kept): `ext:<selector>:shade:<hub>-<shade>`. No identity: nothing
  published, status says so.
- **Not sensitive**: shades are not in the list of sensitive commands (no
  gate, no garage door): open and close are plain moves, no option. **STOP is
  the protective command**: no queue, through a pause (one connection try),
  before the first report (hub identity kept in /data), cancels the moves not
  written yet. Moves and STOP share the one ordered socket, so a STOP written
  after a move always reaches the hub after it (no second STOP needed).
- **Acceptance vs confirmation**: the hub never acknowledges an order. A move
  is "accepted" (success) when a report received after the write shows the
  shade moving or within 2 % of the target, by 4.3 s; else "sent, without
  confirmation" (never "not sent" once written). The position is confirmed
  only by a report equal to it; after the last follow-up (50 s) a target not
  reached shows on the badge.
- **Reads**: one shadow request per interval on the open session, plus the
  follow-ups after a command; a connection never sooner than the interval
  after the last try (kept in /data before connecting, at most once a minute;
  after a restart that minute is added); backoff 10 s, 30 s, 1, 2, 5 min;
  429/5xx on the upgrade: pause 1 min to 6 h in /data. A silent session (3
  intervals, 30 s at least) is dropped.
- **Names** on TCP 1487, one short read-only exchange (8 KB, 4 s), at most
  three tries per shade spaced 10 min; a shade is published once its name was
  asked (fallback "Store/Shade <id>"). Port 1487 is plain TCP, not tied to the
  pin: names only, cleaned and bounded (said in the docs).
- **One hub** per integration in v1.

### Decisions of review 1

- **Identity (B1)**: the identity (MAC, else `id-<hubId>`) is set at the first
  report and frozen (never downgraded nor upgraded: it fixes the external
  ids). The facts read (`hubMac`, `hubId`) are merged into /data while
  nothing contradicts them (written only when they change). Another hub only
  on a fact of the same nature that differs (the MAC when both reports have
  one, else the hubId). A report with no fact at all neither proves another
  hub nor lifts the check of a session not verified yet. STOP is refused
  only on a proven other hub. The shades are kept across sessions of the same
  hub (motor type, names, review m3).
- **Acceptance (I1)**: on a report after the write: the position asked; or a
  shade still in the last report before the write now moving; or a moving
  shade whose position got closer to the one asked by more than 2 %. The
  app can only judge on what it read: a shade still in its last report and
  moving afterwards is taken as the order's doing.
- **STOP held (I2)**: once written, held 60 s: written again on a later
  report that still shows the shade moving (3 times at most), first thing on
  a new session; a session lost while a STOP is held is reopened at once (one
  try, at most every 5 s, outside the backoff). Lifted by a report showing
  the shade still, or by a newer move really written (never by one refused or
  not sent). A move written before a STOP keeps no target (m2).
- **Rhythm (I4)**: one state request in flight, another within 1 s waits for
  its answer (merged); one follow-up schedule for the hub, set again on the
  last order; the Discovery tab at most 5 times per 10 s (m4), the rest sent
  later in one go (a scan or a reconnection to Gladys always goes).
- **Pin (I5, m7)**: the fingerprint of every verified connection is kept in
  /data (learned or typed). A certificate change whose fingerprint is the one
  pinned is lifted when the typed field is emptied.
- **STOP connection (m1, m8)**: waited for within the STOP's own deadline
  (3.3 s, real time), whatever connection is under way; a failed connection
  never waits for its publication to Gladys; at most one STOP connection try
  every 5 s.
- **Frames behind the upgrade**: parsed synchronously in the same data event
  as the end of the upgrade answer (never deferred); tested with the upgrade
  and four frames split into back-to-back packets (the test fails when the
  parse is deferred). Reports that arrive before the session is set (same
  packet) are kept (4 at most) and applied once it is.
