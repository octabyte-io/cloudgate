import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';

import { InfrastructureStatesService } from '../../src/cloud-accounts/infrastructure-state/infrastructure-states.service';
import { GOOGLE_PROVIDER_VERSION } from '../../src/cloud-accounts/tofu/tofu-environment';
import * as schema from '../../src/db/schema';
import { FakeCloudPort, TestRunSignal } from '../utils/fake-cloud-port';
import { FakeGoogleCloudPort } from '../utils/fake-google-cloud-port';
import { startTestDb } from '../utils/test-db';
import type { TestDb } from '../utils/test-db';

/**
 * The Infrastructure state's home (ADR-0036): the migration makes
 * OpenTofu's `pg` tables so `tofu` creates nothing, and the state login made
 * by `deploy/opentofu/state-login.sql` — the file install.sh runs — reaches
 * that schema and nothing else. Then the service's version and readability
 * gates, against the fake port.
 */

const STATE_LOGIN_SQL = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'deploy',
  'opentofu',
  'state-login.sql',
);

let db: TestDb;
let admin: Client;
/** A role name of this suite's own: roles are cluster-wide and the server is shared. */
const role = `cloudgate_state_${randomBytes(4).toString('hex')}`;
const password = randomBytes(12).toString('hex');
let login: Client;

function asUser(connectionString: string, user: string, pass: string) {
  const url = new URL(connectionString);
  url.username = user;
  url.password = pass;
  return url.toString();
}

beforeAll(async () => {
  db = await startTestDb();
  admin = new Client({ connectionString: db.connectionString });
  await admin.connect();
  const database = new URL(db.connectionString).pathname.slice(1);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await admin.query(
    readFileSync(STATE_LOGIN_SQL, 'utf8')
      .replaceAll('cloudgate_state', role)
      .replace('ON DATABASE cloudgate', `ON DATABASE "${database}"`),
  );
  login = new Client({
    connectionString: asUser(db.connectionString, role, password),
  });
  await login.connect();
});

afterAll(async () => {
  await login?.end();
  // Its grants, here and on the database, then the role itself.
  await admin?.query(`DROP OWNED BY ${role}`);
  await admin?.query(`DROP ROLE IF EXISTS ${role}`);
  await admin?.end();
  await db?.stop();
});

describe('the infrastructure_state schema', () => {
  it("holds OpenTofu's pg backend table, as tofu would have made it", async () => {
    const { rows: columns } = await admin.query<{
      column_name: string;
      data_type: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, column_default FROM information_schema.columns
       WHERE table_schema = 'infrastructure_state' AND table_name = 'states'
       ORDER BY ordinal_position`,
    );
    expect(columns).toEqual([
      {
        column_name: 'id',
        data_type: 'bigint',
        column_default:
          "nextval('infrastructure_state.global_states_id_seq'::regclass)",
      },
      { column_name: 'name', data_type: 'text', column_default: null },
      { column_name: 'data', data_type: 'text', column_default: null },
    ]);
    const { rows: indexes } = await admin.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'infrastructure_state' ORDER BY indexname`,
    );
    expect(indexes.map((i) => i.indexname)).toEqual([
      'states_by_name',
      'states_name_key',
      'states_pkey',
    ]);
  });
});

describe('the state login', () => {
  it('reads and writes states, and takes their advisory locks, as the pg backend does', async () => {
    const {
      rows: [made],
    } = await login.query<{ id: string }>(
      `INSERT INTO infrastructure_state.states (name, data) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET data = $2 WHERE infrastructure_state.states.name = $1
       RETURNING id`,
      ['state-a', '{"encrypted_data":"…"}'],
    );
    const { rows } = await login.query(
      `SELECT infrastructure_state.states.id, pg_try_advisory_lock(infrastructure_state.states.id) AS locked
       FROM infrastructure_state.states WHERE infrastructure_state.states.name = $1`,
      ['state-a'],
    );
    expect(rows).toEqual([{ id: made.id, locked: true }]);
    await login.query('SELECT pg_advisory_unlock($1)', [made.id]);
    await login.query(
      'DELETE FROM infrastructure_state.states WHERE name = $1',
      ['state-a'],
    );
  });

  it("cannot read Cloudgate's own tables", async () => {
    for (const table of [
      'application',
      'cloud_account',
      'infrastructure_state_record',
    ]) {
      await expect(
        login.query(`SELECT * FROM public.${table}`),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('can create nothing, in its schema or anywhere', async () => {
    await expect(
      login.query('CREATE TABLE infrastructure_state.other (x int)'),
    ).rejects.toThrow(/permission denied/);
    await expect(
      login.query('CREATE TABLE public.other (x int)'),
    ).rejects.toThrow(/permission denied/);
    await expect(login.query('CREATE SCHEMA other')).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('InfrastructureStatesService', () => {
  let pool: Pool;
  let cloud: FakeCloudPort;
  let google: FakeGoogleCloudPort;
  let states: InfrastructureStatesService;
  const credential = { accessKeyId: 'AKIAFAKE', secretAccessKey: 'secret' };

  beforeAll(() => {
    // Foreign keys off for this pool's sessions: a state's owner is a
    // network id these gates never read, and that id is a key to
    // `environment_network`, whose row would need an Organization, Project,
    // Environment and Cloud account behind it. The one-owner CHECK still holds.
    pool = new Pool({
      connectionString: db.connectionString,
      options: '-c session_replication_role=replica',
    });
    cloud = new FakeCloudPort();
    google = new FakeGoogleCloudPort();
    states = new InfrastructureStatesService(
      drizzle(pool, { schema }),
      cloud,
      google,
    );
  });

  afterAll(async () => {
    google.dispose();
    await pool.end();
  });
  beforeEach(() => cloud.reset());

  const network = () =>
    states.create({
      environmentNetworkId: `net-${randomBytes(4).toString('hex')}`,
    });

  it('keeps one owner per state', async () => {
    await expect(
      admin.query(
        `INSERT INTO infrastructure_state_record (infrastructure_state_id, created_at) VALUES ('x', 'now')`,
      ),
    ).rejects.toThrow(/infrastructure_state_record_one_owner/);
  });

  // Every state made before Google Cloud was AWS's; the migration's default
  // is what they read as.
  it('starts with no versions, readable, written with the AWS provider', async () => {
    const state = await network();

    expect(state).toMatchObject({
      provider: 'aws',
      tofuVersion: null,
      providerVersion: null,
      readable: true,
    });
  });

  it('replays the stored plan, and a plan writes no versions', async () => {
    const state = await network();
    cloud.replayPlan('network-create');

    const outcome = await states.plan({
      stateId: state.infrastructureStateId,
      credential,
      definition: {},
    });

    expect(outcome).toMatchObject({
      ok: true,
      show: { format_version: '1.2' },
    });
    expect(await states.findOne(state.infrastructureStateId)).toMatchObject({
      tofuVersion: null,
    });
  });

  it('leaves no workspace behind a plan of a create no Apply has made', async () => {
    const stateId = `fresh-${randomBytes(4).toString('hex')}`;
    // As `workspace select -or-create` leaves it.
    await admin.query(
      `INSERT INTO infrastructure_state.states (name, data) VALUES ($1, '')`,
      [stateId],
    );
    cloud.replayPlan('web-create');

    const outcome = await states.planFresh({
      stateId,
      credential,
      definition: {},
    });

    expect(outcome).toMatchObject({ ok: true });
    const { rows } = await admin.query(
      'SELECT name FROM infrastructure_state.states WHERE name = $1',
      [stateId],
    );
    expect(rows).toEqual([]);
  });

  it('records the install’s versions when an apply finishes, bringing an older state forward', async () => {
    const state = await network();
    await admin.query(
      `UPDATE infrastructure_state_record SET tofu_version = '1.10.0', provider_version = '6.0.0' WHERE infrastructure_state_id = $1`,
      [state.infrastructureStateId],
    );
    const lines: string[] = [];

    const outcome = await states.apply({
      stateId: state.infrastructureStateId,
      credential,
      definition: {},
      onLine: (line) => lines.push(line),
    });

    expect(outcome.ok).toBe(true);
    expect(lines).toContain('Apply complete!');
    expect(await states.findOne(state.infrastructureStateId)).toMatchObject({
      tofuVersion: '1.13.1',
      providerVersion: '6.69.1',
    });
  });

  it('refuses a state written by newer versions, naming both and saying to upgrade Cloudgate, and runs nothing', async () => {
    const state = await network();
    await admin.query(
      `UPDATE infrastructure_state_record SET tofu_version = '1.14.0', provider_version = '6.69.1' WHERE infrastructure_state_id = $1`,
      [state.infrastructureStateId],
    );

    const outcome = await states.apply({
      stateId: state.infrastructureStateId,
      credential,
      definition: {},
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'newer-state',
      message: expect.stringMatching(
        /OpenTofu 1\.14\.0 with AWS provider 6\.69\.1.*OpenTofu 1\.13\.1 with AWS provider 6\.69\.1.*Upgrade Cloudgate/,
      ) as string,
    });
    expect(cloud.calls).toEqual([]);
  });

  describe('a Google state', () => {
    const googleNetwork = async (providerVersion: string) => {
      const state = await network();
      await admin.query(
        `UPDATE infrastructure_state_record SET provider = 'google', tofu_version = '1.13.1', provider_version = $2 WHERE infrastructure_state_id = $1`,
        [state.infrastructureStateId, providerVersion],
      );
      return state;
    };

    it('refuses one written by a newer Google provider, naming the Google provider, and runs nothing', async () => {
      const state = await googleNetwork('99.0.0');

      const outcome = await states.apply({
        stateId: state.infrastructureStateId,
        credential,
        definition: {},
      });

      expect(outcome).toEqual({
        ok: false,
        reason: 'newer-state',
        message: expect.stringMatching(
          new RegExp(
            `with Google provider 99\\.0\\.0.*with Google provider ${GOOGLE_PROVIDER_VERSION.replaceAll('.', '\\.')}\\. Upgrade Cloudgate`,
          ),
        ) as string,
      });
      expect(cloud.calls).toEqual([]);
    });

    it('is made for a Google owner written with the Google provider, and its apply runs through the Google client port, answering its outputs', async () => {
      google.reset();
      google.replayOutputsFor('network', 'network-create');
      const part = (value: object) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const state = await states.create(
        { environmentNetworkId: `net-${randomBytes(4).toString('hex')}` },
        undefined,
        'google',
      );

      const outcome = await states.apply({
        stateId: state.infrastructureStateId,
        credential: google.credentialConfiguration({
          audience: '//iam.googleapis.com/projects/1/locations/global/x',
          serviceAccount: 'cloudgate-deploy@shop-prod.iam.gserviceaccount.com',
          subjectToken: `${part({ alg: 'RS256' })}.${part({ sub: 'cloudgate:c' })}.sig`,
        }),
        definition: { resource: { google_compute_network: { network: {} } } },
      });

      expect(outcome).toMatchObject({
        ok: true,
        outputs: { ip_address: '34.117.42.7' },
      });
      expect(google.calls.map((call) => call.method)).toEqual(['apply']);
      expect(cloud.calls).toEqual([]);
      expect(await states.findOne(state.infrastructureStateId)).toMatchObject({
        provider: 'google',
        providerVersion: GOOGLE_PROVIDER_VERSION,
      });
    });

    it('records the Google pin, not the AWS one, when an apply finishes', async () => {
      const state = await googleNetwork('8.0.0');

      const outcome = await states.apply({
        stateId: state.infrastructureStateId,
        credential,
        definition: {},
      });

      expect(outcome.ok).toBe(true);
      expect(await states.findOne(state.infrastructureStateId)).toMatchObject({
        provider: 'google',
        tofuVersion: '1.13.1',
        providerVersion: GOOGLE_PROVIDER_VERSION,
      });
    });
  });

  it('marks a state tofu cannot read, and fails every later run at once, naming it', async () => {
    const state = await network();
    const stateId = state.infrastructureStateId;
    cloud.unreadableState(stateId);

    const first = await states.apply({ stateId, credential, definition: {} });
    cloud.reset();
    const second = await states.plan({ stateId, credential, definition: {} });

    expect(first).toMatchObject({ ok: false, reason: 'unreadable-state' });
    expect(second).toMatchObject({
      ok: false,
      reason: 'unreadable-state',
      message: expect.stringContaining(stateId) as string,
    });
    expect(cloud.calls).toEqual([]);
    expect(await states.findOne(stateId)).toMatchObject({ readable: false });
  });

  it('passes a held lock on as it is, writing nothing', async () => {
    const state = await network();
    cloud.lockHeld();

    const outcome = await states.destroy({
      stateId: state.infrastructureStateId,
      credential,
      definition: {},
    });

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'lock-held',
      message: expect.stringMatching(
        /another run is using this state/i,
      ) as string,
    });
    expect(await states.findOne(state.infrastructureStateId)).toMatchObject({
      tofuVersion: null,
      readable: true,
    });
  });

  it('ends a hung run by its signal', async () => {
    const state = await network();
    cloud.hang();
    const signal = new TestRunSignal();

    const run = states.apply({
      stateId: state.infrastructureStateId,
      credential,
      definition: {},
      signal,
    });
    signal.interrupt();

    expect(await run).toMatchObject({ ok: false, reason: 'interrupted' });
  });
});
