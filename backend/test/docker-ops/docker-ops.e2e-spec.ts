import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { ApplicationsService } from '../../src/applications/applications.service';
import { licenseKey, member, organizationRole } from '../../src/db/schema';
import { ClusterService } from '../../src/docker-ops/cluster.service';
import { DockerOpsService } from '../../src/docker-ops/docker-ops.service';
import {
  HOST_UNREACHABLE_CODE,
  PLATFORM_HOST_UNREACHABLE_CODE,
} from '../../src/docker-ops/host-reachability';
import { SwarmService } from '../../src/docker-ops/swarm.service';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { previewDeployment } from '../../src/preview-deployments/preview-deployment.schema';
import { ProjectsService } from '../../src/projects/projects.service';
import { CONTAINER_DENIAL_MESSAGE } from '../../src/realtime/container-access.service';
import { ServersService } from '../../src/servers/servers.service';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import { withArgvExec } from '../utils/exec-double';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';
import { createTestApp, TestAppContext } from '../utils/test-app';
import {
  secondOrganizationOwner,
  signUpMember,
  createOrganization,
} from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

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

/** `PermissionService.checkInstanceAuthority`'s refusal, written out. */
const INSTANCE_AUTHORITY_REFUSAL =
  'Only an owner or admin of the instance organization can configure the platform host';

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

type Ctx = ReturnType<typeof permissionCtx>;

const ok = (stdout: string): ExecResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
});

/**
 * One `docker ps -a` row in the widened `--format`'s shape: the six
 * container fields, then one field per owner label. `docker ps` resolves `.Label`
 * itself rather than indexing a map, so a container carrying none of the three
 * renders them **empty** — not as a Go template's `<no value>`.
 */
const psRow = (
  fields: string,
  owners: { swarm?: string; compose?: string; stack?: string } = {},
) =>
  `${fields} | Swarm: ${owners.swarm ?? ''} | Compose: ${owners.compose ?? ''} | Stack: ${owners.stack ?? ''}`;

// A `docker ps -a` output worked by hand from the listing's --format string —
// includes a platform container ("cloudgate") that the listing must hide and
// the monitoring exception that must survive the filter. All three are
// unmanaged, so the organization filter leaves them exactly as they were.
const PS_OUTPUT = [
  psRow(
    'CONTAINER ID : abc123 | Name: web-app | Image: nginx:latest | Ports: 0.0.0.0:8080->80/tcp | State: running | Status: Up 2 hours',
  ),
  psRow(
    'CONTAINER ID : def456 | Name: cloudgate | Image: cloudgate/cloudgate:latest | Ports:  | State: running | Status: Up 5 hours',
  ),
  psRow(
    'CONTAINER ID : ghi789 | Name: cloudgate-monitoring | Image: cloudgate/monitoring:latest | Ports:  | State: running | Status: Up 5 hours',
  ),
].join('\n');

// The three `.Label` placeholders are the organization filter's: they are what
// tells a managed container from an unmanaged one, and they cost no second exec.
const PS_COMMAND = `docker ps -a --format 'CONTAINER ID : {{.ID}} | Name: {{.Names}} | Image: {{.Image}} | Ports: {{.Ports}} | State: {{.State}} | Status: {{.Status}} | Swarm: {{.Label "com.docker.swarm.service.name"}} | Compose: {{.Label "com.docker.compose.project"}} | Stack: {{.Label "com.docker.stack.namespace"}}'`;

/**
 * The `docker inspect` the ownership gate runs before it touches a
 * container. Every container-addressed route issues this first now, so a test
 * that stubs one command has to answer this one too.
 */
const INSPECT_COMMAND = (containerId: string) =>
  `docker inspect --type container --format '{{.Name}}|{{index .Config.Labels "com.docker.swarm.service.name"}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.stack.namespace"}}' ${containerId}`;

/**
 * What that inspect prints for a container carrying these owner labels.
 * `<no value>` is what a Go template renders for a key that is not there — the
 * unmanaged container, which is governed by machine-level Docker access, plus
 * instance authority when the target is the platform host.
 *
 * `name` leads, with the slash Docker puts on `{{.Name}}`: now an
 * unmanaged container whose name is one of this instance's own is refused rather
 * than handed to `docker:read`, and the name is the only thing that says which.
 */
const ownerLabels = (
  owners: {
    swarm?: string;
    compose?: string;
    stack?: string;
    name?: string;
  } = {},
): ExecResult =>
  ok(
    `${owners.name ?? '/abc123'}|${owners.swarm ?? '<no value>'}|${owners.compose ?? '<no value>'}|${owners.stack ?? '<no value>'}\n`,
  );

describe('Docker ops (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let dockerOps: DockerOpsService;
  let swarm: SwarmService;
  let cluster: ClusterService;
  let servers: ServersService;
  let sshKeys: SshKeysService;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;

  // All shell work goes through RemoteExecService (phase 10); the seam mocks
  // it so no test ever runs docker or opens an SSH connection.
  //
  // `withArgvExec` adds the argv half an earlier change moved these routes onto, worded the
  // way `execRemote` words it, so both stubs and both assertions still speak in
  // the one command each route asked for rather than in two seams saying the
  // same thing (`test/utils/exec-double.ts`).
  const remoteExec = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<
      Promise<ExecResult>,
      [string, string, ((d: string) => void)?]
    >(),
  });

  // The cluster endpoints talk dockerode; the factory hands back a stub
  // client so listNodes/swarmInspect/version/info never hit a daemon.
  const dockerClient = {
    listNodes: jest.fn<Promise<unknown[]>, []>(),
    swarmInspect: jest.fn<Promise<unknown>, []>(),
    version: jest.fn<Promise<unknown>, []>(),
    info: jest.fn<Promise<unknown>, []>(),
  };
  const dockerFactory = {
    getRemoteDocker: jest.fn(() => Promise.resolve(dockerClient)),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: remoteExec },
        { provide: RemoteDockerFactory, useValue: dockerFactory },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    dockerOps = ctx.app.get(DockerOpsService);
    swarm = ctx.app.get(SwarmService);
    cluster = ctx.app.get(ClusterService);
    servers = ctx.app.get(ServersService);
    sshKeys = ctx.app.get(SshKeysService);
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    remoteExec.execAsync.mockReset();
    remoteExec.execAsyncRemote.mockReset();
    dockerClient.listNodes.mockReset();
    dockerClient.swarmInspect.mockReset();
    dockerClient.version.mockReset();
    dockerClient.info.mockReset();
    dockerFactory.getRemoteDocker.mockClear();
    await ctx.resetDb();
  });

  /**
   * Answers the ownership gate with `labels` and every other command with
   * `result`.
   *
   * Every container-addressed route inspects the container's owner labels before
   * it touches it, so a test that stubs only its own command has the gate read
   * *that* command's output as a set of labels. Both dispatch paths are stubbed
   * because the labels are read on the machine being addressed.
   */
  function stubDaemon(labels: ExecResult, result: ExecResult = ok('')) {
    const answer = (command: string) =>
      Promise.resolve(
        command.startsWith('docker inspect --type container') ? labels : result,
      );
    remoteExec.execAsync.mockImplementation(answer);
    remoteExec.execAsyncRemote.mockImplementation((_serverId, command) =>
      answer(command),
    );
  }

  /** Fake-`docker` sandboxes made by `stubRealShell`, removed after each test. */
  const shellSandboxes: string[] = [];

  afterEach(() => {
    for (const dir of shellSandboxes.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Like `stubDaemon`, except every command that is *not* the ownership gate's
   * inspect is handed to a **real `/bin/sh`** through a real
   * `RemoteExecService`, with a fake `docker` first on `PATH`.
   *
   * The only way to read a compound shell command's **exit status** is to run
   * it. A `jest.fn()` returning `ok('')` cannot tell
   * `… && docker cp … ; rm -f …` (status: `rm`'s, always 0) from
   * `… && docker cp … ; rc=$?; rm -f …; exit $rc` (status: `docker cp`'s), which
   * is the whole of the upload's failure handling — a `docker cp` to a
   * non-existent parent directory returned `200 {"success":true}` having written
   * nothing. So this stub runs the real pipeline: the real `echo | base64 -d`
   * writes the real temp file, the fake `docker cp` reads it back out (the same
   * sink read the box proof used) and exits with `dockerExitCode`, and the real
   * `rm -f` and the real exit status are whatever the command says they are.
   *
   * No daemon and no container: `docker` here is eight lines of `sh`.
   */
  function stubRealShell(labels: ExecResult, dockerExitCode: number) {
    const bin = mkdtempSync(join(tmpdir(), 'cg-docker-ops-shell-'));
    shellSandboxes.push(bin);
    const argvLog = join(bin, 'argv.log');
    const payload = join(bin, 'payload');
    const fakeDocker = join(bin, 'docker');
    writeFileSync(
      fakeDocker,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> '${argvLog}'`,
        // A real `docker cp` reads its source before it fails on a bad
        // destination, so the capture happens either way.
        `if [ "$1" = cp ] && [ -f "$2" ]; then cat "$2" > '${payload}'; fi`,
        `exit ${dockerExitCode}`,
        '',
      ].join('\n'),
    );
    chmodSync(fakeDocker, 0o755);

    const realExec = new RemoteExecService();
    remoteExec.execAsync.mockImplementation((command: string) =>
      command.startsWith('docker inspect --type container')
        ? Promise.resolve(labels)
        : realExec.execAsync(command, {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
          }),
    );

    return {
      /** Every argv the fake `docker` was called with, one per line. */
      argv: () => (existsSync(argvLog) ? readFileSync(argvLog, 'utf8') : ''),
      /** What `docker cp` was handed as the source file's bytes. */
      copied: () =>
        existsSync(payload) ? readFileSync(payload, 'utf8') : null,
      /** The temp path the upload actually built, read off the argv. */
      tempPath: () => {
        const match = /\/tmp\/cloudgate-upload-\S+/.exec(
          existsSync(argvLog) ? readFileSync(argvLog, 'utf8') : '',
        );
        expect(match).not.toBeNull();
        return match![0];
      },
    };
  }

  /** An owner ctx plus a remote server row to dispatch commands to. */
  async function setUpOwnerWithServer() {
    const { organizationId, owner: ownerSession } = await setUpOwner(server);
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);
    const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
    const created = await servers.create(ownerCtx, {
      name: 'worker-1',
      ipAddress: '203.0.113.10',
      port: 22,
      username: 'root',
      sshKeyId: key.sshKeyId,
    });
    return {
      organizationId,
      ownerSession,
      ownerCtx,
      serverId: created.serverId,
    };
  }

  /**
   * A real Member of the owner's organization, on a licensed custom role
   * carrying exactly `permission`.
   *
   * The license row and the `organization_role` row are written directly:
   * `CustomRolesService.create` is itself license-gated and audited, and this
   * fixture is about what the role grants rather than about how it was made.
   *
   * Outside the two `docker: ['write']` blocks that drive it
   * because both need the same fixture and a second copy is how two gates
   * come to be tested against two different roles.
   */
  async function setUpCustomRole(permission: Record<string, string[]>) {
    const { organizationId, ownerSession, serverId } =
      await setUpOwnerWithServer();
    const invitee = await signUpMember(server, ownerSession.cookie);

    await ctx.db.insert(licenseKey).values({
      organizationId,
      key: 'test-license-key',
      status: 'active',
      enableEnterpriseFeatures: true,
    });
    await ctx.db
      .insert(organizationRole)
      .values({ organizationId, role: 'container-operator', permission });
    await ctx.db
      .update(member)
      .set({ role: 'container-operator' })
      .where(
        and(
          eq(member.userId, invitee.id),
          eq(member.organizationId, organizationId),
        ),
      );

    return {
      organizationId,
      // The organization's own owner, forwarded so a block can build
      // a *second* organization from their session — the only way to give this
      // role a foreign managed container to be refused for.
      ownerSession,
      ownerCtx: permissionCtx(ownerSession.id, organizationId),
      inviteeId: invitee.id,
      roleCtx: permissionCtx(invitee.id, organizationId),
      cookie: invitee.cookie,
      // The Server `setUpOwnerWithServer` already made, in this role's own
      // organization. Forwarded: an *unmanaged* container on the
      // **platform host** now takes instance authority, which a custom role
      // never holds, so a block whose subject is the `docker` statement has to
      // put its unmanaged target on a machine the organization owns or it stops
      // being about the statement at all. `ownedServerId` resolves this id
      // through `checkServerAccess` inside this organization, so it is a real
      // row and not a passing id.
      serverId,
    };
  }

  describe('getContainers', () => {
    it('maps the docker ps output to DTOs and hides platform containers', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(ok(PS_OUTPUT));

      const containers = await dockerOps.getContainers(ownerCtx, {});

      expect(remoteExec.execAsync).toHaveBeenCalledWith(PS_COMMAND);
      // The platform's own containers ("cloudgate") are hidden, except the
      // monitoring one.
      expect(containers).toEqual([
        {
          containerId: 'abc123',
          name: 'web-app',
          image: 'nginx:latest',
          ports: '0.0.0.0:8080->80/tcp',
          state: 'running',
          status: 'Up 2 hours',
          serverId: undefined,
        },
        {
          containerId: 'ghi789',
          name: 'cloudgate-monitoring',
          image: 'cloudgate/monitoring:latest',
          ports: '',
          state: 'running',
          status: 'Up 5 hours',
          serverId: undefined,
        },
      ]);
    });

    /**
     * The own-container hide, with the platform row **last** — which is where it actually
     * is on every real box, and the one position 111 green tests never put it
     * in. `PS_OUTPUT` puts `cloudgate` in the middle, so the leak below went
     * unseen: `docker ps -a` is newest-first and the platform containers are
     * created at install time, so `cloudgate-traefik` is structurally the final
     * line of the listing this parser reads.
     *
     * The mechanism, which is a parse bug and not a filter bug: the format's
     * last field is `Stack: {{.Label …}}`, which renders as `"Stack: "` — with
     * the trailing space — for a container carrying no labels. `stdout.trim()`
     * strips that space off the **final line only**, so that row's last field
     * reads `"Stack:"`, the parser's prefix strip does not recognise it, and
     * `"Stack:"` survives as a **phantom owner**. `owners.length` is then 1, the
     * `owners.length === 0` conjunct in the filter is false, and the platform
     * name test is never consulted — so `cloudgate-traefik` is served to every
     * organization with its id, image and published `:80`/`:443`.
     *
     * Both stdout shapes are asserted because both are real: `docker ps` emits a
     * trailing newline, and `trim()` eats the space *and* the newline, so the
     * bug does not depend on the newline being absent.
     */
    it.each([
      ['with the trailing newline docker emits', '\n'],
      ['with no trailing newline', ''],
    ])(
      'hides the platform container when its row is the last line, %s',
      async (_name, trailer) => {
        const { ownerCtx } = await setUpOwnerWithServer();
        remoteExec.execAsync.mockResolvedValue(
          ok(
            `${[
              psRow(
                'CONTAINER ID : abc123 | Name: web-app | Image: nginx:latest | Ports: 0.0.0.0:8080->80/tcp | State: running | Status: Up 2 hours',
              ),
              psRow(
                'CONTAINER ID : 9ba49dc3087c | Name: cloudgate-traefik | Image: traefik:v3.6.7 | Ports: 0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp | State: running | Status: Up 5 hours',
              ),
            ].join('\n')}${trailer}`,
          ),
        );

        const containers = await dockerOps.getContainers(ownerCtx, {});

        // The whole row, not just the name: what leaked was the instance's own
        // reverse proxy with its container id and its published ports.
        expect(containers).toEqual([
          {
            containerId: 'abc123',
            name: 'web-app',
            image: 'nginx:latest',
            ports: '0.0.0.0:8080->80/tcp',
            state: 'running',
            status: 'Up 2 hours',
            serverId: undefined,
          },
        ]);
      },
    );

    /**
     * The same parse, read from the allowing direction: a last row whose owner
     * labels really are empty must still parse to *no* owner, so a name nothing
     * claims stays in the listing rather than being dropped as somebody's. This
     * is what stops the fix above from becoming "drop the last row".
     */
    it('still lists an unclaimed last row whose owner labels are empty', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(
        ok(
          psRow(
            'CONTAINER ID : zzz999 | Name: someones-postgres | Image: postgres:16 | Ports:  | State: running | Status: Up 1 hour',
          ),
        ),
      );

      const containers = await dockerOps.getContainers(ownerCtx, {});

      expect(containers?.map((row) => row.name)).toEqual(['someones-postgres']);
    });

    /**
     * The class rather than the instance. `stdout.trim()` is one way an owner
     * field can arrive not carrying its own prefix; the reason that turned into
     * a disclosure is what the parser then did with it — `field.replace('Stack:
     * ', '')` returns the field **unchanged** when the prefix is not there, so
     * an unrecognised field became an owner *name*, and one owner is all it took
     * to skip the platform test.
     *
     * A security filter reads this array, so the contract is fail-closed: a
     * field the parser does not recognise is **no owner**. That is what keeps
     * the next reason a field arrives malformed — a widened `--format`, a docker
     * release, a fourth label — from being another `cloudgate-traefik` in every
     * tenant's listing.
     */
    it.each([
      ['lost its separating space', 'Stack:'],
      ['is not the label at all', 'Stack'],
      ['carries a different label than its position', 'Swarm: web-app'],
    ])(
      'reads an owner field that %s as no owner, not as an owner name',
      async (_name, stackField) => {
        const { ownerCtx } = await setUpOwnerWithServer();
        remoteExec.execAsync.mockResolvedValue(
          ok(
            'CONTAINER ID : 9ba49dc3087c | Name: cloudgate-traefik | ' +
              'Image: traefik:v3.6.7 | Ports: 0.0.0.0:80->80/tcp | ' +
              `State: running | Status: Up 5 hours | Swarm:  | Compose:  | ${stackField}`,
          ),
        );

        await expect(dockerOps.getContainers(ownerCtx, {})).resolves.toEqual(
          [],
        );
      },
    );

    /**
     * The other thing `stdout.trim()` was hiding: this method has no `!stdout`
     * guard, so a host with no containers went through the parser as one empty
     * line and came back as one **invented** container —
     * `{ containerId: 'No container id', name: 'No container name', … }`, which
     * carries no owner and is not a platform name, so nothing downstream dropped
     * it. Dropping blank lines answers that too, and this pins it so a later
     * "tidy" back to `trim().split()` cannot bring either bug back.
     */
    it('returns an empty listing rather than an invented row when no containers exist', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(ok(''));

      await expect(dockerOps.getContainers(ownerCtx, {})).resolves.toEqual([]);
    });

    /**
     * The behaviour the hide *changes*, so it gets a test that states it: the name
     * test now runs behind the owner-label parse, so it drops a `cloudgate-*`
     * row only when nothing claims it. The old order dropped this row too — a
     * member's own Application, hidden from their own listing because of what
     * they called it.
     */
    it('lists an application whose name contains cloudgate when a Service owns it', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      const project = await projects.create(ownerCtx, { name: 'shop' });
      const environment = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
        deployTarget: { kind: 'platform-host' },
      });
      await applications.create(ownerCtx, {
        name: 'Cloudgate API',
        appName: 'my-cloudgate-api',
        environmentId: environment.environmentId,
      });
      remoteExec.execAsync.mockResolvedValue(
        ok(
          psRow(
            'CONTAINER ID : eee555 | Name: my-cloudgate-api.1.abc | Image: api:latest | Ports:  | State: running | Status: Up 1 hour',
            { swarm: 'my-cloudgate-api' },
          ),
        ),
      );

      const containers = await dockerOps.getContainers(ownerCtx, {});

      expect(containers?.map((row) => row.name)).toEqual([
        'my-cloudgate-api.1.abc',
      ]);
    });

    it('dispatches over SSH when a serverId is given', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      remoteExec.execAsyncRemote.mockResolvedValue(ok(PS_OUTPUT));

      const containers = await dockerOps.getContainers(ownerCtx, { serverId });

      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        serverId,
        PS_COMMAND,
      );
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
      expect(containers?.[0]).toMatchObject({ name: 'web-app', serverId });
    });

    it("rejects another organization's server as NotFound", async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );

      await expect(
        dockerOps.getContainers(secondOrgCtx, { serverId }),
      ).rejects.toThrow(NotFoundException);
      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
    });
  });

  describe('getConfig', () => {
    it('inspects the container and returns the parsed JSON', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      const config = {
        Id: 'abc123',
        Name: '/web-app',
        State: { Running: true },
      };
      stubDaemon(ownerLabels(), ok(JSON.stringify(config)));

      const result = await dockerOps.getConfig(ownerCtx, {
        containerId: 'abc123',
      });

      // `'--format={{json .}}'` rather than the `--format='{{json .}}'` this
      // read before the fix: the flag and its template are one argv word now, so
      // `quote()` words the whole of it. Same two arguments reach `docker`.
      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        "docker inspect abc123 '--format={{json .}}'",
      );
      expect(result).toEqual(config);
    });

    it('swallows failures behind the gate and returns undefined', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      // The gate clears an unmanaged container; it is the inspect *after* it
      // that fails, which is where the empty catch still applies.
      remoteExec.execAsync.mockImplementation((command) =>
        command.startsWith('docker inspect --type container')
          ? Promise.resolve(ownerLabels())
          : Promise.reject(new Error('no such container')),
      );

      await expect(
        dockerOps.getConfig(ownerCtx, { containerId: 'missing' }),
      ).resolves.toBeUndefined();
    });

    it('refuses a container it cannot inspect at all', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockRejectedValue(new Error('no such container'));

      // ADR-0008: a target that cannot be inspected is a denial rather than an
      // empty resolution — falling through to the unmanaged branch would hand
      // out a container that may well be managed on a machine this process
      // cannot see. The empty catch narrows to the inspect behind the gate.
      await expect(
        dockerOps.getConfig(ownerCtx, { containerId: 'missing' }),
      ).rejects.toThrow(ForbiddenException);
      // And it says nothing about *why*: `No such container` told a
      // caller that an id they were refused does not exist, which is half an
      // enumeration of the ids that do.
      await expect(
        dockerOps.getConfig(ownerCtx, { containerId: 'missing' }),
      ).rejects.toThrow(CONTAINER_DENIAL_MESSAGE);
    });
  });

  /**
   * A Server that was never reached at all.
   *
   * Beside the case above rather than replacing it, and that is the whole
   * subject of the review: the gate's catch answered
   * {@link CONTAINER_DENIAL_MESSAGE} for *every* inspect failure, so an
   * unreachable Server's containers were refused **403 "not found or not
   * permitted"** — an *authorization* claim about a machine nothing spoke to,
   * on the eleven surfaces `ContainerAccessService.resolveTarget` gates. An earlier fix
   * made that byte-identical denial a security property, so the split is an
   * amendment to ADR-0008 and the argument lives there: its guarantee is about
   * the outcome of a resolution that **ran**, and a transport failure happens
   * before one — nothing was looked up, so nothing is disclosed.
   *
   * **No existing assertion moves, and that is what makes the change safe.**
   * The case above and the four other `CONTAINER_DENIAL_MESSAGE` pins in this
   * file reject with a plain `Error`, which `isTransportFailure` reads as "not
   * a transport failure" on purpose. The pairing is asserted here explicitly
   * rather than left to the reader, because the pairing *is* the property.
   */
  describe('a target on a Server that was never reached', () => {
    /**
     * What `execRemote` rejects with off the `ssh2` client's `'error'` event:
     * the command never reached a shell, so there is no exit code to carry. A
     * Server pointed at a closed port produces exactly this, in milliseconds.
     */
    const unreachable = () =>
      new ExecError(
        'SSH connection error: connect ECONNREFUSED 203.0.113.10:22',
        { command: 'docker inspect', serverId: null },
      );

    /** What it rejects with when `docker` ran and answered: the status is on it. */
    const dockerAnswered = () =>
      new ExecError('Remote command failed with exit code 1', {
        command: 'docker inspect',
        serverId: null,
        exitCode: 1,
        stderr: 'Error: No such container: abc123',
      });

    /** Both dispatch paths, because the labels are read on the machine addressed. */
    function rejectInspectWith(error: unknown) {
      remoteExec.execAsync.mockRejectedValue(error);
      remoteExec.execAsyncRemote.mockRejectedValue(error);
    }

    /**
     * The refusal, unwrapped. `HttpException` rather than
     * `ServiceUnavailableException` so the 403 arm comes back through the same
     * helper — the two are compared to each other, not to two literals.
     */
    async function refusalOf(call: Promise<unknown>) {
      try {
        await call;
        return null;
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        return {
          status: error.getStatus(),
          body: error.getResponse() as { message?: string; code?: string },
        };
      }
    }

    /**
     * The three surfaces the triage names, one per kind: the read, one of the
     * five lifecycle verbs, and the upload. All three run the same gate before
     * they touch the container, and all three used to answer 403 for a machine
     * nobody reached.
     */
    const surfaces: [
      string,
      (ctx: Ctx, serverId: string) => Promise<unknown>,
    ][] = [
      [
        'getConfig',
        (ctx, serverId) =>
          dockerOps.getConfig(ctx, { containerId: 'abc123', serverId }),
      ],
      [
        'stopContainer',
        (ctx, serverId) =>
          dockerOps.stopContainer(ctx, { containerId: 'abc123', serverId }),
      ],
      [
        'uploadFileToContainer',
        (ctx, serverId) =>
          dockerOps.uploadFileToContainer(
            ctx,
            {
              containerId: 'abc123',
              destinationPath: '/etc/app/config.json',
              serverId,
            },
            Buffer.from('hello'),
            'config.json',
          ),
      ],
    ];

    it.each(surfaces)(
      '%s answers 503 HOST_UNREACHABLE rather than refusing the container',
      async (_name, call) => {
        const { ownerCtx, serverId } = await setUpOwnerWithServer();
        rejectInspectWith(unreachable());

        const refusal = await refusalOf(call(ownerCtx, serverId));

        expect(refusal?.status).toBe(503);
        expect(refusal?.body.code).toBe(HOST_UNREACHABLE_CODE);
        expect(refusal?.body.message).toBe('This Server could not be reached');
        // The wire states the fact; the SSH error stays in the journal (§2.5).
        expect(refusal?.body.message).not.toContain('ECONNREFUSED');
        // And it is about the machine, not about the container it was asked
        // for: an unreachable Server discloses nothing about either.
        expect(refusal?.body.message).not.toContain('abc123');
      },
    );

    it.each(surfaces)(
      '%s still refuses 403 with the byte-identical message when docker itself answered',
      async (_name, call) => {
        // The case that catches a fix written as "any exec rejection is a
        // transport failure": `docker inspect` reached a shell, ran, and exited
        // nonzero, so the resolution happened and its outcome is a denial.
        const { ownerCtx, serverId } = await setUpOwnerWithServer();
        rejectInspectWith(dockerAnswered());

        const refusal = await refusalOf(call(ownerCtx, serverId));

        expect(refusal?.status).toBe(403);
        expect(refusal?.body.message).toBe(CONTAINER_DENIAL_MESSAGE);
        expect(refusal?.body.code).toBeUndefined();
      },
    );

    it('answers the two the same way it always did, side by side', async () => {
      // The pairing, in one test, because it is one property: a plain `Error`
      // — the shape every existing pin in this file rejects with — is *not* a
      // transport failure and still refuses byte-identically, and only the
      // exec layer's own no-exit-code failure gets the 503. A widening that
      // read any rejection as unreachable fails here rather than passing the
      // 503 cases above.
      const { ownerCtx, serverId } = await setUpOwnerWithServer();

      rejectInspectWith(new Error('no such container'));
      const notTransport = await refusalOf(
        dockerOps.getConfig(ownerCtx, { containerId: 'abc123', serverId }),
      );

      rejectInspectWith(unreachable());
      const neverReached = await refusalOf(
        dockerOps.getConfig(ownerCtx, { containerId: 'abc123', serverId }),
      );

      expect(notTransport?.status).toBe(403);
      expect(notTransport?.body.message).toBe(CONTAINER_DENIAL_MESSAGE);
      expect(neverReached?.status).toBe(503);
      expect(neverReached?.body.message).not.toBe(CONTAINER_DENIAL_MESSAGE);
    });

    it('refuses the platform host in its own words, and in its own code', async () => {
      // ADR-0008 makes an absent `serverId` the platform host, and §2.5 names
      // the entity: a Server and the host Cloudgate runs on are two different
      // things to be told about.
      //
      // **The code is the half added later, and the sentence is why it had to
      // be.** The two subjects had two sentences and one code, and the console
      // branches on the code — `errorMessage()` is forbidden from matching the
      // prose — so this refusal reached an operator as *"Cloudgate could
      // not reach that Server … check that its SSH key still works"*: a machine
      // that is not involved, and a credential the platform host does not use.
      const { ownerCtx } = await setUpOwnerWithServer();
      rejectInspectWith(unreachable());

      const refusal = await refusalOf(
        dockerOps.getConfig(ownerCtx, { containerId: 'abc123' }),
      );

      expect(refusal?.status).toBe(503);
      expect(refusal?.body.message).toBe(
        'The platform host could not be reached',
      );
      expect(refusal?.body.code).toBe(PLATFORM_HOST_UNREACHABLE_CODE);
      // Asserted as *not* the Server's code as well, because the two being
      // equal is the defect rather than the platform code being absent.
      expect(refusal?.body.code).not.toBe(HOST_UNREACHABLE_CODE);
    });

    /**
     * The two arms compared to each other over HTTP, on one route, in one body.
     *
     * The pairing is the property, the way the 403/503 pairing above is: what
     * makes the console able to say two sentences is that the two refusals
     * differ in the one field it is allowed to read, and neither the status nor
     * the message is that field. A fix written as "publish the platform code
     * everywhere" passes the platform case above and fails here.
     *
     * Over the wire rather than at the service, because the `code` does not
     * exist until `AllExceptionsFilter` has rendered the exception — and
     * because the rejected alternative was a `serverId` field on this body,
     * which that filter drops silently: it copies `message`, `code` and
     * `details` off the object form and nothing else. Asserted, so the next
     * reader reaching for the id can see why it is not there.
     */
    it('tells the two arms apart on the wire, and echoes no serverId', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      rejectInspectWith(unreachable());

      const config = (query: string) =>
        request(server)
          .get(`/docker/containers/abc123/config${query}`)
          .set('Cookie', ownerSession.cookie);

      const onServer = await config(`?serverId=${serverId}`);
      const onHost = await config('');

      const bodyOf = (response: { body: unknown }) =>
        response.body as { code?: string; message?: string; serverId?: string };

      expect(onServer.status).toBe(503);
      expect(onHost.status).toBe(503);
      // Same status, different code, different sentence — and the code is the
      // one the console is allowed to branch on.
      expect(bodyOf(onServer)).toMatchObject({
        code: HOST_UNREACHABLE_CODE,
        message: 'This Server could not be reached',
      });
      expect(bodyOf(onHost)).toMatchObject({
        code: PLATFORM_HOST_UNREACHABLE_CODE,
        message: 'The platform host could not be reached',
      });
      expect(bodyOf(onHost).code).not.toBe(bodyOf(onServer).code);

      // No id on either body: the subject is a name, not an identifier, and
      // `ErrorResponseBody` does not carry one for the console to read — the
      // filter would drop it even if a thrower attached one.
      expect(bodyOf(onServer).serverId).toBeUndefined();
      expect(bodyOf(onHost).serverId).toBeUndefined();
      // And nothing about the container, on either arm: an unreachable machine
      // discloses nothing about whether the container exists.
      expect(bodyOf(onServer).message).not.toContain('abc123');
      expect(bodyOf(onHost).message).not.toContain('abc123');
    });

    /**
     * Over HTTP, because the status and the `code` are what the console
     * branches on and neither exists until `AllExceptionsFilter` has rendered
     * the exception: `ApiError.isUnreachableHost` reads the status *and* the
     * code, so a 503 that lost its `code` on the way out would be reported to
     * an operator as "the backend is not answering" — a confident claim about
     * the wrong machine, and the misattribution this whole split exists to
     * remove.
     */
    it('renders the 503 and its code on the wire, on all three surfaces', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      rejectInspectWith(unreachable());

      const config = await request(server)
        .get(`/docker/containers/abc123/config?serverId=${serverId}`)
        .set('Cookie', ownerSession.cookie);
      expect(config.status).toBe(503);
      expect(config.body).toMatchObject({
        code: HOST_UNREACHABLE_CODE,
        message: 'This Server could not be reached',
      });

      const stopped = await request(server)
        .post(`/docker/containers/abc123/stop`)
        .set('Cookie', ownerSession.cookie)
        .send({ serverId });
      expect(stopped.status).toBe(503);
      expect(stopped.body).toMatchObject({ code: HOST_UNREACHABLE_CODE });

      const uploaded = await request(server)
        .post('/docker/containers/abc123/upload')
        .set('Cookie', ownerSession.cookie)
        .field('destinationPath', '/etc/app/config.json')
        .field('serverId', serverId)
        .attach('file', Buffer.from('hello'), 'config.txt');
      expect(uploaded.status).toBe(503);
      expect(uploaded.body).toMatchObject({ code: HOST_UNREACHABLE_CODE });

      // Nothing was written into any container on the way to the refusal: the
      // gate is still ahead of every side effect (ADR-0010).
      expect(
        remoteExec.execAsyncRemote.mock.calls.filter(
          ([, command]) => !command.startsWith('docker inspect'),
        ),
      ).toHaveLength(0);
    });
  });

  describe('container lifecycle', () => {
    // op → the exact command it runs (`docker rm -f` for remove, `docker
    // container <verb>` for the rest).
    const cases = [
      ['restartContainer', 'docker container restart abc123'],
      ['startContainer', 'docker container start abc123'],
      ['stopContainer', 'docker container stop abc123'],
      ['killContainer', 'docker container kill abc123'],
      ['removeContainer', 'docker rm -f abc123'],
    ] as const;

    it.each(cases)(
      '%s issues its docker command locally',
      async (op, command) => {
        const { ownerCtx } = await setUpOwnerWithServer();
        stubDaemon(ownerLabels());

        await dockerOps[op](ownerCtx, { containerId: 'abc123' });

        expect(remoteExec.execAsync).toHaveBeenCalledWith(command);
      },
    );

    it.each(cases)(
      '%s dispatches over SSH by serverId',
      async (op, command) => {
        const { ownerCtx, serverId } = await setUpOwnerWithServer();
        stubDaemon(ownerLabels());

        await dockerOps[op](ownerCtx, { containerId: 'abc123', serverId });

        expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
          serverId,
          command,
        );
        // Including the ownership gate's own inspect: the labels are read on
        // the machine being addressed, never locally (ADR-0008).
        expect(remoteExec.execAsync).not.toHaveBeenCalled();
      },
    );

    it('throws the stderr text when docker reports an error', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      stubDaemon(ownerLabels(), {
        stdout: '',
        stderr: 'Error response from daemon: No such container: abc123',
        exitCode: 0,
      });

      await expect(
        dockerOps.restartContainer(ownerCtx, { containerId: 'abc123' }),
      ).rejects.toThrow(
        'Error response from daemon: No such container: abc123',
      );
    });
  });

  /**
   * `containerOp` gated `stop`, `kill`, `start`, `restart` and `docker rm
   * -f` on `docker: ['read']`, the only action the resource had — so a **read**
   * statement authorized five destructive verbs, and a licensed custom role
   * holding it could `docker rm -f` a managed container while being refused
   * `POST /settings/traefik/reload`.
   *
   * **Every fixture here is a licensed custom role that does not hold the
   * action.** An owner ctx cannot tell a passing gate from an absent one: the
   * owner holds every action, so the assertion would be green either way. The
   * organization's owner appears in `container lifecycle` above, which is the
   * allowing direction and is what says this narrowing did not break the
   * console for the people who run it.
   */
  describe('the five destructive verbs need docker write', () => {
    // op → the exact command it runs, the same table `container lifecycle`
    // drives: the five share one body, so a per-verb table is what proves the
    // new gate is not on four of them.
    const cases = [
      ['restartContainer', 'docker container restart abc123'],
      ['startContainer', 'docker container start abc123'],
      ['stopContainer', 'docker container stop abc123'],
      ['killContainer', 'docker container kill abc123'],
      ['removeContainer', 'docker rm -f abc123'],
    ] as const;

    it.each(cases)(
      '%s refuses a licensed custom role holding docker read alone',
      async (op) => {
        const { roleCtx } = await setUpCustomRole({ docker: ['read'] });
        stubDaemon(ownerLabels());

        await expect(
          dockerOps[op](roleCtx, { containerId: 'abc123' }),
        ).rejects.toThrow(ForbiddenException);

        // Nothing was inspected, stopped, killed or removed on the way to being
        // refused — the statement gate runs before the container is touched at
        // all, so not even the ownership gate's own inspect went out.
        expect(remoteExec.execAsync).not.toHaveBeenCalled();
      },
    );

    /**
     * **On the role's own Server, and the retarget is the point
     * rather than a workaround.** The container is unmanaged, which is the
     * target this block needs — a managed one is governed by entitlement and
     * would prove nothing about the `docker` statement — and an unmanaged
     * container on the *platform host* now takes instance authority on top,
     * which a custom role never holds. Left on the host this case would be red
     * for a reason that has nothing to do with `read` versus `write`. The
     * refusal it used to assert as an allowance is pinned as its own test in
     * `an unmanaged container on the platform host` below, on
     * `certificates.e2e-spec.ts`'s precedent.
     */
    it.each(cases)(
      '%s allows a licensed custom role holding docker read and write, on its own Server',
      async (op, command) => {
        const { roleCtx, serverId } = await setUpCustomRole({
          docker: ['read', 'write'],
        });
        stubDaemon(ownerLabels());

        await dockerOps[op](roleCtx, { containerId: 'abc123', serverId });

        expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
          serverId,
          command,
        );
      },
    );

    /**
     * The other half of the claim: the narrowing is surgical rather than a
     * blanket denial. A role holding `docker: ['read']` keeps every route it
     * could reach before — otherwise the fix would be a feature removal
     * delivered inside a security fix, which is what
     * `container-access.service.ts` says the gates exist *not* to be.
     *
     * **On the role's own Server**, for the same reason the verb
     * cases above moved there for the instance-authority check: every row in `PS_OUTPUT` is
     * *unmanaged*, and the listing hides the platform host's unmanaged rows
     * from a caller without instance authority now. Left on the host this would
     * be red for a reason that has nothing to do with `read` versus `write`.
     * The refusal it used to assert as an allowance is its own test in `an
     * unmanaged container on the platform host` below.
     */
    it('still lists containers for a role holding docker read alone, on its own Server', async () => {
      const { roleCtx, serverId } = await setUpCustomRole({ docker: ['read'] });
      remoteExec.execAsyncRemote.mockResolvedValue(ok(PS_OUTPUT));

      const containers = await dockerOps.getContainers(roleCtx, { serverId });

      expect(containers?.map((row) => row.name)).toEqual([
        'web-app',
        'cloudgate-monitoring',
      ]);
    });

    it('still inspects a container for a role holding docker read alone', async () => {
      const { roleCtx, serverId } = await setUpCustomRole({ docker: ['read'] });
      stubDaemon(ownerLabels(), ok('{"Id":"abc123"}'));

      // The role's own Server, for the reason the block above records: the
      // target has to be unmanaged for this to be about `docker: ['read']`, and
      // an unmanaged container on the platform host takes instance authority
      //.
      await expect(
        dockerOps.getConfig(roleCtx, { containerId: 'abc123', serverId }),
      ).resolves.toEqual({ Id: 'abc123' });
    });

    /**
     * The issue's headline symptom, on the wire: *"a licensed custom role
     * holding `docker: ['read']` can `docker rm -f` a managed container while
     * being refused `POST /settings/traefik/reload`."* The `GET` beside it is
     * what says the role was narrowed rather than locked out.
     *
     * Over HTTP rather than at the service seam because the status is the thing
     * an operator meets. It does **not** pin which of the two gates answered:
     * `PermissionsGuard` reads the route's `@RequirePermission`, which moved to
     * `'write'` in step with `containerOp`'s own check, and either refuses this
     * caller with the same 403 — so a stale decorator would still be green here.
     * Keeping the two in step is a review concern, not something a test on this
     * surface can hold.
     */
    it('refuses DELETE /docker/containers/:id to a role holding docker read alone, and still serves it the listing', async () => {
      const { cookie, serverId } = await setUpCustomRole({ docker: ['read'] });
      remoteExec.execAsyncRemote.mockResolvedValue(ok(PS_OUTPUT));

      const removed = await request(server)
        .delete('/docker/containers/abc123')
        .set('Cookie', cookie);
      expect(removed.status).toBe(403);

      // The role's own Server, and the **rows** asserted rather than the
      // status: now the platform host answers this role an empty
      // listing, so a bare `200` no longer says "narrowed rather than locked
      // out" — which is the whole claim this half carries.
      const listed = await request(server)
        .get('/docker/containers')
        .query({ serverId })
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).not.toEqual([]);
    });
  });

  /**
   * `uploadFileToContainer` was the one route the write-verb scoping left out by name,
   * with a note at its change site saying `docker cp` into a container had been
   * considered and left on `docker: ['read']`. It was the same defect one route
   * over: the method stages a caller's bytes under /tmp and `docker cp`s them to
   * a caller-supplied path, so a *read* statement let a licensed custom role
   * overwrite an application's config, or drop a file where the app will execute
   * it, in any managed container it could address.
   *
   * **Every fixture here is a licensed custom role that does not hold the
   * action.** The organization's own owner holds every action, so an owner ctx
   * cannot tell a passing gate from an absent one and would be green either way
   * — the shape this repo has shipped a real hole green behind twice. The owner
   * appears in `uploadFileToContainer` below instead, which is the allowing
   * direction.
   */
  describe('the file upload needs docker write', () => {
    it('refuses a licensed custom role holding docker read alone', async () => {
      const { roleCtx } = await setUpCustomRole({ docker: ['read'] });
      stubDaemon(ownerLabels());

      await expect(
        dockerOps.uploadFileToContainer(
          roleCtx,
          { containerId: 'abc123', destinationPath: '/etc/app/config.json' },
          Buffer.from('pwned'),
          'config.json',
        ),
      ).rejects.toThrow(ForbiddenException);

      // Nothing was staged, copied or even inspected on the way to being
      // refused: the statement gate runs before the container is touched, so not
      // even the ownership gate's own inspect went out.
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    /**
     * The one assertion that says which **docker** action the gate is allowed to
     * name. The role holds `docker: ['write']` and no `docker: ['read']`, so
     * this is the only fixture here that would go red if the gate were
     * re-tightened to demand both — `['write']` alone is `containerOp`'s and
     * `traefikFiles`' precedent, each route asking for the one action it needs.
     *
     * The container has to be a **managed** one for the claim to be provable at
     * all. An unmanaged container falls through `authorizeAppNames`' machine
     * branch, which asks for `docker: ['read']` in its own right (ADR-0008), so
     * a write-only role is refused there no matter what the route's own gate
     * says. A container carrying a Service's owner label is governed by
     * entitlement to that Service instead — hence the `service: ['read']` grant
     * and the `accessedServices` row, which are about reaching *this* container
     * and not about the docker statement under test.
     */
    it('allows a licensed custom role holding docker write alone, on a container its Service entitles it to', async () => {
      const { roleCtx, ownerCtx, inviteeId, organizationId } =
        await setUpCustomRole({ docker: ['write'], service: ['read'] });

      const project = await projects.create(ownerCtx, { name: 'shop' });
      const environment = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
        deployTarget: { kind: 'platform-host' },
      });
      const app = await applications.create(ownerCtx, {
        name: 'web-app',
        appName: 'web-app',
        environmentId: environment.environmentId,
      });
      await ctx.db
        .update(member)
        .set({ accessedServices: [app.applicationId] })
        .where(
          and(
            eq(member.userId, inviteeId),
            eq(member.organizationId, organizationId),
          ),
        );

      stubDaemon(ownerLabels({ compose: 'web-app' }));

      await dockerOps.uploadFileToContainer(
        roleCtx,
        { containerId: 'abc123', destinationPath: '/etc/app/config.json' },
        Buffer.from('hello'),
        'config.json',
      );

      // Call 0 is the ownership gate's inspect; the copy is what follows it.
      expect(remoteExec.execAsync.mock.calls[1][0]).toContain(
        'docker cp "/tmp/cloudgate-upload-',
      );
    });

    it('allows a licensed custom role holding docker read and write, on its own Server', async () => {
      const { roleCtx, serverId } = await setUpCustomRole({
        docker: ['read', 'write'],
      });
      stubDaemon(ownerLabels());

      await dockerOps.uploadFileToContainer(
        roleCtx,
        {
          containerId: 'abc123',
          destinationPath: '/etc/app/config.json',
          serverId,
        },
        Buffer.from('hello'),
        'config.json',
      );

      // Call 0 is the gate's inspect, call 1 the copy; `[1]` is the command and
      // `[0]` the serverId on the remote seam.
      expect(remoteExec.execAsyncRemote.mock.calls[1][1]).toContain(
        '"abc123:/etc/app/config.json"',
      );
    });

    /**
     * The other half of the claim, as in the write-verb block above: the narrowing is
     * surgical rather than a blanket denial. A role holding `docker: ['read']`
     * keeps every read it could reach before — `getConfig` shared the upload's
     * gate and is a genuine read, so it is the one that would be taken down with
     * it if the move were sloppier than it claims to be.
     *
     * Both halves name the role's own Server, for the reason the write-verb block
     * records: an unmanaged target on the platform host takes instance
     * authority, and its *rows* do.
     */
    it('still lists containers and inspects one for a role holding docker read alone, on its own Server', async () => {
      const { roleCtx, serverId } = await setUpCustomRole({ docker: ['read'] });

      remoteExec.execAsyncRemote.mockResolvedValue(ok(PS_OUTPUT));
      const containers = await dockerOps.getContainers(roleCtx, { serverId });
      expect(containers?.map((row) => row.name)).toEqual([
        'web-app',
        'cloudgate-monitoring',
      ]);
      remoteExec.execAsyncRemote.mockReset();

      remoteExec.execAsync.mockReset();
      stubDaemon(ownerLabels(), ok('{"Id":"abc123"}'));
      await expect(
        dockerOps.getConfig(roleCtx, { containerId: 'abc123', serverId }),
      ).resolves.toEqual({ Id: 'abc123' });
    });

    /**
     * On the wire, because the status is what an operator meets, and because the
     * decorator is a second gate that has to move in step with the service's own
     * check. As on the write-verb `DELETE`, this does not pin *which* of the two
     * answered — `PermissionsGuard` and `checkPermission` both refuse this caller
     * with the same 403 — so keeping them in step stays a review concern. The
     * `GET` beside it is what says the role was narrowed rather than locked out.
     */
    it('refuses POST /docker/containers/:id/upload to a role holding docker read alone, and still serves it the listing', async () => {
      const { cookie, serverId } = await setUpCustomRole({ docker: ['read'] });
      remoteExec.execAsyncRemote.mockResolvedValue(ok(PS_OUTPUT));

      const uploaded = await request(server)
        .post('/docker/containers/abc123/upload')
        .set('Cookie', cookie)
        .field('destinationPath', '/etc/app/config.json')
        .attach('file', Buffer.from('pwned'), 'config.txt');
      expect(uploaded.status).toBe(403);

      // On the role's own Server and asserting the rows, as on the write-verb `DELETE`
      // above: an empty `200` from the platform host would satisfy a status
      // check while saying nothing about the role keeping the read.
      const listed = await request(server)
        .get('/docker/containers')
        .query({ serverId })
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).not.toEqual([]);
    });
  });

  /**
   * The statement check, over HTTP — **the half the issue and the first draft of ADR-0008's
   * amendment both got wrong.**
   *
   * The refusal `ContainerAccessService.authorizeAppNames`' machine branch used
   * to let out is not `PermissionService`'s fallback *"Permission denied"*: that
   * string is only reached when better-auth answers no error at all, and for
   * `docker` it always answers one. `role.authorize({ docker: ['read'] })`
   * returns *unauthorized to access resource "docker"* — a sentence naming the
   * resource — against `CONTAINER_DENIAL_MESSAGE` from every branch behind it.
   *
   * And it was reachable, which the amendment first recorded as "not on the
   * wire". The caller is not a base member — `memberRole` grants `docker: []`
   * and all three routes ask for a `docker` statement of their own first, so
   * they are refused identically for every id and never arrive. It is a caller
   * who clears the **route's** statement and fails **this** one, and those
   * stopped being the same statement with the write-verb scoping: the five verbs and the
   * upload ask `docker: ['write']`, this branch asks `docker: ['read']`, and
   * `validatePermissions` accepts `docker: ['write']` with no `read`.
   *
   * On the role's **own Server** deliberately: the instance-authority check
   * is skipped for a named `serverId`, so the only thing that can refuse the
   * unmanaged target here is the statement — which is what makes this block
   * about the statement check and nothing else.
   */
  describe("a role holding the route's docker write but not the gate's read", () => {
    /**
     * The write-only role, plus a real Application in a **second** organization
     * whose `appName` the inspect below names — so the foreign-managed refusal
     * is a Service row in another organization rather than a name that resolves
     * to nothing and takes the same branch as the unmanaged one.
     */
    async function setUpWriteOnlyRole() {
      const role = await setUpCustomRole({ docker: ['write'] });
      const { ownerSession, cookie, roleCtx, serverId } = role;

      const second = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const orgTwoCtx = permissionCtx(
        ownerSession.id,
        (second.body as { id: string }).id,
      );
      const project = await projects.create(orgTwoCtx, { name: 'rival' });
      const environment = await environments.create(orgTwoCtx, {
        name: 'production',
        projectId: project.projectId,
        deployTarget: { kind: 'platform-host' },
      });
      await applications.create(orgTwoCtx, {
        name: 'app-rival',
        appName: 'app-rival',
        environmentId: environment.environmentId,
      });

      return { cookie, roleCtx, serverId };
    }

    const stop = (cookie: string, serverId: string) =>
      request(server)
        .post('/docker/containers/abc123/stop')
        .set('Cookie', cookie)
        .send({ serverId });

    it("answers it one sentence for an unmanaged container and for another organization's", async () => {
      const { cookie, serverId } = await setUpWriteOnlyRole();

      stubDaemon(ownerLabels({ name: '/operator-sidecar' }));
      const unmanaged = await stop(cookie, serverId);

      stubDaemon(ownerLabels({ swarm: 'app-rival', name: '/app-rival.1.abc' }));
      const foreign = await stop(cookie, serverId);

      const said = (res: { body: unknown }) =>
        (res.body as { message: string }).message;

      expect(unmanaged.status).toBe(403);
      expect(foreign.status).toBe(403);
      expect(said(unmanaged)).toBe(said(foreign));
      expect(said(unmanaged)).toBe(CONTAINER_DENIAL_MESSAGE);
      // Named rather than left to the equality above: the statement's own words
      // carry the resource, and the resource is the fact that separated the two.
      expect(said(unmanaged)).not.toContain('docker');
    });

    /**
     * **The premise, asserted rather than assumed**, and it is the whole reason
     * this block can fail: the role really does clear `POST …/stop`'s own
     * `docker: ['write']` guard, so the refusals above came from the gate and
     * not from the route. A role that failed the route check would answer 403
     * twice with one message too, and say nothing at all.
     *
     * The gate's `docker inspect` is what says so: `checkPermission` and the
     * `@RequirePermission('docker', 'write')` guard both run before
     * `ownedServerId`, so nothing reaches the daemon at all if either refuses.
     */
    it('is refused by the gate and not by the route, which its own inspect proves', async () => {
      const { cookie, serverId } = await setUpWriteOnlyRole();
      stubDaemon(ownerLabels({ name: '/operator-sidecar' }));

      await stop(cookie, serverId);

      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        serverId,
        INSPECT_COMMAND('abc123'),
      );
      // And no further: the refusal is the gate's, so `docker container stop`
      // was never issued.
      expect(
        remoteExec.execAsyncRemote.mock.calls.filter(([, command]) =>
          String(command).includes('container stop'),
        ),
      ).toHaveLength(0);
    });

    /**
     * The other direction, and what says the fix is a translation rather than a
     * widening: the role still cannot reach the container. `docker: ['read']`
     * is what an unmanaged container takes and this role does not hold it — only
     * the sentence moved.
     */
    it('still refuses it the container it could not reach before', async () => {
      const { roleCtx, serverId } = await setUpWriteOnlyRole();
      stubDaemon(ownerLabels({ name: '/operator-sidecar' }));

      await expect(
        dockerOps.stopContainer(roleCtx, { containerId: 'abc123', serverId }),
      ).rejects.toThrow(CONTAINER_DENIAL_MESSAGE);
    });
  });

  /**
   * **The statement-check shape on the sibling branch**, and the one site the audit
   * the issue asked for actually found.
   *
   * The earlier fix translated the statement check standing in front of
   * `ContainerAccessService.authorizeAppNames`' **machine** branch and left the
   * **service** branch's `checkServiceAccess` throwing its own two sentences —
   * better-auth's *unauthorized to access resource "service"* when the role
   * holds no `service` action, and *"You don't have access to this service"*
   * when the member row does not name the Service. Neither is
   * {@link CONTAINER_DENIAL_MESSAGE}, so `authorizeAppNames`' own docblock's
   * *"every denial says the same thing"* was false for the branch that answers
   * a **managed** container — which is ADR-0008's *not-entitled*, the first of
   * the three the one-close-code bullet names.
   *
   * **Which caller, measured rather than assumed**, and it is the statement
   * check's population exactly. Not a base member: `memberRole` grants `docker:
   * []` and every container-addressed route asks for a `docker` statement first,
   * so a member is refused identically for every id and never arrives. Not a socket either:
   * `socket-access.ts` normalizes every close frame. What arrives is a licensed
   * custom role that clears the route's `docker` statement and fails this
   * branch's — and `validatePermissions` accepts `docker: ['read', 'write']`
   * with no `service` entry at all, which is the role built below.
   *
   * **What it discloses, which is why it is a fix and not a tidy-up.** The two
   * sentences partition every container id on a shared machine into *owned by a
   * Service in my organization* and *owned by somebody else's Service, or by
   * nobody, or not a container at all* — a distinction drawn by an
   * authorization refusal rather than by a listing, on the machine every
   * organization's services share. It is the fifth distinguishable answer of
   * the class the byte-identical denial closed four of, and it arrives from the
   * same place the statement check's did: a check standing in front of a branch
   * rather than a branch itself.
   *
   * On the role's **own Server** for the same reason: the instance-authority
   * check is skipped for a named `serverId`, so nothing but entitlement can
   * refuse here and the block stays about entitlement.
   */
  describe("a role holding the route's docker statement but not the gate's service entitlement", () => {
    /**
     * A role that can reach the machine and not the workload: `docker` in full,
     * so the machine branch clears and the route's own `write` clears, and no
     * `service` statement, so `checkServiceAccess`' first half refuses. Plus an
     * Application in this role's **own** organization for the managed target,
     * and one in a **second** organization for the foreign target it is
     * measured against.
     */
    async function setUpMachineOnlyRole() {
      const role = await setUpCustomRole({ docker: ['read', 'write'] });
      const { ownerSession, ownerCtx, cookie, roleCtx, serverId } = role;

      const ownProject = await projects.create(ownerCtx, { name: 'mine' });
      const ownEnvironment = await environments.create(ownerCtx, {
        name: 'production',
        projectId: ownProject.projectId,
        deployTarget: { kind: 'platform-host' },
      });
      await applications.create(ownerCtx, {
        name: 'app-mine',
        appName: 'app-mine',
        environmentId: ownEnvironment.environmentId,
      });

      const second = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const orgTwoCtx = permissionCtx(
        ownerSession.id,
        (second.body as { id: string }).id,
      );
      const rivalProject = await projects.create(orgTwoCtx, { name: 'rival' });
      const rivalEnvironment = await environments.create(orgTwoCtx, {
        name: 'production',
        projectId: rivalProject.projectId,
        deployTarget: { kind: 'platform-host' },
      });
      await applications.create(orgTwoCtx, {
        name: 'app-rival',
        appName: 'app-rival',
        environmentId: rivalEnvironment.environmentId,
      });

      return { cookie, roleCtx, serverId };
    }

    const stop = (cookie: string, serverId: string) =>
      request(server)
        .post('/docker/containers/abc123/stop')
        .set('Cookie', cookie)
        .send({ serverId });

    const said = (res: { body: unknown }) =>
      (res.body as { message: string }).message;

    it("answers it one sentence for its own organization's container and for another organization's", async () => {
      const { cookie, serverId } = await setUpMachineOnlyRole();

      stubDaemon(ownerLabels({ swarm: 'app-mine', name: '/app-mine.1.abc' }));
      const own = await stop(cookie, serverId);

      stubDaemon(ownerLabels({ swarm: 'app-rival', name: '/app-rival.1.abc' }));
      const foreign = await stop(cookie, serverId);

      expect(own.status).toBe(403);
      expect(foreign.status).toBe(403);
      expect(said(own)).toBe(said(foreign));
      expect(said(own)).toBe(CONTAINER_DENIAL_MESSAGE);
      // Named rather than left to the equality above: the statement's own words
      // carry the resource, and the resource is the fact that separated the two.
      expect(said(own)).not.toContain('service');
    });

    /**
     * The second half of `checkServiceAccess`, which refuses with a different
     * sentence again — *"You don't have access to this service"* — and reaches
     * the wire through the same unwrapped call. The role holds `service:
     * ['read']` here, so the statement clears and only the member row's
     * `accessedServices` can refuse; without this the fix could be written as a
     * catch around the statement alone and this branch would still leak.
     */
    it('answers it the same sentence when it is the member row and not the statement that refuses', async () => {
      const role = await setUpCustomRole({
        docker: ['read', 'write'],
        service: ['read'],
      });
      const { ownerCtx, cookie, serverId } = role;

      const ownProject = await projects.create(ownerCtx, { name: 'mine' });
      const ownEnvironment = await environments.create(ownerCtx, {
        name: 'production',
        projectId: ownProject.projectId,
        deployTarget: { kind: 'platform-host' },
      });
      await applications.create(ownerCtx, {
        name: 'app-mine',
        appName: 'app-mine',
        environmentId: ownEnvironment.environmentId,
      });

      stubDaemon(ownerLabels({ swarm: 'app-mine', name: '/app-mine.1.abc' }));
      const own = await stop(cookie, serverId);

      expect(own.status).toBe(403);
      expect(said(own)).toBe(CONTAINER_DENIAL_MESSAGE);
    });

    /**
     * The other direction, and what says the fix is a translation rather than a
     * widening: the role still cannot reach the container. Only the sentence
     * moved — the same claim the statement-check block makes for the machine branch.
     */
    it('still refuses it the container it could not reach before', async () => {
      const { roleCtx, serverId } = await setUpMachineOnlyRole();
      stubDaemon(ownerLabels({ swarm: 'app-mine', name: '/app-mine.1.abc' }));

      await expect(
        dockerOps.stopContainer(roleCtx, { containerId: 'abc123', serverId }),
      ).rejects.toThrow(CONTAINER_DENIAL_MESSAGE);
      expect(
        remoteExec.execAsyncRemote.mock.calls.filter(([, command]) =>
          String(command).includes('container stop'),
        ),
      ).toHaveLength(0);
    });
  });

  /**
   * `docker: ['write']` was the whole gate on an **unmanaged** container
   * on the **platform host**, which is the machine every organization's
   * services share.
   *
   * The two checks in front of `authorizeManagedContainer` are both
   * organization-level: the statement is a capability owner, admin and any
   * licensed custom role can hold, and `ownedServerId` resolves an absent
   * `serverId` to `undefined` by design (ADR-0008's second consequence,
   * restated in `common/owned-server.ts` as *"do not fix it"*). So on the
   * platform host an owner of any second Organization could stop, kill,
   * restart, `rm -f` or `docker cp` into an operator's own sidecar. The hide's
   * carve-out covers Cloudgate's *own* containers by name, which leaves
   * everything an operator runs beside them — and `cloudgate-monitoring`, which
   * the predicate deliberately excludes.
   *
   * The split is ADR-0013's: instance authority on the host branch, organization
   * authority on a named Server. ADR-0013 carries the decision.
   *
   * **Mallory rather than a custom role, and rather than a base member.** A base
   * member holds `docker: []` and never reaches this gate, so a fixture built on
   * one would be green either way — the shape this repo has shipped a real hole
   * behind twice. Her Organization and her owner row are real rows written by
   * `secondOrganizationOwner`, which also keeps her *out* of the instance
   * organization by issuing her invitation from the second one.
   */
  describe('an unmanaged container on the platform host', () => {
    /** The instance owner, a Server they own, and Mallory beside them. */
    async function setUpMallory() {
      const { ownerSession, organizationId, serverId } =
        await setUpOwnerWithServer();
      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerSession.cookie,
      );
      return { ownerSession, organizationId, serverId, mallory };
    }

    /** A Server of Mallory's own, so the named-Server branch has a real row. */
    async function setUpMalloryServer(mallory: {
      id: string;
      organizationId: string;
    }) {
      const malloryCtx = permissionCtx(mallory.id, mallory.organizationId);
      const key = await sshKeys.create(malloryCtx, { name: 'mallory-key' });
      const created = await servers.create(malloryCtx, {
        name: 'mallory-1',
        ipAddress: '203.0.113.20',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      return created.serverId;
    }

    // The five destructive verbs and the inspect, as the console addresses
    // them. A table rather than one call, because the five share one body and
    // `getConfig` does not — a single case cannot say the gate is on all six.
    // The upload has its own test below: it carries a multipart body.
    // `.send({})` on the four POSTs is the house pattern here and it is
    // load-bearing rather than decorative: `ServerIdBodyDto` is validated, and a
    // POST with no body at all answers 400 before any gate — which is how a
    // refusal test on this surface stops being able to fail. Measured: the red
    // run for the instance-authority check answered 400 on all four before this was added.
    const routes = [
      [
        'restart',
        () =>
          request(server).post('/docker/containers/abc123/restart').send({}),
      ],
      [
        'start',
        () => request(server).post('/docker/containers/abc123/start').send({}),
      ],
      [
        'stop',
        () => request(server).post('/docker/containers/abc123/stop').send({}),
      ],
      [
        'kill',
        () => request(server).post('/docker/containers/abc123/kill').send({}),
      ],
      ['remove', () => request(server).delete('/docker/containers/abc123')],
      ['config', () => request(server).get('/docker/containers/abc123/config')],
    ] as const;

    it.each(routes)(
      "refuses another organization's owner the %s route",
      async (_name, route) => {
        const { mallory } = await setUpMallory();
        stubDaemon(ownerLabels({ name: '/operator-sidecar' }));

        const denied = await route().set('Cookie', mallory.cookie);

        expect(denied.status).toBe(403);
        expect((denied.body as { message: string }).message).toBe(
          CONTAINER_DENIAL_MESSAGE,
        );
        // And it does not leak `checkInstanceAuthority`'s own sentence, which
        // names the platform host and would tell this caller "that id resolved
        // to no Service" apart from "that id is somebody else's".
        expect((denied.body as { message: string }).message).not.toBe(
          INSTANCE_AUTHORITY_REFUSAL,
        );
      },
    );

    /**
     * **The cost, pinned rather than hidden**, on `certificates.e2e-spec.ts`'s
     * precedent: a licensed custom role granted
     * `docker: ['read', 'write']` — *in the instance organization*, so this is
     * not about a second Organization at all — can no longer touch an unmanaged
     * container on the platform host. `checkInstanceAuthority` reads the static
     * role and nothing else, which is ADR-0013's third consequence and the
     * whole reason the boundary is not a statement: a grantable statement would
     * let "Deploy engineer" quietly carry the machine every organization runs
     * on. The two write-verb blocks above are what this changed — their
     * unmanaged target moved to the role's own Server, which is where the
     * `docker` statement is still the whole gate.
     *
     * **Operator-facing:** to restore what such a role could do here there is
     * no grant to add — the role has to be an admin of the instance
     * organization. That is the point.
     */
    it('refuses a licensed custom role that holds docker read and write', async () => {
      const { roleCtx, serverId } = await setUpCustomRole({
        docker: ['read', 'write'],
      });
      stubDaemon(ownerLabels({ name: '/operator-sidecar' }));

      await expect(
        dockerOps.stopContainer(roleCtx, { containerId: 'abc123' }),
      ).rejects.toThrow(CONTAINER_DENIAL_MESSAGE);

      // And the same role, the same statement, the same unmanaged container on
      // a Server its own organization owns: still allowed. That pair is what
      // says the boundary is the *machine* and not the role's `docker` grant.
      await dockerOps.stopContainer(roleCtx, {
        containerId: 'abc123',
        serverId,
      });
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        serverId,
        'docker container stop abc123',
      );
    });

    it("refuses another organization's owner a docker cp into it", async () => {
      const { mallory } = await setUpMallory();
      stubDaemon(ownerLabels({ name: '/operator-sidecar' }));

      const uploaded = await request(server)
        .post('/docker/containers/abc123/upload')
        .set('Cookie', mallory.cookie)
        .field('destinationPath', '/etc/app/config.json')
        .attach('file', Buffer.from('pwned'), 'config.txt');

      expect(uploaded.status).toBe(403);
      expect((uploaded.body as { message: string }).message).toBe(
        CONTAINER_DENIAL_MESSAGE,
      );
      // Nothing was staged under /tmp and nothing was copied: the only command
      // that went out is the gate's own inspect.
      expect(
        remoteExec.execAsync.mock.calls.filter(([command]) =>
          command.includes('docker cp'),
        ),
      ).toHaveLength(0);
    });

    /**
     * The no-op claim on the single-organization install `deploy/install.sh`
     * produces: the one Organization *is* the instance organization, so the
     * operator keeps every verb they have today.
     */
    it("leaves the instance organization's owner exactly as they were", async () => {
      const { ownerSession } = await setUpMallory();
      stubDaemon(ownerLabels({ name: '/operator-sidecar' }));

      const stopped = await request(server)
        .post('/docker/containers/abc123/stop')
        .set('Cookie', ownerSession.cookie)
        .send({});

      expect(stopped.status).toBe(204);
      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        'docker container stop abc123',
      );
    });

    /**
     * The other half of the split, and what says this is a narrowing rather
     * than a removal: **a named Server keeps organization authority**
     * (ADR-0013's second consequence). Mallory's own Server is a real row in
     * her own Organization — a `serverId` with no row behind it answers 404
     * from `checkServerAccess` and could not tell a passing organization check
     * from one that never ran.
     */
    it("still answers for an unmanaged container on the caller's own Server", async () => {
      const { mallory } = await setUpMallory();
      const malloryServerId = await setUpMalloryServer(mallory);
      stubDaemon(ownerLabels({ name: '/operator-sidecar' }));

      const stopped = await request(server)
        .post('/docker/containers/abc123/stop')
        .set('Cookie', mallory.cookie)
        .send({ serverId: malloryServerId });

      expect(stopped.status).toBe(204);
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        malloryServerId,
        'docker container stop abc123',
      );
    });

    /**
     * And a **managed** container on the platform host is untouched: it belongs
     * to a Service, so entitlement answers it and instance authority is never
     * asked. Without this the fix would deny every organization's own services
     * on the default host — a feature removal delivered inside a security fix,
     * which `container-access.service.ts` says these gates exist *not* to be.
     */
    it("does not ask instance authority of a container the caller's own Service owns", async () => {
      const { ownerSession, organizationId } = await setUpOwnerWithServer();
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const project = await projects.create(ownerCtx, { name: 'cloudgate' });
      const environment = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
        deployTarget: { kind: 'platform-host' },
      });
      await applications.create(ownerCtx, {
        name: 'Web App',
        appName: 'web-app',
        environmentId: environment.environmentId,
      });
      // Mallory second, so her Organization exists and the instance
      // organization is still the first — the ordering the check reads. She is
      // present so this is the multi-organization install the fix is about
      // rather than the one where the check is a no-op.
      await secondOrganizationOwner(server, ctx.db, ownerSession.cookie);
      stubDaemon(ownerLabels({ swarm: 'web-app', name: '/web-app.1.abc' }));

      const stopped = await request(server)
        .post('/docker/containers/abc123/stop')
        .set('Cookie', ownerSession.cookie)
        .send({});

      expect(stopped.status).toBe(204);
    });

    /**
     * The listing rather than the acting. Three rows on the platform
     * host: one a Service owns, one an operator started with `docker run` and
     * one they started with `docker compose -p my-monitoring up`. The set is
     * what says the narrowing drops what the routes refuse and leaves everything
     * else alone, which a listing that came back empty could not.
     *
     * **The third row is the one that decides how the filter is written.** It
     * carries `com.docker.compose.project`, so the parse counts an owner label
     * for it and a *label* test would keep it — while `authorizeAppNames`
     * resolves that name against the Service relation, finds nothing, and sends
     * its id to the machine branch to be refused. Only a filter asking the
     * database the same question drops both unmanaged rows together.
     */
    const HOST_PS_OUTPUT = [
      psRow(
        'CONTAINER ID : aaa111 | Name: app-rival.1.abc | Image: app-rival:latest | Ports:  | State: running | Status: Up 2 hours',
        { swarm: 'app-rival' },
      ),
      psRow(
        'CONTAINER ID : ccc333 | Name: operators-own-redis | Image: redis:7 | Ports: 0.0.0.0:6379->6379/tcp | State: running | Status: Up 9 days',
      ),
      psRow(
        'CONTAINER ID : ddd444 | Name: my-monitoring-grafana-1 | Image: grafana/grafana:11 | Ports: 0.0.0.0:3000->3000/tcp | State: running | Status: Up 3 days',
        { compose: 'my-monitoring' },
      ),
    ].join('\n');

    /** Mallory, plus an Application of her own so her listing is not empty. */
    async function setUpMalloryWithApp() {
      const { ownerSession, organizationId, mallory } = await setUpMallory();
      const malloryCtx = permissionCtx(mallory.id, mallory.organizationId);
      const project = await projects.create(malloryCtx, { name: 'rival' });
      const environment = await environments.create(malloryCtx, {
        name: 'production',
        projectId: project.projectId,
        deployTarget: { kind: 'platform-host' },
      });
      await applications.create(malloryCtx, {
        name: 'app-rival',
        appName: 'app-rival',
        environmentId: environment.environmentId,
      });
      return { ownerSession, organizationId, mallory, malloryCtx };
    }

    /**
     * **The listing follows the operation path.** The instance-authority check refused the
     * *acting* on an unmanaged container here and left `getContainers` alone, so
     * the row stayed in the listing while every route that acts on its id
     * answered `CONTAINER_DENIAL_MESSAGE` — the disagreement the organization
     * filter exists to prevent, and ADR-0013's first consequence answers it the same way it
     * answered the Traefik reads: the row carries the image, the published
     * ports, the state and the **container id** the ownership-gated routes take,
     * so admitting the read hands a second organization's owner the
     * reconnaissance half of an attack the write now refuses.
     *
     * Her own managed row is the control: it stays, so this is a per-row
     * narrowing and not a route that stopped answering. **Both** unmanaged rows
     * go, and the labelled one is the case a filter written on the parsed
     * `owners` array would have kept — see `HOST_PS_OUTPUT`.
     */
    it("omits the platform host's unmanaged rows from another organization's owner", async () => {
      const { malloryCtx } = await setUpMalloryWithApp();
      remoteExec.execAsync.mockResolvedValue(ok(HOST_PS_OUTPUT));

      const containers = await dockerOps.getContainers(malloryCtx, {});

      expect(containers?.map((row) => row.name)).toEqual(['app-rival.1.abc']);
      // And not by refusing the route: the `docker ps` still ran, and the row
      // was dropped from its output rather than the caller being turned away —
      // which is what keeps her own containers on the screen.
      expect(remoteExec.execAsync).toHaveBeenCalledWith(PS_COMMAND);
    });

    /**
     * **The other half of the pair, and the one that makes the claim a claim.**
     * "The listing follows the operation path" is about two surfaces, so it
     * cannot be asserted on the listing alone: the row dropped above has to be
     * the row the route refuses, asked of the same caller and the same id.
     *
     * The labelled one is the case that matters. Its `com.docker.compose.project`
     * is an owner label the listing's parse counts, and
     * `ContainerAccessService.servicesNamed` finds no Service for it — so it
     * takes the machine branch, takes instance authority on this machine, and is
     * refused. A listing filtered on the label would have offered exactly this
     * id.
     */
    it('refuses the id of a row it dropped for carrying a label that names no Service', async () => {
      const { mallory } = await setUpMalloryWithApp();
      stubDaemon(
        ownerLabels({
          compose: 'my-monitoring',
          name: '/my-monitoring-grafana-1',
        }),
      );

      const stopped = await request(server)
        .post('/docker/containers/ddd444/stop')
        .set('Cookie', mallory.cookie)
        .send({});

      expect(stopped.status).toBe(403);
      expect((stopped.body as { message: string }).message).toBe(
        CONTAINER_DENIAL_MESSAGE,
      );
    });

    /**
     * The no-op half, and the independent check on the assertion above: the same
     * `docker ps` output, read by the instance organization's owner, still
     * carries the sidecar. Mallory's own row is foreign to *them* and drops out
     * by the organization filter, so the two listings are complements rather than one
     * being a subset of the other.
     */
    it("still lists them to the instance organization's owner", async () => {
      const { ownerSession, organizationId } = await setUpMalloryWithApp();
      remoteExec.execAsync.mockResolvedValue(ok(HOST_PS_OUTPUT));

      const containers = await dockerOps.getContainers(
        permissionCtx(ownerSession.id, organizationId),
        {},
      );

      expect(containers?.map((row) => row.name)).toEqual([
        'operators-own-redis',
        'my-monitoring-grafana-1',
      ]);
    });

    /**
     * The other half of ADR-0013's split, on the listing: **a named Server keeps
     * organization authority**. Mallory's Server is a real row in her own
     * Organization, so this cannot pass for want of a check having run.
     */
    it("still lists an unmanaged row on the caller's own Server", async () => {
      const { mallory, malloryCtx } = await setUpMalloryWithApp();
      const malloryServerId = await setUpMalloryServer(mallory);
      remoteExec.execAsyncRemote.mockResolvedValue(ok(HOST_PS_OUTPUT));

      const containers = await dockerOps.getContainers(malloryCtx, {
        serverId: malloryServerId,
      });

      expect(containers?.map((row) => row.name)).toEqual([
        'app-rival.1.abc',
        'operators-own-redis',
        'my-monitoring-grafana-1',
      ]);
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    /**
     * The cost, pinned rather than hidden, on the same precedent the
     * refusal above uses: a licensed custom role granted `docker: ['read']` *in
     * the instance organization* no longer sees the platform host's unmanaged
     * rows either, because `checkInstanceAuthority` reads the static role and
     * nothing else (ADR-0013's third consequence). This is the allowance the
     * write-verb blocks above used to assert, moved here — their listings now
     * name the role's own Server, where machine Docker access really is the
     * whole gate.
     */
    it('omits them from a licensed custom role holding docker read', async () => {
      const { roleCtx, serverId } = await setUpCustomRole({ docker: ['read'] });
      remoteExec.execAsync.mockResolvedValue(ok(PS_OUTPUT));
      remoteExec.execAsyncRemote.mockResolvedValue(ok(PS_OUTPUT));

      await expect(dockerOps.getContainers(roleCtx, {})).resolves.toEqual([]);

      // The same role and the same three rows on a Server its own organization
      // owns: still listed. That pair is what says the boundary is the machine
      // and not the role's `docker` grant.
      const onServer = await dockerOps.getContainers(roleCtx, { serverId });
      expect(onServer?.map((row) => row.name)).toEqual([
        'web-app',
        'cloudgate-monitoring',
      ]);
    });

    /**
     * A base member is not in scope on either half: `memberRole` grants
     * `docker: []`, so the route's own statement gate answers before any of this
     * — asserted so a later reader does not read the narrowing as the thing that
     * refuses them.
     */
    it('refuses a base member the listing on the statement, as it always did', async () => {
      const { ownerSession, organizationId } = await setUpOwnerWithServer();
      const invitee = await signUpMember(server, ownerSession.cookie);
      remoteExec.execAsync.mockResolvedValue(ok(PS_OUTPUT));

      await expect(
        dockerOps.getContainers(permissionCtx(invitee.id, organizationId), {}),
      ).rejects.toThrow(ForbiddenException);
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });
  });

  describe('getContainersByOwnerLabel', () => {
    const shortPs = (label: string, appName: string) =>
      `docker ps -a --filter='label=${label}=${appName}' --format 'CONTAINER ID : {{.ID}} | Name: {{.Names}} | State: {{.State}} | Status: {{.Status}}'`;

    // `my-app`, `my-stack` and `nope` name no Service, so these take
    // the container gate's machine branch, which the instance organization's
    // owner clears on the platform host. Their subject is the command and the
    // parse; the gate is `appName-keyed reads take the container gate` below.
    it('filters the listing by the swarm service label and maps the rows', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(
        ok(
          'CONTAINER ID : abc123 | Name: my-app.1.xyz | State: running | Status: Up 2 hours',
        ),
      );

      const containers = await dockerOps.getContainersByOwnerLabel(ownerCtx, {
        appName: 'my-app',
      });

      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        shortPs('com.docker.swarm.service.name', 'my-app'),
      );
      expect(containers).toEqual([
        {
          containerId: 'abc123',
          name: 'my-app.1.xyz',
          state: 'running',
          status: 'Up 2 hours',
        },
      ]);
    });

    it('filters by compose project label for docker-compose apps', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(ok(''));

      const containers = await dockerOps.getContainersByOwnerLabel(ownerCtx, {
        appName: 'my-stack',
        appType: 'docker-compose',
      });

      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        shortPs('com.docker.compose.project', 'my-stack'),
      );
      expect(containers).toEqual([]);
    });

    it('filters by stack namespace label for a Swarm stack', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(ok(''));

      await dockerOps.getContainersByOwnerLabel(ownerCtx, {
        appName: 'my-stack',
        appType: 'stack',
      });

      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        shortPs('com.docker.stack.namespace', 'my-stack'),
      );
    });

    it('returns [] when docker ran and failed (nonzero exit)', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockRejectedValue(new Error('exit 1'));

      await expect(
        dockerOps.getContainersByOwnerLabel(ownerCtx, { appName: 'nope' }),
      ).resolves.toEqual([]);
    });

    /**
     * H-80, the blank-listing half. `if (stderr || !stdout) return []` is the
     * intended "no containers" guard and it is **one whitespace character**
     * short of doing its job: `!'\n'` is false, so a blank-but-not-empty listing
     * went through the parser as one empty line and came back as one *invented*
     * container — `{ containerId: 'No container id', … }`, a row naming a
     * container that does not exist.
     *
     * The same one-character gap in `getContainers` was H-74's fourth bug. The
     * fix is the same line: drop blank lines instead of trimming the whole
     * buffer.
     */
    it('returns no rows for a listing that is blank rather than absent', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(ok('\n'));

      await expect(
        dockerOps.getContainersByOwnerLabel(ownerCtx, { appName: 'my-app' }),
      ).resolves.toEqual([]);
    });
  });

  describe('getContainersByAppLabel', () => {
    it('filters by the swarm service label', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(
        ok('CONTAINER ID : abc123 | Name: my-app.1.xyz | State: running'),
      );

      const containers = await dockerOps.getContainersByAppLabel(ownerCtx, {
        appName: 'my-app',
        type: 'swarm',
      });

      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        `docker ps --filter "label=com.docker.swarm.service.name=my-app" --format 'CONTAINER ID : {{.ID}} | Name: {{.Names}} | State: {{.State}}'`,
      );
      expect(containers).toEqual([
        { containerId: 'abc123', name: 'my-app.1.xyz', state: 'running' },
      ]);
    });

    it('filters by the exact container name for standalone apps', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(ok(''));

      await dockerOps.getContainersByAppLabel(ownerCtx, {
        appName: 'my-app',
        type: 'standalone',
      });

      // Anchored: Docker's `name` filter is a substring match otherwise.
      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        `docker ps --filter "name=^my-app$" --format 'CONTAINER ID : {{.ID}} | Name: {{.Names}} | State: {{.State}}'`,
      );
    });

    /** H-80's blank-listing half again — `if (!stdout)` misses `'\n'`. */
    it('returns no rows for a listing that is blank rather than absent', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(ok('\n'));

      await expect(
        dockerOps.getContainersByAppLabel(ownerCtx, {
          appName: 'my-app',
          type: 'swarm',
        }),
      ).resolves.toEqual([]);
    });
  });

  describe('stack and service tasks', () => {
    const psLine =
      'CONTAINER ID : task1 | Name: my-app.1 | State: Running | Node: node-a | CurrentState: Running 2 hours ago | Error: task: non-zero exit (1)';
    const expected = [
      {
        containerId: 'task1',
        name: 'my-app.1',
        state: 'running',
        node: 'node-a',
        currentState: 'Running 2 hours ago',
        error: 'task: non-zero exit (1)',
      },
    ];

    it('getStackContainersByAppName lists stack tasks with a lowercased state', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(ok(psLine));

      const tasks = await dockerOps.getStackContainersByAppName(ownerCtx, {
        appName: 'my-app',
      });

      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        "docker stack ps my-app --no-trunc --format 'CONTAINER ID : {{.ID}} | Name: {{.Name}} | State: {{.DesiredState}} | Node: {{.Node}} | CurrentState: {{.CurrentState}} | Error: {{.Error}}'",
      );
      expect(tasks).toEqual(expected);
    });

    it('getServiceContainersByAppName lists service tasks', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      remoteExec.execAsyncRemote.mockResolvedValue(ok(psLine));

      const tasks = await dockerOps.getServiceContainersByAppName(ownerCtx, {
        appName: 'my-app',
        serverId,
      });

      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        serverId,
        "docker service ps my-app --no-trunc --format 'CONTAINER ID : {{.ID}} | Name: {{.Name}} | State: {{.DesiredState}} | Node: {{.Node}} | CurrentState: {{.CurrentState}} | Error: {{.Error}}'",
      );
      expect(tasks).toEqual(expected);
    });

    /**
     * H-80, the live half — and the same mechanism as H-74 one method over.
     *
     * This format's final field is `Error: {{.Error}}`, which renders as
     * `"Error: "` — trailing space, no value — for a task that has not failed,
     * and `stdout.trim()` strips that space off the **final line only**. So the
     * last task's `parts[5]` read `"Error:"`, the unanchored
     * `replace('Error: ', '')` did not match it, and the route reported
     * `error: "Error:"` on a **healthy** task.
     *
     * Why this is the live one rather than a curiosity: the last task is not an
     * edge case. A single-replica service — the default, and what every
     * Application this platform deploys is until someone scales it — has exactly
     * one task, so it is always the final line, so *every* healthy
     * single-replica service reported a task error. `psLine` above carries a
     * genuine error, which is why 111 green tests never saw it.
     *
     * Both listings are asserted because `getTaskList` is the shared body of the
     * two and the bug was in the body, not the vocabulary.
     */
    describe('a healthy task on the last line reports no error (H-80)', () => {
      const psLines = [
        psLine,
        'CONTAINER ID : task2 | Name: my-app.2 | State: Running | Node: node-b | CurrentState: Running 3 hours ago | Error: ',
      ].join('\n');

      const bothTasks = [
        expected[0],
        {
          containerId: 'task2',
          name: 'my-app.2',
          state: 'running',
          node: 'node-b',
          currentState: 'Running 3 hours ago',
          error: '',
        },
      ];

      it('getStackContainersByAppName', async () => {
        const { ownerCtx } = await setUpOwnerWithServer();
        remoteExec.execAsync.mockResolvedValue(ok(`${psLines}\n`));

        const tasks = await dockerOps.getStackContainersByAppName(ownerCtx, {
          appName: 'my-app',
        });

        expect(tasks[1].error).toBe('');
        expect(tasks).toEqual(bothTasks);
      });

      it('getServiceContainersByAppName', async () => {
        const { ownerCtx, serverId } = await setUpOwnerWithServer();
        remoteExec.execAsyncRemote.mockResolvedValue(ok(`${psLines}\n`));

        const tasks = await dockerOps.getServiceContainersByAppName(ownerCtx, {
          appName: 'my-app',
          serverId,
        });

        expect(tasks[1].error).toBe('');
        expect(tasks).toEqual(bothTasks);
      });

      /**
       * The single-replica shape stated on its own, because it is the common
       * one: one task, last by definition, healthy.
       */
      it('a single-replica service reports no error at all', async () => {
        const { ownerCtx } = await setUpOwnerWithServer();
        remoteExec.execAsync.mockResolvedValue(
          ok(
            'CONTAINER ID : task9 | Name: solo.1 | State: Running | Node: node-a | CurrentState: Running 5 minutes ago | Error: \n',
          ),
        );

        const tasks = await dockerOps.getStackContainersByAppName(ownerCtx, {
          appName: 'solo',
        });

        expect(tasks).toEqual([
          {
            containerId: 'task9',
            name: 'solo.1',
            state: 'running',
            node: 'node-a',
            currentState: 'Running 5 minutes ago',
            error: '',
          },
        ]);
      });
    });

    /**
     * H-81. `Error: {{.Error}}` is the one field in this module whose value is
     * **free text from the container runtime** rather than a docker object name,
     * so it is the one field that can contain the ` | ` the parser splits on.
     * `parts[5]` therefore truncated the message at the first separator and
     * discarded the rest — worst at exactly the moment someone is reading it.
     *
     * `parts.slice(5).join(' | ')` is a complete fix **because `Error` is the
     * last field**: everything after index 5 belongs to it by construction, so
     * the value is rejoined rather than guessed at. No `--format` separator
     * change is needed, which is the expensive version of this fix.
     *
     * `currentState` is asserted alongside it deliberately: it sits immediately
     * before `Error`, so if the split had shifted the fields rather than
     * truncating the last one, this is the assertion that would catch it.
     */
    it('keeps a task error that contains the field separator', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      const runtimeError =
        'starting container failed: exec: "sh -c a | b": no such file';
      remoteExec.execAsync.mockResolvedValue(
        ok(
          'CONTAINER ID : t1 | Name: a.1 | State: Shutdown | Node: node-a | ' +
            `CurrentState: Failed 2 minutes ago | Error: ${runtimeError}\n`,
        ),
      );

      const tasks = await dockerOps.getStackContainersByAppName(ownerCtx, {
        appName: 'a',
      });

      expect(tasks[0].error).toBe(runtimeError);
      expect(tasks[0].currentState).toBe('Failed 2 minutes ago');
      expect(tasks[0].node).toBe('node-a');
    });

    /** H-80's blank-listing half — `if (stderr || !stdout)` misses `'\n'`. */
    it('returns no tasks for a listing that is blank rather than absent', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(ok('\n'));

      await expect(
        dockerOps.getStackContainersByAppName(ownerCtx, { appName: 'my-app' }),
      ).resolves.toEqual([]);
    });
  });

  /**
   * `containers/search`, `by-label`, `stack` and `service` answer by a
   * Service's `appName`, and asked only for an organization statement and
   * `ownedServerId` — which answers the platform host for an absent
   * `serverId`. So a base member of any organization listed every
   * organization's containers on the shared host by name prefix, and an owner
   * of one read another's Swarm tasks. They now take the container gate
   * (`ContainerAccessService.authorizeAppName`, ADR-0008) before any exec.
   */
  describe('appName-keyed reads take the container gate', () => {
    const SEARCH_PS = (label: string, appName: string) =>
      `docker ps -a --filter='label=${label}=${appName}' --format 'CONTAINER ID : {{.ID}} | Name: {{.Names}} | State: {{.State}} | Status: {{.Status}}'`;

    /** A Project, an Environment and one Application per `appName`. */
    async function createApplications(
      creator: Ctx,
      projectName: string,
      appNames: string[],
    ) {
      const project = await projects.create(creator, { name: projectName });
      const environment = await environments.create(creator, {
        name: 'production',
        projectId: project.projectId,
        deployTarget: { kind: 'platform-host' },
      });
      const created: Awaited<ReturnType<ApplicationsService['create']>>[] = [];
      for (const appName of appNames) {
        created.push(
          await applications.create(creator, {
            name: appName,
            appName,
            environmentId: environment.environmentId,
          }),
        );
      }
      return created;
    }

    /**
     * The instance owner with Services `app-a` and `app-b`; a base member of
     * the same organization entitled to `app-a` alone; and Mallory, owner of a
     * second organization, with `app-c`.
     */
    async function setUpEntitlements() {
      const { ownerSession, ownerCtx, organizationId } =
        await setUpOwnerWithServer();
      const [appA] = await createApplications(ownerCtx, 'shop', [
        'app-a',
        'app-b',
      ]);

      const invitee = await signUpMember(server, ownerSession.cookie);
      await ctx.db
        .update(member)
        .set({ accessedServices: [appA.applicationId] })
        .where(
          and(
            eq(member.userId, invitee.id),
            eq(member.organizationId, organizationId),
          ),
        );

      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerSession.cookie,
      );
      await createApplications(
        permissionCtx(mallory.id, mallory.organizationId),
        'rival',
        ['app-c'],
      );

      return { ownerSession, memberCookie: invitee.cookie, mallory };
    }

    /** A refusal's body less the two fields that vary with the request. */
    const refusalBody = (res: request.Response) => {
      const body = { ...(res.body as Record<string, unknown>) };
      delete body.path;
      delete body.timestamp;
      return JSON.stringify(body);
    };

    it("answers a member's search for the Service they are entitled to, by its swarm label", async () => {
      const { memberCookie } = await setUpEntitlements();
      remoteExec.execAsync.mockResolvedValue(
        ok(
          'CONTAINER ID : abc123 | Name: app-a.1.xyz | State: running | Status: Up 2 hours',
        ),
      );

      const res = await request(server)
        .get('/docker/containers/search')
        .query({ appName: 'app-a' })
        .set('Cookie', memberCookie);

      expect(res.status).toBe(200);
      expect((res.body as { name: string }[]).map((c) => c.name)).toEqual([
        'app-a.1.xyz',
      ]);
      expect(remoteExec.execAsync.mock.calls.map(([c]) => c)).toEqual([
        SEARCH_PS('com.docker.swarm.service.name', 'app-a'),
      ]);
    });

    it('refuses a member every other name with one byte-identical body, and runs nothing', async () => {
      const { memberCookie } = await setUpEntitlements();
      remoteExec.execAsync.mockResolvedValue(ok(''));

      // Not entitled, another organization's on the platform host, unmanaged
      // without machine access (a base member holds `docker: []`), and the
      // platform's own.
      const refused: request.Response[] = [];
      for (const appName of [
        'app-b',
        'app-c',
        'operator-sidecar',
        'cloudgate-traefik',
      ]) {
        refused.push(
          await request(server)
            .get('/docker/containers/search')
            .query({ appName })
            .set('Cookie', memberCookie),
        );
      }

      for (const res of refused) {
        expect(res.status).toBe(403);
        expect((res.body as { message: string }).message).toBe(
          CONTAINER_DENIAL_MESSAGE,
        );
        expect(refusalBody(res)).toBe(refusalBody(refused[0]));
      }
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it("refuses the instance owner the platform's own name, and still answers an unmanaged one", async () => {
      const { ownerSession } = await setUpEntitlements();
      remoteExec.execAsync.mockResolvedValue(ok(''));

      const platform = await request(server)
        .get('/docker/containers/search')
        .query({ appName: 'cloudgate-traefik' })
        .set('Cookie', ownerSession.cookie);
      const foreign = await request(server)
        .get('/docker/containers/search')
        .query({ appName: 'app-c' })
        .set('Cookie', ownerSession.cookie);
      const unmanaged = await request(server)
        .get('/docker/containers/search')
        .query({ appName: 'operator-sidecar' })
        .set('Cookie', ownerSession.cookie);

      expect(platform.status).toBe(403);
      expect(refusalBody(platform)).toBe(refusalBody(foreign));
      expect(unmanaged.status).toBe(200);
      expect(remoteExec.execAsync.mock.calls.map(([c]) => c)).toEqual([
        SEARCH_PS('com.docker.swarm.service.name', 'operator-sidecar'),
      ]);
    });

    const ownerRoutes = [
      ['by-label', { appName: 'app-a', type: 'swarm' }],
      ['stack', { appName: 'app-a' }],
      ['service', { appName: 'app-a' }],
    ] as const;

    it.each(ownerRoutes)(
      "refuses another organization's owner the %s route for this organization's appName",
      async (route, query) => {
        const { mallory, memberCookie } = await setUpEntitlements();
        remoteExec.execAsync.mockResolvedValue(ok(''));

        const denied = await request(server)
          .get(`/docker/containers/${route}`)
          .query(query)
          .set('Cookie', mallory.cookie);
        // The same refusal a member gets from the search for a name they are
        // not entitled to — one sentence across routes, not only within one.
        const reference = await request(server)
          .get('/docker/containers/search')
          .query({ appName: 'app-b' })
          .set('Cookie', memberCookie);

        expect(denied.status).toBe(403);
        expect(refusalBody(denied)).toBe(refusalBody(reference));
        expect(remoteExec.execAsync).not.toHaveBeenCalled();
      },
    );

    it.each(ownerRoutes)(
      'still answers the %s route to the Service’s own organization',
      async (route, query) => {
        const { ownerSession } = await setUpEntitlements();
        remoteExec.execAsync.mockResolvedValue(ok(''));

        const res = await request(server)
          .get(`/docker/containers/${route}`)
          .query(query)
          .set('Cookie', ownerSession.cookie);

        expect(res.status).toBe(200);
        expect(remoteExec.execAsync).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('uploadFileToContainer', () => {
    it('pipes the base64 payload through docker cp into the container', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      stubDaemon(ownerLabels());

      await dockerOps.uploadFileToContainer(
        ownerCtx,
        { containerId: 'abc123', destinationPath: 'etc/app/config.json' },
        Buffer.from('{"hello":"world"}'),
        'config.json',
      );

      // Call 0 is the ownership gate; the copy is what follows it.
      expect(remoteExec.execAsync.mock.calls[0][0]).toBe(
        INSPECT_COMMAND('abc123'),
      );
      const command = remoteExec.execAsync.mock.calls[1][0];
      // The payload travels base64-encoded and lands at the destination with
      // a leading slash added; the temp file is removed afterwards.
      expect(command).toContain(
        `echo '${Buffer.from('{"hello":"world"}').toString('base64')}' | base64 -d > "/tmp/cloudgate-upload-`,
      );
      expect(command).toContain('docker cp "/tmp/cloudgate-upload-');
      expect(command).toContain('"abc123:/etc/app/config.json"');
      expect(command).toContain('rm -f "/tmp/cloudgate-upload-');
      // The cleanup runs unconditionally and the *copy's* status is what the
      // command exits with — see the two exit-status tests below.
      expect(command).toContain('; rc=$?; rm -f "/tmp/cloudgate-upload-');
      expect(command).toMatch(/; exit \$rc$/);
    });

    /**
     * The command's exit status is `docker cp`'s, read by running the command.
     *
     * The `;` before `rm -f` used to make the compound command's status **`rm`'s**
     * — always 0 — so a failed `docker cp` was discarded, the `try/catch` around
     * `this.exec` never fired, and the route answered
     * `200 {"success":true,"message":"File uploaded successfully"}` for an upload
     * that wrote nothing. Proven on a live box against a destination whose parent
     * directory does not exist; pinned here with a fake `docker` that fails.
     *
     * The two constraints this states together: the failure must **surface**, and
     * the temp file must **still be removed** on the failure path — fixing the
     * status by dropping the cleanup would leave the payload in `/tmp` on every
     * failed upload.
     */
    it('surfaces a failed docker cp instead of reporting success, and still removes the temp file', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      const shell = stubRealShell(ownerLabels(), 1);

      await expect(
        dockerOps.uploadFileToContainer(
          ownerCtx,
          { containerId: 'abc123', destinationPath: '/nodir/deeper/x.txt' },
          Buffer.from('upload-marker'),
          'x.txt',
        ),
      ).rejects.toThrow('Failed to upload file to container');

      // The copy was really attempted, with the decoded payload as its source.
      expect(shell.argv()).toContain('abc123:/nodir/deeper/x.txt');
      expect(shell.copied()).toBe('upload-marker');
      // …and the temp file is gone even though the command failed.
      expect(existsSync(shell.tempPath())).toBe(false);
    });

    /** The allowing direction of the same run: a `docker cp` that exits 0. */
    it('resolves, and removes the temp file, when docker cp succeeds', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      const shell = stubRealShell(ownerLabels(), 0);

      await expect(
        dockerOps.uploadFileToContainer(
          ownerCtx,
          { containerId: 'abc123', destinationPath: '/etc/app/config.json' },
          Buffer.from('{"hello":"world"}'),
          'config.json',
        ),
      ).resolves.toBeUndefined();

      expect(shell.copied()).toBe('{"hello":"world"}');
      expect(existsSync(shell.tempPath())).toBe(false);
    });

    it('rejects container ids and destination paths with shell metacharacters', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();

      await expect(
        dockerOps.uploadFileToContainer(
          ownerCtx,
          { containerId: 'abc; rm -rf /', destinationPath: '/etc' },
          Buffer.from('x'),
          'f',
        ),
      ).rejects.toThrow('Invalid container ID');

      await expect(
        dockerOps.uploadFileToContainer(
          ownerCtx,
          { containerId: 'abc123', destinationPath: '/etc; rm -rf /' },
          Buffer.from('x'),
          'f',
        ),
      ).rejects.toThrow(
        'Invalid destination path: shell metacharacters are not allowed',
      );
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });
  });

  /**
   * Two organizations sharing one host.
   *
   * The host is the **platform host** — no `serverId` — where `checkServerAccess`
   * returns undefined by design (ADR-0008's documented contract), so the only
   * gate left on every route here was `docker: ['read']`: an organization-level
   * capability that says nothing about which container is being addressed. That
   * is the listing's disclosure and the routes' `docker rm -f`, and they are asserted
   * together because the listing hands out the ids the routes act on.
   *
   * Both organizations belong to the **same owner**: a second
   * `/api/auth/sign-up/email` in one e2e run answers 400, and an invited member
   * cannot create an organization because `organizations.create` gates on the
   * caller's *instance* role. That is also what makes these assertions sharp —
   * the caller holds `docker:read` in both, so the only thing separating org1's
   * containers from org2's is the Service its labels resolve to.
   *
   * Every fixture here is a **real row** — Project, Environment, Application,
   * Server. A `serverId: 'server-1'` with nothing behind it (the shape
   * `test/destinations` uses) cannot tell a passing organization check from one
   * that never ran, because a nonexistent id fails the lookup either way.
   */
  describe('cross-org isolation', () => {
    /** A Project, an Environment and one Application carrying `appName`. */
    async function createApplication(
      ctx: Ctx,
      projectName: string,
      appName: string,
    ) {
      const project = await projects.create(ctx, { name: projectName });
      const environment = await environments.create(ctx, {
        name: 'production',
        projectId: project.projectId,
        deployTarget: { kind: 'platform-host' },
      });
      return applications.create(ctx, {
        name: appName,
        appName,
        environmentId: environment.environmentId,
      });
    }

    async function setUpTwoOrganizations() {
      const {
        ownerSession,
        ownerCtx: orgOneCtx,
        serverId,
      } = await setUpOwnerWithServer();
      const orgOneApp = await createApplication(orgOneCtx, 'shop', 'app-org1');

      const second = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const orgTwoCtx = permissionCtx(
        ownerSession.id,
        (second.body as { id: string }).id,
      );
      await createApplication(orgTwoCtx, 'rival', 'app-org2');

      return { ownerSession, orgOneCtx, orgTwoCtx, serverId, orgOneApp };
    }

    /** The container every route below is pointed at, on the platform host. */
    const CONTAINER = { containerId: 'abc123' };

    /**
     * The seven container-addressed routes, each as the one call the
     * controller makes. All seven are asserted rather than sampled: `docker rm
     * -f` and `docker cp` destroy and write, and the five lifecycle verbs share
     * one body, so a per-route table is what proves the gate is not on four of
     * them.
     */
    const routes: [string, (ctx: Ctx) => Promise<unknown>][] = [
      ['getConfig', (ctx) => dockerOps.getConfig(ctx, CONTAINER)],
      ['restartContainer', (ctx) => dockerOps.restartContainer(ctx, CONTAINER)],
      ['startContainer', (ctx) => dockerOps.startContainer(ctx, CONTAINER)],
      ['stopContainer', (ctx) => dockerOps.stopContainer(ctx, CONTAINER)],
      ['killContainer', (ctx) => dockerOps.killContainer(ctx, CONTAINER)],
      ['removeContainer', (ctx) => dockerOps.removeContainer(ctx, CONTAINER)],
      [
        'uploadFileToContainer',
        (ctx) =>
          dockerOps.uploadFileToContainer(
            ctx,
            { ...CONTAINER, destinationPath: '/etc/app/config.json' },
            Buffer.from('pwned'),
            'config.json',
          ),
      ],
    ];

    it.each(routes)(
      "%s refuses a container owned by another organization's service",
      async (_name, call) => {
        const { orgOneCtx } = await setUpTwoOrganizations();
        stubDaemon(ownerLabels({ swarm: 'app-org2' }));

        await expect(call(orgOneCtx)).rejects.toThrow(ForbiddenException);

        // Nothing was inspected, stopped, removed or written to on the way to
        // being refused: the gate's own inspect is the only command issued.
        expect(remoteExec.execAsync.mock.calls.map(([c]) => c)).toEqual([
          INSPECT_COMMAND('abc123'),
        ]);
      },
    );

    it.each(routes)(
      "%s still reaches this organization's own container",
      async (_name, call) => {
        const { orgOneCtx } = await setUpTwoOrganizations();
        stubDaemon(ownerLabels({ swarm: 'app-org1' }), ok('{}'));

        await call(orgOneCtx);

        // The gate's inspect, then the route's own command.
        expect(remoteExec.execAsync).toHaveBeenCalledTimes(2);
      },
    );

    it.each(routes)(
      '%s still reaches an unmanaged container',
      async (_name, call) => {
        // Traefik, the platform's own, anything an operator started by hand:
        // no owner label resolves, so machine-level Docker access governs it
        // (CONTEXT.md, ADR-0008).
        //
        // Still green after the fix, and the reason is the caller rather than the
        // branch: `orgOneCtx` is the *first* signed-up user's bootstrap
        // Organization, which is the instance organization, so the instance
        // authority the platform-host branch now also asks for is held. The
        // caller who is refused is Mallory, in
        // `an unmanaged container on the platform host` above.
        const { orgOneCtx } = await setUpTwoOrganizations();
        stubDaemon(ownerLabels(), ok('{}'));

        await call(orgOneCtx);

        expect(remoteExec.execAsync).toHaveBeenCalledTimes(2);
      },
    );

    /**
     * The byte-identical denial's REST half, on the surface it is actually
     * reachable from. Both answers are already 403, so nothing is *authorized*
     * that should not be — what is closed is that a caller could tell which
     * container ids exist on a shared host and which of them are managed by someone else.
     *
     * Compared to each other rather than to a literal: the property is
     * indistinguishability.
     */
    it('answers a foreign container and a nonexistent one with the same body', async () => {
      const { orgOneCtx } = await setUpTwoOrganizations();

      stubDaemon(ownerLabels({ swarm: 'app-org2' }));
      const foreign = await dockerOps
        .getConfig(orgOneCtx, CONTAINER)
        .catch((error: Error) => error);

      remoteExec.execAsync.mockRejectedValue(
        new Error('Error: No such container: deadbeef1234'),
      );
      const nonexistent = await dockerOps
        .getConfig(orgOneCtx, { containerId: 'deadbeef1234' })
        .catch((error: Error) => error);

      expect((foreign as Error).message).toBe((nonexistent as Error).message);
      expect((foreign as Error).message).toBe(CONTAINER_DENIAL_MESSAGE);
    });

    /**
     * The byte-identical denial, re-pinned against the split the machine arm
     * makes — and this is the assertion the security review turns on.
     *
     * The three answers side by side: on a Server that **answered**, a
     * container owned by another organization and an id that does not exist
     * are still byte-identical 403s, and only a Server that answered **nothing
     * at all** gets a different frame. The enumeration oracle that denial closed stays
     * closed, because the new arm is decided before any resolution runs — no id
     * was looked up and no owner label was read, so it discloses nothing about
     * whether this container exists or who owns it. A fix that widened the
     * denial itself, rather than answering ahead of it, fails the first two
     * expectations here.
     */
    it('keeps a foreign container and an unknown one identical, and only a Server that never answered apart', async () => {
      const { orgOneCtx, serverId } = await setUpTwoOrganizations();
      const ask = (): Promise<unknown> =>
        dockerOps.getConfig(orgOneCtx, { containerId: 'abc123', serverId });

      // Reachable, and the container belongs to the other organization.
      stubDaemon(ownerLabels({ swarm: 'app-org2' }));
      const foreign = (await ask().catch((error: Error) => error)) as Error;

      // Reachable, and there is no such container: `docker inspect` ran and
      // said so, which is a rejection carrying an exit code.
      remoteExec.execAsyncRemote.mockRejectedValue(
        new ExecError('Remote command failed with exit code 1', {
          command: 'docker inspect',
          serverId,
          exitCode: 1,
          stderr: 'Error: No such container: abc123',
        }),
      );
      const unknown = (await ask().catch((error: Error) => error)) as Error;

      // Never reached: no shell ran, so there is no exit code to carry.
      remoteExec.execAsyncRemote.mockRejectedValue(
        new ExecError('SSH connection error: connect ECONNREFUSED', {
          command: 'docker inspect',
          serverId,
        }),
      );
      const neverReached = (await ask().catch(
        (error: Error) => error,
      )) as HttpException;

      // Compared to each other rather than to a literal: the property is
      // indistinguishability.
      expect(foreign.message).toBe(unknown.message);
      expect(foreign.message).toBe(CONTAINER_DENIAL_MESSAGE);
      expect(foreign).toBeInstanceOf(ForbiddenException);
      expect(unknown).toBeInstanceOf(ForbiddenException);

      // And the one that is deliberately different, named rather than merely
      // not-403 so a future edit cannot satisfy this by inventing a third
      // refusal.
      expect(neverReached.getStatus()).toBe(503);
      expect(
        (neverReached.getResponse() as { code?: string; message?: string })
          .code,
      ).toBe(HOST_UNREACHABLE_CODE);
      expect(neverReached.message).not.toBe(CONTAINER_DENIAL_MESSAGE);
    });

    /**
     * `cloudgate-traefik` was in nobody's listing and reachable by id from
     * every organization, because it carries no labels at all and so took the
     * unmanaged branch. The `DELETE` is the one that matters: the VPS run
     * deliberately did not press it against a live ingress, and a test is where
     * it can be pressed safely.
     *
     * An **owner** ctx, so the old code would have passed — and the refusal is
     * byte-identical with what a foreign container gets, so the routes do not
     * become an oracle for which containers are the platform's.
     */
    it.each(routes)(
      "%s refuses the platform's own Traefik, as it refuses a foreign container",
      async (_name, call) => {
        const { orgOneCtx } = await setUpTwoOrganizations();
        stubDaemon(
          ownerLabels({ name: '/cloudgate-traefik' }),
          ok('{"Id":"9ba49dc3087c"}'),
        );

        await expect(call(orgOneCtx)).rejects.toThrow(CONTAINER_DENIAL_MESSAGE);

        // Nothing was inspected, stopped, removed or written to on the way to
        // being refused: the gate's own inspect is the only command issued.
        expect(remoteExec.execAsync.mock.calls.map(([c]) => c)).toEqual([
          INSPECT_COMMAND('abc123'),
        ]);
      },
    );

    it('still reaches cloudgate-monitoring, which the operator manages', async () => {
      const { orgOneCtx } = await setUpTwoOrganizations();
      stubDaemon(ownerLabels({ name: '/cloudgate-monitoring' }), ok('{}'));

      await dockerOps.getConfig(orgOneCtx, CONTAINER);

      expect(remoteExec.execAsync).toHaveBeenCalledTimes(2);
    });

    it("refuses another organization's server before inspecting anything", async () => {
      const { orgTwoCtx, serverId } = await setUpTwoOrganizations();

      // The remote path is unchanged: `checkServerAccess` already scopes a
      // supplied id to the caller's organization, and answers NotFound so a
      // caller who may not see the fleet learns nothing about which ids exist.
      await expect(
        dockerOps.stopContainer(orgTwoCtx, {
          containerId: 'abc123',
          serverId,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it('reads the owner labels on the server being addressed, not locally', async () => {
      const { orgOneCtx, serverId } = await setUpTwoOrganizations();
      stubDaemon(ownerLabels({ swarm: 'app-org2' }));

      await expect(
        dockerOps.stopContainer(orgOneCtx, { containerId: 'abc123', serverId }),
      ).rejects.toThrow(ForbiddenException);

      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        serverId,
        INSPECT_COMMAND('abc123'),
      );
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    /** org1's own, org2's, and one container no Service in the instance claims. */
    const MIXED_PS_OUTPUT = [
      psRow(
        'CONTAINER ID : aaa111 | Name: app-org1.1.abc | Image: app-org1:latest | Ports:  | State: running | Status: Up 2 hours',
        { swarm: 'app-org1' },
      ),
      psRow(
        'CONTAINER ID : bbb222 | Name: app-org2.1.def | Image: traefik/whoami:latest | Ports: 0.0.0.0:8080->80/tcp | State: running | Status: Up 2 hours',
        { swarm: 'app-org2' },
      ),
      psRow(
        'CONTAINER ID : ccc333 | Name: operators-own-redis | Image: redis:7 | Ports:  | State: running | Status: Up 9 days',
      ),
    ].join('\n');

    it("omits a container whose swarm service label names another organization's service", async () => {
      const { orgOneCtx } = await setUpTwoOrganizations();
      remoteExec.execAsync.mockResolvedValue(ok(MIXED_PS_OUTPUT));

      const containers = await dockerOps.getContainers(orgOneCtx, {});

      // org2's row is gone; the caller's own and the unmanaged one stay, and the
      // fields the console renders are untouched.
      expect(containers).toEqual([
        {
          containerId: 'aaa111',
          name: 'app-org1.1.abc',
          image: 'app-org1:latest',
          ports: '',
          state: 'running',
          status: 'Up 2 hours',
          serverId: undefined,
        },
        {
          containerId: 'ccc333',
          name: 'operators-own-redis',
          image: 'redis:7',
          ports: '',
          state: 'running',
          status: 'Up 9 days',
          serverId: undefined,
        },
      ]);
      // One `docker ps` for the whole listing: the resolution is a batched
      // database read, never a `docker inspect` per row.
      expect(remoteExec.execAsync).toHaveBeenCalledTimes(1);
    });

    it('hides each organization from the other on the same host', async () => {
      const { orgTwoCtx } = await setUpTwoOrganizations();
      remoteExec.execAsync.mockResolvedValue(ok(MIXED_PS_OUTPUT));

      const containers = await dockerOps.getContainers(orgTwoCtx, {});

      expect(containers?.map((row) => row.name)).toEqual([
        'app-org2.1.def',
        'operators-own-redis',
      ]);
    });

    it('keeps an unmanaged container that matches no service row', async () => {
      const { orgOneCtx } = await setUpTwoOrganizations();
      remoteExec.execAsync.mockResolvedValue(
        ok(
          psRow(
            'CONTAINER ID : ddd444 | Name: whoami | Image: traefik/whoami | Ports:  | State: running | Status: Up 1 hour',
            { compose: 'a-project-cloudgate-never-heard-of' },
          ),
        ),
      );

      const containers = await dockerOps.getContainers(orgOneCtx, {});

      expect(containers?.map((row) => row.name)).toEqual(['whoami']);
    });

    it("lists a preview deployment's container to its parent Application's organization", async () => {
      const { orgOneCtx, orgOneApp } = await setUpTwoOrganizations();
      await ctx.db.insert(previewDeployment).values({
        appName: 'preview-app-org1-pr1',
        applicationId: orgOneApp.applicationId,
        branch: 'feature/x',
        pullRequestId: '1',
        pullRequestNumber: '1',
        pullRequestTitle: 'Add a thing',
        pullRequestURL: 'https://example.com/pr/1',
        domain: 'preview-app-org1-pr1.example.com',
      });
      remoteExec.execAsync.mockResolvedValue(
        ok(
          psRow(
            'CONTAINER ID : eee555 | Name: preview-app-org1-pr1.1.ghi | Image: app-org1:pr1 | Ports:  | State: running | Status: Up 3 minutes',
            { swarm: 'preview-app-org1-pr1' },
          ),
        ),
      );

      // A preview's appName lives in its own table, not among the eight, and its
      // entitlement is the parent Application's — resolving it as unmanaged
      // would be the right answer for the wrong reason.
      const containers = await dockerOps.getContainers(orgOneCtx, {});

      expect(containers?.map((row) => row.name)).toEqual([
        'preview-app-org1-pr1.1.ghi',
      ]);
    });

    it("hides a preview deployment's container from the other organization", async () => {
      const { orgTwoCtx, orgOneApp } = await setUpTwoOrganizations();
      await ctx.db.insert(previewDeployment).values({
        appName: 'preview-app-org1-pr1',
        applicationId: orgOneApp.applicationId,
        branch: 'feature/x',
        pullRequestId: '1',
        pullRequestNumber: '1',
        pullRequestTitle: 'Add a thing',
        pullRequestURL: 'https://example.com/pr/1',
        domain: 'preview-app-org1-pr1.example.com',
      });
      remoteExec.execAsync.mockResolvedValue(
        ok(
          psRow(
            'CONTAINER ID : eee555 | Name: preview-app-org1-pr1.1.ghi | Image: app-org1:pr1 | Ports:  | State: running | Status: Up 3 minutes',
            { swarm: 'preview-app-org1-pr1' },
          ),
        ),
      );

      await expect(dockerOps.getContainers(orgTwoCtx, {})).resolves.toEqual([]);
    });

    it('drops a stack container by its namespace label alone', async () => {
      const { orgOneCtx } = await setUpTwoOrganizations();
      // A compose row deployed as a Swarm stack carries the namespace and a
      // swarm service name of `${appName}_${serviceName}`, which matches no
      // Service row — so the namespace is the only label that can resolve it.
      // Omitting it from the format string would read as unmanaged and leak.
      remoteExec.execAsync.mockResolvedValue(
        ok(
          psRow(
            'CONTAINER ID : fff666 | Name: app-org2_web.1.jkl | Image: nginx | Ports:  | State: running | Status: Up 1 day',
            { swarm: 'app-org2_web', stack: 'app-org2' },
          ),
        ),
      );

      await expect(dockerOps.getContainers(orgOneCtx, {})).resolves.toEqual([]);
    });
  });

  describe('swarm', () => {
    it('getSwarmNodes parses the node ls JSON lines', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(
        ok(
          '{"ID":"node1","Hostname":"manager-1","ManagerStatus":"Leader"}\n' +
            '{"ID":"node2","Hostname":"worker-1","ManagerStatus":""}',
        ),
      );

      const nodes = await swarm.getSwarmNodes(ownerCtx, {});

      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        "docker node ls --format '{{json .}}'",
      );
      expect(nodes).toEqual([
        { ID: 'node1', Hostname: 'manager-1', ManagerStatus: 'Leader' },
        { ID: 'node2', Hostname: 'worker-1', ManagerStatus: '' },
      ]);
    });

    it('getNodeInfo inspects one node', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      const info = { ID: 'node1', Spec: { Role: 'manager' } };
      remoteExec.execAsyncRemote.mockResolvedValue(ok(JSON.stringify(info)));

      const result = await swarm.getNodeInfo(ownerCtx, {
        nodeId: 'node1',
        serverId,
      });

      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        serverId,
        "docker node inspect node1 --format '{{json .}}'",
      );
      expect(result).toEqual(info);
    });

    /**
     * The service half of the `nodeId` fix. `NodeIdParamsDto` refuses
     * anything outside `containerIdRegex`, so no route delivers this payload —
     * which is exactly why the assertion is made on the service: the quoting
     * here is the defence in depth `builders/build-strategy.ts` asks every
     * interpolation site for, and a test that could only reach it through the
     * DTO would be pinning the DTO twice over instead. The 400 is pinned
     * separately, under `HTTP surface`.
     */
    it('getNodeInfo quotes a nodeId carrying a metacharacter', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(ok('{}'));

      await swarm.getNodeInfo(ownerCtx, { nodeId: SHELL_PAYLOAD });

      expectQuotedInCommand(
        remoteExec.execAsync.mock.calls[0][0],
        SHELL_PAYLOAD,
      );
    });

    it('getNodeApplications lists services hiding the platform ones', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(
        ok(
          '{"ID":"svc1","Name":"my-app","Replicas":"1/1"}\n' +
            '{"ID":"svc2","Name":"cloudgate-traefik","Replicas":"1/1"}',
        ),
      );

      const apps = await swarm.getNodeApplications(ownerCtx, {});

      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        "docker service ls --format '{{json .}}'",
      );
      // Services prefixed with "cloudgate-" are hidden.
      expect(apps).toEqual([{ ID: 'svc1', Name: 'my-app', Replicas: '1/1' }]);
    });

    /**
     * The write-verb scoping's sibling, the same shape the hide closed for
     * containers: the listing hid `cloudgate-` services from
     * `getNodeApplications` while nothing refused *acting* on one by name, so
     * `getApplicationInfo` handed back the platform's own ingress tasks to any
     * caller holding `server: ['read']`.
     *
     * An **owner** ctx throughout, because the owner is the caller the old code
     * allowed — a plain member never reaches these routes at all, so a member
     * fixture could not tell the new refusal from the old one.
     */
    it('getApplicationInfo refuses a swarm service this instance runs for itself', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();

      await expect(
        swarm.getApplicationInfo(ownerCtx, {
          appNames: ['cloudgate-traefik'],
        }),
      ).rejects.toThrow(CONTAINER_DENIAL_MESSAGE);
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it("getApplicationInfo refuses the whole request when one name among several is the platform's own", async () => {
      const { ownerCtx } = await setUpOwnerWithServer();

      await expect(
        swarm.getApplicationInfo(ownerCtx, {
          appNames: ['my-app', 'cloudgate-backend'],
        }),
      ).rejects.toThrow(CONTAINER_DENIAL_MESSAGE);
      // `docker service ps` takes every name in one command, so there is no
      // partial answer to give: nothing was asked about my-app either.
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it.each([
      'cloudgate-trace-store-application-web',
      'cloudgate-trace-store-compose-cloudgate-monitoring',
    ])('getApplicationInfo refuses the Trace store %s', async (appName) => {
      const { ownerCtx } = await setUpOwnerWithServer();

      await expect(
        swarm.getApplicationInfo(ownerCtx, { appNames: [appName] }),
      ).rejects.toThrow(CONTAINER_DENIAL_MESSAGE);
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it('getApplicationInfo still asks about cloudgate-monitoring, which the operator manages', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(
        ok('{"ID":"task1","Name":"cloudgate-monitoring.1"}'),
      );

      await expect(
        swarm.getApplicationInfo(ownerCtx, {
          appNames: ['cloudgate-monitoring'],
        }),
      ).resolves.toEqual([{ ID: 'task1', Name: 'cloudgate-monitoring.1' }]);
    });

    /**
     * The listing and the acting now read the same predicate, which moves two
     * rows in the listing's answer. Both are stated rather than left to be
     * discovered:
     *
     * - `cloudgate-monitoring` was hidden by the old `startsWith('cloudgate-')`
     *   and is not the platform's own — CONTEXT.md carves it out as a thing the
     *   operator sets up and manages from the console — so it now appears, and
     *   the route above answers for it.
     * - a service whose name merely *carries* `cloudgate` is now hidden and
     *   refused where the prefix test let it through. That is the cost of one
     *   predicate rather than two, and it is deliberate: `isPlatformContainerName`
     *   is a rule rather than a list precisely so a container the platform gains
     *   later is refused by default. Unlike the container path there is no
     *   Service resolution here to confine it to an unowned name — see
     *   `swarm.service.ts`.
     */
    it('getNodeApplications lists cloudgate-monitoring and hides any other name carrying cloudgate', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(
        ok(
          '{"ID":"svc1","Name":"my-app","Replicas":"1/1"}\n' +
            '{"ID":"svc2","Name":"cloudgate-monitoring","Replicas":"1/1"}\n' +
            '{"ID":"svc3","Name":"my-cloudgate-api","Replicas":"1/1"}',
        ),
      );

      const apps = await swarm.getNodeApplications(ownerCtx, {});

      expect(apps).toEqual([
        { ID: 'svc1', Name: 'my-app', Replicas: '1/1' },
        { ID: 'svc2', Name: 'cloudgate-monitoring', Replicas: '1/1' },
      ]);
    });

    it('getApplicationInfo asks docker service ps for all names at once', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(
        ok('{"ID":"task1","Name":"my-app.1"}\n{"ID":"task2","Name":"other.1"}'),
      );

      const infos = await swarm.getApplicationInfo(ownerCtx, {
        appNames: ['my-app', 'other'],
      });

      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        "docker service ps my-app other --format '{{json .}}' --no-trunc",
      );
      expect(infos).toEqual([
        { ID: 'task1', Name: 'my-app.1' },
        { ID: 'task2', Name: 'other.1' },
      ]);
    });

    it('getApplicationInfo answers [] for no names without shelling out', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();

      await expect(
        swarm.getApplicationInfo(ownerCtx, { appNames: [] }),
      ).resolves.toEqual([]);
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it('getAllContainerStats parses docker stats output', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(
        ok(
          '{"BlockIO":"0B / 0B","CPUPerc":"0.50%","Container":"abc123","ID":"abc123","MemPerc":"1.20%","MemUsage":"10MiB / 1GiB","Name":"web-app","NetIO":"1kB / 2kB"}',
        ),
      );

      const stats = await swarm.getAllContainerStats(ownerCtx, {});

      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        'docker stats --no-stream --format \'{"BlockIO":"{{.BlockIO}}","CPUPerc":"{{.CPUPerc}}","Container":"{{.Container}}","ID":"{{.ID}}","MemPerc":"{{.MemPerc}}","MemUsage":"{{.MemUsage}}","Name":"{{.Name}}","NetIO":"{{.NetIO}}"}\'',
      );
      expect(stats).toEqual([
        {
          BlockIO: '0B / 0B',
          CPUPerc: '0.50%',
          Container: 'abc123',
          ID: 'abc123',
          MemPerc: '1.20%',
          MemUsage: '10MiB / 1GiB',
          Name: 'web-app',
          NetIO: '1kB / 2kB',
        },
      ]);
    });

    it("rejects another organization's server on swarm queries too", async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );

      await expect(
        swarm.getSwarmNodes(secondOrgCtx, { serverId }),
      ).rejects.toThrow(NotFoundException);
      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
    });
  });

  describe('cluster', () => {
    const swarmTokens = {
      JoinTokens: {
        Worker: 'SWMTKN-1-worker-token',
        Manager: 'SWMTKN-1-manager-token',
      },
    };

    it('getNodes returns the dockerode node listing for the target server', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      const nodes = [{ ID: 'node1', Spec: { Role: 'manager' } }];
      dockerClient.listNodes.mockResolvedValue(nodes);

      await expect(cluster.getNodes(ownerCtx, { serverId })).resolves.toEqual(
        nodes,
      );
      expect(dockerFactory.getRemoteDocker).toHaveBeenCalledWith(serverId);
    });

    it('addWorker builds the join command from the swarm worker token and node address', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      dockerClient.swarmInspect.mockResolvedValue(swarmTokens);
      dockerClient.version.mockResolvedValue({ Version: '24.0.5' });
      dockerClient.info.mockResolvedValue({ Swarm: { NodeAddr: '10.0.0.5' } });

      await expect(cluster.addWorker(ownerCtx, {})).resolves.toEqual({
        command:
          'docker swarm join --token SWMTKN-1-worker-token 10.0.0.5:2377',
        version: '24.0.5',
      });
    });

    it('addManager uses the manager token', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      dockerClient.swarmInspect.mockResolvedValue(swarmTokens);
      dockerClient.version.mockResolvedValue({ Version: '24.0.5' });
      dockerClient.info.mockResolvedValue({ Swarm: { NodeAddr: '10.0.0.5' } });

      await expect(cluster.addManager(ownerCtx, {})).resolves.toEqual({
        command:
          'docker swarm join --token SWMTKN-1-manager-token 10.0.0.5:2377',
        version: '24.0.5',
      });
    });

    it("addWorker falls back to the server row's IP when the swarm reports no node address", async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      dockerClient.swarmInspect.mockResolvedValue(swarmTokens);
      dockerClient.version.mockResolvedValue({ Version: '24.0.5' });
      dockerClient.info.mockResolvedValue({});
      // The local IP is probed even on the remote path, then overridden
      // with the server row's address.
      remoteExec.execAsync.mockResolvedValue(ok('192.168.1.50\n'));

      await expect(cluster.addWorker(ownerCtx, { serverId })).resolves.toEqual({
        command:
          'docker swarm join --token SWMTKN-1-worker-token 203.0.113.10:2377',
        version: '24.0.5',
      });
      expect(dockerFactory.getRemoteDocker).toHaveBeenCalledWith(serverId);
    });

    it('addWorker falls back to the local private IP when there is no server row', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      dockerClient.swarmInspect.mockResolvedValue(swarmTokens);
      dockerClient.version.mockResolvedValue({ Version: '24.0.5' });
      dockerClient.info.mockResolvedValue({});
      remoteExec.execAsync.mockResolvedValue(ok('192.168.1.50\n'));

      await expect(cluster.addWorker(ownerCtx, {})).resolves.toEqual({
        command:
          'docker swarm join --token SWMTKN-1-worker-token 192.168.1.50:2377',
        version: '24.0.5',
      });
      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        `ip addr show | grep -E "inet (192.168.|10.|172.1[6-9].|172.2[0-9].|172.3[0-1].)" | head -n1 | awk '{print $2}' | cut -d/ -f1`,
      );
    });

    it('removeWorker drains the node and then force-removes it', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      remoteExec.execAsyncRemote.mockResolvedValue(ok(''));

      await expect(
        cluster.removeWorker(ownerCtx, { nodeId: 'node2', serverId }),
      ).resolves.toBe(true);

      expect(remoteExec.execAsyncRemote.mock.calls).toEqual([
        [serverId, 'docker node update --availability drain node2'],
        [serverId, 'docker node rm node2 --force'],
      ]);
    });

    /** The `swarm.getNodeInfo` case's twin, for the drain and the removal. */
    it('removeWorker quotes a nodeId carrying a metacharacter in both commands', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockResolvedValue(ok(''));

      await expect(
        cluster.removeWorker(ownerCtx, { nodeId: SHELL_PAYLOAD }),
      ).resolves.toBe(true);

      const commands = remoteExec.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        expectQuotedInCommand(command, SHELL_PAYLOAD);
      }
    });

    it('removeWorker wraps failures as "Error removing the node"', async () => {
      const { ownerCtx } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockRejectedValue(new Error('node not found'));

      await expect(
        cluster.removeWorker(ownerCtx, { nodeId: 'ghost' }),
      ).rejects.toThrow('Error removing the node');
    });

    /**
     * H-63. An absent `serverId` on these four routes is the **platform host's
     * own swarm** — the one the console, the database and every organization's
     * services run in — and the only questions asked were a `server` statement
     * and `checkServerAccess`, which returns for an absent id by design
     * (ADR-0008). So the whole gate collapsed to "hold `server:create` somewhere
     * on this instance", and an owner of a second Organization holds every
     * statement in their own by construction.
     *
     * `add-manager` is the sharpest of the four and the reason the read takes
     * the same boundary as the write: a **manager** join token is not a
     * disclosure, it is an invitation. Anyone holding it can join a node to the
     * platform host's swarm as a manager, which is the raft quorum, every
     * service spec and every secret in it — a read that is as good as a write,
     * and one that needs no second request to use. `add-worker` and `nodes` are
     * the reconnaissance half of the same act (ADR-0013's first consequence),
     * and `DELETE /cluster/nodes/:nodeId` drains and force-removes a node from
     * that swarm, which is the write.
     *
     * The neighbouring suite covered a foreign `serverId` — `getNodes` answering
     * NotFound for another organization's Server. It never covered the absent
     * one, which is how this stayed invisible, exactly as H-51 did.
     */
    describe('the platform host as a cluster target', () => {
      it("refuses another organization's owner the platform swarm's manager join token", async () => {
        const { ownerSession } = await setUpOwnerWithServer();
        const mallory = await secondOrganizationOwner(
          server,
          ctx.db,
          ownerSession.cookie,
        );
        dockerClient.swarmInspect.mockResolvedValue(swarmTokens);
        dockerClient.version.mockResolvedValue({ Version: '24.0.5' });
        dockerClient.info.mockResolvedValue({
          Swarm: { NodeAddr: '10.0.0.5' },
        });

        const denied = await request(server)
          .get('/cluster/add-manager')
          .set('Cookie', mallory.cookie);
        expect(denied.status).toBe(403);
        expect((denied.body as { message: string }).message).toBe(
          INSTANCE_AUTHORITY_REFUSAL,
        );

        // The token was never minted: the daemon was not asked for it, so it
        // is not in a log, a response body or a stack trace anywhere.
        expect(dockerClient.swarmInspect).not.toHaveBeenCalled();
        expect(dockerFactory.getRemoteDocker).not.toHaveBeenCalled();
      });

      it("refuses another organization's owner the worker token and the node listing", async () => {
        const { ownerSession } = await setUpOwnerWithServer();
        const mallory = await secondOrganizationOwner(
          server,
          ctx.db,
          ownerSession.cookie,
        );
        dockerClient.listNodes.mockResolvedValue([{ ID: 'node1' }]);
        dockerClient.swarmInspect.mockResolvedValue(swarmTokens);
        dockerClient.version.mockResolvedValue({ Version: '24.0.5' });
        dockerClient.info.mockResolvedValue({
          Swarm: { NodeAddr: '10.0.0.5' },
        });

        const worker = await request(server)
          .get('/cluster/add-worker')
          .set('Cookie', mallory.cookie);
        expect(worker.status).toBe(403);
        expect((worker.body as { message: string }).message).toBe(
          INSTANCE_AUTHORITY_REFUSAL,
        );

        const nodes = await request(server)
          .get('/cluster/nodes')
          .set('Cookie', mallory.cookie);
        expect(nodes.status).toBe(403);
        expect((nodes.body as { message: string }).message).toBe(
          INSTANCE_AUTHORITY_REFUSAL,
        );
        expect(dockerClient.listNodes).not.toHaveBeenCalled();
      });

      it("refuses another organization's owner the removal of a platform swarm node", async () => {
        const { ownerSession } = await setUpOwnerWithServer();
        const mallory = await secondOrganizationOwner(
          server,
          ctx.db,
          ownerSession.cookie,
        );
        remoteExec.execAsync.mockResolvedValue(ok(''));

        const denied = await request(server)
          .delete('/cluster/nodes/node2')
          .set('Cookie', mallory.cookie);
        expect(denied.status).toBe(403);
        expect((denied.body as { message: string }).message).toBe(
          INSTANCE_AUTHORITY_REFUSAL,
        );
        // Nothing was drained on the way to being refused.
        expect(remoteExec.execAsync).not.toHaveBeenCalled();
      });

      /**
       * The no-op claim: on the single-organization install `deploy/install.sh`
       * produces, the one Organization is the instance organization, so its
       * owner keeps the platform swarm's join commands — and a Server the
       * organization owns is unaffected either way, because that branch never
       * asked this question.
       */
      /**
       * The sibling route that answers the same fact. `GET /cluster/nodes` and
       * `GET /swarm/nodes` are both `docker node ls` on the target, so gating
       * one and not the other would have moved the disclosure rather than
       * closed it — and `GET /swarm/stats` is worse than either, answering a
       * `docker stats` snapshot of every container on the platform host with
       * none of the owner-label filtering `DockerOpsService` applies.
       */
      it("refuses another organization's owner the platform host's swarm routes", async () => {
        const { ownerSession } = await setUpOwnerWithServer();
        const mallory = await secondOrganizationOwner(
          server,
          ctx.db,
          ownerSession.cookie,
        );
        remoteExec.execAsync.mockResolvedValue(ok('{"ID":"node1"}\n'));

        for (const route of [
          '/swarm/nodes',
          '/swarm/nodes/node1',
          '/swarm/apps',
          '/swarm/stats',
        ]) {
          const denied = await request(server)
            .get(route)
            .set('Cookie', mallory.cookie);
          expect([route, denied.status]).toEqual([route, 403]);
          expect((denied.body as { message: string }).message).toBe(
            INSTANCE_AUTHORITY_REFUSAL,
          );
        }

        // Nothing was asked of the host's daemon on the way to being refused.
        expect(remoteExec.execAsync).not.toHaveBeenCalled();
      });

      it("leaves the single-organization install's owner exactly as they were", async () => {
        const { ownerSession, serverId } = await setUpOwnerWithServer();
        dockerClient.swarmInspect.mockResolvedValue(swarmTokens);
        dockerClient.version.mockResolvedValue({ Version: '24.0.5' });
        dockerClient.info.mockResolvedValue({
          Swarm: { NodeAddr: '10.0.0.5' },
        });

        const host = await request(server)
          .get('/cluster/add-manager')
          .set('Cookie', ownerSession.cookie);
        expect(host.status).toBe(200);
        expect((host.body as { command: string }).command).toBe(
          'docker swarm join --token SWMTKN-1-manager-token 10.0.0.5:2377',
        );

        const named = await request(server)
          .get('/cluster/add-manager')
          .query({ serverId })
          .set('Cookie', ownerSession.cookie);
        expect(named.status).toBe(200);
      });
    });
  });

  describe('HTTP surface', () => {
    it('round-trips the docker endpoints', async () => {
      const { ownerSession } = await setUpOwnerWithServer();

      remoteExec.execAsync.mockResolvedValue(ok(PS_OUTPUT));
      const listed = await request(server)
        .get('/docker/containers')
        .set('Cookie', ownerSession.cookie);
      expect(listed.status).toBe(200);
      expect((listed.body as { name: string }[]).map((c) => c.name)).toEqual([
        'web-app',
        'cloudgate-monitoring',
      ]);

      remoteExec.execAsync.mockReset();
      stubDaemon(ownerLabels());
      const restarted = await request(server)
        .post('/docker/containers/abc123/restart')
        .set('Cookie', ownerSession.cookie)
        .send({});
      expect(restarted.status).toBe(204);
      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        'docker container restart abc123',
      );

      // The containerIdRegex gate: shell metacharacters never reach
      // the command line.
      const badId = await request(server)
        .post(encodeURI('/docker/containers/abc;rm -rf/restart'))
        .set('Cookie', ownerSession.cookie)
        .send({});
      expect(badId.status).toBe(400);

      remoteExec.execAsync.mockReset();
      stubDaemon(ownerLabels());
      const uploaded = await request(server)
        .post('/docker/containers/abc123/upload')
        .set('Cookie', ownerSession.cookie)
        .field('destinationPath', '/etc/app/config.json')
        .attach('file', Buffer.from('hello'), 'config.txt');
      expect(uploaded.status).toBe(200);
      expect(uploaded.body).toEqual({
        success: true,
        message: 'File uploaded successfully',
      });
      expect(remoteExec.execAsync.mock.calls[1][0]).toContain(
        '"abc123:/etc/app/config.json"',
      );
    });

    it('round-trips the swarm and cluster endpoints', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();

      remoteExec.execAsync.mockResolvedValue(ok('{"ID":"node1"}'));
      const nodes = await request(server)
        .get('/swarm/nodes')
        .set('Cookie', ownerSession.cookie);
      expect(nodes.status).toBe(200);
      expect(nodes.body).toEqual([{ ID: 'node1' }]);

      remoteExec.execAsync.mockReset();
      remoteExec.execAsync.mockResolvedValue(ok('{"ID":"task1"}'));
      const infos = await request(server)
        .get('/swarm/apps/info')
        .query({ appName: ['my-app', 'other'] })
        .set('Cookie', ownerSession.cookie);
      expect(infos.status).toBe(200);
      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        "docker service ps my-app other --format '{{json .}}' --no-trunc",
      );

      dockerClient.swarmInspect.mockResolvedValue({
        JoinTokens: { Worker: 'SWMTKN-w', Manager: 'SWMTKN-m' },
      });
      dockerClient.version.mockResolvedValue({ Version: '24.0.5' });
      dockerClient.info.mockResolvedValue({ Swarm: { NodeAddr: '10.0.0.5' } });
      const join = await request(server)
        .get('/cluster/add-worker')
        .query({ serverId })
        .set('Cookie', ownerSession.cookie);
      expect(join.status).toBe(200);
      expect(join.body).toEqual({
        command: 'docker swarm join --token SWMTKN-w 10.0.0.5:2377',
        version: '24.0.5',
      });

      remoteExec.execAsyncRemote.mockResolvedValue(ok(''));
      const removed = await request(server)
        .delete('/cluster/nodes/node2')
        .query({ serverId })
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);
      expect(remoteExec.execAsyncRemote.mock.calls).toEqual([
        [serverId, 'docker node update --availability drain node2'],
        [serverId, 'docker node rm node2 --force'],
      ]);
    });

    /**
     * `NodeIdParamsDto` was the one DTO in `dto/docker-ops.dto.ts` without
     * `containerIdRegex`. Both of its routes are asserted, because the
     * DTO is shared and a regression that re-widened it for one would be
     * invisible in a test on the other.
     *
     * Refused rather than quoted, unlike `dockerImage`: a swarm node id is an
     * opaque daemon-minted token, so there is nothing legitimate to preserve.
     */
    it('refuses a nodeId with shell metacharacters on both node routes', async () => {
      const { ownerSession } = await setUpOwnerWithServer();
      remoteExec.execAsync.mockReset();
      remoteExec.execAsyncRemote.mockReset();

      const inspected = await request(server)
        .get(encodeURI(`/swarm/nodes/${SHELL_PAYLOAD}`))
        .set('Cookie', ownerSession.cookie);
      expect(inspected.status).toBe(400);

      const removed = await request(server)
        .delete(encodeURI(`/cluster/nodes/${SHELL_PAYLOAD}`))
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(400);

      // Nothing was inspected, drained or removed on the way to being refused.
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
    });
  });
});
