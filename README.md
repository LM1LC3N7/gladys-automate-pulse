# gladys-automate-pulse

[Gladys Assistant](https://gladysassistant.com) external integration for
**Rollease Acmeda Automate** shades through the **Pulse Hub v2**: each shade
becomes a Gladys shutter of the Discovery tab (open, close, stop, position,
battery of battery motors). Gladys talks to the hub on the local network only,
through its WebSocket (TLS, self-signed certificate, pinned). The cloud is not
used. Unofficial, not affiliated with Rollease Acmeda.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Development version.** Tested against a simulated hub only: it has
> never been tested with a real hub yet. Feedback and bug reports are welcome
> in the [GitHub issues](https://github.com/LM1LC3N7/gladys-automate-pulse/issues).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (PulseApp) ⇄ src/pulse/ws.js ⇄ wss://<hub>:443/rpc
                                   ├─ src/pulse/protocol.js  messages of the hub (pure)
                                   ├─ src/pulse/serial.js    names on TCP 1487 (read only)
                                   ├─ src/devices.js         shades -> Gladys devices, ids (pure)
                                   ├─ src/publisher.js       states within 300/min
                                   └─ src/store.js           /data: last try, pause, pin, hub identity
```

- **Protocol** (from aiopulse2): one WebSocket; `{"method":"shadow",...}` asks
  the state, answered by `result.reported` (hub identity, and per shade `mp`
  percent closed, `is` still, `ol` online, `vo` voltage and motor type);
  `desired.shades.<id>.movePercent` / `stopShade` / `query` act. The names of
  the shades come from the serial-like port 1487 (`!<id>NAME?;`).
- **TLS**: the certificate of the hub is self-signed. Its SHA-256 fingerprint
  is learned at the first connection (or typed) and checked after the
  handshake, before any byte is written. Another one is a final stop kept in
  `/data`, lifted only by typing its fingerprint or pressing "Trust the new
  certificate" twice. The upgrade is written by hand on the one TLS socket.
- **Devices**: one `shutter` per shade (`state` write-only, `position` 0 closed
  .. 100 open, `battery` % for battery motors), never a `switch`. Identity rule
  (it fixes the external ids): the MAC of the hub (else `id-<hubId>`), a dash,
  the shade id: `ext:<selector>:shade:<hub>-<shade>`.
- **Commands**: a move is decided on the report of this session (the hub of
  the device, the shade present), written within 3.5 s or refused, "accepted"
  once a later report shows the shade moving or there (by 4.3 s), else "sent,
  without confirmation"; the position is confirmed only by a report equal to
  it. STOP is never queued: written at once, before the first report (the hub
  identity behind the pinned certificate is kept in `/data`), through a pause
  (one connection try), and cancels the moves not written yet.
- **Reads**: the shadow every interval (10 s by default) on the open
  WebSocket, and at 1.5, 4, 10, 25, 50 s after a command. Connections never
  sooner than the interval after the last try (Test button, reconnection to
  Gladys, unchanged save, restart: the time is kept in `/data`, written before
  connecting, at most once a minute). A hub silent for three intervals (30 s at
  least) is dropped.
- **Failures**: 429 or 5xx on the upgrade pauses 1 min to 6 h (kept in
  `/data`); anything else retries after 10 s, 30 s, 1, 2, 5 min. A
  reconnection to Gladys publishes the status, the Discovery and the badges
  again, and connects to nothing.

## Reused work

- [sillyfrog/aiopulse2](https://github.com/sillyfrog/aiopulse2) (Apache-2.0),
  the Python library of the Automate Pulse v2 integration of Home Assistant:
  the protocol is **ported** to JavaScript (it cannot run in this Node
  container).
- [LM1LC3N7/gladys-slide](https://github.com/LM1LC3N7/gladys-slide),
  gladys-warema, gladys-system-bridge and gladys-elk-m1, integrations of the
  same author: the app structure, the state publisher, the WebSocket frame
  parser and the certificate pinning.

Notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), copied into the
image. The only runtime dependency is the Gladys SDK.

## Development

```bash
npm install
npm test                                        # node --test, loopback only
npm run lint && npm run format:check
npm run audit
npm run cover                                   # cover.png, 800×534, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/helpers/fakeHub.js` simulates a hub on 127.0.0.1: a real TLS server with
a self-signed certificate, the WebSocket and the name port; it counts the
connections. See TODO.md, "To check on a real hub".

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic lists the repository in the Gladys store.

## License

Apache-2.0 (see [LICENSE](LICENSE)); ported logic under Apache-2.0, see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Automate and Pulse are
trademarks of Rollease Acmeda; this project is not affiliated with Rollease
Acmeda.
