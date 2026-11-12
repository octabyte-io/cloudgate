import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { parse } from 'yaml';
import * as schema from '../../src/db/schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { MAIN_TRAEFIK_DIR } from '../../src/settings/traefik-files.service';
import { withArgvExec } from '../utils/exec-double';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { seededConfigName } from '../utils/seeded-config-name';

jest.setTimeout(120_000);

const STORAGE = '/etc/cloudgate/traefik/dynamic/acme.json';
const TRAEFIK_YML = `certificatesResolvers:
  letsencrypt:
    acme:
      email: ops@example.com
      storage: ${STORAGE}
      httpChallenge:
        entryPoint: web
`;

/** Two credential values nothing but the container env may ever hold. */
const TOKEN = 'cf-token-5b1e9d';
const ZONE = 'cf-zone-77ac02';

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ok = (stdout: string): ExecResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
});

const INSTANCE_AUTHORITY_REFUSAL =
  'Only an owner or admin of the instance organization can configure the platform host';

type Resolvers = Record<string, { acme: Record<string, unknown> }>;

/**
 * A machine's DNS-01 setup over HTTP: the three routes, what they write
 * into `traefik.yml` and Traefik's env, and what no response may carry.
 *
 * Traefik is a swarm service here, answered by an exec double that dispatches
 * on the command rather than on call order — the recreate runs in the
 * background, so the order of its reads against the request's is not fixed —
 * and by a Docker double whose `service.update` records the env Traefik was
 * recreated with. That env is the assertion, because it is what Traefik reads
 * its DNS provider's credentials from.
 */
describe('DNS challenge settings (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let traefikDir: string;
  /** The env `docker service inspect` answers for Traefik's container. */
  let containerEnv: string[];

  const remoteExec = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });
  const serviceUpdate = jest.fn<Promise<void>, [unknown]>();
  const dockerFactory = {
    getRemoteDocker: jest.fn<Promise<unknown>, [string | undefined]>(),
  };

  const ymlPath = () => path.join(traefikDir, 'traefik.yml');
  const resolvers = () =>
    (
      parse(fs.readFileSync(ymlPath(), 'utf8')) as {
        certificatesResolvers: Resolvers;
      }
    ).certificatesResolvers;

  /** The env of the last Traefik recreate, once the background one lands. */
  async function recreatedEnv(times = 1): Promise<string[]> {
    for (let i = 0; i < 100 && serviceUpdate.mock.calls.length < times; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(serviceUpdate).toHaveBeenCalledTimes(times);
    const spec = serviceUpdate.mock.calls.at(-1)?.[0] as {
      TaskTemplate: { ContainerSpec: { Env: string[] } };
    };
    return spec.TaskTemplate.ContainerSpec.Env;
  }

  async function signUp(): Promise<string> {
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    return res.headers['set-cookie'];
  }

  const put = (cookie: string, body: object) =>
    request(httpServer)
      .put('/settings/traefik/dns-challenge')
      .set('Cookie', cookie)
      .send(body);

  beforeAll(async () => {
    traefikDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-dns-'));
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: remoteExec },
        { provide: RemoteDockerFactory, useValue: dockerFactory },
        { provide: MAIN_TRAEFIK_DIR, useValue: () => traefikDir },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
    fs.rmSync(traefikDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    fs.rmSync(traefikDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(traefikDir, 'dynamic'), { recursive: true });
    fs.writeFileSync(ymlPath(), TRAEFIK_YML);
    containerEnv = ['TRAEFIK_A=1'];
    // `clearAllMocks` keeps implementations, and a test below gives this one.
    remoteExec.execAsyncRemote.mockReset();
    remoteExec.execAsync.mockImplementation((command: string) => {
      if (command.includes('RESOURCE_NAME=')) {
        return Promise.resolve(ok('service\n'));
      }
      if (command.includes('ContainerSpec.Env')) {
        return Promise.resolve(ok(JSON.stringify(containerEnv)));
      }
      if (command.includes('EndpointSpec.Ports')) {
        return Promise.resolve(ok('null'));
      }
      return Promise.resolve(ok(''));
    });
    serviceUpdate.mockResolvedValue(undefined);
    dockerFactory.getRemoteDocker.mockResolvedValue({
      getService: () => ({
        inspect: () =>
          Promise.resolve({
            Version: { Index: '1' },
            Spec: { TaskTemplate: { ForceUpdate: 0 } },
          }),
        update: serviceUpdate,
      }),
    });
  });

  it('answers null for a machine with no DNS challenge', async () => {
    const cookie = await signUp();

    const res = await request(httpServer)
      .get('/settings/traefik/dns-challenge')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(res.text).toBe('');
  });

  it('sets a provider, answers key names and never a value, and stores the values encrypted', async () => {
    const cookie = await signUp();

    const saved = await put(cookie, {
      provider: 'cloudflare',
      credentials: { CF_DNS_API_TOKEN: TOKEN, CF_ZONE_API_TOKEN: ZONE },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      provider: 'cloudflare',
      credentialKeys: ['CF_DNS_API_TOKEN', 'CF_ZONE_API_TOKEN'],
    });
    expect(saved.text).not.toContain(TOKEN);
    expect(saved.text).not.toContain(ZONE);

    const read = await request(httpServer)
      .get('/settings/traefik/dns-challenge')
      .set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(saved.body);
    expect(read.text).not.toContain(TOKEN);

    // At rest, the map is ciphertext (ADR 0006).
    const raw = await ctx.db.execute<{ credentials: string }>(
      sql`select credentials from dns_challenge`,
    );
    expect(raw.rows[0].credentials.startsWith('enc:v1:')).toBe(true);
    expect(raw.rows[0].credentials).not.toContain(TOKEN);

    // The resolver sits beside letsencrypt, sharing its email and storage.
    expect(resolvers()['letsencrypt-dns']).toEqual({
      acme: {
        email: 'ops@example.com',
        storage: STORAGE,
        dnsChallenge: { provider: 'cloudflare' },
      },
    });
    expect(resolvers().letsencrypt.acme).toHaveProperty('httpChallenge');

    // And Traefik is recreated with the credentials in its env.
    expect(await recreatedEnv()).toEqual([
      'TRAEFIK_A=1',
      `CF_DNS_API_TOKEN=${TOKEN}`,
      `CF_ZONE_API_TOKEN=${ZONE}`,
    ]);
  });

  it('keeps the stored credentials when a PUT omits them', async () => {
    const cookie = await signUp();
    await put(cookie, {
      provider: 'cloudflare',
      credentials: { CF_DNS_API_TOKEN: TOKEN },
    });
    await recreatedEnv(1);
    containerEnv = ['TRAEFIK_A=1', `CF_DNS_API_TOKEN=${TOKEN}`];

    const res = await put(cookie, { provider: 'acme-dns' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      provider: 'acme-dns',
      credentialKeys: ['CF_DNS_API_TOKEN'],
    });
    const row = await ctx.db.query.dnsChallenge.findFirst();
    expect(row?.credentials).toEqual({ CF_DNS_API_TOKEN: TOKEN });
    expect(resolvers()['letsencrypt-dns'].acme.dnsChallenge).toEqual({
      provider: 'acme-dns',
    });
    expect(await recreatedEnv(2)).toEqual([
      'TRAEFIK_A=1',
      `CF_DNS_API_TOKEN=${TOKEN}`,
    ]);
  });

  /**
   * Both PUTs read "no row" before either writes, which is the race a read and
   * then an insert lost with a unique-index 500 (§2.3). The platform host is
   * the case worth pinning: its row is unique only through the partial index.
   */
  it('answers two concurrent first PUTs on the platform host with one row, and no 500', async () => {
    const cookie = await signUp();

    const answers = await Promise.all([
      put(cookie, {
        provider: 'cloudflare',
        credentials: { CF_DNS_API_TOKEN: TOKEN },
      }),
      put(cookie, {
        provider: 'cloudflare',
        credentials: { CF_DNS_API_TOKEN: TOKEN, CF_ZONE_API_TOKEN: ZONE },
      }),
    ]);

    expect(answers.map((res) => res.status)).toEqual([200, 200]);
    expect(await ctx.db.query.dnsChallenge.findMany()).toHaveLength(1);
    await recreatedEnv(2);
  });

  it('answers two concurrent first PUTs on a Server with one row, and no 500', async () => {
    const cookie = await signUp();
    const orgs = await request(httpServer)
      .get('/organizations')
      .set('Cookie', cookie);
    const [remote] = await ctx.db
      .insert(schema.server)
      .values({
        name: 'srv',
        ipAddress: '10.0.0.1',
        port: 22,
        organizationId: (orgs.body as { id: string }[])[0].id,
      })
      .returning();
    // The Server's traefik.yml, and its Traefik answered as the platform
    // host's is, so both background recreates land inside this test.
    remoteExec.execAsyncRemote.mockImplementation(
      (_serverId: string, command: string) =>
        command.startsWith('cat ')
          ? Promise.resolve(ok(TRAEFIK_YML))
          : remoteExec.execAsync(command),
    );
    const body = {
      serverId: remote.serverId,
      provider: 'cloudflare',
      credentials: { CF_DNS_API_TOKEN: TOKEN },
    };

    const answers = await Promise.all([put(cookie, body), put(cookie, body)]);

    expect(answers.map((res) => res.status)).toEqual([200, 200]);
    const rows = await ctx.db.query.dnsChallenge.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].serverId).toBe(remote.serverId);
    await recreatedEnv(2);
  });

  it('takes a key the new map leaves out off Traefik’s env', async () => {
    const cookie = await signUp();
    await put(cookie, {
      provider: 'cloudflare',
      credentials: { CF_DNS_API_TOKEN: TOKEN, CF_ZONE_API_TOKEN: ZONE },
    });
    await recreatedEnv(1);
    containerEnv = [
      'TRAEFIK_A=1',
      `CF_DNS_API_TOKEN=${TOKEN}`,
      `CF_ZONE_API_TOKEN=${ZONE}`,
    ];

    const res = await put(cookie, {
      provider: 'route53',
      credentials: { AWS_ACCESS_KEY_ID: 'AKIA1' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      provider: 'route53',
      credentialKeys: ['AWS_ACCESS_KEY_ID'],
    });
    expect(await recreatedEnv(2)).toEqual([
      'TRAEFIK_A=1',
      'AWS_ACCESS_KEY_ID=AKIA1',
    ]);
  });

  describe('refusals', () => {
    it.each([
      ['credentials omitted with none stored', { provider: 'cloudflare' }],
      ['an empty map', { provider: 'cloudflare', credentials: {} }],
      [
        'a provider that is not a lego code',
        { provider: 'Cloud Flare', credentials: { A: 'x' } },
      ],
      [
        'a lower-case key',
        { provider: 'cloudflare', credentials: { cf_token: 'x' } },
      ],
      [
        'an empty value',
        { provider: 'cloudflare', credentials: { CF_DNS_API_TOKEN: '' } },
      ],
      [
        'a value with a newline',
        { provider: 'cloudflare', credentials: { CF_DNS_API_TOKEN: 'a\nB=c' } },
      ],
      [
        'a value with a NUL',
        {
          provider: 'cloudflare',
          credentials: { CF_DNS_API_TOKEN: 'a\u0000b' },
        },
      ],
    ])('refuses %s with 400 and writes nothing', async (_name, body) => {
      const cookie = await signUp();

      const res = await put(cookie, body);

      expect(res.status).toBe(400);
      expect(await ctx.db.query.dnsChallenge.findMany()).toEqual([]);
      expect(resolvers()).not.toHaveProperty('letsencrypt-dns');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(serviceUpdate).not.toHaveBeenCalled();
    });

    it('refuses with 409 a machine whose traefik.yml has no letsencrypt resolver, and stores nothing', async () => {
      const cookie = await signUp();
      fs.writeFileSync(ymlPath(), 'entryPoints:\n  web:\n    address: ":80"\n');

      const res = await put(cookie, {
        provider: 'cloudflare',
        credentials: { CF_DNS_API_TOKEN: TOKEN },
      });

      expect(res.status).toBe(409);
      expect(await ctx.db.query.dnsChallenge.findMany()).toEqual([]);
    });

    it('refuses a plain member and another organization’s owner on the platform host', async () => {
      const cookie = await signUp();
      const member = await signUpMember(httpServer, cookie);
      const mallory = await secondOrganizationOwner(httpServer, ctx.db, cookie);

      for (const caller of [member.cookie, mallory.cookie]) {
        const read = await request(httpServer)
          .get('/settings/traefik/dns-challenge')
          .set('Cookie', caller);
        const write = await put(caller, {
          provider: 'cloudflare',
          credentials: { CF_DNS_API_TOKEN: TOKEN },
        });
        const remove = await request(httpServer)
          .delete('/settings/traefik/dns-challenge')
          .set('Cookie', caller);
        for (const res of [read, write, remove]) {
          expect(res.status).toBe(403);
          expect((res.body as { message: string }).message).toBe(
            INSTANCE_AUTHORITY_REFUSAL,
          );
        }
      }
      // Nothing was written on the way to being refused.
      expect(await ctx.db.query.dnsChallenge.findMany()).toEqual([]);
    });

    it('refuses another organization’s owner a Server that is not hers', async () => {
      const cookie = await signUp();
      const mallory = await secondOrganizationOwner(httpServer, ctx.db, cookie);
      const [remote] = await ctx.db
        .insert(schema.server)
        .values({
          name: 'srv',
          ipAddress: '10.0.0.1',
          port: 22,
          organizationId: mallory.instanceOrganizationId,
        })
        .returning();

      const res = await put(mallory.cookie, {
        serverId: remote.serverId,
        provider: 'cloudflare',
        credentials: { CF_DNS_API_TOKEN: TOKEN },
      });

      expect(res.status).toBe(404);
      expect(await ctx.db.query.dnsChallenge.findMany()).toEqual([]);
      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    async function previewsOn(cookie: string, names: string[]) {
      const orgs = await request(httpServer)
        .get('/organizations')
        .set('Cookie', cookie);
      const organizationId = (orgs.body as { id: string }[])[0].id;
      const [project] = await ctx.db
        .insert(schema.project)
        .values({ name: 'Shop', organizationId })
        .returning();
      const [environment] = await ctx.db
        .insert(schema.environment)
        .values({ name: 'production', projectId: project.projectId })
        .returning();
      for (const name of names) {
        await ctx.db.insert(schema.application).values({
          name,
          appName: name.toLowerCase().replace(/\s/g, '-'),
          environmentId: environment.environmentId,
          configName: seededConfigName(),
          previewDnsChallenge: true,
        });
      }
      // Previews on the platform host without the switch do not hold it.
      await ctx.db.insert(schema.application).values({
        name: 'Unrelated',
        appName: 'unrelated',
        environmentId: environment.environmentId,
        configName: seededConfigName(),
      });
    }

    it('refuses with 409 naming the Applications whose previews use it, and keeps everything', async () => {
      const cookie = await signUp();
      await put(cookie, {
        provider: 'cloudflare',
        credentials: { CF_DNS_API_TOKEN: TOKEN },
      });
      await recreatedEnv(1);
      await previewsOn(cookie, ['Shop API', 'Admin']);

      const res = await request(httpServer)
        .delete('/settings/traefik/dns-challenge')
        .set('Cookie', cookie);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        code: 'DNS_CHALLENGE_IN_USE',
        message:
          'Previews of Admin, Shop API issue their certificate through this DNS challenge; turn that off on them first',
      });
      expect(await ctx.db.query.dnsChallenge.findMany()).toHaveLength(1);
      expect(resolvers()).toHaveProperty('letsencrypt-dns');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(serviceUpdate).toHaveBeenCalledTimes(1);
    });

    it('does not count an Application whose previews run on another machine', async () => {
      const cookie = await signUp();
      await put(cookie, {
        provider: 'cloudflare',
        credentials: { CF_DNS_API_TOKEN: TOKEN },
      });
      await recreatedEnv(1);
      await previewsOn(cookie, ['Shop API']);
      const orgs = await request(httpServer)
        .get('/organizations')
        .set('Cookie', cookie);
      const [remote] = await ctx.db
        .insert(schema.server)
        .values({
          name: 'srv',
          ipAddress: '10.0.0.1',
          port: 22,
          organizationId: (orgs.body as { id: string }[])[0].id,
        })
        .returning();
      await ctx.db
        .update(schema.application)
        .set({ serverId: remote.serverId });

      const res = await request(httpServer)
        .delete('/settings/traefik/dns-challenge')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
    });

    /** A Project and Environment in the caller's Organization. */
    async function environmentOf(cookie: string) {
      const orgs = await request(httpServer)
        .get('/organizations')
        .set('Cookie', cookie);
      const organizationId = (orgs.body as { id: string }[])[0].id;
      const [project] = await ctx.db
        .insert(schema.project)
        .values({ name: 'Shop', organizationId })
        .returning();
      const [environment] = await ctx.db
        .insert(schema.environment)
        .values({ name: 'production', projectId: project.projectId })
        .returning();
      return { organizationId, environmentId: environment.environmentId };
    }

    const dnsCertificate = {
      certificateType: 'custom' as const,
      customCertResolver: 'letsencrypt-dns',
    };

    it('refuses with 409 naming the Domains whose certificate it issues, on an Application or a Compose stack, and keeps everything', async () => {
      const cookie = await signUp();
      await put(cookie, {
        provider: 'cloudflare',
        credentials: { CF_DNS_API_TOKEN: TOKEN },
      });
      await recreatedEnv(1);
      const { organizationId, environmentId } = await environmentOf(cookie);
      const [app] = await ctx.db
        .insert(schema.application)
        .values({
          name: 'Web',
          appName: 'web',
          environmentId,
          configName: seededConfigName(),
        })
        .returning();
      const [stack] = await ctx.db
        .insert(schema.compose)
        .values({
          name: 'Stack',
          appName: 'stack',
          environmentId,
          configName: seededConfigName(),
        })
        .returning();
      const [remote] = await ctx.db
        .insert(schema.server)
        .values({
          name: 'srv',
          ipAddress: '10.0.0.1',
          port: 22,
          organizationId,
        })
        .returning();
      const [remoteApp] = await ctx.db
        .insert(schema.application)
        .values({
          name: 'Remote',
          appName: 'remote',
          environmentId,
          configName: seededConfigName(),
          serverId: remote.serverId,
        })
        .returning();
      await ctx.db.insert(schema.domain).values([
        {
          host: 'www.example.com',
          applicationId: app.applicationId,
          ...dnsCertificate,
        },
        {
          host: 'stack.example.com',
          composeId: stack.composeId,
          ...dnsCertificate,
        },
        // Neither of these asks this machine's Traefik for the resolver.
        {
          host: 'other.example.com',
          applicationId: app.applicationId,
          certificateType: 'custom',
          customCertResolver: 'some-other-resolver',
        },
        {
          host: 'remote.example.com',
          applicationId: remoteApp.applicationId,
          ...dnsCertificate,
        },
      ]);

      const res = await request(httpServer)
        .delete('/settings/traefik/dns-challenge')
        .set('Cookie', cookie);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        code: 'DNS_CHALLENGE_IN_USE',
        message:
          'Domains stack.example.com, www.example.com issue their certificate through this DNS challenge; give them another certificate first',
      });
      expect(await ctx.db.query.dnsChallenge.findMany()).toHaveLength(1);
      expect(resolvers()).toHaveProperty('letsencrypt-dns');
    });

    it('refuses with 409 while forward auth issues its certificate through it, naming its domain', async () => {
      const cookie = await signUp();
      await put(cookie, {
        provider: 'cloudflare',
        credentials: { CF_DNS_API_TOKEN: TOKEN },
      });
      await recreatedEnv(1);
      await ctx.db.insert(schema.forwardAuthSettings).values({
        authDomain: 'auth.example.com',
        baseDomain: '.example.com',
        ...dnsCertificate,
      });

      const res = await request(httpServer)
        .delete('/settings/traefik/dns-challenge')
        .set('Cookie', cookie);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'DNS_CHALLENGE_IN_USE',
        message:
          'Forward auth on auth.example.com issues its certificate through this DNS challenge; give it another certificate first',
      });
      expect(await ctx.db.query.dnsChallenge.findMany()).toHaveLength(1);
      expect(resolvers()).toHaveProperty('letsencrypt-dns');
    });

    it('names every kind of thing relying on it in one refusal', async () => {
      const cookie = await signUp();
      await put(cookie, {
        provider: 'cloudflare',
        credentials: { CF_DNS_API_TOKEN: TOKEN },
      });
      await recreatedEnv(1);
      await previewsOn(cookie, ['Shop API']);
      const [app] = await ctx.db
        .select({ applicationId: schema.application.applicationId })
        .from(schema.application)
        .limit(1);
      await ctx.db.insert(schema.domain).values({
        host: 'www.example.com',
        applicationId: app.applicationId,
        ...dnsCertificate,
      });

      const res = await request(httpServer)
        .delete('/settings/traefik/dns-challenge')
        .set('Cookie', cookie);

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        'Previews of Shop API issue their certificate through this DNS challenge; turn that off on it first. ' +
          'Domain www.example.com issues its certificate through this DNS challenge; give it another certificate first',
      );
    });

    it('keeps the row when traefik.yml cannot be rewritten, so row, file and env still agree', async () => {
      const cookie = await signUp();
      const { organizationId } = await environmentOf(cookie);
      const [remote] = await ctx.db
        .insert(schema.server)
        .values({
          name: 'srv',
          ipAddress: '10.0.0.1',
          port: 22,
          organizationId,
        })
        .returning();
      await ctx.db.insert(schema.dnsChallenge).values({
        serverId: remote.serverId,
        provider: 'cloudflare',
        credentials: { CF_DNS_API_TOKEN: TOKEN },
      });
      const withResolver = `${TRAEFIK_YML}  letsencrypt-dns:
    acme:
      email: ops@example.com
      storage: ${STORAGE}
      dnsChallenge:
        provider: cloudflare
`;
      remoteExec.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          command.startsWith('cat ')
            ? Promise.resolve(ok(withResolver))
            : command.includes('base64 -d >')
              ? Promise.reject(new Error('No space left on device'))
              : Promise.resolve(ok('')),
      );

      const res = await request(httpServer)
        .delete(`/settings/traefik/dns-challenge?serverId=${remote.serverId}`)
        .set('Cookie', cookie);

      expect(res.status).toBeGreaterThanOrEqual(500);
      // The write was attempted, failed, and nothing after it happened.
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        remote.serverId,
        expect.stringContaining('base64 -d >'),
      );
      expect(await ctx.db.query.dnsChallenge.findMany()).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(serviceUpdate).not.toHaveBeenCalled();
    });

    it('removes the row, the resolver and the credentials from Traefik’s env', async () => {
      const cookie = await signUp();
      await put(cookie, {
        provider: 'cloudflare',
        credentials: { CF_DNS_API_TOKEN: TOKEN },
      });
      await recreatedEnv(1);
      containerEnv = ['TRAEFIK_A=1', `CF_DNS_API_TOKEN=${TOKEN}`];

      const res = await request(httpServer)
        .delete('/settings/traefik/dns-challenge')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(await ctx.db.query.dnsChallenge.findMany()).toEqual([]);
      expect(resolvers()).not.toHaveProperty('letsencrypt-dns');
      expect(resolvers()).toHaveProperty('letsencrypt');
      expect(await recreatedEnv(2)).toEqual(['TRAEFIK_A=1']);
    });

    it('answers 404 when there is nothing to remove', async () => {
      const cookie = await signUp();

      const res = await request(httpServer)
        .delete('/settings/traefik/dns-challenge')
        .set('Cookie', cookie);

      expect(res.status).toBe(404);
    });
  });

  describe('Traefik’s env', () => {
    it('withholds the credentials from GET /settings/traefik/env', async () => {
      const cookie = await signUp();
      await put(cookie, {
        provider: 'cloudflare',
        credentials: { CF_DNS_API_TOKEN: TOKEN },
      });
      await recreatedEnv(1);
      containerEnv = ['TRAEFIK_A=1', `CF_DNS_API_TOKEN=${TOKEN}`];

      const res = await request(httpServer)
        .get('/settings/traefik/env')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.text).toBe('TRAEFIK_A=1');
    });

    it('keeps the credentials on Traefik through an env-editor save that cannot carry them', async () => {
      const cookie = await signUp();
      await put(cookie, {
        provider: 'cloudflare',
        credentials: { CF_DNS_API_TOKEN: TOKEN },
      });
      await recreatedEnv(1);

      // What the editor saves is what the GET gave it, edited — and a same-named
      // key typed into it does not displace the stored credential.
      const res = await request(httpServer)
        .post('/settings/traefik/env')
        .set('Cookie', cookie)
        .send({ env: 'TRAEFIK_A=2\nCF_DNS_API_TOKEN=typed' });

      expect(res.status).toBe(200);
      expect(await recreatedEnv(2)).toEqual([
        'TRAEFIK_A=2',
        `CF_DNS_API_TOKEN=${TOKEN}`,
      ]);
    });

    it('keeps the credentials on Traefik through a port write', async () => {
      const cookie = await signUp();
      await put(cookie, {
        provider: 'cloudflare',
        credentials: { CF_DNS_API_TOKEN: TOKEN },
      });
      await recreatedEnv(1);
      containerEnv = ['TRAEFIK_A=1', `CF_DNS_API_TOKEN=${TOKEN}`];

      const res = await request(httpServer)
        .post('/settings/traefik/ports')
        .set('Cookie', cookie)
        .send({ additionalPorts: [] });

      expect(res.status).toBe(200);
      expect(await recreatedEnv(2)).toEqual([
        'TRAEFIK_A=1',
        `CF_DNS_API_TOKEN=${TOKEN}`,
      ]);
    });
  });
});
