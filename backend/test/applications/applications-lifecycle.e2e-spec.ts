import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import {
  application as applicationTable,
  server as serverTable,
} from '../../src/db/schema';
import {
  applicationsDirectoryOn,
  deploymentLogsDirectoryOn,
  fileMountsDirectoryOnRunServer,
} from '../../src/deployment-engine/deployment-engine.paths';
import { DomainsService } from '../../src/domains/domains.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
/**
 * The presence read Delete issues and the discriminator this file's exec
 * mock recognises it by. Hand-written, and imported from `test/utils/` rather
 * than from `application-ops.ts`, for the reason that file's docblock gives:
 * importing the product's builder would make this suite agree with whatever the
 * builder says, and the shell trick these commands turn on — exit 0 either way,
 * the answer on stdout — is exactly the thing a "simplification" would quietly
 * drop.
 *
 * **Why one copy for the tree rather than this file's own.** This file used to
 * hold its own. H-95 changed the shape — `<question> && echo present || echo
 * absent` became `if ! <daemon>; then echo unknown; elif <question>; …`, so a
 * stopped daemon on a reachable Server stops reading as `absent` — and updated
 * the builder and its unit spec but not this copy. `isPresenceProbe` then
 * matched nothing, every probe answered `''`, `readWorkloadPresence` read that
 * as `'unknown'`, and **three deletes in this file 409'd** (H-104), one of nine
 * suites it happened to. Independence from `src` is the property that earned
 * the copy its keep, and one copy preserves it exactly while making the next
 * shape change one file's edit rather than ten. Still run this file when
 * the probe changes — the unit spec passing is not evidence that this one does
 * — and the set-level guard in `test/common/workload-presence.spec.ts` is what
 * fails if the copy goes stale or an eleventh appears.
 */
import {
  isPresenceProbe,
  servicePresenceProbe,
} from '../utils/workload-presence-probe';
import { buildLeftoverReclamation } from '../../src/builders/build-leftovers';
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

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/**
 * the lifecycle routes an Application was missing while every
 * managed database engine had them — start, stop, reload, and the rotation of
 * the secret in its deploy-webhook URL.
 *
 * The seam is the HTTP surface plus the exec layer: what the routes are
 * observed to do is the swarm command they issue on the Application's server
 * and the row they leave behind, which is exactly what the database lifecycle
 * specs assert about `docker service scale`.
 *
 * That command is argv, and `withArgvExec` words it the way
 * `execRemote` does so the assertions still read one command string. The `\=` in
 * the scaled word below is `shell-quote` escaping the `=`; the shell strips it
 * before `docker` sees it, and the emitted spelling is asserted here rather than
 * parsed because the whole command is a fixed three words.
 */
describe('Application lifecycle (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let domains: DomainsService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<typeof ok>, [string]>(),
    execAsyncRemote: jest.fn<Promise<typeof ok>, [string, string]>(),
  });
  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
    writeCertificate: jest.fn(),
    removeCertificate: jest.fn(),
  };

  /**
   * The exec layer as Delete sees it by default: every command succeeds and the
   * presence read says the swarm service is gone, which is the happy path. A
   * `mockResolvedValue(ok)` would leave the probe answering an empty stdout —
   * `'unknown'`, deliberately, since a shell that never ran the command is no
   * more "gone" than a rejection is — and every delete here would 409.
   */
  const teardownSucceeds = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command) ? { ...ok, stdout: 'absent' } : ok,
    );

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: TraefikWriterService, useValue: traefikWriterMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    domains = ctx.app.get(DomainsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    execMock.execAsync.mockImplementation(teardownSucceeds);
    execMock.execAsyncRemote.mockImplementation((_serverId, command) =>
      teardownSucceeds(command),
    );
    traefikWriterMock.removeConfig.mockResolvedValue(undefined);
    traefikWriterMock.writeConfig.mockResolvedValue(undefined);
    traefikWriterMock.loadOrCreateConfig.mockResolvedValue({
      http: { routers: {}, services: {} },
    });
  });

  /** An owner with a project, an environment and one Application in it. */
  async function setUpApplication(appName = 'web-app') {
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
    const created = await applications.create(ownerCtx, {
      name: 'Web App',
      appName,
      environmentId: environment.environmentId,
    });

    return { ownerSession, organizationId, ownerCtx, environment, created };
  }

  it('starting an Application scales its swarm service up and marks it done', async () => {
    const { ownerSession, created } = await setUpApplication();

    const res = await request(server)
      .post(`/applications/${created.applicationId}/start`)
      .set('Cookie', ownerSession.cookie);

    expect(res.status).toBe(200);
    expect(execMock.execAsync).toHaveBeenCalledWith(
      'docker service scale web-app\\=1',
    );
    expect(res.body).toMatchObject({
      applicationId: created.applicationId,
      applicationStatus: 'done',
    });
  });

  it('stopping an Application scales its swarm service to zero and marks it stopped, which a never-deployed row cannot be', async () => {
    const { ownerSession, ownerCtx, created } = await setUpApplication();
    // The control, read off the created row rather than spelled as a literal:
    // the property is that the two are not the same word, and a test that
    // wrote `'idle'` twice would still pass if the column's default moved onto
    // the stop status and collapsed them again (as for databases).
    expect(created.applicationStatus).toBe('idle');

    const res = await request(server)
      .post(`/applications/${created.applicationId}/stop`)
      .set('Cookie', ownerSession.cookie);

    expect(res.status).toBe(200);
    expect(execMock.execAsync).toHaveBeenCalledWith(
      'docker service scale web-app\\=0',
    );
    expect(res.body).toMatchObject({ applicationStatus: 'stopped' });
    // And a reload says it again: the row is the only thing that survives one.
    const found = await applications.findOne(ownerCtx, created.applicationId);
    expect(found.applicationStatus).toBe('stopped');
    expect(found.applicationStatus).not.toBe(created.applicationStatus);
  });

  it('reloading an Application takes it down and back up without building', async () => {
    const { ownerSession, created } = await setUpApplication();

    const res = await request(server)
      .post(`/applications/${created.applicationId}/reload`)
      .set('Cookie', ownerSession.cookie);

    expect(res.status).toBe(200);
    // Down then up, in that order: the task is recreated on the current spec,
    // and nothing is cloned, built or pushed.
    expect(execMock.execAsync.mock.calls.map((call) => call[0])).toEqual([
      'docker service scale web-app\\=0',
      'docker service scale web-app\\=1',
    ]);
    expect(res.body).toMatchObject({ applicationStatus: 'done' });
  });

  /**
   * A Restart is a Stop and a Start, and the Stop half writes what Stop writes.
   * The status between the two scales is the row's only record that
   * the service went to zero, so a scale back up that fails leaves the row
   * saying `stopped` over a service at 0 — not the never-deployed `idle` it
   * used to, and not the `done` of a Restart that did not finish.
   */
  it('a Restart whose scale back up fails leaves the Application stopped, not idle', async () => {
    const { ownerSession, ownerCtx, created } = await setUpApplication();
    execMock.execAsync.mockImplementation((command: string) => {
      if (command === 'docker service scale web-app\\=1') {
        return Promise.reject(
          Object.assign(new Error('Command execution failed'), {
            stderr: 'web-app: Error response from daemon: rpc error',
            exitCode: 1,
          }),
        );
      }
      if (command === servicePresenceProbe('web-app')) {
        return Promise.resolve({ ...ok, stdout: 'present\n' });
      }
      return Promise.resolve(ok);
    });

    const res = await request(server)
      .post(`/applications/${created.applicationId}/reload`)
      .set('Cookie', ownerSession.cookie);

    expect(res.status).toBe(500);
    const found = await applications.findOne(ownerCtx, created.applicationId);
    expect(found.applicationStatus).toBe('stopped');
  });

  it('runs the swarm command over SSH when the Application runs on a remote server', async () => {
    const { ownerSession, organizationId, created } = await setUpApplication();
    const [remote] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'edge-1',
        ipAddress: '10.0.0.9',
        port: 22,
        username: 'root',
        organizationId,
      })
      .returning();
    await ctx.db
      .update(applicationTable)
      .set({ serverId: remote.serverId })
      .where(eq(applicationTable.applicationId, created.applicationId));

    const res = await request(server)
      .post(`/applications/${created.applicationId}/start`)
      .set('Cookie', ownerSession.cookie);

    expect(res.status).toBe(200);
    expect(execMock.execAsync).not.toHaveBeenCalled();
    expect(execMock.execAsyncRemote).toHaveBeenCalledWith(
      remote.serverId,
      'docker service scale web-app\\=1',
    );
  });

  /**
   * An Application whose only Deployment failed has no Swarm service, and
   * `docker service scale` on it exits "service … not found". That used to
   * surface as an unhandled ExecError — a 500 the console reported as "the
   * request did not come back … may still be running", about a request that
   * came back at once with nothing running. The presence read that Delete
   * already issues is what tells "no service" from any other failure.
   */
  describe('with no Swarm service to scale', () => {
    const notFound = Object.assign(new Error('Command execution failed'), {
      stderr: 'web-app: Error response from daemon: service web-app not found',
      exitCode: 1,
    });
    const scaleFails =
      (presence: 'absent' | 'present') => (command: string) => {
        if (command.startsWith('docker service scale ')) {
          return Promise.reject(notFound);
        }
        if (command === servicePresenceProbe('web-app')) {
          return Promise.resolve({ ...ok, stdout: `${presence}\n` });
        }
        return Promise.resolve(ok);
      };

    it.each([
      ['start', 'start'],
      ['stop', 'stop'],
      ['reload', 'restart'],
    ])(
      '%s answers 409 naming the missing service and leaves the status alone',
      async (route, verb) => {
        const { ownerSession, created } = await setUpApplication();
        await ctx.db
          .update(applicationTable)
          .set({ applicationStatus: 'error' })
          .where(eq(applicationTable.applicationId, created.applicationId));
        execMock.execAsync.mockImplementation(scaleFails('absent'));

        const res = await request(server)
          .post(`/applications/${created.applicationId}/${route}`)
          .set('Cookie', ownerSession.cookie);

        expect(res.status).toBe(409);
        const { message } = res.body as { message: string };
        expect(message).toContain("Swarm service 'web-app'");
        expect(message).toContain(`to ${verb}`);
        expect(message).not.toMatch(/\.$/);
        // Nothing ran, so nothing is reported as having changed: the row keeps
        // the `error` its failed Deployment wrote.
        const [found] = await ctx.db
          .select()
          .from(applicationTable)
          .where(eq(applicationTable.applicationId, created.applicationId));
        expect(found.applicationStatus).toBe('error');
      },
    );

    it('still fails as it did when the service is there and the scale failed for another reason', async () => {
      const { ownerSession, created } = await setUpApplication();
      execMock.execAsync.mockImplementation(scaleFails('present'));

      const res = await request(server)
        .post(`/applications/${created.applicationId}/stop`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(500);
    });
  });

  it('rotating the deploy-webhook secret replaces the token with a new one', async () => {
    const { ownerSession, ownerCtx, created } = await setUpApplication();
    // The column defaults through $defaultFn(nanoid), so there is one to lose.
    expect(created.refreshToken).toBeTruthy();

    const res = await request(server)
      .post(`/applications/${created.applicationId}/refresh-token`)
      .set('Cookie', ownerSession.cookie);

    expect(res.status).toBe(200);
    const rotated = (res.body as { refreshToken: string }).refreshToken;
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(created.refreshToken);
    // The leaked URL is dead: the row itself holds only the new secret.
    const found = await applications.findOne(ownerCtx, created.applicationId);
    expect(found.refreshToken).toBe(rotated);
    // Rotation is not a redeploy — nothing was scaled or built.
    expect(execMock.execAsync).not.toHaveBeenCalled();
  });

  it('stores the deploy-webhook secret encrypted at rest, minted and rotated', async () => {
    const { ownerSession, ownerCtx, created } = await setUpApplication();

    // Both writes: the `$defaultFn(nanoid)` mint on insert, and the explicit
    // `.set()` in `ApplicationsService.refreshToken`. The mint is the half
    // worth naming — a default generated in JS still has to travel through the
    // column's `toDriver`, and nothing else in the schema encrypts a defaulted
    // column, so this is the only place that says it does.
    const mintedRaw = await ctx.db.$client.query<{ refresh_token: string }>(
      'select refresh_token from application where application_id = $1',
      [created.applicationId],
    );
    expect(mintedRaw.rows[0].refresh_token).not.toBe(created.refreshToken);
    expect(mintedRaw.rows[0].refresh_token.startsWith('enc:v1:')).toBe(true);

    const res = await request(server)
      .post(`/applications/${created.applicationId}/refresh-token`)
      .set('Cookie', ownerSession.cookie);
    const rotated = (res.body as { refreshToken: string }).refreshToken;

    const rotatedRaw = await ctx.db.$client.query<{ refresh_token: string }>(
      'select refresh_token from application where application_id = $1',
      [created.applicationId],
    );
    expect(rotatedRaw.rows[0].refresh_token).not.toBe(rotated);
    expect(rotatedRaw.rows[0].refresh_token.startsWith('enc:v1:')).toBe(true);

    // Decrypt on read is what lets the console keep printing it: the rotate
    // dialog shows the value the route hands back, and the facts card gates its
    // Rotate action on the column being truthy.
    const found = await applications.findOne(ownerCtx, created.applicationId);
    expect(found.refreshToken).toBe(rotated);
  });

  it('reads back a webhook secret written before the column was encrypted', async () => {
    const { ownerCtx, created } = await setUpApplication();

    // The claim an earlier change declined to ship a backfill on, asserted rather than
    // quoted: ADR 0006 passes a value with no `enc:v1:` prefix through on read,
    // so an install that upgrades keeps every webhook URL its operator has
    // already configured. Written with raw SQL because there is deliberately no
    // longer a path through the ORM that puts cleartext in this column.
    await ctx.db.$client.query(
      'update application set refresh_token = $1 where application_id = $2',
      ['legacy-plaintext-secret', created.applicationId],
    );

    const found = await applications.findOne(ownerCtx, created.applicationId);
    expect(found.refreshToken).toBe('legacy-plaintext-secret');
  });

  it('every lifecycle route reads as absent from another organization', async () => {
    const { ownerSession, created } = await setUpApplication();

    // A second organization for the same owner: a second sign-up in one spec
    // returns 400, so the isolation case travels through POST /organizations.
    const secondOrg = await createOrganization(
      server,
      ctx.db,
      ownerSession.cookie,
      { name: 'Second Org' },
    );
    expect(secondOrg.status).toBe(201);
    const activated = await request(server)
      .post('/api/auth/organization/set-active')
      .set('Cookie', ownerSession.cookie)
      .send({ organizationId: (secondOrg.body as { id: string }).id });
    expect(activated.status).toBe(200);

    // Thunks, not a promise array: each route is asked in turn so a failure
    // names the route that answered wrongly.
    for (const route of ['start', 'stop', 'reload', 'refresh-token']) {
      const res = await request(server)
        .post(`/applications/${created.applicationId}/${route}`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ message: 'Application not found' });
    }
    // DELETE too, since it now reaches the exec layer: the gate is
    // `checkServiceAccess(..., 'delete')` and it stays first, before any
    // command. A route that tore down and *then* refused would be a way to make
    // Docker calls you are not entitled to.
    const deleted = await request(server)
      .delete(`/applications/${created.applicationId}`)
      .set('Cookie', ownerSession.cookie);
    expect(deleted.status).toBe(404);
    expect(deleted.body).toMatchObject({ message: 'Application not found' });

    // Nothing was scaled or torn down on the way to being refused.
    expect(execMock.execAsync).not.toHaveBeenCalled();
    expect(traefikWriterMock.removeConfig).not.toHaveBeenCalled();
  });

  /**
   * `remove` used to be `db.delete(application)` and nothing else, behind
   * a docblock deferring the runtime cleanup to a phase that had already
   * arrived. The row is the only handle the product has on the workload, so a
   * delete that dropped it while the swarm service still ran left a container
   * no console screen and no API route could reach — and, per ADR-0008,
   * unmanaged, hence readable and actable by every organization holding
   * `docker:read`.
   *
   * The two assertions that stand in for the filed observation (`docker service
   * ls` still listing `w10-gw 1/1` while `GET` answered 404) are the pair in
   * 'refuses the delete': the row is still there, and the route still answers
   * 200 for it.
   */
  describe('delete', () => {
    /**
     * The `code` half of an Application's tree, **asked of the machine the
     * assertion is about** rather than of this process.
     *
     * It took a `null` for both call sites below until the fix. That is right for
     * the local delete and wrong for the remote one, and the suite could not
     * tell the difference because it leaves `CLOUDGATE_DIRECTORY` unset, which
     * makes the platform host's root and a Server's `/etc/cloudgate` the same
     * literal — the coincidence ADR-0018 exists for, and the sixth time this
     * batch was bitten by it.
     *
     * **There is no gate on this yet, and here is why not.** The check
     * that would hold it is not a census but the falsifying run itself: set
     * `CLOUDGATE_DIRECTORY` to anything but the default and a suite that
     * confuses the two roots reds by construction. Measured across the 32
     * root-touching e2e suites, that reds **13 of them, 44 tests** — all of
     * them tests hardcoding `/etc/cloudgate` or resolving with `null`, none of
     * them a product defect, because `platform-root-call-sites.spec.ts`
     * already holds `src/`. So the gate is one line of setup behind 44
     * assertions of work, and that is separate work.
     */
    const codeDirectory = (appName: string, serverId: string | null) =>
      `${applicationsDirectoryOn(serverId)}/${appName}`;

    it('tears the swarm service, the Traefik config and the directory down before the row', async () => {
      const { ownerSession, created } = await setUpApplication();

      const res = await request(server)
        .delete(`/applications/${created.applicationId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      expect(execMock.execAsync).toHaveBeenCalledWith(
        'docker service rm web-app',
      );
      expect(execMock.execAsync).toHaveBeenCalledWith(
        `rm -rf ${codeDirectory('web-app', null)}`,
      );
      expect(traefikWriterMock.removeConfig).toHaveBeenCalledWith(
        'web-app',
        null,
      );
      // Nothing to report: the service was confirmed gone.
      expect(res.body).not.toHaveProperty('orphaned');

      const rows = await ctx.db
        .select()
        .from(applicationTable)
        .where(eq(applicationTable.applicationId, created.applicationId));
      expect(rows).toHaveLength(0);
    });

    it('refuses the delete and keeps the row when the swarm service is still there', async () => {
      const { ownerSession, created } = await setUpApplication();
      execMock.execAsync.mockImplementation((command) => {
        if (command === 'docker service rm web-app') {
          return Promise.reject(new Error('service removal failed'));
        }
        if (command === servicePresenceProbe('web-app')) {
          return Promise.resolve({ ...ok, stdout: 'present\n' });
        }
        return Promise.resolve(ok);
      });

      const res = await request(server)
        .delete(`/applications/${created.applicationId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toContain('web-app');

      // The two facts the verification host measured, from the two directions
      // a test can reach: the workload is still there, and so is the record
      // that names it — which is the whole point, because without the record
      // nothing in the product can address the workload again.
      const rows = await ctx.db
        .select()
        .from(applicationTable)
        .where(eq(applicationTable.applicationId, created.applicationId));
      expect(rows).toHaveLength(1);

      const found = await request(server)
        .get(`/applications/${created.applicationId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
    });

    it('refuses when the Server cannot be reached, and force deletes while reporting what was left', async () => {
      const { ownerSession, created } = await setUpApplication();
      execMock.execAsync.mockRejectedValue(new Error('ssh: connect refused'));

      const refused = await request(server)
        .delete(`/applications/${created.applicationId}`)
        .set('Cookie', ownerSession.cookie);
      expect(refused.status).toBe(409);
      // 'unknown', not 'gone': an unreachable daemon is the case where treating
      // a failure as absence is what manufactures the orphan.
      expect((refused.body as { message: string }).message).toContain(
        '?force=true',
      );
      expect(
        await ctx.db
          .select()
          .from(applicationTable)
          .where(eq(applicationTable.applicationId, created.applicationId)),
      ).toHaveLength(1);

      const forced = await request(server)
        .delete(`/applications/${created.applicationId}?force=true`)
        .set('Cookie', ownerSession.cookie);
      expect(forced.status).toBe(200);
      // The answer says what was left behind rather than a bare 200.
      expect(forced.body).toMatchObject({
        orphaned: { appName: 'web-app', serverId: null, reason: 'unknown' },
      });
      expect(
        await ctx.db
          .select()
          .from(applicationTable)
          .where(eq(applicationTable.applicationId, created.applicationId)),
      ).toHaveLength(0);
    });

    it('removes the Traefik config for an Application that still has a domain', async () => {
      const { ownerSession, ownerCtx, created } = await setUpApplication();
      await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: created.applicationId,
      });
      jest.clearAllMocks();
      execMock.execAsync.mockImplementation(teardownSucceeds);

      const res = await request(server)
        .delete(`/applications/${created.applicationId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      // `domain.applicationId` cascades, so the domain rows go with the row —
      // but the dynamic-config file they generated does not, and nothing else
      // in the delete path would have removed it. Without this the hostname
      // stays routed at a service that is gone.
      expect(traefikWriterMock.removeConfig).toHaveBeenCalledWith(
        'web-app',
        null,
      );
      expect(traefikWriterMock.writeConfig).not.toHaveBeenCalled();
    });

    it('runs every teardown command and the presence read on the Application’s own server', async () => {
      const { ownerSession, organizationId, created } =
        await setUpApplication();
      const [remote] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'edge-1',
          ipAddress: '10.0.0.9',
          port: 22,
          username: 'root',
          organizationId,
        })
        .returning();
      await ctx.db
        .update(applicationTable)
        .set({ serverId: remote.serverId })
        .where(eq(applicationTable.applicationId, created.applicationId));

      const res = await request(server)
        .delete(`/applications/${created.applicationId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      // Not one command on this machine. Reading one machine's daemon to
      // authorize a delete on another is what ADR-0008's "labels are read on
      // the machine being addressed" bullet forbids, and the presence read is
      // the easiest place in application-ops.ts to get that wrong.
      expect(execMock.execAsync).not.toHaveBeenCalled();
      // The order is the contract, not an artifact of the list: the two
      // teardown steps, then the presence read that decides whether the row may
      // go, and only then the reclamations — the built image, the leftovers a
      // killed build left behind, and the patch-repo clone, all *after* the
      // refusal, because untagging the image the Swarm service is running
      // or wiping `ensureRepo`'s cache would break an Application
      // the caller may still be told it kept. The leftover sweep is after the
      // refusal for a weaker reason than the other two and it is worth naming:
      // nothing it removes is in use, so a run ahead of the refusal would be
      // harmless rather than wrong — it sits here because a delete that refuses
      // should reach no machine at all.
      //
      // The leftover program is asked for rather than spelled: it is one shell
      // program built from `BUILD_NONCE_LENGTH` wildcards, and a copy here
      // would be a second statement of the length rule that keeps `web-2`'s
      // artifacts out of `web`'s sweep.
      //
      // The image's `:` (and the format's braces) are backslashed because `execRemote` joins its argv with
      // `quote()` and this list is the string half of the double; the
      // words themselves are asserted as argv in
      // `application-delete-machines.e2e-spec.ts`.
      //
      // The file-mounts tree is last and is the only reclamation aimed at the
      // **run** Server rather than the build host — invisible in this
      // list, which is one machine, and asserted as a machine in
      // `application-delete-machines.e2e-spec.ts`. Its path is asked of
      // `fileMountsDirectoryOnRunServer` rather than spelled, so this cannot
      // agree with a removal that names a tree `MountsService` does not write.
      // It shares the post-refusal slot for the sharpest of the three reasons:
      // nothing re-materializes a file mount, so an early removal would leave a
      // kept Application without the config files it is still running on.
      expect(
        execMock.execAsyncRemote.mock.calls.map((call) => call[1]),
      ).toEqual([
        'docker service rm web-app',
        servicePresenceProbe('web-app'),
        // The image's id first, to follow it once its tag is gone (#1415).
        'docker image inspect --format \\{\\{.Id\\}\\} web-app\\:latest',
        'docker image rm web-app\\:latest --force',
        buildLeftoverReclamation('web-app'),
        'rm -rf /etc/cloudgate/patch-repos/application/web-app',
        `rm -rf ${fileMountsDirectoryOnRunServer(remote.serverId, 'web-app')}`,
        // The Application's directory after the refusal too, and after the
        // file mounts it is the parent of: on this one-Server install
        // an `rm -rf` ahead of the presence read took the `files` and `traces`
        // of an Application the caller was then told still exists.
        `rm -rf ${codeDirectory('web-app', remote.serverId)}`,
        // The deployment logs, last, on the build host — which is this one
        // Server here.
        `rm -rf ${deploymentLogsDirectoryOn(remote.serverId, 'web-app')}`,
      ]);
      for (const call of execMock.execAsyncRemote.mock.calls) {
        expect(call[0]).toBe(remote.serverId);
      }
      expect(traefikWriterMock.removeConfig).toHaveBeenCalledWith(
        'web-app',
        remote.serverId,
      );
    });
  });
});
