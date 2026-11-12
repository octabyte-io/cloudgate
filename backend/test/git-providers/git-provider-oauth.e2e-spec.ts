import request from 'supertest';
import { App } from 'supertest/types';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import type { FetchClient } from '../../src/git-providers/fetch.provider';
import { GiteaService } from '../../src/git-providers/strategies/gitea/gitea.service';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import { OCTOKIT_FACTORY } from '../../src/git-providers/strategies/github/octokit.provider';
import { GitlabService } from '../../src/git-providers/strategies/gitlab/gitlab.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** The route prefix every OAuth handshake lives under. */
const OAUTH = '/git-providers/oauth';

/**
 * The console's own request, as it reaches the backend in the shipped shape:
 * the browser calls the console's origin under `/backend`, and the console's
 * rewrite proxies it here with the prefix stripped, stamping the host the
 * browser used. The callback and webhook URLs handed to a provider are
 * derived from exactly these — no environment key names this instance's
 * public origin.
 */
const CONSOLE_ORIGIN = 'https://console.example.com';
/** Where the console serves this backend: its origin plus its `/backend` rewrite. */
const PROVIDER_BASE = `${CONSOLE_ORIGIN}/backend`;

const asConsole = (req: request.Test): request.Test =>
  req
    .set('Origin', CONSOLE_ORIGIN)
    .set('X-Forwarded-Proto', 'https')
    .set('X-Forwarded-Host', 'console.example.com');

/**
 * The backend route a provider-facing URL reaches, or a failed expectation if
 * the URL is not on the console's `/backend` prefix at all — the one address
 * every install shape publishes for this backend.
 */
function backendPathOf(url: string): string {
  expect(url.startsWith(`${PROVIDER_BASE}/`)).toBe(true);
  const parsed = new URL(url);
  return parsed.pathname.slice('/backend'.length) + parsed.search;
}

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

/** What GitHub answers `POST /app-manifests/{code}/conversions` with. */
const CONVERSION = {
  id: 424242,
  slug: 'cloudgate-acme',
  client_id: 'Iv1.manifest-client',
  client_secret: 'manifest-client-secret',
  webhook_secret: 'manifest-webhook-secret',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEmanifest\n-----END RSA PRIVATE KEY-----',
};

describe('Git provider OAuth handshakes (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let githubService: GithubService;
  let gitlabService: GitlabService;
  let giteaService: GiteaService;

  /**
   * Every provider's HTTP surface is a system boundary. This routes by URL and
   * records what was sent, so a test can assert *which* host the exchange went
   * to as well as what came back — the internal-vs-public URL distinction is a
   * real bug source here.
   */
  let routes: Array<{
    match: RegExp;
    ok?: boolean;
    statusText?: string;
    /** A `(href) => unknown` function when the answer depends on the URL. */
    body?: unknown;
  }>;
  let calls: Array<{ url: string; method?: string; body?: string }>;

  const stubFetch = ((url: string, init?: RequestInit) => {
    const href = url;
    calls.push({
      url: href,
      method: init?.method,
      // Every grant in this flow sends a URLSearchParams body.
      body:
        init?.body instanceof URLSearchParams
          ? init.body.toString()
          : undefined,
    });
    const route = routes.find((r) => r.match.test(href));
    if (!route) {
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: `no stub for ${href}`,
        headers: new Headers(),
        json: () => Promise.resolve({}),
      } as Response);
    }
    const body =
      typeof route.body === 'function'
        ? (route.body as (href: string) => unknown)(href)
        : route.body;
    return Promise.resolve({
      ok: route.ok ?? true,
      status: route.ok === false ? 400 : 200,
      statusText: route.statusText ?? 'OK',
      headers: new Headers(),
      json: () => Promise.resolve(body ?? {}),
    } as Response);
  }) as FetchClient;

  const stubOctokit = {
    rest: {
      apps: { listReposAccessibleToInstallation: 'repos-endpoint' },
      repos: { listBranches: 'branches-endpoint' },
    },
    auth: () => Promise.resolve({ token: 'ghs_stub-token' }),
    paginate: () =>
      Promise.resolve([
        {
          name: 'cloudgate',
          owner: { login: 'octabyte-io' },
          html_url: 'https://github.com/octabyte-io/cloudgate',
          default_branch: 'main',
        },
      ]),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: FETCH_CLIENT, useValue: stubFetch },
        { provide: OCTOKIT_FACTORY, useValue: () => stubOctokit },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    githubService = ctx.app.get(GithubService);
    gitlabService = ctx.app.get(GitlabService);
    giteaService = ctx.app.get(GiteaService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    calls = [];
    routes = [
      {
        match: /api\.github\.com\/app-manifests\/.*\/conversions/,
        body: CONVERSION,
      },
      {
        match: /\/oauth\/token$/,
        body: {
          access_token: 'gl-access-token',
          refresh_token: 'gl-refresh-token',
          expires_in: 7200,
        },
      },
      {
        match: /\/login\/oauth\/access_token$/,
        body: {
          access_token: 'gt-access-token',
          refresh_token: 'gt-refresh-token',
          expires_in: 3600,
        },
      },
      // GitLab's projects listing, so a connected row can be shown to work.
      // Paginated: `fetchAllPages` walks until a page comes back empty, and a
      // stub that answers every page identically never terminates.
      {
        match: /\/api\/v4\/projects/,
        body: (href: string) =>
          href.includes('page=1&')
            ? [
                {
                  id: 7,
                  name: 'cloudgate',
                  path_with_namespace: 'grace/cloudgate',
                  default_branch: 'main',
                  namespace: {
                    path: 'grace',
                    full_path: 'grace',
                    kind: 'user',
                  },
                },
              ]
            : [],
      },
      { match: /\/api\/v1\/user\/repos/, body: [] },
    ];
  });

  // ------------------------------------------------------------- GitHub App

  describe('GitHub App manifest conversion', () => {
    async function startManifest(cookie: string, body?: object) {
      const res = await asConsole(
        request(server).post(`${OAUTH}/github/manifest`).set('Cookie', cookie),
      ).send({ name: 'Acme on GitHub', ...body });
      expect(res.status).toBe(200);
      return res.body as {
        githubId: string;
        gitProviderId: string;
        state: string;
        action: string;
        manifest: Record<string, unknown>;
      };
    }

    it('hands the console a manifest addressed at this backend’s own routes, and a github.com form to post it to', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const started = await startManifest(ownerSession.cookie);

      // The console's origin through its `/backend` rewrite, with the
      // install return GitHub never made before.
      expect(started.manifest).toMatchObject({
        name: 'Acme on GitHub',
        redirect_url: `${PROVIDER_BASE}${OAUTH}/github/setup`,
        setup_url: `${PROVIDER_BASE}${OAUTH}/github/callback`,
        setup_on_update: false,
        callback_urls: [`${PROVIDER_BASE}${OAUTH}/github/callback`],
        hook_attributes: { url: `${PROVIDER_BASE}/github/webhook` },
        url: `${CONSOLE_ORIGIN}/settings/git-providers`,
        public: false,
      });
      expect(started.action).toBe(
        `https://github.com/settings/apps/new?state=${started.state}`,
      );
      // The state is not the connection's own id, which is what makes a
      // callback for it unforgeable by anyone who has seen the id.
      expect(started.state).not.toBe(started.githubId);
      expect(started.state).not.toBe(started.gitProviderId);

      // The connection exists already, empty, ready to receive credentials.
      const listed = await request(server)
        .get('/github')
        .set('Cookie', ownerSession.cookie);
      expect(listed.body as unknown[]).toHaveLength(1);
      expect((listed.body as { appId: number | null }[])[0].appId).toBeNull();
    });

    it('posts the manifest form to the organization’s app page when an organization is named', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const started = await startManifest(ownerSession.cookie, {
        organizationName: 'octabyte',
        appName: 'cloudgate-octabyte',
      });

      expect(started.action).toBe(
        `https://github.com/organizations/octabyte/settings/apps/new?state=${started.state}`,
      );
      expect(started.manifest).toMatchObject({ name: 'cloudgate-octabyte' });
    });

    it('converts the code into every credential the paste-them-in flow asked a human for, encrypted at rest', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const started = await startManifest(ownerSession.cookie);

      const setup = await request(server)
        .get(`${OAUTH}/github/setup`)
        .query({ code: 'conversion-code', state: started.state });

      expect(setup.status).toBe(302);
      // On to installing the app that now exists, under a *fresh* state.
      const location = new URL(setup.headers.location);
      expect(location.origin + location.pathname).toBe(
        'https://github.com/apps/cloudgate-acme/installations/new',
      );
      const installState = location.searchParams.get('state');
      expect(installState).toEqual(expect.any(String));
      expect(installState).not.toBe(started.state);

      // The conversion request itself.
      const conversion = calls.find((c) => c.url.includes('app-manifests'));
      expect(conversion?.url).toBe(
        'https://api.github.com/app-manifests/conversion-code/conversions',
      );
      expect(conversion?.method).toBe('POST');

      const one = await request(server)
        .get(`/github/${started.githubId}`)
        .set('Cookie', ownerSession.cookie);
      expect(one.body).toMatchObject({
        appId: CONVERSION.id,
        appName: CONVERSION.slug,
        clientId: CONVERSION.client_id,
      });
      // Nothing sanitize() strips comes back, as ever.
      expect(one.body).not.toHaveProperty('privateKey');
      expect(one.body).not.toHaveProperty('clientSecret');
      expect(one.body).not.toHaveProperty('webhookSecret');

      const raw = await ctx.db.$client.query<{
        private_key: string;
        client_secret: string;
        webhook_secret: string;
      }>(
        'select private_key, client_secret, webhook_secret from github where github_id = $1',
        [started.githubId],
      );
      expect(raw.rows[0].private_key).not.toContain('MIIEmanifest');
      expect(raw.rows[0].private_key.startsWith('enc:v1:')).toBe(true);
      expect(raw.rows[0].client_secret.startsWith('enc:v1:')).toBe(true);
      expect(raw.rows[0].webhook_secret.startsWith('enc:v1:')).toBe(true);
    });

    it('records the installation id on the install callback and returns the browser to the console', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const started = await startManifest(ownerSession.cookie);
      // Driven through the manifest's own URLs rather than this file's idea of
      // them: GitHub redirects to `redirect_url`, then — after Install — to
      // `setup_url`, with exactly these three parameters.
      const setup = await request(server)
        .get(backendPathOf(started.manifest.redirect_url as string))
        .query({ code: 'conversion-code', state: started.state });
      const installState = new URL(setup.headers.location).searchParams.get(
        'state',
      ) as string;

      const callback = await request(server)
        .get(backendPathOf(started.manifest.setup_url as string))
        .query({
          installation_id: '55443322',
          setup_action: 'install',
          state: installState,
        });

      expect(callback.status).toBe(302);
      expect(callback.headers.location).toBe(
        `${CONSOLE_ORIGIN}/settings/git-providers?connected=github`,
      );

      const one = await request(server)
        .get(`/github/${started.githubId}`)
        .set('Cookie', ownerSession.cookie);
      expect(one.body).toMatchObject({ installationId: '55443322' });
    });

    it('produces a connection the shipped GitHub consumers accept, with no value ever pasted in', async () => {
      // The point of the whole flow: `getGithubToken` demands an appId, a
      // private key and an installationId, and refuses without all three.
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const started = await startManifest(ownerSession.cookie);
      const setup = await request(server)
        .get(`${OAUTH}/github/setup`)
        .query({ code: 'conversion-code', state: started.state });
      const installState = new URL(setup.headers.location).searchParams.get(
        'state',
      ) as string;
      await request(server)
        .get(`${OAUTH}/github/callback`)
        .query({ installation_id: '55443322', state: installState });

      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const repositories = await githubService.listRepositoriesFor(
        ownerCtx,
        started.githubId,
      );
      expect(repositories).toEqual([
        {
          name: 'cloudgate',
          owner: 'octabyte-io',
          url: 'https://github.com/octabyte-io/cloudgate',
          // Read off GitHub's `default_branch`.
          defaultBranch: 'main',
        },
      ]);

      // And a webhook delivery can now find the connection by installation id.
      const found = await githubService.findByInstallationId('55443322');
      expect(found?.githubId).toBe(started.githubId);
      expect(found?.webhookSecret).toBe(CONVERSION.webhook_secret);
    });

    it('refuses an unknown state, a replayed state and a state issued for the other leg', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const started = await startManifest(ownerSession.cookie);

      const unknown = await request(server)
        .get(`${OAUTH}/github/setup`)
        .query({ code: 'c', state: 'never-issued' });
      expect(unknown.status).toBe(400);

      // A manifest state is not an install state, however fresh it is.
      const wrongLeg = await request(server)
        .get(`${OAUTH}/github/callback`)
        .query({ installation_id: '1', state: started.state });
      expect(wrongLeg.status).toBe(400);
      // …and asking wrongly still burned it, so it cannot be reused after.
      const afterWrongLeg = await request(server)
        .get(`${OAUTH}/github/setup`)
        .query({ code: 'c', state: started.state });
      expect(afterWrongLeg.status).toBe(400);

      // A fresh handshake, completed once, cannot be completed twice.
      const second = await startManifest(ownerSession.cookie, {
        name: 'Second',
      });
      const first = await request(server)
        .get(`${OAUTH}/github/setup`)
        .query({ code: 'conversion-code', state: second.state });
      expect(first.status).toBe(302);
      const replay = await request(server)
        .get(`${OAUTH}/github/setup`)
        .query({ code: 'conversion-code', state: second.state });
      expect(replay.status).toBe(400);
    });

    it('refuses a state that has expired while the user was at the provider', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const started = await startManifest(ownerSession.cookie);

      await ctx.db.$client.query(
        'update git_provider_oauth_state set expires_at = $1 where state = $2',
        [Math.floor(Date.now() / 1000) - 1, started.state],
      );

      const res = await request(server)
        .get(`${OAUTH}/github/setup`)
        .query({ code: 'conversion-code', state: started.state });
      expect(res.status).toBe(400);
    });

    it('refuses when GitHub rejects the conversion, and when it answers without a private key', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const rejected = await startManifest(ownerSession.cookie);
      routes[0] = {
        match: /app-manifests/,
        ok: false,
        statusText: 'Unprocessable Entity',
      };
      const refused = await request(server)
        .get(`${OAUTH}/github/setup`)
        .query({ code: 'stale-code', state: rejected.state });
      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toContain(
        'Unprocessable Entity',
      );

      // A conversion with no `pem` is unrecoverable: GitHub mints the private
      // key once and never shows it again.
      const partial = await startManifest(ownerSession.cookie, {
        name: 'Partial',
      });
      routes[0] = {
        match: /app-manifests/,
        body: { id: 1, slug: 'x' },
      };
      const incomplete = await request(server)
        .get(`${OAUTH}/github/setup`)
        .query({ code: 'c', state: partial.state });
      expect(incomplete.status).toBe(400);
    });

    it('needs a session to start, and never to finish', async () => {
      await setUpOwner(server);

      const anonymous = await asConsole(
        request(server).post(`${OAUTH}/github/manifest`),
      ).send({ name: 'Nope' });
      expect(anonymous.status).toBe(401);

      // The return legs are unauthenticated by necessity — GitHub redirects a
      // browser to them — so they answer 400 (bad state) rather than 401.
      const callback = await request(server)
        .get(`${OAUTH}/github/setup`)
        .query({ code: 'c', state: 'never-issued' });
      expect(callback.status).toBe(400);
    });
  });

  // ------------------------------------------------------------------ GitLab

  describe('GitLab authorization code grant', () => {
    /** An OAuth application registered at GitLab, with no grant yet. */
    const gitlabApp = {
      name: 'Acme on GitLab',
      gitlabUrl: 'https://gitlab.example.com',
      applicationId: 'gitlab-application-id',
      secret: 'gitlab-application-secret',
    };

    it('sends the browser to GitLab and writes back the callback URL that has to be registered there', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await gitlabService.create(ownerCtx, gitlabApp);

      const res = await asConsole(
        request(server)
          .post(`${OAUTH}/gitlab/${created.gitlabId}/authorize`)
          .set('Cookie', ownerSession.cookie),
      );
      expect(res.status).toBe(200);
      const started = res.body as {
        state: string;
        url: string;
        redirectUri: string;
      };

      const url = new URL(started.url);
      expect(url.origin + url.pathname).toBe(
        'https://gitlab.example.com/oauth/authorize',
      );
      expect(url.searchParams.get('client_id')).toBe('gitlab-application-id');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('state')).toBe(started.state);
      expect(url.searchParams.get('scope')).toBe(
        'api read_user read_repository',
      );
      expect(url.searchParams.get('redirect_uri')).toBe(started.redirectUri);
      expect(started.redirectUri).toBe(
        `${PROVIDER_BASE}${OAUTH}/gitlab/callback`,
      );

      // Persisted, because the OAuth application at GitLab has to have this
      // exact value registered and until now nothing said what it was.
      const one = await gitlabService.findOne(ownerCtx, created.gitlabId);
      expect(one.redirectUri).toBe(started.redirectUri);
    });

    it('keeps a redirect URI already stored on the connection rather than overwriting it', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await gitlabService.create(ownerCtx, {
        ...gitlabApp,
        redirectUri: 'https://legacy.example.com/api/providers/gitlab/callback',
      });

      const res = await asConsole(
        request(server)
          .post(`${OAUTH}/gitlab/${created.gitlabId}/authorize`)
          .set('Cookie', ownerSession.cookie),
      );

      expect((res.body as { redirectUri: string }).redirectUri).toBe(
        'https://legacy.example.com/api/providers/gitlab/callback',
      );
    });

    it('replaces the unanswerable callback URL it used to write itself, on the console without /backend', async () => {
      // What an earlier install stored on every connection authorized while the
      // derivation ignored the console's prefix: the console answers it with
      // its sign-in redirect or its 404 page, so no handshake ever finished.
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await gitlabService.create(ownerCtx, {
        ...gitlabApp,
        redirectUri: `${CONSOLE_ORIGIN}${OAUTH}/gitlab/callback`,
      });

      const res = await asConsole(
        request(server)
          .post(`${OAUTH}/gitlab/${created.gitlabId}/authorize`)
          .set('Cookie', ownerSession.cookie),
      );

      const redirectUri = (res.body as { redirectUri: string }).redirectUri;
      expect(redirectUri).toBe(`${PROVIDER_BASE}${OAUTH}/gitlab/callback`);
      expect(
        (await gitlabService.findOne(ownerCtx, created.gitlabId)).redirectUri,
      ).toBe(redirectUri);
    });

    it('records the token pair and the expiry, which is what makes a GitLab connection usable at all', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await gitlabService.create(ownerCtx, gitlabApp);

      // Before the grant: `refreshToken` runs the refresh grant unconditionally
      // because `expiresAt` is null, and throws when it fails. This is the
      // "GitLab cannot be connected by pasting credentials" bug.
      expect(
        await gitlabService.findOne(ownerCtx, created.gitlabId),
      ).toMatchObject({ expiresAt: null });

      const start = await asConsole(
        request(server)
          .post(`${OAUTH}/gitlab/${created.gitlabId}/authorize`)
          .set('Cookie', ownerSession.cookie),
      );
      const { state, redirectUri } = start.body as {
        state: string;
        redirectUri: string;
      };

      const before = Math.floor(Date.now() / 1000);
      const callback = await request(server)
        .get(`${OAUTH}/gitlab/callback`)
        .query({ code: 'gitlab-auth-code', state });

      expect(callback.status).toBe(302);
      expect(callback.headers.location).toBe(
        `${CONSOLE_ORIGIN}/settings/git-providers?connected=gitlab`,
      );

      // The exchange repeated the redirect_uri verbatim, which GitLab compares.
      const exchange = calls.find((c) => c.url.endsWith('/oauth/token'));
      const form = new URLSearchParams(exchange?.body ?? '');
      expect(Object.fromEntries(form)).toEqual({
        grant_type: 'authorization_code',
        code: 'gitlab-auth-code',
        client_id: 'gitlab-application-id',
        client_secret: 'gitlab-application-secret',
        redirect_uri: redirectUri,
      });

      const one = await gitlabService.findOne(ownerCtx, created.gitlabId);
      expect(one.expiresAt).toBeGreaterThanOrEqual(before + 7200);
      expect(one.expiresAt).toBeLessThanOrEqual(before + 7200 + 30);
      // Both tokens are stripped from the response and encrypted at rest.
      expect(one).not.toHaveProperty('accessToken');
      const raw = await ctx.db.$client.query<{
        access_token: string;
        refresh_token: string;
      }>(
        'select access_token, refresh_token from gitlab where gitlab_id = $1',
        [created.gitlabId],
      );
      expect(raw.rows[0].access_token).not.toContain('gl-access-token');
      expect(raw.rows[0].access_token.startsWith('enc:v1:')).toBe(true);
      expect(raw.rows[0].refresh_token.startsWith('enc:v1:')).toBe(true);

      // And now the consumer works: a listing that would have thrown before.
      const repositories = await gitlabService.listRepositoriesFor(
        ownerCtx,
        created.gitlabId,
      );
      expect(repositories).toEqual([
        {
          id: 7,
          name: 'cloudgate',
          owner: 'grace',
          pathNamespace: 'grace/cloudgate',
          // Read off GitLab's `default_branch`.
          defaultBranch: 'main',
        },
      ]);
    });

    it('sends the browser to the public URL and exchanges the code over the internal one', async () => {
      // A self-hosted GitLab on a private address: the browser cannot reach it,
      // and the server should prefer it. Getting this the wrong way round is
      // silent until someone actually runs it behind a private network.
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await gitlabService.create(ownerCtx, {
        ...gitlabApp,
        gitlabInternalUrl: 'http://gitlab.internal:8080',
      });

      const start = await asConsole(
        request(server)
          .post(`${OAUTH}/gitlab/${created.gitlabId}/authorize`)
          .set('Cookie', ownerSession.cookie),
      );
      const { state, url } = start.body as { state: string; url: string };
      expect(url.startsWith('https://gitlab.example.com/oauth/authorize')).toBe(
        true,
      );

      await request(server)
        .get(`${OAUTH}/gitlab/callback`)
        .query({ code: 'c', state });

      const exchange = calls.find((c) => c.url.endsWith('/oauth/token'));
      expect(exchange?.url).toBe('http://gitlab.internal:8080/oauth/token');
    });

    it('refuses to start without the OAuth application credentials, and refuses a rejected exchange', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const bare = await gitlabService.create(ownerCtx, {
        name: 'Nothing pasted yet',
      });
      const noApp = await asConsole(
        request(server)
          .post(`${OAUTH}/gitlab/${bare.gitlabId}/authorize`)
          .set('Cookie', ownerSession.cookie),
      );
      expect(noApp.status).toBe(400);
      expect((noApp.body as { message: string }).message).toContain(
        'application ID and secret',
      );

      const created = await gitlabService.create(ownerCtx, gitlabApp);
      const start = await asConsole(
        request(server)
          .post(`${OAUTH}/gitlab/${created.gitlabId}/authorize`)
          .set('Cookie', ownerSession.cookie),
      );
      const { state } = start.body as { state: string };

      routes[1] = {
        match: /\/oauth\/token$/,
        ok: false,
        statusText: 'invalid_grant',
      };
      const failed = await request(server)
        .get(`${OAUTH}/gitlab/callback`)
        .query({ code: 'reused-code', state });
      expect(failed.status).toBe(400);
      expect((failed.body as { message: string }).message).toContain(
        'invalid_grant',
      );

      // A failed exchange still burned the state: no retry on the same code.
      const retry = await request(server)
        .get(`${OAUTH}/gitlab/callback`)
        .query({ code: 'reused-code', state });
      expect(retry.status).toBe(400);

      // And nothing was written.
      const one = await gitlabService.findOne(ownerCtx, created.gitlabId);
      expect(one.expiresAt).toBeNull();
    });

    it('cannot start a handshake for a connection in another organization', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;
      const foreign = await gitlabService.create(
        permissionCtx(ownerSession.id, secondOrgId),
        gitlabApp,
      );

      // The cookie's active organization is still the first one.
      const res = await asConsole(
        request(server)
          .post(`${OAUTH}/gitlab/${foreign.gitlabId}/authorize`)
          .set('Cookie', ownerSession.cookie),
      );
      expect(res.status).toBe(404);
    });
  });

  // ------------------------------------------------------------------- Gitea

  describe('Gitea authorization code grant', () => {
    const giteaApp = {
      name: 'Acme on Gitea',
      giteaUrl: 'https://gitea.example.com',
      clientId: 'gitea-client-id',
      clientSecret: 'gitea-client-secret',
    };

    it('space-delimits the scopes the column stores comma-joined', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await giteaService.create(ownerCtx, giteaApp);

      const res = await asConsole(
        request(server)
          .post(`${OAUTH}/gitea/${created.giteaId}/authorize`)
          .set('Cookie', ownerSession.cookie),
      );
      expect(res.status).toBe(200);
      const url = new URL((res.body as { url: string }).url);

      expect(url.origin + url.pathname).toBe(
        'https://gitea.example.com/login/oauth/authorize',
      );
      // The column's default is `repo,repo:status,read:user,read:org`; OAuth 2
      // delimits scopes with spaces, and Gitea reads the comma form as one.
      expect(url.searchParams.get('scope')).toBe(
        'repo repo:status read:user read:org',
      );
    });

    it('records the token pair, the expiry and the authentication time', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await giteaService.create(ownerCtx, giteaApp);

      const start = await asConsole(
        request(server)
          .post(`${OAUTH}/gitea/${created.giteaId}/authorize`)
          .set('Cookie', ownerSession.cookie),
      );
      const { state } = start.body as { state: string };

      const before = Math.floor(Date.now() / 1000);
      const callback = await request(server)
        .get(`${OAUTH}/gitea/callback`)
        .query({ code: 'gitea-auth-code', state });

      expect(callback.status).toBe(302);
      expect(callback.headers.location).toBe(
        `${CONSOLE_ORIGIN}/settings/git-providers?connected=gitea`,
      );

      const exchange = calls.find((c) =>
        c.url.endsWith('/login/oauth/access_token'),
      );
      expect(exchange?.url).toBe(
        'https://gitea.example.com/login/oauth/access_token',
      );
      expect(
        Object.fromEntries(new URLSearchParams(exchange?.body ?? '')),
      ).toMatchObject({
        grant_type: 'authorization_code',
        code: 'gitea-auth-code',
      });

      const one = await giteaService.findOne(ownerCtx, created.giteaId);
      expect(one.expiresAt).toBeGreaterThanOrEqual(before + 3600);
      // `lastAuthenticatedAt` exists on the row and nothing was ever writing it.
      expect(one.lastAuthenticatedAt).toBeGreaterThanOrEqual(before);

      const raw = await ctx.db.$client.query<{ access_token: string }>(
        'select access_token from gitea where gitea_id = $1',
        [created.giteaId],
      );
      expect(raw.rows[0].access_token.startsWith('enc:v1:')).toBe(true);
    });

    it('refuses a Gitea state replayed against the GitLab callback', async () => {
      // Both are the `authorize` leg; only the provider kind separates them.
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await giteaService.create(ownerCtx, giteaApp);

      const start = await asConsole(
        request(server)
          .post(`${OAUTH}/gitea/${created.giteaId}/authorize`)
          .set('Cookie', ownerSession.cookie),
      );
      const { state } = start.body as { state: string };

      const crossed = await request(server)
        .get(`${OAUTH}/gitlab/callback`)
        .query({ code: 'c', state });
      expect(crossed.status).toBe(400);
    });
  });

  describe('every URL handed to a provider is one this install serves', () => {
    it('reaches a route of this backend through the console’s /backend rewrite, for all three providers', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const manifestRes = await asConsole(
        request(server)
          .post(`${OAUTH}/github/manifest`)
          .set('Cookie', ownerSession.cookie),
      ).send({ name: 'Acme on GitHub' });
      const manifest = (
        manifestRes.body as {
          manifest: {
            redirect_url: string;
            setup_url: string;
            callback_urls: string[];
            hook_attributes: { url: string };
          };
        }
      ).manifest;

      const gitlabRow = await gitlabService.create(ownerCtx, {
        name: 'Acme on GitLab',
        gitlabUrl: 'https://gitlab.example.com',
        applicationId: 'gitlab-application-id',
        secret: 'gitlab-application-secret',
      });
      const giteaRow = await giteaService.create(ownerCtx, {
        name: 'Acme on Gitea',
        giteaUrl: 'https://gitea.example.com',
        clientId: 'gitea-client-id',
        clientSecret: 'gitea-client-secret',
      });
      const authorize = async (kind: string, id: string) => {
        const res = await asConsole(
          request(server)
            .post(`${OAUTH}/${kind}/${id}/authorize`)
            .set('Cookie', ownerSession.cookie),
        );
        const { url, redirectUri } = res.body as {
          url: string;
          redirectUri: string;
        };
        // The authorize page is told the same callback it is returned with.
        expect(new URL(url).searchParams.get('redirect_uri')).toBe(redirectUri);
        return redirectUri;
      };

      // Browser redirects arrive as GETs; GitHub's deliveries as POSTs.
      const handed: Array<{ url: string; method: 'get' | 'post' }> = [
        { url: manifest.redirect_url, method: 'get' },
        { url: manifest.setup_url, method: 'get' },
        ...manifest.callback_urls.map((url) => ({
          url,
          method: 'get' as const,
        })),
        { url: manifest.hook_attributes.url, method: 'post' },
        {
          url: await authorize('gitlab', gitlabRow.gitlabId),
          method: 'get',
        },
        { url: await authorize('gitea', giteaRow.giteaId), method: 'get' },
      ];
      expect(handed).toHaveLength(6);

      for (const { url, method } of handed) {
        // Unauthenticated, as a provider arrives: a route that exists refuses
        // the missing query or signature; one that does not is Nest's 404.
        const res = await request(server)[method](backendPathOf(url));
        expect({ url, status: res.status }).toEqual({
          url,
          status: method === 'post' ? 401 : 400,
        });
      }
    });
  });

  describe('a same-site page cannot choose where a provider sends its secrets', () => {
    it('ignores a forged Origin on the manifest and on the callback a connection stores', async () => {
      // The session cookie is SameSite=Lax and a site ignores the port, so a
      // page on another port of the console's host posts with the operator's
      // cookie and its own Origin. The request still arrives on the console.
      const forged = (req: request.Test): request.Test =>
        req
          .set('Origin', 'https://console.example.com:8443')
          .set('X-Forwarded-Proto', 'https')
          .set('X-Forwarded-Host', 'console.example.com');
      const { organizationId, owner: ownerSession } = await setUpOwner(server);

      const manifestRes = await forged(
        request(server)
          .post(`${OAUTH}/github/manifest`)
          .set('Cookie', ownerSession.cookie),
      ).send({ name: 'Acme on GitHub' });
      expect(manifestRes.status).toBe(200);
      expect(
        (manifestRes.body as { manifest: Record<string, unknown> }).manifest,
      ).toMatchObject({
        redirect_url: `${PROVIDER_BASE}${OAUTH}/github/setup`,
        setup_url: `${PROVIDER_BASE}${OAUTH}/github/callback`,
        hook_attributes: { url: `${PROVIDER_BASE}/github/webhook` },
        // Not the forged origin's console either: relative, so the callback
        // resolves it on the console it is served from.
        url: '/settings/git-providers',
      });

      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await gitlabService.create(ownerCtx, {
        name: 'Acme on GitLab',
        gitlabUrl: 'https://gitlab.example.com',
        applicationId: 'gitlab-application-id',
        secret: 'gitlab-application-secret',
      });
      await forged(
        request(server)
          .post(`${OAUTH}/gitlab/${created.gitlabId}/authorize`)
          .set('Cookie', ownerSession.cookie),
      );
      expect(
        (await gitlabService.findOne(ownerCtx, created.gitlabId)).redirectUri,
      ).toBe(`${PROVIDER_BASE}${OAUTH}/gitlab/callback`);
    });
  });

  describe('route shapes', () => {
    it('does not shadow the connection lookups it sits beside', async () => {
      // `GET /git-providers/:id` and `GET /github/:id` both exist; the three
      // OAuth segments must not be read as an id.
      const { owner: ownerSession } = await setUpOwner(server);

      const notAnId = await request(server)
        .get('/git-providers/oauth')
        .set('Cookie', ownerSession.cookie);
      expect(notAnId.status).toBe(404);

      const missingQuery = await request(server).get(`${OAUTH}/gitea/callback`);
      // Missing `code` and `state` is a validation refusal, not a 404.
      expect(missingQuery.status).toBe(400);
    });
  });
});
