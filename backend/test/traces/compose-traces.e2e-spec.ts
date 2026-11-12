import { and, eq } from 'drizzle-orm';
import { parse as parseShell } from 'shell-quote';
import request from 'supertest';
import { App } from 'supertest/types';
import { parse } from 'yaml';

import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import { ComposeService } from '../../src/compose/compose.service';
import {
  auditLog,
  compose,
  licenseKey,
  member,
  organizationRole,
  traceStore,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember } from '../utils/test-auth';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * Traces for a Compose (spec slice 2, ADR-0028): one Trace store
 * per Compose, every inner service wired to it through the converted file the
 * deploy writes, told apart by `service.name`; and what a turn-off, a Stop and
 * a Delete do to the store. Observed where an operator observes them: the
 * responses, the audit rows, the compose file the deploy writes to the
 * machine, and the commands the machine is asked to run.
 *
 * `RemoteExecService` is the double, as in `traces.e2e-spec.ts`; the engine,
 * the routes and the Delete run for real.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** The store's container, network and directory, spelled out (§1.7). */
const STORE = 'cloudgate-trace-store-compose-shop';
const NETWORK = 'cloudgate-traces-shop';
const storeDirectory = () =>
  `${cloudgateDirectoryOn(null)}/compose/shop/traces`;
const composeFilePath = () =>
  `${cloudgateDirectoryOn(null)}/compose/shop/code/docker-compose.yml`;

/** Two inner services, one of which names itself to its SDK. */
const SHOP_COMPOSE = `services:
  frontend:
    image: shop/frontend
    environment:
      GREETING: hello
  orders:
    image: shop/orders
    environment:
      - OTEL_SERVICE_NAME=order-service
`;

type ExecOptions = { env?: Record<string, string | undefined> };

interface Service {
  environment?: Record<string, unknown> | string[];
  networks?: unknown;
}

describe('Traces for a Compose (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let storeRunning: boolean;
  /** What `cat` of the converted file answers, for a git-sourced Compose. */
  let onDisk: string;

  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  const machine = (command: string): Promise<ExecResult> => {
    if (command.startsWith('docker container inspect')) {
      return storeRunning
        ? Promise.resolve(ok('true\n'))
        : Promise.reject(new Error(`Error: No such container: ${STORE}`));
    }
    if (command.startsWith('cat ')) return Promise.resolve(ok(onDisk));
    return Promise.resolve(isPresenceProbe(command) ? ok('absent') : ok(''));
  };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string, ExecOptions?]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  let ownerCookie: string;
  let environmentId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    storeRunning = false;
    onDisk = '';
    execMock.execAsync.mockReset().mockImplementation(machine);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId, command) => machine(command));

    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', ownerCookie)
      .send({ name: 'shop' });
    const environment = await request(httpServer)
      .post('/environments')
      .set('Cookie', ownerCookie)
      .send({
        name: 'production',
        projectId: (project.body as { projectId: string }).projectId,
      });
    expect(environment.status).toBe(201);
    environmentId = (environment.body as { environmentId: string })
      .environmentId;
  });

  /** A raw Compose on the platform host. */
  async function addCompose(
    appName = 'shop',
    composeType: 'docker-compose' | 'stack' = 'docker-compose',
  ): Promise<string> {
    const res = await request(httpServer)
      .post('/compose')
      .set('Cookie', ownerCookie)
      .send({
        name: appName,
        appName,
        environmentId,
        composeType,
        composeFile: SHOP_COMPOSE,
      });
    expect(res.status).toBe(201);
    const { composeId } = res.body as { composeId: string };
    const patched = await request(httpServer)
      .patch(`/compose/${composeId}`)
      .set('Cookie', ownerCookie)
      .send({ sourceType: 'raw' });
    expect(patched.status).toBe(200);
    return composeId;
  }

  function putTraces(
    serviceId: string,
    body: Record<string, unknown>,
    cookie = ownerCookie,
    serviceType = 'compose',
  ) {
    return request(httpServer)
      .put(`/traces/${serviceId}?serviceType=${serviceType}`)
      .set('Cookie', cookie)
      .send(body);
  }

  async function turnOn(composeId: string) {
    const res = await putTraces(composeId, { enabled: true });
    expect(res.status).toBe(200);
  }

  async function deploy(composeId: string): Promise<void> {
    const deployable = await ctx.app
      .get(ComposeService)
      .findDeployable(composeId);
    await ctx.app.get(DeploymentEngineService).deployCompose(deployable);
  }

  const commands = () => execMock.execAsync.mock.calls.map(([c]) => c);

  /** The compose file the deploy's build step wrote to the machine, last. */
  /**
   * The converted file the last deploy wrote. A traced one carries the
   * ingest credential, so it travels in the program's environment
   * (`CG_COMPOSE_FILE`), never its text; an untraced one is still the
   * base64 in the program.
   */
  function writtenComposeFile(): string {
    const path = composeFilePath();
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const writes = execMock.execAsync.mock.calls.flatMap(
      ([command, options]) => {
        if (command.includes(`printf '%s' "$CG_COMPOSE_FILE" > ${path}`)) {
          return [(options?.env ?? {}).CG_COMPOSE_FILE as string];
        }
        return [
          ...command.matchAll(
            new RegExp(
              `echo "([A-Za-z0-9+/=]+)" \\| base64 -d > '?${escaped}'?`,
              'g',
            ),
          ),
        ].map((match) => Buffer.from(match[1], 'base64').toString('utf-8'));
      },
    );
    expect(writes.length).toBeGreaterThan(0);
    return writes[writes.length - 1];
  }

  const servicesOf = (file: string) =>
    (parse(file) as { services: Record<string, Service> }).services;

  /** A service's environment as a map, whichever form it is written in. */
  function envOf(service: Service): Record<string, unknown> {
    const env = service.environment ?? {};
    if (!Array.isArray(env)) return env;
    return Object.fromEntries(
      env.map((entry) => {
        const at = entry.indexOf('=');
        return at < 0
          ? [entry, null]
          : [entry.slice(0, at), entry.slice(at + 1)];
      }),
    );
  }

  const otelNames = (service: Service) =>
    Object.keys(envOf(service))
      .filter((name) => name.startsWith('OTEL_'))
      .sort();

  const storeStarts = () =>
    commands().filter(
      (command) => command.includes('docker run') && command.includes(STORE),
    );

  async function rowOf(composeId: string) {
    const [row] = await ctx.db
      .select()
      .from(traceStore)
      .where(eq(traceStore.composeId, composeId));
    return row;
  }

  describe('the setting', () => {
    it('turns traces on for a Compose, leaves an audit row keyed on it, and never answers the credential', async () => {
      const composeId = await addCompose();

      const on = await putTraces(composeId, { enabled: true });
      expect(on.status).toBe(200);
      expect(on.body).toEqual({
        serviceType: 'compose',
        serviceId: composeId,
        enabled: true,
        retentionDays: 3,
        hasCredential: true,
      });
      const read = await request(httpServer)
        .get(`/traces/${composeId}?serviceType=compose`)
        .set('Cookie', ownerCookie);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ enabled: true, storeRunning: false });
      const retention = await putTraces(composeId, {
        enabled: true,
        retentionDays: 7,
      });

      const row = await rowOf(composeId);
      for (const res of [on, read, retention]) {
        expect(res.text).not.toContain(row.credential);
        expect(res.text).not.toContain(row.queryCredential);
      }
      expect(
        await ctx.db
          .select({ action: auditLog.action, resourceId: auditLog.resourceId })
          .from(auditLog)
          .where(eq(auditLog.resourceType, 'traces')),
      ).toEqual([
        { action: 'update', resourceId: composeId },
        { action: 'update', resourceId: composeId },
      ]);
    });

    it('refuses the write to a Member entitled to the Compose whose role lacks service update, and lets it read', async () => {
      const composeId = await addCompose();
      const reader = await signUpMember(httpServer, ownerCookie);
      const [row] = await ctx.db
        .select({ organizationId: member.organizationId })
        .from(member)
        .where(eq(member.userId, reader.id));
      await ctx.db.insert(licenseKey).values({
        organizationId: row.organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(organizationRole).values({
        organizationId: row.organizationId,
        role: 'reader',
        permission: { service: ['read'] },
      });
      await ctx.db
        .update(member)
        .set({ role: 'reader', accessedServices: [composeId] })
        .where(
          and(
            eq(member.userId, reader.id),
            eq(member.organizationId, row.organizationId),
          ),
        );

      const res = await putTraces(composeId, { enabled: true }, reader.cookie);

      expect(res.status).toBe(403);
      expect(await ctx.db.select().from(traceStore)).toEqual([]);
      const read = await request(httpServer)
        .get(`/traces/${composeId}?serviceType=compose`)
        .set('Cookie', reader.cookie);
      expect(read.status).toBe(200);
    });

    it('gives a Compose and an Application of the same app name a Trace store each, and a turn-off of one never removes the other', async () => {
      const app = await request(httpServer)
        .post('/applications')
        .set('Cookie', ownerCookie)
        .send({ name: 'shop', appName: 'shop', environmentId });
      expect(app.status).toBe(201);
      const { applicationId } = app.body as { applicationId: string };
      const composeId = await addCompose();

      expect(
        (
          await putTraces(
            applicationId,
            { enabled: true },
            ownerCookie,
            'application',
          )
        ).status,
      ).toBe(200);
      await turnOn(composeId);

      execMock.execAsync.mockClear();
      expect(
        (
          await putTraces(
            applicationId,
            { enabled: false },
            ownerCookie,
            'application',
          )
        ).status,
      ).toBe(200);
      expect(commands()).toContain(
        'docker rm --force cloudgate-trace-store-application-shop',
      );
      expect(commands().filter((command) => command.includes(STORE))).toEqual(
        [],
      );
    });
  });

  describe('deploy', () => {
    it('writes the three OTEL variables into every inner service of a traced Compose, names each by its own name unless its author did, and writes no env row', async () => {
      const composeId = await addCompose();
      const [before] = await ctx.db
        .select({ env: compose.env })
        .from(compose)
        .where(eq(compose.composeId, composeId));
      await turnOn(composeId);
      const row = await rowOf(composeId);

      await deploy(composeId);

      const services = servicesOf(writtenComposeFile());
      for (const service of Object.values(services)) {
        expect(otelNames(service)).toEqual(
          expect.arrayContaining([
            'OTEL_EXPORTER_OTLP_ENDPOINT',
            'OTEL_EXPORTER_OTLP_HEADERS',
            'OTEL_EXPORTER_OTLP_PROTOCOL',
          ]),
        );
        expect(envOf(service)).toMatchObject({
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://${STORE}:4318`,
          OTEL_EXPORTER_OTLP_HEADERS: `Authorization=${encodeURIComponent(
            `Basic ${Buffer.from(`traces:${row.credential}`).toString('base64')}`,
          )}`,
          OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        });
        expect(service.networks).toEqual(['default', NETWORK]);
      }
      expect(envOf(services.frontend)).toMatchObject({
        OTEL_SERVICE_NAME: 'frontend',
        GREETING: 'hello',
      });
      expect(envOf(services.orders).OTEL_SERVICE_NAME).toBe('order-service');
      expect(
        (parse(writtenComposeFile()) as { networks: unknown }).networks,
      ).toHaveProperty([NETWORK], { external: true });

      const [after] = await ctx.db
        .select({ env: compose.env })
        .from(compose)
        .where(eq(compose.composeId, composeId));
      expect(after.env).toBe(before.env);
    });

    it('writes nothing into an untraced Compose, or one whose traces were turned off, and starts no store', async () => {
      const composeId = await addCompose();
      await deploy(composeId);
      expect(
        Object.values(servicesOf(writtenComposeFile())).flatMap(otelNames),
      ).toEqual(['OTEL_SERVICE_NAME']); // `orders`' own, as its author wrote it

      await turnOn(composeId);
      await putTraces(composeId, { enabled: false });
      execMock.execAsync.mockClear();
      await deploy(composeId);

      expect(
        Object.values(servicesOf(writtenComposeFile())).flatMap(otelNames),
      ).toEqual(['OTEL_SERVICE_NAME']);
      expect(writtenComposeFile()).not.toContain(NETWORK);
      expect(storeStarts()).toEqual([]);
    });

    it('starts one Trace store for the Compose on its own network, before the services start', async () => {
      const composeId = await addCompose();
      await turnOn(composeId);

      await deploy(composeId);

      const starts = storeStarts();
      expect(starts).toHaveLength(1);
      const run = parseShell(
        starts[0].split('\n').find((line) => line.startsWith('docker run'))!,
      );
      const after = (flag: string) => run[run.indexOf(flag) + 1];
      expect(after('--network')).toBe(NETWORK);
      expect(run).not.toContain('cloudgate-network');
      expect(after('--volume')).toBe(`${storeDirectory()}:/trace-store`);
      // The network is made before the store joins it, and again (a no-op
      // then) before the services do, so a store that failed to start does
      // not fail the deploy.
      expect(starts[0]).toContain(
        `docker network create --driver overlay --attachable ${NETWORK}`,
      );
      const up = commands().findIndex((c) =>
        c.includes('up -d --build --remove-orphans'),
      );
      expect(up).toBeGreaterThan(commands().indexOf(starts[0]));
      expect(commands()[up]).toContain(`docker network inspect ${NETWORK}`);

      // A second deploy finds it running and leaves it alone.
      storeRunning = true;
      execMock.execAsync.mockClear();
      await deploy(composeId);
      expect(storeStarts()).toEqual([]);
    });

    it('deploys a traced Compose whose store could not be started, with the variables still written', async () => {
      const composeId = await addCompose();
      await turnOn(composeId);
      execMock.execAsync.mockImplementation((command) =>
        command.includes('docker run')
          ? Promise.reject(new Error('Cannot connect to the Docker daemon'))
          : machine(command),
      );

      await deploy(composeId);

      expect(otelNames(servicesOf(writtenComposeFile()).frontend)).toContain(
        'OTEL_EXPORTER_OTLP_HEADERS',
      );
      const [row] = await ctx.db
        .select({ status: compose.composeStatus })
        .from(compose)
        .where(eq(compose.composeId, composeId));
      expect(row.status).toBe('done');
    });
  });

  describe('the converted file', () => {
    it('never puts the ingest credential in a deploy program’s text, which ps can read', async () => {
      const composeId = await addCompose();
      await turnOn(composeId);
      const { credential } = await rowOf(composeId);
      const base64 = Buffer.from(`traces:${credential}`).toString('base64');
      await deploy(composeId);

      const texts = commands();
      for (const text of texts) {
        expect(text).not.toContain(credential);
        expect(text).not.toContain(base64);
        // Nor inside a base64 payload the program decodes.
        for (const [payload] of text.matchAll(/[A-Za-z0-9+/=]{40,}/g)) {
          expect(
            Buffer.from(payload, 'base64').toString('utf-8'),
          ).not.toContain(base64);
        }
      }
      expect(writtenComposeFile()).toContain(
        encodeURIComponent(`Basic ${base64}`),
      );
    });

    it('never answers the ingest credential, for a raw Compose or for one whose converted file on disk carries it', async () => {
      const composeId = await addCompose();
      await turnOn(composeId);
      const { credential } = await rowOf(composeId);
      const base64 = Buffer.from(`traces:${credential}`).toString('base64');
      await deploy(composeId);
      const deployed = writtenComposeFile();
      // The deploy did write it: the property below is not vacuous.
      expect(deployed).toContain(encodeURIComponent(base64));

      const raw = await request(httpServer)
        .get(`/compose/${composeId}/converted`)
        .set('Cookie', ownerCookie);
      expect(raw.status).toBe(200);

      // A git-sourced Compose's converted route reads the file its last
      // deploy left on the Server.
      await ctx.db
        .update(compose)
        .set({
          sourceType: 'git',
          customGitUrl: 'https://git.example.com/shop.git',
        })
        .where(eq(compose.composeId, composeId));
      onDisk = deployed;
      const git = await request(httpServer)
        .get(`/compose/${composeId}/converted`)
        .set('Cookie', ownerCookie);
      expect(git.status).toBe(200);
      expect(git.text).toContain('OTEL_EXPORTER_OTLP_HEADERS');

      // Traces off since: the file on disk still carries it until a deploy.
      await putTraces(composeId, { enabled: false });
      const off = await request(httpServer)
        .get(`/compose/${composeId}/converted`)
        .set('Cookie', ownerCookie);

      for (const res of [raw, git, off]) {
        expect(res.text).not.toContain(credential);
        expect(res.text).not.toContain(base64);
        expect(res.text).not.toContain(encodeURIComponent(base64));
      }
    });
  });

  describe('lifecycle', () => {
    const storeCommands = () =>
      commands().filter(
        (command) =>
          command === `docker rm --force ${STORE}` ||
          command === `rm -rf ${storeDirectory()}` ||
          command.includes(`docker network rm ${NETWORK}`),
      );

    it('removes the store container and directory when traces are turned off, and leaves the network the services are still on', async () => {
      const composeId = await addCompose();
      await turnOn(composeId);
      await deploy(composeId);
      execMock.execAsync.mockClear();

      const off = await putTraces(composeId, { enabled: false });

      expect(off.status).toBe(200);
      expect(off.body).not.toHaveProperty('unreclaimedArtifacts');
      expect(storeCommands()).toEqual([
        `docker rm --force ${STORE}`,
        `rm -rf ${storeDirectory()}`,
      ]);
    });

    it('leaves the store running when the Compose is stopped', async () => {
      const composeId = await addCompose();
      await turnOn(composeId);
      await deploy(composeId);
      storeRunning = true;
      execMock.execAsync.mockClear();

      const stopped = await request(httpServer)
        .post(`/compose/${composeId}/stop`)
        .set('Cookie', ownerCookie);

      expect(stopped.status).toBe(200);
      expect(commands().some((c) => c.includes('trace'))).toBe(false);
    });

    it('removes the store container, directory and network when the Compose is deleted', async () => {
      const composeId = await addCompose();
      await turnOn(composeId);
      await deploy(composeId);
      execMock.execAsync.mockClear();

      const removed = await request(httpServer)
        .delete(`/compose/${composeId}`)
        .set('Cookie', ownerCookie);

      expect(removed.status).toBe(200);
      expect(removed.body).not.toHaveProperty('unreclaimedArtifacts');
      expect(storeCommands()).toEqual([
        `docker rm --force ${STORE}`,
        `rm -rf ${storeDirectory()}`,
        `if docker network inspect ${NETWORK} >/dev/null 2>&1; then docker network rm ${NETWORK} >/dev/null; fi`,
      ]);
      expect(await ctx.db.select().from(traceStore)).toEqual([]);
    });

    it('names a store network a Delete could not remove', async () => {
      const composeId = await addCompose();
      await turnOn(composeId);
      execMock.execAsync.mockImplementation((command) =>
        command.includes(`docker network rm ${NETWORK}`)
          ? Promise.reject(new Error('network has active endpoints'))
          : machine(command),
      );

      const removed = await request(httpServer)
        .delete(`/compose/${composeId}`)
        .set('Cookie', ownerCookie);

      expect(removed.status).toBe(200);
      expect(
        (removed.body as { unreclaimedArtifacts: unknown[] })
          .unreclaimedArtifacts,
      ).toContainEqual({
        kind: 'network',
        appName: 'shop',
        serverId: null,
        path: NETWORK,
      });
    });

    it('asks nothing about a store when a Compose never traced is deleted', async () => {
      const composeId = await addCompose();
      execMock.execAsync.mockClear();

      const removed = await request(httpServer)
        .delete(`/compose/${composeId}`)
        .set('Cookie', ownerCookie);

      expect(removed.status).toBe(200);
      expect(storeCommands()).toEqual([]);
    });

    it('removes the store container, directory and network when the Compose’s Environment is deleted', async () => {
      const composeId = await addCompose();
      await turnOn(composeId);
      execMock.execAsync.mockClear();

      const removed = await request(httpServer)
        .delete(`/environments/${environmentId}`)
        .set('Cookie', ownerCookie);

      expect(removed.status).toBe(200);
      expect(storeCommands()).toEqual([
        `docker rm --force ${STORE}`,
        `rm -rf ${storeDirectory()}`,
        `if docker network inspect ${NETWORK} >/dev/null 2>&1; then docker network rm ${NETWORK} >/dev/null; fi`,
      ]);
    });
  });
});
