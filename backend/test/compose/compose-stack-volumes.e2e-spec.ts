import request from 'supertest';
import { App } from 'supertest/types';

import { ComposeService } from '../../src/compose/compose.service';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** An n8n-shaped stack: a database, the app, and one bind mount. */
const STACK_FILE = `services:
  db:
    image: postgres:17
    volumes:
      - db-data:/var/lib/postgresql/data
      - ./init:/docker-entrypoint-initdb.d:ro
  n8n:
    image: n8nio/n8n:1.80
    volumes:
      - type: volume
        source: files
        target: /home/node/.n8n
      - shared:/shared
volumes:
  db-data:
  files:
    name: n8n-files
  shared:
    external: true
`;

interface StackVolumes {
  services: { serviceName: string; image: string | null; volumes: string[] }[];
  unavailableReason: string | null;
}

/**
 * `GET /compose/:id/volumes`: each service of a stack with the named volumes
 * it mounts, as Docker names them, read from the record its last successful
 * deploy wrote (ADR-0069) — what the Volume backups tab picks a one-volume
 * backup from (#163).
 *
 * Only the Server is replaced: `RemoteExecService`, so the real
 * `DeploymentEngineService.deployCompose` runs and records the file.
 */
describe('A Compose stack’s volumes (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let compose: ComposeService;
  let engine: DeploymentEngineService;
  let destinations: DestinationsService;
  let cookie: string;
  let environmentId: string;

  const ok = () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
  const execMock = withArgvExec({
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  });
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
    compose = ctx.app.get(ComposeService);
    engine = ctx.app.get(DeploymentEngineService);
    destinations = ctx.app.get(DestinationsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockImplementation(ok);
    execMock.execAsyncRemote.mockReset().mockImplementation(ok);
    queueMock.add.mockReset().mockResolvedValue({ id: 'job-1' });

    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'automation' });
    expect(project.status).toBe(201);
    const env = await request(httpServer)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        name: 'production',
        projectId: (project.body as { projectId: string }).projectId,
      });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;
  });

  async function createStack(
    composeType: 'docker-compose' | 'stack',
  ): Promise<{ composeId: string; appName: string }> {
    const created = await request(httpServer)
      .post('/compose')
      .set('Cookie', cookie)
      .send({
        name: 'n8n',
        environmentId,
        composeType,
        composeFile: STACK_FILE,
      });
    expect(created.status).toBe(201);
    return created.body as { composeId: string; appName: string };
  }

  async function deploy(composeId: string): Promise<void> {
    await engine.deployCompose(await compose.findDeployable(composeId), {
      title: 'Manual deployment',
      description: '',
    });
  }

  async function volumesOf(composeId: string): Promise<StackVolumes> {
    const res = await request(httpServer)
      .get(`/compose/${composeId}/volumes`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as StackVolumes;
  }

  it('says its volumes are read from its first deploy, for a stack not deployed yet', async () => {
    const { composeId } = await createStack('docker-compose');

    const answered = await volumesOf(composeId);

    expect(answered.services).toEqual([]);
    expect(answered.unavailableReason).toBe(
      'This stack hasn’t deployed successfully yet, and its volumes are read from its first deploy',
    );
  });

  it('lists each service’s named volumes by their Docker names, name: and external ones included, and no bind mount', async () => {
    const { composeId, appName } = await createStack('docker-compose');

    await deploy(composeId);

    expect(await volumesOf(composeId)).toEqual({
      services: [
        {
          serviceName: 'db',
          image: 'postgres:17',
          volumes: [`${appName}_db-data`],
        },
        {
          serviceName: 'n8n',
          image: 'n8nio/n8n:1.80',
          volumes: ['n8n-files', 'shared'],
        },
      ],
      unavailableReason: null,
    });
  });

  it('lists a swarm stack’s volumes by the same naming', async () => {
    const { composeId, appName } = await createStack('stack');

    await deploy(composeId);

    expect((await volumesOf(composeId)).services).toEqual([
      {
        serviceName: 'db',
        image: 'postgres:17',
        volumes: [`${appName}_db-data`],
      },
      {
        serviceName: 'n8n',
        image: 'n8nio/n8n:1.80',
        volumes: ['n8n-files', 'shared'],
      },
    ]);
  });

  describe('a one-volume backup', () => {
    async function destinationId(): Promise<string> {
      const orgs = await request(httpServer)
        .get('/organizations')
        .set('Cookie', cookie);
      const organizationId = (orgs.body as { id: string }[])[0].id;
      const session = await request(httpServer)
        .get('/api/auth/get-session')
        .set('Cookie', cookie);
      const userId = (session.body as { user: { id: string } }).user.id;
      const destination = await destinations.create(
        {
          user: { id: userId },
          session: { activeOrganizationId: organizationId },
        },
        {
          name: 'prod-backups',
          provider: 'Cloudflare',
          accessKey: 'AKIAEXAMPLEACCESSKEY',
          secretAccessKey: 'wJalrXUtnFEMI-example-secret-key',
          bucket: 'cloudgate-backups',
          region: 'auto',
          endpoint: 'https://accountid.r2.cloudflarestorage.com',
        },
      );
      return destination.destinationId;
    }

    it('stores the Docker volume name and the service picked from the list, and runs from Run now', async () => {
      const { composeId, appName } = await createStack('docker-compose');
      await deploy(composeId);
      const db = (await volumesOf(composeId)).services[0];

      const created = await request(httpServer)
        .post('/volume-backups')
        .set('Cookie', cookie)
        .send({
          name: 'Nightly database',
          volumeName: db.volumes[0],
          serviceName: db.serviceName,
          prefix: 'nightly',
          schedule: '0 3 * * *',
          serviceType: 'compose',
          serviceId: composeId,
          turnOff: true,
          destinationId: await destinationId(),
        });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        composeId,
        volumeName: `${appName}_db-data`,
        serviceName: 'db',
      });

      execMock.execAsync.mockClear();
      const run = await request(httpServer)
        .post(
          `/volume-backups/${(created.body as { volumeBackupId: string }).volumeBackupId}/run`,
        )
        .set('Cookie', cookie);
      expect(run.status).toBeLessThan(300);

      const scripts = execMock.execAsync.mock.calls.map(
        ([command]) => command as string,
      );
      const backup = scripts.find((script) => script.includes('rclone'));
      expect(backup).toBeDefined();
      expect(backup).toContain(`volume-backup-lock-${appName}_db-data`);
      // `quote()`d, which escapes the colon.
      expect(backup).toContain(`-v ${appName}_db-data\\:/volume_data`);
      expect(backup).toContain(`cloudgate-backups/${appName}_db/nightly/`);
    });

    it('takes a typed volume name, and refuses one outside the volume name rules', async () => {
      const { composeId } = await createStack('docker-compose');
      const base = {
        name: 'Typed',
        prefix: 'nightly',
        schedule: '0 3 * * *',
        serviceType: 'compose',
        serviceId: composeId,
        destinationId: await destinationId(),
      };

      const typed = await request(httpServer)
        .post('/volume-backups')
        .set('Cookie', cookie)
        .send({ ...base, volumeName: 'adopted.by-hand_1' });
      const refused = await request(httpServer)
        .post('/volume-backups')
        .set('Cookie', cookie)
        .send({ ...base, volumeName: 'x$(id)' });

      expect(typed.status).toBe(201);
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain(
        'Volume name can only contain letters, numbers, dots, underscores and hyphens',
      );
    });
  });
});
