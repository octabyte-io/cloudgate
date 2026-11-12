// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();

import request from 'supertest';
import { App } from 'supertest/types';

import { application, environment, server } from '../../src/db/schema';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import {
  PLATFORM_HOST_REFUSALS,
  PLATFORM_HOST_REFUSED_CODE,
} from '../../src/instance-mode/platform-host-refusal';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { HOSTED_STAFF, openHostedSignUp } from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

/** The 400 every platform-host refusal of a check says. */
const REFUSED = {
  statusCode: 400,
  code: PLATFORM_HOST_REFUSED_CODE,
  message: PLATFORM_HOST_REFUSALS.checks,
};

const S3 = {
  provider: 'AWS',
  accessKey: 'AKIAEXAMPLE',
  secretAccessKey: 'destination-secret',
  bucket: 'backups',
  region: 'us-east-1',
  endpoint: 'https://s3.amazonaws.com',
};

const LOGIN = {
  url: 'registry.example.com',
  username: 'deployer',
  password: 'registry-secret',
};

interface Ids {
  destinationId: string;
  registryId: string;
}

/**
 * One probe: its route, and the request it sends with `serverId` given as
 * `where` (left out when `undefined`).
 */
interface Probe {
  readonly name: string;
  readonly success: number;
  send(
    http: App,
    cookie: string,
    ids: Ids,
    where: { serverId?: string | null },
  ): request.Test;
}

const query = (where: { serverId?: string | null }) =>
  where.serverId === undefined
    ? {}
    : where.serverId === null
      ? { serverId: '' }
      : { serverId: where.serverId };

const PROBES: readonly Probe[] = [
  {
    name: 'POST /destinations/test-connection',
    success: 204,
    send: (http, cookie, _ids, where) =>
      request(http)
        .post('/destinations/test-connection')
        .set('Cookie', cookie)
        .send({ name: 'offsite', ...S3, ...where }),
  },
  {
    name: 'POST /destinations/:id/test-connection',
    success: 204,
    send: (http, cookie, ids, where) =>
      request(http)
        .post(`/destinations/${ids.destinationId}/test-connection`)
        .set('Cookie', cookie)
        .send(where),
  },
  {
    name: 'GET /destinations/:id/objects',
    success: 200,
    send: (http, cookie, ids, where) =>
      request(http)
        .get(`/destinations/${ids.destinationId}/objects`)
        .set('Cookie', cookie)
        .query(query(where)),
  },
  {
    name: 'GET /backups/files',
    success: 200,
    send: (http, cookie, ids, where) =>
      request(http)
        .get('/backups/files')
        .set('Cookie', cookie)
        .query({ destinationId: ids.destinationId, ...query(where) }),
  },
  {
    name: 'POST /registries/test-connection',
    success: 204,
    send: (http, cookie, _ids, where) =>
      request(http)
        .post('/registries/test-connection')
        .set('Cookie', cookie)
        .send({ ...LOGIN, ...where }),
  },
  {
    name: 'POST /registries/:id/test-connection',
    success: 204,
    send: (http, cookie, ids, where) =>
      request(http)
        .post(`/registries/${ids.registryId}/test-connection`)
        .set('Cookie', cookie)
        .send(where),
  },
];

/**
 * On the Hosted instance a customer's credentials are never used on the
 * platform host: testing a backup destination, listing its objects or
 * a restore's files (rclone) and testing a registry login (`docker login`)
 * run from a Server the caller names, and with none named — or the platform
 * host named, `serverId: null` — they are refused with
 * `PLATFORM_HOST_REFUSED` and the checks sentence, and nothing runs.
 *
 * The Self-hosted counterparts turn `isHosted` off on the same app: there the
 * probe runs on the platform host as before.
 */
describe('Credential probes on the platform host, Hosted instance (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let ids: Ids;

  const execMock = {
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  };
  /** rclone's listings answer JSON; the other probes ignore stdout. */
  const succeeds = (command: string) =>
    Promise.resolve<ExecResult>({
      stdout: command.startsWith('rclone lsjson') ? '[]' : '',
      stderr: '',
      exitCode: 0,
    });

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.restoreAllMocks();
    execMock.execAsync
      .mockReset()
      .mockImplementation((command: string) => succeeds(command));
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        succeeds(command),
      );

    await openHostedSignUp(ctx.db);
    const res = await request(http)
      .post('/api/auth/sign-in/email')
      .send({ email: HOSTED_STAFF.email, password: HOSTED_STAFF.password });
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;

    const destination = await request(http)
      .post('/destinations')
      .set('Cookie', cookie)
      .send({ name: 'offsite', ...S3 });
    expect(destination.status).toBe(201);
    const registry = await request(http)
      .post('/registries')
      .set('Cookie', cookie)
      .send({ name: 'private', ...LOGIN });
    expect(registry.status).toBe(201);
    ids = {
      destinationId: (destination.body as { destinationId: string })
        .destinationId,
      registryId: (registry.body as { registryId: string }).registryId,
    };
  });

  const givenSelfHostedInstance = () =>
    jest
      .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
      .mockReturnValue(false);

  async function addServer(name: string): Promise<string> {
    const [row] = await ctx.db
      .insert(server)
      .values({ name, ipAddress: '203.0.113.5', port: 22, organizationId })
      .returning();
    return row.serverId;
  }

  const ranNothing = () => {
    expect(execMock.execAsync).not.toHaveBeenCalled();
    expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
  };

  describe.each(PROBES.map((probe) => [probe.name, probe] as const))(
    '%s',
    (_name, probe) => {
      it('is refused with no Server named, and runs nothing', async () => {
        const res = await probe.send(http, cookie, ids, {});

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject(REFUSED);
        ranNothing();
      });

      it('is refused the platform host by name (`serverId: null`), and runs nothing', async () => {
        const res = await probe.send(http, cookie, ids, { serverId: null });

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject(REFUSED);
        ranNothing();
      });

      it("runs on the Server named, through that Server's exec", async () => {
        const serverId = await addServer('worker-1');

        const res = await probe.send(http, cookie, ids, { serverId });

        expect(res.status).toBe(probe.success);
        expect(execMock.execAsync).not.toHaveBeenCalled();
        expect(execMock.execAsyncRemote).toHaveBeenCalledTimes(1);
        expect(execMock.execAsyncRemote.mock.calls[0][0]).toBe(serverId);
      });

      it('runs on the platform host as before on a Self-hosted instance', async () => {
        givenSelfHostedInstance();

        const res = await probe.send(http, cookie, ids, {});

        expect(res.status).toBe(probe.success);
        expect(execMock.execAsync).toHaveBeenCalledTimes(1);
        expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
      });
    },
  );

  /**
   * An Application source's registry test runs on its build host
   * (`buildHostServerId`). A cloud web Application has none — no Server, no
   * build Server — and on the Hosted instance that login would otherwise run
   * on the shared box with the customer's password.
   */
  describe('POST /applications/:id/test-registry-login', () => {
    /** An Application row on `serverId`, or on no host when `null`. */
    async function applicationOn(serverId: string | null): Promise<string> {
      const project = await request(http)
        .post('/projects')
        .set('Cookie', cookie)
        .send({ name: 'shop' });
      expect(project.status).toBe(201);
      const [env] = await ctx.db
        .insert(environment)
        .values({
          name: 'production',
          projectId: (project.body as { projectId: string }).projectId,
          deployTarget: serverId
            ? { kind: 'server', serverId }
            : { kind: 'platform-host' },
        })
        .returning();
      const [row] = await ctx.db
        .insert(application)
        .values({
          name: 'web',
          appName: 'web-app',
          configName: 'web',
          environmentId: env.environmentId,
          serverId,
        })
        .returning();
      return row.applicationId;
    }

    const testLogin = (applicationId: string) =>
      request(http)
        .post(`/applications/${applicationId}/test-registry-login`)
        .set('Cookie', cookie)
        .send({
          registryUrl: LOGIN.url,
          username: LOGIN.username,
          password: LOGIN.password,
        });

    it('is refused for an Application with no build host, and runs nothing', async () => {
      const applicationId = await applicationOn(null);

      const res = await testLogin(applicationId);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject(REFUSED);
      ranNothing();
    });

    it("runs on the Application's own Server", async () => {
      const serverId = await addServer('worker-1');
      const applicationId = await applicationOn(serverId);

      const res = await testLogin(applicationId);

      expect(res.status).toBe(204);
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).toHaveBeenCalledTimes(1);
      expect(execMock.execAsyncRemote.mock.calls[0][0]).toBe(serverId);
    });

    it('runs on the platform host as before on a Self-hosted instance', async () => {
      givenSelfHostedInstance();
      const applicationId = await applicationOn(null);

      const res = await testLogin(applicationId);

      expect(res.status).toBe(204);
      expect(execMock.execAsync).toHaveBeenCalledTimes(1);
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    });
  });
});
