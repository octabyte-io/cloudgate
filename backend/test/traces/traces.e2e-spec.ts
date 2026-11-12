import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq, sql } from 'drizzle-orm';
import { parse } from 'shell-quote';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import {
  application,
  auditLog,
  licenseKey,
  member,
  organizationRole,
  rollback,
  traceStore,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TRACE_STORE_UNREACHABLE } from '../../src/traces/trace-store-proxy';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * Traces on the platform host (spec slice 1, ADR-0028): turning
 * them on, off and changing retention; the `OTEL_*` a deploy and a Rollback
 * inject; the Trace store a deploy starts; and what a turn-off, a Stop and a
 * Delete do to it — observed where an operator observes them: responses,
 * audit rows, the Swarm spec the deploy emits, and the commands issued to the
 * machine.
 *
 * The doubles are the spec's: `RemoteExecService` records every command and
 * answers the store's `docker container inspect` from {@link storeRunning},
 * and `RemoteDockerFactory` records the emitted Swarm spec. The deployment
 * engine, the routes and the Delete run for real.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** The store's container, spelled out rather than rebuilt (§1.7). */
const STORE = 'cloudgate-trace-store-application-web';
/** Its directory on the platform host, the tail spelled out. */
const storeDirectory = () =>
  `${cloudgateDirectoryOn(null)}/applications/web/traces`;

type ExecOptions = { env?: Record<string, string | undefined> };

interface Traces {
  serviceType: string;
  serviceId: string;
  enabled: boolean;
  retentionDays: number;
  hasCredential: boolean;
  unreclaimedArtifacts?: unknown[];
}

describe('Traces (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  /** Whether the daemon answers the store's inspect with a running container. */
  let storeRunning: boolean;
  /**
   * What `docker port <store> 16686` prints while the store runs: the stub
   * standing in for the store's UI, on loopback, unless a test says otherwise.
   */
  let publishedUi: () => string;
  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  const machine = (command: string): Promise<ExecResult> => {
    if (command.startsWith('docker container inspect')) {
      return storeRunning
        ? Promise.resolve(ok('true\n'))
        : Promise.reject(new Error(`Error: No such container: ${STORE}`));
    }
    if (command.startsWith('docker port')) {
      return storeRunning
        ? Promise.resolve(ok(publishedUi()))
        : Promise.reject(new Error(`Error: No such container: ${STORE}`));
    }
    if (command.startsWith('du -sk')) {
      // 2 MiB of Badger, while the store has ever run.
      return storeRunning
        ? Promise.resolve(ok(`2048\t${storeDirectory()}\n`))
        : Promise.reject(new Error('du: cannot access: No such file'));
    }
    return Promise.resolve(isPresenceProbe(command) ? ok('absent') : ok(''));
  };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string, ExecOptions?]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });

  /** A Swarm with no existing service and one task already running. */
  const dockerService = { inspect: jest.fn(), update: jest.fn() };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
  };
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };

  /**
   * The local stub HTTP server standing in for the Trace store's UI and query
   * API (the spec's Testing Decisions): it records what reaches it, whole,
   * and answers what {@link storeAnswers} says.
   */
  interface HeardByStore {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: Buffer;
  }
  const storeHears: HeardByStore[] = [];
  interface StoreAnswer {
    status: number;
    headers: Record<string, string>;
    body: string | Buffer;
  }
  const defaultStoreAnswer = (): StoreAnswer => ({
    status: 203,
    headers: { 'content-type': 'application/json', 'x-trace-store': 'stub' },
    body: '{"data":["checkout"],"total":1}',
  });
  let storeAnswers: (heard: HeardByStore) => StoreAnswer = defaultStoreAnswer;
  const store: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const heard = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      storeHears.push(heard);
      const answer = storeAnswers(heard);
      res.writeHead(answer.status, answer.headers);
      res.end(answer.body);
    });
  });
  let storePort: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => store.listen(0, '127.0.0.1', resolve));
    storePort = (store.address() as AddressInfo).port;
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
    await new Promise((resolve) => store.close(resolve));
  });

  let ownerCookie: string;
  let environmentId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    storeRunning = false;
    publishedUi = () => `127.0.0.1:${storePort}\n`;
    storeHears.length = 0;
    storeAnswers = defaultStoreAnswer;
    execMock.execAsync.mockReset().mockImplementation(machine);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId, command) => machine(command));
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.createService.mockReset().mockResolvedValue(undefined);
    docker.listTasks
      .mockReset()
      .mockResolvedValue([
        { Status: { State: 'running', Timestamp: '2026-09-28T00:00:00Z' } },
      ]);

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

  /** An Application on the platform host that ships a prebuilt image. */
  async function addApplication(appName = 'web'): Promise<string> {
    const res = await request(httpServer)
      .post('/applications')
      .set('Cookie', ownerCookie)
      .send({ name: appName, appName, environmentId });
    expect(res.status).toBe(201);
    const { applicationId } = res.body as { applicationId: string };
    const patched = await request(httpServer)
      .patch(`/applications/${applicationId}`)
      .set('Cookie', ownerCookie)
      .send({ sourceType: 'docker', dockerImage: 'nginx:1.27' });
    expect(patched.status).toBe(200);
    return applicationId;
  }

  function putTraces(
    serviceId: string,
    body: Record<string, unknown>,
    cookie = ownerCookie,
    serviceType = 'application',
  ) {
    return request(httpServer)
      .put(`/traces/${serviceId}?serviceType=${serviceType}`)
      .set('Cookie', cookie)
      .send(body);
  }

  async function turnOn(applicationId: string, retentionDays = 3) {
    const res = await putTraces(applicationId, {
      enabled: true,
      retentionDays,
    });
    expect(res.status).toBe(200);
    return res.body as Traces;
  }

  /** Deploys through the real engine, as the queue processor would. */
  async function deploy(applicationId: string): Promise<void> {
    const deployable = await ctx.app
      .get(ApplicationsService)
      .findDeployable(applicationId);
    await ctx.app.get(DeploymentEngineService).deploy(deployable);
  }

  /** The container environment of the Swarm spec the last converge emitted. */
  function emittedEnv(): string[] {
    const call = docker.createService.mock.lastCall as unknown[];
    const settings = call[call.length - 1] as {
      TaskTemplate: { ContainerSpec: { Env: string[] } };
    };
    return settings.TaskTemplate.ContainerSpec.Env;
  }

  const otelNames = (env: string[]) =>
    env
      .map((entry) => entry.split('=', 1)[0])
      .filter((name) => name.startsWith('OTEL_'));

  /** Every command the machine was asked, with the environment it carried. */
  const executed = (): { command: string; env: Record<string, string> }[] =>
    execMock.execAsync.mock.calls.map(([command, options]) => ({
      command,
      env: (options?.env ?? {}) as Record<string, string>,
    }));

  const storeStarts = () =>
    executed().filter(
      ({ command }) =>
        command.includes('docker run') && command.includes(STORE),
    );

  async function storedCredentials(applicationId: string) {
    const [row] = await ctx.db
      .select()
      .from(traceStore)
      .where(eq(traceStore.applicationId, applicationId));
    return row;
  }

  describe('the setting', () => {
    it('turns traces on with a generated credential that no response carries', async () => {
      const applicationId = await addApplication();

      const initial = await request(httpServer)
        .get(`/traces/${applicationId}?serviceType=application`)
        .set('Cookie', ownerCookie);
      expect(initial.status).toBe(200);
      expect(initial.body).toEqual({
        serviceType: 'application',
        serviceId: applicationId,
        enabled: false,
        retentionDays: 3,
        hasCredential: false,
        storeRunning: false,
        storeSizeBytes: null,
      });

      const on = await putTraces(applicationId, { enabled: true });
      expect(on.status).toBe(200);
      expect(on.body).toEqual({
        serviceType: 'application',
        serviceId: applicationId,
        enabled: true,
        retentionDays: 3,
        hasCredential: true,
      });

      const row = await storedCredentials(applicationId);
      expect(row.credential).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(row.queryCredential).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(row.queryCredential).not.toBe(row.credential);

      const read = await request(httpServer)
        .get(`/traces/${applicationId}?serviceType=application`)
        .set('Cookie', ownerCookie);
      const off = await putTraces(applicationId, { enabled: false });
      const again = await putTraces(applicationId, {
        enabled: true,
        retentionDays: 7,
      });
      for (const res of [on, read, off, again]) {
        expect(res.text).not.toContain(row.credential);
        expect(res.text).not.toContain(row.queryCredential);
      }
      // A turn-on after a turn-off keeps the Service's credential.
      expect((await storedCredentials(applicationId)).credential).toBe(
        row.credential,
      );
    });

    it('stores the credentials encrypted at rest', async () => {
      const applicationId = await addApplication();
      await turnOn(applicationId);
      const { rows } = await ctx.db.execute<{
        credential: string;
        query_credential: string;
      }>(sql`select credential, query_credential from trace_store`);
      expect(rows[0].credential).toMatch(/^enc:/);
      expect(rows[0].query_credential).toMatch(/^enc:/);
    });

    it('refuses a Database, and a retention other than 1, 3 or 7 days', async () => {
      const created = await request(httpServer)
        .post('/postgres')
        .set('Cookie', ownerCookie)
        .send({
          name: 'Main DB',
          appName: 'main-db',
          databaseName: 'shop',
          databaseUser: 'shop_user',
          databasePassword: 'sup3rS3cret',
          environmentId,
        });
      expect(created.status).toBe(201);
      const { postgresId } = created.body as { postgresId: string };
      const database = await putTraces(
        postgresId,
        { enabled: true },
        ownerCookie,
        'postgres',
      );
      expect(database.status).toBe(400);

      const applicationId = await addApplication();
      for (const retentionDays of [0, 2, 5, 14, 3.5]) {
        expect(
          (await putTraces(applicationId, { enabled: true, retentionDays }))
            .status,
        ).toBe(400);
      }
      expect(await ctx.db.select().from(traceStore)).toEqual([]);
    });

    it('refuses every write to a Member whose role lacks service update, and lets it read', async () => {
      const applicationId = await addApplication();
      await turnOn(applicationId);
      const ida = await signUpMember(httpServer, ownerCookie);
      const [row] = await ctx.db
        .select({ organizationId: member.organizationId })
        .from(member)
        .where(eq(member.userId, ida.id));
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
        .set({ role: 'reader', accessedServices: [applicationId] })
        .where(
          and(
            eq(member.userId, ida.id),
            eq(member.organizationId, row.organizationId),
          ),
        );
      execMock.execAsync.mockClear();

      for (const body of [
        { enabled: false },
        { enabled: true, retentionDays: 7 },
        { enabled: true, retentionDays: 1 },
      ]) {
        expect((await putTraces(applicationId, body, ida.cookie)).status).toBe(
          403,
        );
      }
      expect(await ctx.db.select().from(traceStore)).toMatchObject([
        { enabled: true, retentionDays: 3 },
      ]);
      expect(execMock.execAsync).not.toHaveBeenCalled();
      const read = await request(httpServer)
        .get(`/traces/${applicationId}?serviceType=application`)
        .set('Cookie', ida.cookie);
      expect(read.status).toBe(200);
    });

    it('leaves an audit row for turning on, changing retention and turning off, keyed on the Service', async () => {
      const applicationId = await addApplication();
      for (const body of [
        { enabled: true },
        { enabled: true, retentionDays: 7 },
        { enabled: false },
      ]) {
        expect((await putTraces(applicationId, body)).status).toBe(200);
      }

      const rows = await ctx.db
        .select({ action: auditLog.action, resourceId: auditLog.resourceId })
        .from(auditLog)
        .where(eq(auditLog.resourceType, 'traces'));
      expect(rows).toEqual([
        { action: 'update', resourceId: applicationId },
        { action: 'update', resourceId: applicationId },
        { action: 'update', resourceId: applicationId },
      ]);
    });
  });

  describe('deploy', () => {
    it('injects the three OTEL variables into a traced Application’s Swarm spec and writes no env row', async () => {
      const applicationId = await addApplication();
      const saved = await request(httpServer)
        .patch(`/applications/${applicationId}/environment`)
        .set('Cookie', ownerCookie)
        .send({ env: 'GREETING=hello' });
      expect(saved.status).toBe(200);
      const [before] = await ctx.db
        .select({ env: application.env })
        .from(application)
        .where(eq(application.applicationId, applicationId));
      await turnOn(applicationId);

      await deploy(applicationId);

      const { credential } = await storedCredentials(applicationId);
      const env = emittedEnv();
      expect(env).toContain('GREETING=hello');
      expect(env).toContain(`OTEL_EXPORTER_OTLP_ENDPOINT=http://${STORE}:4318`);
      // The header value percent-encoded, as the OpenTelemetry spec reads it.
      const basic = Buffer.from(`traces:${credential}`).toString('base64');
      expect(env).toContain(
        `OTEL_EXPORTER_OTLP_HEADERS=Authorization=${encodeURIComponent(`Basic ${basic}`)}`,
      );
      // The store's one receiver is OTLP/HTTP; an SDK defaulting to gRPC
      // would otherwise send nothing.
      expect(env).toContain('OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf');
      const [after] = await ctx.db
        .select({ env: application.env })
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(after.env).toBe(before.env);
      expect(after.env ?? '').not.toContain('OTEL_');
    });

    it('injects nothing into an untraced Application, or one whose traces were turned off', async () => {
      const applicationId = await addApplication();
      await deploy(applicationId);
      expect(otelNames(emittedEnv())).toEqual([]);
      expect(storeStarts()).toEqual([]);

      await turnOn(applicationId);
      expect((await putTraces(applicationId, { enabled: false })).status).toBe(
        200,
      );
      await deploy(applicationId);
      expect(otelNames(emittedEnv())).toEqual([]);
      expect(storeStarts()).toEqual([]);
    });

    it('starts the Trace store before the Service with its memory limit, retention and credential', async () => {
      const applicationId = await addApplication();
      await turnOn(applicationId, 7);

      await deploy(applicationId);

      const starts = storeStarts();
      expect(starts).toHaveLength(1);
      const [{ command, env }] = starts;
      // The `docker run` line as the shell will split it.
      const run = parse(
        command.split('\n').find((line) => line.startsWith('docker run'))!,
      ).map(String);
      const flag = (name: string) => run[run.indexOf(name) + 1];
      expect(flag('--name')).toBe(STORE);
      expect(flag('--memory')).toBe('512m');
      expect(flag('--memory-swap')).toBe('512m');
      expect(flag('--network')).toBe('cloudgate-network');
      // Loopback only: nothing is published on the Server's edge.
      expect(run.filter((word) => word === '--publish')).toHaveLength(1);
      expect(flag('--publish')).toBe('127.0.0.1::16686');
      expect(flag('--volume')).toBe(`${storeDirectory()}:/trace-store`);
      // No owner labels, so no Service route resolves it.
      expect(run.some((word) => word.startsWith('--label'))).toBe(false);
      expect(
        run.some((word) => word.startsWith('jaegertracing/jaeger:2.')),
      ).toBe(true);

      const { credential, queryCredential } =
        await storedCredentials(applicationId);
      // The config travels in the environment, never in the program's text.
      expect(command).not.toContain(credential);
      expect(command).not.toContain(queryCredential);
      const config = env.CG_TRACE_STORE_CONFIG;
      expect(config).toContain('spans: 168h');
      expect(config).toContain(`inline: "traces:${credential}"`);
      expect(config).toContain(`inline: "cloudgate:${queryCredential}"`);
      expect(config).toContain('limit_mib: 220');
      // The store traces nothing of its own: with no exporter configured it
      // would dial localhost:4317 for ever and log each failure.
      expect(config).toMatch(/ {4}traces:\n {6}level: none\n/);
      expect(config).toContain(
        `base_path: "/backend/traces/${applicationId}/ui"`,
      );

      // Before the Service starts: the store's start precedes the converge.
      const startOrder =
        execMock.execAsync.mock.invocationCallOrder[
          execMock.execAsync.mock.calls.findIndex(([c]) =>
            c.includes('docker run'),
          )
        ];
      expect(startOrder).toBeLessThan(
        docker.createService.mock.invocationCallOrder[0],
      );
    });

    it('leaves a running Trace store alone on the next deploy', async () => {
      const applicationId = await addApplication();
      await turnOn(applicationId);
      storeRunning = true;

      await deploy(applicationId);

      expect(storeStarts()).toEqual([]);
      expect(otelNames(emittedEnv()).sort()).toEqual([
        'OTEL_EXPORTER_OTLP_ENDPOINT',
        'OTEL_EXPORTER_OTLP_HEADERS',
        'OTEL_EXPORTER_OTLP_PROTOCOL',
      ]);
    });

    it('injects the OTEL variables into a Rollback of a traced Application, and none into an untraced one', async () => {
      const applicationId = await addApplication();
      const enabled = await request(httpServer)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie)
        .send({ rollbackActive: true });
      expect(enabled.status).toBe(200);
      await deploy(applicationId);
      const [snapshot] = await ctx.db
        .select({ rollbackId: rollback.rollbackId })
        .from(rollback);

      docker.createService.mockClear();
      const untraced = await request(httpServer)
        .post(`/rollbacks/${snapshot.rollbackId}/rollback`)
        .set('Cookie', ownerCookie);
      expect(untraced.status).toBeLessThan(300);
      expect(otelNames(emittedEnv())).toEqual([]);

      await turnOn(applicationId);
      docker.createService.mockClear();
      execMock.execAsync.mockClear();
      const traced = await request(httpServer)
        .post(`/rollbacks/${snapshot.rollbackId}/rollback`)
        .set('Cookie', ownerCookie);
      expect(traced.status).toBeLessThan(300);
      expect(otelNames(emittedEnv()).sort()).toEqual([
        'OTEL_EXPORTER_OTLP_ENDPOINT',
        'OTEL_EXPORTER_OTLP_HEADERS',
        'OTEL_EXPORTER_OTLP_PROTOCOL',
      ]);
      expect(storeStarts()).toHaveLength(1);
    });

    it('rolls back a traced Application whose traces setting cannot be read, with no OTEL variables, as a deploy does', async () => {
      const applicationId = await addApplication();
      await request(httpServer)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie)
        .send({ rollbackActive: true });
      await deploy(applicationId);
      const [snapshot] = await ctx.db
        .select({ rollbackId: rollback.rollbackId })
        .from(rollback);
      await turnOn(applicationId);
      // A credential that no longer decrypts: the setting's read throws.
      await ctx.db.execute(
        sql`update trace_store set credential = credential || 'AAAA'`,
      );

      docker.createService.mockClear();
      execMock.execAsync.mockClear();
      const res = await request(httpServer)
        .post(`/rollbacks/${snapshot.rollbackId}/rollback`)
        .set('Cookie', ownerCookie);

      expect(res.status).toBeLessThan(300);
      expect(otelNames(emittedEnv())).toEqual([]);
      expect(storeStarts()).toEqual([]);
    });
  });

  describe('lifecycle', () => {
    const reclaimCommands = () =>
      executed()
        .map(({ command }) => command)
        .filter(
          (command) =>
            command === `docker rm --force ${STORE}` ||
            command === `rm -rf ${storeDirectory()}`,
        );

    it('removes the store container and directory when traces are turned off', async () => {
      const applicationId = await addApplication();
      await turnOn(applicationId);
      await deploy(applicationId);
      execMock.execAsync.mockClear();

      const off = await putTraces(applicationId, { enabled: false });

      expect(off.status).toBe(200);
      expect(off.body).not.toHaveProperty('unreclaimedArtifacts');
      expect(reclaimCommands()).toEqual([
        `docker rm --force ${STORE}`,
        `rm -rf ${storeDirectory()}`,
      ]);
    });

    it('names what a turn-off could not remove', async () => {
      const applicationId = await addApplication();
      await turnOn(applicationId);
      execMock.execAsync.mockImplementation((command) =>
        command === `rm -rf ${storeDirectory()}`
          ? Promise.reject(new Error('Permission denied'))
          : machine(command),
      );

      const off = await putTraces(applicationId, { enabled: false });

      expect(off.status).toBe(200);
      expect((off.body as Traces).unreclaimedArtifacts).toEqual([
        {
          kind: 'trace-store',
          appName: 'web',
          serverId: null,
          path: storeDirectory(),
        },
      ]);
    });

    it('restarts a running store in place for a retention change, and keeps its directory', async () => {
      const applicationId = await addApplication();
      await turnOn(applicationId);
      storeRunning = true;
      execMock.execAsync.mockClear();

      expect(
        (await putTraces(applicationId, { enabled: true, retentionDays: 1 }))
          .status,
      ).toBe(200);

      const restarts = executed().filter(({ command }) =>
        command.includes(`docker restart ${STORE}`),
      );
      expect(restarts).toHaveLength(1);
      expect(restarts[0].env.CG_TRACE_STORE_CONFIG).toContain('spans: 24h');
      expect(reclaimCommands()).toEqual([]);
      expect(storeStarts()).toEqual([]);
    });

    it('restarts nothing for a retention change when the store is not running', async () => {
      const applicationId = await addApplication();
      await turnOn(applicationId);
      execMock.execAsync.mockClear();

      expect(
        (await putTraces(applicationId, { enabled: true, retentionDays: 7 }))
          .status,
      ).toBe(200);

      expect(
        executed().filter(({ command }) => command.includes('docker restart')),
      ).toEqual([]);
    });

    it('leaves the store running when the Service is stopped', async () => {
      const applicationId = await addApplication();
      await turnOn(applicationId);
      await deploy(applicationId);
      execMock.execAsync.mockClear();

      const stopped = await request(httpServer)
        .post(`/applications/${applicationId}/stop`)
        .set('Cookie', ownerCookie);

      expect(stopped.status).toBeLessThan(300);
      expect(
        executed().filter(({ command }) => command.includes(STORE)),
      ).toEqual([]);
    });

    it('removes the store container and directory when the Application is deleted', async () => {
      const applicationId = await addApplication();
      await turnOn(applicationId);
      await deploy(applicationId);
      execMock.execAsync.mockClear();

      const deleted = await request(httpServer)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie);

      expect(deleted.status).toBe(200);
      expect(reclaimCommands()).toEqual([
        `docker rm --force ${STORE}`,
        `rm -rf ${storeDirectory()}`,
      ]);
      expect(await ctx.db.select().from(traceStore)).toEqual([]);
    });

    it('removes a turned-off store again on Delete, and asks nothing of a Service never traced', async () => {
      const traced = await addApplication('web');
      await turnOn(traced);
      await putTraces(traced, { enabled: false });
      const untraced = await addApplication('blog');
      execMock.execAsync.mockClear();

      for (const id of [traced, untraced]) {
        const deleted = await request(httpServer)
          .delete(`/applications/${id}`)
          .set('Cookie', ownerCookie);
        expect(deleted.status).toBe(200);
      }

      expect(reclaimCommands()).toEqual([
        `docker rm --force ${STORE}`,
        `rm -rf ${storeDirectory()}`,
      ]);
      expect(
        executed().filter(({ command }) =>
          command.includes('cloudgate-trace-store-application-blog'),
        ),
      ).toEqual([]);
    });

    it('removes the store container and directory when its Environment is deleted', async () => {
      const applicationId = await addApplication();
      await turnOn(applicationId);
      await deploy(applicationId);
      execMock.execAsync.mockClear();

      const deleted = await request(httpServer)
        .delete(`/environments/${environmentId}`)
        .set('Cookie', ownerCookie);

      expect(deleted.status).toBe(200);
      expect(reclaimCommands()).toEqual([
        `docker rm --force ${STORE}`,
        `rm -rf ${storeDirectory()}`,
      ]);
    });
  });

  /**
   * A Member on a custom role with `permission`, entitled to exactly
   * `accessedServices` — the domain tenancy suite's shape.
   */
  async function memberOn(
    permission: Record<string, string[]>,
    accessedServices: string[],
  ): Promise<string> {
    const member_ = await signUpMember(httpServer, ownerCookie);
    const [row] = await ctx.db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, member_.id));
    await ctx.db.insert(licenseKey).values({
      organizationId: row.organizationId,
      key: 'test-license-key',
      status: 'active',
      enableEnterpriseFeatures: true,
    });
    await ctx.db.insert(organizationRole).values({
      organizationId: row.organizationId,
      role: 'reader',
      permission,
    });
    await ctx.db
      .update(member)
      .set({ role: 'reader', accessedServices })
      .where(
        and(
          eq(member.userId, member_.id),
          eq(member.organizationId, row.organizationId),
        ),
      );
    return member_.cookie;
  }

  /** A traced Application whose store is running, as a deploy leaves it. */
  async function tracedAndRunning(appName = 'web'): Promise<string> {
    const applicationId = await addApplication(appName);
    await turnOn(applicationId);
    storeRunning = true;
    return applicationId;
  }

  /** `GET /traces/:serviceId/frame` as `cookie`: the frame token's mint. */
  const mintFrame = (serviceId: string, cookie: string) =>
    request(httpServer).get(`/traces/${serviceId}/frame`).set('Cookie', cookie);

  /**
   * Where `cookie`'s frame sends its requests, as the backend receives them:
   * the minted UI path without the console's `/backend` rewrite. Requests to
   * it carry no cookie, as a sandboxed frame's do (ADR-0075).
   */
  async function framed(serviceId: string, cookie: string): Promise<string> {
    const res = await mintFrame(serviceId, cookie);
    expect(res.status).toBe(200);
    const { uiPath } = res.body as { uiPath: string };
    expect(uiPath).toMatch(
      new RegExp(`^/backend/traces/${serviceId}/ui/t/[A-Za-z0-9_.-]+$`),
    );
    return uiPath.slice('/backend'.length);
  }

  describe('the proxy', () => {
    it('forwards an entitled Member’s read to the store with its path, base path and query intact, and returns the store’s answer unchanged', async () => {
      const applicationId = await tracedAndRunning();
      const cookie = await memberOn({ service: ['read'] }, [applicationId]);

      const res = await request(httpServer)
        .get(`${await framed(applicationId, cookie)}/api/traces`)
        .query('service=checkout&lookback=1h&tags=%7B%22a%22%3A1%7D');

      expect(res.status).toBe(203);
      expect(res.headers['x-trace-store']).toBe('stub');
      expect(res.headers['content-type']).toBe('application/json');
      expect(res.text).toBe('{"data":["checkout"],"total":1}');
      expect(storeHears).toHaveLength(1);
      const [heard] = storeHears;
      expect(heard.method).toBe('GET');
      // The base path the store was configured with, spelled out (§1.7).
      expect(heard.url).toBe(
        `/backend/traces/${applicationId}/ui/api/traces?service=checkout&lookback=1h&tags=%7B%22a%22%3A1%7D`,
      );
      // The backend's credential, never the caller's session.
      const { queryCredential } = await storedCredentials(applicationId);
      expect(heard.headers.authorization).toBe(
        `Basic ${Buffer.from(`cloudgate:${queryCredential}`).toString('base64')}`,
      );
      expect(heard.headers.cookie).toBeUndefined();
      // And the browser never sees it.
      expect(JSON.stringify(res.headers)).not.toContain(queryCredential);
    });

    it('forwards the base path itself, where the UI’s page is', async () => {
      const applicationId = await tracedAndRunning();

      const res = await request(httpServer).get(
        `${await framed(applicationId, ownerCookie)}`,
      );

      expect(res.status).toBe(203);
      expect(storeHears.map(({ url }) => url)).toEqual([
        `/backend/traces/${applicationId}/ui`,
      ]);
    });

    it.each([
      ['application/json', '{"file":{"data":[{"spans":[]}]},"n":1.50}'],
      ['text/plain', 'resourceSpans raw bytes ✓'],
    ])('forwards a %s POST body byte for byte', async (contentType, body) => {
      const applicationId = await tracedAndRunning();

      const res = await request(httpServer)
        .post(`${await framed(applicationId, ownerCookie)}/api/transform`)
        .set('Content-Type', contentType)
        .send(body);

      expect(res.status).toBe(203);
      expect(storeHears).toHaveLength(1);
      expect(storeHears[0].method).toBe('POST');
      expect(storeHears[0].url).toBe(
        `/backend/traces/${applicationId}/ui/api/transform`,
      );
      expect(storeHears[0].body.toString('utf8')).toBe(body);
      expect(storeHears[0].headers['content-type']).toContain(contentType);
    });

    it('refuses a Member entitled only to another Service, and the store hears nothing', async () => {
      const applicationId = await tracedAndRunning();
      const other = await addApplication('api');
      const cookie = await memberOn({ service: ['read'] }, [other]);
      execMock.execAsync.mockClear();

      // No frame token for them, so nothing their browser could send.
      const res = await mintFrame(applicationId, cookie);

      expect(res.status).toBe(403);
      expect(storeHears).toEqual([]);
      // Refused before the store's address was even asked for.
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    it.each([
      [
        'service read and monitoring read',
        { service: ['read'], monitoring: ['read'] },
      ],
      ['monitoring read alone', { monitoring: ['read'] }],
    ])(
      'refuses a Member with %s but no entitlement to the Service',
      async (_label, permission) => {
        const applicationId = await tracedAndRunning();
        const cookie = await memberOn(permission, []);

        const res = await mintFrame(applicationId, cookie);

        expect(res.status).toBe(403);
        expect(storeHears).toEqual([]);
      },
    );

    it('answers another Organization’s Service as not found, and the store hears nothing', async () => {
      const applicationId = await tracedAndRunning();
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        ownerCookie,
      );

      const res = await mintFrame(applicationId, mallory.cookie);

      expect(res.status).toBe(404);
      expect(storeHears).toEqual([]);
    });

    it('refuses a write verb, and the store hears nothing', async () => {
      const applicationId = await tracedAndRunning();

      for (const verb of ['put', 'patch', 'delete'] as const) {
        const res = await request(httpServer)[verb](
          `${await framed(applicationId, ownerCookie)}/api/traces/abc`,
        );
        expect(res.status).toBe(405);
      }
      expect(storeHears).toEqual([]);
    });

    it('says why there is nothing to reach: traces off, never on, or the store not started yet', async () => {
      const never = await addApplication('never');
      expect((await mintFrame(never, ownerCookie)).status).toBe(404);

      const applicationId = await addApplication();
      await turnOn(applicationId);
      const path = await framed(applicationId, ownerCookie);
      const notStarted = await request(httpServer).get(path);
      expect(notStarted.status).toBe(409);
      expect((notStarted.body as { message: string }).message).toMatch(
        /next deploy/,
      );

      await putTraces(applicationId, { enabled: false });
      storeRunning = true;
      expect((await mintFrame(applicationId, ownerCookie)).status).toBe(404);
      // A token minted while traces were on reaches nothing once they are off.
      expect((await request(httpServer).get(path)).status).toBe(404);
      expect(storeHears).toEqual([]);
    });

    it('reaches the store only on loopback: a UI port published anywhere else is refused, not dialled', async () => {
      const applicationId = await tracedAndRunning();
      publishedUi = () => `0.0.0.0:${storePort}\n[::]:${storePort}\n`;

      const res = await request(httpServer).get(
        `${await framed(applicationId, ownerCookie)}/api/services`,
      );

      expect(res.status).toBe(502);
      // The addresses it was published on are the operator's to read in the
      // log, not every entitled Member's (CODING_STANDARDS §2.5).
      expect(res.text).not.toContain('0.0.0.0');
      expect(res.text).not.toContain(String(storePort));
      expect(res.body).toMatchObject({ message: TRACE_STORE_UNREACHABLE });
      expect(storeHears).toEqual([]);
      expect(
        execMock.execFileAsync.mock.calls.filter(([command]) =>
          String(command).startsWith('docker'),
        ),
      ).toContainEqual(['docker', ['port', STORE, '16686']]);
    });

    it('answers the store refusing the backend’s credential as a 502, with no sign-in challenge', async () => {
      const applicationId = await tracedAndRunning();
      storeAnswers = () => ({
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="jaeger"' },
        body: 'Unauthorized',
      });

      const res = await request(httpServer).get(
        `${await framed(applicationId, ownerCookie)}/api/services`,
      );

      expect(res.status).toBe(502);
      expect(res.headers['www-authenticate']).toBeUndefined();
      // The filter's shape (ADR-0005), not one the proxy wrote by hand.
      expect(res.body).toMatchObject({
        statusCode: 502,
        error: 'Bad Gateway',
        path: expect.stringMatching(
          new RegExp(`^/traces/${applicationId}/ui/t/[^/]+/api/services$`),
        ) as unknown,
      });
      expect((res.body as { timestamp?: unknown }).timestamp).toEqual(
        expect.any(String),
      );
    });
  });

  /**
   * The frame token (ADR-0075): a sandboxed frame sends no session, so its
   * requests are authorized by the token in their path alone, and refused
   * without one, with another Service's, or once whoever it was minted for
   * may no longer read the Service.
   */
  describe('the frame token', () => {
    it('is the only way in: the session alone reaches no store, at the old path or the new', async () => {
      const applicationId = await tracedAndRunning();

      const old = await request(httpServer)
        .get(`/traces/${applicationId}/ui/api/services`)
        .set('Cookie', ownerCookie);
      expect(old.status).toBe(404);

      for (const token of ['', 'x', 'not.a-token']) {
        const res = await request(httpServer)
          .get(`/traces/${applicationId}/ui/t/${token}/api/services`)
          .set('Cookie', ownerCookie);
        expect([401, 404]).toContain(res.status);
      }
      expect(storeHears).toEqual([]);
    });

    it('is refused for another Service, though both are the caller’s', async () => {
      const applicationId = await tracedAndRunning();
      const other = await addApplication('api');
      await turnOn(other);
      const otherPath = await framed(other, ownerCookie);
      const token = otherPath.split('/ui/t/')[1];

      const res = await request(httpServer).get(
        `/traces/${applicationId}/ui/t/${token}/api/services`,
      );

      expect(res.status).toBe(401);
      expect(storeHears).toEqual([]);
    });

    it('stops working once its Member’s entitlement is withdrawn, before it expires', async () => {
      const applicationId = await tracedAndRunning();
      const cookie = await memberOn({ service: ['read'] }, [applicationId]);
      const path = await framed(applicationId, cookie);
      expect(
        (await request(httpServer).get(`${path}/api/services`)).status,
      ).toBe(203);

      await ctx.db
        .update(member)
        .set({ accessedServices: [] })
        .where(eq(member.role, 'reader'));
      storeHears.length = 0;

      const res = await request(httpServer).get(`${path}/api/services`);
      expect(res.status).toBe(403);
      expect(storeHears).toEqual([]);
    });

    it('stops working once the session it was minted with signs out', async () => {
      const applicationId = await tracedAndRunning();
      const cookie = await memberOn({ service: ['read'] }, [applicationId]);
      const path = await framed(applicationId, cookie);

      const signOut = await request(httpServer)
        .post('/api/auth/sign-out')
        .set('Cookie', cookie)
        .send({});
      expect(signOut.status).toBe(200);

      const res = await request(httpServer).get(`${path}/api/services`);
      expect(res.status).toBe(401);
      expect(storeHears).toEqual([]);
    });
  });

  /**
   * The policy the store's UI is served under. The hashes are spelled
   * out, from `printf '%s' '<script text>' | openssl dgst -sha256 -binary |
   * base64` (§1.7).
   */
  describe('the content security policy', () => {
    const CONFIG_HASH = "'sha256-b7GhnDeSTKp2mWfbBifSDQAP29vql3MfdbjKoYzEk3U='";
    /** `alert(1)`'s. */
    const ALERT_HASH = "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='";
    const POLICY_TAIL =
      "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; " +
      "base-uri 'self'; form-action 'none'; object-src 'none'; " +
      // The boundary (ADR-0075): an opaque origin, on every answer.
      'sandbox allow-scripts allow-forms allow-popups';
    const page = (body = '<div id="root"></div>') =>
      '<!doctype html><html><head>' +
      '<script>window.config = 1;</script>' +
      '<script type="module" crossorigin src="./static/index.js"></script>' +
      `</head><body>${body}</body></html>`;

    it('serves the UI page under a policy whose one hash is the inline script it served, in place of the store’s own headers', async () => {
      const applicationId = await tracedAndRunning();
      storeAnswers = () => ({
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "script-src * 'unsafe-inline'",
          'content-security-policy-report-only': "default-src 'none'",
          'x-frame-options': 'DENY',
        },
        body: page(),
      });

      const res = await request(httpServer).get(
        `${await framed(applicationId, ownerCookie)}/search`,
      );

      expect(res.status).toBe(200);
      expect(res.text).toBe(page());
      expect(res.headers['content-security-policy']).toBe(
        `default-src 'none'; script-src 'self' ${CONFIG_HASH}; ${POLICY_TAIL}`,
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(
        res.headers['content-security-policy-report-only'],
      ).toBeUndefined();
      expect(res.headers['x-frame-options']).toBeUndefined();
    });

    it('hashes the page as served when the store compresses it, and sends it decoded', async () => {
      const applicationId = await tracedAndRunning();
      storeAnswers = () => ({
        status: 200,
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
        body: gzipSync(page()),
      });

      const res = await request(httpServer)
        .get(`${await framed(applicationId, ownerCookie)}/search`)
        .set('Accept-Encoding', 'gzip');

      expect(res.status).toBe(200);
      // Decoded to move it under the frame token, and sent as it was moved.
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.text).toBe(page());
      expect(res.headers['content-security-policy']).toContain(
        `script-src 'self' ${CONFIG_HASH};`,
      );
    });

    it('serves an asset under the policy with no inline script allowed', async () => {
      const applicationId = await tracedAndRunning();
      storeAnswers = () => ({
        status: 200,
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
        body: 'export const a = 1;',
      });

      const res = await request(httpServer).get(
        `${await framed(applicationId, ownerCookie)}/static/index.js`,
      );

      expect(res.status).toBe(200);
      expect(res.text).toBe('export const a = 1;');
      expect(res.headers['content-security-policy']).toBe(
        `default-src 'none'; script-src 'self'; ${POLICY_TAIL}`,
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      // Readable from the frame's opaque origin, never with credentials.
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('moves the page’s base path under the frame token, so every URL the UI builds from it carries the token', async () => {
      const applicationId = await tracedAndRunning();
      const base = `/backend/traces/${applicationId}/ui`;
      storeAnswers = () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: `<html><head><base href="${base}/" /></head><body></body></html>`,
      });
      const path = await framed(applicationId, ownerCookie);

      const res = await request(httpServer).get(`${path}/search`);

      expect(res.status).toBe(200);
      expect(res.text).toBe(
        `<html><head><base href="/backend${path}/" /></head><body></body></html>`,
      );
      // The store itself is asked at the base path it was configured with.
      expect(storeHears.map(({ url }) => url)).toEqual([`${base}/search`]);
    });

    it('allows neither a script nor an event handler injected into the page', async () => {
      const applicationId = await tracedAndRunning();
      storeAnswers = () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: page('<script>alert(1)</script><img src=x onerror="alert(1)">'),
      });

      const res = await request(httpServer).get(
        `${await framed(applicationId, ownerCookie)}/search`,
      );

      expect(res.status).toBe(200);
      const policy = String(res.headers['content-security-policy']);
      // Only the store's head script: no hash for the injected one, and
      // nothing that lets an inline script or handler run without one.
      expect(policy).toContain(`script-src 'self' ${CONFIG_HASH};`);
      expect(policy).not.toContain(ALERT_HASH);
      expect(policy).not.toMatch(/'unsafe-(eval|hashes)'/);
      expect(policy.match(/'unsafe-inline'/g)).toHaveLength(1); // style-src's
    });
  });

  describe('the read', () => {
    it('returns the store’s size on disk and that it is running, and never a credential', async () => {
      const applicationId = await tracedAndRunning();
      const cookie = await memberOn({ service: ['read'] }, [applicationId]);

      const res = await request(httpServer)
        .get(`/traces/${applicationId}?serviceType=application`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        serviceType: 'application',
        serviceId: applicationId,
        enabled: true,
        retentionDays: 3,
        hasCredential: true,
        storeRunning: true,
        storeSizeBytes: 2048 * 1024,
      });
      const { credential, queryCredential } =
        await storedCredentials(applicationId);
      expect(res.text).not.toContain(credential);
      expect(res.text).not.toContain(queryCredential);
      // Read with the local shell, argv, from the store's directory.
      expect(execMock.execFileAsync).toHaveBeenCalledWith('du', [
        '-sk',
        storeDirectory(),
      ]);
    });

    it('says a store that has not started yet is not running and has no size, rather than failing', async () => {
      const applicationId = await addApplication();
      await turnOn(applicationId);

      const res = await request(httpServer)
        .get(`/traces/${applicationId}?serviceType=application`)
        .set('Cookie', ownerCookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        enabled: true,
        storeRunning: false,
        storeSizeBytes: null,
      });
    });

    it('asks the machine nothing for a Service without traces', async () => {
      const applicationId = await addApplication();
      execMock.execAsync.mockClear();

      const res = await request(httpServer)
        .get(`/traces/${applicationId}?serviceType=application`)
        .set('Cookie', ownerCookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        enabled: false,
        hasCredential: false,
        storeRunning: false,
        storeSizeBytes: null,
      });
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });
  });

  describe('the container routes', () => {
    it.each([STORE, 'cloudgate-trace-store-compose-cloudgate-monitoring'])(
      'refuses %s to the instance owner, and runs nothing',
      async (appName) => {
        execMock.execAsync.mockClear();
        const res = await request(httpServer)
          .get('/docker/containers/search')
          .query({ appName })
          .set('Cookie', ownerCookie);
        expect(res.status).toBe(403);
        expect(execMock.execAsync).not.toHaveBeenCalled();
      },
    );

    it('answers a traced Application’s container inspect without its ingest credential', async () => {
      const applicationId = await addApplication();
      await turnOn(applicationId);
      await deploy(applicationId);
      const env = emittedEnv();
      const { credential } = await storedCredentials(applicationId);
      const basic = Buffer.from(`traces:${credential}`).toString('base64');
      expect(env.join('\n')).toContain(encodeURIComponent(basic));
      // The container a Swarm task of `web` runs as, inspected whole.
      execMock.execAsync.mockImplementation((command) =>
        Promise.resolve(
          command.startsWith('docker inspect --type container')
            ? ok('/web.1.abc|web|<no value>|<no value>\n')
            : command.startsWith('docker inspect abc123')
              ? ok(
                  JSON.stringify({
                    Id: 'abc123',
                    Name: '/web.1.abc',
                    Config: { Env: [...env, 'PORT=8080'] },
                  }),
                )
              : ok(''),
        ),
      );

      const res = await request(httpServer)
        .get('/docker/containers/abc123/config')
        .set('Cookie', ownerCookie);

      expect(res.status).toBe(200);
      expect(res.text).not.toContain(credential);
      expect(res.text).not.toContain(basic);
      expect(res.text).not.toContain(encodeURIComponent(basic));
      const answered = (res.body as { Config: { Env: string[] } }).Config.Env;
      expect(answered).toContain('OTEL_EXPORTER_OTLP_HEADERS=<redacted>');
      expect(answered).toContain('PORT=8080');
      expect(answered).toContain(
        env.find((entry) => entry.startsWith('OTEL_EXPORTER_OTLP_ENDPOINT=')),
      );
    });
  });
});
