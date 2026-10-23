# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It bridges Rollease Acmeda Automate shades through the Pulse Hub v2 and its
local WebSocket (logic ported from aiopulse2, Apache-2.0).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "STOP"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # cover.png (800×534) in plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/app.js                        PulseApp: session, reads, commands, badges, status, buttons
src/pulse/ws.js                   one TLS socket: pin check, upgrade by hand, bounded frames
src/pulse/protocol.js             messages of the hub (shadow, orders, names), pure
src/pulse/serial.js               names of the shades on TCP 1487 (read only)
src/pulse/errors.js               errors by kind
src/devices.js                    shades -> Gladys devices, ids (pure)
src/publisher.js                  states within 300/min
src/store.js                      /data/automate-pulse-state.json: last try, pause, pin, hub
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       texts in English and French
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
scripts/cover.mjs                 generates cover.png
test/                             node --test, against the SDK's fake Gladys and a simulated
                                  hub on 127.0.0.1 (real TLS, never the network)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Safety rules of this integration

- A shade is a `shutter`, never `switch`/`binary`.
- The certificate of the hub is pinned and checked before any byte is
  written; another one is a final stop lifted only by the user. Never add
  `agent: false` / `http.request` around the socket: one TLS connection only.
- STOP is never queued: through a pause (one try), before the first report;
  it cancels the moves not written yet. Never put it behind anything.
- A move is decided on the report of this session (hub identity of the
  device, shade present), written within 3.5 s or refused; once written it is
  never told "not sent"; never retried; the ack never waits for a publication
  to Gladys. A position is confirmed only by a report equal to it.
- Never connect sooner than the interval after the last try (kept in /data
  before connecting); a reconnection to Gladys (`connected`) clears no pause
  nor stop and connects to nothing.
- Messages are bounded (256 KB, the upgrade 8 KB, the names 8 KB), parsed
  linearly; ids from the network are checked before use, never merged into
  plain objects.

## Rules

- **External ids are forever.** `gladys.externalIds('shade', '<hub>-<shade>')`
  (see src/devices.js). The same goes for every key users store: manifest
  `config_schema`, `actions`, feature keys.
- **A device published again never loses a feature** (`publishDevices`
  merges the features of `gladys.devices`).
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree (never a pinned value).
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  The catalog `description` holds 10 to 100 characters per language. Gladys
  does not protect its configuration: a secret is kept in clear in its
  database, never write otherwise.
- **User-facing text** is bilingual (English and French), kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only). No Bluetooth.
