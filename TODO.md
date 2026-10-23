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
  asked (fallback "Store/Shade <id>").
- **One hub** per integration in v1.
