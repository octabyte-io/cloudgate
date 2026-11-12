import { drizzle } from 'drizzle-orm/node-postgres';
import request from 'supertest';
import { App } from 'supertest/types';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import * as schema from '../../src/db/schema';
import { defaultMetricsConfig } from '../../src/servers/server.schema';
import { defaultWebServerMetricsConfig } from '../../src/settings/settings.schema';
import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * `MetricsConfig.server.token` is a live shared secret — an operator
 * supplies it, a metrics agent presents it to the unauthenticated
 * `POST /notifications/receive`, and possession of it is the whole
 * authorization — and it sat in cleartext `jsonb` on both `server` and
 * `web_server_settings`. `0065` converts both columns to `encryptedJson`.
 *
 * **Why a spec of its own, and why it goes at the bytes.** `encryptedJson`
 * `dataType()`s to `'text'`, so nothing else in the tree can tell it from a
 * plain column: the compiler sees the same `MetricsConfig` either way, and
 * `drizzle-kit`'s snapshot records `"type": "text"` for both (the top of
 * `test/coding-standards/secret-bearing-columns.spec.ts` states that argument
 * at length, and its `jsonDefaults` property holds the *declaration*). What a
 * declaration cannot say is whether the driver actually wrote ciphertext, and
 * a revert of either column would leave every existing monitoring test green.
 * `gitlab.e2e-spec.ts` is the precedent — the three GitLab secrets are
 * asserted at rest for the same reason.
 *
 * The second half is the migration, which needs a database whose history stops
 * at `0064`: the run's template has already replayed `0065`, so a legacy row
 * cannot be written there. `startLegacyDatabase` carries that technique.
 */
const MIGRATION_BEFORE = '0064_parent-matches-discriminant';

const setupBody = (token: string) => ({
  metricsConfig: {
    server: {
      refreshRate: 30,
      port: 4500,
      token,
      urlCallback: 'http://cloudgate.example.com/api/notifications/receive',
      retentionDays: 3,
      cronJob: '0 0 * * *',
      thresholds: { cpu: 80, memory: 85 },
    },
    containers: {
      refreshRate: 45,
      services: { include: ['web'], exclude: [] },
    },
  },
});

/** A legacy row's config, as a pre-`0065` `jsonb` column held it. */
const LEGACY_CONFIG = {
  ...defaultWebServerMetricsConfig,
  server: { ...defaultWebServerMetricsConfig.server, token: 'legacy-token-65' },
};

describe('Metrics config encryption at rest (e2e)', () => {
  describe('the bytes the driver writes', () => {
    let ctx: TestAppContext;
    let httpServer: App;

    const remoteExec = {
      execAsync: jest.fn(),
      execAsyncRemote: jest.fn(),
      execFileAsync: jest.fn(),
    };

    beforeAll(async () => {
      ctx = await createTestApp({
        overrideProviders: [
          { provide: RemoteExecService, useValue: remoteExec },
        ],
      });
      httpServer = ctx.app.getHttpServer() as App;
    });

    afterAll(async () => {
      await ctx.teardown();
    });

    beforeEach(async () => {
      await ctx.resetDb();
      jest.clearAllMocks();
    });

    it("stores a Server's metrics token as ciphertext and reads it back whole", async () => {
      const session = await request(httpServer)
        .post('/api/auth/sign-up/email')
        .send({
          name: 'Grace Hopper',
          email: 'grace@example.com',
          password: 'super-secret-password',
        });
      expect(session.status).toBe(200);
      const cookie = session.headers['set-cookie'];

      const sshKey = await request(httpServer)
        .post('/ssh-keys')
        .set('Cookie', cookie)
        .send({ name: 'worker-key' });
      expect(sshKey.status).toBe(201);
      const created = await request(httpServer)
        .post('/servers')
        .set('Cookie', cookie)
        .send({
          name: 'worker-1',
          ipAddress: '10.0.0.5',
          port: 22,
          username: 'root',
          sshKeyId: (sshKey.body as { sshKeyId: string }).sshKeyId,
        });
      expect(created.status).toBe(201);
      const { serverId } = created.body as { serverId: string };

      // A fresh Server has never been set up, so its column holds the DDL
      // default — deliberately *plain* JSON, because a ciphertext in DDL would
      // be tied to whichever APP_ENCRYPTION_SECRET generated `0065` and
      // undecryptable everywhere else. Asserted, not assumed: it is the one
      // value in the column that is allowed not to start with `enc:v1:`, and
      // ADR 0006's pass-through is what makes reading it work.
      const fresh = await ctx.db.$client.query<{ metrics_config: string }>(
        'select metrics_config from server where server_id = $1',
        [serverId],
      );
      expect(fresh.rows[0].metrics_config.startsWith('enc:v1:')).toBe(false);
      expect(JSON.parse(fresh.rows[0].metrics_config)).toEqual(
        defaultMetricsConfig,
      );

      const setup = await request(httpServer)
        .post(`/monitoring/servers/${serverId}/setup`)
        .set('Cookie', cookie)
        .send(setupBody('server-metrics-token-348'));
      expect(setup.status).toBe(200);

      const raw = await ctx.db.$client.query<{ metrics_config: string }>(
        'select metrics_config from server where server_id = $1',
        [serverId],
      );
      // `not.toContain` as well as the prefix test: a `toDriver` that returned
      // its input unchanged would still be `text` in a `text` column, and only
      // the absence of the plaintext says the encryption ran.
      expect(raw.rows[0].metrics_config).not.toContain(
        'server-metrics-token-348',
      );
      expect(raw.rows[0].metrics_config.startsWith('enc:v1:')).toBe(true);

      // And the whole structure survives the round trip, not just the token —
      // `encryptedJson` serializes the blob, so a broken `fromDriver` loses
      // every field at once rather than one.
      const [row] = await ctx.db.select().from(schema.server);
      expect(row.metricsConfig).toEqual({
        server: {
          type: 'Remote',
          refreshRate: 30,
          port: 4500,
          token: 'server-metrics-token-348',
          urlCallback: 'http://cloudgate.example.com/api/notifications/receive',
          retentionDays: 3,
          cronJob: '0 0 * * *',
          thresholds: { cpu: 80, memory: 85 },
        },
        containers: {
          refreshRate: 45,
          services: { include: ['web'], exclude: [] },
        },
      });
    });

    it("stores the web server's metrics token as ciphertext too", async () => {
      // The settings singleton is the copy with the wider blast radius: its
      // token authenticates `receiveServerThreshold`'s instance-wide branch,
      // which fans an alert out to every organization on the instance. A change
      // that encrypted `server` and not this row would have left the larger of
      // the two exposures in place, so both are asserted rather than one being
      // taken as evidence for the other.
      const session = await request(httpServer)
        .post('/api/auth/sign-up/email')
        .send({
          name: 'Grace Hopper',
          email: 'grace@example.com',
          password: 'super-secret-password',
        });
      expect(session.status).toBe(200);

      const res = await request(httpServer)
        .post('/admin/setup-monitoring')
        .set('Cookie', session.headers['set-cookie'])
        .send(setupBody('web-metrics-token-348'));
      expect(res.status).toBe(200);

      const raw = await ctx.db.$client.query<{ metrics_config: string }>(
        'select metrics_config from web_server_settings',
      );
      expect(raw.rows).toHaveLength(1);
      expect(raw.rows[0].metrics_config).not.toContain('web-metrics-token-348');
      expect(raw.rows[0].metrics_config.startsWith('enc:v1:')).toBe(true);

      const [row] = await ctx.db.select().from(schema.webServerSettings);
      expect(row.metricsConfig.server.token).toBe('web-metrics-token-348');
      expect(row.metricsConfig.server.type).toBe('Cloudgate');
      expect(row.metricsConfig.containers.services.include).toEqual(['web']);
    });
  });

  describe('0065 over a database that predates it', () => {
    let legacy: LegacyDatabase;
    let columnTypes: Record<string, string>;
    let atRestAfterMigration: string;
    let readThroughTheColumn: unknown;
    let atRestAfterAWrite: string;

    const rawConfig = async (): Promise<string> => {
      const { rows } = await legacy.pool.query<{ metrics_config: string }>(
        'select metrics_config from web_server_settings',
      );
      return rows[0].metrics_config;
    };

    beforeAll(async () => {
      legacy = await startLegacyDatabase('i348', MIGRATION_BEFORE);

      // `web_server_settings` declares no foreign keys, so the legacy row
      // needs no user, organization or project behind it — which is the whole
      // reason this half uses the singleton rather than `server`. The two
      // columns convert through the same three statements in `0065`.
      await legacy.pool.query(
        `insert into web_server_settings (id, metrics_config, created_at, updated_at)
           values ('settings-1', $1::jsonb, $2, $2)`,
        [JSON.stringify(LEGACY_CONFIG), '2026-01-01T00:00:00.000Z'],
      );

      // The premise, asserted before the migration runs: a `jsonb` column
      // holding the token in cleartext. Without this the whole describe would
      // pass against a migration that did nothing.
      const before = await legacy.pool.query<{
        data_type: string;
        raw: string;
      }>(
        `select c.data_type, s.metrics_config::text as raw
           from information_schema.columns c, web_server_settings s
          where c.table_name = 'web_server_settings'
            and c.column_name = 'metrics_config'`,
      );
      expect(before.rows[0].data_type).toBe('jsonb');
      expect(before.rows[0].raw).toContain('legacy-token-65');

      // `0065`, through the migrator that runs it in production.
      await legacy.migrateToHead();

      const types = await legacy.pool.query<{
        table_name: string;
        data_type: string;
      }>(
        `select table_name, data_type
           from information_schema.columns
          where column_name = 'metrics_config'
          order by table_name`,
      );
      columnTypes = Object.fromEntries(
        types.rows.map((row) => [row.table_name, row.data_type]),
      );

      atRestAfterMigration = await rawConfig();

      // The pass-through, through the real column rather than a hand-rolled
      // parse: a drizzle instance over the migrated database, with the same
      // schema `src` uses.
      const db = drizzle(legacy.pool, { schema });
      const [row] = await db.select().from(schema.webServerSettings);
      readThroughTheColumn = row.metricsConfig;

      // And one write, which is the only thing that turns a legacy row into
      // ciphertext.
      await db
        .update(schema.webServerSettings)
        .set({ metricsConfig: LEGACY_CONFIG });
      atRestAfterAWrite = await rawConfig();
    }, 180_000);

    afterAll(async () => {
      await legacy?.drop();
    });

    it('converts both metrics_config columns to text', () => {
      // Both, in one assertion, because `0065` exists to convert them
      // together: whichever one were left as `jsonb` would still be a
      // cleartext token, and `server` is the table this file's other half
      // cannot reach from a legacy database without four rows of FK scaffold.
      expect(columnTypes).toEqual({
        server: 'text',
        web_server_settings: 'text',
      });
    });

    it('leaves a legacy row in cleartext, and reads it anyway', () => {
      // The ticket asked for a data migration "that reads each row's JSON and
      // rewrites it through `encryptedJson`", and `0065` deliberately is not
      // one — it cannot be. The key is derived in the Node process from
      // `APP_ENCRYPTION_SECRET`; `db:migrate` is `drizzle-kit migrate`, which
      // replays `.sql` and nothing else, and this database has no `pgcrypto`
      // and no access to that variable. AES-256-GCM is not expressible in a
      // migration file.
      //
      // What makes that safe is ADR 0006: `decryptValue` returns a value
      // lacking the `enc:v1:` prefix unchanged, so the converted column reads
      // a legacy row as the object it always was. This is that claim, at the
      // bytes and through the column.
      expect(atRestAfterMigration.startsWith('enc:v1:')).toBe(false);
      expect(atRestAfterMigration).toContain('legacy-token-65');
      expect(readThroughTheColumn).toEqual(LEGACY_CONFIG);
    });

    it('turns that row into ciphertext on its next write', () => {
      // The other half of the no-data-migration argument: the residue is
      // bounded to rows nobody touches, because after `0065` every write goes
      // through `toDriver` and no path can produce new cleartext. An operator
      // rotating the token — which is the actual remedy for a shared secret
      // that has been in a `pg_dump` — encrypts the row on the way past.
      expect(atRestAfterAWrite).not.toContain('legacy-token-65');
      expect(atRestAfterAWrite.startsWith('enc:v1:')).toBe(true);
    });
  });
});
