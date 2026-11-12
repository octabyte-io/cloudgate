import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { parse } from 'yaml';
import { ApplicationsService } from '../../src/applications/applications.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import { OCTOKIT_FACTORY } from '../../src/git-providers/strategies/github/octokit.provider';
import { PreviewDeploymentsService } from '../../src/preview-deployments/preview-deployments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { dnsChallenge } from '../../src/settings/dns-challenge.schema';
import type { FileConfig } from '../../src/traefik/config/file-types';
import { dynamicTraefikConfigPath } from '../../src/traefik/traefik-writer.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { WILDCARD_PREVIEW_EXAMPLE_COM_PEM } from './fixtures/preview-certificates';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const appCredentials = {
  name: 'Team GitHub',
  appName: 'cloudgate-app',
  appId: 12345,
  clientId: 'Iv1.abc123',
  clientSecret: 'github-client-secret',
  installationId: '99887766',
  privateKey:
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----',
  webhookSecret: 'wh-secret',
};

const prOpened = {
  action: 'opened' as const,
  pullRequestId: '990001',
  pullRequestNumber: '42',
  pullRequestTitle: 'Add health endpoint',
  pullRequestURL: 'https://github.com/example-org/shop/pull/42',
  headBranch: 'feature/health',
  baseBranch: 'main',
  repository: 'cloudgate',
  owner: 'octabyte-io',
  prAuthor: 'octocat',
};

/** Written out, so the console's copy and this agree by being read. */
const NEEDS_WILDCARD =
  'Issuing preview certificates through DNS-01 needs a preview wildcard: a generated sslip.io host cannot get a DNS-01 certificate. Set a preview wildcard, or turn DNS-01 off in the same save before clearing it';
const NO_SETUP =
  "The machine this Application's previews run on has no DNS-01 setup. Add a DNS provider in that machine's Traefik settings first";
const NOT_ISSUED_NOTE =
  'The DNS-01 certificate for *.preview.example.com has not been issued on the machine this preview runs on, so its link is http://.';

const KEY_SENTINEL = 'cHJpdmF0ZS1rZXktc2VudGluZWw=';

/**
 * The platform host's `acme.json` as the machine-side `sed` hands it back:
 * keys already blanked — except this one, left in to prove the parse never
 * carries a `key` anywhere even when one arrives.
 */
const ACME_JSON = JSON.stringify(
  {
    'letsencrypt-dns': {
      Account: { Email: 'ops@example.com', PrivateKey: '' },
      Certificates: [
        {
          domain: { main: '*.preview.example.com' },
          certificate: Buffer.from(WILDCARD_PREVIEW_EXAMPLE_COM_PEM).toString(
            'base64',
          ),
          key: KEY_SENTINEL,
          Store: 'default',
        },
      ],
    },
  },
  null,
  2,
);

const DNS_TLS = {
  certResolver: 'letsencrypt-dns',
  domains: [{ main: '*.preview.example.com' }],
};

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/**
 * The Previews switch that issues the preview wildcard through DNS-01:
 * its admission on `PATCH /applications/:id`, the router it gives a preview,
 * the rewrite of live previews when it moves, and the printed link that waits
 * for the certificate to be in the machine's `acme.json`.
 */
describe('Preview DNS-01 switch (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let githubService: GithubService;
  let previews: PreviewDeploymentsService;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
    execFileAsync: jest.fn(),
    execRemote: jest.fn(),
  };
  const dockerService = { inspect: jest.fn(), update: jest.fn() };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
  };
  const convergedTasks = [1, 2, 3].map((n) => ({
    Status: { State: 'running', Timestamp: `2026-08-24T00:00:0${n}Z` },
  }));
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };
  const octokitMock = {
    rest: {
      issues: { createComment: jest.fn() },
      repos: { getCollaboratorPermissionLevel: jest.fn() },
    },
    auth: jest.fn(),
  };

  /** A writable platform root, as `preview-deployments.e2e-spec.ts` makes one. */
  const configuredRoot = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-dns-preview-root-')),
  );
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  /** What the platform host's `acme.json` read answers; none by default. */
  let acmeJson: string | null;

  beforeAll(async () => {
    process.env.CLOUDGATE_DIRECTORY = configuredRoot;
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
        { provide: OCTOKIT_FACTORY, useValue: () => octokitMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    githubService = ctx.app.get(GithubService);
    previews = ctx.app.get(PreviewDeploymentsService);
  });

  afterAll(async () => {
    await ctx.teardown();
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(configuredRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    acmeJson = null;
    for (const fn of [
      execMock.execAsync,
      execMock.execAsyncRemote,
      execMock.execRemote,
    ]) {
      fn.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    }
    execMock.execFileAsync
      .mockReset()
      .mockImplementation((program: string) =>
        program === 'sed'
          ? acmeJson === null
            ? Promise.reject(new Error("sed: can't read acme.json"))
            : Promise.resolve({ stdout: acmeJson, stderr: '' })
          : Promise.resolve({ stdout: '', stderr: '' }),
      );
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.createService.mockReset().mockResolvedValue(undefined);
    docker.listTasks.mockReset().mockResolvedValue(convergedTasks);
    queueMock.add.mockReset().mockResolvedValue({ id: 'job-1' });
    queueMock.getJobs.mockReset().mockResolvedValue([]);
    queueMock.cancel.mockReset().mockResolvedValue(false);
    octokitMock.rest.issues.createComment
      .mockReset()
      .mockResolvedValue({ data: { id: 777 } });
    octokitMock.rest.repos.getCollaboratorPermissionLevel
      .mockReset()
      .mockResolvedValue({ data: { permission: 'admin' } });
    octokitMock.auth.mockReset().mockResolvedValue({ token: 'ghs_stub' });
  });

  /** An owner and a GitHub-sourced Application with previews on, on the platform host. */
  async function setUp({
    previewWildcard = '*.preview.example.com',
  }: { previewWildcard?: string | null } = {}) {
    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers['set-cookie'];
    const ownerId = (signUp.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(ownerId, organizationId);

    const connection = await githubService.create(ownerCtx, appCredentials);
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const created = await applications.create(ownerCtx, {
      name: 'Web App',
      appName: 'web-app',
      environmentId: environment.environmentId,
    });
    const application = await applications.update(
      ownerCtx,
      created.applicationId,
      {
        sourceType: 'github',
        repository: 'cloudgate',
        owner: 'octabyte-io',
        branch: 'main',
        githubId: connection.githubId,
        isPreviewDeploymentsActive: true,
        previewWildcard,
      },
    );
    return { cookie, ownerCtx, application, connection };
  }

  /** The platform host's DNS-01 setup, as the settings routes store it. */
  async function addPlatformDnsChallenge() {
    await ctx.db.insert(dnsChallenge).values({
      provider: 'cloudflare',
      credentials: { CF_DNS_API_TOKEN: 'not-a-real-token' },
      serverId: null,
    });
  }

  const patch = (cookie: string, applicationId: string, body: object) =>
    request(server)
      .patch(`/applications/${applicationId}`)
      .set('Cookie', cookie)
      .send(body);

  /** A built, routed preview of the pull request, and its router file. */
  async function routedPreview(
    ownerCtx: ReturnType<typeof permissionCtx>,
    applicationId: string,
    githubId: string,
  ) {
    await previews.handlePullRequestEvent(githubId, prOpened);
    const [preview] = await previews.findAllByApplicationId(
      ownerCtx,
      applicationId,
    );
    await previews.deployPreview(preview.previewDeploymentId);
    const configPath = dynamicTraefikConfigPath(preview.appName, null);
    const secureTls = () => {
      const config = parse(fs.readFileSync(configPath, 'utf8')) as FileConfig;
      return Object.values(config.http?.routers ?? {}).find(
        (router) => router.entryPoints?.[0] === 'websecure',
      )?.tls;
    };
    return { preview, secureTls };
  }

  describe('admission', () => {
    it('refuses turning the switch on when the platform host has no DNS-01 setup, 409', async () => {
      const { cookie, application } = await setUp();
      const res = await patch(cookie, application.applicationId, {
        previewDnsChallenge: true,
      });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        message: NO_SETUP,
        code: 'NO_DNS_CHALLENGE_ON_MACHINE',
      });
      const read = await request(server)
        .get(`/applications/${application.applicationId}`)
        .set('Cookie', cookie);
      // Nothing was written on the way to being refused.
      expect(read.body).toMatchObject({ previewDnsChallenge: false });
    });

    it('refuses turning the switch on with no preview wildcard, 409', async () => {
      const { cookie, application } = await setUp({ previewWildcard: null });
      await addPlatformDnsChallenge();
      const res = await patch(cookie, application.applicationId, {
        previewDnsChallenge: true,
      });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        message: NEEDS_WILDCARD,
        code: 'PREVIEW_DNS_CHALLENGE_NEEDS_WILDCARD',
      });
    });

    it('turns on with a wildcard and a DNS-01 setup, reads back, and then refuses clearing the wildcard', async () => {
      const { cookie, application } = await setUp();
      await addPlatformDnsChallenge();
      const on = await patch(cookie, application.applicationId, {
        previewDnsChallenge: true,
      });
      expect(on.status).toBe(200);
      const read = await request(server)
        .get(`/applications/${application.applicationId}`)
        .set('Cookie', cookie);
      expect(read.body).toMatchObject({
        previewDnsChallenge: true,
        previewWildcard: '*.preview.example.com',
      });

      const cleared = await patch(cookie, application.applicationId, {
        previewWildcard: null,
      });
      expect(cleared.status).toBe(409);
      expect(cleared.body).toMatchObject({
        code: 'PREVIEW_DNS_CHALLENGE_NEEDS_WILDCARD',
      });

      const both = await patch(cookie, application.applicationId, {
        previewDnsChallenge: false,
        previewWildcard: null,
      });
      expect(both.status).toBe(200);
    });
  });

  describe('router and printed link', () => {
    it('asks the DNS-01 resolver for the wildcard and prints http:// with a note until acme.json holds it', async () => {
      const { cookie, ownerCtx, application, connection } = await setUp();
      await addPlatformDnsChallenge();
      await applications.update(ownerCtx, application.applicationId, {
        previewDnsChallenge: true,
      });

      const { preview, secureTls } = await routedPreview(
        ownerCtx,
        application.applicationId,
        connection.githubId,
      );
      expect(secureTls()).toEqual(DNS_TLS);
      expect(octokitMock.rest.issues.createComment).toHaveBeenLastCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(
            `Preview deployment ready: http://${preview.domain}`,
          ) as string,
        }),
      );
      const list = await request(server)
        .get(`/applications/${application.applicationId}/preview-deployments`)
        .set('Cookie', cookie);
      expect(list.status).toBe(200);
      expect((list.body as unknown[])[0]).toMatchObject({
        url: `http://${preview.domain}`,
        urlNote: NOT_ISSUED_NOTE,
      });
    });

    it('prints https:// once the certificate is issued, on the read and on the pull request, and never answers its key', async () => {
      const { cookie, ownerCtx, application, connection } = await setUp();
      await addPlatformDnsChallenge();
      await applications.update(ownerCtx, application.applicationId, {
        previewDnsChallenge: true,
      });
      acmeJson = ACME_JSON;

      const { preview } = await routedPreview(
        ownerCtx,
        application.applicationId,
        connection.githubId,
      );
      expect(octokitMock.rest.issues.createComment).toHaveBeenLastCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(
            `Preview deployment ready: https://${preview.domain}`,
          ) as string,
        }),
      );
      const list = await request(server)
        .get(`/applications/${application.applicationId}/preview-deployments`)
        .set('Cookie', cookie);
      const [listed] = list.body as Record<string, unknown>[];
      expect(listed.url).toBe(`https://${preview.domain}`);
      expect(listed).not.toHaveProperty('urlNote');
      const one = await request(server)
        .get(`/preview-deployments/${preview.previewDeploymentId}`)
        .set('Cookie', cookie);
      expect(one.body).toMatchObject({ url: `https://${preview.domain}` });
      expect(JSON.stringify([list.body, one.body])).not.toContain(KEY_SENTINEL);
    });

    it('does not read acme.json, nor count it, while the switch is off', async () => {
      const { cookie, ownerCtx, application, connection } = await setUp();
      await addPlatformDnsChallenge();
      acmeJson = ACME_JSON;
      const { preview, secureTls } = await routedPreview(
        ownerCtx,
        application.applicationId,
        connection.githubId,
      );
      expect(secureTls()).toEqual({});
      const list = await request(server)
        .get(`/applications/${application.applicationId}/preview-deployments`)
        .set('Cookie', cookie);
      expect((list.body as unknown[])[0]).toMatchObject({
        url: `http://${preview.domain}`,
      });
      expect(execMock.execFileAsync).not.toHaveBeenCalledWith(
        'sed',
        expect.anything(),
      );
    });

    it("stops counting the certificate once the machine's DNS-01 setup is gone", async () => {
      const { cookie, ownerCtx, application, connection } = await setUp();
      await addPlatformDnsChallenge();
      await applications.update(ownerCtx, application.applicationId, {
        previewDnsChallenge: true,
      });
      acmeJson = ACME_JSON;
      const { preview } = await routedPreview(
        ownerCtx,
        application.applicationId,
        connection.githubId,
      );
      await ctx.db.delete(dnsChallenge);

      const list = await request(server)
        .get(`/applications/${application.applicationId}/preview-deployments`)
        .set('Cookie', cookie);
      expect((list.body as unknown[])[0]).toMatchObject({
        url: `http://${preview.domain}`,
      });
    });

    it("rewrites a live preview's router when the switch moves, either way", async () => {
      const { cookie, ownerCtx, application, connection } = await setUp();
      await addPlatformDnsChallenge();
      const { secureTls } = await routedPreview(
        ownerCtx,
        application.applicationId,
        connection.githubId,
      );
      expect(secureTls()).toEqual({});

      const on = await patch(cookie, application.applicationId, {
        previewDnsChallenge: true,
      });
      expect(on.status).toBe(200);
      expect(secureTls()).toEqual(DNS_TLS);

      const off = await patch(cookie, application.applicationId, {
        previewDnsChallenge: false,
      });
      expect(off.status).toBe(200);
      expect(secureTls()).toEqual({});
    });
  });
});
