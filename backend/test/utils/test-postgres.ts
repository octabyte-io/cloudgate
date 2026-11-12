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
 * The machine-wide lock that stops two `jest` runs from each starting a server.
 *
 * The per-suite container was only half the problem. `globalSetup` bounds a
 * *run*: one server, however many suites. It does not bound a *machine*, and
 * the thing that actually runs these tests is a fan-out of up to five fix
 * agents, each proving a fix red-green,
 * each invoking `jest` of its own. Five invocations is five servers and ten
 * workers at half a gigabyte apiece — which is the 16 GB machine gone, and the
 * reason a run that had been made cheap could still take the box down.
 *
 * So the second run waits rather than doubling the bill. Serial is the right
 * default here because the workers, not the containers, are the memory: two
 * concurrent runs cost roughly what nine workers used to, and this suite's
 * whole point was getting off that. `CLOUDGATE_E2E_NO_LOCK=1` opts out for a
 * machine with the headroom to spare.
 */
const LOCK_PATH = join(tmpdir(), 'cloudgate-e2e-postgres.lock');
const LOCK_POLL_MS = 2_000;
const LOCK_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * Whether the pid in the lock file is a process that still exists.
 *
 * A run killed between `globalSetup` and `globalTeardown` — the ordinary end of
 * a cancelled agent — leaves the file behind, and a lock that only a clean exit
 * can release would wedge every later run on this machine. `kill(pid, 0)`
 * signals nothing and only asks.
 */
function lockHolderIsAlive(): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(LOCK_PATH, 'utf8').trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryAcquireLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_PATH, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (lockHolderIsAlive()) return false;
      try {
        unlinkSync(LOCK_PATH);
      } catch {
        // Another waiter cleared the same stale lock; retry decides it.
      }
    }
  }
  return false;
}

export async function acquireE2eLock(): Promise<void> {
  if (process.env.CLOUDGATE_E2E_NO_LOCK === '1') return;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let announced = false;
  while (!tryAcquireLock()) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after 45 minutes waiting for ${LOCK_PATH}. Another e2e run ` +
          `holds it. Delete the file if no jest process is alive, or set ` +
          `CLOUDGATE_E2E_NO_LOCK=1 to run concurrently anyway.`,
      );
    }
    if (!announced) {
      console.log(
        `[e2e] another run holds ${LOCK_PATH}; waiting rather than starting a second Postgres.`,
      );
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/**
 * Released by pid rather than by a module-level flag, because `globalSetup` and
 * `globalTeardown` are separate entry points and nothing promises they share a
 * module instance. The pid is the one fact both of them agree on.
 */
export function releaseE2eLock(): void {
  try {
    if (Number(readFileSync(LOCK_PATH, 'utf8').trim()) === process.pid) {
      unlinkSync(LOCK_PATH);
    }
  } catch {
    // No lock, or someone else's: nothing of ours to release.
  }
}

export function rememberSharedPostgres(shared: SharedPostgres): void {
  (globalThis as Record<symbol, unknown>)[HANDLE] = shared;
}

export function recallSharedPostgres(): SharedPostgres | undefined {
  return (globalThis as Record<symbol, unknown>)[HANDLE] as
    SharedPostgres | undefined;
}
