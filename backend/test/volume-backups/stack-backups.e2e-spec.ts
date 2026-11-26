import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ComposeService } from '../../src/compose/compose.service';
import { cloudAccount, compose as composeTable } from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { VOLUME_LOCK_BUSY_EXIT_CODE } from '../../src/deployment-engine/volume-lock';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * A catalogue-shaped stack: a database and the app's files. Every volume is
 * given its Docker name with `name:`, and the file lists `zeta-db` before
 * `alpha-files`, so an assertion about name order cannot pass by file order.
 */
const STACK_FILE = `services:
  db:
    image: postgres:17
    volumes:
      - db-data:/var/lib/postgresql/data
  app:
    image: outlinewiki/outline:0.80
    volumes:
      - files:/var/lib/outline/data
      - ./config:/config:ro
volumes:
  db-data:
    name: zeta-db
  files:
    name: alpha-files
`;

/** One moment folder: `getBackupTimestamp`'s ISO instant, `:` and `.` as `-`. */
const MOMENT = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z';

/**
 * A **Stack backup** (ADR-0092, #164): one row and one run for a whole
 * Compose stack, which stops the stack once, tars every volume its last
 * successful deploy recorded under one moment folder, and starts it again.
 *
 * Through the HTTP seam, with only the machine replaced
 * (`RemoteExecService`), so the real deploy records the stack's volumes.
 */
describe('Stack backups (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let compose: ComposeService;
  let engine: DeploymentEngineService;
  let destinations: DestinationsService;
  let cookie: string;
  let environmentId: string;
  let organizationId: string;
  let userId: string;

  const ok = () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
  const execMock = withArgvExec({
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  });
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
      ],
    });
    http = ctx.app.getHttpServer() as App;
    compose = ctx.app.get(ComposeService);
    engine = ctx.app.get(DeploymentEngineService);
    destinations = ctx.app.get(DestinationsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockImplementation(ok);
    execMock.execAsyncRemote.mockReset().mockImplementation(ok);
    queueMock.add.mockReset().mockResolvedValue({ id: 'job-1' });

    const res = await request(http).post('/api/auth/sign-up/email').send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    userId = (res.body as { user: { id: string } }).user.id;
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'wiki' });
    expect(project.status).toBe(201);
    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        name: 'production',
        projectId: (project.body as { projectId: string }).projectId,
      });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;
  });

  async function createStack(
    composeType: 'docker-compose' | 'stack' = 'docker-compose',
  ): Promise<{ composeId: string; appName: string }> {
    const created = await request(http)
      .post('/compose')
      .set('Cookie', cookie)
      .send({
        name: 'outline',
        environmentId,
        composeType,
        composeFile: STACK_FILE,
      });
    expect(created.status).toBe(201);
    return created.body as { composeId: string; appName: string };
  }

  async function deploy(composeId: string): Promise<void> {
    await engine.deployCompose(await compose.findDeployable(composeId), {
      title: 'Manual deployment',
      description: '',
    });
  }

  async function destinationId(): Promise<string> {
    const destination = await destinations.create(
      {
        user: { id: userId },
        session: { activeOrganizationId: organizationId },
      },
      {
        name: 'prod-backups',
        provider: 'Cloudflare',
        accessKey: 'AKIAEXAMPLEACCESSKEY',
        secretAccessKey: 'wJalrXUtnFEMI-example-secret-key',
        bucket: 'cloudgate-backups',
        region: 'auto',
        endpoint: 'https://accountid.r2.cloudflarestorage.com',
      },
    );
    return destination.destinationId;
  }

  async function createBackup(body: Record<string, unknown>) {
    return request(http)
      .post('/volume-backups')
      .set('Cookie', cookie)
      .send({
        name: 'Nightly',
        prefix: 'nightly',
        schedule: '0 3 * * *',
        destinationId: await destinationId(),
        ...body,
      });
  }

  /** A deployed stack with a Stack backup, its exec log cleared. */
  async function stackBackupOf(
    body: Record<string, unknown> = {},
    composeType: 'docker-compose' | 'stack' = 'docker-compose',
  ) {
    const stack = await createStack(composeType);
    await deploy(stack.composeId);
    const created = await createBackup({
      scope: 'stack',
      serviceType: 'compose',
      serviceId: stack.composeId,
      turnOff: true,
      ...body,
    });
    expect(created.status).toBe(201);
    execMock.execAsync.mockClear();
    return {
      ...stack,
      volumeBackupId: (created.body as { volumeBackupId: string })
        .volumeBackupId,
    };
  }

  const runNow = (volumeBackupId: string) =>
    request(http)
      .post(`/volume-backups/${volumeBackupId}/run`)
      .set('Cookie', cookie);

  const scripts = () =>
    execMock.execAsync.mock.calls.map(([command]) => command as string);
  const backupScript = () => {
    const found = scripts().find((script) => script.includes('rclone copyto'));
    if (!found) throw new Error('no backup script was dispatched');
    return found;
  };

  describe('scope', () => {
    it('stores a backup with no scope as a backup of one volume, as before', async () => {
      const { composeId } = await createStack();

      const created = await createBackup({
        volumeName: 'zeta-db',
        serviceName: 'db',
        serviceType: 'compose',
        serviceId: composeId,
      });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        scope: 'volume',
        volumeName: 'zeta-db',
        serviceName: 'db',
      });
    });

    it('stores a Stack backup on a Compose stack with no volume and no service', async () => {
      const { composeId } = await createStack();

      const created = await createBackup({
        scope: 'stack',
        serviceType: 'compose',
        serviceId: composeId,
        turnOff: true,
      });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        scope: 'stack',
        composeId,
        volumeName: null,
        serviceName: null,
        turnOff: true,
      });
    });

    it('refuses a patch that points a Stack backup at one volume', async () => {
      const { composeId } = await createStack();
      const created = await createBackup({
        scope: 'stack',
        serviceType: 'compose',
        serviceId: composeId,
      });

      const patched = await request(http)
        .patch(
          `/volume-backups/${(created.body as { volumeBackupId: string }).volumeBackupId}`,
        )
        .set('Cookie', cookie)
        .send({ volumeName: 'zeta-db' });

      expect(patched.status).toBe(400);
      expect((patched.body as { message: string }).message).toContain(
        'A Stack backup tars every volume its services mount',
      );
    });

    it('refuses a one-volume backup that names no volume', async () => {
      const { composeId } = await createStack();

      const refused = await createBackup({
        serviceType: 'compose',
        serviceId: composeId,
      });

      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain(
        'A backup of one volume needs the volume to tar',
      );
    });

    it.each(['application', 'bucket'])(
      'refuses the stack scope on a %s, with the reason',
      async (serviceType) => {
        const refused = await createBackup({
          scope: 'stack',
          serviceType,
          serviceId: 'svc-1',
        });

        expect(refused.status).toBe(400);
        expect(JSON.stringify(refused.body)).toContain(
          'The whole stack can be backed up only on a Compose stack',
        );
      },
    );

    it.each([
      ['the stack scope', { scope: 'stack' }],
      ['one volume', { volumeName: 'zeta-db', serviceName: 'db' }],
    ])(
      'refuses %s on a stack in a Cloud account, with the reason',
      async (_, body) => {
        const { composeId } = await createStack();
        const [account] = await ctx.db
          .insert(cloudAccount)
          .values({
            organizationId,
            name: 'Production AWS',
            cloud: 'aws',
            cloudId: '123456789012',
            accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
            secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
            taskExecutionRoleArn:
              'arn:aws:iam::123456789012:role/cloudgate-task-execution',
            externalId: 'external-id-made-by-cloudgate',
            policyVersion: 1,
            lastCheckedAt: new Date().toISOString(),
            lastCheckResult: 'passed',
          })
          .returning();
        await ctx.db
          .update(composeTable)
          .set({
            cloudAccountId: account.cloudAccountId,
            region: 'eu-central-1',
          })
          .where(eq(composeTable.composeId, composeId));

        const refused = await createBackup({
          serviceType: 'compose',
          serviceId: composeId,
          ...body,
        });

        expect(refused.status).toBe(409);
        expect((refused.body as { message: string }).message).toContain(
          'runs in a Cloud account',
        );
      },
    );
  });

  describe('a run', () => {
    it('writes one tarball per recorded volume under one moment folder, and records one run', async () => {
      const { appName, volumeBackupId } = await stackBackupOf();

      const ran = await runNow(volumeBackupId);
      expect(ran.status).toBeLessThan(300);

      const script = backupScript();
      const uploads = [
        ...script.matchAll(
          new RegExp(
            `cloudgate-backups/${appName}/nightly/(${MOMENT})/([a-z-]+)\\.tar`,
            'g',
          ),
        ),
      ];
      expect(uploads.map((match) => match[2]).sort()).toEqual([
        'alpha-files',
        'zeta-db',
      ]);
      expect(new Set(uploads.map((match) => match[1])).size).toBe(1);

      const runs = await ctx.db.execute(
        sql`SELECT status FROM deployment WHERE volume_backup_id = ${volumeBackupId}`,
      );
      expect(runs.rows).toEqual([{ status: 'done' }]);
    });

    it('stops the stack once and starts it once around every volume', async () => {
      const { volumeBackupId } = await stackBackupOf();

      await runNow(volumeBackupId);

      const script = backupScript();
      expect(script.match(/docker stop /g)).toHaveLength(1);
      expect(script.match(/docker start /g)).toHaveLength(1);
      const stop = script.indexOf('docker stop ');
      for (const volume of ['alpha-files', 'zeta-db']) {
        expect(script.indexOf(`-v ${volume}\\:/volume_data`)).toBeGreaterThan(
          stop,
        );
      }
      expect(script.indexOf('trap restore_stack EXIT')).toBeLessThan(stop);
    });

    it('stops nothing with the switch off', async () => {
      const { volumeBackupId } = await stackBackupOf({ turnOff: false });

      await runNow(volumeBackupId);

      const script = backupScript();
      expect(script).not.toContain('docker stop');
      expect(script).toContain('-v alpha-files\\:/volume_data');
      expect(script).toContain('-v zeta-db\\:/volume_data');
    });

    it('takes every volume lock in name order', async () => {
      const { volumeBackupId } = await stackBackupOf();

      await runNow(volumeBackupId);

      const script = backupScript();
      const alpha = script.indexOf('Volume lock acquired: alpha-files');
      const zeta = script.indexOf('Volume lock acquired: zeta-db');
      expect(alpha).toBeGreaterThan(-1);
      expect(zeta).toBeGreaterThan(alpha);
    });

    it('prunes whole moments to the newest N after a successful run', async () => {
      const { appName, volumeBackupId } = await stackBackupOf({
        keepLatestCount: 3,
      });

      await runNow(volumeBackupId);

      expect(scripts()).toContain(
        `rclone lsf --dirs-only \\:s3\\:cloudgate-backups/${appName}/nightly/ | ` +
          'sort -r | tail -n +$((3+1)) | xargs -I{} ' +
          `rclone purge \\:s3\\:cloudgate-backups/${appName}/nightly/\\{\\}`,
      );
    });

    it('fails a stack with no recorded volumes, recording the run with the reason', async () => {
      const { composeId } = await createStack();
      const created = await createBackup({
        scope: 'stack',
        serviceType: 'compose',
        serviceId: composeId,
      });
      const volumeBackupId = (created.body as { volumeBackupId: string })
        .volumeBackupId;

      const ran = await runNow(volumeBackupId);

      expect(ran.status).toBe(400);
      expect((ran.body as { message: string }).message).toContain(
        'hasn’t deployed successfully yet',
      );
      const runs = await ctx.db.execute(
        sql`SELECT status FROM deployment WHERE volume_backup_id = ${volumeBackupId}`,
      );
      expect(runs.rows).toEqual([{ status: 'error' }]);
    });
  });

  describe('Remove containers', () => {
    it('answers 409 while a turn-off Stack backup holds one of its volumes', async () => {
      const { composeId } = await stackBackupOf();
      execMock.execAsync.mockImplementation((command: string) =>
        command.includes('rm --stop --force')
          ? Promise.reject(
              Object.assign(new Error('Command failed with exit code 75'), {
                exitCode: VOLUME_LOCK_BUSY_EXIT_CODE,
                stdout:
                  'Waiting for volume lock: alpha-files\nVolume lock busy: alpha-files\n',
                stderr: '',
              }),
            )
          : ok(),
      );

      const removed = await request(http)
        .post(`/compose/${composeId}/remove-containers`)
        .set('Cookie', cookie);

      expect(removed.status).toBe(409);
      expect((removed.body as { message: string }).message).toContain(
        'alpha-files',
      );
      const removal = scripts().find((script) =>
        script.includes('rm --stop --force'),
      );
      expect(removal).toContain('volume-backup-lock-alpha-files');
      expect(removal).toContain('volume-backup-lock-zeta-db');
    });

    it('takes no stack lock for a Stack backup that stops nothing', async () => {
      const { composeId } = await stackBackupOf({ turnOff: false });

      const removed = await request(http)
        .post(`/compose/${composeId}/remove-containers`)
        .set('Cookie', cookie);

      expect(removed.status).toBe(200);
      const removal = scripts().find((script) =>
        script.includes('rm --stop --force'),
      );
      expect(removal).not.toContain('LOCK_PATH');
    });
  });
});
