import * as fs from 'node:fs';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

import { desc, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import WebSocket from 'ws';

import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import { ComposeService } from '../../src/compose/compose.service';
import {
  cloudAccount,
  compose,
  deployment,
  environment,
  server as serverTable,
  sshKey,
  stackVmKey,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { MountsService } from '../../src/mounts/mounts.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { SHELL_OPEN_FRAME } from '../../src/realtime/terminal-protocol';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { STACK_VM_TUNNEL } from '../../src/remote/stack-vm-remote';
import type {
  StackVmEndpoint,
  StackVmTunnel,
} from '../../src/remote/stack-vm-remote';
import { stackVmPublicKey } from '../../src/stack-vm/stack-vm-key';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import type { StackVmSettings } from '../../src/cloud-accounts/definitions/stack-vm';
import { cookieHeader, waitFor } from '../realtime/realtime.fixture';
import { makeGoogleCloudAccount } from '../utils/google-cloud-account';
import { startSshForwardServer } from '../utils/ssh-forward-server';
import type { SshForwardServer } from '../utils/ssh-forward-server';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const INSTANCE = 'i-0stackvm1234567';
/** An `.env` value: it may reach the Stack VM only inside the tunnel. */
const SECRET = 'stack-vm-secret-7f3a9c';
/** A config file's credential, the same. */
const CONFIG_SECRET = 'config-file-secret-41bd';
const CONTAINER = 'a1b2c3d4e5f6';

/** Where a stack's Apply made its Stack VM, as its row records it. */
interface StackVmPlace {
  readonly region: string;
  readonly machineType: string;
  readonly made: NonNullable<StackVmSettings['made']>;
}

const PINS = { dockerEngine: '5:28.0.0', composePlugin: '2.33.0' };

const AWS_PLACE: StackVmPlace = {
  region: REGION,
  machineType: 't3.small',
  made: {
    imageId: 'ami-0ubuntu2404',
    pins: PINS,
    instanceId: INSTANCE,
    privateIp: '10.0.1.5',
    dataVolumeId: 'vol-0data',
  },
};

const GOOGLE_REGION = 'europe-west1';
const GOOGLE_ZONE = 'europe-west1-b';
const GOOGLE_STACK_VM = 'cg-analytics-vm';

const GOOGLE_PLACE: StackVmPlace = {
  region: GOOGLE_REGION,
  machineType: 'e2-small',
  made: {
    imageId:
      'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20261101',
    pins: PINS,
    instanceId: GOOGLE_STACK_VM,
    privateIp: '10.10.0.5',
    dataVolumeId: 'cg-analytics-data',
    zone: GOOGLE_ZONE,
  },
};

const composeFile = (image: string) =>
  `services:\n  web:\n    build: .\n    image: ${image}\n`;

/**
 * **A Compose stack on its own Stack VM** (ADR-0070, #1361): its
 * Deployment, its logs and its container terminal go through the Stack VM
 * run target, which reaches the Stack VM over SSH inside the cloud's tunnel.
 *
 * The tunnel is the one double (`STACK_VM_TUNNEL`): it hands the SSH layer
 * a socket to a local stand-in SSH server (`ssh-forward-server.ts`), so the
 * real `RemoteExecService`, SSH channels, connection provider and the
 * stack's own key all run as they do against a real Stack VM. A second
 * stand-in is a Server, reached as every Server is, by address.
 */
describe('A Compose stack on its Stack VM (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let port: number;
  let composeService: ComposeService;
  let engine: DeploymentEngineService;
  let mounts: MountsService;

  let stackVm: SshForwardServer;
  let serverHost: SshForwardServer;
  const opened: StackVmEndpoint[] = [];
  const tunnel: StackVmTunnel = {
    open: (endpoint) => {
      opened.push(endpoint);
      return new Promise<Duplex>((resolve, reject) => {
        const socket = connect(
          stackVm.connection.port,
          stackVm.connection.host,
        );
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      });
    },
  };

  /** Every program run on the platform host, which a Stack VM's must never be. */
  const local: string[] = [];

  beforeAll(async () => {
    stackVm = await startSshForwardServer({ username: 'root' });
    serverHost = await startSshForwardServer();
    ctx = await createTestApp({
      overrideProviders: [{ provide: STACK_VM_TUNNEL, useValue: tunnel }],
    });
    http = ctx.app.getHttpServer() as App;
    composeService = ctx.app.get(ComposeService);
    engine = ctx.app.get(DeploymentEngineService);
    mounts = ctx.app.get(MountsService);
    const remoteExec = ctx.app.get(RemoteExecService);
    const execAsync = remoteExec.execAsync.bind(
      remoteExec,
    ) as RemoteExecService['execAsync'];
    jest
      .spyOn(remoteExec, 'execAsync')
      .mockImplementation((command: string, options) => {
        local.push(command);
        return execAsync(command, options);
      });
    const execFileAsync = remoteExec.execFileAsync.bind(
      remoteExec,
    ) as RemoteExecService['execFileAsync'];
    jest
      .spyOn(remoteExec, 'execFileAsync')
      .mockImplementation((command: string, args: string[], options) => {
        local.push([command, ...args].join(' '));
        return execFileAsync(command, args, options);
      });

    await ctx.app.listen(0);
    port = (http as unknown as { address(): { port: number } }).address().port;
  });

  afterAll(async () => {
    await ctx.teardown();
    await stackVm.close();
    await serverHost.close();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    opened.length = 0;
    local.length = 0;
    for (const host of [stackVm, serverHost]) {
      host.execs.length = 0;
      host.scripts.length = 0;
      host.execAnswer = () => ({ code: 0 });
    }
  });

  async function setUp() {
    const res = await request(http).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(res.status).toBe(200);
    const cookie = cookieHeader(res.headers['set-cookie']);
    const userId = (res.body as { user: { id: string } }).user.id;
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    };

    const [account] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId,
        name: 'Production AWS',
        cloud: 'aws',
        cloudId: ACCOUNT,
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy`,
        taskExecutionRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-task-execution`,
        externalId: 'external-id-made-by-cloudgate',
        policyVersion: 1,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    const project = await ctx.app
      .get(ProjectsService)
      .create(ownerCtx, { name: 'Shop' });
    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId: project.projectId,
        name: 'production',
        deployTarget: {
          kind: 'cloud',
          cloudAccountId: account.cloudAccountId,
          region: REGION,
        },
      });
    expect(env.status).toBe(201);
    const environmentId = (env.body as { environmentId: string }).environmentId;
    return {
      cookie,
      ownerCtx,
      organizationId,
      account,
      projectId: project.projectId,
      environmentId,
    };
  }

  /**
   * A stack an Apply made in the AWS Environment, with its Stack VM made:
   * its row, its own SSH key (which the stand-in authorizes, as the Stack
   * VM's first boot does), and the instance its Apply recorded.
   */
  async function stackOnItsStackVm(
    setup: Awaited<ReturnType<typeof setUp>>,
    source: { sourceType: 'raw' } | { sourceType: 'git'; url: string },
    place: StackVmPlace = AWS_PLACE,
  ) {
    const created = await composeService.create(
      setup.ownerCtx,
      {
        name: 'analytics',
        environmentId: setup.environmentId,
        serverId: null,
      },
      {
        configName: 'analytics',
        cloud: {
          composeId: 'StackVmCompose1',
          cloudAccountId: setup.account.cloudAccountId,
          region: place.region,
          stackVm: {
            machineType: place.machineType,
            sizeName: 'medium',
            dataDiskGb: 20,
            snapshotDays: 7,
            made: null,
          },
        },
      },
    );
    await composeService.update(setup.ownerCtx, created.composeId, {
      ...(source.sourceType === 'raw'
        ? { sourceType: 'raw', composeFile: composeFile('shop/web:1') }
        : {
            sourceType: 'git',
            customGitUrl: source.url,
            customGitBranch: 'main',
            composePath: 'docker-compose.yml',
          }),
      env: `DB_PASSWORD=${SECRET}`,
    });
    const [row] = await ctx.db
      .select()
      .from(compose)
      .where(eq(compose.composeId, created.composeId));
    await ctx.db
      .update(compose)
      .set({
        stackVm: {
          ...row.stackVm!,
          made: place.made,
        },
      })
      .where(eq(compose.composeId, created.composeId));
    const [key] = await ctx.db
      .select()
      .from(stackVmKey)
      .where(eq(stackVmKey.composeId, created.composeId));
    stackVm.authorize(stackVmPublicKey(key.privateKey));
    return row;
  }

  const deploy = async (composeId: string) =>
    engine.deployCompose(await composeService.findDeployable(composeId));

  const lastDeployment = async (composeId: string) =>
    (
      await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.composeId, composeId))
        .orderBy(desc(deployment.createdAt))
        .limit(1)
    )[0];

  /** What reached the Stack VM: each request and each script read off stdin. */
  const onStackVm = () => [
    ...stackVm.execs,
    ...stackVm.scripts.map(({ stdin }) => stdin),
  ];

  /** The compose files a program wrote, decoded from its base64 writes. */
  const writtenFiles = (program: string) =>
    [...program.matchAll(/echo "([A-Za-z0-9+/=]+)" \| base64 -d >/g)].map(
      ([, encoded]) => Buffer.from(encoded, 'base64').toString(),
    );

  function dial(pathWithQuery: string, cookie: string) {
    const client = new WebSocket(`ws://127.0.0.1:${port}${pathWithQuery}`, {
      headers: { cookie },
    });
    const frames: string[] = [];
    let closed: { code: number } | null = null;
    client.on('message', (data) => frames.push((data as Buffer).toString()));
    client.on('close', (code) => {
      closed = { code };
    });
    return {
      frames,
      closure: async () => {
        await waitFor(() => closed !== null);
        return closed as unknown as { code: number };
      },
      close: () => client.close(),
    };
  }

  /** The stand-in's Docker: the container is the stack's, by its labels. */
  const asStackContainer =
    (appName: string, output: string) => (command: string) =>
      command.startsWith('docker inspect')
        ? { stdout: `/${appName}-web-1|${appName}`, code: 0 }
        : { stdout: output, code: 0 };

  describe('its Deployment', () => {
    it('runs on its Stack VM, over SSH inside the tunnel to the instance its Apply made', async () => {
      const setup = await setUp();
      const stack = await stackOnItsStackVm(setup, { sourceType: 'raw' });

      await deploy(stack.composeId);

      expect(opened.length).toBeGreaterThan(0);
      for (const endpoint of opened) {
        expect(endpoint).toMatchObject({
          cloud: 'aws',
          region: REGION,
          instanceId: INSTANCE,
        });
        expect(endpoint.account.cloudAccountId).toBe(
          setup.account.cloudAccountId,
        );
      }
      // Rooted as a Server's tree is, on the Stack VM.
      expect(
        onStackVm().some((program) =>
          program.includes(
            `${REMOTE_CLOUDGATE_DIRECTORY}/compose/${stack.appName}/code`,
          ),
        ),
      ).toBe(true);
      // Nothing of the stack runs on the platform host, nor on a Server.
      expect(
        local.filter((command) => command.includes(stack.appName)),
      ).toEqual(local.filter((command) => command.includes('/logs/')));
      expect(serverHost.execs).toEqual([]);
      expect((await lastDeployment(stack.composeId)).status).toBe('done');
    });

    it('writes its .env values only over the tunnel, never on a command line', async () => {
      const setup = await setUp();
      const stack = await stackOnItsStackVm(setup, { sourceType: 'raw' });

      await deploy(stack.composeId);

      expect(stackVm.scripts.some(({ stdin }) => stdin.includes(SECRET))).toBe(
        true,
      );
      expect(stackVm.execs.some((command) => command.includes(SECRET))).toBe(
        false,
      );
      expect(local.some((command) => command.includes(SECRET))).toBe(false);
    });

    it("builds a compose build: on the Stack VM inside docker compose up --build, never in the cloud's build service", async () => {
      const setup = await setUp();
      const stack = await stackOnItsStackVm(setup, { sourceType: 'raw' });

      await deploy(stack.composeId);

      expect(
        onStackVm().some((program) =>
          program.includes(
            `compose -p ${stack.appName} -f docker-compose.yml up -d --build`,
          ),
        ),
      ).toBe(true);
      expect(
        ctx.cloud.calls.filter(({ method }) => method === 'codeBuildStart'),
      ).toEqual([]);
    });

    it('says in its log that it runs on the stack’s Stack VM in its account and region, the log kept on the platform host', async () => {
      const setup = await setUp();
      const stack = await stackOnItsStackVm(setup, { sourceType: 'raw' });
      stackVm.execAnswer = (command) =>
        command.endsWith(' -s')
          ? { stdout: 'Container analytics-web-1 Started\n', code: 0 }
          : { code: 0 };

      await deploy(stack.composeId);

      expect(
        stackVm.execs.some((command) =>
          command.includes(
            "on the stack's Stack VM in Cloud account 'Production AWS', region eu-central-1",
          ),
        ),
      ).toBe(true);
      const log = fs.readFileSync(
        (await lastDeployment(stack.composeId)).logPath,
        'utf8',
      );
      expect(log).toContain('Container analytics-web-1 Started');
    });

    it('picks up a change to its repository compose file at the next Deployment, read off the Stack VM', async () => {
      const setup = await setUp();
      const stack = await stackOnItsStackVm(setup, {
        sourceType: 'git',
        url: 'https://git.example.com/shop/analytics.git',
      });
      let image = 'shop/web:1';
      stackVm.execAnswer = (command) =>
        command.startsWith('cat ')
          ? { stdout: composeFile(image), code: 0 }
          : { code: 0 };

      await deploy(stack.composeId);
      image = 'shop/web:2';
      stackVm.scripts.length = 0;
      await deploy(stack.composeId);

      const written = stackVm.scripts.flatMap(({ stdin }) =>
        writtenFiles(stdin),
      );
      expect(written.some((file) => file.includes('shop/web:2'))).toBe(true);
      expect(written.some((file) => file.includes('shop/web:1'))).toBe(false);
    });
  });

  it('writes a config file only over the tunnel', async () => {
    const setup = await setUp();
    const stack = await stackOnItsStackVm(setup, { sourceType: 'raw' });

    await mounts.create(setup.ownerCtx, {
      serviceType: 'compose',
      serviceId: stack.composeId,
      type: 'file',
      filePath: 'app.conf',
      content: `password=${CONFIG_SECRET}\n`,
    });

    expect(opened.length).toBeGreaterThan(0);
    expect(
      stackVm.execs.some((command) =>
        command.includes(
          `${REMOTE_CLOUDGATE_DIRECTORY}/compose/${stack.appName}/files`,
        ),
      ),
    ).toBe(true);
    expect(local.some((command) => command.includes(CONFIG_SECRET))).toBe(
      false,
    );
  });

  describe('its sockets', () => {
    it("follows a container's logs through the tunnel, the stack named rather than a Server", async () => {
      const setup = await setUp();
      const stack = await stackOnItsStackVm(setup, { sourceType: 'raw' });
      stackVm.execAnswer = asStackContainer(
        stack.appName,
        'hello from the Stack VM\r\n',
      );

      const socket = dial(
        `/docker-container-logs?containerId=${CONTAINER}&composeId=${stack.composeId}`,
        setup.cookie,
      );
      await waitFor(() =>
        socket.frames.some((frame) =>
          frame.includes('hello from the Stack VM'),
        ),
      );
      socket.close();

      expect(opened.length).toBeGreaterThan(0);
      expect(stackVm.execs.some((command) => command.includes(CONTAINER))).toBe(
        true,
      );
      expect(local.some((command) => command.includes(CONTAINER))).toBe(false);
    });

    it('opens a container terminal through the tunnel', async () => {
      const setup = await setUp();
      const stack = await stackOnItsStackVm(setup, { sourceType: 'raw' });
      stackVm.execAnswer = asStackContainer(stack.appName, '# ');

      const socket = dial(
        `/docker-container-terminal?containerId=${CONTAINER}&composeId=${stack.composeId}`,
        setup.cookie,
      );
      await waitFor(() =>
        socket.frames.some((frame) => frame !== SHELL_OPEN_FRAME),
      );
      socket.close();

      expect(
        stackVm.execs.some(
          (command) =>
            command.startsWith('docker exec -it') &&
            command.includes(CONTAINER),
        ),
      ).toBe(true);
      expect(local.some((command) => command.includes(CONTAINER))).toBe(false);
    });

    it("refuses a container that is not the stack's, though it runs on the Stack VM", async () => {
      const setup = await setUp();
      const stack = await stackOnItsStackVm(setup, { sourceType: 'raw' });
      stackVm.execAnswer = asStackContainer('someone-else', 'secret\r\n');

      const socket = dial(
        `/docker-container-logs?containerId=${CONTAINER}&composeId=${stack.composeId}`,
        setup.cookie,
      );
      const { code } = await socket.closure();

      expect(code).not.toBe(1000);
      expect(socket.frames.some((frame) => frame.includes('secret'))).toBe(
        false,
      );
    });
  });

  /**
   * #1370: Stop takes the containers down through the tunnel and then stops
   * the Stack VM through the cloud's API, so a stopped stack pays only for
   * its disk; Start brings the Stack VM back, waits for the tunnel, then the
   * containers; Restart touches only the containers. The cloud's calls are
   * the fake port's.
   */
  describe('its Stop, Start and Restart', () => {
    const composeRan = (appName: string, verb: string) =>
      stackVm.execs.some((command) =>
        command.includes(`docker compose -p ${appName} ${verb}`),
      );
    const ec2Calls = () =>
      ctx.cloud.calls.filter(({ method }) =>
        ['ec2StopInstance', 'ec2StartInstance'].includes(method),
      );
    const statusOf = async (composeId: string) =>
      (
        await ctx.db
          .select({ status: compose.composeStatus })
          .from(compose)
          .where(eq(compose.composeId, composeId))
      )[0].status;

    it('stops the containers through the tunnel, then the Stack VM through the cloud', async () => {
      const setup = await setUp();
      const stack = await stackOnItsStackVm(setup, { sourceType: 'raw' });
      let stoppedBeforeTheVm = false;
      stackVm.execAnswer = (command) => {
        if (command.includes(`docker compose -p ${stack.appName} stop`)) {
          stoppedBeforeTheVm = ec2Calls().length === 0;
        }
        return { code: 0 };
      };

      const res = await request(http)
        .post(`/compose/${stack.composeId}/stop`)
        .set('Cookie', setup.cookie);

      expect(res.status).toBe(200);
      expect(composeRan(stack.appName, 'stop')).toBe(true);
      expect(stoppedBeforeTheVm).toBe(true);
      expect(ec2Calls()).toEqual([
        { method: 'ec2StopInstance', region: REGION, instanceId: INSTANCE },
      ]);
      expect(await statusOf(stack.composeId)).toBe('stopped');
      expect(local.some((command) => command.includes(stack.appName))).toBe(
        false,
      );
    });

    it('starts the Stack VM, waits for the tunnel, then starts its stopped containers through it with docker compose start', async () => {
      const setup = await setUp();
      const stack = await stackOnItsStackVm(setup, { sourceType: 'raw' });
      ctx.cloud.setEc2InstanceState(INSTANCE, 'stopped');
      let vmStartedFirst = false;
      stackVm.execAnswer = (command) => {
        if (command.includes(`docker compose -p ${stack.appName}`)) {
          vmStartedFirst = ec2Calls().some(
            ({ method }) => method === 'ec2StartInstance',
          );
        }
        return { code: 0 };
      };

      const res = await request(http)
        .post(`/compose/${stack.composeId}/start`)
        .set('Cookie', setup.cookie);

      expect(res.status).toBe(200);
      expect(ec2Calls()).toEqual([
        { method: 'ec2StartInstance', region: REGION, instanceId: INSTANCE },
      ]);
      expect(vmStartedFirst).toBe(true);
      expect(composeRan(stack.appName, 'start')).toBe(true);
      // The containers its Stop stopped, as they were: nothing is made again.
      expect(stackVm.execs.some((command) => command.includes('up -d'))).toBe(
        false,
      );
      expect(await statusOf(stack.composeId)).toBe('done');
    });

    it('restarts only the containers, never the Stack VM', async () => {
      const setup = await setUp();
      const stack = await stackOnItsStackVm(setup, { sourceType: 'raw' });

      const res = await request(http)
        .post(`/compose/${stack.composeId}/restart`)
        .set('Cookie', setup.cookie);

      expect(res.status).toBe(200);
      expect(composeRan(stack.appName, 'restart')).toBe(true);
      expect(ec2Calls()).toEqual([]);
      expect(opened.length).toBeGreaterThan(0);
    });

    it('refuses a Deployment of a stopped stack, saying to start it first', async () => {
      const setup = await setUp();
      const stack = await stackOnItsStackVm(setup, { sourceType: 'raw' });
      await composeService.stop(setup.ownerCtx, stack.composeId);

      const res = await request(http)
        .post(`/compose/${stack.composeId}/deployments`)
        .set('Cookie', setup.cookie)
        .send({});

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toMatch(
        /start it first/,
      );
      await expect(
        ctx.app
          .get(DeploymentsService)
          .deployCompose(setup.ownerCtx, stack.composeId),
      ).rejects.toThrow(/start it first/);
      expect(await lastDeployment(stack.composeId)).toBeUndefined();
    });

    it('shows whether its Stack VM runs, read from the cloud', async () => {
      const setup = await setUp();
      const stack = await stackOnItsStackVm(setup, { sourceType: 'raw' });
      const read = async () =>
        (
          await request(http)
            .get(`/compose/${stack.composeId}/stack-vm`)
            .set('Cookie', setup.cookie)
        ).body as { state: string };

      expect(await read()).toEqual({ state: 'running' });
      await composeService.stop(setup.ownerCtx, stack.composeId);
      expect(await read()).toEqual({ state: 'stopped' });
      expect(ctx.cloud.calls).toContainEqual({
        method: 'ec2InstanceState',
        region: REGION,
        instanceId: INSTANCE,
      });
    });
  });

  it('deploys a stack on a Server over plain SSH to its address, opening no tunnel', async () => {
    const setup = await setUp();
    const [key] = await ctx.db
      .insert(sshKey)
      .values({
        name: 'runner',
        organizationId: setup.organizationId,
        privateKey: serverHost.connection.privateKey,
        publicKey: stackVmPublicKey(serverHost.connection.privateKey),
      })
      .returning();
    const [runner] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'runner-eu',
        ipAddress: serverHost.connection.host,
        port: serverHost.connection.port,
        username: serverHost.connection.username,
        sshKeyId: key.sshKeyId,
        organizationId: setup.organizationId,
      })
      .returning();
    // An Environment of its own deploying to the Server: in the Cloud
    // Environment the console asks for no Server (#1372, ADR-0070).
    const onServer = await request(http)
      .post('/environments')
      .set('Cookie', setup.cookie)
      .send({
        projectId: setup.projectId,
        name: 'staging',
        deployTarget: { kind: 'server', serverId: runner.serverId },
      });
    expect(onServer.status).toBe(201);
    const created = await composeService.create(setup.ownerCtx, {
      name: 'billing',
      environmentId: (onServer.body as { environmentId: string }).environmentId,
      serverId: runner.serverId,
    });
    await composeService.update(setup.ownerCtx, created.composeId, {
      sourceType: 'raw',
      composeFile: composeFile('shop/billing:1'),
    });

    await deploy(created.composeId);

    expect(serverHost.execs.length).toBeGreaterThan(0);
    expect(opened).toEqual([]);
    expect(stackVm.execs).toEqual([]);
  });

  /**
   * #1365: a stack in a Google Cloud project reaches its Stack VM the same
   * way, the tunnel being IAP's TCP forwarding to the Compute Engine VM its
   * Apply recorded, in its zone.
   */
  describe('on Google Cloud', () => {
    async function googleStack(
      source: { sourceType: 'raw' } | { sourceType: 'git'; url: string },
    ) {
      const setup = await setUp();
      await makeGoogleCloudAccount(ctx.db, setup.account.cloudAccountId);
      const key = makeSigningKey();
      await ctx.db
        .update(cloudAccount)
        .set({
          name: 'Production Google',
          // A key that signs, for the run session Stop and Start take.
          signingKey: key.privateKey,
          signingKeyId: key.keyId,
          signingPublicKey: JSON.stringify(key.publicJwk),
        })
        .where(eq(cloudAccount.cloudAccountId, setup.account.cloudAccountId));
      // The Environment deploys to the project's region: a console-managed
      // stack's place is its Environment's (#1372), and one elsewhere is
      // a Deploy target that moved, which its plan refuses.
      await ctx.db
        .update(environment)
        .set({
          deployTarget: {
            kind: 'cloud',
            cloudAccountId: setup.account.cloudAccountId,
            region: GOOGLE_REGION,
          },
        })
        .where(eq(environment.environmentId, setup.environmentId));
      const stack = await stackOnItsStackVm(setup, source, GOOGLE_PLACE);
      return { setup, stack };
    }

    const throughIap = (cloudAccountId: string) => {
      expect(opened.length).toBeGreaterThan(0);
      for (const endpoint of opened) {
        expect(endpoint).toMatchObject({
          cloud: 'gcp',
          zone: GOOGLE_ZONE,
          instanceName: GOOGLE_STACK_VM,
        });
        expect(endpoint.account.cloudAccountId).toBe(cloudAccountId);
      }
    };

    it('deploys onto its Stack VM over SSH inside IAP, its .env only over the tunnel and its build: on the Stack VM', async () => {
      const { setup, stack } = await googleStack({ sourceType: 'raw' });

      await deploy(stack.composeId);

      throughIap(setup.account.cloudAccountId);
      expect(stackVm.scripts.some(({ stdin }) => stdin.includes(SECRET))).toBe(
        true,
      );
      expect(stackVm.execs.some((command) => command.includes(SECRET))).toBe(
        false,
      );
      expect(local.some((command) => command.includes(SECRET))).toBe(false);
      expect(
        onStackVm().some((program) =>
          program.includes(
            `compose -p ${stack.appName} -f docker-compose.yml up -d --build`,
          ),
        ),
      ).toBe(true);
      expect(ctx.google.calls.map(({ method }) => method)).not.toContain(
        'cloudBuild',
      );
      expect(serverHost.execs).toEqual([]);
      expect((await lastDeployment(stack.composeId)).status).toBe('done');
    });

    it('says in its log that it runs on the stack’s Stack VM in its project and region', async () => {
      const { stack } = await googleStack({ sourceType: 'raw' });

      await deploy(stack.composeId);

      expect(
        stackVm.execs.some((command) =>
          command.includes(
            `on the stack's Stack VM in Cloud account 'Production Google', region ${GOOGLE_REGION}`,
          ),
        ),
      ).toBe(true);
    });

    it("follows a container's logs through IAP", async () => {
      const { setup, stack } = await googleStack({ sourceType: 'raw' });
      stackVm.execAnswer = asStackContainer(
        stack.appName,
        'hello from the Google Stack VM\r\n',
      );

      const socket = dial(
        `/docker-container-logs?containerId=${CONTAINER}&composeId=${stack.composeId}`,
        setup.cookie,
      );
      await waitFor(() =>
        socket.frames.some((frame) =>
          frame.includes('hello from the Google Stack VM'),
        ),
      );
      socket.close();

      throughIap(setup.account.cloudAccountId);
      expect(local.some((command) => command.includes(CONTAINER))).toBe(false);
    });

    it('opens a container terminal through IAP', async () => {
      const { setup, stack } = await googleStack({ sourceType: 'raw' });
      stackVm.execAnswer = asStackContainer(stack.appName, '# ');

      const socket = dial(
        `/docker-container-terminal?containerId=${CONTAINER}&composeId=${stack.composeId}`,
        setup.cookie,
      );
      await waitFor(() =>
        socket.frames.some((frame) => frame !== SHELL_OPEN_FRAME),
      );
      socket.close();

      throughIap(setup.account.cloudAccountId);
      expect(
        stackVm.execs.some(
          (command) =>
            command.startsWith('docker exec -it') &&
            command.includes(CONTAINER),
        ),
      ).toBe(true);
      expect(local.some((command) => command.includes(CONTAINER))).toBe(false);
    });

    it('stops its Compute Engine VM in its zone after the containers, and starts it again before them', async () => {
      const { setup, stack } = await googleStack({ sourceType: 'raw' });
      const vmCalls = () =>
        ctx.google.calls
          .filter(({ method }) =>
            ['stopComputeInstance', 'startComputeInstance'].includes(method),
          )
          .map(({ method }) => method);

      await composeService.stop(setup.ownerCtx, stack.composeId);
      await composeService.start(setup.ownerCtx, stack.composeId);

      expect(vmCalls()).toEqual([
        'stopComputeInstance',
        'startComputeInstance',
      ]);
      expect(ctx.google.calls).toContainEqual(
        expect.objectContaining({
          method: 'stopComputeInstance',
          zone: GOOGLE_ZONE,
          name: GOOGLE_STACK_VM,
        }),
      );
      expect(
        stackVm.execs.some((command) =>
          command.includes(`docker compose -p ${stack.appName} stop`),
        ),
      ).toBe(true);
    });
  });
});
