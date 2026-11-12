import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { decryptValue } from '../../src/common/encryption/encryption';
import { ComposeService } from '../../src/compose/compose.service';
import { DomainsService } from '../../src/domains/domains.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { webServerSettings } from '../../src/settings/settings.schema';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

/**
 * H-83. A compose file's own `traefik.*` router labels reached the deployed spec
 * verbatim, on every branch and from four surfaces, so an author could claim
 * another tenant's hostname on the shared Traefik — H-56's reproduced
 * cross-tenant hijack, arriving through the door H-56 closed for an
 * Application's Swarm labels and left open for a Compose stack's file.
 *
 * The unit half is `compose-labels.spec.ts`: everything no ownership query could
 * make safe (a `HostRegexp` nobody can own, a rule not bounded to a hostname, a
 * rule the parser cannot fully read, a host compose has still to interpolate,
 * `com.docker.*`) is refused by a pure function at the emitter. **What is pinned
 * here is the half that needs a database**: whether the hostname a label claims
 * is one this organization may claim, decided by the same
 * `DomainsService.assertHostsUnclaimed` rule `POST /domains` applies, reached
 * through every route that can put a compose file where a deploy will read it.
 *
 * Two organizations, and every collision is on the platform host
 * (`serverId: null`): a Server belongs to exactly one organization and
 * `checkServerAccess` refuses a foreign `serverId`, so the platform host is the
 * one Traefik two organizations can both reach (ADR-0008) —
 * `domain-host-claims.e2e-spec.ts` establishes that and this file inherits it.
 */

const operator = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const VICTIM_HOST = 'victim.example.com';

/** A compose file whose `web` service carries exactly the given label lines. */
const withLabels = (...labels: string[]) => `services:
  web:
    image: nginx:alpine
    labels:
${labels.map((label) => `      - ${JSON.stringify(label)}`).join('\n')}
`;

const CLEAN_COMPOSE = `services:
  web:
    image: nginx:alpine
`;

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

describe('Compose label host claims (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let composeService: ComposeService;
  let domains: DomainsService;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
    execRemote: jest.fn(),
    execFileAsync: jest.fn(),
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
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    composeService = ctx.app.get(ComposeService);
    domains = ctx.app.get(DomainsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    for (const fn of [
      execMock.execAsync,
      execMock.execAsyncRemote,
      execMock.execRemote,
      execMock.execFileAsync,
    ]) {
      fn.mockReset().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    }
    traefikWriterMock.loadOrCreateConfig
      .mockReset()
      .mockResolvedValue({ http: { routers: {}, services: {} } });
    traefikWriterMock.writeConfig.mockReset().mockResolvedValue(undefined);
    traefikWriterMock.removeConfig.mockReset().mockResolvedValue(undefined);
    await ctx.db.$client.query('delete from web_server_settings');
    await ctx.db
      .insert(webServerSettings)
      .values({ host: 'console.example.com' });
  });

  interface OrganizationFixture {
    organizationId: string;
    organizationName: string;
    session: { cookie: string; id: string };
    ctx: ReturnType<typeof permissionCtx>;
    environmentId: string;
  }

  async function withProject(
    session: { cookie: string; id: string },
    organization: { id: string; name: string },
  ): Promise<OrganizationFixture> {
    const organizationCtx = permissionCtx(session.id, organization.id);
    const project = await projects.create(organizationCtx, {
      name: organization.name,
    });
    const environment = await environments.create(organizationCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    return {
      organizationId: organization.id,
      organizationName: organization.name,
      session,
      ctx: organizationCtx,
      environmentId: environment.environmentId,
    };
  }

  async function setUpOperator(): Promise<OrganizationFixture> {
    const session = await signUp(server, operator);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', session.cookie);
    const [organization] = orgs.body as { id: string; name: string }[];
    return withProject(session, organization);
  }

  /**
   * A second organization, so a hostname can be held by somebody else. One
   * session, two organizations, `set-active` between them — sign-up closes once
   * an owner exists, and an invitation would land the user in *this*
   * organization. `domain-host-claims.e2e-spec.ts` establishes the shape.
   */
  async function setUpNeighbour(session: {
    cookie: string;
    id: string;
  }): Promise<OrganizationFixture> {
    const created = await createOrganization(server, ctx.db, session.cookie, {
      name: 'Neighbour',
      slug: `neighbour-${Date.now()}`,
    });
    expect(created.status).toBe(201);
    return withProject(session, created.body as { id: string; name: string });
  }

  /** Points the shared session at this organization and hands back its cookie. */
  async function actingAs(org: OrganizationFixture): Promise<string> {
    const activated = await request(server)
      .post('/api/auth/organization/set-active')
      .set('Cookie', org.session.cookie)
      .send({ organizationId: org.organizationId });
    expect(activated.status).toBe(200);
    return org.session.cookie;
  }

  /** The neighbour organization, holding {@link VICTIM_HOST} on the platform host. */
  async function neighbourHolding(
    held: OrganizationFixture,
    host = VICTIM_HOST,
  ): Promise<OrganizationFixture> {
    const neighbour = await setUpNeighbour(held.session);
    const app = await applications.create(neighbour.ctx, {
      name: 'held-app',
      appName: `held-app-${Date.now()}`,
      environmentId: neighbour.environmentId,
    });
    await domains.create(neighbour.ctx, {
      host,
      applicationId: app.applicationId,
    });
    return neighbour;
  }

  /**
   * Every compose row's stored file, so a refusal can be shown to have written
   * nothing.
   *
   * Read with the driver rather than through `ComposeService`, because the
   * question is what is *stored* and a service read would answer it through the
   * same guard the refusal came out of. `decryptValue` is what the driver read
   * costs since `composeFile` became `encryptedText`: the column holds
   * `enc:v1:…` now, and this helper's job is still to compare content. It is
   * not the expectation — the expectation is a literal further down — and it
   * passes a legacy plaintext row straight through (ADR 0006), which is what
   * lets the seeded-past-the-guard fixture below keep writing one.
   */
  const composeFiles = async () =>
    (
      await ctx.db.$client.query<{ compose_file: string }>(
        'select compose_file from compose order by app_name',
      )
    ).rows.map((row) => decryptValue(row.compose_file));

  // -------------------------------------------------------------------------
  // Surface 1: POST /compose
  // -------------------------------------------------------------------------

  describe('POST /compose', () => {
    it('refuses a router label claiming a host another organization holds', async () => {
      const claimant = await setUpOperator();
      const holder = await neighbourHolding(claimant);

      const refused = await request(server)
        .post('/compose')
        .set('Cookie', await actingAs(claimant))
        .send({
          name: 'Hijack',
          appName: 'hijack-stack',
          environmentId: claimant.environmentId,
          composeFile: withLabels(
            'traefik.enable=true',
            `traefik.http.routers.hijack.rule=Host(\`${VICTIM_HOST}\`)`,
          ),
        });

      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        'This hostname is already in use',
      );
      // Nothing was written on the way to being refused.
      expect(await composeFiles()).toEqual([]);
      // And the refusal names no holder: the same opaque sentence
      // `POST /domains` answers with, so this route is not an enumeration
      // oracle for another organization's hostnames when its sibling is not.
      expect(JSON.stringify(refused.body)).not.toContain(holder.organizationId);
      expect(JSON.stringify(refused.body)).not.toContain(
        holder.organizationName,
      );
    });

    it('refuses a router label whose rule names a hostname pattern', async () => {
      const claimant = await setUpOperator();

      const refused = await request(server)
        .post('/compose')
        .set('Cookie', await actingAs(claimant))
        .send({
          name: 'Wildcard',
          appName: 'wildcard-stack',
          environmentId: claimant.environmentId,
          composeFile: withLabels(
            'traefik.http.routers.w.rule=HostRegexp(`^.+\\.example\\.com$`)',
          ),
        });

      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toMatch(
        /HostRegexp/,
      );
      expect(await composeFiles()).toEqual([]);
    });

    it('refuses a com.docker label key on the compose path too', async () => {
      const claimant = await setUpOperator();

      const refused = await request(server)
        .post('/compose')
        .set('Cookie', await actingAs(claimant))
        .send({
          name: 'Ownership',
          appName: 'ownership-stack',
          environmentId: claimant.environmentId,
          composeFile: withLabels('com.docker.compose.project=someone-else'),
        });

      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toMatch(
        /com\.docker/,
      );
      expect(await composeFiles()).toEqual([]);
    });

    it('admits a router label claiming a hostname nobody holds', async () => {
      // First-claim-wins per Server is the ownership model `POST /domains`
      // already applies; this rule is that one, not a stricter one.
      const claimant = await setUpOperator();

      const created = await request(server)
        .post('/compose')
        .set('Cookie', await actingAs(claimant))
        .send({
          name: 'Mine',
          appName: 'mine-stack',
          environmentId: claimant.environmentId,
          composeFile: withLabels(
            'traefik.enable=true',
            'traefik.http.routers.mine.rule=Host(`mine.example.com`) && PathPrefix(`/api`)',
          ),
        });

      expect(created.status).toBe(201);
    });

    it("refuses a router label claiming the console's own hostname", async () => {
      const claimant = await setUpOperator();

      const refused = await request(server)
        .post('/compose')
        .set('Cookie', await actingAs(claimant))
        .send({
          name: 'Console',
          appName: 'console-stack',
          environmentId: claimant.environmentId,
          composeFile: withLabels(
            'traefik.http.routers.c.rule=Host(`console.example.com`)',
          ),
        });

      expect(refused.status).toBe(409);
      expect(await composeFiles()).toEqual([]);
    });

    it('refuses a tls.domains certificate claim on a host another organization holds', async () => {
      // H-85, and the shape that makes it worth its own finding: the *routing*
      // claim here is one the guard admits — `mine.example.com` is unheld — and
      // the certificate claim beside it is somebody else's hostname. The shipped
      // resolver answers `httpChallenge` on this host's own port 80 and the
      // victim's DNS already points here, so without this the tenant obtains a
      // valid certificate for another tenant's hostname, and a certificate
      // outlives the container that asked for it.
      const claimant = await setUpOperator();
      const holder = await neighbourHolding(claimant);

      const refused = await request(server)
        .post('/compose')
        .set('Cookie', await actingAs(claimant))
        .send({
          name: 'Cert',
          appName: 'cert-stack',
          environmentId: claimant.environmentId,
          composeFile: withLabels(
            'traefik.enable=true',
            'traefik.http.routers.r.rule=Host(`mine.example.com`)',
            'traefik.http.routers.r.tls.certresolver=letsencrypt',
            `traefik.http.routers.r.tls.domains[0].main=${VICTIM_HOST}`,
          ),
        });

      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        'This hostname is already in use',
      );
      expect(await composeFiles()).toEqual([]);
      expect(JSON.stringify(refused.body)).not.toContain(holder.organizationId);
    });

    it('refuses a held host named in a comma-separated sans list', async () => {
      // `.sans` is a Traefik slice, so a claim can hide behind a legitimate
      // first element.
      const claimant = await setUpOperator();
      await neighbourHolding(claimant);

      const refused = await request(server)
        .post('/compose')
        .set('Cookie', await actingAs(claimant))
        .send({
          name: 'Sans',
          appName: 'sans-stack',
          environmentId: claimant.environmentId,
          composeFile: withLabels(
            `traefik.http.routers.r.tls.domains[0].sans=ok.example.com,${VICTIM_HOST}`,
          ),
        });

      expect(refused.status).toBe(409);
      expect(await composeFiles()).toEqual([]);
    });

    it('refuses a wildcard certificate claim outright', async () => {
      const claimant = await setUpOperator();

      const refused = await request(server)
        .post('/compose')
        .set('Cookie', await actingAs(claimant))
        .send({
          name: 'Wildcard cert',
          appName: 'wildcard-cert-stack',
          environmentId: claimant.environmentId,
          composeFile: withLabels(
            'traefik.http.routers.r.tls.domains[0].main=*.example.com',
          ),
        });

      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toMatch(
        /wildcard/i,
      );
      expect(await composeFiles()).toEqual([]);
    });

    it('admits a certificate claim for a hostname nobody holds', async () => {
      const claimant = await setUpOperator();

      const created = await request(server)
        .post('/compose')
        .set('Cookie', await actingAs(claimant))
        .send({
          name: 'Own cert',
          appName: 'own-cert-stack',
          environmentId: claimant.environmentId,
          composeFile: withLabels(
            'traefik.http.routers.r.rule=Host(`mine.example.com`)',
            'traefik.http.routers.r.tls.domains[0].main=mine.example.com',
            'traefik.http.routers.r.tls.domains[0].sans=alt.example.com',
          ),
        });

      expect(created.status).toBe(201);
    });

    it.each([
      [
        'wikijs',
        ['traefik.enable=true', 'traefik.constraint-label-stack=wikijs'],
      ],
      ['qbittorrent', ['traefik.enable=true']],
      ['fivem', ['traefik.enable=true']],
      ['crowdsec', ['traefik.enable=false']],
      // Not a blueprint: the `tls.*` labels Cloudgate itself mints
      // (`createComposeDomainLabels`), here because H-85 refuses a `tls.domains`
      // key and this is the row that proves the two the product actually writes
      // are not that key. Re-checked against the four above at the same time:
      // none of them sets `tls.domains` either, so the H-85 rule is
      // unconditional and costs the catalogue nothing.
      [
        'the tls labels Cloudgate mints',
        [
          'traefik.enable=true',
          'traefik.http.routers.r.rule=Host(`mine.example.com`)',
          'traefik.http.routers.r.tls=true',
          'traefik.http.routers.r.tls.certresolver=letsencrypt',
        ],
      ],
    ])('deploys the %s label shape unchanged', async (id, labels) => {
      // Real label shapes from the published wikijs, qbittorrent, fivem and
      // crowdsec blueprints. None of the four carries a router rule or a
      // `tls.domains`; if the guard breaks any of them the guard is wrong, not
      // the blueprint.
      const claimant = await setUpOperator();

      const created = await request(server)
        .post('/compose')
        .set('Cookie', await actingAs(claimant))
        .send({
          name: id,
          appName: `${id.replace(/[^a-z0-9]+/gi, '-')}-stack`,
          environmentId: claimant.environmentId,
          composeFile: withLabels(...labels),
        });

      expect(created.status).toBe(201);
    });
  });

  // -------------------------------------------------------------------------
  // Surface 2: PATCH /compose/:id — including the `.partial()` hole
  // -------------------------------------------------------------------------

  describe('PATCH /compose/:id', () => {
    it('refuses a composeFile claiming a host another organization holds', async () => {
      const claimant = await setUpOperator();
      await neighbourHolding(claimant);
      const stack = await composeService.create(claimant.ctx, {
        name: 'Stack',
        appName: 'patch-stack',
        environmentId: claimant.environmentId,
        composeFile: CLEAN_COMPOSE,
      });

      const refused = await request(server)
        .patch(`/compose/${stack.composeId}`)
        .set('Cookie', await actingAs(claimant))
        .send({
          composeFile: withLabels(
            `traefik.http.routers.hijack.rule=Host(\`${VICTIM_HOST}\`)`,
          ),
        });

      expect(refused.status).toBe(409);
      // The stored file is untouched — the refusal is not a partial write.
      expect(await composeFiles()).toEqual([CLEAN_COMPOSE]);
    });

    it('refuses a PATCH that omits composeFile while the stored file is poisoned', async () => {
      // X05's H-14 shape and its no-backfill residual, one schema over:
      // `updateComposeSchema` is `.partial()`, so a PATCH carrying only `name`
      // used to write every other column while the stored file went unexamined
      // — and the next deploy re-emitted it. The rule is a statement about the
      // row's resulting state, `data.composeFile ?? row.composeFile`, not about
      // the request body.
      const claimant = await setUpOperator();
      const poisoned = withLabels(
        `traefik.http.routers.hijack.rule=Host(\`${VICTIM_HOST}\`)`,
      );
      // Seeded past the guard, exactly as a row stored before the rule existed.
      const stack = await composeService.create(claimant.ctx, {
        name: 'Stack',
        appName: 'stale-stack',
        environmentId: claimant.environmentId,
        composeFile: CLEAN_COMPOSE,
      });
      await ctx.db.$client.query(
        'update compose set compose_file = $1 where compose_id = $2',
        [poisoned, stack.composeId],
      );
      await neighbourHolding(claimant);

      const refused = await request(server)
        .patch(`/compose/${stack.composeId}`)
        .set('Cookie', await actingAs(claimant))
        .send({ name: 'Renamed' });

      expect(refused.status).toBe(409);
      // The unrelated column did not change either: the refusal is the whole
      // request, not the compose file half of it.
      const rows = await ctx.db.$client.query<{ name: string }>(
        'select name from compose where compose_id = $1',
        [stack.composeId],
      );
      expect(rows.rows[0].name).toBe('Stack');
    });

    it('admits a PATCH that omits composeFile when the stored file is clean', async () => {
      const claimant = await setUpOperator();
      const stack = await composeService.create(claimant.ctx, {
        name: 'Stack',
        appName: 'clean-stack',
        environmentId: claimant.environmentId,
        composeFile: CLEAN_COMPOSE,
      });

      const updated = await request(server)
        .patch(`/compose/${stack.composeId}`)
        .set('Cookie', await actingAs(claimant))
        .send({ name: 'Renamed' });

      expect(updated.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Surfaces 3 and 4: POST /ai/deploy, and POST /templates/deploy until the
  // `template.toml` reader was removed in #1364
  // -------------------------------------------------------------------------

  describe('the AI deploy path', () => {
    it('refuses a compose file claiming a held host at its sink', async () => {
      // The route reaches the `composeFile` column through exactly one method
      // and has no other way to it: `AiService.deploy` builds a file and calls
      // `ComposeService.createByTemplate`. The guard is there rather than in
      // the service for the reason H-20 named — two writers reaching one sink,
      // each carrying its own copy of the rule, and a third arriving later with
      // none — so this is the assertion that covers the sink. Driving it
      // over HTTP would additionally need an AI provider.
      const claimant = await setUpOperator();
      await neighbourHolding(claimant);

      await expect(
        composeService.createByTemplate({
          environmentId: claimant.environmentId,
          composeFile: withLabels(
            `traefik.http.routers.hijack.rule=Host(\`${VICTIM_HOST}\`)`,
          ),
          name: 'blueprint',
          sourceType: 'raw',
          appName: 'blueprint-stack',
          isolatedDeployment: false,
        }),
      ).rejects.toThrow('This hostname is already in use');

      expect(await composeFiles()).toEqual([]);
    });

    it('refuses a compose file whose rule names a hostname pattern', async () => {
      // appwrite's own shape, and the intended collateral: a claim on every
      // subdomain of a shared ingress is the surface being closed.
      const claimant = await setUpOperator();

      await expect(
        composeService.createByTemplate({
          environmentId: claimant.environmentId,
          composeFile: withLabels(
            'traefik.enable=true',
            'traefik.constraint-label-stack=appwrite',
            'traefik.http.routers.appwrite-sites-wildcard.rule=HostRegexp(`^.+\\.${_APP_DOMAIN_SITES}$$`)',
          ),
          name: 'appwrite',
          sourceType: 'raw',
          appName: 'appwrite-stack',
          isolatedDeployment: false,
        }),
      ).rejects.toThrow(/HostRegexp/);

      expect(await composeFiles()).toEqual([]);
    });

    it('admits a compose file that claims nothing', async () => {
      const claimant = await setUpOperator();

      const created = await composeService.createByTemplate({
        environmentId: claimant.environmentId,
        composeFile: withLabels('traefik.enable=true'),
        name: 'wikijs',
        sourceType: 'raw',
        appName: 'wikijs-stack',
        isolatedDeployment: false,
      });

      expect(created.appName).toBe('wikijs-stack');
    });
  });

  // -------------------------------------------------------------------------
  // Surface 5: POST /compose/:id/start — the converted file already on disk
  // -------------------------------------------------------------------------

  describe('POST /compose/:id/start', () => {
    /** The compose stack this organization owns, seeded past the guard. */
    async function seedStack(org: OrganizationFixture) {
      const stack = await composeService.create(org.ctx, {
        name: 'Stack',
        appName: 'start-stack',
        environmentId: org.environmentId,
        composeFile: CLEAN_COMPOSE,
      });
      await composeService.update(org.ctx, stack.composeId, {
        sourceType: 'raw',
        composeType: 'docker-compose',
      });
      return stack;
    }

    it('refuses to bring up an on-disk file claiming a held host', async () => {
      // `start` re-reads nothing and re-injects nothing — it runs the converted
      // file `getBuildComposeCommand` left in the code directory. So a stack
      // poisoned before the rule existed comes back up straight past every
      // write-path guard unless this route checks the bytes on disk.
      const claimant = await setUpOperator();
      await neighbourHolding(claimant);
      const stack = await seedStack(claimant);

      const poisoned = withLabels(
        'traefik.enable=true',
        `traefik.http.routers.hijack.rule=Host(\`${VICTIM_HOST}\`)`,
      );
      execMock.execAsync.mockImplementation((command: string) =>
        Promise.resolve({
          stdout: command.startsWith('cat ') ? poisoned : '',
          stderr: '',
          exitCode: 0,
        }),
      );

      const refused = await request(server)
        .post(`/compose/${stack.composeId}/start`)
        .set('Cookie', await actingAs(claimant));

      expect(refused.status).toBe(409);
      // And the `up` never ran: the only exec was the read.
      const commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      expect(commands.filter((c) => c.includes('docker compose'))).toEqual([]);
      expect(commands.some((c) => c.startsWith('cat '))).toBe(true);
    });

    it('brings up an on-disk file whose claims are its own', async () => {
      // Cloudgate's own injected labels have to pass, or `start` breaks for
      // every routed stack: a generated rule names this stack's own domain rows,
      // which the ownership rule admits by construction.
      const claimant = await setUpOperator();
      const stack = await seedStack(claimant);

      const converted = withLabels(
        'traefik.enable=true',
        'traefik.docker.network=cloudgate-network',
        'traefik.http.routers.start-stack-1-web.rule=Host(`mine.example.com`)',
        'traefik.http.services.start-stack-1-web.loadbalancer.server.port=80',
      );
      execMock.execAsync.mockImplementation((command: string) =>
        Promise.resolve({
          stdout: command.startsWith('cat ') ? converted : '',
          stderr: '',
          exitCode: 0,
        }),
      );

      const started = await request(server)
        .post(`/compose/${stack.composeId}/start`)
        .set('Cookie', await actingAs(claimant));

      expect(started.status).toBe(200);
      const commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      expect(commands.some((c) => c.includes('docker compose'))).toBe(true);
    });

    it('starts a stack with nothing on disk yet rather than blaming its labels', async () => {
      // An absent file is not a label problem. `cat … || true` answers empty and
      // the `up` below fails on its own terms if it is going to.
      const claimant = await setUpOperator();
      const stack = await seedStack(claimant);

      const started = await request(server)
        .post(`/compose/${stack.composeId}/start`)
        .set('Cookie', await actingAs(claimant));

      expect(started.status).toBe(200);
    });
  });
});
