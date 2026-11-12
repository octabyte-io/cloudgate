import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { application } from '../../src/applications/application.schema';
import { ApplicationsService } from '../../src/applications/applications.service';
import { cloudAccount } from '../../src/cloud-accounts/cloud-account.schema';
import { postgres } from '../../src/databases/postgres/postgres.schema';
import { member } from '../../src/db/schema';
import { domain } from '../../src/domains/domain.schema';
import { environment } from '../../src/environments/environment.schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { AccessLogService } from '../../src/monitoring/access-log.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import {
  ForwardExecAbortedError,
  SshForwardError,
  SshForwardService,
} from '../../src/remote/ssh-forward.service';
import type {
  ForwardExecOptions,
  ForwardExecResult,
} from '../../src/remote/ssh-forward.service';
import { server } from '../../src/servers/server.schema';
import { freezeOrganization } from '../utils/frozen-organization';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';

jest.setTimeout(120_000);

/**
 * The Requests page's read of one Server's Access log (ADR-0055,
 * ADR-0056), over HTTP, with only the Server's SSH doubled: the pooled
 * connection's `exec` serves a scripted `traefik.yml` for `cat` and a
 * scripted log for `wc -c` and `tail -c`, or fails to connect, or hangs.
 * Everything else runs — the parser, the stop rule, the split by Service,
 * the hidden query values, the permissions and the frozen guard — and each
 * way a read can have nothing to show is answered as its own state.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** The log the Server's file path is, the same string rotation derives. */
const LOG_PATH = '/etc/cloudgate/traefik/dynamic/access.log';

/** The Server's Traefik static configuration, beside `dynamic/`. */
const CONFIG_PATH = '/etc/cloudgate/traefik/traefik.yml';

/** A traefik.yml with the Access log on, as the Request logging card writes it. */
const LOGGING_ON = [
  'entryPoints:',
  '  web:',
  '    address: ":80"',
  'accessLog:',
  `  filePath: ${LOG_PATH}`,
  '  format: json',
  '',
].join('\n');

/** The same file with no `accessLog` block: how every new Server starts. */
const LOGGING_OFF = ['entryPoints:', '  web:', '    address: ":80"', ''].join(
  '\n',
);

/** One access-log line, as Traefik writes it; Duration is nanoseconds. */
function line(fields: {
  at: string;
  host?: string;
  path: string;
  status?: number;
  method?: string;
}): string {
  return JSON.stringify({
    StartUTC: fields.at,
    Duration: 2_000_000,
    RequestHost: fields.host,
    RequestPath: fields.path,
    RequestMethod: fields.method ?? 'GET',
    DownstreamStatus: fields.status ?? 200,
    DownstreamContentSize: 512,
    ClientHost: '198.51.100.7',
    'request_User-Agent': 'curl/8.5.0',
  });
}

const RANGE = {
  start: '2026-11-06T10:00:00.000Z',
  end: '2026-11-06T12:00:00.000Z',
};

/** Two hours of traffic: two Services, and a scanner no Domain names. */
const LOG = [
  line({
    at: '2026-11-06T10:05:00Z',
    host: 'shop.example.com',
    path: '/reset?token=s3cret&user=7',
  }),
  line({ at: '2026-11-06T10:15:00Z', host: 'blog.example.com', path: '/' }),
  line({ at: '2026-11-06T10:20:00Z', path: '/wp-login.php', status: 404 }),
  line({
    at: '2026-11-06T11:05:00Z',
    host: 'shop.example.com',
    path: '/cart',
    method: 'POST',
  }),
  line({
    at: '2026-11-06T11:10:00Z',
    host: 'blog.example.com',
    path: '/post/1',
  }),
].join('\n');

describe('Server requests (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  /** What the Server's pooled connection answers, per Server. */
  let logs: Map<string, { text: string; size?: number }>;
  /** Each Server's traefik.yml; null is none at all. Logging on unless set. */
  let configs: Map<string, string | null>;
  /** A Server whose connection fails, or whose every command never ends. */
  let failures: Map<string, 'unreachable' | 'hang'>;
  const forward = {
    exec: jest.fn(
      (
        serverId: string,
        argv: readonly string[],
        options?: ForwardExecOptions,
      ): Promise<ForwardExecResult> => {
        const failure = failures.get(serverId);
        if (failure === 'unreachable') {
          return Promise.reject(
            new SshForwardError(
              'Could not connect to the Server over SSH: connect ECONNREFUSED',
              serverId,
            ),
          );
        }
        if (failure === 'hang') {
          // As the real `exec` does once its signal aborts.
          return new Promise((_, reject) =>
            options?.signal?.addEventListener('abort', () =>
              reject(new ForwardExecAbortedError(serverId)),
            ),
          );
        }
        if (argv[0] === 'cat') {
          const config = configs.has(serverId)
            ? configs.get(serverId)
            : LOGGING_ON;
          return Promise.resolve(
            config === null || config === undefined
              ? {
                  stdout: '',
                  stderr: `cat: ${CONFIG_PATH}: No such file or directory\n`,
                  code: 1,
                }
              : { stdout: config, stderr: '', code: 0 },
          );
        }
        const log = logs.get(serverId);
        if (!log) {
          return Promise.resolve({
            stdout: '',
            stderr: `wc: ${LOG_PATH}: No such file or directory\n`,
            code: 1,
          });
        }
        if (argv[0] === 'wc') {
          const size = log.size ?? Buffer.byteLength(log.text);
          return Promise.resolve({
            stdout: `${size} ${LOG_PATH}\n`,
            stderr: '',
            code: 0,
          });
        }
        return Promise.resolve({ stdout: log.text, stderr: '', code: 0 });
      },
    ),
  };
  const remoteExec = {
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
    execRemote: jest.fn<Promise<ExecResult>, [string, string[]]>(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: SshForwardService, useValue: forward },
        { provide: RemoteExecService, useValue: remoteExec },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    forward.exec.mockClear();
    const ok = { stdout: '', stderr: '', exitCode: 0 };
    remoteExec.execAsync.mockResolvedValue(ok);
    remoteExec.execAsyncRemote.mockResolvedValue(ok);
    remoteExec.execRemote.mockResolvedValue(ok);
    logs = new Map();
    configs = new Map();
    failures = new Map();
    await ctx.resetDb();
  });

  /** The instance owner, one Server, a shop and a blog on it. */
  async function given() {
    const signUp = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers['set-cookie'];
    const ownerId = (signUp.body as { user: { id: string } }).user.id;
    const orgs = await request(httpServer)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = {
      user: { id: ownerId },
      session: { activeOrganizationId: organizationId },
    };

    const [row] = await ctx.db
      .insert(server)
      .values({
        name: 'eu-web-1',
        ipAddress: '203.0.113.10',
        port: 22,
        organizationId,
      })
      .returning({ serverId: server.serverId });
    const serverId = row.serverId;

    const project = await ctx.app
      .get(ProjectsService)
      .create(ownerCtx, { name: 'Storefront' });
    const environment = await ctx.app
      .get(EnvironmentsService)
      .create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
        deployTarget: { kind: 'server', serverId },
      });
    const app = async (name: string, host: string) => {
      const created = await ctx.app.get(ApplicationsService).create(ownerCtx, {
        name,
        appName: `${name}-app`,
        environmentId: environment.environmentId,
        serverId,
      });
      await ctx.db
        .insert(domain)
        .values({ host, applicationId: created.applicationId });
      return created.applicationId;
    };
    const shopId = await app('shop', 'shop.example.com');
    const blogId = await app('blog', 'blog.example.com');

    return { cookie, ownerId, organizationId, serverId, shopId, blogId };
  }

  /** A member whose row names exactly these Services. */
  async function memberWith(
    ownerCookie: string,
    organizationId: string,
    services: string[],
  ) {
    const fixture = await signUpMember(httpServer, ownerCookie);
    await ctx.db
      .update(member)
      .set({ accessedServices: services })
      .where(
        and(
          eq(member.userId, fixture.id),
          eq(member.organizationId, organizationId),
        ),
      );
    return fixture;
  }

  /** An Application in a Cloud account, in the Project `given` made. */
  async function cloudApplication(organizationId: string): Promise<string> {
    const [project] = await ctx.db
      .select({ projectId: environment.projectId })
      .from(environment)
      .limit(1);
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
        externalId: 'external-id-1',
        policyVersion: 3,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    const [cloudEnvironment] = await ctx.db
      .insert(environment)
      .values({
        name: 'cloud',
        projectId: project.projectId,
        deployTarget: {
          kind: 'cloud',
          cloudAccountId: account.cloudAccountId,
          region: 'eu-central-1',
        },
      })
      .returning({ environmentId: environment.environmentId });
    const [created] = await ctx.db
      .insert(application)
      .values({
        name: 'api',
        configName: 'api',
        environmentId: cloudEnvironment.environmentId,
        cloudAccountId: account.cloudAccountId,
        region: 'eu-central-1',
      })
      .returning({ applicationId: application.applicationId });
    return created.applicationId;
  }

  type Read = {
    state: string;
    target: { serverId: string | null; name: string };
    canSwitchLogging: boolean;
    readAt: string;
    data: {
      RequestPath?: string;
      RequestHost?: string;
      'request_User-Agent'?: string;
      service?: { serviceId: string; name: string } | null;
    }[];
    totalCount: number;
    hours: { hour: string; count: number }[];
    retainedFrom?: string;
    services: { serviceId: string; name: string }[];
    noService: boolean;
    wholeServer: boolean;
    covers: 'server' | 'your-services' | 'chosen-services' | 'service';
  };

  function read(cookie: string, query: Record<string, unknown>) {
    return request(httpServer)
      .get('/monitoring/requests')
      .query({ ...RANGE, ...query })
      .set('Cookie', cookie);
  }

  it("answers a Server's lines parsed, each with its Service, and every query value as ***", async () => {
    const { cookie, serverId, shopId } = await given();
    logs.set(serverId, { text: `${LOG}\n` });

    const res = await read(cookie, { serverId });

    expect(res.status).toBe(200);
    const body = res.body as Read;
    expect(body.state).toBe('ok');
    expect(body.target).toEqual({ serverId, name: 'eu-web-1' });
    expect(body.totalCount).toBe(5);
    const reset = body.data.find((row) =>
      row.RequestPath?.startsWith('/reset'),
    );
    expect(reset).toMatchObject({
      RequestPath: '/reset?token=***&user=***',
      'request_User-Agent': 'curl/8.5.0',
      service: { serviceId: shopId, name: 'shop' },
    });
    expect(JSON.stringify(body)).not.toContain('s3cret');
    expect(
      body.data.find((row) => row.RequestPath === '/wp-login.php')?.service,
    ).toBeNull();
    // Read with standard commands only, at the path rotation keeps bounded.
    expect(forward.exec.mock.calls.map(([, argv]) => argv)).toEqual([
      ['cat', CONFIG_PATH],
      ['wc', '-c', LOG_PATH],
      ['tail', '-c', String(Buffer.byteLength(`${LOG}\n`)), LOG_PATH],
    ]);
  });

  it("gives a member with service: ['read'] on one Service only its lines, and counts only those", async () => {
    const { cookie, organizationId, serverId, shopId } = await given();
    logs.set(serverId, { text: `${LOG}\n` });
    const ida = await memberWith(cookie, organizationId, [shopId]);

    const res = await read(ida.cookie, { serverId });

    expect(res.status).toBe(200);
    const body = res.body as Read;
    expect(body.totalCount).toBe(2);
    expect(body.data.map((row) => row.service?.name)).toEqual(['shop', 'shop']);
    expect(body.hours).toEqual([
      { hour: '2026-11-06T10:00:00Z', count: 1 },
      { hour: '2026-11-06T11:00:00Z', count: 1 },
    ]);
  });

  it("sends lines that matched no Service only to a server: ['read'] holder", async () => {
    const { cookie, organizationId, serverId, shopId, blogId } = await given();
    logs.set(serverId, { text: `${LOG}\n` });
    // A member reads both Services and still holds no `server: ['read']`.
    const ida = await memberWith(cookie, organizationId, [shopId, blogId]);
    const admin = await signUpMember(httpServer, cookie, {
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      role: 'admin',
    });

    const byMember = (await read(ida.cookie, { serverId })).body as Read;
    const byAdmin = (await read(admin.cookie, { serverId })).body as Read;

    expect(byMember.totalCount).toBe(4);
    expect(byMember.data.some((row) => row.service === null)).toBe(false);
    expect(byAdmin.totalCount).toBe(5);
    expect(byAdmin.data.filter((row) => row.service === null)).toHaveLength(1);
  });

  it("gives a member holding monitoring: ['read'] and no Service nothing, as a Server not found", async () => {
    const { cookie, organizationId, serverId } = await given();
    logs.set(serverId, { text: `${LOG}\n` });
    // The base member role holds `monitoring: ['read']`; this row names no
    // Service, so nothing on the Server is theirs to read.
    const ida = await memberWith(cookie, organizationId, []);

    const res = await read(ida.cookie, { serverId });
    const picker = await request(httpServer)
      .get('/monitoring/requests/servers')
      .set('Cookie', ida.cookie);

    expect(res.status).toBe(404);
    expect((res.body as { message: string }).message).toBe('Server not found');
    expect(JSON.stringify(res.body)).not.toContain('shop.example.com');
    expect(picker.body).toEqual({
      servers: [],
      platformHost: false,
      cloudAccountServices: false,
    });
    expect(forward.exec).not.toHaveBeenCalled();
  });

  it('says how far back it reached when the 16 MiB bound falls short of the range', async () => {
    const { cookie, serverId } = await given();
    // A file larger than one read: the tail begins mid-line, at 10:15's line.
    logs.set(serverId, {
      text: `{"cut-off half":\n${LOG.split('\n').slice(1).join('\n')}\n`,
      size: 40 * 1024 * 1024,
    });

    const body = (await read(cookie, { serverId })).body as Read;

    expect(body.state).toBe('ok');
    expect(body.totalCount).toBe(4);
    expect(body.retainedFrom).toBe('2026-11-06T10:15:00.002Z');
    expect(forward.exec.mock.calls[2][1]).toEqual([
      'tail',
      '-c',
      String(16 * 1024 * 1024),
      LOG_PATH,
    ]);
  });

  it('says how far back it reached when the start of the file falls short of the range', async () => {
    const { cookie, serverId } = await given();
    // Just rotated: the live file starts at 11:05.
    logs.set(serverId, { text: `${LOG.split('\n').slice(3).join('\n')}\n` });

    const body = (await read(cookie, { serverId })).body as Read;

    expect(body.totalCount).toBe(2);
    expect(body.retainedFrom).toBe('2026-11-06T11:05:00.002Z');
  });

  it('says nothing about retention when the file reaches back past the range', async () => {
    const { cookie, serverId } = await given();
    logs.set(serverId, {
      text: `${line({ at: '2026-11-06T08:00:00Z', host: 'shop.example.com', path: '/' })}\n${LOG}\n`,
    });

    const body = (await read(cookie, { serverId })).body as Read;

    expect(body.totalCount).toBe(5);
    expect(body.retainedFrom).toBeUndefined();
  });

  it("answers another Organization's Server as not found, and never reads it", async () => {
    const { cookie, serverId } = await given();
    logs.set(serverId, { text: `${LOG}\n` });
    const mallory = await secondOrganizationOwner(httpServer, ctx.db, cookie);

    const res = await read(mallory.cookie, { serverId });
    const picker = await request(httpServer)
      .get('/monitoring/requests/servers')
      .set('Cookie', mallory.cookie);

    expect(res.status).toBe(404);
    expect((res.body as { message: string }).message).toBe('Server not found');
    expect(picker.body).toEqual({
      servers: [],
      platformHost: false,
      cloudAccountServices: false,
    });
    expect(forward.exec).not.toHaveBeenCalled();
  });

  it("gives the instance's own owner no read of a customer's Server, authority or not (ADR-0050)", async () => {
    const { cookie } = await given();
    const mallory = await secondOrganizationOwner(httpServer, ctx.db, cookie);
    const [theirs] = await ctx.db
      .insert(server)
      .values({
        name: 'mallory-1',
        ipAddress: '203.0.113.20',
        port: 22,
        organizationId: mallory.organizationId,
      })
      .returning({ serverId: server.serverId });
    logs.set(theirs.serverId, { text: `${LOG}\n` });

    const res = await read(cookie, { serverId: theirs.serverId });

    expect(res.status).toBe(404);
    expect(forward.exec).not.toHaveBeenCalled();
  });

  it('lists the platform host as a picker entry for instance authority, and refuses an Organization with no Service there', async () => {
    const { cookie, serverId } = await given();
    const mallory = await secondOrganizationOwner(httpServer, ctx.db, cookie);
    jest
      .spyOn(ctx.app.get(AccessLogService), 'loggingOn')
      .mockReturnValue(true);
    jest.spyOn(ctx.app.get(AccessLogService), 'readWindow').mockResolvedValue({
      raw: `${LOG}\n`,
      fromOffset: 0,
      bytesRead: LOG.length,
      bytesIndexed: 0,
    });

    const ownerPicker = await request(httpServer)
      .get('/monitoring/requests/servers')
      .set('Cookie', cookie);
    const ownerRead = await read(cookie, {});
    const malloryRead = await read(mallory.cookie, {});

    expect(ownerPicker.body).toEqual({
      servers: [{ serverId, name: 'eu-web-1' }],
      platformHost: true,
      cloudAccountServices: false,
    });
    expect(ownerRead.status).toBe(200);
    expect((ownerRead.body as Read).target).toEqual({
      serverId: null,
      name: 'Platform host',
    });
    expect((ownerRead.body as Read).totalCount).toBe(5);
    expect(malloryRead.status).toBe(403);
  });

  // #1342: the platform host fronts every Organization's Domains, and the
  // Instance organization's authority to read it is no switch to show values.
  it('GET /monitoring/requests on the platform host hides every query value, and searches it hidden', async () => {
    const { cookie } = await given();
    jest
      .spyOn(ctx.app.get(AccessLogService), 'loggingOn')
      .mockReturnValue(true);
    jest.spyOn(ctx.app.get(AccessLogService), 'readWindow').mockResolvedValue({
      raw: `${LOG}\n`,
      fromOffset: 0,
      bytesRead: LOG.length,
      bytesIndexed: 0,
    });

    const all = await read(cookie, {});
    const bySecret = await read(cookie, { search: 's3cret' });

    expect(all.status).toBe(200);
    const body = all.body as Read;
    expect(body.target.serverId).toBeNull();
    expect(
      body.data.find((row) => row.RequestPath?.startsWith('/reset'))
        ?.RequestPath,
    ).toBe('/reset?token=***&user=***');
    expect(body.data.some((row) => row.RequestPath === '/wp-login.php')).toBe(
      true,
    );
    expect(JSON.stringify(body)).not.toContain('s3cret');
    expect(bySecret.status).toBe(200);
    expect((bySecret.body as Read).totalCount).toBe(0);
  });

  it('lets a Frozen Organization still read', async () => {
    const { cookie, organizationId, serverId } = await given();
    logs.set(serverId, { text: `${LOG}\n` });
    await freezeOrganization(ctx, organizationId);

    const res = await read(cookie, { serverId });

    expect(res.status).toBe(200);
    expect((res.body as Read).totalCount).toBe(5);
  });

  it('lists a Server whose logging is off, without reaching it', async () => {
    const { cookie, organizationId, serverId, shopId } = await given();
    const ida = await memberWith(cookie, organizationId, [shopId]);
    // No log on the Server at all.

    const picker = await request(httpServer)
      .get('/monitoring/requests/servers')
      .set('Cookie', ida.cookie);

    expect(picker.status).toBe(200);
    expect(picker.body).toEqual({
      servers: [{ serverId, name: 'eu-web-1' }],
      platformHost: false,
      cloudAccountServices: false,
    });
    expect(forward.exec).not.toHaveBeenCalled();
  });

  it('filters by status, method and search after the split, and counts only what is left', async () => {
    const { cookie, serverId } = await given();
    logs.set(serverId, { text: `${LOG}\n` });

    const posts = (await read(cookie, { serverId, method: 'POST' }))
      .body as Read;
    const clientErrors = (await read(cookie, { serverId, status: ['client'] }))
      .body as Read;
    const blog = (await read(cookie, { serverId, search: 'blog.' }))
      .body as Read;

    expect(posts.totalCount).toBe(1);
    expect(posts.hours).toEqual([{ hour: '2026-11-06T11:00:00Z', count: 1 }]);
    expect(clientErrors.data.map((row) => row.RequestPath)).toEqual([
      '/wp-login.php',
    ]);
    expect(blog.totalCount).toBe(2);
  });

  describe('the Service filter', () => {
    it('narrows lines, totals and buckets to the chosen Services, and to No Service', async () => {
      const { cookie, serverId, shopId, blogId } = await given();
      logs.set(serverId, { text: `${LOG}\n` });

      const shop = (await read(cookie, { serverId, serviceId: shopId }))
        .body as Read;
      const shopAndBlog = (
        await read(cookie, { serverId, serviceId: [shopId, blogId] })
      ).body as Read;
      const none = (await read(cookie, { serverId, noService: 'true' }))
        .body as Read;
      const blogAndNone = (
        await read(cookie, { serverId, serviceId: blogId, noService: 'true' })
      ).body as Read;

      expect(shop.totalCount).toBe(2);
      expect(shop.data.map((row) => row.service?.name)).toEqual([
        'shop',
        'shop',
      ]);
      expect(shop.hours).toEqual([
        { hour: '2026-11-06T10:00:00Z', count: 1 },
        { hour: '2026-11-06T11:00:00Z', count: 1 },
      ]);
      expect(shopAndBlog.totalCount).toBe(4);
      expect(none.totalCount).toBe(1);
      expect(none.data.map((row) => row.RequestPath)).toEqual([
        '/wp-login.php',
      ]);
      expect(none.hours).toEqual([{ hour: '2026-11-06T10:00:00Z', count: 1 }]);
      expect(blogAndNone.totalCount).toBe(3);
      expect(blogAndNone.hours).toEqual([
        { hour: '2026-11-06T10:00:00Z', count: 2 },
        { hour: '2026-11-06T11:00:00Z', count: 1 },
      ]);
    });

    it("gives No Service nothing to a caller without server: ['read'], and a Service id they can't read reveals nothing", async () => {
      const { cookie, organizationId, serverId, shopId, blogId } =
        await given();
      logs.set(serverId, { text: `${LOG}\n` });
      const ida = await memberWith(cookie, organizationId, [shopId]);

      const none = (await read(ida.cookie, { serverId, noService: 'true' }))
        .body as Read;
      const blog = (await read(ida.cookie, { serverId, serviceId: blogId }))
        .body as Read;

      expect(none.state).toBe('ok');
      expect(none.totalCount).toBe(0);
      expect(none.data).toEqual([]);
      expect(none.hours).toEqual([]);
      expect(blog.totalCount).toBe(0);
      expect(blog.hours).toEqual([]);
      expect(JSON.stringify(blog)).not.toContain('blog.example.com');
      // The options are only what is theirs.
      expect(blog.services).toEqual([{ serviceId: shopId, name: 'shop' }]);
      expect(blog.noService).toBe(false);
    });

    it('says when the totals cover only some Services, and when they cover the chosen ones', async () => {
      const { cookie, organizationId, serverId, shopId, blogId } =
        await given();
      logs.set(serverId, { text: `${LOG}\n` });
      const ida = await memberWith(cookie, organizationId, [shopId]);

      const byOwner = (await read(cookie, { serverId })).body as Read;
      const byMember = (await read(ida.cookie, { serverId })).body as Read;
      const chosen = (await read(cookie, { serverId, serviceId: shopId }))
        .body as Read;

      expect(byOwner.covers).toBe('server');
      expect(byOwner.services).toEqual([
        { serviceId: blogId, name: 'blog' },
        { serviceId: shopId, name: 'shop' },
      ]);
      expect(byOwner.noService).toBe(true);
      expect(byMember.covers).toBe('your-services');
      expect(byMember.noService).toBe(false);
      expect(chosen.covers).toBe('chosen-services');
      expect(byOwner.wholeServer).toBe(true);
      expect(chosen.wholeServer).toBe(true);
      expect(byMember.wholeServer).toBe(false);
    });
  });

  describe('when a read has nothing to show', () => {
    it('answers unreachable when the Server cannot be reached over SSH', async () => {
      const { cookie, serverId } = await given();
      failures.set(serverId, 'unreachable');

      const res = await read(cookie, { serverId });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        state: 'unreachable',
        target: { serverId, name: 'eu-web-1' },
        data: [],
        totalCount: 0,
        hours: [],
      });
    });

    it("answers logging off when the Server's traefik.yml has no accessLog block, whatever file is left", async () => {
      const { cookie, serverId } = await given();
      configs.set(serverId, LOGGING_OFF);
      // A log from before it was turned off is still on disk.
      logs.set(serverId, { text: `${LOG}\n` });

      const body = (await read(cookie, { serverId })).body as Read;

      expect(body.state).toBe('logging-off');
      expect(body.totalCount).toBe(0);
      expect(body.data).toEqual([]);
      // Nothing of that old file was read back.
      expect(forward.exec.mock.calls.map(([, argv]) => argv)).toEqual([
        ['cat', CONFIG_PATH],
      ]);
    });

    it('answers logging off when the Server has no traefik.yml at all', async () => {
      const { cookie, serverId } = await given();
      configs.set(serverId, null);

      const body = (await read(cookie, { serverId })).body as Read;

      expect(body.state).toBe('logging-off');
    });

    it('answers awaiting restart when logging is on but Traefik has written no file', async () => {
      const { cookie, serverId } = await given();
      // traefik.yml has the block; no access.log exists yet.

      const body = (await read(cookie, { serverId })).body as Read;

      expect(body.state).toBe('awaiting-restart');
      expect(body.totalCount).toBe(0);
    });

    it('answers empty when the log file has no lines', async () => {
      const { cookie, serverId } = await given();
      logs.set(serverId, { text: '' });

      const body = (await read(cookie, { serverId })).body as Read;

      expect(body.state).toBe('empty');
      expect(body.totalCount).toBe(0);
    });

    it('answers ok, not empty, when the file has lines but none in the range', async () => {
      const { cookie, serverId } = await given();
      logs.set(serverId, {
        text: `${line({ at: '2026-11-06T08:00:00Z', host: 'shop.example.com', path: '/' })}\n`,
      });

      const body = (await read(cookie, { serverId })).body as Read;

      expect(body.state).toBe('ok');
      expect(body.totalCount).toBe(0);
    });

    it('answers too slow when the read has not finished after 10 seconds', async () => {
      const { cookie, serverId } = await given();
      failures.set(serverId, 'hang');

      const started = Date.now();
      const res = await read(cookie, { serverId });
      const took = Date.now() - started;

      expect(res.status).toBe(200);
      expect((res.body as Read).state).toBe('too-slow');
      expect((res.body as Read).totalCount).toBe(0);
      expect(took).toBeGreaterThanOrEqual(10_000);
      expect(took).toBeLessThan(20_000);
    });

    it('says an owner or admin of the Organization can switch logging, and another member cannot', async () => {
      const { cookie, organizationId, serverId, shopId } = await given();
      configs.set(serverId, LOGGING_OFF);
      const ida = await memberWith(cookie, organizationId, [shopId]);
      const admin = await signUpMember(httpServer, cookie, {
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        role: 'admin',
      });

      const byOwner = (await read(cookie, { serverId })).body as Read;
      const byAdmin = (await read(admin.cookie, { serverId })).body as Read;
      const byMember = (await read(ida.cookie, { serverId })).body as Read;

      expect(byOwner).toMatchObject({
        state: 'logging-off',
        canSwitchLogging: true,
      });
      expect(byAdmin.canSwitchLogging).toBe(true);
      expect(byMember).toMatchObject({
        state: 'logging-off',
        canSwitchLogging: false,
      });
    });

    it('says so on an ok read too', async () => {
      const { cookie, organizationId, serverId, shopId } = await given();
      logs.set(serverId, { text: `${LOG}\n` });
      const ida = await memberWith(cookie, organizationId, [shopId]);

      expect(
        ((await read(cookie, { serverId })).body as Read).canSwitchLogging,
      ).toBe(true);
      expect(
        ((await read(ida.cookie, { serverId })).body as Read).canSwitchLogging,
      ).toBe(false);
    });

    it('tells the picker the Organization has Services in a Cloud account, only to callers who can read one', async () => {
      const { cookie, organizationId } = await given();
      await cloudApplication(organizationId);
      const ida = await memberWith(cookie, organizationId, []);

      const byOwner = await request(httpServer)
        .get('/monitoring/requests/servers')
        .set('Cookie', cookie);
      const byMember = await request(httpServer)
        .get('/monitoring/requests/servers')
        .set('Cookie', ida.cookie);

      expect(byOwner.body).toMatchObject({ cloudAccountServices: true });
      expect(byMember.body).toMatchObject({ cloudAccountServices: false });
    });
  });

  describe("a Service's Requests tab", () => {
    function readService(
      cookie: string,
      serviceId: string,
      query: Record<string, unknown> = {},
    ) {
      return request(httpServer)
        .get(`/monitoring/requests/services/${serviceId}`)
        .query({ ...RANGE, ...query })
        .set('Cookie', cookie);
    }

    it("reads the Service's own Server, found from the Service, and answers only that Service's lines", async () => {
      const { cookie, serverId, shopId } = await given();
      logs.set(serverId, { text: `${LOG}\n` });

      const res = await readService(cookie, shopId);

      expect(res.status).toBe(200);
      const body = res.body as Read;
      expect(body.state).toBe('ok');
      // The Server, for "on Server eu-web-1" under the title.
      expect(body.target).toEqual({ serverId, name: 'eu-web-1' });
      expect(body.totalCount).toBe(2);
      expect(body.data.map((row) => row.service?.name)).toEqual([
        'shop',
        'shop',
      ]);
      expect(body.hours).toEqual([
        { hour: '2026-11-06T10:00:00Z', count: 1 },
        { hour: '2026-11-06T11:00:00Z', count: 1 },
      ]);
      expect(body.covers).toBe('service');
      expect(body.services).toEqual([{ serviceId: shopId, name: 'shop' }]);
      expect(body.noService).toBe(false);
      // Query values hidden, and the scanner's line, matching no Service,
      // is not this Service's even for an owner.
      expect(JSON.stringify(body)).not.toContain('s3cret');
      expect(JSON.stringify(body)).not.toContain('wp-login');
      expect(JSON.stringify(body)).not.toContain('blog.example.com');
      expect(forward.exec.mock.calls.map(([sid]) => sid)).toEqual([
        serverId,
        serverId,
        serverId,
      ]);
    });

    it('keeps the filters, the no-lines states and how far back the read reached', async () => {
      const { cookie, serverId, shopId } = await given();
      // Just rotated: the live file starts at 11:05.
      logs.set(serverId, { text: `${LOG.split('\n').slice(3).join('\n')}\n` });

      const posts = (await readService(cookie, shopId, { method: 'POST' }))
        .body as Read;
      configs.set(serverId, LOGGING_OFF);
      const off = (await readService(cookie, shopId)).body as Read;

      expect(posts.totalCount).toBe(1);
      expect(posts.retainedFrom).toBe('2026-11-06T11:05:00.002Z');
      expect(off).toMatchObject({
        state: 'logging-off',
        target: { serverId, name: 'eu-web-1' },
        canSwitchLogging: true,
        totalCount: 0,
      });
    });

    it('gives a member the tab of a Service they read, and "not found" for one they cannot', async () => {
      const { cookie, organizationId, serverId, shopId, blogId } =
        await given();
      logs.set(serverId, { text: `${LOG}\n` });
      const ida = await memberWith(cookie, organizationId, [shopId]);

      const shop = await readService(ida.cookie, shopId);
      const blog = await readService(ida.cookie, blogId);

      expect(shop.status).toBe(200);
      expect((shop.body as Read).totalCount).toBe(2);
      expect((shop.body as Read).canSwitchLogging).toBe(false);
      expect(blog.status).toBe(404);
      expect((blog.body as { message: string }).message).toBe(
        'Service not found',
      );
      expect(JSON.stringify(blog.body)).not.toContain('blog.example.com');
    });

    it("answers another Organization's Service, and an unknown id, as not found, and reaches no Server", async () => {
      const { cookie, serverId, shopId } = await given();
      logs.set(serverId, { text: `${LOG}\n` });
      const mallory = await secondOrganizationOwner(httpServer, ctx.db, cookie);

      const theirs = await readService(mallory.cookie, shopId);
      const unknown = await readService(cookie, 'no-such-service');

      expect(theirs.status).toBe(404);
      expect((theirs.body as { message: string }).message).toBe(
        'Service not found',
      );
      expect(unknown.status).toBe(404);
      expect(forward.exec).not.toHaveBeenCalled();
    });

    it('answers cloud-account for a Service in a Cloud account, without reaching any Server', async () => {
      const { cookie, organizationId } = await given();
      const apiId = await cloudApplication(organizationId);
      const ida = await memberWith(cookie, organizationId, []);

      const byOwner = await readService(cookie, apiId);
      const byMember = await readService(ida.cookie, apiId);

      expect(byOwner.status).toBe(200);
      expect(byOwner.body).toEqual({
        state: 'cloud-account',
        service: { serviceId: apiId, name: 'api' },
      });
      // Not theirs to read: not found, so the tab reveals nothing.
      expect(byMember.status).toBe(404);
      expect(forward.exec).not.toHaveBeenCalled();
    });

    it('has no read for a Database', async () => {
      const { cookie } = await given();
      const [environmentRow] = await ctx.db
        .select({ environmentId: environment.environmentId })
        .from(environment)
        .limit(1);
      const [database] = await ctx.db
        .insert(postgres)
        .values({
          name: 'DB',
          environmentId: environmentRow.environmentId,
          configName: 'db',
          dockerImage: 'postgres:16',
          databaseName: 'shop',
          databaseUser: 'shop',
          databasePassword: 'super-secret-database-password',
        })
        .returning({ postgresId: postgres.postgresId });

      const res = await readService(cookie, database.postgresId);

      expect(res.status).toBe(404);
      expect((res.body as { message: string }).message).toBe(
        'Service not found',
      );
      expect(forward.exec).not.toHaveBeenCalled();
    });

    it('lets a Frozen Organization still read the tab', async () => {
      const { cookie, organizationId, serverId, shopId } = await given();
      logs.set(serverId, { text: `${LOG}\n` });
      await freezeOrganization(ctx, organizationId);

      const res = await readService(cookie, shopId);

      expect(res.status).toBe(200);
      expect((res.body as Read).totalCount).toBe(2);
    });
  });
  // ADR-0061: the platform host's access log is read as its Services, against
  // every Organization's Domains there, and a host two Organizations hold
  // there is matched by neither.
  describe('the platform host', () => {
    /** Two hours of the platform host's traffic, across Organizations. */
    const PLATFORM_LOG = [
      line({
        at: '2026-11-06T10:05:00Z',
        host: 'web.example.com',
        path: '/reset?token=s3cret&user=7',
      }),
      line({
        at: '2026-11-06T10:10:00Z',
        host: 'api.example.com',
        path: '/v1',
      }),
      line({
        at: '2026-11-06T10:15:00Z',
        host: 'status.example.com',
        path: '/',
      }),
      line({ at: '2026-11-06T10:20:00Z', path: '/wp-login.php', status: 404 }),
      // A Domain on a Server, not on the platform host: it matches nothing here.
      line({ at: '2026-11-06T10:25:00Z', host: 'shop.example.com', path: '/' }),
      line({
        at: '2026-11-06T11:05:00Z',
        host: 'web.example.com',
        path: '/about',
        method: 'POST',
      }),
    ].join('\n');

    function readService(
      cookie: string,
      serviceId: string,
      query: Record<string, unknown> = {},
    ) {
      return request(httpServer)
        .get(`/monitoring/requests/services/${serviceId}`)
        .query({ ...RANGE, ...query })
        .set('Cookie', cookie);
    }

    function picker(cookie: string) {
      return request(httpServer)
        .get('/monitoring/requests/servers')
        .set('Cookie', cookie);
    }

    /**
     * Each call's Project is numbered: a test may put more Applications on the
     * platform host for an Organization `givenPlatformHost` already set up, and
     * a Project name is unique in an Organization.
     */
    let platformHostProjects = 0;

    /** Applications on the platform host of one Organization, with their Domains. */
    async function onPlatformHost(
      creator: {
        user: { id: string };
        session: { activeOrganizationId: string };
      },
      apps: { name: string; host: string; path?: string; appName?: string }[],
    ): Promise<string[]> {
      const project = await ctx.app.get(ProjectsService).create(creator, {
        name: `On the platform host ${++platformHostProjects}`,
      });
      const environment = await ctx.app
        .get(EnvironmentsService)
        .create(creator, {
          name: 'production',
          projectId: project.projectId,
          deployTarget: { kind: 'platform-host' },
        });
      const ids: string[] = [];
      for (const each of apps) {
        const created = await ctx.app.get(ApplicationsService).create(creator, {
          name: each.name,
          appName: each.appName ?? `${each.name}-app`,
          environmentId: environment.environmentId,
        });
        await ctx.db.insert(domain).values({
          host: each.host,
          path: each.path ?? '/',
          applicationId: created.applicationId,
        });
        ids.push(created.applicationId);
      }
      return ids;
    }

    /**
     * The instance owner (with `status` on the platform host and `shop` on a
     * Server), and Mallory, owner of a second Organization, with `web` and
     * `api` on the platform host.
     */
    async function givenPlatformHost() {
      const base = await given();
      const [statusId] = await onPlatformHost(
        {
          user: { id: base.ownerId },
          session: { activeOrganizationId: base.organizationId },
        },
        [{ name: 'status', host: 'status.example.com' }],
      );
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        base.cookie,
      );
      const malloryCtx = {
        user: { id: mallory.id },
        session: { activeOrganizationId: mallory.organizationId },
      };
      const [webId, apiId] = await onPlatformHost(malloryCtx, [
        { name: 'web', host: 'web.example.com' },
        { name: 'api', host: 'api.example.com' },
      ]);
      jest
        .spyOn(ctx.app.get(AccessLogService), 'loggingOn')
        .mockReturnValue(true);
      jest
        .spyOn(ctx.app.get(AccessLogService), 'readWindow')
        .mockResolvedValue({
          raw: `${PLATFORM_LOG}\n`,
          fromOffset: 0,
          bytesRead: PLATFORM_LOG.length,
          bytesIndexed: 0,
        });
      return { ...base, statusId, mallory, malloryCtx, webId, apiId };
    }

    it("gives a non-instance owner its own Services' lines, query values hidden, and no 403", async () => {
      const { mallory, webId, apiId } = await givenPlatformHost();

      const res = await read(mallory.cookie, {});

      expect(res.status).toBe(200);
      const body = res.body as Read;
      expect(body.state).toBe('ok');
      expect(body.target).toEqual({ serverId: null, name: 'Platform host' });
      expect(body.totalCount).toBe(3);
      expect(body.data.map((row) => row.service?.name).sort()).toEqual([
        'api',
        'web',
        'web',
      ]);
      expect(
        body.data.find((row) => row.RequestPath?.startsWith('/reset'))
          ?.RequestPath,
      ).toBe('/reset?token=***&user=***');
      expect(JSON.stringify(body)).not.toContain('s3cret');
      expect(body.services).toEqual([
        { serviceId: apiId, name: 'api' },
        { serviceId: webId, name: 'web' },
      ]);
      expect(body.covers).toBe('your-services');
      expect(body.noService).toBe(false);
      expect(body.wholeServer).toBe(false);
      expect(body.canSwitchLogging).toBe(false);
    });

    it("shows no line of another Organization's platform-host Domain, none that matched no Domain, and none of a Server's Domain", async () => {
      const { mallory } = await givenPlatformHost();

      const body = (await read(mallory.cookie, {})).body as Read;

      const text = JSON.stringify(body);
      expect(text).not.toContain('status.example.com');
      expect(text).not.toContain('wp-login');
      expect(text).not.toContain('shop.example.com');
      expect(body.data.some((row) => row.service === null)).toBe(false);
    });

    it("answers a platform-host Service's tab with its own lines, not platform-host", async () => {
      const { mallory, webId } = await givenPlatformHost();

      const res = await readService(mallory.cookie, webId);

      expect(res.status).toBe(200);
      const body = res.body as Read & { withheldShared: number };
      expect(body.state).toBe('ok');
      expect(body.target).toEqual({ serverId: null, name: 'Platform host' });
      expect(body.covers).toBe('service');
      expect(body.services).toEqual([{ serviceId: webId, name: 'web' }]);
      expect(body.totalCount).toBe(2);
      expect(body.data.every((row) => row.service?.serviceId === webId)).toBe(
        true,
      );
      expect(body.withheldShared).toBe(0);
      expect(JSON.stringify(body)).not.toContain('s3cret');
    });

    it("gives a member with service: ['read'] on one of two Services only its lines, on the tab and on the page", async () => {
      const { mallory, webId, apiId } = await givenPlatformHost();
      // Mallory's Organization is not the owner's active one: invite there.
      const ida = await memberWith(mallory.cookie, mallory.organizationId, [
        apiId,
      ]);

      const page = (await read(ida.cookie, {})).body as Read;
      const api = await readService(ida.cookie, apiId);
      const web = await readService(ida.cookie, webId);
      const listed = (await picker(ida.cookie)).body as {
        platformHost: boolean;
      };

      expect(page.totalCount).toBe(1);
      expect(page.data.map((row) => row.service?.name)).toEqual(['api']);
      expect(page.services).toEqual([{ serviceId: apiId, name: 'api' }]);
      expect(api.status).toBe(200);
      expect((api.body as Read).totalCount).toBe(1);
      expect(web.status).toBe(404);
      expect(listed.platformHost).toBe(true);
    });

    it('lists the platform host for a caller who can read a Service there, and not for one who cannot', async () => {
      const { mallory } = await givenPlatformHost();
      const ida = await memberWith(mallory.cookie, mallory.organizationId, []);

      const malloryPicker = await picker(mallory.cookie);
      const idaPicker = await picker(ida.cookie);
      const idaRead = await read(ida.cookie, {});

      expect(malloryPicker.body).toEqual({
        servers: [],
        platformHost: true,
        cloudAccountServices: false,
      });
      expect(idaPicker.body).toEqual({
        servers: [],
        platformHost: false,
        cloudAccountServices: false,
      });
      expect(idaRead.status).toBe(403);
    });

    it('narrows to the chosen Services, and a Service id the caller cannot read finds nothing', async () => {
      const { mallory, webId, statusId } = await givenPlatformHost();

      const chosen = (await read(mallory.cookie, { serviceId: [webId] }))
        .body as Read;
      const theirs = (await read(mallory.cookie, { serviceId: [statusId] }))
        .body as Read;

      expect(chosen.covers).toBe('chosen-services');
      expect(chosen.totalCount).toBe(2);
      expect(theirs.totalCount).toBe(0);
      expect(JSON.stringify(theirs)).not.toContain('status.example.com');
    });

    it('lets instance authority read every line, each matched one naming its Service', async () => {
      const { cookie, webId, statusId } = await givenPlatformHost();

      const res = await read(cookie, {});

      expect(res.status).toBe(200);
      const body = res.body as Read;
      expect(body.totalCount).toBe(6);
      expect(body.covers).toBe('server');
      expect(body.wholeServer).toBe(true);
      expect(body.noService).toBe(true);
      expect(body.canSwitchLogging).toBe(true);
      const serviceOf = (host: string | undefined) =>
        body.data.find((row) => row.RequestHost === host)?.service;
      expect(serviceOf('web.example.com')).toEqual({
        serviceId: webId,
        name: 'web',
      });
      expect(serviceOf('status.example.com')).toEqual({
        serviceId: statusId,
        name: 'status',
      });
      expect(serviceOf(undefined)).toBeNull();
      expect(serviceOf('shop.example.com')).toBeNull();
      expect(JSON.stringify(body)).not.toContain('s3cret');
    });

    it('shows a host two Organizations hold to neither, and says so on both tabs', async () => {
      const { cookie, mallory, malloryCtx } = await givenPlatformHost();
      const [storeId] = await onPlatformHost(malloryCtx, [
        { name: 'store', host: 'store.example.com', path: '/' },
      ]);
      const trent = await secondOrganizationOwner(httpServer, ctx.db, cookie, {
        email: 'trent@example.com',
        name: 'Trent',
        organizationName: 'Third Org',
      });
      const [blogId] = await onPlatformHost(
        {
          user: { id: trent.id },
          session: { activeOrganizationId: trent.organizationId },
        },
        [
          {
            name: 'blog',
            // `given()`'s blog already holds `blog-app`, unique on the instance.
            appName: 'store-blog-app',
            host: 'store.example.com',
            path: '/blog',
          },
        ],
      );
      const shared = [
        PLATFORM_LOG,
        line({
          at: '2026-11-06T10:30:00Z',
          host: 'store.example.com',
          path: '/blog/x',
        }),
        line({
          at: '2026-11-06T10:35:00Z',
          host: 'store.example.com',
          path: '/cart',
        }),
      ].join('\n');
      jest
        .spyOn(ctx.app.get(AccessLogService), 'readWindow')
        .mockResolvedValue({
          raw: `${shared}\n`,
          fromOffset: 0,
          bytesRead: shared.length,
          bytesIndexed: 0,
        });

      const storeTab = (await readService(mallory.cookie, storeId))
        .body as Read & { withheldShared: number };
      const blogTab = (await readService(trent.cookie, blogId)).body as Read & {
        withheldShared: number;
      };
      const malloryPage = (await read(mallory.cookie, {})).body as Read;
      const trentPage = (await read(trent.cookie, {})).body as Read;
      const instancePage = (await read(cookie, {})).body as Read & {
        withheldShared: number;
      };

      expect(storeTab.totalCount).toBe(0);
      expect(storeTab.withheldShared).toBe(2);
      expect(blogTab.totalCount).toBe(0);
      expect(blogTab.withheldShared).toBe(2);
      expect(JSON.stringify(malloryPage)).not.toContain('store.example.com');
      expect(malloryPage.totalCount).toBe(3);
      expect(JSON.stringify(trentPage)).not.toContain('store.example.com');
      expect(trentPage.totalCount).toBe(0);
      // Matched for no Organization, but the instance reads each with the
      // Service Traefik routed it to, by the longest path prefix.
      expect(
        instancePage.data
          .filter((row) => row.RequestHost === 'store.example.com')
          .map((row) => [row.RequestPath, row.service]),
      ).toEqual(
        expect.arrayContaining([
          ['/blog/x', { serviceId: blogId, name: 'blog' }],
          ['/cart', { serviceId: storeId, name: 'store' }],
        ]),
      );
      expect(instancePage.withheldShared).toBe(0);
    });

    it("never counts a Cloud account Application's Domain as holding a platform-host host", async () => {
      const { organizationId, mallory } = await givenPlatformHost();
      const apiInCloud = await cloudApplication(organizationId);
      await ctx.db
        .insert(domain)
        .values({ host: 'web.example.com', applicationId: apiInCloud });

      const body = (await read(mallory.cookie, {})).body as Read;

      expect(
        body.data.filter((row) => row.RequestHost === 'web.example.com'),
      ).toHaveLength(2);
    });

    it('tells a non-instance caller logging is off and offers no switch', async () => {
      const { cookie, mallory, webId } = await givenPlatformHost();
      jest
        .spyOn(ctx.app.get(AccessLogService), 'loggingOn')
        .mockReturnValue(false);

      const page = (await read(mallory.cookie, {})).body as Read;
      const tab = (await readService(mallory.cookie, webId)).body as Read;
      const byInstance = (await read(cookie, {})).body as Read;

      expect(page).toMatchObject({
        state: 'logging-off',
        canSwitchLogging: false,
        totalCount: 0,
        data: [],
      });
      expect(tab).toMatchObject({
        state: 'logging-off',
        canSwitchLogging: false,
        totalCount: 0,
      });
      expect(byInstance).toMatchObject({
        state: 'logging-off',
        canSwitchLogging: true,
      });
    });

    it('lets a Frozen Organization still read its own platform-host lines', async () => {
      const { mallory, webId } = await givenPlatformHost();
      await freezeOrganization(ctx, mallory.organizationId);

      const page = await read(mallory.cookie, {});
      const tab = await readService(mallory.cookie, webId);

      expect(page.status).toBe(200);
      expect((page.body as Read).totalCount).toBe(3);
      expect(tab.status).toBe(200);
      expect((tab.body as Read).totalCount).toBe(2);
    });
  });
});
