# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

### Fixed

- A STOP held after a click is no longer written again after a newer move (a
  report arriving while the move was being written could stop it).
- A dropped connection is no longer reopened at once for a STOP whose
  rewrites are all spent.

## [0.1.1] - 2026-10-23

### Added

- Rollease Acmeda Automate shades through the Pulse Hub v2, on the local
  network: each shade is a shutter of the Discovery tab, with open, close,
  stop, its position, and the battery of battery motors. Never a switch.
- The names of the shades read from the hub (TCP port 1487).
- The self-signed certificate of the hub pinned at the first connection (or
  typed); another one stops everything until it is trusted (its fingerprint
  in the status, a "Trust the new certificate" button pressed twice).
- Moves decided on the report of the hub, sent within 3.5 s or refused,
  "accepted" only on a change the order caused (a shade already moving proves
  nothing), else "sent, without confirmation"; a position confirmed only by a
  report equal to it, the badge showing a position not reached; an empty or
  unreadable position is unknown, never "open".
- STOP never queued, before the first report after a restart and through a
  pause (one connection try, at most every 5 s, within its own deadline); it
  cancels the moves not sent yet, and is written again for a minute while the
  hub still reports the shade moving, first thing on the next connection when
  the connection dropped.
- The identity of the hub kept once known: a report missing its MAC (or any
  identity) is never taken as another hub; only a MAC (or hubId) that differs.
- One state request of the hub at a time, at most one per second, for all the
  shades; one schedule of follow-up reads for the hub after the last order; the
  Discovery tab sent at most 5 times per 10 s.
- A fingerprint typed and verified is kept in `/data`: emptying the field
  never relearns the certificate blindly; a wrong fingerprint typed then
  removed goes back to the pinned one.
- A 429 or a 5xx pauses the connections (1 minute to 6 hours, kept in
  `/data`); never connected sooner than the read interval, a restart included.
- A "Test the connection" button, English and French texts.

[Unreleased]: https://github.com/LM1LC3N7/gladys-automate-pulse/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-automate-pulse/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-automate-pulse/releases/tag/v0.1.1
