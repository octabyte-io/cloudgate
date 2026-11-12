'use strict';

/**
 * How many e2e workers this machine has room for, from 1 up to 4.
 *
 * Shared by `test/jest-preset.js`, which forks that many workers for one run,
 * and by the machine-wide lock in `test-postgres.ts`, which hands out that
 * many slots across every run on the machine. Plain JavaScript because the
 * preset is.
 *
 * **Why more than the old 2.** A worker spends most of an e2e file waiting on
 * Postgres and libuv rather than on its own CPU: a CPU profile of
 * `rbac.e2e-spec.ts` found the main thread idle for 28 of its 38 s. So
 * workers scale nearly linearly until the cores run out. A full run of 380
 * suites took about 70 minutes at 2 workers and 24 minutes at 4 on a 4-core,
 * 16 GB machine (2026-11-12), peaking at 8.6 GB for the whole machine with
 * Postgres, with no `ran out of memory` and no `Right-hand side of 'instanceof'
 * is not an object`. That error is what the old cap was set against, at
 * jest's own default worker count.
 *
 * **Why the room is measured.** One worker peaks at about 2.2 GB of RSS before
 * `workerIdleMemoryLimit` recycles it, so 2.5 GB is budgeted per worker after
 * 2 GB for Postgres and the jest main process, and never more workers than
 * cores. A 2-vCPU, 7 GB runner gets 2, as before; a 16 GB, 4-core laptop
 * gets 4.
 */
function machineWorkers() {
  const os = require('node:os');
  const GB = 1024 ** 3;
  const byMemory = Math.floor((os.totalmem() - 2 * GB) / (2.5 * GB));
  return Math.max(1, Math.min(4, os.availableParallelism(), byMemory));
}

/**
 * `CLOUDGATE_E2E_WORKERS` when it is a whole number of at least 1, else
 * `machineWorkers()`.
 *
 * An environment variable rather than `--maxWorkers` because
 * `pnpm test:e2e -- --maxWorkers=…` hands jest a literal `--` and the flag
 * becomes a path pattern (`backend/README.md`), and because it reaches every
 * lane on the preset at once.
 */
function e2eWorkers() {
  const raw = process.env.CLOUDGATE_E2E_WORKERS;
  const asked = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(asked) && asked >= 1 ? asked : machineWorkers();
}

module.exports = { machineWorkers, e2eWorkers };
