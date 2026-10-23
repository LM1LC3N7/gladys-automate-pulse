# Third-party notices

This integration ports to JavaScript the knowledge of the local protocol of the
Rollease Acmeda Automate Pulse Hub v2 held by the following project: the
WebSocket at `wss://<hub>:443/rpc`, the `shadow` request and its answer
(`result.reported`: `name`, `hubId`, `mac`, `firmware`, `mfi`, `matter`,
`shades` with `mp`, `is`, `ol`, `rs`, `vo`), the `desired` orders
(`movePercent`, `stopShade`, `query`), the repair of a message missing closing
braces, the motor types and the voltage string, the battery estimate, and the
names read on TCP port 1487 (`!<id>NAME?;`). No file is copied, and nothing of
it is installed at runtime. It is distributed under the Apache License,
Version 2.0, the same licence as this repository, whose full text is in the
`LICENSE` file (copied into the image); its repository holds no NOTICE file.

## aiopulse2

<https://github.com/sillyfrog/aiopulse2> (tag v1.0.0, commit e8b47c4 of
2025-08-30; `setup.py` 1.0.0), by Sillyfrog (author named in its `setup.py`),
the library of the Automate Pulse v2 integration of Home Assistant. Its
`LICENSE` file is the Apache License 2.0 text, whose appendix keeps the
placeholders as they are:

```
Copyright [yyyy] [name of copyright owner]

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

Changes: the logic was rewritten in JavaScript for Node.js (`src/pulse/`). The
certificate of the hub, which aiopulse2 does not check, is pinned here; the
messages and answers are bounded; a missing position is taken as unknown
(aiopulse2 assumes 100); the details are asked at most once an hour per shade,
as aiopulse2 does.

## LM1LC3N7/gladys-slide, gladys-warema, gladys-system-bridge and gladys-elk-m1

`src/publisher.js` (from gladys-warema), the frame parser of `src/pulse/ws.js`
(from gladys-system-bridge), the pinning of a self-signed certificate and its
"trust" button (after gladys-elk-m1), the structure of `src/app.js`,
`src/config.js` and `src/store.js` (after gladys-slide) and
`test/helpers/selfSigned.js` (from gladys-elk-m1) come from integrations of
the same author, under the Apache License 2.0 of this repository (the
`LICENSE` file).
