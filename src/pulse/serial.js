// -----------------------------------------------------------------------------
// The names of the shades. The WebSocket of the hub does not give them; the
// serial-like protocol of the hub on TCP port 1487 does (aiopulse2
// Hub.serialrunner): one short connection, the questions written at once, the
// answers read until the hub is silent, then closed. Read only: no command
// ever goes this way. Bounded in bytes (8 KB) and in time; a failure only
// leaves the names unknown (the shade is then named after its id).
// -----------------------------------------------------------------------------

import { connect as netConnect } from 'node:net';
import { LIMITS, TIMINGS } from '../constants.js';
import { askNames, namesOf } from './protocol.js';

export function fetchNames({
  host,
  port,
  ids,
  timeout = TIMINGS.serialTimeout,
  idle = TIMINGS.serialIdle,
  connect = netConnect,
}) {
  const question = askNames(ids);
  if (question === '') {
    return Promise.resolve(new Map());
  }
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    let idleTimer;
    const socket = connect({ host, port });
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(overall);
      clearTimeout(idleTimer);
      socket.destroy();
      resolve(namesOf(Buffer.concat(chunks, bytes).toString('utf8')));
    };
    const overall = setTimeout(finish, timeout);
    const quiet = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, idle);
    };
    socket.on('error', finish);
    socket.on('close', finish);
    socket.on('connect', () => {
      socket.write(question);
      quiet();
    });
    socket.on('data', (chunk) => {
      const room = LIMITS.serialBytes - bytes;
      if (room <= 0) {
        finish();
        return;
      }
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(kept);
      bytes += kept.length;
      if (bytes >= LIMITS.serialBytes) {
        finish();
        return;
      }
      quiet();
    });
  });
}
