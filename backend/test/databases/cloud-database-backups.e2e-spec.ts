import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { rdsInstanceIdentifier } from '../../src/cloud-accounts/aws/definitions/postgres-definition';
import { serviceName } from '../../src/cloud-accounts/gcp/definitions/names';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { replicationGroupIdentifier } from '../../src/cloud-accounts/aws/definitions/redis-definition';
import {
  backup,
  cloudAccount,
  destination,
  postgres,
  redis,
  volumeBackup,
  webServerSettings,
} from '../../src/db/schema';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';

/**
 * A cloud database's backups are the provider's own, shown live. The
 * Backups tab's read of a postgres on RDS answers its retention, the
 * restorable window and its snapshots from the cloud port (`ctx.cloud`); of a
 * redis on ElastiCache, its snapshot retention and snapshots. Retention is
 * edited through the Service's own settings, and dump Backups and volume
 * backups of a cloud database are refused with `SERVER_ONLY_DUMPS`.
 *
 * That the edited RDS retention shows in the next plan and its Apply is
 * `cloud-postgres-changes.e2e-spec.ts`'s ("plans the console's storage,
 * Multi-AZ and retention …"): the tab writes through the same route.
 */
describe('A cloud database’s Backups tab (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let cloudAccountId: string;
  let environmentId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    const res = await request(http).post('/api/auth/sign-up/email').send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'Shop' });
    expect(project.status).toBe(201);
    const { projectId } = project.body as { projectId: string };

    const [row] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId,
        name: 'Production AWS',
        cloud: 'aws',
        cloudId: ACCOUNT,
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy`,
        taskExecutionRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-task-execution`,
        externalId: 'external-id-made-by-cloudgate',
        policyVersion: 1,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    cloudAccountId = row.cloudAccountId;

    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId,
        name: 'production',
        deployTarget: { kind: 'cloud', cloudAccountId, region: REGION },
      });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;
    ctx.cloud.calls.length = 0;
  });

  /** `pg-1` as a plan's Apply leaves a postgres on RDS. */
  async function rdsPostgres() {
    const [made] = await ctx.db
      .insert(postgres)
      .values({
        name: 'pg-1',
        configName: 'pg-1',
        environmentId,
        databaseName: 'pg_1',
        databaseUser: 'pg_1',
        databasePassword: 'super-secret-database-password',
        cloudAccountId,
        region: REGION,
        instanceClass: null,
      })
      .returning();
    return made;
  }

  /** `cache` as a plan's Apply leaves a redis on ElastiCache. */
  async function elastiCacheRedis() {
    const [made] = await ctx.db
      .insert(redis)
      .values({
        name: 'cache',
        configName: 'cache',
        environmentId,
        databasePassword: 'super-secret-redis-password',
        cloudAccountId,
        region: REGION,
        snapshotRetentionDays: 3,
      })
      .returning();
    return made;
  }

  async function serverPostgres() {
    const [made] = await ctx.db
      .insert(postgres)
      .values({
        name: 'local',
        configName: 'local',
        environmentId,
        databaseName: 'local',
        databaseUser: 'local',
        databasePassword: 'super-secret-database-password',
      })
      .returning();
    return made;
  }

  const tab = (kind: 'postgres' | 'redis', id: string) =>
    request(http).get(`/${kind}/${id}/cloud-backups`).set('Cookie', cookie);

  describe('on RDS', () => {
    it('answers retention, the restorable window and the snapshots RDS holds, with the RDS console link', async () => {
      const pg = await rdsPostgres();
      const identifier = rdsInstanceIdentifier(pg.postgresId);
      ctx.cloud.rdsHolds(identifier, {
        retentionDays: 7,
        earliestRestorableTime: '2026-10-09T02:45:31.000Z',
        latestRestorableTime: '2026-10-16T11:05:00.000Z',
        snapshots: [
          {
            id: `rds:${identifier}-2026-10-15-02-45`,
            type: 'automated',
            createdAt: '2026-10-15T02:45:51.000Z',
            status: 'available',
            size: '20 GB',
          },
          {
            id: 'shop-production-pg-1-final-2026-10-02',
            type: 'manual',
            createdAt: '2026-10-02T08:00:00.000Z',
            status: 'available',
            size: '20 GB',
          },
        ],
      });

      const res = await tab('postgres', pg.postgresId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        engine: 'rds',
        identifier,
        region: REGION,
        made: true,
        retentionDays: 7,
        liveRetentionDays: 7,
        restorableWindow: {
          earliest: '2026-10-09T02:45:31.000Z',
          latest: '2026-10-16T11:05:00.000Z',
        },
        snapshots: [
          expect.objectContaining({ type: 'automated' }),
          expect.objectContaining({
            id: 'shop-production-pg-1-final-2026-10-02',
            type: 'manual',
          }),
        ],
        consoleUrl: `https://${REGION}.console.aws.amazon.com/rds/home?region=${REGION}#database:id=${identifier};is-cluster=false`,
      });
      // Read with the deploy role's session, never the account's own key.
      expect(ctx.cloud.calls).toContainEqual({
        method: 'rdsBackups',
        region: REGION,
        identifier,
        session: true,
      });
      // A read, never a run.
      expect(
        ctx.cloud.calls.some((call) =>
          ['plan', 'apply', 'destroy'].includes(call.method),
        ),
      ).toBe(false);
    });

    it('answers an empty tab before the first Cloud run makes the instance', async () => {
      const pg = await rdsPostgres();

      const res = await tab('postgres', pg.postgresId);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        made: false,
        retentionDays: 7,
        liveRetentionDays: null,
        restorableWindow: { earliest: null, latest: null },
        snapshots: [],
      });
    });

    it('shows a retention edited through the RDS settings as Cloudgate’s, beside what RDS still runs, and refuses one out of range', async () => {
      const pg = await rdsPostgres();
      ctx.cloud.rdsHolds(rdsInstanceIdentifier(pg.postgresId), {
        retentionDays: 7,
        earliestRestorableTime: null,
        latestRestorableTime: null,
        snapshots: [],
      });

      const saved = await request(http)
        .patch(`/postgres/${pg.postgresId}/rds-settings`)
        .set('Cookie', cookie)
        .send({ backupRetentionDays: 14 });
      expect(saved.status).toBe(200);

      expect((await tab('postgres', pg.postgresId)).body).toMatchObject({
        retentionDays: 14,
        liveRetentionDays: 7,
      });

      for (const days of [0, 36]) {
        const refused = await request(http)
          .patch(`/postgres/${pg.postgresId}/rds-settings`)
          .set('Cookie', cookie)
          .send({ backupRetentionDays: days });
        expect(refused.status).toBe(400);
      }
      const [row] = await ctx.db
        .select()
        .from(postgres)
        .where(eq(postgres.postgresId, pg.postgresId));
      expect(row.backupRetentionDays).toBe(14);
    });

    it('answers AWS’s refusal as a 400 naming the Cloud account, and records a denied read on it', async () => {
      const pg = await rdsPostgres();
      ctx.cloud.refuseBackupReads(
        'AccessDenied',
        'User is not authorized to perform: rds:DescribeDBInstances',
      );

      const res = await tab('postgres', pg.postgresId);

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        'Cloud account Production AWS could not read the backups of pg-1: AWS answered AccessDenied: User is not authorized to perform: rds:DescribeDBInstances',
      );
      const [account] = await ctx.db
        .select()
        .from(cloudAccount)
        .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
      expect(account.lastCheckResult).toBe('failed');
      expect(account.lastCheckReason).toContain('AccessDenied');
    });

    it('refuses the read for a postgres on a Server', async () => {
      const pg = await serverPostgres();

      const res = await tab('postgres', pg.postgresId);

      expect(res.status).toBe(400);
      expect(ctx.cloud.calls).toEqual([]);
    });
  });

  describe('on ElastiCache', () => {
    it('answers the snapshot retention and the snapshots ElastiCache holds', async () => {
      const cache = await elastiCacheRedis();
      const identifier = replicationGroupIdentifier(cache.redisId);
      ctx.cloud.cacheHolds(identifier, {
        retentionDays: 3,
        snapshots: [
          {
            id: `automatic.${identifier}-2026-10-15-05-00`,
            type: 'automated',
            createdAt: '2026-10-15T05:03:12.000Z',
            status: 'available',
            size: '5 MB',
          },
        ],
      });

      const res = await tab('redis', cache.redisId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        engine: 'elasticache',
        identifier,
        region: REGION,
        made: true,
        retentionDays: 3,
        liveRetentionDays: 3,
        restorableWindow: null,
        snapshots: [
          {
            id: `automatic.${identifier}-2026-10-15-05-00`,
            type: 'automated',
            createdAt: '2026-10-15T05:03:12.000Z',
            status: 'available',
            size: '5 MB',
          },
        ],
        consoleUrl: null,
      });
      expect(ctx.cloud.calls).toContainEqual({
        method: 'cacheBackups',
        region: REGION,
        identifier,
        session: true,
      });
    });

    it('stores a snapshot retention of 0 to 35 days as the Service’s setting, and refuses one out of range', async () => {
      const cache = await elastiCacheRedis();
      const settings = (body: Record<string, unknown>) =>
        request(http)
          .patch(`/redis/${cache.redisId}/elasticache-settings`)
          .set('Cookie', cookie)
          .send(body);

      expect((await settings({ snapshotRetentionDays: 0 })).status).toBe(200);
      expect((await tab('redis', cache.redisId)).body).toMatchObject({
        retentionDays: 0,
      });

      for (const days of [-1, 36]) {
        const refused = await settings({ snapshotRetentionDays: days });
        expect(refused.status).toBe(400);
        expect(JSON.stringify(refused.body)).toContain(
          'snapshotRetentionDays must be 0 to 35',
        );
      }
      const [row] = await ctx.db
        .select()
        .from(redis)
        .where(eq(redis.redisId, cache.redisId));
      expect(row.snapshotRetentionDays).toBe(0);
    });

    it('refuses ElastiCache settings for a redis on a Server', async () => {
      const [local] = await ctx.db
        .insert(redis)
        .values({
          name: 'local-cache',
          configName: 'local-cache',
          environmentId,
          databasePassword: 'super-secret-redis-password',
        })
        .returning();

      const res = await request(http)
        .patch(`/redis/${local.redisId}/elasticache-settings`)
        .set('Cookie', cookie)
        .send({ snapshotRetentionDays: 3 });

      expect(res.status).toBe(400);
    });
  });

  /**
   * Backups and Delete for Cloud SQL and Memorystore:
   * on Google Cloud the tab copies AWS's, read live through the Google
   * client port (`ctx.google`): retention, the restorable window and the
   * backup list, a link to the Google Cloud console, and no Restore. That
   * an edited retention plans the change is `google-cloud-sql.e2e-spec.ts`'s
   * and `google-memorystore.e2e-spec.ts`'s.
   */
  describe('on Google Cloud', () => {
    const PROJECT = 'shop-prod';
    const GOOGLE_REGION = 'europe-west1';
    let googleAccountId: string;
    let googleEnvironmentId: string;

    beforeEach(async () => {
      // The install's own address, which a Google provider names as its
      // issuer: a Google Environment is refused without it.
      await ctx.db
        .insert(webServerSettings)
        .values({ host: 'cloudgate.example.com', https: true });
      const key = makeSigningKey();
      const [row] = await ctx.db
        .insert(cloudAccount)
        .values({
          organizationId,
          name: 'Production Google',
          cloud: 'gcp',
          cloudId: PROJECT,
          ...GOOGLE_COLUMNS,
          signingKey: key.privateKey,
          signingKeyId: key.keyId,
          signingPublicKey: JSON.stringify(key.publicJwk),
          policyVersion: 1,
          lastCheckedAt: new Date().toISOString(),
          lastCheckResult: 'passed',
        })
        .returning();
      googleAccountId = row.cloudAccountId;
      const projects = await request(http)
        .post('/projects')
        .set('Cookie', cookie)
        .send({ name: 'Shop on Google' });
      const env = await request(http)
        .post('/environments')
        .set('Cookie', cookie)
        .send({
          projectId: (projects.body as { projectId: string }).projectId,
          name: 'production',
          deployTarget: {
            kind: 'cloud',
            cloudAccountId: googleAccountId,
            region: GOOGLE_REGION,
          },
        });
      expect(env.status).toBe(201);
      googleEnvironmentId = (env.body as { environmentId: string })
        .environmentId;
      ctx.google.calls.length = 0;
    });

    /** `pg-1` as a plan's Apply leaves a postgres on Cloud SQL. */
    async function cloudSqlPostgres() {
      const [made] = await ctx.db
        .insert(postgres)
        .values({
          name: 'pg-1',
          configName: 'pg-1',
          environmentId: googleEnvironmentId,
          databaseName: 'pg_1',
          databaseUser: 'app_pg_1',
          databasePassword: 'super-secret-database-password',
          cloudAccountId: googleAccountId,
          region: GOOGLE_REGION,
          instanceClass: 'db-f1-micro',
          cloudSqlApplied: { backupRetentionDays: 7 },
        })
        .returning();
      return made;
    }

    /** `cache` as a plan's Apply leaves a redis on Memorystore. */
    async function memorystoreRedis() {
      const [made] = await ctx.db
        .insert(redis)
        .values({
          name: 'cache',
          configName: 'cache',
          environmentId: googleEnvironmentId,
          databasePassword: 'super-secret-redis-password',
          cloudAccountId: googleAccountId,
          region: GOOGLE_REGION,
          nodeType: 'CUSTOM_PICO',
          memorystoreApplied: {
            highAvailability: false,
            backupRetentionDays: 1,
          },
        })
        .returning();
      return made;
    }

    it('answers Cloud SQL’s retention, point-in-time recovery’s window and its backups, with the Google Cloud console link and no Restore', async () => {
      const pg = await cloudSqlPostgres();
      const name = serviceName(pg.postgresId);
      ctx.google.cloudSqlHolds(name, {
        retentionDays: 7,
        earliestRestorableTime: '2026-10-19T03:00:00.000Z',
        latestRestorableTime: '2026-10-26T11:05:00.000Z',
        backups: [
          {
            id: '1761447600000',
            type: 'automated',
            createdAt: '2026-10-26T03:00:00.000Z',
            status: 'successful',
            size: '1.4 MB',
          },
          {
            id: '1761100000000',
            type: 'manual',
            createdAt: '2026-10-22T08:00:00.000Z',
            status: 'successful',
            size: '1.4 MB',
          },
        ],
      });

      const res = await tab('postgres', pg.postgresId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        engine: 'cloud-sql',
        identifier: name,
        region: GOOGLE_REGION,
        made: true,
        retentionDays: 7,
        liveRetentionDays: 7,
        restorableWindow: {
          earliest: '2026-10-19T03:00:00.000Z',
          latest: '2026-10-26T11:05:00.000Z',
        },
        snapshots: [
          expect.objectContaining({ id: '1761447600000', type: 'automated' }),
          expect.objectContaining({ id: '1761100000000', type: 'manual' }),
        ],
        consoleUrl: `https://console.cloud.google.com/sql/instances/${name}/backups?project=${PROJECT}`,
      });
      // Read with the deploy service account, never through AWS or a run.
      expect(ctx.google.calls).toContainEqual({
        method: 'cloudSqlBackups',
        impersonated: true,
        projectId: PROJECT,
        region: GOOGLE_REGION,
        name,
      });
      expect(ctx.cloud.calls).toEqual([]);
      expect(
        ctx.google.calls.some((call) =>
          ['plan', 'apply', 'destroy'].includes(call.method),
        ),
      ).toBe(false);
    });

    it('answers Memorystore’s retention and backups, its window their oldest and newest', async () => {
      const cache = await memorystoreRedis();
      const name = serviceName(cache.redisId);
      ctx.google.memorystoreHolds(name, {
        retentionDays: 1,
        backups: [
          {
            id: 'auto-2',
            type: 'automated',
            createdAt: '2026-10-26T03:00:00.000Z',
            status: 'active',
            size: '2 MB',
          },
          {
            id: 'auto-1',
            type: 'automated',
            createdAt: '2026-10-25T03:00:00.000Z',
            status: 'active',
            size: '2 MB',
          },
        ],
      });

      const res = await tab('redis', cache.redisId);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        engine: 'memorystore',
        identifier: name,
        made: true,
        retentionDays: 1,
        liveRetentionDays: 1,
        restorableWindow: {
          earliest: '2026-10-25T03:00:00.000Z',
          latest: '2026-10-26T03:00:00.000Z',
        },
        snapshots: [{ id: 'auto-2' }, { id: 'auto-1' }],
        consoleUrl: `https://console.cloud.google.com/memorystore/valkey/locations/${GOOGLE_REGION}/instances/${name}/details?project=${PROJECT}`,
      });
    });

    it('answers an empty tab before the first Cloud run makes the instance', async () => {
      const pg = await cloudSqlPostgres();

      const res = await tab('postgres', pg.postgresId);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        engine: 'cloud-sql',
        made: false,
        retentionDays: 7,
        liveRetentionDays: null,
        snapshots: [],
      });
    });

    it('answers Google’s refusal as a 400 naming the Cloud account, and records a denied read on it', async () => {
      const pg = await cloudSqlPostgres();
      ctx.google.permissionDenied(
        'cloudSqlBackups',
        "Permission 'cloudsql.backupRuns.list' denied",
      );

      const res = await tab('postgres', pg.postgresId);

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        "Cloud account Production Google could not read the backups of pg-1: Google Cloud answered PERMISSION_DENIED: Permission 'cloudsql.backupRuns.list' denied",
      );
      const [account] = await ctx.db
        .select()
        .from(cloudAccount)
        .where(eq(cloudAccount.cloudAccountId, googleAccountId));
      expect(account.lastCheckResult).toBe('failed');
    });

    it('stores a Cloud SQL retention of 1 to 365 days as the Service’s setting, refusing 0 and 366', async () => {
      const pg = await cloudSqlPostgres();
      const settings = (body: Record<string, unknown>) =>
        request(http)
          .patch(`/postgres/${pg.postgresId}/cloud-sql-settings`)
          .set('Cookie', cookie)
          .send(body);

      expect((await settings({ backupRetentionDays: 365 })).status).toBe(200);
      expect((await tab('postgres', pg.postgresId)).body).toMatchObject({
        retentionDays: 365,
      });
      for (const days of [0, 366]) {
        const refused = await settings({ backupRetentionDays: days });
        expect(refused.status).toBe(400);
        expect(JSON.stringify(refused.body)).toContain(
          'backupRetentionDays must be 1 to 365',
        );
      }
      const [row] = await ctx.db
        .select()
        .from(postgres)
        .where(eq(postgres.postgresId, pg.postgresId));
      expect(row.backupRetentionDays).toBe(365);
    });

    it('refuses Cloud SQL settings for a postgres on RDS, naming its RDS settings', async () => {
      const onRds = await rdsPostgres();

      const refused = await request(http)
        .patch(`/postgres/${onRds.postgresId}/cloud-sql-settings`)
        .set('Cookie', cookie)
        .send({ backupRetentionDays: 7 });

      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toContain(
        'runs on RDS, not Cloud SQL',
      );
    });

    it('stores a Memorystore retention of 0 to 365 days, refusing one out of range', async () => {
      const cache = await memorystoreRedis();
      const settings = (body: Record<string, unknown>) =>
        request(http)
          .patch(`/redis/${cache.redisId}/memorystore-settings`)
          .set('Cookie', cookie)
          .send(body);

      expect((await settings({ backupRetentionDays: 0 })).status).toBe(200);
      expect((await tab('redis', cache.redisId)).body).toMatchObject({
        retentionDays: 0,
      });
      for (const days of [-1, 366]) {
        expect((await settings({ backupRetentionDays: days })).status).toBe(
          400,
        );
      }
      const [row] = await ctx.db
        .select()
        .from(redis)
        .where(eq(redis.redisId, cache.redisId));
      expect(row).toMatchObject({
        memorystoreBackupRetentionDays: 0,
        memorystoreHighAvailability: false,
      });
    });

    it('refuses a dump Backup and a volume backup of a Google database with SERVER_ONLY_DUMPS, writing nothing', async () => {
      const pg = await cloudSqlPostgres();
      const cache = await memorystoreRedis();
      const destinationId = await aDestination();

      const dump = await request(http)
        .post('/backups')
        .set('Cookie', cookie)
        .send({
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'pg_1',
          databaseType: 'postgres',
          serviceId: pg.postgresId,
          destinationId,
        });
      expect(dump.status).toBe(409);
      expect((dump.body as { code: string }).code).toBe('SERVER_ONLY_DUMPS');
      for (const [serviceType, serviceId] of [
        ['postgres', pg.postgresId],
        ['redis', cache.redisId],
      ]) {
        const res = await request(http)
          .post('/volume-backups')
          .set('Cookie', cookie)
          .send({
            name: 'Nightly',
            volumeName: 'data',
            prefix: 'daily',
            schedule: '0 3 * * *',
            serviceType,
            serviceId,
            destinationId,
          });
        expect(res.status).toBe(409);
        expect((res.body as { code: string }).code).toBe('SERVER_ONLY_DUMPS');
      }
      expect(await ctx.db.select().from(backup)).toEqual([]);
      expect(await ctx.db.select().from(volumeBackup)).toEqual([]);
    });
  });

  /** A Destination of the Organization's. */
  async function aDestination() {
    const [made] = await ctx.db
      .insert(destination)
      .values({
        name: 'Bucket',
        accessKey: 'access',
        secretAccessKey: 'secret',
        bucket: 'dumps',
        region: 'us-east-1',
        endpoint: 'https://s3.example.com',
        organizationId,
      })
      .returning();
    return made.destinationId;
  }

  describe('dump backups are Server-only', () => {
    it('refuses a dump Backup of a postgres on RDS with SERVER_ONLY_DUMPS, writing nothing', async () => {
      const pg = await rdsPostgres();
      const destinationId = await aDestination();

      const res = await request(http)
        .post('/backups')
        .set('Cookie', cookie)
        .send({
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'pg_1',
          databaseType: 'postgres',
          serviceId: pg.postgresId,
          destinationId,
        });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'SERVER_ONLY_DUMPS',
        message: expect.stringContaining(
          'Dump backups to a Destination are Server-only for now',
        ) as string,
      });
      expect(await ctx.db.select().from(backup)).toEqual([]);
    });

    it('refuses a volume backup of a postgres on RDS or a redis on ElastiCache, writing nothing', async () => {
      const pg = await rdsPostgres();
      const cache = await elastiCacheRedis();
      const destinationId = await aDestination();

      for (const [serviceType, serviceId] of [
        ['postgres', pg.postgresId],
        ['redis', cache.redisId],
      ]) {
        const res = await request(http)
          .post('/volume-backups')
          .set('Cookie', cookie)
          .send({
            name: 'Nightly',
            volumeName: 'data',
            prefix: 'daily',
            schedule: '0 3 * * *',
            serviceType,
            serviceId,
            destinationId,
          });
        expect(res.status).toBe(409);
        expect((res.body as { code: string }).code).toBe('SERVER_ONLY_DUMPS');
      }
      expect(await ctx.db.select().from(volumeBackup)).toEqual([]);
    });

    it('still takes a dump Backup of a postgres on a Server', async () => {
      const pg = await serverPostgres();
      const destinationId = await aDestination();

      const res = await request(http)
        .post('/backups')
        .set('Cookie', cookie)
        .send({
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'local',
          databaseType: 'postgres',
          serviceId: pg.postgresId,
          destinationId,
          enabled: false,
        });

      expect(res.status).toBe(201);
    });
  });
});
