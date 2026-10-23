# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Rollease Acmeda Automate shades through the Pulse Hub v2, on the local
  network: each shade is a shutter of the Discovery tab, with open, close,
  stop, its position, and the battery of battery motors. Never a switch.
- The names of the shades read from the hub (TCP port 1487).
- The self-signed certificate of the hub pinned at the first connection (or
  typed); another one stops everything until it is trusted (its fingerprint
  in the status, a "Trust the new certificate" button pressed twice).
- Moves decided on the report of the hub, sent within 3.5 s or refused,
  "sent, without confirmation" when the hub does not report them in time, a
  position confirmed only by a report equal to it, the badge showing a
  position not reached.
- STOP at once, never queued, before the first report after a restart and
  through a pause (one try); it cancels the moves not sent yet.
- A 429 or a 5xx pauses the connections (1 minute to 6 hours, kept in
  `/data`); never connected sooner than the read interval, a restart included.
- A "Test the connection" button, English and French texts.

[Unreleased]: https://github.com/LM1LC3N7/gladys-automate-pulse/commits/main
