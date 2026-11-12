import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { dataDeletedLine } from '../../src/cloud-accounts/aws/final-snapshot';
import { tofuStates } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import {
  auditLog,
  cloudAccount,
  deployment,
  environment,
  environmentNetwork,
  infrastructureState,
  postgres,
  redis,
} from '../../src/db/schema';
import { CLOUD_RUN_TIMING } from '../../src/deployment-queue/cloud-runs-concurrency.provider';
import { CloudRunsService } from '../../src/deployment-queue/cloud-runs.service';
import { snapshotDate } from '../../src/project-config/rds-postgres-places';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const FAKE_DOCKER = '#!/bin/bash\nexit 0\n';

/**
 * A Delete of a postgres on RDS or a redis on ElastiCache never
 * loses data by accident. It is a destroy-only Cloud run recorded as
 * a Deployment of the database: RDS's deletion protection is lifted first,
 * through the cloud port's direct call; the state is given the final
 * snapshot `<project>-<environment>-<service>-final-<date>` (or none, when
 * "also delete its data" was ticked); then everything is destroyed, and the
 * report's *kept* list names the snapshot once with its region, size and
 * monthly cost. An Environment's Delete never takes the flag.
 *
 * Against the fake cloud port (`ctx.cloud`), which takes a final snapshot
 * on destroy exactly when the state's last applied definition asks for one.
 */
describe('Deleting a cloud database (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let environmentId: string;
  let cloudAccountId: string;
  let pgId: string;
  let pgState: string;
  let cacheId: string;
  let cacheState: string;
  let lines: string[];
  let restoreLog: () => void;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-dbdel-'));
  const bin = nodePath.join(root, 'bin');
  const saved = process.env.CLOUDGATE_DIRECTORY;

  const execMock = withArgvExec({
    execAsync: jest.fn(
      (command: string, options?: { env?: NodeJS.ProcessEnv }) =>
        new Promise((resolve, reject) => {
          exec(
            command,
            {
              shell: '/bin/bash',
              env: {
                ...process.env,
                ...options?.env,
                PATH: `${bin}:${process.env.PATH}`,
              },
            },
            (error, stdout, stderr) =>
              error
                ? reject(Object.assign(error, { stdout, stderr }))
                : resolve({ stdout, stderr, exitCode: 0 }),
          );
        }),
    ),
    execAsyncRemote: jest.fn(),
  });

  beforeAll(async () => {
    process.env.CLOUDGATE_DIRECTORY = root;
    fs.mkdirSync(bin);
    fs.writeFileSync(nodePath.join(bin, 'docker'), FAKE_DOCKER, {
      mode: 0o755,
    });
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        {
          provide: CLOUD_RUN_TIMING,
          useValue: { minuteMs: 100, killGraceMs: 150, shutdownGraceMs: 150 },
        },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
    if (saved === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function stateFor(owner: { postgresId: string } | { redisId: string }) {
    const [state] = await ctx.db
      .insert(infrastructureState)
      .values(owner)
      .returning();
    await ctx.db.insert(tofuStates).values({
      name: state.infrastructureStateId,
      data: 'encrypted-by-opentofu',
    });
    return state.infrastructureStateId;
  }

  beforeEach(async () => {
    await ctx.resetDb();
    ctx.cloud.reset();
    const res = await request(http).post('/api/auth/sign-up/email').send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'Shop' });
    expect(project.status).toBe(201);
    const projectId = (project.body as { projectId: string }).projectId;

    const [account] = await ctx.db
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
    cloudAccountId = account.cloudAccountId;
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
    await ctx.db.insert(environmentNetwork).values({
      environmentId,
      cloudAccountId,
      region: REGION,
      status: 'ready',
      vpcId: 'vpc-0a1b',
      publicSubnetIds: ['subnet-0aaa', 'subnet-0bbb'],
      privateSubnetIds: ['subnet-0ccc', 'subnet-0ddd'],
      clusterArn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/env`,
      albSecurityGroupId: 'sg-0alb',
    });

    const [pg] = await ctx.db
      .insert(postgres)
      .values({
        name: 'pg-1',
        environmentId,
        configName: 'pg-1',
        dockerImage: 'postgres:17',
        databaseName: 'pg_1',
        databaseUser: 'pg_1',
        databasePassword: 'super-secret-database-password',
        cloudAccountId,
        region: REGION,
        instanceClass: 'db.t4g.micro',
        applicationStatus: 'done',
        createdAt: '2026-01-15T10:00:00.000Z',
      })
      .returning();
    pgId = pg.postgresId;
    pgState = await stateFor({ postgresId: pgId });

    const [cache] = await ctx.db
      .insert(redis)
      .values({
        name: 'cache',
        environmentId,
        configName: 'cache',
        dockerImage: 'redis:8',
        databasePassword: 'unused-on-elasticache',
        authToken: 'a'.repeat(64),
        nodeType: 'cache.t4g.micro',
        cloudAccountId,
        region: REGION,
        applicationStatus: 'done',
      })
      .returning();
    cacheId = cache.redisId;
    cacheState = await stateFor({ redisId: cacheId });
    ctx.cloud.calls.length = 0;
    ctx.cloud.tofuInputs.length = 0;

    lines = [];
    const runs = ctx.app.get(CloudRunsService);
    const spy = jest
      .spyOn(runs, 'appendLog')
      .mockImplementation((_path: string, line: string) => {
        lines.push(line);
        return Promise.resolve();
      });
    restoreLog = () => spy.mockRestore();
  });

  afterEach(() => restoreLog());

  async function until(check: () => Promise<boolean>, ms = 30_000) {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const pgRow = async () =>
    (
      await ctx.db.select().from(postgres).where(eq(postgres.postgresId, pgId))
    )[0];
  const cacheRow = async () =>
    (await ctx.db.select().from(redis).where(eq(redis.redisId, cacheId)))[0];
  const today = () => snapshotDate(new Date());
  const pgSnapshot = () => `shop-production-pg-1-final-${today()}`;
  const cacheSnapshot = () => `shop-production-cache-final-${today()}`;
  /** The AWS-changing calls, in order: what reached AWS first. */
  const changes = () =>
    ctx.cloud.calls
      .filter((call) =>
        ['rdsLiftDeletionProtection', 'apply', 'destroy'].includes(call.method),
      )
      .map((call) => call.method);
  const statesHeld = async (stateId: string) =>
    (await ctx.db.select().from(tofuStates).where(eq(tofuStates.name, stateId)))
      .length;

  describe('a postgres on RDS', () => {
    it('lifts deletion protection first, keeps a final snapshot named for today, and names it once in the report', async () => {
      const res = await request(http)
        .delete(`/postgres/${pgId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        postgresId: pgId,
        cloudDelete: {
          status: 'deleting',
          finalSnapshot: pgSnapshot(),
          left: [],
        },
        volumeLeftBehind: null,
      });
      await until(async () => (await pgRow()) === undefined);

      // Protection lifted first, by the direct call; then the state told the
      // snapshot (only the instance), then the destroy.
      expect(changes()).toEqual([
        'rdsLiftDeletionProtection',
        'apply',
        'destroy',
      ]);
      expect(ctx.cloud.calls).toContainEqual({
        method: 'rdsLiftDeletionProtection',
        region: REGION,
        identifier: `cloudgate-${pgId.toLowerCase().replace(/[^a-z0-9]/g, 'x')}`,
      });
      const prepared = ctx.cloud.calls.find((call) => call.method === 'apply');
      expect(prepared).toMatchObject({
        stateId: pgState,
        targets: ['aws_db_instance.database'],
        variables: ['master_password'],
      });
      const definition = ctx.cloud.tofuInputs[0].definition;
      expect(definition).toContain('"deletion_protection": false');
      expect(definition).toContain('"skip_final_snapshot": false');
      expect(definition).toContain(
        `"final_snapshot_identifier": "${pgSnapshot()}"`,
      );
      expect(definition).toContain('"copy_tags_to_snapshot": true');
      expect(definition).not.toContain('super-secret-database-password');
      expect(ctx.cloud.snapshotNamed('rds', pgSnapshot())).toBeDefined();

      // The kept list: name, region, size and monthly cost, once.
      const kept = lines.filter((line) => line.includes(pgSnapshot()));
      expect(lines).toContain('Kept on purpose:');
      expect(lines).toContain(
        `  rds:snapshot ${pgSnapshot()} (${REGION}, 20 GB): about $1.90 a month until you delete it in AWS`,
      );
      expect(
        kept.filter((line) => line.startsWith('  rds:snapshot')),
      ).toHaveLength(1);

      // A clean finish: no row, no Deployment, no state, nothing of the
      // snapshot stored; the report is the audit entry's.
      expect(await statesHeld(pgState)).toBe(0);
      expect(
        await ctx.db
          .select()
          .from(deployment)
          .where(eq(deployment.postgresId, pgId)),
      ).toEqual([]);
      const entry = (
        await ctx.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.resourceId, pgId))
      ).find((one) =>
        (one.metadata ?? '').includes('"cloudDelete":"finished"'),
      )!;
      expect(entry).toMatchObject({
        action: 'delete',
        resourceType: 'database',
      });
      expect(JSON.parse(entry.metadata!)).toMatchObject({
        cloudDelete: 'finished',
        dataDeleted: false,
        kept: [
          {
            type: 'rds:snapshot',
            awsId: pgSnapshot(),
            region: REGION,
            size: '20 GB',
          },
        ],
      });
    });

    it('does not count the snapshot a tag search finds by its copied tags as left', async () => {
      ctx.cloud.leaveTagged(
        REGION,
        `arn:aws:rds:${REGION}:${ACCOUNT}:snapshot:${pgSnapshot()}`,
        { 'cloudgate:state': pgState },
      );

      expect(
        (await request(http).delete(`/postgres/${pgId}`).set('Cookie', cookie))
          .status,
      ).toBe(200);
      await until(async () => (await pgRow()) === undefined);
    });

    it("does not count the instance's automated backup a tag search still finds as left", async () => {
      const instance = `cloudgate-${pgId.toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
      ctx.cloud.leaveTagged(
        REGION,
        `arn:aws:rds:${REGION}:${ACCOUNT}:snapshot:rds:${instance}-2026-10-25-08-50`,
        { 'cloudgate:state': pgState },
      );

      expect(
        (await request(http).delete(`/postgres/${pgId}`).set('Cookie', cookie))
          .status,
      ).toBe(200);
      await until(async () => (await pgRow()) === undefined);
      expect(lines).toContain(
        `  rds:snapshot ${pgSnapshot()} (${REGION}, 20 GB): about $1.90 a month until you delete it in AWS`,
      );
      expect(lines.some((line) => line.startsWith('Left'))).toBe(false);
    });

    it('with "also delete its data" ticked, skips the snapshot and says the data is gone', async () => {
      const res = await request(http)
        .delete(`/postgres/${pgId}?deleteData=true`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        cloudDelete: { status: 'deleting', finalSnapshot: null },
      });
      await until(async () => (await pgRow()) === undefined);

      expect(changes()).toEqual([
        'rdsLiftDeletionProtection',
        'apply',
        'destroy',
      ]);
      const definition = ctx.cloud.tofuInputs[0].definition;
      expect(definition).toContain('"skip_final_snapshot": true');
      expect(definition).toContain('"final_snapshot_identifier": null');
      expect(ctx.cloud.snapshotNamed('rds', pgSnapshot())).toBeUndefined();
      expect(ctx.cloud.calls.map((call) => call.method)).not.toContain(
        'rdsSnapshot',
      );
      expect(lines).toContain(dataDeletedLine('pg-1'));
      expect(lines).not.toContain('Kept on purpose:');
    });

    it('a run that fails after lifting protection is Delete incomplete and says protection is now off; Retry keeps the same snapshot', async () => {
      ctx.cloud.failRunFor('postgres', 'Error: AWS said no.');

      expect(
        (await request(http).delete(`/postgres/${pgId}`).set('Cookie', cookie))
          .status,
      ).toBe(200);
      await until(
        async () => (await pgRow())?.cloudDelete?.status === 'incomplete',
      );
      const record = (await pgRow()).cloudDelete!;
      expect(record.unfinished).toContain(
        "pg-1's deletion protection is now off.",
      );
      expect(changes()).toEqual(['rdsLiftDeletionProtection', 'apply']);
      expect(await statesHeld(pgState)).toBe(1);
      // A deploy of it, a second Delete: refused while incomplete.
      expect(
        (await request(http).delete(`/postgres/${pgId}`).set('Cookie', cookie))
          .status,
      ).toBe(409);

      ctx.cloud.reset();
      const retried = await request(http)
        .post(`/postgres/${pgId}/delete/retry`)
        .set('Cookie', cookie);
      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({
        cloudDelete: {
          status: 'deleting',
          retrying: true,
          finalSnapshot: record.finalSnapshot,
        },
      });
      await until(async () => (await pgRow()) === undefined);
      expect(ctx.cloud.snapshotNamed('rds', pgSnapshot())).toBeDefined();
    });

    it('fails and removes nothing when RDS refuses to lift its protection', async () => {
      ctx.cloud.refuseProtectionLift(
        'AccessDenied',
        'User is not authorized to perform: rds:ModifyDBInstance',
      );

      expect(
        (await request(http).delete(`/postgres/${pgId}`).set('Cookie', cookie))
          .status,
      ).toBe(200);
      await until(async () => (await pgRow())?.cloudDelete === null);
      expect(changes()).toEqual(['rdsLiftDeletionProtection']);
      expect(lines.join('\n')).toContain(
        "RDS refused to lift pg-1's deletion protection: AWS answered AccessDenied",
      );
    });

    it('forgets a Delete incomplete, dropping the row and its state', async () => {
      ctx.cloud.failRunFor('postgres', 'Error: AWS said no.');
      await request(http).delete(`/postgres/${pgId}`).set('Cookie', cookie);
      await until(
        async () => (await pgRow())?.cloudDelete?.status === 'incomplete',
      );

      const forgotten = await request(http)
        .post(`/postgres/${pgId}/delete/forget`)
        .set('Cookie', cookie);

      expect(forgotten.status).toBe(200);
      expect(await pgRow()).toBeUndefined();
      expect(await statesHeld(pgState)).toBe(0);
    });

    it('answers the Delete dialog the snapshot it keeps and about what it costs', async () => {
      const res = await request(http)
        .get(`/postgres/${pgId}/final-snapshot`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        cloud: 'aws',
        name: pgSnapshot(),
        region: REGION,
        sizeGb: 20,
        monthlyUsd: 1.9,
        sentence: `keeps snapshot ${pgSnapshot()}, about $1.90 a month, until you delete it in AWS`,
      });
    });
  });

  describe('a redis on ElastiCache', () => {
    it('keeps a final snapshot with no protection to lift, and names it once in the report', async () => {
      const res = await request(http)
        .delete(`/redis/${cacheId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        cloudDelete: { status: 'deleting', finalSnapshot: cacheSnapshot() },
      });
      await until(async () => (await cacheRow()) === undefined);

      expect(changes()).toEqual(['apply', 'destroy']);
      expect(
        ctx.cloud.calls.find((call) => call.method === 'apply'),
      ).toMatchObject({
        stateId: cacheState,
        targets: ['aws_elasticache_replication_group.cache'],
        variables: ['auth_token'],
      });
      expect(ctx.cloud.tofuInputs[0].definition).toContain(
        `"final_snapshot_identifier": "${cacheSnapshot()}"`,
      );
      expect(
        ctx.cloud.snapshotNamed('elasticache', cacheSnapshot()),
      ).toBeDefined();
      expect(lines).toContain(
        `  elasticache:snapshot ${cacheSnapshot()} (${REGION}, 0.5 GiB): about $0.04 a month until you delete it in AWS`,
      );
      expect(await statesHeld(cacheState)).toBe(0);
    });

    it('with "also delete its data" ticked, takes no snapshot', async () => {
      expect(
        (
          await request(http)
            .delete(`/redis/${cacheId}?deleteData=true`)
            .set('Cookie', cookie)
        ).status,
      ).toBe(200);
      await until(async () => (await cacheRow()) === undefined);

      expect(ctx.cloud.tofuInputs[0].definition).toContain(
        '"final_snapshot_identifier": null',
      );
      expect(
        ctx.cloud.snapshotNamed('elasticache', cacheSnapshot()),
      ).toBeUndefined();
      expect(lines).toContain(dataDeletedLine('cache'));
    });
  });

  describe("an Environment's Delete", () => {
    it('refuses the flag, removing nothing', async () => {
      const res = await request(http)
        .delete(`/environments/${environmentId}?deleteData=true`)
        .set('Cookie', cookie);

      expect(res.status).toBe(400);
      expect(await pgRow()).toBeDefined();
      expect(ctx.cloud.calls).toEqual([]);
    });

    it("deletes each database through its own Delete, keeping every one's final snapshot", async () => {
      const res = await request(http)
        .delete(`/environments/${environmentId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      await until(async () => {
        const [found] = await ctx.db
          .select()
          .from(environment)
          .where(eq(environment.environmentId, environmentId));
        return found === undefined;
      });
      expect(ctx.cloud.snapshotNamed('rds', pgSnapshot())).toBeDefined();
      expect(
        ctx.cloud.snapshotNamed('elasticache', cacheSnapshot()),
      ).toBeDefined();
      expect(await statesHeld(pgState)).toBe(0);
      expect(await statesHeld(cacheState)).toBe(0);
    });
  });
});
