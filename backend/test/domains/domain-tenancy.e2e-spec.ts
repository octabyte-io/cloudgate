import { asc } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { domain } from '../../src/db/schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner } from '../utils/test-auth';

jest.setTimeout(120_000);

const instanceOwner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** Ids shaped like the real ones and naming nothing anywhere. */
const NO_SUCH_COMPOSE = 'no-such-compose-id';
const NO_SUCH_APPLICATION = 'no-such-application-id';

/** Every field of an error body except the wall clock. */
function withoutTimestamp(body: unknown): unknown {
  const rest = { ...(body as Record<string, unknown>) };
  delete rest.timestamp;
  return rest;
}

/**
 * `POST /domains` as a cross-tenant write, and the pair of refusals that keeps
 * it from becoming an existence oracle.
 *
 * `DomainsService.create` resolves its parent through `findParentService`, which
 * **is** organization-scoped in both branches — each joins `environment` →
 * `project` and filters on `project.organizationId`. The defect was the control
 * flow around them: the method tests `applicationId` first and *returns* on
 * that branch, so the `composeId` branch is never reached when both are
 * present, and the insert was `.values({ ...data, host, path })`, which writes
 * **both** foreign keys. A body carrying the caller's own `applicationId`
 * beside another organization's `composeId` therefore passed the gate on the
 * first and landed a `domain` row on the victim's Compose stack — not a stray
 * record: `DomainsService.findComposeDomains` hands it to
 * `addDomainsToComposeSpec`, which splices a Traefik router for the attacker's
 * hostname into the victim's stack at their next deploy. Before the fix the
 * first two tests below read **201** and left that row behind.
 *
 * The same call authorized two *other* decisions against the wrong parent, and
 * the last two tests are what pin those: `assertHostUnclaimed` was handed
 * `parent.serverId` — the attacker's Server, since `parent` came from the
 * `applicationId` branch — so the claim check asked whether the hostname was
 * free on a machine the row was not going to reach, and
 * `assertComposeServiceRoutable` read the wrong stack's compose file.
 *
 * These live here rather than in `domains.e2e-spec.ts` for the reason
 * `patch-tenancy.e2e-spec.ts` and `environment-tenancy.e2e-spec.ts` both give:
 * this needs a second **account**. `domain-host-claims.e2e-spec.ts`'s two
 * organizations are both owned by the operator's own session, which is enough
 * for a rule that only compares `activeOrganizationId` against
 * `project.organizationId` and is not enough here — a second organization owned
 * by the same user carries that user's row-level grants and privileged role
 * with it, so it cannot tell "the service is in another organization" from "the
 * caller is the same person". `secondOrganizationOwner` gives Mallory, a Member
 * of exactly one organization and an owner of it — the strongest caller this
 * defect was reachable by (ADR-0013's fixture).
 *
 * **The pair is the point, not the status.** §2.2 and ADR-0008 both require
 * that a refusal disclose nothing about which ids exist elsewhere on the
 * instance, so each single-id direction asserts the foreign-service body
 * against the nothing-anywhere body field by field rather than asserting a
 * status twice.
 */
describe('Domain tenancy (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: TraefikWriterService, useValue: traefikWriterMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    traefikWriterMock.loadOrCreateConfig
      .mockReset()
      .mockResolvedValue({ http: { routers: {}, services: {} } });
    traefikWriterMock.writeConfig.mockReset().mockResolvedValue(undefined);
    traefikWriterMock.removeConfig.mockReset().mockResolvedValue(undefined);
  });

  /** An Application and a Compose stack in one organization, via HTTP only. */
  async function servicesFor(cookie: string, slug: string) {
    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: slug });
    expect(project.status).toBe(201);

    const environment = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        name: 'production',
        projectId: (project.body as { projectId: string }).projectId,
      });
    expect(environment.status).toBe(201);
    const environmentId = (environment.body as { environmentId: string })
      .environmentId;

    // `appName` is unique across every Application row on the instance, so the
    // two organizations' services are named apart rather than by role.
    const application = await request(server)
      .post('/applications')
      .set('Cookie', cookie)
      .send({ name: 'Blog', appName: `${slug}-app`, environmentId });
    expect(application.status).toBe(201);

    const compose = await request(server)
      .post('/compose')
      .set('Cookie', cookie)
      .send({ name: 'Stack', appName: `${slug}-stack`, environmentId });
    expect(compose.status).toBe(201);

    return {
      environmentId,
      applicationId: (application.body as { applicationId: string })
        .applicationId,
      composeId: (compose.body as { composeId: string }).composeId,
    };
  }

  /** Two organizations, an owner each, and an Application + Compose in both. */
  async function setUpTwoOrganizations() {
    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(instanceOwner);
    expect(signUp.status).toBe(200);
    const ownerCookie: string = signUp.headers['set-cookie'];

    const mallory = await secondOrganizationOwner(server, ctx.db, ownerCookie, {
      organizationName: 'Neighbour Org',
    });

    return {
      ownerCookie,
      mallory,
      ours: await servicesFor(ownerCookie, 'cloudgate'),
      theirs: await servicesFor(mallory.cookie, 'neighbour'),
    };
  }

  const createDomain = (cookie: string, body: Record<string, unknown>) =>
    request(server)
      .post('/domains')
      .set('Cookie', cookie)
      .send({ host: 'mallory.example.com', ...body });

  /**
   * Every Domain row on the instance, whoever created it — ordered, so a
   * multi-row assertion is about the rows and not about insertion order.
   */
  const allDomains = () =>
    ctx.db.select().from(domain).orderBy(asc(domain.host), asc(domain.path));

  /** Host, path and both parent ids of every row, which is what a tenancy claim is. */
  const domainAttachments = async () =>
    (await allDomains()).map((row) => ({
      host: row.host,
      path: row.path,
      applicationId: row.applicationId,
      composeId: row.composeId,
    }));

  /**
   * A `server` row in an organization, so a service can sit somewhere other
   * than the platform host.
   *
   * Seeded by SQL, as `domain-host-claims.e2e-spec.ts` does: a Server belongs
   * to exactly one organization and `checkServerAccess` refuses a `serverId`
   * outside the caller's, so this is the only way to give Mallory a second
   * Traefik to be judged against.
   */
  async function addServer(
    organizationId: string,
    name: string,
  ): Promise<string> {
    const inserted = await ctx.db.$client.query<{ server_id: string }>(
      `insert into server (server_id, name, ip_address, port, created_at, organization_id)
       values ($1, $2, '192.168.1.10', 22, $3, $4) returning server_id`,
      [name, name, new Date().toISOString(), organizationId],
    );
    return inserted.rows[0].server_id;
  }

  it("refuses a create pairing Mallory's own applicationId with a composeId of ours, and attaches nothing to it", async () => {
    const { mallory, ours, theirs } = await setUpTwoOrganizations();

    const paired = await createDomain(mallory.cookie, {
      applicationId: theirs.applicationId,
      composeId: ours.composeId,
      serviceName: 'web',
      domainType: 'compose',
    });

    expect(paired.status).toBe(400);
    expect(paired.body).toMatchObject({
      message: 'Validation failed',
      details: [
        {
          path: 'applicationId',
          message:
            'Exactly one of applicationId, composeId or bucketId must be provided',
        },
      ],
    });
    // Nothing was attached to our Compose stack on the way to being refused,
    // and nothing was written anywhere — before the fix this was a 201 and a row
    // whose `composeId` was ours, which our next deploy would have turned into
    // a Traefik router for `mallory.example.com` inside our own stack.
    expect(await allDomains()).toEqual([]);
  });

  it("refuses a create pairing our own applicationId with a composeId of Mallory's, and attaches nothing to it", async () => {
    const { ownerCookie, ours, theirs } = await setUpTwoOrganizations();

    const paired = await createDomain(ownerCookie, {
      applicationId: ours.applicationId,
      composeId: theirs.composeId,
    });

    expect(paired.status).toBe(400);
    expect(paired.body).toMatchObject({ message: 'Validation failed' });
    // The direction is symmetric because the rule is about the body's shape,
    // not about who sent it: the instance owner is refused the same pair.
    expect(await allDomains()).toEqual([]);
  });

  it('refuses Mallory a composeId of ours identically to a composeId that exists nowhere', async () => {
    const { mallory, ours } = await setUpTwoOrganizations();

    const foreign = await createDomain(mallory.cookie, {
      composeId: ours.composeId,
    });
    const absent = await createDomain(mallory.cookie, {
      composeId: NO_SUCH_COMPOSE,
    });

    expect(foreign.status).toBe(404);
    expect(withoutTimestamp(foreign.body)).toEqual(
      withoutTimestamp(absent.body),
    );
    expect(foreign.body).toMatchObject({ message: 'Compose not found' });
    // Neither attempt left a row: the single-id path was already org-scoped,
    // and this pins the refusal it answers with as well as the write it skips.
    expect(await allDomains()).toEqual([]);
  });

  it('refuses Mallory an applicationId of ours identically to an applicationId that exists nowhere', async () => {
    const { mallory, ours } = await setUpTwoOrganizations();

    const foreign = await createDomain(mallory.cookie, {
      applicationId: ours.applicationId,
    });
    const absent = await createDomain(mallory.cookie, {
      applicationId: NO_SUCH_APPLICATION,
    });

    expect(foreign.status).toBe(404);
    expect(withoutTimestamp(foreign.body)).toEqual(
      withoutTimestamp(absent.body),
    );
    expect(foreign.body).toMatchObject({ message: 'Application not found' });
    expect(await allDomains()).toEqual([]);
  });

  it('refuses a create that names no owning service at all, and writes nothing', async () => {
    const { ownerCookie } = await setUpTwoOrganizations();

    const orphan = await createDomain(ownerCookie, {});

    // The same refinement, the other half of "exactly one": this used to reach
    // the service and answer 400 `'applicationId or composeId is required'`,
    // which `findParentService` still raises for an internal caller.
    expect(orphan.status).toBe(400);
    expect(orphan.body).toMatchObject({
      message: 'Validation failed',
      details: [
        {
          path: 'applicationId',
          message:
            'Exactly one of applicationId, composeId or bucketId must be provided',
        },
      ],
    });
    expect(await allDomains()).toEqual([]);
  });

  it("creates a domain owned by an Application and one owned by a Compose stack in the caller's own organization", async () => {
    const { mallory, theirs } = await setUpTwoOrganizations();

    const onApplication = await createDomain(mallory.cookie, {
      applicationId: theirs.applicationId,
    });
    expect(onApplication.status).toBe(201);
    expect(onApplication.body).toMatchObject({
      applicationId: theirs.applicationId,
      composeId: null,
      host: 'mallory.example.com',
      // The three defaults the explicit insert has to keep producing now that
      // the body is no longer spread into it: `path` is `create`'s own `?? '/'`
      // and the other two are the table's.
      path: '/',
      https: false,
      certificateType: 'none',
    });

    const onCompose = await createDomain(mallory.cookie, {
      host: 'stack.example.com',
      composeId: theirs.composeId,
      serviceName: 'web',
      domainType: 'compose',
    });
    expect(onCompose.status).toBe(201);
    expect(onCompose.body).toMatchObject({
      applicationId: null,
      composeId: theirs.composeId,
      serviceName: 'web',
      domainType: 'compose',
    });

    // Each row hangs off exactly the one service its body named, and off no
    // second one.
    expect(await domainAttachments()).toEqual([
      {
        host: 'mallory.example.com',
        path: '/',
        applicationId: theirs.applicationId,
        composeId: null,
      },
      {
        host: 'stack.example.com',
        path: '/',
        applicationId: null,
        composeId: theirs.composeId,
      },
    ]);
  });

  it('runs the host-claim check against the Server of the parent it resolved', async () => {
    const { ownerCookie, mallory, ours, theirs } =
      await setUpTwoOrganizations();
    // We hold `shared.example.com` on the platform host, which per ADR-0008 is
    // the one Traefik two organizations can both reach (`serverId: null`).
    const held = await request(server)
      .post('/domains')
      .set('Cookie', ownerCookie)
      .send({ host: 'shared.example.com', applicationId: ours.applicationId });
    expect(held.status).toBe(201);

    const mallorysServer = await addServer(mallory.organizationId, 'mallory-1');
    const remoteStack = await request(server)
      .post('/compose')
      .set('Cookie', mallory.cookie)
      .send({
        name: 'Elsewhere',
        appName: 'neighbour-remote-stack',
        environmentId: theirs.environmentId,
        serverId: mallorysServer,
      });
    expect(remoteStack.status).toBe(201);
    const remoteComposeId = (remoteStack.body as { composeId: string })
      .composeId;

    // Same caller, same hostname, two of her own parents differing in nothing
    // but their Server — so the two outcomes below can only be a function of
    // the Server of the parent `create` resolved. That is the property the defect's
    // second consequence broke: with both ids in the body, `parent` came from
    // the `applicationId` branch, so this check was asked about the attacker's
    // Application's Server while the row landed on the Compose stack.
    const onPlatformHost = await createDomain(mallory.cookie, {
      host: 'shared.example.com',
      path: '/api',
      composeId: theirs.composeId,
      serviceName: 'web',
      domainType: 'compose',
    });
    expect(onPlatformHost.status).toBe(409);
    expect(onPlatformHost.body).toMatchObject({
      message: 'This hostname is already in use',
    });

    const onHerOwnServer = await createDomain(mallory.cookie, {
      host: 'shared.example.com',
      path: '/mallory',
      composeId: remoteComposeId,
      serviceName: 'web',
      domainType: 'compose',
    });
    expect(onHerOwnServer.status).toBe(201);

    // The refused attach stored nothing, and the taken one is attached to the
    // stack on her own Server and to nothing of ours. (The paths differ because
    // the `(host, path)` pair check stays global — the third accepted
    // residual, deliberately not loosened here.)
    expect(await domainAttachments()).toEqual([
      {
        host: 'shared.example.com',
        path: '/',
        applicationId: ours.applicationId,
        composeId: null,
      },
      {
        host: 'shared.example.com',
        path: '/mallory',
        applicationId: null,
        composeId: remoteComposeId,
      },
    ]);
  });
});
