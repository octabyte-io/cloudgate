import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';

import { INFRASTRUCTURE_STATE_SCHEMA } from '../../../src/cloud-accounts/definitions/tofu-json';
import { TofuRunner } from '../../../src/cloud-accounts/tofu/tofu-runner';
import type { TofuApplyRequest } from '../../../src/cloud-accounts/cloud.port';
import type { TofuCredential } from '../../../src/cloud-accounts/cloud.port';

/**
 * One run per state (ADR-0036 §4): the real pinned OpenTofu's `pg` backend, through the real runner,
 * against a real Postgres made as an install makes it — no cloud at all.
 *
 * OpenTofu 1.13.1's `pg` backend (`internal/backend/remote-state/pg/
 * client.go`) locks a state with
 *
 *   SELECT id, pg_try_advisory_lock(id), pg_try_advisory_lock($1)
 *     FROM <schema>.states WHERE name = $2
 *
 * where `$1` is its workspace-creation key, the negated FNV-32 of
 * `<schema>\0<table>`: one key every state in the schema shares, held for
 * the whole of a new workspace's creation. Two Cloud runs on different
 * states used to fail on it at random. This proves they no longer do, and
 * that a state genuinely held still fails as `lock-held`.
 *
 * Needs `OPENTOFU_BINARY` and `OPENTOFU_PROVIDER_MIRROR` (filled by
 * `install-opentofu.sh`) and Docker. Run with `pnpm test:moto`.
 */

const POSTGRES_IMAGE = 'postgres:17-alpine';
const REPO = resolve(__dirname, '..', '..', '..', '..');
const APP_SECRET = 'state-lock-lane-app-encryption-secret';
const STATE_PASSWORD = 'state-lock-lane-state-login';

/**
 * The `pg` backend's creation key for `infrastructure_state.states`:
 * -FNV-32("infrastructure_state\0states"), worked out by hand from the
 * 1.13.1 source's `composeCreationLockID`.
 */
const CREATION_KEY = -885348656;

let postgres: StartedPostgreSqlContainer;
let runner: TofuRunner;

/** A run with nothing in it but the state backend and one output. */
function run(stateId: string): TofuApplyRequest<TofuCredential> {
  return {
    stateId,
    credential: { accessKeyId: 'unused', secretAccessKey: 'unused' },
    definition: {
      terraform: {
        backend: {
          pg: {
            schema_name: INFRASTRUCTURE_STATE_SCHEMA,
            skip_schema_creation: true,
            skip_table_creation: true,
            skip_index_creation: true,
          },
        },
      },
      output: { state: { value: stateId } },
    },
  };
}

/** A session of its own on the database, as a stray process would hold one. */
async function session(): Promise<Client> {
  const client = new Client({ connectionString: postgres.getConnectionUri() });
  await client.connect();
  return client;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const binary = process.env.OPENTOFU_BINARY;
  const providerMirror = process.env.OPENTOFU_PROVIDER_MIRROR;
  if (!binary || !providerMirror) {
    throw new Error(
      'Set OPENTOFU_BINARY and OPENTOFU_PROVIDER_MIRROR: backend/test/cloud-accounts/moto/install-opentofu.sh <dir> fills them',
    );
  }
  postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('cloudgate')
    .start();

  // The state as an install makes it, as the moto lane does.
  const pool = new Pool({ connectionString: postgres.getConnectionUri() });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: join(REPO, 'backend/drizzle'),
    });
    await pool.query(
      `CREATE ROLE cloudgate_state LOGIN PASSWORD '${STATE_PASSWORD}'`,
    );
    await pool.query(
      readFileSync(join(REPO, 'deploy/opentofu/state-login.sql'), 'utf8'),
    );
  } finally {
    await pool.end();
  }
  const stateUrl = new URL(postgres.getConnectionUri());
  stateUrl.username = 'cloudgate_state';
  stateUrl.password = STATE_PASSWORD;
  stateUrl.searchParams.set('sslmode', 'disable');

  runner = new TofuRunner({
    binary,
    providerMirror,
    stateDatabaseUrl: stateUrl.toString(),
    appEncryptionSecret: APP_SECRET,
    pinsDirectory: join(REPO, 'deploy/opentofu'),
  });
}, 300_000);

afterAll(async () => {
  await postgres?.stop();
});

describe("the pg backend's shared creation lock", () => {
  it.each([2, 3])(
    'lets %i Cloud runs on different, new states plan and apply at once, every round',
    async (runs) => {
      for (let round = 0; round < 3; round++) {
        const states = Array.from(
          { length: runs },
          (_, n) => `state_${runs}_${round}_${n}`,
        );
        const outcomes = await Promise.all(
          states.map((stateId) => runner.apply(run(stateId))),
        );
        expect(outcomes).toEqual(
          states.map((stateId) => ({
            ok: true,
            show: expect.anything() as unknown,
            outputs: { state: stateId },
          })),
        );
      }
    },
  );

  it("makes a new state's workspace once a run elsewhere lets go of the creation key", async () => {
    const elsewhere = await session();
    try {
      await elsewhere.query('SELECT pg_advisory_lock($1)', [CREATION_KEY]);
      const outcome = runner.apply(run('state_after_creation'));
      await pause(1_500);
      await elsewhere.query('SELECT pg_advisory_unlock($1)', [CREATION_KEY]);

      expect(await outcome).toMatchObject({ ok: true });
    } finally {
      await elsewhere.end();
    }
  });

  it('fails in its own words, not as another run on the state, when the creation key is never let go', async () => {
    const elsewhere = await session();
    try {
      await elsewhere.query('SELECT pg_advisory_lock($1)', [CREATION_KEY]);
      const outcome = await runner.plan(run('state_never_created'));

      expect(outcome).toMatchObject({
        ok: false,
        reason: 'state-backend-busy',
        message: expect.stringContaining('state_never_created') as string,
      });
    } finally {
      await elsewhere.end();
    }
  });

  it('still fails a state genuinely held, saying another run is using it, once the wait is up', async () => {
    expect(await runner.apply(run('state_held'))).toMatchObject({ ok: true });
    const elsewhere = await session();
    try {
      const held = await elsewhere.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(id) AS locked FROM ${INFRASTRUCTURE_STATE_SCHEMA}.states WHERE name = $1`,
        ['state_held'],
      );
      expect(held.rows).toEqual([{ locked: true }]);

      const started = Date.now();
      const outcome = await runner.apply(run('state_held'));

      expect(outcome).toMatchObject({
        ok: false,
        reason: 'lock-held',
        message: expect.stringMatching(
          /another run is using this state/i,
        ) as string,
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(10_000);
    } finally {
      await elsewhere.end();
    }
  });
});
