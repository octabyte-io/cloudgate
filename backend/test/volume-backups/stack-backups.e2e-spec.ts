import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ComposeService } from '../../src/compose/compose.service';
import {
  cloudAccount,
  compose as composeTable,
  environment,
  licenseKey,
  member,
  organizationRole,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { VOLUME_LOCK_BUSY_EXIT_CODE } from '../../src/deployment-engine/volume-lock';
import { MOMENT_RESTORE_HALTED_EXIT_CODE } from '../../src/volume-backups/volume-backup-commands';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { PermissionService } from '../../src/rbac/permission.service';
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

  describe('restoring a moment', () => {
    const NEWER = '2026-11-26T03-00-00-000Z';
    const OLDER = '2026-11-25T03-00-00-000Z';

    /** What `rclone lsjson --recursive` answers for the backup's prefix:
     * two moments, written oldest first, and one object no Stack backup
     * wrote. */
    const LISTING = JSON.stringify([
      { Path: OLDER, Name: OLDER, Size: -1, IsDir: true },
      {
        Path: `${OLDER}/zeta-db.tar`,
        Name: 'zeta-db.tar',
        Size: 10,
        IsDir: false,
      },
      {
        Path: `${OLDER}/alpha-files.tar`,
        Name: 'alpha-files.tar',
        Size: 10,
        IsDir: false,
      },
      { Path: NEWER, Name: NEWER, Size: -1, IsDir: true },
      {
        Path: `${NEWER}/alpha-files.tar`,
        Name: 'alpha-files.tar',
        Size: 10,
        IsDir: false,
      },
      {
        Path: `${NEWER}/zeta-db.tar`,
        Name: 'zeta-db.tar',
        Size: 10,
        IsDir: false,
      },
      { Path: 'notes.txt', Name: 'notes.txt', Size: 3, IsDir: false },
    ]);

    /** The machine: the listing answers `LISTING`, the restore script is
     * answered by `restore`, and everything else succeeds. */
    function machine(restore: () => Promise<unknown> = ok): void {
      execMock.execAsync.mockImplementation((command: string) => {
        if (command.startsWith('rclone lsjson')) {
          return Promise.resolve({ stdout: LISTING, stderr: '', exitCode: 0 });
        }
        if (
          command.includes('Step started: Remove containers') ||
          command.includes("'Step started: Stop'")
        ) {
          return restore();
        }
        return ok();
      });
    }

    const restoreScript = () => {
      const found = scripts().find((script) =>
        script.includes('Step started:'),
      );
      if (!found) throw new Error('no moment restore script was dispatched');
      return found;
    };

    const restoreMoment = (volumeBackupId: string, moment = NEWER) =>
      request(http)
        .post(`/volume-backups/${volumeBackupId}/restore-moment`)
        .set('Cookie', cookie)
        .send({ moment });

    const runsOf = async (volumeBackupId: string) =>
      (
        await ctx.db.execute(
          sql`SELECT title, status FROM deployment WHERE volume_backup_id = ${volumeBackupId} ORDER BY created_at`,
        )
      ).rows;

    const statusOf = async (composeId: string) =>
      (
        await ctx.db
          .select({ composeStatus: composeTable.composeStatus })
          .from(composeTable)
          .where(eq(composeTable.composeId, composeId))
      )[0].composeStatus;

    it('lists the moments the destination holds, newest first, with their volumes', async () => {
      const { appName, volumeBackupId } = await stackBackupOf();
      machine();

      const listed = await request(http)
        .get(`/volume-backups/${volumeBackupId}/moments`)
        .set('Cookie', cookie);

      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([
        {
          moment: NEWER,
          takenAt: '2026-11-26T03:00:00.000Z',
          volumes: ['alpha-files', 'zeta-db'],
        },
        {
          moment: OLDER,
          takenAt: '2026-11-25T03:00:00.000Z',
          volumes: ['alpha-files', 'zeta-db'],
        },
      ]);
      const listing = scripts().find((script) =>
        script.startsWith('rclone lsjson'),
      );
      expect(listing).toContain(
        ` --recursive --files-only --no-mimetype \\:s3\\:cloudgate-backups/${appName}/nightly/`,
      );
    });

    it('removes the containers, restores every volume and starts the stack, as one run', async () => {
      const { composeId, appName, volumeBackupId } = await stackBackupOf();
      machine();

      const restored = await restoreMoment(volumeBackupId);

      expect(restored.status).toBe(204);
      const script = restoreScript();
      const remove = script.indexOf('rm --stop --force');
      const alpha = script.indexOf('docker volume rm alpha-files --force');
      const zeta = script.indexOf('docker volume rm zeta-db --force');
      const start = script.indexOf(' up -d');
      expect(remove).toBeGreaterThan(-1);
      expect(alpha).toBeGreaterThan(remove);
      expect(zeta).toBeGreaterThan(alpha);
      expect(start).toBeGreaterThan(zeta);
      expect(script).toContain(
        `\\:s3\\:cloudgate-backups/${appName}/nightly/${NEWER}/zeta-db.tar`,
      );
      expect(await runsOf(volumeBackupId)).toEqual([
        { title: 'Stack Restore', status: 'done' },
      ]);
      expect(await statusOf(composeId)).toBe('done');
    });

    it('stops a swarm stack rather than removing containers', async () => {
      const { volumeBackupId } = await stackBackupOf({}, 'stack');
      machine();

      const restored = await restoreMoment(volumeBackupId);

      expect(restored.status).toBe(204);
      const script = restoreScript();
      expect(script).toContain("'Step started: Stop'");
      expect(script).toContain('docker service update --replicas=0');
      expect(script).not.toContain('rm --stop --force');
    });

    it('takes every volume lock in name order', async () => {
      const { volumeBackupId } = await stackBackupOf();
      machine();

      await restoreMoment(volumeBackupId);

      const script = restoreScript();
      const alpha = script.indexOf('Volume lock acquired: alpha-files');
      const zeta = script.indexOf('Volume lock acquired: zeta-db');
      expect(alpha).toBeGreaterThan(-1);
      expect(zeta).toBeGreaterThan(alpha);
      expect(script.indexOf('Step started: Remove containers')).toBeGreaterThan(
        zeta,
      );
    });

    it('answers 409 naming the volume when one lock is held, leaving the stack as it was', async () => {
      const { composeId, volumeBackupId } = await stackBackupOf();
      const before = await statusOf(composeId);
      machine(() =>
        Promise.reject(
          Object.assign(new Error('Command failed with exit code 75'), {
            exitCode: VOLUME_LOCK_BUSY_EXIT_CODE,
            stdout: '',
            stderr: '',
          }),
        ),
      );

      const refused = await restoreMoment(volumeBackupId);

      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toContain(
        'alpha-files',
      );
      expect(await statusOf(composeId)).toBe(before);
    });

    it('records a restore that failed at a step as an error run and the stack as stopped', async () => {
      const { composeId, volumeBackupId } = await stackBackupOf();
      machine(() =>
        Promise.reject(
          Object.assign(new Error('Command failed with exit code 3'), {
            exitCode: MOMENT_RESTORE_HALTED_EXIT_CODE,
            stdout: '',
            stderr: '',
          }),
        ),
      );

      const failed = await restoreMoment(volumeBackupId);

      expect(failed.status).toBe(400);
      expect((failed.body as { message: string }).message).toContain(
        'run’s log',
      );
      expect(await runsOf(volumeBackupId)).toEqual([
        { title: 'Stack Restore', status: 'error' },
      ]);
      expect(await statusOf(composeId)).toBe('stopped');
    });

    it('leaves the stack as it was when the restore failed before its first step', async () => {
      const { composeId, volumeBackupId } = await stackBackupOf();
      const before = await statusOf(composeId);
      machine(() =>
        Promise.reject(
          Object.assign(new Error('Command failed with exit code 1'), {
            exitCode: 1,
            stdout: '',
            stderr: '',
          }),
        ),
      );

      const failed = await restoreMoment(volumeBackupId);

      expect(failed.status).toBe(400);
      expect(await runsOf(volumeBackupId)).toEqual([
        { title: 'Stack Restore', status: 'error' },
      ]);
      expect(await statusOf(composeId)).toBe(before);
    });

    it('refuses a moment the destination does not hold, running nothing', async () => {
      const { volumeBackupId } = await stackBackupOf();
      machine();

      const refused = await restoreMoment(
        volumeBackupId,
        '2026-01-01T03-00-00-000Z',
      );

      expect(refused.status).toBe(404);
      expect(scripts().some((script) => script.includes('Step started:'))).toBe(
        false,
      );
      expect(await runsOf(volumeBackupId)).toEqual([]);
    });

    it('refuses a value that is not a moment', async () => {
      const { volumeBackupId } = await stackBackupOf();

      const refused = await restoreMoment(volumeBackupId, '../other-app');

      expect(refused.status).toBe(400);
    });

    it('refuses a backup of one volume, which has no moments', async () => {
      const { composeId } = await createStack();
      const created = await createBackup({
        volumeName: 'zeta-db',
        serviceType: 'compose',
        serviceId: composeId,
      });

      const refused = await request(http)
        .get(
          `/volume-backups/${(created.body as { volumeBackupId: string }).volumeBackupId}/moments`,
        )
        .set('Cookie', cookie);

      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toContain(
        'Only a Stack backup has moments',
      );
    });

    describe('authorization', () => {
      /** Moves an invitee entitled to the stack onto a licensed custom role. */
      async function memberWith(
        composeId: string,
        permission: Record<string, string[]>,
      ): Promise<string> {
        const invite = await request(http)
          .post('/organizations/invitations')
          .set('Cookie', cookie)
          .send({ email: 'ida@example.com', role: 'member' });
        const inviteId = (invite.body as { id: string }).id;
        const signedUp = await request(http)
          .post('/api/auth/sign-up/email')
          .set('x-cloudgate-token', inviteId)
          .send({
            name: 'Ida Rhodes',
            email: 'ida@example.com',
            password: 'super-secret-password',
          });
        const inviteeCookie = (
          signedUp.headers['set-cookie'] as unknown as string[]
        )
          .map((entry) => entry.split(';')[0])
          .join('; ');
        const inviteeId = (signedUp.body as { user: { id: string } }).user.id;
        const accepted = await request(http)
          .post(`/organizations/invitations/${inviteId}/accept`)
          .set('Cookie', inviteeCookie);
        expect(accepted.status).toBe(201);

        const [memberRow] = await ctx.db
          .select()
          .from(member)
          .where(eq(member.userId, inviteeId));
        const [stack] = await ctx.db
          .select({ environmentId: composeTable.environmentId })
          .from(composeTable)
          .where(eq(composeTable.composeId, composeId));
        const [env] = await ctx.db
          .select({ projectId: environment.projectId })
          .from(environment)
          .where(eq(environment.environmentId, stack.environmentId));
        await ctx.app
          .get(PermissionService)
          .setMemberEntitlements(organizationId, memberRow.id, {
            accessedProjects: [env.projectId],
            accessedEnvironments: [stack.environmentId],
            accessedServices: [composeId],
          });
        await ctx.db.insert(licenseKey).values({
          organizationId,
          key: 'test-license-key',
          status: 'active',
          enableEnterpriseFeatures: true,
        });
        await ctx.db.insert(organizationRole).values({
          organizationId,
          role: 'stack-restorer',
          permission: { ac: ['read'], ...permission },
        });
        await ctx.db
          .update(member)
          .set({ role: 'stack-restorer' })
          .where(eq(member.userId, inviteeId));
        return inviteeCookie;
      }

      it.each([
        [
          'volumeBackup restore',
          { service: ['read', 'update'], volumeBackup: ['read'] },
        ],
        [
          'service update',
          { service: ['read'], volumeBackup: ['read', 'restore'] },
        ],
      ])(
        'refuses a role without %s, running nothing',
        async (_, permission) => {
          const { composeId, volumeBackupId } = await stackBackupOf();
          machine();
          const inviteeCookie = await memberWith(composeId, permission);

          const refused = await request(http)
            .post(`/volume-backups/${volumeBackupId}/restore-moment`)
            .set('Cookie', inviteeCookie)
            .send({ moment: NEWER });

          expect(refused.status).toBe(403);
          expect(
            scripts().some((script) => script.includes('Step started:')),
          ).toBe(false);
        },
      );

      it('lets a role holding both restore the moment', async () => {
        const { composeId, volumeBackupId } = await stackBackupOf();
        machine();
        const inviteeCookie = await memberWith(composeId, {
          service: ['read', 'update'],
          volumeBackup: ['read', 'restore'],
        });

        const restored = await request(http)
          .post(`/volume-backups/${volumeBackupId}/restore-moment`)
          .set('Cookie', inviteeCookie)
          .send({ moment: NEWER });

        expect(restored.status).toBe(204);
      });
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
