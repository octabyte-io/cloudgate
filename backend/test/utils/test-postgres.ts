import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { machineWorkers } = require('./worker-budget') as {
  machineWorkers: () => number;
};

const POSTGRES_IMAGE = 'postgres:17-alpine';
const MIGRATIONS_FOLDER = join(__dirname, '..', '..', 'drizzle');

/**
 * The migrated database every per-suite database is copied from.
 *
 * `create database … template …` is a file copy inside the server, so a suite
 * pays a copy rather than a replay of `drizzle/`'s 65 migrations — the folder
 * runs to `0064`, so the count is one `ls drizzle` away and this sentence
 * cannot quietly rot the way "63" did. That is the whole reason the template
 * exists: the migrations run once per `jest` invocation instead of once per
 * suite.
 */
export const TEMPLATE_DB = 'cloudgate_test_template';

/** Set by `global-setup`, read by `startTestDb` in every worker. */
export const ADMIN_URL_ENV = 'TEST_PG_ADMIN_URL';
export const TEMPLATE_ENV = 'TEST_PG_TEMPLATE';

/**
 * Point the suite at a Postgres that is already running instead of starting a
 * container for it — e.g. `postgresql://postgres:postgres@localhost:5432/postgres`
 * for the `local-postgres` container kept up for development.
 *
 * The server is used as a *server*: every suite still gets its own freshly
 * created database on it and drops it afterwards, so nothing a test does is
 * visible to the databases already on that server. What it does mean is that
 * the tests run against whatever major version that server is, so a mismatch
 * with `POSTGRES_IMAGE` is a real (if usually harmless) divergence from CI.
 */
export const EXTERNAL_URL_ENV = 'TEST_POSTGRES_URL';

interface SharedPostgres {
  container?: StartedPostgreSqlContainer;
  adminUrl: string;
}

const HANDLE = Symbol.for('cloudgate.test.postgres');

export function withDatabase(uri: string, database: string): string {
  const url = new URL(uri);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Start (or adopt) the one Postgres server the whole run shares, and build the
 * migrated template database on it.
 *
 * The server is tuned for a workload whose durability guarantee is "none of
 * this outlives the run": `fsync`, `synchronous_commit` and `full_page_writes`
 * all cost a suite real time and buy a throwaway database nothing. The
 * connection ceiling is raised because the ceiling is now shared — every
 * worker's app holds a `pg` pool (10 by default) against this one server,
 * where each worker used to have a whole server to itself.
 */
export async function startSharedPostgres(): Promise<SharedPostgres> {
  const external = process.env[EXTERNAL_URL_ENV];
  if (external) return { adminUrl: external };

  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withCommand([
      'postgres',
      '-c',
      'max_connections=400',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ])
    .start();

  return { container, adminUrl: container.getConnectionUri() };
}

export async function createTemplateDatabase(adminUrl: string): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${TEMPLATE_DB}" with (force)`);
    await admin.query(`create database "${TEMPLATE_DB}"`);
  } finally {
    await admin.end();
  }

  const pool = new Pool({
    connectionString: withDatabase(adminUrl, TEMPLATE_DB),
    max: 1,
  });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

export async function dropTemplateDatabase(adminUrl: string): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${TEMPLATE_DB}" with (force)`);
  } finally {
    await admin.end();
  }
}

/**
 * The machine-wide lock that keeps every `jest` run on the box inside one
 * worker budget.
 *
 * The per-suite container was only half the problem. `globalSetup` bounds a
 * *run*: one server, however many suites. It does not bound a *machine*, and
 * the thing that actually runs these tests is a fan-out of agents (`/build`'s
 * implementers, `/fix`'s), each proving its work red-green with `jest` of its
 * own. Unbounded, five invocations are five servers and twenty workers, which
 * is the 16 GB machine gone.
 *
 * **Slots, not one lock.** It used to be a single lock: a second run waited for
 * the first to finish, however small either was. That serialised a fan-out of
 * agents each running one or two files, which use one worker apiece, behind
 * one another, while the machine had room for four. So the machine now has
 * `machineWorkers()` slots (`worker-budget.js`) and a run takes one per worker
 * it can use (`slotsFor`): a full run takes them all, a run of one file takes
 * one. Four agents each running a file go at once; a full run waits for them,
 * and they for it. The workers, not the containers, are the memory, so a
 * second container per concurrent run is the cheap part.
 *
 * **One waiter at a time.** A run that cannot get all its slots at once would
 * otherwise watch a stream of one-slot runs take every slot that frees up, and
 * a run that held some slots while waiting for more could deadlock another
 * doing the same. So a waiter first takes the queue file, and only the queue's
 * holder claims slots, all of them or none; it lets the queue go once it has
 * them. Nobody holding slots ever waits for anything, so nothing deadlocks,
 * and runs start in roughly the order they asked.
 *
 * Slot 0 keeps the lock's old name, `cloudgate-e2e-postgres.lock`; slot n is
 * that name plus `.n`. `CLOUDGATE_E2E_NO_LOCK=1` opts out for a machine with
 * the headroom to spare.
 */
const LOCK_PATH = join(tmpdir(), 'cloudgate-e2e-postgres.lock');
const QUEUE_PATH = join(tmpdir(), 'cloudgate-e2e-postgres.queue');
const LOCK_POLL_MS = 2_000;
const LOCK_TIMEOUT_MS = 45 * 60 * 1000;

const slotPath = (slot: number) =>
  slot === 0 ? LOCK_PATH : `${LOCK_PATH}.${slot}`;

/**
 * How many slots a run takes: one per worker it can use, never more than the
 * machine has. jest never forks more workers than it has test files, so a
 * `--runTestsByPath` run of two files takes two slots even at four workers.
 * Any other run (a full one, a path pattern) cannot be counted here, because
 * jest has not listed its files yet, so it takes one per worker.
 */
export function slotsFor(globalConfig?: {
  maxWorkers?: number;
  runTestsByPath?: boolean;
  nonFlagArgs?: string[];
}): number {
  const machine = machineWorkers();
  const workers = globalConfig?.maxWorkers ?? machine;
  const files =
    globalConfig?.runTestsByPath && globalConfig.nonFlagArgs?.length
      ? globalConfig.nonFlagArgs.length
      : Infinity;
  return Math.max(1, Math.min(workers, files, machine));
}

/**
 * Whether the pid in a lock file is a process that still exists.
 *
 * A run killed between `globalSetup` and `globalTeardown` — the ordinary end of
 * a cancelled agent — leaves its files behind, and a lock that only a clean
 * exit can release would wedge every later run on this machine. `kill(pid, 0)`
 * signals nothing and only asks.
 */
function holderIsAlive(path: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(path, 'utf8').trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryTake(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (holderIsAlive(path)) return false;
      try {
        unlinkSync(path);
      } catch {
        // Another waiter cleared the same stale file; retry decides it.
      }
    }
  }
  return false;
}

/** Releases `path` only if this process holds it. */
function releaseIfOurs(path: string): void {
  try {
    if (Number(readFileSync(path, 'utf8').trim()) === process.pid) {
      unlinkSync(path);
    }
  } catch {
    // Not there, or someone else's: nothing of ours to release.
  }
}

/** `wanted` free slots taken at once, or none taken and false. */
function tryTakeSlots(wanted: number): boolean {
  const taken: number[] = [];
  for (let slot = 0; slot < machineWorkers() && taken.length < wanted; slot++) {
    if (tryTake(slotPath(slot))) taken.push(slot);
  }
  if (taken.length === wanted) return true;
  for (const slot of taken) releaseIfOurs(slotPath(slot));
  return false;
}

export async function acquireE2eLock(slots = 1): Promise<void> {
  if (process.env.CLOUDGATE_E2E_NO_LOCK === '1') return;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let announced = false;
  for (;;) {
    if (tryTake(QUEUE_PATH)) {
      try {
        if (tryTakeSlots(slots)) return;
      } finally {
        // Held only while claiming: a run that got its slots lets the next
        // waiter in, and one that did not lets the queue go round again.
        releaseIfOurs(QUEUE_PATH);
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after 45 minutes waiting for ${slots} of the ` +
          `${machineWorkers()} e2e slots (${LOCK_PATH} and its .n siblings). ` +
          `Other e2e runs hold them. Set CLOUDGATE_E2E_NO_LOCK=1 to run ` +
          `concurrently anyway.`,
      );
    }
    if (!announced) {
      console.log(
        `[e2e] other runs hold the e2e slots (${LOCK_PATH}); waiting for ${slots} rather than overloading the machine.`,
      );
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/**
 * Released by pid rather than by a module-level flag, because `globalSetup` and
 * `globalTeardown` are separate entry points and nothing promises they share a
 * module instance. The pid is the one fact both of them agree on. Every slot
 * the machine could have is checked, since the budget is re-measured here.
 */
export function releaseE2eLock(): void {
  for (let slot = 0; slot < Math.max(4, machineWorkers()); slot++) {
    releaseIfOurs(slotPath(slot));
  }
  releaseIfOurs(QUEUE_PATH);
}

export function rememberSharedPostgres(shared: SharedPostgres): void {
  (globalThis as Record<symbol, unknown>)[HANDLE] = shared;
}

export function recallSharedPostgres(): SharedPostgres | undefined {
  return (globalThis as Record<symbol, unknown>)[HANDLE] as
    SharedPostgres | undefined;
}
