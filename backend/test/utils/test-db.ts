import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import {
  ADMIN_URL_ENV,
  EXTERNAL_URL_ENV,
  TEMPLATE_ENV,
  withDatabase,
} from './test-postgres';

export interface TestDb {
  connectionString: string;
  stop(): Promise<void>;
}

/**
 * A migrated, empty database of this suite's own, on the server the whole run
 * shares.
 *
 * This used to start a `postgres:17-alpine` container per suite and replay
 * `drizzle/` into it, which is where the run's memory went: `maxWorkers`
 * containers plus `maxWorkers` copies of the whole Nest app, on a machine
 * whose Docker VM already holds half the RAM. A suite now pays a
 * `create database … template …` — a file copy inside a server that is already
 * up, with the migrations already replayed into the template by `globalSetup`.
 *
 * Isolation is unchanged: a separate database is as private as a separate
 * server for everything the suites assert, and each one is dropped in `stop()`.
 * What is now shared is the server process, so a suite that changes something
 * cluster-wide (a role, a `postgresql.conf` setting) would be visible to the
 * others — none do, and one that needs to should start its own container the
 * way `databases/mariadb-image-migration.e2e-spec.ts` does.
 */
export async function startTestDb(): Promise<TestDb> {
  const adminUrl = process.env[ADMIN_URL_ENV];
  const template = process.env[TEMPLATE_ENV];
  if (!adminUrl || !template) {
    throw new Error(
      `startTestDb() needs the shared server ${ADMIN_URL_ENV} names, which ` +
        `test/utils/global-setup.ts sets. A jest config that runs a suite ` +
        `calling this has to declare globalSetup/globalTeardown.`,
    );
  }

  const name = `cg_test_${randomBytes(8).toString('hex')}`;
  await withAdmin(adminUrl, async (admin) => {
    await admin.query(`create database "${name}" template "${template}"`);
    // Every commit in this database is a commit nothing is allowed to outlive
    // the suite, so waiting for the WAL to reach the platter buys it nothing
    // and costs it a fsync per transaction. Set per database rather than on
    // the server, because the server may not be ours: under
    // `TEST_POSTGRES_URL` it is a development one we borrowed, and this is the
    // half of the container's `fsync=off` that can be scoped to the databases
    // we created and dropped ourselves.
    await admin.query(`alter database "${name}" set synchronous_commit = off`);
  });

  return {
    connectionString: withDatabase(adminUrl, name),
    stop: async () => {
      await withAdmin(adminUrl, (admin) =>
        // `force` because a suite that leaves a connection open should fail on
        // its own assertion, not on an undroppable database here.
        admin.query(`drop database if exists "${name}" with (force)`),
      );
    },
  };
}

async function withAdmin<T>(
  adminUrl: string,
  run: (admin: Pool) => Promise<T>,
): Promise<T> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    return await run(admin);
  } finally {
    await admin.end();
  }
}

export { EXTERNAL_URL_ENV };
