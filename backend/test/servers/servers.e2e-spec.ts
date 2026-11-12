import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import {
  application,
  certificate,
  containerMetric,
  forwardAuthSettings,
  schedule,
  serverMetric,
} from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { SERVER_KEY_PROVIDER } from '../../src/remote/server-key.provider';
import type { ServerKeyProvider } from '../../src/remote/server-key.provider';
import { ServersService } from '../../src/servers/servers.service';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { withArgvExec } from '../utils/exec-double';
import { serverSetupCommand } from '../../src/servers/server-setup';
import { seededConfigName } from '../utils/seeded-config-name';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

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

/** The owner's bootstrap organization plus a service-seam permission ctx. */
async function setUpOwner(server: App) {
  const ownerSession = await signUp(server, owner);

  const orgs = await request(server)
    .get('/organizations')
    .set('Cookie', ownerSession.cookie);
  const organizationId = (orgs.body as { id: string }[])[0].id;

  return { organizationId, owner: ownerSession };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

const okExec: ExecResult = { stdout: 'ok\n', stderr: '', exitCode: 0 };

describe('Servers (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let servers: ServersService;
  let sshKeys: SshKeysService;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let postgres: PostgresService;

  // All remote commands go through RemoteExecService (phase 10); the seam
  // mocks it so no test ever opens a real SSH connection.
  // `withArgvExec` so the argv half (`execRemote`, the setup's read-back of
  // traefik.yml) reaches the same mock as a quoted string.
  const remoteExec = withArgvExec({
    execAsyncRemote: jest.fn<
      Promise<ExecResult>,
      [string, string, ((d: string) => void)?]
    >(),
  });

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: remoteExec }],
    });
    server = ctx.app.getHttpServer() as App;
    servers = ctx.app.get(ServersService);
    sshKeys = ctx.app.get(SshKeysService);
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    postgres = ctx.app.get(PostgresService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    remoteExec.execAsyncRemote.mockReset();
    await ctx.resetDb();
  });

  /** An owner ctx plus an ssh key to attach servers to. */
  async function setUpOwnerWithKey() {
    const { organizationId, owner: ownerSession } = await setUpOwner(server);
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);
    const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
    return { organizationId, ownerSession, ownerCtx, sshKeyId: key.sshKeyId };
  }

  /**
   * An Environment to hang services off, for the delete guard's tests. The
   * organization already has the carrier, so the Deploy target is a choice it
   * must make; the platform host keeps the carrier's refusal about what
   * it carries and not about being a Deploy target.
   */
  async function setUpEnvironment(ownerCtx: ReturnType<typeof permissionCtx>) {
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
      deployTarget: { kind: 'platform-host' },
    });
    return environment.environmentId;
  }

  /**
   * A Server with an ssh key, carrying nothing yet. Lifted out of the refusal-wording
   * block so the exact-wording pins can share it.
   */
  async function setUpCarrier() {
    const { organizationId, ownerSession, ownerCtx, sshKeyId } =
      await setUpOwnerWithKey();
    const carrier = await servers.create(ownerCtx, {
      name: 'carrier',
      ipAddress: '203.0.113.30',
      port: 22,
      username: 'root',
      sshKeyId,
    });
    return { organizationId, ownerSession, ownerCtx, carrier };
  }

  describe('list', () => {
    it('lists the organization servers newest first', async () => {
      const { ownerCtx, sshKeyId } = await setUpOwnerWithKey();

      await servers.create(ownerCtx, {
        name: 'older',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await servers.create(ownerCtx, {
        name: 'newer',
        ipAddress: '203.0.113.11',
        port: 22,
        username: 'root',
        sshKeyId,
      });

      const listed = await servers.list(ownerCtx);
      // The list orders by createdAt desc.
      expect(listed.map((s) => s.name)).toEqual(['newer', 'older']);
    });
  });

  describe('update', () => {
    it('changes the given fields and leaves the rest untouched', async () => {
      const { ownerCtx, sshKeyId } = await setUpOwnerWithKey();

      const created = await servers.create(ownerCtx, {
        name: 'before',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId,
      });

      const updated = await servers.update(ownerCtx, created.serverId, {
        name: 'after',
        description: 'moved to new DC',
        ipAddress: '203.0.113.99',
        port: 2222,
      });
      expect(updated).toMatchObject({
        serverId: created.serverId,
        name: 'after',
        description: 'moved to new DC',
        ipAddress: '203.0.113.99',
        port: 2222,
        username: 'root',
        sshKeyId,
      });
    });
  });

  describe('remove', () => {
    it('deletes the server', async () => {
      const { ownerCtx, sshKeyId } = await setUpOwnerWithKey();

      const created = await servers.create(ownerCtx, {
        name: 'doomed',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId,
      });

      const removed = await servers.remove(ownerCtx, created.serverId);
      expect(removed.serverId).toBe(created.serverId);

      await expect(servers.findOne(ownerCtx, created.serverId)).rejects.toThrow(
        NotFoundException,
      );
    });

    /**
     * Every service table's `serverId` is `onDelete: 'cascade'`, so
     * before the guard the one unguarded `DELETE` on `server` took Cloudgate's
     * record of every Application, Compose stack and database on the machine
     * with it — while the containers kept running, with nothing left saying
     * which Project they had belonged to. The console at least made an
     * operator type the Server's name; `DELETE /servers/:id` from an API key
     * had no confirmation at all.
     */
    describe('while services name the Server', () => {
      it('refuses, names what it found, and leaves every row where it was', async () => {
        const { ownerCtx, sshKeyId } = await setUpOwnerWithKey();
        const environmentId = await setUpEnvironment(ownerCtx);

        const carrier = await servers.create(ownerCtx, {
          name: 'carrier',
          ipAddress: '203.0.113.10',
          port: 22,
          username: 'root',
          sshKeyId,
        });

        const app = await applications.create(ownerCtx, {
          name: 'Web App',
          appName: 'web-app',
          environmentId,
          serverId: carrier.serverId,
        });
        const db = await postgres.create(ownerCtx, {
          name: 'Orders DB',
          appName: 'orders-db',
          databaseName: 'orders',
          databaseUser: 'orders',
          environmentId,
          serverId: carrier.serverId,
        });

        await expect(
          servers.remove(ownerCtx, carrier.serverId),
        ).rejects.toThrow(ConflictException);

        // The refusal has to name them: after the delete there would be
        // nothing left that could.
        await expect(
          servers.remove(ownerCtx, carrier.serverId),
        ).rejects.toThrow(/application "Web App".*postgres "Orders DB"/s);

        // And nothing moved.
        expect(
          (await servers.findOne(ownerCtx, carrier.serverId)).serverId,
        ).toBe(carrier.serverId);
        expect(
          (await applications.findOne(ownerCtx, app.applicationId))
            .applicationId,
        ).toBe(app.applicationId);
        expect(
          (await postgres.findOne(ownerCtx, db.postgresId)).postgresId,
        ).toBe(db.postgresId);
      });

      it('answers DELETE /servers/:id with a 409 that an API caller can act on', async () => {
        const { ownerSession, ownerCtx, sshKeyId } = await setUpOwnerWithKey();
        const environmentId = await setUpEnvironment(ownerCtx);

        const carrier = await servers.create(ownerCtx, {
          name: 'carrier',
          ipAddress: '203.0.113.10',
          port: 22,
          username: 'root',
          sshKeyId,
        });
        await applications.create(ownerCtx, {
          name: 'Web App',
          appName: 'web-app',
          environmentId,
          serverId: carrier.serverId,
        });

        const refused = await request(server)
          .delete(`/servers/${carrier.serverId}`)
          .set('Cookie', ownerSession.cookie);
        expect(refused.status).toBe(409);
        expect((refused.body as { message: string }).message).toContain(
          'application "Web App"',
        );

        const stillThere = await request(server)
          .get(`/servers/${carrier.serverId}`)
          .set('Cookie', ownerSession.cookie);
        expect(stillThere.status).toBe(200);
      });

      it('deletes a Server whose only tie is as an Application build server', async () => {
        // buildServerId is `set null`, not `cascade` — the Application survives
        // the delete with no build server, which is what that column is for.
        const { ownerCtx, sshKeyId } = await setUpOwnerWithKey();
        const environmentId = await setUpEnvironment(ownerCtx);

        const builder = await servers.create(ownerCtx, {
          name: 'builder',
          ipAddress: '203.0.113.20',
          port: 22,
          username: 'root',
          sshKeyId,
        });
        const app = await applications.create(ownerCtx, {
          name: 'Web App',
          appName: 'web-app',
          environmentId,
        });
        await ctx.db
          .update(application)
          .set({ buildServerId: builder.serverId })
          .where(eq(application.applicationId, app.applicationId));

        const removed = await servers.remove(ownerCtx, builder.serverId);
        expect(removed.serverId).toBe(builder.serverId);
        const [survivor] = await ctx.db
          .select()
          .from(application)
          .where(eq(application.applicationId, app.applicationId));
        expect(survivor.buildServerId).toBeNull();
      });
    });

    /**
     * The original guard read the eight service tables and reasoned that it had
     * covered "every service table's `serverId`" — but thirteen foreign keys
     * onto `server` are `on delete cascade`, and three of the five it missed
     * are configuration an operator authored: a stored certificate whose PEM
     * material Traefik serves on that host, a cron job that runs there, and the
     * forward-auth row naming the domain that host's oauth2-proxy answers on.
     * Deleting a Server carrying only those produced no 409, named nothing and
     * was not mentioned in the dialog.
     *
     * These rows are inserted directly rather than through their services: the
     * subject is the cascade the schema declares, and the V03 verification run
     * could not test it destructively on a live box because creating one would
     * have cost the Server every later phase needed. So this suite is the proof.
     */
    describe('while configuration names the Server', () => {
      it('refuses a Server carrying only a certificate, and names it', async () => {
        const { organizationId, ownerCtx, carrier } = await setUpCarrier();

        await ctx.db.insert(certificate).values({
          name: 'wildcard.example.com',
          certificateData: '-----BEGIN CERTIFICATE-----',
          privateKey: '-----BEGIN PRIVATE KEY-----',
          organizationId,
          serverId: carrier.serverId,
        });

        await expect(
          servers.remove(ownerCtx, carrier.serverId),
        ).rejects.toThrow(ConflictException);
        await expect(
          servers.remove(ownerCtx, carrier.serverId),
        ).rejects.toThrow(/certificate "wildcard\.example\.com"/);

        // A certificate is not a Service (CONTEXT.md), and the refusal must not
        // call it one: it is counted and named in its own clause.
        await expect(
          servers.remove(ownerCtx, carrier.serverId),
        ).rejects.toThrow(/1 configuration entry/);
        await expect(
          servers.remove(ownerCtx, carrier.serverId),
        ).rejects.not.toThrow(/service/);

        // And the row is still there, which before the guard it would not be.
        const [survivor] = await ctx.db.select().from(certificate);
        expect(survivor.serverId).toBe(carrier.serverId);
      });

      it('refuses a Server carrying only a schedule, and names it', async () => {
        const { ownerCtx, carrier } = await setUpCarrier();

        await ctx.db.insert(schedule).values({
          name: 'nightly prune',
          cronExpression: '0 3 * * *',
          command: 'docker system prune -f',
          scheduleType: 'server',
          serverId: carrier.serverId,
        });

        await expect(
          servers.remove(ownerCtx, carrier.serverId),
        ).rejects.toThrow(/schedule "nightly prune"/);

        const [survivor] = await ctx.db.select().from(schedule);
        expect(survivor.serverId).toBe(carrier.serverId);
      });

      it('refuses a Server carrying only a forward-auth rule, counted rather than named', async () => {
        const { ownerCtx, carrier } = await setUpCarrier();

        // forward_auth_settings has no `name` column and its serverId is
        // `.unique()`, so there is at most one per Server and nothing to name it
        // by. The wording fix says count it: naming it by `authDomain` reads as an
        // identifier the row has, and it is the proxy's configuration instead.
        await ctx.db.insert(forwardAuthSettings).values({
          authDomain: 'auth.example.com',
          baseDomain: '.example.com',
          serverId: carrier.serverId,
        });

        await expect(
          servers.remove(ownerCtx, carrier.serverId),
        ).rejects.toThrow(/1 configuration entry \(forward-auth\)/);

        // Nothing borrowed the auth domain to stand in for a name.
        await expect(
          servers.remove(ownerCtx, carrier.serverId),
        ).rejects.not.toThrow(/auth\.example\.com/);

        const [survivor] = await ctx.db.select().from(forwardAuthSettings);
        expect(survivor.serverId).toBe(carrier.serverId);
      });

      it('names Services and configuration as two counted categories in one refusal', async () => {
        const { organizationId, ownerSession, ownerCtx, carrier } =
          await setUpCarrier();
        const environmentId = await setUpEnvironment(ownerCtx);

        await applications.create(ownerCtx, {
          name: 'Web App',
          appName: 'web-app',
          environmentId,
          serverId: carrier.serverId,
        });
        await ctx.db.insert(certificate).values({
          name: 'wildcard.example.com',
          certificateData: '-----BEGIN CERTIFICATE-----',
          privateKey: '-----BEGIN PRIVATE KEY-----',
          organizationId,
          serverId: carrier.serverId,
        });

        const refused = await request(server)
          .delete(`/servers/${carrier.serverId}`)
          .set('Cookie', ownerSession.cookie);
        expect(refused.status).toBe(409);

        const { message } = refused.body as { message: string };
        expect(message).toContain('1 service (application "Web App")');
        expect(message).toContain(
          '1 configuration entry (certificate "wildcard.example.com")',
        );
        // The categories are joined, not merged: nothing calls the certificate
        // a Service, and neither count absorbs the other.
        expect(message).not.toContain('2 services');
      });

      it('deletes a Server whose only remaining rows are metric samples', async () => {
        // container_metric and server_metric cascade too, and are deliberately
        // not guarded: they are a rolling window the next poll refills, nobody
        // authored them, and a guard that counted them would refuse every
        // monitored Server forever.
        const { ownerCtx, carrier } = await setUpCarrier();

        await ctx.db.insert(containerMetric).values({
          timestamp: '2026-08-23T00:00:00Z',
          containerId: 'abc123',
          containerName: 'web-app',
          metrics: { cpu: 1.5 },
          serverId: carrier.serverId,
        });
        await ctx.db.insert(serverMetric).values({
          timestamp: '2026-08-23T00:00:00Z',
          cpu: 1.5,
          cpuModel: 'Test CPU',
          cpuCores: 2,
          cpuPhysicalCores: 2,
          cpuSpeed: 2400,
          os: 'linux',
          distro: 'Ubuntu 24.04',
          kernel: '6.8.0',
          arch: 'x86_64',
          memUsed: 1024,
          memUsedGB: 1,
          memTotal: 3700,
          uptime: 1000,
          diskUsed: 10,
          totalDisk: 40,
          networkIn: 1,
          networkOut: 2,
          serverId: carrier.serverId,
        });

        const removed = await servers.remove(ownerCtx, carrier.serverId);
        expect(removed.serverId).toBe(carrier.serverId);

        // Nothing was kept: the samples went with the Server, which is the
        // outcome the cascade was written for.
        expect(await ctx.db.select().from(containerMetric)).toHaveLength(0);
        expect(await ctx.db.select().from(serverMetric)).toHaveLength(0);
      });

      it('spends the naming budget per category, so a Server carrying many of both names ten of each', async () => {
        const { organizationId, ownerCtx, carrier } = await setUpCarrier();
        const environmentId = await setUpEnvironment(ownerCtx);

        // Direct inserts, like the rest of this block: the subject is the
        // refusal's arithmetic, and twenty-four services through their own
        // create() would buy nothing but minutes.
        await ctx.db.insert(application).values(
          Array.from({ length: 12 }, (_, i) => ({
            name: `App ${i}`,
            appName: `app-${i}`,
            environmentId,
            configName: seededConfigName(),
            serverId: carrier.serverId,
          })),
        );
        await ctx.db.insert(certificate).values(
          Array.from({ length: 12 }, (_, i) => ({
            name: `cert-${i}.example.com`,
            certificateData: '-----BEGIN CERTIFICATE-----',
            privateKey: '-----BEGIN PRIVATE KEY-----',
            organizationId,
            serverId: carrier.serverId,
          })),
        );

        const refused = await servers
          .remove(ownerCtx, carrier.serverId)
          .then(() => null)
          .catch((error: Error) => error.message);

        expect(refused).toContain('12 services (');
        expect(refused).toContain('and 2 more)');
        expect(refused).toContain('12 configuration entries (');
        // The Services clause did not eat the configuration clause's budget:
        // ten certificates are still named, and no clause opens on a comma.
        expect(refused?.match(/certificate "cert-/g)).toHaveLength(10);
        expect(refused).not.toContain('(,');
      });
    });

    /**
     * The refusal is the one sentence an operator is guaranteed to read,
     * and until now nothing read it back: the guard's assertions (:246, :284) and
     * the wording fix's (:379, :423, :459) are all name and clause regexes, so
     * the wording fix rewrote the whole second half of the message — "each of
     * them" to "each one", the Project clause appended, the terminal period
     * dropped for §2.5, and the consequence sentence forked in two — with every
     * existing test still green. These three are whole-string equality on
     * purpose. A regex is what let it drift.
     *
     * The apostrophe in `Cloudgate’s` is U+2019 in `servers.service.ts`, so the
     * constants below spell it `’`: an editor that normalises it to ASCII
     * would otherwise fail these on a one-character diff jest cannot show.
     */
    describe('the exact wording of the refusal', () => {
      const CONSEQUENCE_SERVICES =
        'Deleting the Server would delete Cloudgate’s record of each one ' +
        'while the containers keep running, leaving nothing that says which ' +
        'Project they belonged to.';
      const CONSEQUENCE_CONFIGURATION =
        'Deleting the Server would delete Cloudgate’s record of each one, ' +
        'and nothing else records what they were.';
      const ACTION = 'Move or delete them first';

      /** The message `remove` refuses with, or a failure if it did not refuse. */
      async function refusal(
        ownerCtx: ReturnType<typeof permissionCtx>,
        serverId: string,
      ): Promise<string> {
        try {
          await servers.remove(ownerCtx, serverId);
        } catch (error) {
          return (error as Error).message;
        }
        throw new Error('the delete was not refused');
      }

      it('names one carried Service and states what deleting the Server would do to it', async () => {
        const { ownerCtx, sshKeyId } = await setUpOwnerWithKey();
        const environmentId = await setUpEnvironment(ownerCtx);
        const carrier = await servers.create(ownerCtx, {
          name: 'carrier',
          ipAddress: '203.0.113.40',
          port: 22,
          username: 'root',
          sshKeyId,
        });
        await applications.create(ownerCtx, {
          name: 'Web App',
          appName: 'web-app',
          environmentId,
          serverId: carrier.serverId,
        });

        expect(await refusal(ownerCtx, carrier.serverId)).toBe(
          'Server "carrier" still carries 1 service (application "Web App"). ' +
            `${CONSEQUENCE_SERVICES} ${ACTION}`,
        );
      });

      it('names one carried configuration entry and does not claim any container is running', async () => {
        const { organizationId, ownerCtx, carrier } = await setUpCarrier();
        await ctx.db.insert(certificate).values({
          name: 'wildcard.example.com',
          certificateData: '-----BEGIN CERTIFICATE-----',
          privateKey: '-----BEGIN PRIVATE KEY-----',
          organizationId,
          serverId: carrier.serverId,
        });

        expect(await refusal(ownerCtx, carrier.serverId)).toBe(
          'Server "carrier" still carries 1 configuration entry ' +
            '(certificate "wildcard.example.com"). ' +
            `${CONSEQUENCE_CONFIGURATION} ${ACTION}`,
        );
      });

      it('joins both categories with one Services consequence rather than a third sentence', async () => {
        const { organizationId, ownerCtx, carrier } = await setUpCarrier();
        const environmentId = await setUpEnvironment(ownerCtx);
        await applications.create(ownerCtx, {
          name: 'Web App',
          appName: 'web-app',
          environmentId,
          serverId: carrier.serverId,
        });
        await ctx.db.insert(certificate).values({
          name: 'wildcard.example.com',
          certificateData: '-----BEGIN CERTIFICATE-----',
          privateKey: '-----BEGIN PRIVATE KEY-----',
          organizationId,
          serverId: carrier.serverId,
        });

        // The mixed message takes the Services sentence deliberately:
        // it is accurate about the half that leaves containers behind, and a
        // fourth message is what this assertion exists to catch.
        expect(await refusal(ownerCtx, carrier.serverId)).toBe(
          'Server "carrier" still carries 1 service (application "Web App") ' +
            'and 1 configuration entry (certificate "wildcard.example.com"). ' +
            `${CONSEQUENCE_SERVICES} ${ACTION}`,
        );
      });

      it('carries no trailing period, which §2.5 forbids and the original guard had', async () => {
        const { organizationId, ownerCtx, carrier } = await setUpCarrier();
        await ctx.db.insert(certificate).values({
          name: 'wildcard.example.com',
          certificateData: '-----BEGIN CERTIFICATE-----',
          privateKey: '-----BEGIN PRIVATE KEY-----',
          organizationId,
          serverId: carrier.serverId,
        });

        const message = await refusal(ownerCtx, carrier.serverId);
        expect(message.endsWith('.')).toBe(false);
        expect(message).toMatch(/first$/);
      });
    });
  });

  describe('validate', () => {
    it('reports ok when the connectivity probe succeeds', async () => {
      const { ownerCtx, sshKeyId } = await setUpOwnerWithKey();
      const created = await servers.create(ownerCtx, {
        name: 'reachable',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId,
      });

      remoteExec.execAsyncRemote.mockResolvedValue(okExec);

      const result = await servers.validate(ownerCtx, created.serverId);
      expect(result).toEqual({ status: 'ok' });
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        created.serverId,
        expect.any(String),
      );
    });

    it('surfaces the SSH error when the probe fails', async () => {
      const { ownerCtx, sshKeyId } = await setUpOwnerWithKey();
      const created = await servers.create(ownerCtx, {
        name: 'unreachable',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId,
      });

      remoteExec.execAsyncRemote.mockRejectedValue(
        new ExecError('SSH connection error: connect ECONNREFUSED', {
          command: 'echo ok',
          serverId: created.serverId,
        }),
      );

      await expect(
        servers.validate(ownerCtx, created.serverId),
      ).rejects.toThrow(BadRequestException);
      await expect(
        servers.validate(ownerCtx, created.serverId),
      ).rejects.toThrow(/ECONNREFUSED/);
    });
  });

  describe('audit', () => {
    it('returns parsed docker/swarm readiness from the probe output', async () => {
      const { ownerCtx, sshKeyId } = await setUpOwnerWithKey();
      const created = await servers.create(ownerCtx, {
        name: 'audited',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId,
      });

      // What the readiness script prints on a docker+swarm-ready host.
      remoteExec.execAsyncRemote.mockResolvedValue({
        stdout:
          '{"docker": {"version": "28.5.0", "enabled": true}, ' +
          '"isSwarmActive": true, "isNetworkInstalled": true, ' +
          '"isMainDirectoryInstalled": false, ' +
          '"privilegeMode": "root", "isDockerGroupMember": false}\n',
        stderr: '',
        exitCode: 0,
      });

      const readiness = await servers.audit(ownerCtx, created.serverId);
      expect(readiness).toEqual({
        docker: { version: '28.5.0', enabled: true },
        isSwarmActive: true,
        isNetworkInstalled: true,
        isMainDirectoryInstalled: false,
        privilegeMode: 'root',
        isDockerGroupMember: false,
      });

      // The audit runs over the remote-exec seam against this server.
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        created.serverId,
        expect.stringContaining('docker'),
      );
    });

    it('surfaces a 400 when the probe output is not parseable', async () => {
      const { ownerCtx, sshKeyId } = await setUpOwnerWithKey();
      const created = await servers.create(ownerCtx, {
        name: 'garbled',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId,
      });

      remoteExec.execAsyncRemote.mockResolvedValue({
        stdout: 'bash: docker: command not found',
        stderr: '',
        exitCode: 0,
      });

      await expect(servers.audit(ownerCtx, created.serverId)).rejects.toThrow(
        BadRequestException,
      );
    });

    /**
     * **Every way the SSH session fails is an answer the console can word
     * ** The audit called `execAsyncRemote` with no `catch`, so each of
     * these reached the filter as a bare 500 journaled at error, and the
     * Infrastructure and Access cards said "The backend hit an error … so
     * nothing changed" about a read. The three rejections below are the three
     * shapes `RemoteExecService` produces for a session that never ran the
     * script, driven on a real Server in U03.
     */
    describe('a session that never ran the script', () => {
      /** Rejects the audit with `error` and answers what the route would. */
      async function auditRejectingWith(error: unknown) {
        const { ownerCtx, sshKeyId } = await setUpOwnerWithKey();
        const created = await servers.create(ownerCtx, {
          name: 'refusing',
          ipAddress: '127.0.0.1',
          port: 1,
          username: 'root',
          sshKeyId,
        });
        remoteExec.execAsyncRemote.mockRejectedValue(error);
        try {
          await servers.audit(ownerCtx, created.serverId);
        } catch (caught) {
          if (!(caught instanceof HttpException)) throw caught;
          return {
            status: caught.getStatus(),
            body: caught.getResponse() as { message?: string; code?: string },
          };
        }
        throw new Error('the audit did not refuse');
      }

      it('answers 503 HOST_UNREACHABLE for a refused connection', async () => {
        const refused = await auditRejectingWith(
          new ExecError(
            'SSH connection error: connect ECONNREFUSED 127.0.0.1:1',
            {
              command: 'audit',
            },
          ),
        );
        expect(refused).toEqual({
          status: 503,
          body: {
            message: 'This Server could not be reached',
            code: 'HOST_UNREACHABLE',
          },
        });
      });

      it('answers 400 naming the key when the Server does not accept it', async () => {
        const refused = await auditRejectingWith(
          new ExecError(
            'Authentication failed: the SSH key was not accepted by the server. (All configured authentication methods failed)',
            {
              command: 'audit',
              originalError: Object.assign(
                new Error('All configured authentication methods failed'),
                { level: 'client-authentication' },
              ),
            },
          ),
        );
        expect(refused.status).toBe(400);
        expect(refused.body.message).toMatch(
          /^The SSH key "server-key" was not accepted by this Server/,
        );
        // §1.1: the operator is told about a Server, never a "host".
        expect(refused.body.message).toContain(
          '~/.ssh/authorized_keys for root on the Server',
        );
        expect(refused.body.message).not.toMatch(/\bhost\b/i);
        expect(refused.body.code).toBeUndefined();
      });

      it('answers 400 naming the key when its private half cannot be read', async () => {
        // Not an `ExecError`: ssh2's `connect` throws this synchronously inside
        // `execAsyncRemote`'s promise executor, before any session exists.
        const refused = await auditRejectingWith(
          new Error('Cannot parse privateKey: Malformed OpenSSH private key'),
        );
        expect(refused.status).toBe(400);
        expect(refused.body.message).toMatch(
          /^The SSH key "server-key" could not be read/,
        );
        expect(refused.body.message).not.toMatch(/\bhost\b/i);
      });

      it('publishes the 503 and its code on the wire', async () => {
        const { ownerSession, sshKeyId } = await setUpOwnerWithKey();
        const created = await request(server)
          .post('/servers')
          .set('Cookie', ownerSession.cookie)
          .send({
            name: 'unreachable-wire',
            ipAddress: '127.0.0.1',
            port: 1,
            username: 'root',
            sshKeyId,
          });
        const id = (created.body as { serverId: string }).serverId;
        remoteExec.execAsyncRemote.mockRejectedValue(
          new ExecError(
            'SSH connection error: connect ECONNREFUSED 127.0.0.1:1',
            {
              command: 'audit',
            },
          ),
        );

        const audited = await request(server)
          .get(`/servers/${id}/audit`)
          .set('Cookie', ownerSession.cookie);
        expect(audited.status).toBe(503);
        expect(audited.body).toMatchObject({
          message: 'This Server could not be reached',
          code: 'HOST_UNREACHABLE',
        });
      });
    });
  });

  describe('setup', () => {
    it('issues the install/init sequence: docker → swarm → network → directory → traefik', async () => {
      const { ownerCtx, sshKeyId } = await setUpOwnerWithKey();
      const created = await servers.create(ownerCtx, {
        name: 'fresh',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId,
      });

      remoteExec.execAsyncRemote.mockResolvedValue(okExec);

      await servers.setup(ownerCtx, created.serverId);

      // The script, then the read-back of the traefik.yml it left (ADR-0027).
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledTimes(2);
      expect(remoteExec.execAsyncRemote.mock.calls[1]?.[1]).toBe(
        'cat /etc/cloudgate/traefik/traefik.yml',
      );
      const [targetServerId, command] = remoteExec.execAsyncRemote.mock
        .calls[0] as [string, string];
      expect(targetServerId).toBe(created.serverId);

      // The default setup script installs Docker, initializes Swarm, creates
      // the overlay network and platform directory, and starts Traefik —
      // in that order.
      const steps = [
        'get.docker.com',
        'docker swarm init',
        'docker network create --driver overlay --attachable cloudgate-network',
        'mkdir -p /etc/cloudgate',
        'docker run -d',
        '--name cloudgate-traefik',
      ];
      const positions = steps.map((step) => command.indexOf(step));
      expect(positions).not.toContain(-1);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });

    /**
     * ADR-0027: a new Server keeps request counters from the start, and its
     * Server read says so. The state comes from the file the script left, not
     * from having run it — the script skips a traefik.yml that is already there.
     */
    describe('request-metrics state after setup', () => {
      /** The traefik.yml the default script writes, as its heredoc. */
      const generatedTraefikYml = () => {
        const body = serverSetupCommand().match(
          /<<'TRAEFIK_EOF'\n([\s\S]*?)\nTRAEFIK_EOF\n/,
        )?.[1];
        if (!body) throw new Error('no TRAEFIK_EOF heredoc');
        return body;
      };

      async function setUpWithTraefikYml(traefikYml: string | Error) {
        const { ownerCtx, sshKeyId } = await setUpOwnerWithKey();
        const created = await servers.create(ownerCtx, {
          name: 'metrics',
          ipAddress: '203.0.113.10',
          port: 22,
          username: 'root',
          sshKeyId,
        });
        expect(created.requestMetricsEnabled).toBe(false);
        remoteExec.execAsyncRemote.mockImplementation((_id, command) =>
          command.startsWith('cat ')
            ? traefikYml instanceof Error
              ? Promise.reject(traefikYml)
              : Promise.resolve({ ...okExec, stdout: traefikYml })
            : Promise.resolve(okExec),
        );
        await servers.setup(ownerCtx, created.serverId);
        return servers.findOne(ownerCtx, created.serverId);
      }

      it('reads enabled on a Server the script wrote traefik.yml on', async () => {
        const read = await setUpWithTraefikYml(generatedTraefikYml());
        expect(read.requestMetricsEnabled).toBe(true);
      });

      it('reads not enabled on a Server whose older traefik.yml the script kept', async () => {
        const read = await setUpWithTraefikYml(
          'entryPoints:\n  web:\n    address: ":80"\n',
        );
        expect(read.requestMetricsEnabled).toBe(false);
      });

      it('leaves the state alone, and the setup succeeded, when the read-back fails', async () => {
        const read = await setUpWithTraefikYml(new Error('connection reset'));
        expect(read.requestMetricsEnabled).toBe(false);
      });
    });

    it('prefers the server’s stored custom command over the default script', async () => {
      const { ownerCtx, sshKeyId } = await setUpOwnerWithKey();
      const created = await servers.create(ownerCtx, {
        name: 'custom',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId,
      });
      await servers.update(ownerCtx, created.serverId, {
        command: 'echo custom-setup',
      });

      remoteExec.execAsyncRemote.mockResolvedValue(okExec);

      await servers.setup(ownerCtx, created.serverId);

      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        created.serverId,
        'echo custom-setup',
        undefined,
      );
    });
  });

  describe('server key provider (SSH connection resolution)', () => {
    it('resolves host/port/username and the decrypted private key by serverId', async () => {
      const { ownerCtx } = await setUpOwnerWithKey();
      const key = await sshKeys.create(ownerCtx, {
        name: 'conn-key',
        publicKey: 'ssh-ed25519 AAAAfakepub test',
        privateKey:
          '-----BEGIN OPENSSH PRIVATE KEY-----\nconn-material\n-----END OPENSSH PRIVATE KEY-----\n',
      });
      const created = await servers.create(ownerCtx, {
        name: 'connectable',
        ipAddress: '203.0.113.77',
        port: 2222,
        username: 'deploy',
        sshKeyId: key.sshKeyId,
      });

      const provider = ctx.app.get<ServerKeyProvider>(SERVER_KEY_PROVIDER);
      const { hostKey, ...connection } = await provider.getConnection(
        created.serverId,
      );
      // Its host key is checked by trust on first use (ADR-0074;
      // `server-host-key.e2e-spec.ts` covers what that does).
      expect(typeof hostKey.verifier).toBe('function');
      expect(connection).toEqual({
        host: '203.0.113.77',
        port: 2222,
        username: 'deploy',
        privateKey:
          '-----BEGIN OPENSSH PRIVATE KEY-----\nconn-material\n-----END OPENSSH PRIVATE KEY-----\n',
      });
    });

    it('rejects a server with no SSH key assigned', async () => {
      const { ownerCtx, sshKeyId } = await setUpOwnerWithKey();
      const created = await servers.create(ownerCtx, {
        name: 'keyless',
        ipAddress: '203.0.113.78',
        port: 22,
        username: 'root',
        sshKeyId,
      });
      await sshKeys.remove(ownerCtx, sshKeyId);

      const provider = ctx.app.get<ServerKeyProvider>(SERVER_KEY_PROVIDER);
      await expect(provider.getConnection(created.serverId)).rejects.toThrow(
        /SSH key/i,
      );
    });
  });

  describe('HTTP endpoint surface', () => {
    it('supports CRUD plus validate/audit/setup over HTTP', async () => {
      const { ownerSession, sshKeyId } = await setUpOwnerWithKey();
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/servers')
        .set('Cookie', cookie)
        .send({
          name: 'http-server',
          ipAddress: '203.0.113.20',
          port: 22,
          username: 'root',
          sshKeyId,
        });
      expect(created.status).toBe(201);
      const id = (created.body as { serverId: string }).serverId;

      const listed = await request(server)
        .get('/servers')
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect((listed.body as { name: string }[]).map((s) => s.name)).toEqual([
        'http-server',
      ]);

      const one = await request(server)
        .get(`/servers/${id}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        name: 'http-server',
        serverStatus: 'active',
      });

      const patched = await request(server)
        .patch(`/servers/${id}`)
        .set('Cookie', cookie)
        .send({ description: 'renamed over http' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        name: 'http-server',
        description: 'renamed over http',
      });

      remoteExec.execAsyncRemote.mockResolvedValue(okExec);
      const validated = await request(server)
        .get(`/servers/${id}/validate`)
        .set('Cookie', cookie);
      expect(validated.status).toBe(200);
      expect(validated.body).toEqual({ status: 'ok' });

      remoteExec.execAsyncRemote.mockResolvedValue({
        stdout:
          '{"docker": {"version": "28.5.0", "enabled": true}, "isSwarmActive": false, "isNetworkInstalled": false, "isMainDirectoryInstalled": false, "privilegeMode": "root", "isDockerGroupMember": false}',
        stderr: '',
        exitCode: 0,
      });
      const audited = await request(server)
        .get(`/servers/${id}/audit`)
        .set('Cookie', cookie);
      expect(audited.status).toBe(200);
      expect(audited.body).toMatchObject({
        docker: { version: '28.5.0', enabled: true },
        isSwarmActive: false,
      });

      remoteExec.execAsyncRemote.mockResolvedValue(okExec);
      const setup = await request(server)
        .post(`/servers/${id}/setup`)
        .set('Cookie', cookie);
      expect(setup.status).toBe(200);
      expect(setup.body).toEqual({ status: 'ok' });

      const removed = await request(server)
        .delete(`/servers/${id}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/servers/${id}`)
        .set('Cookie', cookie);
      expect(gone.status).toBe(404);
    });
  });

  describe('cross-org isolation', () => {
    it('a server is invisible and unremovable outside its own organization', async () => {
      const { organizationId, ownerSession } = await setUpOwnerWithKey();

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);
      const foreignKey = await sshKeys.create(secondOrgCtx, {
        name: 'org-b-key',
      });
      const foreign = await servers.create(secondOrgCtx, {
        name: 'org-b-only',
        ipAddress: '203.0.113.50',
        port: 22,
        username: 'root',
        sshKeyId: foreignKey.sshKeyId,
      });

      // Same user, but acting in the first organization: the server from the
      // second organization must not resolve, even for its creator.
      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        servers.findOne(firstOrgCtx, foreign.serverId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        servers.update(firstOrgCtx, foreign.serverId, { name: 'stolen' }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        servers.remove(firstOrgCtx, foreign.serverId),
      ).rejects.toThrow(NotFoundException);
      expect(await servers.list(firstOrgCtx)).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({ serverId: foreign.serverId }),
        ]),
      );
    });
  });

  describe('create → findOne', () => {
    it('stores a server retrievable by id, active and deploy-type by default', async () => {
      const { organizationId, ownerCtx, sshKeyId } = await setUpOwnerWithKey();

      const created = await servers.create(ownerCtx, {
        name: 'hetzner-1',
        description: 'primary deploy target',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId,
      });

      expect(created.serverId).toEqual(expect.any(String));
      expect(created.organizationId).toBe(organizationId);

      const found = await servers.findOne(ownerCtx, created.serverId);
      expect(found).toMatchObject({
        serverId: created.serverId,
        name: 'hetzner-1',
        description: 'primary deploy target',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId,
        organizationId,
        // The schema defaults: a new server is active and a deploy target.
        serverStatus: 'active',
        serverType: 'deploy',
      });
    });
  });
});
