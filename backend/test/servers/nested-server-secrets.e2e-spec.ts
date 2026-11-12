import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import * as schema from '../../src/db/schema';
import { NotificationDispatcherService } from '../../src/notifications/dispatcher.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { defaultMetricsConfig } from '../../src/servers/server.schema';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember } from '../utils/test-auth';

jest.setTimeout(180_000);

/**
 * The per-Server half of the monitoring-token fix.
 *
 * `server.metricsConfig` is the same `encryptedJson` column the at-rest change
 * encrypted and it decrypts on read. `GET /servers` and `GET /servers/:id` answer with it
 * behind `server:read` — owner/admin or a licensed custom role, which is
 * defensible. The nested `server` relation on **`GET /applications/:id`**,
 * **`GET /compose/:id`** and every database service read is behind
 * `checkServiceAccess(ctx, id, 'read')`, which the base `memberRole` satisfies
 * with one id in `accessedServices` — and those reads spread the `server` row
 * whole.
 *
 * So a plain member entitled to one Application read that Server's
 * `metricsConfig.server.token` and presented it to the unauthenticated
 * `POST /notifications/receive`, which authenticates on possession of it alone:
 * `receiveServerThreshold`'s `ServerType: 'Remote'` branch matched the row and
 * dispatched `found.organizationId` with attacker-chosen `Message`. One
 * organization's channels rather than the instance, so a rung below the admin route — but
 * `memberRole` holds `notification: []`, so a member who cannot even *list* the
 * organization's Slack or Telegram channels could write into all of them,
 * unauthenticated, from off-instance.
 *
 * **Every string, not one field** — the admin route's technique, and the reason for it is
 * the same: a test asserting `metricsConfig.server.token === undefined` passes
 * against a projection that moved the value elsewhere in the body, which is the
 * mistake `stripSshPrivateKey` made in the other direction. So the member
 * harvests every string the response contains, presents each one to the receive
 * route, and the dispatcher is asserted never to have been reached. The
 * positive control presents the *real* token out of the database and proves the
 * chain is live; without it the whole describe would pass against a receive
 * route that refused everybody.
 *
 * **The three other secrets** the same reads handed over are asserted here too,
 * because they are the same defect and were found by looking for it: the nested
 * `customGitSSHKey` was `true`, so the whole `ssh_key` row came back with the
 * `privateKey` an early fix established never leaves the server; `github` withheld
 * `clientSecret` and `privateKey` and **not** `webhookSecret`, which
 * `GithubService.sanitize` withholds because a reader of it can forge an
 * inbound delivery; and `gitlab` withheld both tokens and **not** `secret`, the
 * OAuth application secret. Each is seeded with a marker no other value
 * matches, so `nothing the member reads contains a stored secret` fails by
 * naming the one that leaked rather than by a `toEqual` diff over the tree.
 *
 * `test/coding-standards/service-read-relations.spec.ts` is the property that
 * makes this file's list complete — a new `encryptedText` column on any of
 * these tables goes red there without anyone remembering to seed a marker here.
 */
const TOKEN = 'per-server-metrics-token';

/** Seeded values no other string in a response can collide with. */
const SECRETS = {
  metricsToken: TOKEN,
  sshPrivateKey: 'MARKER-ssh-key-private-half',
  githubWebhookSecret: 'MARKER-github-webhook-secret',
  githubClientSecret: 'MARKER-github-client-secret',
  githubPrivateKey: 'MARKER-github-app-private-key',
  gitlabSecret: 'MARKER-gitlab-application-secret',
  gitlabAccessToken: 'MARKER-gitlab-access-token',
  registryPassword: 'MARKER-registry-password',
  buildRegistryPassword: 'MARKER-build-registry-password',
} as const;

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** The alert an external metrics agent posts when a threshold is breached. */
const alert = (token: string) => ({
  ServerType: 'Remote',
  Type: 'CPU',
  Value: 99,
  Threshold: 80,
  Message: 'attacker-controlled alert text',
  Timestamp: '2026-09-07T12:00:00.000Z',
  Token: token,
});

/** Every string anywhere in a JSON response. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(stringsIn);
  }
  return [];
}

interface NestedServerBody {
  metricsConfig: { server: Record<string, unknown>; containers: unknown };
}

describe('A service read never serves its Server’s metrics token (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;

  const dispatcher = { dispatch: jest.fn() };
  const remoteExec = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
    execFileAsync: jest.fn(),
  };
  const traefikWriter = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
    writeCertificate: jest.fn(),
    removeCertificate: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: remoteExec },
        { provide: TraefikWriterService, useValue: traefikWriter },
        { provide: NotificationDispatcherService, useValue: dispatcher },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
  });

  interface Fixture {
    memberCookie: string;
    applicationId: string;
    composeId: string;
    postgresId: string;
    serverId: string;
    organizationId: string;
  }

  /**
   * One Server carrying a live token, one Application / Compose / Postgres on
   * it with every credential relation attached, and a **base member** granted
   * row-level access to all three and nothing else.
   *
   * The owner builds it over HTTP; the secrets themselves are written straight
   * to their columns afterwards, because what this file is about is what comes
   * back out of them and the marker has to be a value no route would accept.
   */
  async function setUp(): Promise<Fixture> {
    const signUp = await request(http)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(signUp.status).toBe(200);
    const cookie: string = signUp.headers['set-cookie'];

    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;

    const post = async (path: string, body: Record<string, unknown>) => {
      const res = await request(http)
        .post(path)
        .set('Cookie', cookie)
        .send(body);
      expect(res.status).toBe(201);
      return res.body as Record<string, string>;
    };

    const project = await post('/projects', { name: 'cloudgate' });
    const environment = await post('/environments', {
      name: 'production',
      projectId: project.projectId,
    });
    const environmentId = environment.environmentId;

    const sshKey = await post('/ssh-keys', { name: 'worker-key' });
    const worker = await post('/servers', {
      name: 'worker-1',
      ipAddress: '10.0.0.5',
      port: 22,
      username: 'root',
      sshKeyId: sshKey.sshKeyId,
    });
    const serverId = worker.serverId;

    const registry = await post('/registries', {
      name: 'pull',
      username: 'ci',
      password: SECRETS.registryPassword,
      url: '',
      registryType: 'cloud',
    });
    const buildRegistry = await post('/registries', {
      name: 'push',
      username: 'ci',
      password: SECRETS.buildRegistryPassword,
      url: '',
      registryType: 'cloud',
    });
    const github = await post('/github', { name: 'gh' });
    const gitlab = await post('/gitlab', { name: 'gl' });

    const application = await post('/applications', {
      name: 'Blog',
      appName: 'blog-1',
      environmentId,
      serverId,
    });
    const compose = await post('/compose', {
      name: 'Stack',
      appName: 'stack-1',
      environmentId,
      serverId,
    });
    const postgres = await post('/postgres', {
      name: 'Db',
      appName: 'db-1',
      databaseName: 'blog',
      databaseUser: 'blog',
      environmentId,
      serverId,
    });

    // Everything the read loads as a relation, attached through the routes that
    // resolve each id inside the organization.
    const attach = async (path: string, body: Record<string, unknown>) => {
      const res = await request(http)
        .patch(path)
        .set('Cookie', cookie)
        .send(body);
      expect(res.status).toBe(200);
    };
    await attach(`/applications/${application.applicationId}`, {
      customGitSSHKeyId: sshKey.sshKeyId,
      registryId: registry.registryId,
      buildRegistryId: buildRegistry.registryId,
      githubId: github.githubId,
      gitlabId: gitlab.gitlabId,
      buildServerId: serverId,
    });
    await attach(`/compose/${compose.composeId}`, {
      customGitSSHKeyId: sshKey.sshKeyId,
      githubId: github.githubId,
      gitlabId: gitlab.gitlabId,
    });

    // The secrets, written at their columns. `metricsConfig` goes through the
    // column rather than through `POST /monitoring/servers/:id/setup` because
    // that write registers this host's collection intervals as a side effect,
    // and the disclosure does not depend on them existing.
    await ctx.db
      .update(schema.server)
      .set({
        metricsConfig: {
          ...defaultMetricsConfig,
          server: { ...defaultMetricsConfig.server, token: TOKEN },
        },
      })
      .where(eq(schema.server.serverId, serverId));
    await ctx.db
      .update(schema.sshKey)
      .set({ privateKey: SECRETS.sshPrivateKey })
      .where(eq(schema.sshKey.sshKeyId, sshKey.sshKeyId));
    await ctx.db
      .update(schema.github)
      .set({
        webhookSecret: SECRETS.githubWebhookSecret,
        clientSecret: SECRETS.githubClientSecret,
        privateKey: SECRETS.githubPrivateKey,
      })
      .where(eq(schema.github.githubId, github.githubId));
    await ctx.db
      .update(schema.gitlab)
      .set({
        secret: SECRETS.gitlabSecret,
        accessToken: SECRETS.gitlabAccessToken,
      })
      .where(eq(schema.gitlab.gitlabId, gitlab.gitlabId));

    const member = await signUpMember(http, cookie);
    await ctx.db
      .update(schema.member)
      .set({
        accessedServices: [
          application.applicationId,
          compose.composeId,
          postgres.postgresId,
        ],
      })
      .where(eq(schema.member.userId, member.id));

    return {
      memberCookie: member.cookie,
      applicationId: application.applicationId,
      composeId: compose.composeId,
      postgresId: postgres.postgresId,
      serverId,
      organizationId,
    };
  }

  /** The three reads the nested `server` relation reaches a base member on. */
  const reads = (fixture: Fixture) =>
    [
      ['GET /applications/:id', `/applications/${fixture.applicationId}`],
      ['GET /compose/:id', `/compose/${fixture.composeId}`],
      // One of six engines; all six are `BaseDatabaseService.findOne`, and the
      // coding-standards property is what covers the other five.
      ['GET /postgres/:id', `/postgres/${fixture.postgresId}`],
    ] as const;

  async function read(cookie: string, path: string): Promise<unknown> {
    const res = await request(http).get(path).set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body;
  }

  it('tells the member a token is set without handing over the token', async () => {
    const fixture = await setUp();

    for (const [label, path] of reads(fixture)) {
      const body = (await read(fixture.memberCookie, path)) as {
        server: NestedServerBody | null;
        buildServer?: NestedServerBody | null;
      };

      const nested = [body.server, body.buildServer].filter(
        (row): row is NestedServerBody => Boolean(row),
      );
      // The premise: this read really does carry a `server` relation, so an
      // absent one cannot be what makes the assertion below pass.
      expect({ label, servers: nested.length > 0 }).toEqual({
        label,
        servers: true,
      });

      for (const row of nested) {
        // Absent, not `undefined`-valued: `in` is the difference between a
        // projection and a key whose value happens to be empty.
        expect({ label, carries: 'token' in row.metricsConfig.server }).toEqual(
          { label, carries: false },
        );
        // …and the one fact the console's `isCollecting` reads stands where the
        // field stood (ADR 0019), so the per-Server collecting switch survives
        // the projection.
        expect({ label, hasToken: row.metricsConfig.server.hasToken }).toEqual({
          label,
          hasToken: true,
        });
        // Everything else the config carries is untouched: this is a
        // projection of one field, not of the blob.
        expect({
          label,
          refreshRate: row.metricsConfig.server.refreshRate,
          containers: row.metricsConfig.containers,
        }).toEqual({
          label,
          refreshRate: defaultMetricsConfig.server.refreshRate,
          containers: defaultMetricsConfig.containers,
        });
      }
    }
  });

  it('says no token is set on a Server nobody has set monitoring up on', async () => {
    const fixture = await setUp();
    // `defaultMetricsConfig` ships `token: ''`, which is what "never set up"
    // means to `registerTarget` and to `authenticatesMetricsAgent`. Empty has
    // to read as *false* rather than as "a token exists whose value we
    // withheld", or the switch inverts on every un-set-up host.
    await ctx.db
      .update(schema.server)
      .set({ metricsConfig: defaultMetricsConfig })
      .where(eq(schema.server.serverId, fixture.serverId));

    const body = (await read(
      fixture.memberCookie,
      `/applications/${fixture.applicationId}`,
    )) as { server: NestedServerBody };

    expect(body.server.metricsConfig.server).not.toHaveProperty('token');
    expect(body.server.metricsConfig.server.hasToken).toBe(false);
  });

  it('hands the member no stored secret anywhere in any of the three reads', async () => {
    const fixture = await setUp();

    for (const [label, path] of reads(fixture)) {
      const harvested = stringsIn(await read(fixture.memberCookie, path));
      expect({ label, harvested: harvested.length > 0 }).toEqual({
        label,
        harvested: true,
      });

      // Named rather than diffed: the failure says *which* secret came back.
      expect({
        label,
        leaked: Object.entries(SECRETS)
          .filter(([, secret]) => harvested.includes(secret))
          .map(([name]) => name),
      }).toEqual({ label, leaked: [] });
    }
  });

  it('cannot turn any of the three reads into an alert in its organization', async () => {
    const fixture = await setUp();

    for (const [label, path] of reads(fixture)) {
      const harvested = stringsIn(await read(fixture.memberCookie, path));
      expect({ label, harvested: harvested.length > 0 }).toEqual({
        label,
        harvested: true,
      });

      const accepted: string[] = [];
      for (const candidate of harvested) {
        const attack = await request(http)
          .post('/notifications/receive')
          .send(alert(candidate));
        if (attack.status !== 400) accepted.push(candidate);
      }
      // Every string in the body is refused — asserted as a list so a failure
      // prints what authenticated rather than a bare status.
      expect({ label, accepted }).toEqual({ label, accepted: [] });
    }

    // The harm, asserted where it would land: the Remote branch dispatches into
    // `found.organizationId`, which is every channel this organization has.
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('positive control: the real token does reach the organization’s channels', async () => {
    // Without this the assertions above would pass against a receive route that
    // refused everybody, a broken dispatcher, or a token that was never stored.
    // This is the attack, run with the value the member could not get.
    const fixture = await setUp();

    const accepted = await request(http)
      .post('/notifications/receive')
      .send(alert(TOKEN));

    expect(accepted.status).toBe(204);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(fixture.organizationId, {
      type: 'server-threshold',
      serverName: 'Remote',
      metric: 'CPU',
      value: 99,
      threshold: 80,
      message: 'attacker-controlled alert text',
      timestamp: '2026-09-07T12:00:00.000Z',
    });
  });

  it('still answers GET /servers/:id with the token, for the operator who rotates it', async () => {
    // The asymmetry the fix deliberately leaves: `server:read` is owner/admin or a
    // licensed custom role, and the console's setup modal writes this value.
    // Asserted so the projection cannot quietly spread to that route and be
    // read as intended — see `endpoints/servers.ts`, which is the console-side
    // statement of the same split.
    const fixture = await setUp();
    const signIn = await request(http)
      .post('/api/auth/sign-in/email')
      .send({ email: owner.email, password: owner.password });
    expect(signIn.status).toBe(200);

    const res = await request(http)
      .get(`/servers/${fixture.serverId}`)
      .set('Cookie', signIn.headers['set-cookie']);

    expect(res.status).toBe(200);
    expect((res.body as NestedServerBody).metricsConfig.server.token).toBe(
      TOKEN,
    );
  });
});
