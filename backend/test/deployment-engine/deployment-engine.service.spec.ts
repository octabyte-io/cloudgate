import type { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { parse as parseShell } from 'shell-quote';
import {
  cloudgateDirectoryOn,
  REMOTE_CLOUDGATE_DIRECTORY,
} from '../../src/common/config/cloudgate-directory';
import type { ComposeService } from '../../src/compose/compose.service';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { GithubService } from '../../src/git-providers/strategies/github/github.service';
import type { GiteaService } from '../../src/git-providers/strategies/gitea/gitea.service';
import type { GitlabService } from '../../src/git-providers/strategies/gitlab/gitlab.service';
import { SourceCloneService } from '../../src/git-providers/source-clone.service';
import { passThroughGuard } from '../outbound/pass-through-guard';
import type { PatchService } from '../../src/patch/patch.service';
import { ExecError } from '../../src/remote/exec-error';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  DeploymentEngineService,
  digestOf,
} from '../../src/deployment-engine/deployment-engine.service';
import type { DeployableApplication } from '../../src/deployment-engine/deployment-engine.types';
import type { ApplicationsService } from '../../src/applications/applications.service';
import type { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type { DomainsService } from '../../src/domains/domains.service';
import type { DeployableCompose } from '../../src/compose/compose.types';
import type { DeploymentRecorder } from '../../src/deployment-engine/ports/deployment-recorder';
import type { DeploymentNotifier } from '../../src/deployment-engine/ports/deployment-notifier';
import type { RollbackRecorder } from '../../src/deployment-engine/ports/rollback-recorder';
import {
  expectValueIsInert,
  INERT_VALUE,
  SEPARATOR_PAYLOAD,
} from '../utils/shell-safety';
import {
  NODE_GPU_RESOURCES_COMMAND,
  RUNNING_TASK_GPUS_COMMAND,
} from '../../src/settings/gpu-counts';
import {
  nvidiaRuntimeAnswer,
  RUNTIME_TOML,
} from '../settings/gpu-runtime.fixture';
import { makeApp } from './application.fixture';

const ok = { stdout: '', stderr: '', exitCode: 0 };

/**
 * A `jest.fn()` carrying one port method's own signature, so a change to the
 * port breaks this file at compile time instead of being absorbed by the
 * double.
 *
 * **An annotation on the mock object would not do it.** `jest.fn()` with no
 * type arguments is `jest.Mock<any, any>`, which is assignable to every port
 * there is — so `{ create: jest.fn() }` satisfies a `jest.Mocked<Port>`
 * annotation, a `satisfies` clause and the constructor parameter alike while
 * checking nothing. An earlier change is the proof: it replaced `CreateDeploymentInput`'s
 * two independent optional ids with a discriminated union and both engine call
 * sites gained a `kind`, and the three port doubles in this file — the only
 * unit test of the caller — went on compiling untouched. The type arguments
 * are therefore where the coupling has to live, which is what `remoteExec`
 * below has always done by hand; this reads them off the port instead of
 * restating them.
 */
const portFn = <Method extends (...args: any[]) => any>() =>
  jest.fn<ReturnType<Method>, Parameters<Method>>();

/**
 * The lines a base64-carried log append actually writes, decoded — the Update
 * phase's own writer, which does not ride the `>> logPath` redirection
 * the shell steps ride. Decoded rather than matched on the base64 so the
 * assertion reads as the operator's log tail and not as a checksum.
 *
 * The redirect target is matched loosely rather than as `"[^"]+"`, because the
 * path is `quote()`d now and `quote()` leaves an ordinary path bare (H-34).
 * What this helper is for is the *payload*, which is the capture group; the
 * shape of the target is `appendToLogCommand`'s business and is pinned by the
 * injection test below.
 */
const appendedLogLines = (commands: string[]): string[] =>
  commands.flatMap((command) =>
    [...command.matchAll(/echo "([A-Za-z0-9+/=]+)" \| base64 -d >> /g)].map(
      (match) => Buffer.from(match[1], 'base64').toString('utf-8'),
    ),
  );

const makeDeps = () => {
  // Parameters read off the real service rather than restated, on the same
  // argument {@link portFn}'s docblock makes: the hand-written `[string]` and
  // `[string, string]` tuples were the two shapes the callers happened to use,
  // so the fourth argument — the environment a build's values travel in —
  // could not be asserted on without editing them. Reading them off
  // `RemoteExecService` means the next signature change breaks this file at
  // compile time instead of being absorbed.
  const remoteExec = {
    execAsync: jest
      .fn<Promise<typeof ok>, Parameters<RemoteExecService['execAsync']>>()
      .mockResolvedValue(ok),
    execAsyncRemote: jest
      .fn<
        Promise<typeof ok>,
        Parameters<RemoteExecService['execAsyncRemote']>
      >()
      .mockResolvedValue(ok),
    // The argv twins, which a failed Deployment reads its log's tail through
    // — `execOnServer` picks one by whether there is a `serverId`.
    execFileAsync: jest
      .fn<Promise<typeof ok>, Parameters<RemoteExecService['execFileAsync']>>()
      .mockResolvedValue(ok),
    execRemote: jest
      .fn<Promise<typeof ok>, Parameters<RemoteExecService['execRemote']>>()
      .mockResolvedValue(ok),
  };
  const githubService = {
    getGithubToken: jest.fn().mockResolvedValue('gh-token-123'),
  };
  const gitlabService = {
    refreshToken: jest
      .fn()
      .mockImplementation((row: object) =>
        Promise.resolve({ ...row, accessToken: 'gl-token-9' }),
      ),
  };
  const recorder = {
    create: portFn<DeploymentRecorder['create']>().mockResolvedValue({
      deploymentId: 'dep-1',
      logPath: '/etc/cloudgate/logs/shop-api-x1/dep-1.log',
      cancelled: new AbortController().signal,
    }),
    updateStatus:
      portFn<DeploymentRecorder['updateStatus']>().mockResolvedValue(undefined),
    closeCancelWindow: portFn<DeploymentRecorder['closeCancelWindow']>(),
  };
  const giteaService = {
    refreshToken: jest
      .fn()
      .mockImplementation((row: object) =>
        Promise.resolve({ ...row, accessToken: 'gt-token-5' }),
      ),
  };
  const service = {
    inspect: jest.fn().mockRejectedValue(new Error('no such service')),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const docker = {
    getService: jest.fn(() => service),
    // Typed like `mechanize.spec.ts`' double rather than a bare `jest.fn()`,
    // so a test that reads the spec off this call reads `unknown[]` and has to
    // say what it expects — the argument {@link portFn}'s docblock makes.
    createService: jest
      .fn<Promise<unknown>, unknown[]>()
      .mockResolvedValue(undefined),
    // The release is followed by a convergence poll. A task already
    // running on the first read is the shortest honest answer — the poll
    // returns without sleeping, so these tests still run in milliseconds.
    listTasks: jest
      .fn()
      .mockResolvedValue([
        { Status: { State: 'running', Timestamp: '2026-08-24T00:00:00Z' } },
      ]),
  };
  const dockerFactory = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };
  const applications = { updateStatus: jest.fn().mockResolvedValue(undefined) };
  const composeService = {
    updateStatus: jest.fn().mockResolvedValue(undefined),
    // H-83's ownership half. The engine is the only seam that can see a
    // git-sourced stack's compose file, so the call is unconditional on the
    // compose branch; the double admits everything, because what this file
    // pins is command *quoting* and the guard's own red-green lives in
    // `test/compose/compose-label-claims.e2e-spec.ts`.
    assertComposeContentClaimable: jest.fn().mockResolvedValue(undefined),
    // The record of a successful deploy's ports; pinned end to end in
    // `test/compose/compose-deployed-ports.e2e-spec.ts`.
    recordDeployedFile: jest.fn().mockResolvedValue(undefined),
  };
  const domainsService = {
    findComposeDomains: jest.fn().mockResolvedValue([]),
  };
  // No stored patches: the engine appends the empty command for apps and
  // skips the compose patch step entirely.
  const patchService = {
    generateApplyPatchesCommand: jest.fn().mockResolvedValue(''),
  };
  const notifier = {
    buildSuccess:
      portFn<DeploymentNotifier['buildSuccess']>().mockResolvedValue(undefined),
    buildError:
      portFn<DeploymentNotifier['buildError']>().mockResolvedValue(undefined),
  };
  const rollbacks = {
    capture: portFn<RollbackRecorder['capture']>().mockResolvedValue({
      image: 'shop-api-x1:v1',
    }),
  };
  // The `server` rows the host line names. The double answers every
  // `select … from … where` with the whole list, so the engine has to pick its
  // rows by id rather than trust the query to have filtered; `servers` is
  // exposed so a test can rename one, and `select` so a test can say the
  // platform host is described without asking the database at all.
  const servers: { serverId: string; name: string; ipAddress: string }[] = [
    { serverId: 'srv-run', name: 'app-runner', ipAddress: '203.0.113.10' },
    { serverId: 'srv-build', name: 'ui-self', ipAddress: '203.0.113.42' },
  ];
  // The one `… where … limit` the engine reads is the Application's traces
  // setting, and none of these Applications has one: traced deploys
  // are `test/traces/traces.e2e-spec.ts`'.
  const db = {
    select: jest.fn(() => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve(servers), {
            limit: () => Promise.resolve([]),
          }),
      }),
    })),
    // A settled deploy clears its wired-variables notice.
    update: jest.fn(() => ({
      set: () => ({ where: () => Promise.resolve() }),
    })),
  };
  return {
    db,
    servers,
    remoteExec,
    composeService,
    domainsService,
    patchService,
    githubService,
    gitlabService,
    giteaService,
    recorder,
    docker,
    dockerFactory,
    applications,
    notifier,
    rollbacks,
  };
};

type Deps = ReturnType<typeof makeDeps>;

const makeEngine = (deps: Deps) =>
  new DeploymentEngineService(
    deps.remoteExec,
    deps.dockerFactory as unknown as RemoteDockerFactory,
    deps.applications as unknown as ApplicationsService,
    deps.composeService as unknown as ComposeService,
    deps.domainsService as unknown as DomainsService,
    new SourceCloneService(
      deps.githubService as unknown as GithubService,
      deps.gitlabService as unknown as GitlabService,
      deps.giteaService as unknown as GiteaService,
      passThroughGuard,
    ),
    deps.patchService as unknown as PatchService,
    deps.recorder,
    deps.notifier,
    deps.rollbacks,
    deps.db as unknown as DrizzleDB,
    { isHosted: false } as InstanceMode,
  );

/**
 * A linked Registry, which is what makes a dedicated build Server deployable at
 * all: it is the only thing `uploadImageCommands` will push the built
 * image through, and the tag `getImageName` then hands the converge.
 */
const REGISTRY = {
  registryId: 'reg-1',
  name: 'acme registry',
  imagePrefix: null,
  username: 'pusher',
  password: 'reg-secret',
  url: 'registry.acme.dev',
  registryType: 'cloud',
  organizationId: 'org-1',
};

/**
 * Where `makeApp()`'s source tree is, on the machine that builds it. The
 * fixture has no `serverId` and no `buildServerId`, so that machine is the
 * platform host, and its root is this process's own `CLOUDGATE_DIRECTORY` — not
 * the `/etc/cloudgate` a Server's tree sits at. The two read alike only while
 * that variable is unset, which is how every expectation spelling the literal
 * here was green by coincidence rather than by being right.
 *
 * Spelled as `cloudgateDirectoryOn` plus the literal tail rather than through
 * `applicationsDirectoryOn`, because that helper is the one the engine itself
 * asks, and an expectation computed the way the code computes it proves
 * nothing (§1.7). A function rather than a constant for the reason
 * `localCloudgateDirectory` is one: the root is read when it is asked for.
 */
const platformHostCode = (tail = '') =>
  `${cloudgateDirectoryOn(null)}/applications/shop-api-x1/code${tail}`;

describe('DeploymentEngineService.deploy', () => {
  /**
   * The `.env` a build writes lands in the build context with a mode an
   * image's own user can read, so the Service directory above `code` is what
   * keeps it from every local account — closed before the clone, on every
   * deploy, which is also what corrects an older install's directory.
   */
  it('closes the Service directory before the clone writes into it', async () => {
    const deps = makeDeps();

    await makeEngine(deps).deploy(makeApp());

    const service = `${cloudgateDirectoryOn(null)}/applications/shop-api-x1`;
    const command: string = deps.remoteExec.execAsync.mock.calls[0][0];
    expect(
      command.indexOf(`mkdir -p ${service} && chmod 700 ${service};`),
    ).toBeGreaterThan(-1);
    expect(command.indexOf(`chmod 700 ${service}`)).toBeLessThan(
      command.indexOf(platformHostCode()),
    );
  });

  it('runs clone → build piped to the deployment log for a github app on the local server', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(makeApp());

    expect(deps.remoteExec.execAsyncRemote).not.toHaveBeenCalled();
    // The pipeline, then the two Update-phase log appends.
    expect(deps.remoteExec.execAsync).toHaveBeenCalledTimes(3);
    const command = deps.remoteExec.execAsync.mock.calls[0][0];

    expect(command.startsWith('(set -e;')).toBe(true);
    expect(
      command.endsWith(
        ') >> /etc/cloudgate/logs/shop-api-x1/dep-1.log 2>&1 < /dev/null',
      ),
    ).toBe(true);
    expect(command).toContain(
      `git -c protocol.file.allow=never clone --branch main --depth 1 --progress -- https\\://oauth2\\:gh-token-123\\@github.com/acme/shop-api.git ${platformHostCode()}`,
    );
    expect(command).toContain(
      `nixpacks build ${platformHostCode()} --name shop-api-x1`,
    );
    expect(
      command.indexOf('git -c protocol.file.allow=never clone'),
    ).toBeLessThan(command.indexOf('nixpacks build'));
  });

  /**
   * The parent each branch records, read off the port's own input type.
   *
   * This is the assertion that makes {@link portFn}'s typing bite on `create`'s
   * *argument* rather than only on its result: `created.kind` and
   * `created.applicationId` are member accesses on a `CreateDeploymentInput`,
   * so the shape — a tag plus exactly one id, with the other four parent
   * columns pinned to `never` — is now load-bearing on this file at compile
   * time as well as at runtime. Reverting the port to two independent optional
   * ids stops this compiling, which is the whole point; the untyped double it
   * replaced absorbed that change silently (ADR-0017).
   *
   * The runtime half is worth having on its own: `deploy` and `deployCompose`
   * are the port's only two callers, and nothing else in this file reads what
   * they passed.
   */
  it('records an application deploy against the application, by kind', async () => {
    const deps = makeDeps();

    await makeEngine(deps).deploy(makeApp());

    const [created] = deps.recorder.create.mock.calls[0];
    expect(created.kind).toBe('application');
    expect(created.applicationId).toBe('app-1');
    expect(created.composeId).toBeUndefined();
  });

  /**
   * A queued job names the `pending` row its trigger inserted, and the
   * engine hands that id to the recorder, which claims exactly that row. A row
   * settled between the dequeue and the claim comes back `null`, and nothing
   * is built under it — building would run what an operator cancelled.
   */
  describe('the row its job names', () => {
    it('hands the recorder the Deployment id the job named, for an application and a compose stack', async () => {
      const deps = makeDeps();
      const engine = makeEngine(deps);

      await engine.deploy(makeApp(), { deploymentId: 'dep-named' });
      await engine.deployCompose(makeComposeStack(), {
        deploymentId: 'dep-stack',
      });

      expect(deps.recorder.create.mock.calls[0][0].deploymentId).toBe(
        'dep-named',
      );
      expect(deps.recorder.create.mock.calls[1][0].deploymentId).toBe(
        'dep-stack',
      );
    });

    it.each([
      [
        'application',
        (engine: DeploymentEngineService) =>
          engine.deploy(makeApp(), { deploymentId: 'dep-settled' }),
      ],
      [
        'compose stack',
        (engine: DeploymentEngineService) =>
          engine.deployCompose(makeComposeStack(), {
            deploymentId: 'dep-settled',
          }),
      ],
    ])(
      'builds nothing for an %s whose named row is no longer pending',
      async (_kind, run) => {
        const deps = makeDeps();
        deps.recorder.create.mockResolvedValue(null);

        await run(makeEngine(deps));

        expect(deps.remoteExec.execAsync).not.toHaveBeenCalled();
        expect(deps.remoteExec.execAsyncRemote).not.toHaveBeenCalled();
        expect(deps.recorder.updateStatus).not.toHaveBeenCalled();
        expect(deps.recorder.closeCancelWindow).not.toHaveBeenCalled();
      },
    );
  });

  it('runs the pipeline over ssh when the application builds on a remote server', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(makeApp({ serverId: 'srv-1' }));

    expect(deps.remoteExec.execAsync).not.toHaveBeenCalled();
    expect(deps.remoteExec.execAsyncRemote).toHaveBeenCalledTimes(3);
    const [serverId, command] = deps.remoteExec.execAsyncRemote.mock.calls[0];
    expect(serverId).toBe('srv-1');
    expect(command).toContain(
      'git -c protocol.file.allow=never clone --branch main',
    );
    expect(
      command.endsWith(
        ') >> /etc/cloudgate/logs/shop-api-x1/dep-1.log 2>&1 < /dev/null',
      ),
    ).toBe(true);
  });

  /**
   * The never-carry change at the seam, and the three facts it turns on.
   *
   * `application.env` and its two parents used to be spliced into the build
   * step, so `ExecError.command` — which pino writes six times over — carried
   * every one of them on a failed build. They now travel beside the program:
   * the strategy declares them, `buildProgram` hands them to `exec`, and
   * `exec` gives them to `RemoteExecOptions.env`, where `RemoteExecService`
   * sends them as a script on the SSH channel.
   */
  describe("a build's operator-authored environment", () => {
    const withSecret = () =>
      makeApp({
        env: 'STRIPE_KEY=sk_live_91b3d0c6f2a84e57',
        serverId: 'srv-1',
      });

    it('reaches the Server in the environment and not in the command', async () => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(withSecret());

      const [, command, , options] =
        deps.remoteExec.execAsyncRemote.mock.calls[0];
      expect(command).not.toContain('sk_live_91b3d0c6f2a84e57');
      expect(command).toContain('--env STRIPE_KEY"=$CG_BUILD_ENV_0"');
      expect(options).toEqual({
        env: { CG_BUILD_ENV_0: 'sk_live_91b3d0c6f2a84e57' },
        // The cancel signal rides beside it and is not an environment.
        signal: expect.any(AbortSignal) as unknown,
      });
    });

    it("extends the platform host's environment rather than replacing it, on the local branch", async () => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(
        makeApp({ env: 'STRIPE_KEY=sk_live_91b3d0c6f2a84e57' }),
      );

      const [command, options] = deps.remoteExec.execAsync.mock.calls[0];
      expect(command).not.toContain('sk_live_91b3d0c6f2a84e57');
      expect(options?.env?.CG_BUILD_ENV_0).toBe('sk_live_91b3d0c6f2a84e57');
      // `ExecOptions.env` *replaces*, so a two-variable environment would
      // otherwise run the build with the shell's fallback `PATH` instead of the
      // account's — `destinations/rclone-exec.ts` spreads `process.env` for the
      // same reason.
      expect(options?.env?.PATH).toBe(process.env.PATH);
    });

    it('leaves a build with no variables on the transport every deploy has always used', async () => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(makeApp({ serverId: 'srv-1' }));

      // No environment, so `execAsyncRemote` sends the program as the SSH
      // `exec` request under the account's login shell rather than piping it to
      // `sh -s`. The only option is the Deployment's cancel signal,
      // which picks no shell.
      const [, , , options] = deps.remoteExec.execAsyncRemote.mock.calls[0];
      expect(Object.keys(options ?? {})).toEqual(['signal']);
    });
  });

  /**
   * The stdin login at the same seam, for the two credentials never-carry left.
   *
   * The registry password was the single most journalled secret in the tree: a
   * refused login is the likeliest failure on the push path, `registry.password`
   * is `encryptedText` (ADR 0006), and `ExecError` captures the whole command,
   * from where pino writes it six times over. The error mask hid it on the way out
   * (`STDIN_CREDENTIAL`) and recorded never-carry as unreachable on four
   * grounds; never-carry measured three away; the fourth was
   * `SourceCloneService.cloneCommand`'s string return, which is now
   * `cloneProgram`.
   *
   * **The assertion that matters is absence from the command as constructed**,
   * paired with presence in the environment — the pair, because absence alone
   * also passes for a deploy that lost the credential, and the journal alone
   * cannot tell never-carry from a working mask (the never-carry change's own
   * falsification note).
   */
  describe('the registry passwords a push logs in with', () => {
    const BUILD_REGISTRY = {
      ...REGISTRY,
      registryId: 'reg-2',
      username: 'builder',
      password: 'build-reg-secret',
      url: 'registry.build.dev',
    };

    it('reaches the Server in the environment and not in the command', async () => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(
        makeApp({
          serverId: 'srv-1',
          registry: REGISTRY,
        } as Partial<DeployableApplication>),
      );

      const [, command, , options] =
        deps.remoteExec.execAsyncRemote.mock.calls[0];
      expect(command).not.toContain('reg-secret');
      expect(command).toContain(
        `printf %s "$CG_REGISTRY_PASSWORD_0" | docker login 'registry.acme.dev' -u 'pusher' --password-stdin`,
      );
      expect(options).toEqual({
        env: { CG_REGISTRY_PASSWORD_0: 'reg-secret' },
        // The cancel signal rides beside it and is not an environment.
        signal: expect.any(AbortSignal) as unknown,
      });
    });

    it('numbers a holder per push, so two registries cannot overwrite each other', async () => {
      // `registry` and `buildRegistry` are independent columns and this method
      // pushes through either or both, so the two logins are composed into one
      // program and need two names.
      const deps = makeDeps();

      await makeEngine(deps).deploy(
        makeApp({
          serverId: 'srv-1',
          registry: REGISTRY,
          buildRegistry: BUILD_REGISTRY,
        } as Partial<DeployableApplication>),
      );

      const [, command, , options] =
        deps.remoteExec.execAsyncRemote.mock.calls[0];
      expect(command).not.toContain('reg-secret');
      expect(command).not.toContain('build-reg-secret');
      expect(command).toContain(
        `printf %s "$CG_REGISTRY_PASSWORD_0" | docker login 'registry.acme.dev' -u 'pusher'`,
      );
      expect(command).toContain(
        `printf %s "$CG_REGISTRY_PASSWORD_1" | docker login 'registry.build.dev' -u 'builder'`,
      );
      expect(options?.env).toEqual({
        CG_REGISTRY_PASSWORD_0: 'reg-secret',
        CG_REGISTRY_PASSWORD_1: 'build-reg-secret',
      });
    });

    it('carries nothing when no registry is linked', async () => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(makeApp({ serverId: 'srv-1' }));

      const [, , , options] = deps.remoteExec.execAsyncRemote.mock.calls[0];
      expect(options?.env).toBeUndefined();
    });

    /**
     * The holder namespaces meeting in one program, which is the reason they
     * have different prefixes. A docker-sourced Application with a Registry
     * linked used to compose a pull login and a push login; now it
     * pushes nothing, so the pull credential is the only one it carries and
     * the Registry's password never leaves the database.
     */
    it('carries only the pull credential for a docker source with a Registry linked', async () => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(
        makeApp({
          serverId: 'srv-1',
          sourceType: 'docker',
          github: null,
          dockerImage: 'ghcr.io/acme/web:1',
          registryUrl: 'ghcr.io',
          username: 'acme',
          password: 'pull-secret',
          registry: REGISTRY,
        } as Partial<DeployableApplication>),
      );

      const [, command, , options] =
        deps.remoteExec.execAsyncRemote.mock.calls[0];
      for (const secret of ['pull-secret', 'reg-secret']) {
        expect(command).not.toContain(secret);
      }
      expect(options?.env).toEqual({
        CG_SOURCE_REGISTRY_PASSWORD: 'pull-secret',
      });
    });

    it("extends the platform host's environment rather than replacing it, on the local branch", async () => {
      // The same hazard never-carry handles for a build's variables, now reachable
      // through a push credential alone: `ExecOptions.env` *replaces*, so a
      // one-variable environment would run the whole deploy — clone, build and
      // `docker push` — with the shell's fallback `PATH`.
      const deps = makeDeps();

      await makeEngine(deps).deploy(
        makeApp({ registry: REGISTRY } as Partial<DeployableApplication>),
      );

      const [command, options] = deps.remoteExec.execAsync.mock.calls[0];
      expect(command).not.toContain('reg-secret');
      expect(options?.env?.CG_REGISTRY_PASSWORD_0).toBe('reg-secret');
      expect(options?.env?.PATH).toBe(process.env.PATH);
    });
  });

  /**
   * The drop lane was upload-only.
   *
   * `getGitProviderStrategy('drop')` threw, `deploy` had no inline branch
   * despite the enum comment promising one, and so `cloneCommand` raised before
   * any build — every `POST /applications/:id/deploy` on a `drop` Application
   * failed with *"No git-provider strategy registered for source type
   * \"drop\""*, which names an implementation detail and not the missing
   * feature.
   *
   * What the branch has to do is *nothing to the tree*, which is the fact that
   * makes it a strategy rather than a fetch: `ApplicationsService.uploadDrop`
   * already extracted the archive into `{appName}/code` on the build host
   * so a clone step that opened with the `rm -rf <outputPath>` its six
   * siblings open with would delete the source it is supposed to be
   * materializing.
   */
  describe("an application deployed from an operator's zip upload", () => {
    const dropApp = (overrides: Partial<DeployableApplication> = {}) =>
      makeApp({
        sourceType: 'drop',
        github: null,
        dropBuildPath: '/',
        ...overrides,
      });

    it('builds the tree the upload left instead of raising', async () => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(dropApp());

      const command = deps.remoteExec.execAsync.mock.calls[0][0];
      // The build ran, which is the whole point.
      expect(command).toContain(
        `nixpacks build ${platformHostCode()} --name shop-api-x1`,
      );
      expect(deps.notifier.buildSuccess).toHaveBeenCalled();
      expect(deps.notifier.buildError).not.toHaveBeenCalled();
    });

    it('leaves the uploaded tree where the upload put it', async () => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(dropApp());

      const command = deps.remoteExec.execAsync.mock.calls[0][0];
      // The one thing this branch must never do. Every other clone strategy
      // starts by clearing its output path; here that path *is* the source.
      expect(command).not.toContain(`rm -rf ${platformHostCode()}`);
      // Nothing is fetched, either — a drop has no repository and no image.
      expect(command).not.toContain('git -c protocol.file.allow=never clone');
      expect(command).not.toContain('docker pull');
    });

    it('builds from dropBuildPath rather than buildPath', async () => {
      // The archive's root is `dropBuildPath`, which is the column
      // `POST /applications/:id/drop` writes and the only one a drop upload
      // sets; `buildPath` belongs to the git-provider sources and is what this
      // dispatch fell through to.
      const deps = makeDeps();

      await makeEngine(deps).deploy(
        dropApp({ dropBuildPath: '/frontend', buildPath: '/api' }),
      );

      const command = deps.remoteExec.execAsync.mock.calls[0][0];
      expect(command).toContain(
        `nixpacks build ${platformHostCode('/frontend')}`,
      );
      expect(command).not.toContain('/code/api');
    });

    it('fails the deploy with a sentence naming the upload route when nothing was ever uploaded', async () => {
      // `sourceType` is a `PATCH /applications/:id` column, so a row can read
      // `drop` with no archive ever posted. The build would then run over an
      // absent directory and fail somewhere inside the builder.
      const deps = makeDeps();

      await makeEngine(deps).deploy(dropApp());

      const command = deps.remoteExec.execAsync.mock.calls[0][0];
      expect(command).toContain(`if [ ! -d ${platformHostCode()} ]; then`);
      expect(command).toContain('/applications/:id/drop');
    });
  });

  it('pulls the image instead of cloning and building for a docker-sourced app', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(
      makeApp({
        sourceType: 'docker',
        dockerImage: 'nginx:1.27',
        github: null,
        username: null,
        password: null,
        registryUrl: null,
      }),
    );

    const command = deps.remoteExec.execAsync.mock.calls[0][0];
    expect(command).toContain(`docker pull 'nginx:1.27'`);
    expect(command).not.toContain('nixpacks build');
    expect(deps.githubService.getGithubToken).not.toHaveBeenCalled();
  });

  it('clones a custom git url and builds from the source-specific build path', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(
      makeApp({
        sourceType: 'git',
        github: null,
        customGitUrl: 'https://git.example.com/acme/shop.git',
        customGitBranch: 'release',
        customGitBuildPath: '/api',
        enableSubmodules: true,
      }),
    );

    const command = deps.remoteExec.execAsync.mock.calls[0][0];
    expect(command).toContain(
      `git -c protocol.file.allow=never clone --branch release --depth 1 --recurse-submodules --progress -- https\\://git.example.com/acme/shop.git ${platformHostCode()}`,
    );
    expect(command).toContain(
      `nixpacks build ${platformHostCode('/api')} --name shop-api-x1`,
    );
  });

  it('clones gitlab with a freshly refreshed oauth token', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(
      makeApp({
        sourceType: 'gitlab',
        github: null,
        gitlabOwner: 'acme',
        gitlabRepository: 'shop-api',
        gitlabBranch: 'main',
        gitlabPathNamespace: 'acme/shop-api',
        gitlabBuildPath: '/',
        gitlab: {
          gitlabId: 'gl-1',
          gitlabUrl: 'https://gitlab.example.com',
          accessToken: 'stale-token',
        },
      } as Partial<DeployableApplication>),
    );

    const command = deps.remoteExec.execAsync.mock.calls[0][0];
    expect(command).toContain(
      `git -c protocol.file.allow=never clone --branch main --depth 1 --progress -- https\\://oauth2\\:gl-token-9\\@gitlab.example.com/acme/shop-api.git ${platformHostCode()}`,
    );
  });

  it('clones gitea with a freshly refreshed oauth token', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(
      makeApp({
        sourceType: 'gitea',
        github: null,
        giteaOwner: 'acme',
        giteaRepository: 'shop-api',
        giteaBranch: 'main',
        giteaBuildPath: '/',
        gitea: {
          giteaId: 'gt-1',
          giteaUrl: 'https://gitea.example.com',
          accessToken: 'stale-token',
        },
      } as Partial<DeployableApplication>),
    );

    const command = deps.remoteExec.execAsync.mock.calls[0][0];
    expect(command).toContain(
      `git -c protocol.file.allow=never clone --branch main --depth 1 --progress -- https\\://oauth2\\:gt-token-5\\@gitea.example.com/acme/shop-api.git ${platformHostCode()}`,
    );
  });

  it('clones bitbucket with the connection api token', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(
      makeApp({
        sourceType: 'bitbucket',
        github: null,
        bitbucketOwner: 'acme',
        bitbucketRepository: 'shop-api',
        bitbucketBranch: 'main',
        bitbucketBuildPath: '/',
        bitbucket: {
          bitbucketId: 'bb-1',
          bitbucketUsername: 'acme-bot',
          bitbucketEmail: 'bot@acme.dev',
          apiToken: 'bb-api-token',
          appPassword: null,
        },
      } as Partial<DeployableApplication>),
    );

    const command = deps.remoteExec.execAsync.mock.calls[0][0];
    expect(command).toContain(
      `git -c protocol.file.allow=never clone --branch main --depth 1 --progress -- https\\://x-bitbucket-api-token-auth\\:bb-api-token\\@bitbucket.org/acme/shop-api.git ${platformHostCode()}`,
    );
  });

  it('points docker build -f at the Dockerfile itself, not the code directory', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(makeApp({ buildType: 'dockerfile' }));

    const command = deps.remoteExec.execAsync.mock.calls[0][0];
    expect(command).toContain(
      `docker build -t shop-api-x1 -f ${platformHostCode('/Dockerfile')} .`,
    );
    // The regression: BuildKit reads `-f` as a file, so the bare code
    // directory makes every dockerfile build fail with "is a directory".
    expect(command).not.toContain(`-f ${platformHostCode()} .`);
  });

  it('resolves the dockerfile column under the build path and keeps its directory as the build context', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(
      makeApp({
        buildType: 'dockerfile',
        buildPath: '/api',
        dockerfile: 'docker/Dockerfile.prod',
      }),
    );

    const command = deps.remoteExec.execAsync.mock.calls[0][0];
    expect(command).toContain(
      `docker build -t shop-api-x1 -f ${platformHostCode('/api/docker/Dockerfile.prod')} .`,
    );
    expect(command).toContain(`cd ${platformHostCode('/api/docker/')} ||`);
  });

  it('lets dockerContextPath override the build context without moving the Dockerfile', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(
      makeApp({
        buildType: 'dockerfile',
        dockerfile: 'docker/Dockerfile',
        // The tree's own top, on the machine that builds it — the column is
        // taken verbatim, so it has to name the root the clone writes under.
        dockerContextPath: platformHostCode(),
      }),
    );

    const command = deps.remoteExec.execAsync.mock.calls[0][0];
    expect(command).toContain(
      `docker build -t shop-api-x1 -f ${platformHostCode('/docker/Dockerfile')} .`,
    );
    expect(command).toContain(`cd ${platformHostCode()} ||`);
  });

  it('builds a static app from the nginx Dockerfile it generates, ignoring the dockerfile column', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(
      makeApp({
        buildType: 'static',
        publishDirectory: 'dist',
        // A leftover column value from a previous builder must not redirect
        // the build at a Dockerfile the static strategy never wrote.
        dockerfile: 'docker/Dockerfile.prod',
      }),
    );

    const command = deps.remoteExec.execAsync.mock.calls[0][0];
    expect(command).toContain(
      `base64 -d > "${platformHostCode('/Dockerfile')}"`,
    );
    expect(command).toContain(
      `docker build -t shop-api-x1 -f ${platformHostCode('/Dockerfile')} .`,
    );
    expect(command).not.toContain('Dockerfile.prod');
  });

  // The dockerfile fix must not leak a file path into the four builders that
  // take the build directory (the earlier fix changed only how `-f` is resolved).
  it.each([
    ['nixpacks', 'nixpacks build'],
    ['railpack', 'railpack prepare'],
    ['heroku_buildpacks', 'pack build shop-api-x1 --path'],
    ['paketo_buildpacks', 'pack build shop-api-x1 --path'],
  ])(
    'still hands %s the build directory, not a Dockerfile path',
    async (buildType, invocation) => {
      const deps = makeDeps();
      const engine = makeEngine(deps);

      await engine.deploy(
        makeApp({
          buildType: buildType as DeployableApplication['buildType'],
          dockerfile: 'docker/Dockerfile.prod',
        }),
      );

      const command = deps.remoteExec.execAsync.mock.calls[0][0];
      expect(command).toContain(`${invocation} ${platformHostCode()}`);
      expect(command).not.toContain('Dockerfile');
    },
  );

  it('pushes the built image to the registry after the build when a registry is linked', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(
      makeApp({
        registry: {
          registryId: 'reg-1',
          name: 'acme registry',
          imagePrefix: null,
          username: 'pusher',
          password: 'reg-secret',
          url: 'registry.acme.dev',
          registryType: 'cloud',
          organizationId: 'org-1',
        },
      } as Partial<DeployableApplication>),
    );

    const command = deps.remoteExec.execAsync.mock.calls[0][0];
    expect(command).toContain(
      `printf %s "$CG_REGISTRY_PASSWORD_0" | docker login 'registry.acme.dev' -u 'pusher' --password-stdin`,
    );
    // `\:` is `shell-quote`'s wording of a `:`; the shell hands `docker` the
    // same two words it always did (H-34 quoted both — `imageName` is the
    // unconstrained `dockerImage` for a docker source, and `registryTag` is
    // built from the unconstrained `imagePrefix`).
    expect(command).toContain(
      'docker tag shop-api-x1\\:latest registry.acme.dev/pusher/shop-api-x1\\:latest',
    );
    expect(command).toContain(
      'docker push registry.acme.dev/pusher/shop-api-x1\\:latest',
    );
    expect(command.indexOf('nixpacks build')).toBeLessThan(
      command.indexOf('docker push'),
    );
  });

  // The console's *Phases of a Deployment* card names four phases and
  // the log well beside it is the only place any of them reports, but Push
  // wrote nothing without a registry and Update wrote nothing ever — so every
  // log ended on `✅ Nixpacks build completed.` with the release that put the
  // image in front of traffic left silent.
  it('names the Push phase in the log when no registry is set', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(makeApp());

    const command = deps.remoteExec.execAsync.mock.calls[0][0];
    expect(command).toContain(
      "📦 [Push] No registry is set — the image 'shop-api-x1:latest' stays on the Server this deployment ran on.",
    );
    expect(command.indexOf('nixpacks build')).toBeLessThan(
      command.indexOf('[Push]'),
    );
  });

  /**
   * That same fallback line is the only thing the Push phase says on a
   * docker-sourced Application, and it said the wrong thing about it: the
   * Application builds nothing — its "build" is `dockerStrategy`'s
   * `docker pull` — so there is no image that could have been pushed anywhere,
   * and the word it names is the operator's own registry reference, which every
   * Server pulls for itself. "Stays on the Server this deployment ran on" reads
   * as a build that could not be moved, which is the state
   * `assertBuiltImageReachesRunServer` refuses for every *other* source type and
   * explicitly exempts this one from.
   *
   * The phase still reports, for a reason: the console's *Phases of a
   * Deployment* card names Push and the log well beside it is the only place it
   * ever says anything.
   */
  it('reports the Push phase as nothing to push for a docker-sourced application', async () => {
    const deps = makeDeps();

    await makeEngine(deps).deploy(
      makeApp({
        sourceType: 'docker',
        dockerImage: 'ghcr.io/acme/web:1',
        github: null,
        username: null,
        password: null,
        registryUrl: null,
      }),
    );

    const command = deps.remoteExec.execAsync.mock.calls[0][0];
    expect(command).toContain(
      "📦 [Push] Nothing to push — this Application runs 'ghcr.io/acme/web:1' as pulled.",
    );
    expect(command).not.toContain('No registry is set');
  });

  /**
   * The behaviour the push log line sat on top of. With a Registry linked
   * a docker-sourced Application used to log in to it, `docker tag` the pulled
   * image with `getRegistryTag`'s word and `docker push` it — while the
   * converge released `dockerImage` verbatim (`releasedImageName`) and pulled
   * it with the Application's *own* credential (`resolveAuthConfig`'s docker
   * branch), so nothing ever read the pushed tag. The push was bandwidth and
   * somebody's registry storage spent per Deployment on a word no service ran.
   *
   * Asserted on the composed program and on its environment together: a
   * program with no `docker push` but the Registry's password still exported
   * would be a login that outlived the push it was for.
   */
  describe('a linked Registry on a docker-sourced application', () => {
    const BUILD_REGISTRY = {
      ...REGISTRY,
      registryId: 'reg-2',
      username: 'builder',
      password: 'build-reg-secret',
      url: 'registry.build.dev',
    };

    it('is never logged in to, tagged or pushed to', async () => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(
        makeApp({
          sourceType: 'docker',
          dockerImage: 'ghcr.io/acme/web:1',
          github: null,
          registryUrl: 'ghcr.io',
          username: 'acme',
          password: 'pull-secret',
          registry: REGISTRY,
          buildRegistry: BUILD_REGISTRY,
        } as Partial<DeployableApplication>),
      );

      const [command, options] = deps.remoteExec.execAsync.mock.calls[0];
      expect(command).not.toContain('docker push');
      expect(command).not.toContain('docker tag');
      expect(command).not.toContain('Uploading image');
      expect(command).not.toContain('registry.acme.dev');
      expect(command).not.toContain('registry.build.dev');
      expect(command).toContain(
        "📦 [Push] Nothing to push — this Application runs 'ghcr.io/acme/web:1' as pulled.",
      );
      // The pull still logs in, with the Application's own credential.
      expect(command).toContain(
        `printf %s "$CG_SOURCE_REGISTRY_PASSWORD" | docker login 'ghcr.io' -u 'acme'`,
      );
      expect(options?.env?.CG_SOURCE_REGISTRY_PASSWORD).toBe('pull-secret');
      expect(Object.values(options?.env ?? {})).not.toContain('reg-secret');
      expect(Object.values(options?.env ?? {})).not.toContain(
        'build-reg-secret',
      );
    });

    it('is still pushed to by a built application (control)', async () => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(
        makeApp({ registry: REGISTRY } as Partial<DeployableApplication>),
      );

      const [command, options] = deps.remoteExec.execAsync.mock.calls[0];
      expect(command).toContain(
        'docker tag shop-api-x1\\:latest registry.acme.dev/pusher/shop-api-x1\\:latest',
      );
      expect(command).toContain(
        'docker push registry.acme.dev/pusher/shop-api-x1\\:latest',
      );
      expect(command).not.toContain('Nothing to push');
      expect(options?.env?.CG_REGISTRY_PASSWORD_0).toBe('reg-secret');
    });

    it('does not claim a push in the ❌ line when Swarm rolls it back', async () => {
      const deps = makeDeps();
      deps.docker.getService.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          Version: { Index: '17' },
          Spec: { TaskTemplate: { ForceUpdate: 2 } },
          UpdateStatus: { State: 'rollback_started' },
        }),
        update: jest.fn().mockResolvedValue(undefined),
      });

      await expect(
        makeEngine(deps).deploy(
          makeApp({
            sourceType: 'docker',
            dockerImage: 'ghcr.io/acme/web:1',
            github: null,
            registry: REGISTRY,
          } as Partial<DeployableApplication>),
        ),
      ).rejects.toThrow('The image was pulled;');
    });
  });

  it('writes the Update phase into the deployment log around the swarm update', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(makeApp());

    const commands = deps.remoteExec.execAsync.mock.calls.map(
      (call) => call[0],
    );
    expect(appendedLogLines(commands)).toEqual([
      "🚀 [Update] Releasing 'shop-api-x1:latest' as Swarm service 'shop-api-x1'\n",
      "✅ Swarm service 'shop-api-x1' created; 1 of 1 tasks running.\n",
    ]);
    // Same file the build output went to, and nothing in between the release.
    expect(commands[1]).toContain('/etc/cloudgate/logs/shop-api-x1/dep-1.log');
    expect(commands[2]).toContain('/etc/cloudgate/logs/shop-api-x1/dep-1.log');
  });

  /**
   * A Cron service's build is the image each run starts a fresh
   * container from (ADR-0034). Its Build deployment builds and is done; no
   * Swarm service is released, converged on or captured for a rollback.
   */
  it('builds a Cron service and releases nothing', async () => {
    const deps = makeDeps();

    const deployed = await makeEngine(deps).deploy(
      makeApp({ configKind: 'cron', rollbackActive: true }),
    );

    expect(deployed).toBe(true);
    const commands = deps.remoteExec.execAsync.mock.calls.map(
      (call) => call[0],
    );
    expect(commands[0]).toContain('nixpacks build');
    // Pinned to this build: a later build moving `:latest` changes no run.
    expect(commands[1]).toContain(
      'docker tag shop-api-x1\\:latest shop-api-x1\\:build-dep-1 && {',
    );
    expect(deps.db.update).toHaveBeenCalled();
    expect(appendedLogLines(commands)).toEqual([
      "✅ [Build] 'shop-api-x1:build-dep-1' is built; a Cron service starts a fresh container from it for each run, so nothing is released now\n",
    ]);
    expect(deps.dockerFactory.getRemoteDocker).not.toHaveBeenCalled();
    expect(deps.docker.createService).not.toHaveBeenCalled();
    expect(deps.rollbacks.capture).not.toHaveBeenCalled();
    // A build settling never lifts a Cron service's Stop pause.
    expect(deps.applications.updateStatus).toHaveBeenCalledWith(
      'app-1',
      'done',
      { keepCronPause: true },
    );
    expect(deps.recorder.updateStatus).toHaveBeenCalledWith('dep-1', 'done');
    expect(deps.notifier.buildSuccess).toHaveBeenCalled();
  });

  /**
   * A Cron service pulled from or pushed to a registry runs the
   * registry's digest of its last successful build, matched by repository.
   */
  it.each([
    ['nginx:1.27', '["nginx@sha256:abc"]', 'nginx@sha256:abc'],
    [
      'docker.io/library/nginx:1.27',
      '["nginx@sha256:abc"]',
      'docker.io/library/nginx@sha256:abc',
    ],
    [
      'registry.example.com:5000/acme/report:latest',
      '["other/report@sha256:no","registry.example.com:5000/acme/report@sha256:def"]',
      'registry.example.com:5000/acme/report@sha256:def',
    ],
    ['acme/report:latest', '[]', null],
    ['acme/report:latest', '', null],
  ])('pins %s by its digest among %s', (image, repoDigests, pinned) => {
    expect(digestOf(image, repoDigests)).toBe(pinned);
  });

  /**
   * The Update line announced {@link builtImageName}'s answer — the tag
   * the *build* left on the build host — while the converge names
   * `getImageName`'s, which with a linked Registry carries that registry's host
   * and prefix. So the operator read `Releasing 'shop-api-x1:latest'` off a
   * Deployment whose `docker service inspect` said
   * `registry.acme.dev/pusher/shop-api-x1:latest`, and the one line in the log
   * that names the released image named an image the service never ran.
   *
   * Asserted as an equality between the two words that reach the wire — the
   * decoded log line and the `Image` of the spec handed to the daemon — rather
   * than as a literal on each side, because two literals stay green under a
   * change to either: `built-image.ts` records that exact drift for the same
   * pair of dispatches (§1.7). The literal is here as well, once per case, to
   * say *which* image is right where the equality only says the two agree.
   */
  it.each([
    { linked: 'no registry', overrides: {}, image: 'shop-api-x1:latest' },
    {
      linked: 'a push registry',
      overrides: { registry: REGISTRY } as Partial<DeployableApplication>,
      image: 'registry.acme.dev/pusher/shop-api-x1:latest',
    },
  ])(
    'names the image the service is released onto in the Update line, with $linked',
    async ({ overrides, image }) => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(makeApp(overrides));

      // `createService` takes the auth blob first when there is one, so the
      // spec is the last argument on either branch.
      const created = deps.docker.createService.mock.calls[0];
      const spec = created[created.length - 1] as {
        TaskTemplate: { ContainerSpec: { Image: string } };
      };
      const released = spec.TaskTemplate.ContainerSpec.Image;
      const [update] = appendedLogLines(
        deps.remoteExec.execAsync.mock.calls.map((call) => call[0]),
      );

      expect(released).toBe(image);
      expect(update).toBe(
        `🚀 [Update] Releasing '${released}' as Swarm service 'shop-api-x1'\n`,
      );
    },
  );

  it('reports the service as updated in the log when the swarm service already exists', async () => {
    const deps = makeDeps();
    deps.docker.getService.mockReturnValue({
      inspect: jest.fn().mockResolvedValue({
        Version: { Index: '17' },
        Spec: { TaskTemplate: { ForceUpdate: 2 } },
      }),
      update: jest.fn().mockResolvedValue(undefined),
    });
    const engine = makeEngine(deps);

    await engine.deploy(makeApp());

    expect(deps.docker.createService).not.toHaveBeenCalled();
    expect(
      appendedLogLines(
        deps.remoteExec.execAsync.mock.calls.map((call) => call[0]),
      ),
    ).toContain(
      "✅ Swarm service 'shop-api-x1' updated; 1 of 1 tasks running.\n",
    );
  });

  /**
   * The convergence poll's failure half. Swarm admitting to a rollback is an
   * *observation*, so it takes the same path a failed build takes — the sentence
   * into the log, `error` on the row, `buildError` to whoever subscribed — and it says what
   * is serving, because the image built and pushed and only the release failed.
   */
  it('fails the Deployment when Swarm rolls the service back', async () => {
    const deps = makeDeps();
    deps.docker.getService.mockReturnValue({
      inspect: jest.fn().mockResolvedValue({
        Version: { Index: '17' },
        Spec: { TaskTemplate: { ForceUpdate: 2 } },
        UpdateStatus: { State: 'rollback_started' },
      }),
      update: jest.fn().mockResolvedValue(undefined),
    });
    deps.docker.listTasks.mockResolvedValue([
      {
        Status: {
          State: 'failed',
          Err: 'task: non-zero exit (1)',
          Timestamp: '2026-08-24T00:00:00Z',
        },
      },
    ]);
    const engine = makeEngine(deps);

    await expect(engine.deploy(makeApp())).rejects.toThrow(
      'Swarm rolled it back to its previous spec',
    );

    expect(deps.recorder.updateStatus).toHaveBeenCalledWith('dep-1', 'error');
    expect(deps.notifier.buildSuccess).not.toHaveBeenCalled();
    const [notified] = deps.notifier.buildError.mock.calls[0];
    // The task's own sentence rides along, since it is the only thing that
    // says *why* the release did not take.
    expect(notified.errorMessage).toContain(
      'what is serving is the Deployment before this one. task: non-zero exit (1)',
    );
  });

  /**
   * At the layer the operator sees: an unresolvable `${{…}}` reference
   * fails the Deployment, and the resolver's sentence is the only line the log
   * carries about why — so it has to reach the log whole, naming the variable
   * that holds the reference and that the key is not set.
   */
  it('writes the unset-reference sentence into the log when a variable refers to a missing Environment key', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await expect(
      engine.deploy(
        makeApp({
          sourceType: 'docker',
          dockerImage: 'traefik/whoami',
          github: null,
          env: 'X=${{environment.UI_NOPE}}',
        }),
      ),
    ).rejects.toThrow();

    const sentence =
      'X refers to ${{environment.UI_NOPE}}, but UI_NOPE is not set on the Environment. Set it on the Environment, or change the reference.';
    const commands = deps.remoteExec.execAsync.mock.calls.map(([c]) => c);
    expect(appendedLogLines(commands)).toContain(`${sentence}\n`);
    expect(deps.recorder.updateStatus).toHaveBeenCalledWith('dep-1', 'error');
    expect(deps.docker.createService).not.toHaveBeenCalled();
  });

  /**
   * **The generation boundary at the layer the operator sees.**
   * `mechanizeDockerContainer`'s own `'created' | 'updated'` is threaded into the
   * poll, and on an `updated` release the poll may not answer off the generation
   * it is replacing.
   *
   * The service already exists, Swarm says `updating`, and the only
   * desired-running task predates `UpdateStatus.StartedAt` — which is exactly
   * what an update looks like on iteration 0 with the shipped default
   * `Order: 'start-first'`. Before the fix this logged
   * `✅ … 1 of 1 tasks running.` and recorded `done` while Swarm was still
   * deciding. If `released` stops reaching `awaitConvergence`, it does so again
   * and this test says so.
   */
  it('does not report an update converged off the generation it replaces', async () => {
    jest.useFakeTimers();
    try {
      const deps = makeDeps();
      deps.docker.getService.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          Version: { Index: '17' },
          Spec: { TaskTemplate: { ForceUpdate: 2 } },
          UpdateStatus: {
            State: 'updating',
            StartedAt: '2026-08-24T12:37:03.940Z',
          },
        }),
        update: jest.fn().mockResolvedValue(undefined),
      });
      deps.docker.listTasks.mockResolvedValue([
        {
          CreatedAt: '2026-08-24T12:36:00.000000000Z',
          Status: { State: 'running', Timestamp: '2026-08-24T12:36:00Z' },
        },
      ]);
      const engine = makeEngine(deps);

      const deployed = engine.deploy(makeApp());
      await jest.advanceTimersByTimeAsync(90_000);
      await deployed;

      expect(deps.docker.createService).not.toHaveBeenCalled();
      const lines = appendedLogLines(
        deps.remoteExec.execAsync.mock.calls.map((call) => call[0]),
      );
      expect(lines).toContain(
        "⚠️ Swarm service 'shop-api-x1' updated; 0 of 1 tasks running after 90s. Convergence was not confirmed.\n",
      );
      expect(lines).not.toContain(
        "✅ Swarm service 'shop-api-x1' updated; 1 of 1 tasks running.\n",
      );
      // An unconfirmed wait is still `done` — the convergence decision is untouched.
      expect(deps.recorder.updateStatus).toHaveBeenCalledWith('dep-1', 'done');
      expect(deps.notifier.buildError).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The convergence decision, at the level it is visible: a budget that ran out with
   * nothing converged and nothing failed is **`done`**, with a ⚠️ line saying
   * so. Inventing a failure from a stopwatch would fire `buildError` at real
   * people about a Deployment that may be perfectly fine, and the operator
   * would have no way to walk the notification back.
   */
  it('leaves a Deployment done when the wait runs out with nothing to report', async () => {
    jest.useFakeTimers();
    try {
      const deps = makeDeps();
      // Nothing ever comes up, and no task carries an error to observe.
      deps.docker.listTasks.mockResolvedValue([]);
      const engine = makeEngine(deps);

      const deployed = engine.deploy(makeApp());
      // One replica with no health check is the 60s floor plus one 30s batch.
      await jest.advanceTimersByTimeAsync(90_000);
      await deployed;

      expect(
        appendedLogLines(
          deps.remoteExec.execAsync.mock.calls.map((call) => call[0]),
        ),
      ).toContain(
        "⚠️ Swarm service 'shop-api-x1' created; 0 of 1 tasks running after 90s. Convergence was not confirmed.\n",
      );
      expect(deps.recorder.updateStatus).toHaveBeenCalledWith('dep-1', 'done');
      expect(deps.notifier.buildError).not.toHaveBeenCalled();
      expect(deps.notifier.buildSuccess).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The other half of that decision: a spent budget in which **every** task in
   * the new generation carries an `Err` is an observation, not a clock, so it
   * is `error` — and it still reports through the ⚠️ line, because what the
   * poll saw is a wait that ran out, with the tasks' own sentence attached.
   */
  it('fails the Deployment when the wait runs out and every task carries an error', async () => {
    jest.useFakeTimers();
    try {
      const deps = makeDeps();
      deps.docker.listTasks.mockResolvedValue([
        {
          Status: {
            State: 'failed',
            Err: 'task: non-zero exit (1)',
            Timestamp: '2026-08-24T00:00:00Z',
          },
        },
      ]);
      const engine = makeEngine(deps);

      // The assertion is attached before the timers run: the rejection lands
      // mid-advance, and an unhandled one fails the run rather than the test.
      const asserted = expect(engine.deploy(makeApp())).rejects.toThrow(
        'Convergence was not confirmed',
      );
      await jest.advanceTimersByTimeAsync(90_000);
      await asserted;

      expect(deps.recorder.updateStatus).toHaveBeenCalledWith('dep-1', 'error');
      expect(deps.notifier.buildError).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the registry push lines and adds the Update lines after them', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(
      makeApp({
        registry: {
          registryId: 'reg-1',
          name: 'acme registry',
          imagePrefix: null,
          username: 'pusher',
          password: 'reg-secret',
          url: 'registry.acme.dev',
          registryType: 'cloud',
          organizationId: 'org-1',
        },
      } as Partial<DeployableApplication>),
    );

    const commands = deps.remoteExec.execAsync.mock.calls.map(
      (call) => call[0],
    );
    expect(commands[0]).toContain('✅ Image Pushed');
    // The no-registry line is the *fallback*, not an extra line beside a push.
    expect(commands[0]).not.toContain('No registry is set');
    expect(appendedLogLines(commands)).toHaveLength(2);
  });

  it('appends the Update lines to the log on the build server, not the run server', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    // With a Registry, because that is the only shape of this configuration
    // that deploys at all.
    await engine.deploy(
      makeApp({
        serverId: 'srv-run',
        buildServerId: 'srv-build',
        registry: REGISTRY,
      } as Partial<DeployableApplication>),
    );

    // The log file lives on the server that built; the release talks to the
    // run server's daemon, but its lines belong in that one file.
    const targets = deps.remoteExec.execAsyncRemote.mock.calls.map(
      (call) => call[0],
    );
    expect(targets).toEqual(['srv-build', 'srv-build', 'srv-build']);
    expect(deps.remoteExec.execAsync).not.toHaveBeenCalled();
  });

  it('releases the service and reports success after a clean build', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(makeApp());

    expect(deps.docker.createService).toHaveBeenCalledTimes(1);
    expect(deps.applications.updateStatus).toHaveBeenCalledWith(
      'app-1',
      'done',
      { keepCronPause: true },
    );
    expect(deps.recorder.updateStatus).toHaveBeenCalledWith('dep-1', 'done');
    expect(deps.notifier.buildSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: 'Shop',
        applicationName: 'Shop API',
        environmentName: 'production',
        organizationId: 'org-1',
      }),
    );
    expect(deps.notifier.buildError).not.toHaveBeenCalled();
  });

  it('marks the deployment failed, logs the error, and notifies when the build breaks', async () => {
    const deps = makeDeps();
    deps.remoteExec.execAsync
      .mockRejectedValueOnce(new Error('nixpacks exploded'))
      .mockResolvedValue(ok);
    const engine = makeEngine(deps);

    await expect(engine.deploy(makeApp())).rejects.toThrow('nixpacks exploded');

    expect(deps.docker.createService).not.toHaveBeenCalled();
    expect(deps.applications.updateStatus).toHaveBeenCalledWith(
      'app-1',
      'error',
      { keepCronPause: true },
    );
    expect(deps.recorder.updateStatus).toHaveBeenCalledWith('dep-1', 'error');
    expect(deps.notifier.buildError).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationName: 'Shop API',
        errorMessage: 'nixpacks exploded',
      }),
    );
    expect(deps.notifier.buildSuccess).not.toHaveBeenCalled();

    const errorLogCommand = deps.remoteExec.execAsync.mock.calls[1][0];
    expect(errorLogCommand).toContain('Error occurred ❌');
    expect(errorLogCommand).toContain(
      '/etc/cloudgate/logs/shop-api-x1/dep-1.log',
    );
    // The failure branch keeps the last word: no Update line claims a release
    // that never happened, and the message is the only line appended.
    expect(
      appendedLogLines(
        deps.remoteExec.execAsync.mock.calls.map((call) => call[0]),
      ),
    ).toEqual(['nixpacks exploded\n']);
  });

  it('deploys the service onto the run server even when built elsewhere', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    // The Registry is not incidental to this scenario, it is what makes it a
    // scenario: a build Server with no Registry leaves the built image on the
    // build Server and is refused before the clone (below).
    await engine.deploy(
      makeApp({
        serverId: 'srv-run',
        buildServerId: 'srv-build',
        registry: REGISTRY,
      } as Partial<DeployableApplication>),
    );

    expect(deps.remoteExec.execAsyncRemote.mock.calls[0][0]).toBe('srv-build');
    expect(deps.dockerFactory.getRemoteDocker).toHaveBeenCalledWith('srv-run');
  });

  /**
   * The second out-of-scope finding of the rollback-image work, and the larger half of it.
   *
   * With a dedicated build Server the image is built *there* as
   * `${appName}:latest`, and `uploadImageCommands` is the only thing that moves
   * it anywhere — it pushes `getRegistryTag(...)`, and only when a Registry is
   * linked. With none it emits its "No registry is set" line and nothing else,
   * and the converge on `application.serverId` then names a bare
   * `${appName}:latest` that machine has never had. So a build Server without a
   * Registry does not merely lose rollbacks: it cannot deploy.
   *
   * **What it did instead is why this is a refusal and not a warning.** A bare
   * reference is not "missing" to the daemon: Docker normalizes a
   * single-component name to `docker.io/library/<appName>:latest`, so the run
   * Server pulls the Docker Official Image of that name if one exists. `appName`
   * is caller-supplied — `createApplicationSchema` holds it to `APP_NAME_REGEX`
   * and nothing else — so an Application named `redis`, `nginx` or `wordpress`
   * released a stranger's image under this Application's name, network, mounts,
   * routers and `env`, `awaitConvergence` saw its tasks come up, and the
   * Deployment was recorded `done`. A green deploy of software nobody here built
   * is not something an operator can be expected to notice.
   */
  it('refuses to deploy an application built on a dedicated build server with no registry linked, naming the missing registry', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await expect(
      engine.deploy(
        makeApp({ serverId: 'srv-run', buildServerId: 'srv-build' }),
      ),
    ).rejects.toThrow(/registry/i);

    // Nothing converged: the run Server was never asked for a Docker handle, so
    // no service spec naming an image it has never had reached the daemon.
    expect(deps.dockerFactory.getRemoteDocker).not.toHaveBeenCalled();
    expect(deps.docker.createService).not.toHaveBeenCalled();
    expect(deps.docker.getService).not.toHaveBeenCalled();
    // And no build ran either — the refusal is in front of the first shell
    // step, so it costs neither a clone nor a nixpacks run on the build Server.
    const commands = deps.remoteExec.execAsyncRemote.mock.calls.map(
      (call) => call[1],
    );
    expect(
      commands.some((command) =>
        command.includes('git -c protocol.file.allow=never clone'),
      ),
    ).toBe(false);
    expect(commands.some((command) => command.includes('nixpacks build'))).toBe(
      false,
    );

    // The reason is where a failed Deployment is read: its own log, on the
    // Server that holds it, and the notification.
    expect(deps.remoteExec.execAsyncRemote.mock.calls[0][0]).toBe('srv-build');
    const line = appendedLogLines(commands).join('\n');
    expect(line).toContain('dedicated build Server');
    expect(line).toContain('no registry is set');
    expect(line).toContain('docker.io/library/shop-api-x1:latest');
    expect(deps.recorder.updateStatus).toHaveBeenCalledWith('dep-1', 'error');
    expect(deps.applications.updateStatus).toHaveBeenCalledWith(
      'app-1',
      'error',
      { keepCronPause: true },
    );
    const [[notified]] = deps.notifier.buildError.mock.calls;
    expect(notified.errorMessage).toContain('registry');
    expect(deps.notifier.buildSuccess).not.toHaveBeenCalled();
  });

  it('deploys an application built on a dedicated build server when a build registry alone is linked', async () => {
    // `uploadImageCommands` pushes through either registry and `getImageName`
    // resolves `registry ?? buildRegistry`, so the two agree on the tag the run
    // Server pulls — either one alone makes the built image reachable.
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(
      makeApp({
        serverId: 'srv-run',
        buildServerId: 'srv-build',
        buildRegistry: REGISTRY,
      } as Partial<DeployableApplication>),
    );

    expect(deps.dockerFactory.getRemoteDocker).toHaveBeenCalledWith('srv-run');
    expect(deps.notifier.buildSuccess).toHaveBeenCalled();
  });

  it('deploys a docker-sourced application on a dedicated build server with no registry, because nothing was built to move', async () => {
    // The exemption, and the reason the refusal is not at the DTO: a docker
    // source builds nothing. `dockerStrategy.clone` is a `docker pull`, and the
    // converge runs `dockerImage` verbatim with the Application's own pull
    // credential, so the run Server fetches the image from where it already
    // lives. `rollbacks.e2e-spec.ts` deploys exactly this configuration.
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await engine.deploy(
      makeApp({
        serverId: 'srv-run',
        buildServerId: 'srv-build',
        sourceType: 'docker',
        dockerImage: 'registry.example.com/acme/web:1',
      }),
    );

    expect(deps.dockerFactory.getRemoteDocker).toHaveBeenCalledWith('srv-run');
    expect(deps.notifier.buildSuccess).toHaveBeenCalled();
  });

  /**
   * A second out-of-scope finding of the rollback work. `captureRollback` preserves the
   * released image with a `docker tag … ${appName}:v${version}` on the **build**
   * server, and `RollbacksService.rollback` converges onto that tag through a
   * Docker handle taken from the Application's own `serverId`. The two are the
   * same machine on a single-Server install and the tag is reachable; with a
   * dedicated build Server they are not, and nothing carries a *local* tag
   * across — `uploadImageCommands` pushes `getRegistryTag`, a different name,
   * and only when a Registry is linked at all.
   *
   * So the snapshot was captured, the row was offered in the console, and the
   * rollback failed at the one moment it was wanted: the converge is accepted
   * (nothing in `rollback` polls for convergence), and the run Server's tasks
   * then fail pulling `docker.io/library/<appName>` — a *bare* tag is Docker
   * Hub, which is the sibling defect an earlier fix fixed the credential half of.
   *
   * Refusing at capture time is the answer taken, because the operator learns
   * on the Deployment that produced the unusable snapshot rather than during an
   * incident. The two alternatives are in the ticket: tagging on the run Server
   * cannot work — `capture` runs *before* the converge, so the released image
   * is not on the run Server yet and may land on any node of its Swarm — and
   * pushing a `:v${version}` tag to the Application's Registry is a write into
   * somebody's registry, with a per-Deployment storage cost they did not ask
   * for, and would put a registry reference on the pinned path that fix just
   * stopped carrying a credential.
   */
  it('captures no rollback snapshot when the image is built on a dedicated build server, and says so in the log', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    // With a Registry, because the reachability check refuses this configuration
    // without one before capture is ever reached — and a Registry does not rescue the
    // snapshot, which is the point: `uploadImageCommands` pushes
    // `getRegistryTag(...)`, a different name from the `:v<version>` tag
    // `captureRollback` would make.
    await engine.deploy(
      makeApp({
        serverId: 'srv-run',
        buildServerId: 'srv-build',
        rollbackActive: true,
        registry: REGISTRY,
      } as Partial<DeployableApplication>),
    );

    expect(deps.rollbacks.capture).not.toHaveBeenCalled();
    const commands = deps.remoteExec.execAsyncRemote.mock.calls.map(
      (call) => call[1],
    );
    // No *version* tag was made anywhere, on either server: a preserved image
    // with no row pointing at it is disk the operator can never reclaim through
    // the console. The push's own `docker tag` is a different name and is the
    // thing that makes this Application deployable at all.
    expect(
      commands.some((command) => command.includes('shop-api-x1\\:v')),
    ).toBe(false);
    expect(deps.remoteExec.execAsync).not.toHaveBeenCalled();
    // And the reason is in the Deployment's own log, where an operator who
    // turned capture on will look for the snapshot it did not leave.
    const lines = appendedLogLines(commands);
    expect(
      lines.some(
        (line) =>
          line.includes('[Rollback]') &&
          line.includes('dedicated build Server'),
      ),
    ).toBe(true);
  });

  it('captures a rollback snapshot when the service runs on the server that built it', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);
    const app = makeApp({ serverId: 'srv-run', rollbackActive: true });

    await engine.deploy(app);

    expect(deps.rollbacks.capture).toHaveBeenCalledWith('dep-1', app);
    const commands = deps.remoteExec.execAsyncRemote.mock.calls.map(
      (call) => call[1],
    );
    expect(
      commands.some((command) =>
        command.includes('docker tag shop-api-x1\\:latest shop-api-x1\\:v1'),
      ),
    ).toBe(true);
  });
});

/**
 * H-34. Two different values reach the shell strings this service builds, and
 * both went in bare:
 *
 * - `deployment.logPath`, in six `>> …` redirects, which is machine-made and
 *   was therefore the H-19 shape — a mint two modules away, correct today,
 *   uncheckable from the line that relies on it.
 * - `dockerImage`, through `builtImageName`, in `docker tag`, `docker push` and
 *   the two `echo`s beside them. `updateApplicationSchema` types that column
 *   `z.string().nullable()`, so nothing constrained it anywhere and the sink
 *   was live.
 *
 * The payload is fed straight into the values rather than through a `PATCH`
 * both because the second half of that is `applications`' e2e and because the
 * claim under test is that the command builder is safe on its own.
 */
/** The smallest raw stack `deployCompose` will take — a copy of the quoting
 * describe's own `makeCompose`, hoisted here because two top-level describes
 * now need it. */
const makeComposeStack = (
  overrides: Partial<DeployableCompose> = {},
): DeployableCompose =>
  ({
    composeId: 'cmp-1',
    name: 'Shop stack',
    appName: 'shop-stack-x1',
    sourceType: 'raw',
    composeType: 'docker-compose',
    composeFile: 'services:\n  web:\n    image: nginx\n',
    composePath: './docker-compose.yml',
    env: '',
    serverId: null,
    environment: {
      environmentId: 'env-1',
      name: 'production',
      env: '',
      project: {
        projectId: 'proj-1',
        name: 'Shop',
        env: '',
        organizationId: 'org-1',
      },
    },
    ...overrides,
  }) as unknown as DeployableCompose;

/**
 * `deployCompose`'s clone, and the one character that keeps a program from
 * truncating and reporting success.
 *
 * `RemoteExecService.buildEnvScript` documents the failure at length: a program
 * that carries an environment cannot travel as the SSH `exec` request, so it
 * goes as a script on `sh -s`'s **stdin** — and a command inside it that reads
 * stdin then consumes the rest of the script. Under bash a script of
 * `echo one`, `cat`, `echo two` runs the first, hands the third to `cat`, and
 * exits **0** having skipped it. `deploy` closes that with `< /dev/null` on the
 * subshell it already wraps its steps in; the compose clone did not.
 *
 * **Latent, and closed pre-emptively for that reason rather than in spite of
 * it.** `clone.env` is empty for every `sourceType` `updateComposeSchema`
 * admits — `docker` is the only strategy that fills one and the DTO does not
 * admit it — so nothing takes the path today. The redirect costs an
 * empty-environment program nothing at all, and the failure it forecloses is
 * silent, so waiting for the first compose source type that carries a
 * credential means waiting for a deploy that lies about having worked.
 */
describe('DeploymentEngineService.deployCompose', () => {
  /** For a stack: its `.env` carries every generated secret. */
  it('closes the stack directory before the clone writes into it', async () => {
    const deps = makeDeps();

    await makeEngine(deps).deployCompose(makeComposeStack());

    const stack = `${cloudgateDirectoryOn(null)}/compose/shop-stack-x1`;
    const [clone] = deps.remoteExec.execAsync.mock.calls.map((call) => call[0]);
    // Second in the program, behind only the host line, which writes to
    // the log and not into the directory.
    expect(clone).toMatch(
      new RegExp(
        `^\\(set -e;\\necho [^\\n]+ ;\\nmkdir -p ${stack} && chmod 700 ${stack};\\n`,
      ),
    );
  });

  it('feeds the clone subshell no stdin, so a program with an environment cannot swallow its own script', async () => {
    const deps = makeDeps();

    await makeEngine(deps).deployCompose(makeComposeStack());

    const [clone] = deps.remoteExec.execAsync.mock.calls.map((call) => call[0]);
    expect(clone.startsWith('(set -e;')).toBe(true);
    // On the subshell, after the log redirection and before anything else —
    // the same shape `deploy` carries, so the outer shell goes on reading the
    // script while nothing inside the parentheses can read from it.
    expect(clone.endsWith('2>&1 < /dev/null')).toBe(true);
  });

  /**
   * The reason it is a `deployCompose` test rather than a
   * `compose.utils` one: what the refusal has to be is *early*.
   *
   * `volumes: {}` parses, so it reached the clone — which `rm -rf`s the project
   * directory and writes the file — and Docker then answered
   * `no service selected` over two containers that were still running from the
   * previous file. The stack went `error` and its directory no longer described
   * what was on the host. `parseComposeFileOrThrow` refuses it now, and the
   * refusal lands where an earlier fix put the raw injection: in front of the first
   * write, which is the only position that makes the withheld status honest.
   */
  it('refuses a raw stack whose file declares no services before it touches the target, and leaves the stack status alone', async () => {
    const deps = makeDeps();

    await expect(
      makeEngine(deps).deployCompose(
        makeComposeStack({ composeFile: 'volumes: {}\n' }),
      ),
    ).rejects.toThrow(
      'The compose file declares no services, so there is nothing to deploy',
    );

    const commands = deps.remoteExec.execAsync.mock.calls.map(
      (call) => call[0],
    );
    // Nothing addressed the stack at all. The clone writes under
    // `…/compose/shop-stack-x1/code` and the build runs `docker compose -p
    // shop-stack-x1`, so the stack's own name appearing in no command is the
    // whole of "the project directory is unchanged" — asserted on the name
    // rather than on a path this test would otherwise compute the way the code
    // computes it (§1.7).
    expect(commands.some((command) => command.includes('shop-stack-x1'))).toBe(
      false,
    );
    expect(commands.some((command) => command.includes('docker compose'))).toBe(
      false,
    );
    // The one command that did run is the error line appended to the Deployment
    // log, which is the record of the attempt and not a write to the target.
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('/dep-1.log');

    // The Deployment is `error` and the operator is notified, with the
    // cause named rather than Docker's `no service selected`; the stack keeps
    // whatever status it had, because nothing about it changed.
    expect(deps.composeService.updateStatus).not.toHaveBeenCalled();
    expect(deps.recorder.updateStatus).toHaveBeenCalledWith('dep-1', 'error');
    expect(deps.notifier.buildError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage:
          'The compose file declares no services, so there is nothing to deploy',
      }),
    );
  });
});

/**
 * Which **root** a compose stack's project tree is written under, and why the
 * environment variable has to be set for any of it to mean anything.
 *
 * `deployCompose`'s `codeDirectory` resolved `composeDirectory()` — this
 * process's own `CLOUDGATE_DIRECTORY` — for every machine alike, while the
 * clone it feeds is dispatched to `compose.serverId`, whose tree
 * `serverSetupCommand` laid out at `REMOTE_CLOUDGATE_DIRECTORY`. With the
 * variable unset the two roots are the *same literal*, so every pre-existing
 * assertion about these commands passes whichever root is resolved — the root change's
 * headline measurement one directory along, and the whole reason this class is
 * invisible. So each test here sets the variable and names the *resolved* temp
 * path: `/etc/cloudgate` exists and is writable on some development hosts, and
 * a silent fall back to the default would read as a pass.
 *
 * This file holds the **writer** and the reader in the same program. The
 * destroyers — `composeTeardownCommand`'s `rm -rf`, `ComposeService`'s `stop`
 * and Remove containers, `MountsService`'s file write and its `rm -rf` — are
 * held to this one in `test/compose/compose-tree-roots.e2e-spec.ts`, which
 * takes its expectation from this clone's own dispatch rather than restating
 * it.
 */
describe('DeploymentEngineService.deployCompose, on the root it writes the project tree under', () => {
  const configured = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-compose-root-')),
  );
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeEach(() => {
    process.env.CLOUDGATE_DIRECTORY = configured;
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
  });

  afterAll(() => {
    fs.rmSync(configured, { recursive: true, force: true });
  });

  /** The stack above, on a named Server rather than the platform host. */
  const onServer = (): DeployableCompose => ({
    ...makeComposeStack(),
    serverId: 'srv-stack',
  });

  it('writes and deploys a Server’s stack under that Server’s own root', async () => {
    const deps = makeDeps();

    await makeEngine(deps).deployCompose(onServer());

    const dispatched = deps.remoteExec.execAsyncRemote.mock.calls;
    // One machine, not two: `findCompose` hard-codes `buildServerId: null`, so
    // a stack's run Server is also its build host.
    expect(new Set(dispatched.map(([serverId]) => serverId))).toEqual(
      new Set(['srv-stack']),
    );
    expect(deps.remoteExec.execAsync).not.toHaveBeenCalled();
    const tree = `${REMOTE_CLOUDGATE_DIRECTORY}/compose/shop-stack-x1/code`;
    // The clone writes it and the build command reads it back, in two separate
    // dispatches — a root that forked between them would deploy an empty
    // directory, which is why the whole set is one change.
    expect(dispatched[0][1]).toContain(tree);
    expect(dispatched.some(([, command]) => command.includes(tree))).toBe(true);
    for (const [, command] of dispatched) {
      expect(command).not.toContain(configured);
    }
  });

  // The branch that has to keep working: a stack on the platform host is
  // deployed where this process can write, which is the whole reason
  // CLOUDGATE_DIRECTORY exists.
  it('keeps a platform-host stack under this instance’s configured root', async () => {
    const deps = makeDeps();

    await makeEngine(deps).deployCompose(makeComposeStack());

    expect(deps.remoteExec.execAsyncRemote).not.toHaveBeenCalled();
    const commands = deps.remoteExec.execAsync.mock.calls.map(([c]) => c);
    expect(commands[0]).toContain(`${configured}/compose/shop-stack-x1/code`);
    for (const command of commands) {
      expect(command).not.toContain(`${REMOTE_CLOUDGATE_DIRECTORY}/compose`);
    }
  });
});

/**
 * Which machine the engine tells `PatchService` the clone is on — the parameter
 * an earlier fix added, and the half of that conversion this file can see.
 *
 * `generateApplyPatchesCommand` roots the block it emits on the id passed here,
 * and it cannot derive that id: `findParentService` projects a Service's run
 * Server and no `buildServerId`, so an Application built on a dedicated Server
 * would have been given the runner. The two answers differ only when a build
 * Server is configured, which is exactly the install the defect is reachable
 * on.
 *
 * The block's own root-from-serverId half is `PatchService`'s and is asserted
 * against a real database in `test/patch/patch.e2e-spec.ts`.
 */
describe('DeploymentEngineService, on the machine it says a patch applies to', () => {
  it('names the build host for an Application, never the run Server', async () => {
    const deps = makeDeps();

    await makeEngine(deps).deploy(
      makeApp({
        serverId: 'srv-run',
        buildServerId: 'srv-build',
        registry: REGISTRY,
      } as Partial<DeployableApplication>),
    );

    expect(deps.patchService.generateApplyPatchesCommand).toHaveBeenCalledWith({
      id: 'app-1',
      type: 'application',
      serverId: 'srv-build',
    });
  });

  it('names the stack’s own Server for a Compose stack', async () => {
    const deps = makeDeps();
    // A git-sourced stack's compose file is read back off the machine with
    // argv rather than a shell word, which is the one `execOnServer`
    // route `makeDeps` does not otherwise need.
    (deps.remoteExec as unknown as { execRemote: jest.Mock }).execRemote = jest
      .fn()
      .mockResolvedValue({
        ...ok,
        stdout: 'services:\n  web:\n    image: nginx\n',
      });

    // Git-sourced, because the patch step is skipped for a `raw` stack —
    // there is no repository to patch.
    await makeEngine(deps).deployCompose({
      ...makeComposeStack(),
      serverId: 'srv-stack',
      sourceType: 'git',
      customGitUrl: 'https://git.example.com/acme/shop.git',
      customGitBranch: 'main',
      customGitSSHKey: null,
      enableSubmodules: false,
    } as unknown as DeployableCompose);

    expect(deps.patchService.generateApplyPatchesCommand).toHaveBeenCalledWith({
      id: 'cmp-1',
      type: 'compose',
      serverId: 'srv-stack',
    });
  });
});

/**
 * Which **root** a build writes its source tree under, and the reason this
 * needs the environment variable set to prove anything at all (the root audit's
 * atomic half).
 *
 * `codeDirectory` resolved through `applicationsDirectory()` — this process's
 * own `CLOUDGATE_DIRECTORY` — for every machine, including a Server that the
 * build was dispatched to and whose tree `serverSetupCommand` laid out at
 * `REMOTE_CLOUDGATE_DIRECTORY`. `cloudgate-directory.ts` states the rule the
 * other way round in as many words: *"every path baked into a command sent over
 * SSH … has to be that literal, whatever this instance's own layout is"*.
 *
 * **With the variable unset the two roots are the same string, so none of these
 * assertions can fail.** That is why nothing has broken and why nothing would
 * have caught it: the root audit measured the same shape one directory along — aiming the
 * log-retention sweep at the local root for every machine reds one e2e test
 * with `CLOUDGATE_DIRECTORY` set and **zero** with it unset. So every test here
 * sets it, and each names the *resolved* temp path, because `/etc/cloudgate`
 * exists and is writable on some development hosts and a silent fall back to
 * the default would otherwise read as a pass.
 */
describe('DeploymentEngineService.deploy, on the root it writes the source tree under', () => {
  const configured = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-engine-root-')),
  );
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeEach(() => {
    process.env.CLOUDGATE_DIRECTORY = configured;
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
  });

  afterAll(() => {
    fs.rmSync(configured, { recursive: true, force: true });
  });

  /**
   * The live half. A Registry is not incidental: it is the only shape of a
   * dedicated build Server that deploys at all, which is also why this
   * configuration is reachable rather than hypothetical.
   */
  it('dispatches a build Server’s clone under that Server’s own root', async () => {
    const deps = makeDeps();

    await makeEngine(deps).deploy(
      makeApp({
        serverId: 'srv-run',
        buildServerId: 'srv-build',
        registry: REGISTRY,
      } as Partial<DeployableApplication>),
    );

    const [serverId, command] = deps.remoteExec.execAsyncRemote.mock.calls[0];
    // The machine was already right; the root was not.
    expect(serverId).toBe('srv-build');
    expect(command).toContain(
      `${REMOTE_CLOUDGATE_DIRECTORY}/applications/shop-api-x1/code`,
    );
    // And not one word of this instance's own layout reaches a machine that
    // has never heard of it.
    expect(command).not.toContain(configured);
  });

  // The build reads the tree the clone wrote, in the same program, so a root
  // that forked between the two would be a build of an empty directory.
  it('gives the clone and the build on a build Server the same root', async () => {
    const deps = makeDeps();

    await makeEngine(deps).deploy(
      makeApp({
        serverId: 'srv-run',
        buildServerId: 'srv-build',
        registry: REGISTRY,
      } as Partial<DeployableApplication>),
    );

    const command = deps.remoteExec.execAsyncRemote.mock.calls[0][1];
    const tree = `${REMOTE_CLOUDGATE_DIRECTORY}/applications/shop-api-x1/code`;
    expect(command).toContain(`git -c protocol.file.allow=never clone`);
    expect(command).toContain(`nixpacks build ${tree} --name shop-api-x1`);
    expect(command.indexOf(tree)).toBeLessThan(
      command.lastIndexOf(`nixpacks build ${tree}`),
    );
  });

  /**
   * The other branch of the same fork, and the one that has to keep working:
   * a build that runs in this process writes where this process can write,
   * which is the whole reason `CLOUDGATE_DIRECTORY` exists — *"the
   * alternative is a backend that only runs where its own user can write to
   * /etc"*.
   */
  it('keeps a platform-host build under this instance’s configured root', async () => {
    const deps = makeDeps();

    await makeEngine(deps).deploy(makeApp());

    expect(deps.remoteExec.execAsyncRemote).not.toHaveBeenCalled();
    const command = deps.remoteExec.execAsync.mock.calls[0][0];
    expect(command).toContain(`${configured}/applications/shop-api-x1/code`);
    expect(command).not.toContain(`${REMOTE_CLOUDGATE_DIRECTORY}/applications`);
  });
});

describe('DeploymentEngineService command quoting', () => {
  const registry = {
    registryId: 'reg-1',
    name: 'acme registry',
    imagePrefix: null,
    username: 'pusher',
    password: 'reg-secret',
    url: 'registry.acme.dev',
    registryType: 'cloud',
    organizationId: 'org-1',
  };

  /** The smallest raw stack `deployCompose` will take: no clone to drive, and
   * `readComposeContent` answers with the stored definition. */
  const makeCompose = (): DeployableCompose =>
    ({
      composeId: 'cmp-1',
      name: 'Shop stack',
      appName: 'shop-stack-x1',
      sourceType: 'raw',
      composeType: 'docker-compose',
      composeFile: 'services:\n  web:\n    image: nginx\n',
      composePath: './docker-compose.yml',
      env: '',
      serverId: null,
      environment: {
        environmentId: 'env-1',
        name: 'production',
        env: '',
        project: {
          projectId: 'proj-1',
          name: 'Shop',
          env: '',
          organizationId: 'org-1',
        },
      },
    }) as unknown as DeployableCompose;

  /**
   * Every command one deploy handed the shell, for a `logPath` and a
   * `dockerImage` built out of `value`. Run twice per assertion — once with the
   * payload and once with an inert value — because these commands carry the
   * same value in up to five places, and an assertion satisfied by one quoted
   * copy says nothing about the other four.
   */
  const commandsFor = async (
    value: string,
    application: Partial<DeployableApplication> = {},
    { fail = false } = {},
  ): Promise<string[]> => {
    const deps = makeDeps();
    deps.recorder.create.mockResolvedValue({
      deploymentId: 'dep-1',
      logPath: `/etc/cloudgate/logs/${value}/dep-1.log`,
      cancelled: new AbortController().signal,
    });
    if (fail) {
      deps.remoteExec.execAsync
        .mockRejectedValueOnce(new Error('nixpacks exploded'))
        .mockResolvedValue(ok);
    }
    const deploy = makeEngine(deps).deploy(makeApp(application));
    await (fail ? expect(deploy).rejects.toThrow() : deploy);
    return deps.remoteExec.execAsync.mock.calls.map((call) => call[0]);
  };

  /** A docker-sourced application, whose `dockerImage` is `builtImageName`. */
  const dockerSourced = (value: string): Partial<DeployableApplication> => ({
    sourceType: 'docker',
    dockerImage: `nginx:${value}`,
    github: null,
    username: null,
    password: null,
    registryUrl: null,
  });

  const expectEveryCommandInert = (
    poisoned: string[],
    inert: string[],
  ): void => {
    expect(poisoned).toHaveLength(inert.length);
    expect(poisoned.length).toBeGreaterThan(0);
    poisoned.forEach((command, index) =>
      expectValueIsInert(command, inert[index]),
    );
  };

  it('keeps the deployment log path in one word in every command a deploy emits', async () => {
    // The build pipeline, the rollback `docker tag`, and the two Update
    // appends — every one of them redirects into the same file.
    expectEveryCommandInert(
      await commandsFor(SEPARATOR_PAYLOAD, { rollbackActive: true }),
      await commandsFor(INERT_VALUE, { rollbackActive: true }),
    );
  });

  it('keeps the deployment log path in one word on the failure path', async () => {
    // The branch that runs when the operator is least able to see what the
    // shell did: the base64 message append and the banner beside it.
    expectEveryCommandInert(
      await commandsFor(SEPARATOR_PAYLOAD, {}, { fail: true }),
      await commandsFor(INERT_VALUE, {}, { fail: true }),
    );
  });

  it('keeps a compose deployment log path in one word in both commands', async () => {
    const composeCommandsFor = async (value: string) => {
      const deps = makeDeps();
      deps.recorder.create.mockResolvedValue({
        deploymentId: 'dep-1',
        logPath: `/etc/cloudgate/logs/${value}/dep-1.log`,
        cancelled: new AbortController().signal,
      });
      await makeEngine(deps).deployCompose(makeCompose());
      return deps.remoteExec.execAsync.mock.calls.map((call) => call[0]);
    };

    // The clone write and the build; a raw stack has no patch step.
    expectEveryCommandInert(
      await composeCommandsFor(SEPARATOR_PAYLOAD),
      await composeCommandsFor(INERT_VALUE),
    );
  });

  it('keeps an unconstrained dockerImage in one word in the Push phase line', async () => {
    // No registry is the ordinary single-box install, so this is the line the
    // column reaches with nothing else configured — the docker arm of the
    // fallback, which is the only one this source type can reach.
    const [poisoned] = await commandsFor(
      SEPARATOR_PAYLOAD,
      dockerSourced(SEPARATOR_PAYLOAD),
    );
    const [inert] = await commandsFor(INERT_VALUE, dockerSourced(INERT_VALUE));

    expect(poisoned).toContain('[Push] Nothing to push');
    expectValueIsInert(poisoned, inert);
  });

  it('keeps an unconstrained dockerImage in one word with a Registry linked', async () => {
    // H-34's `docker tag` / `docker push` sites for this column are gone since
    // A docker source pushes nothing — so a linked Registry now reaches
    // the same Push line as none, and the column must be inert there too.
    const withRegistry = (value: string) =>
      ({ ...dockerSourced(value), registry }) as Partial<DeployableApplication>;
    const [poisoned] = await commandsFor(
      SEPARATOR_PAYLOAD,
      withRegistry(SEPARATOR_PAYLOAD),
    );
    const [inert] = await commandsFor(INERT_VALUE, withRegistry(INERT_VALUE));

    expect(poisoned).not.toContain('docker push');
    expect(poisoned).toContain('[Push] Nothing to push');
    expectValueIsInert(poisoned, inert);
  });

  it("keeps a registry's unconstrained imagePrefix in one word in the push tag", async () => {
    // `imagePrefix` is `z.string().nullish()` and is the first segment of
    // `getRegistryTag`'s word; `url` is the only part of that tag carrying a
    // charset, which is what made the whole tag look constrained.
    const withPrefix = (value: string) =>
      ({
        registry: { ...registry, imagePrefix: value },
      }) as Partial<DeployableApplication>;
    const [poisoned] = await commandsFor(
      SEPARATOR_PAYLOAD,
      withPrefix(SEPARATOR_PAYLOAD),
    );
    const [inert] = await commandsFor(INERT_VALUE, withPrefix(INERT_VALUE));

    expect(poisoned).toContain('docker push');
    expectValueIsInert(poisoned, inert);
  });

  it('keeps an unconstrained dockerImage in one word in the rollback docker tag', async () => {
    const rollbackOf = (value: string) => ({
      ...dockerSourced(value),
      rollbackActive: true,
    });
    const poisoned = await commandsFor(
      SEPARATOR_PAYLOAD,
      rollbackOf(SEPARATOR_PAYLOAD),
    );
    const inert = await commandsFor(INERT_VALUE, rollbackOf(INERT_VALUE));

    expect(poisoned[1]).toContain('docker tag');
    expectEveryCommandInert(poisoned, inert);
  });
});

/**
 * "A Deployment failed" promises the message the builder printed, and it
 * sent the generated shell script instead: every build step runs inside one
 * `(…) >> logPath 2>&1` subshell, so the builder's output goes to the
 * Deployment log and the rejected exec's `ExecError` carries an empty stderr and
 * a `message` that is `Command execution failed: Command failed: ` plus the
 * whole program — naming `nixpacks build` for a clone that never got that far.
 * The reason was only ever in the log, so that is where the notification reads
 * it from.
 */
describe('DeploymentEngineService, the reason a failed Deployment notifies with', () => {
  /** The program a git clone failure rejects with, as `execAsync` wraps it. */
  const script = [
    '(set -e;',
    "echo 'Cloning repo https://github.com/octabyte-io/u12-does-not-exist.git to …/code';",
    'cg_clone=$(mktemp -d);',
    '{ GIT_TERMINAL_PROMPT=0 git -c protocol.file.allow=never clone --branch main --depth 1 --progress -- https://github.com/octabyte-io/u12-does-not-exist.git … 2>&1 || touch "$cg_clone/failed"; } | tee "$cg_clone/output";',
    'if [ -e "$cg_clone/failed" ]; then',
    "  if grep -q 'terminal prompts disabled' \"$cg_clone/output\"; then echo '…'; fi;",
    '  rm -rf "$cg_clone";',
    "  echo '❌ Failed to clone repository …';",
    '  exit 1;',
    'fi',
    'rm -rf "$cg_clone";',
    "echo '✅ Cloned repo …';",
    'nixpacks build /etc/cloudgate/applications/app-mvr51d/code --name app-mvr51d || {',
    '  echo "❌ Nixpacks build failed" ;',
    '  exit 1;',
    '}',
    ') >> /etc/cloudgate/logs/app-mvr51d/dep-1.log 2>&1 < /dev/null',
  ].join('\n');
  const scriptFailed = () =>
    new ExecError(`Command execution failed: Command failed: ${script}`, {
      command: script,
      stdout: '',
      stderr: '',
      exitCode: 1,
    });

  /** What the builder really printed, as the Deployment log holds it — git's
   * `--progress` lines are `\r`-separated updates of one line. */
  const logTail = [
    'Cloning repo https://github.com/octabyte-io/u12-does-not-exist.git to /etc/cloudgate/applications/app-mvr51d/code',
    "Cloning into '/etc/cloudgate/applications/app-mvr51d/code'...",
    "remote: Counting objects:  50% (1/2)\rremote: Counting objects: 100% (2/2)\rfatal: could not read Username for 'https://github.com': terminal prompts disabled",
    'The server asked for credentials, so the repository is private or does not exist. Clone it over SSH with an SSH key, or through a connected git provider.',
    '❌ Failed to clone repository https://github.com/octabyte-io/u12-does-not-exist.git',
    '',
  ].join('\n');

  const failClone = (deps: Deps, tail = logTail) => {
    deps.remoteExec.execAsync
      .mockRejectedValueOnce(scriptFailed())
      .mockResolvedValue(ok);
    deps.remoteExec.execFileAsync.mockResolvedValue({ ...ok, stdout: tail });
  };

  const notifiedReason = (deps: Deps): string => {
    expect(deps.notifier.buildError).toHaveBeenCalledTimes(1);
    return deps.notifier.buildError.mock.calls[0][0].errorMessage;
  };

  it("carries the builder's own words from the Deployment log, and not the script", async () => {
    const deps = makeDeps();
    failClone(deps);

    await expect(makeEngine(deps).deploy(makeApp())).rejects.toThrow(ExecError);

    const reason = notifiedReason(deps);
    expect(reason).toContain(
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    );
    expect(reason).toContain(
      'The server asked for credentials, so the repository is private or does not exist. Clone it over SSH with an SSH key, or through a connected git provider.',
    );
    expect(reason).toContain(
      '❌ Failed to clone repository https://github.com/octabyte-io/u12-does-not-exist.git',
    );
    expect(reason).not.toContain('set -e');
    expect(reason).not.toContain('nixpacks build');
    expect(reason).not.toContain('Command execution failed');
    // The progress a `\r` overwrote is not what the terminal showed.
    expect(reason).not.toContain('Counting objects');
  });

  it('reads the tail of the log the Deployment row names, on the machine that wrote it, before the banner lands', async () => {
    const deps = makeDeps();
    failClone(deps);

    await expect(makeEngine(deps).deploy(makeApp())).rejects.toThrow();

    expect(deps.remoteExec.execFileAsync).toHaveBeenCalledWith('tail', [
      '-n',
      expect.stringMatching(/^\d+$/),
      '/etc/cloudgate/logs/shop-api-x1/dep-1.log',
    ]);
    expect(notifiedReason(deps)).not.toContain('Error occurred');
  });

  it('reads it over the build Server when the build ran on one', async () => {
    const deps = makeDeps();
    deps.remoteExec.execAsyncRemote
      .mockRejectedValueOnce(scriptFailed())
      .mockResolvedValue(ok);
    deps.remoteExec.execRemote.mockResolvedValue({ ...ok, stdout: logTail });

    await expect(
      makeEngine(deps).deploy(makeApp({ serverId: 'srv-1' })),
    ).rejects.toThrow();

    expect(deps.remoteExec.execRemote).toHaveBeenCalledWith('srv-1', [
      'tail',
      '-n',
      expect.stringMatching(/^\d+$/),
      '/etc/cloudgate/logs/shop-api-x1/dep-1.log',
    ]);
    expect(notifiedReason(deps)).toContain('fatal: could not read Username');
  });

  it('stays short enough for a chat preview when the builder wrote a wall of output', async () => {
    const deps = makeDeps();
    const wall = Array.from(
      { length: 400 },
      (_, i) => `#${i} ${'x'.repeat(200)}`,
    ).join('\n');
    failClone(deps, `${wall}\nERROR: failed to solve: exit code 137\n`);

    await expect(makeEngine(deps).deploy(makeApp())).rejects.toThrow();

    const reason = notifiedReason(deps);
    expect(reason.length).toBeLessThanOrEqual(1000);
    expect(reason.endsWith('ERROR: failed to solve: exit code 137')).toBe(true);
  });

  it('keeps a credential in a clone URL elided', async () => {
    const deps = makeDeps();
    failClone(
      deps,
      "fatal: unable to access 'https://x-access-token:ghs_SECRET123@github.com/acme/app.git/': The requested URL returned error: 403\n",
    );

    await expect(makeEngine(deps).deploy(makeApp())).rejects.toThrow();

    const reason = notifiedReason(deps);
    expect(reason).not.toContain('ghs_SECRET123');
    expect(reason).toContain('The requested URL returned error: 403');
  });

  it("strips the terminal's colour codes a builder writes into the log", async () => {
    const deps = makeDeps();
    failClone(deps, '\u001b[31mERROR\u001b[0m: failed to solve\n');

    await expect(makeEngine(deps).deploy(makeApp())).rejects.toThrow();

    expect(notifiedReason(deps)).toBe('ERROR: failed to solve');
  });

  it("names the step's own stderr when the command that failed was not writing to the log", async () => {
    const deps = makeDeps();
    deps.remoteExec.execAsync
      .mockRejectedValueOnce(
        new ExecError('Command execution failed: Command failed: cat …', {
          command: 'cat …',
          stderr: 'cat: ./docker-compose.yml: No such file or directory\n',
          exitCode: 1,
        }),
      )
      .mockResolvedValue(ok);

    await expect(makeEngine(deps).deploy(makeApp())).rejects.toThrow();

    expect(notifiedReason(deps)).toBe(
      'cat: ./docker-compose.yml: No such file or directory',
    );
    expect(deps.remoteExec.execFileAsync).not.toHaveBeenCalled();
  });

  it('says what it knows, and never the script, when neither the log nor the step has anything to say', async () => {
    const deps = makeDeps();
    failClone(deps, '');

    await expect(makeEngine(deps).deploy(makeApp())).rejects.toThrow();

    const reason = notifiedReason(deps);
    expect(reason).toContain('exit code 1');
    expect(reason).not.toContain('set -e');
  });

  it('still notifies when the log cannot be read', async () => {
    const deps = makeDeps();
    failClone(deps);
    deps.remoteExec.execFileAsync.mockRejectedValue(new Error('ssh dropped'));

    await expect(makeEngine(deps).deploy(makeApp())).rejects.toThrow(ExecError);

    expect(notifiedReason(deps)).not.toContain('set -e');
  });

  it('keeps the whole failure on the error the deploy rethrows, for the job log', async () => {
    const deps = makeDeps();
    failClone(deps);

    const thrown = await makeEngine(deps)
      .deploy(makeApp())
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ExecError);
    expect((thrown as ExecError).command).toContain('nixpacks build');
  });

  it('sends a sentence the engine composed as it was, since it is already the reason', async () => {
    const deps = makeDeps();
    deps.remoteExec.execAsync
      .mockRejectedValueOnce(new Error('nixpacks exploded'))
      .mockResolvedValue(ok);

    await expect(makeEngine(deps).deploy(makeApp())).rejects.toThrow();

    expect(notifiedReason(deps)).toBe('nixpacks exploded');
    expect(deps.remoteExec.execFileAsync).not.toHaveBeenCalled();
  });

  it('reads a compose stack the same way', async () => {
    const deps = makeDeps();
    failClone(deps);

    await expect(
      makeEngine(deps).deployCompose(makeComposeStack()),
    ).rejects.toThrow();

    const reason = notifiedReason(deps);
    expect(reason).toContain('fatal: could not read Username');
    expect(reason).not.toContain('set -e');
  });
});

/**
 * With a dedicated build Server a Deployment's log named neither the
 * machine that built the image nor the one that runs it, so a slow or failed
 * build could not be placed. The first line the deploy program writes says
 * both, by the Server's name and address, or as Cloudgate's own host (ADR-0008)
 * when there is no Server row to name.
 */
describe('DeploymentEngineService.deploy', () => {
  describe('the line naming where a Deployment builds and runs', () => {
    /** The lines the composed deploy program `echo`es, in order, unquoted. */
    const echoedLines = (program: string): string[] =>
      [...program.matchAll(/^echo (.+) ;$/gm)].map(([, word]) => {
        // One literal word, or the raw text — so a line the quoting failed to
        // keep whole reads as a mismatch rather than as its first fragment.
        const words = parseShell(word);
        return words.length === 1 && typeof words[0] === 'string'
          ? words[0]
          : word;
      });

    const deployProgram = (deps: Deps): string => {
      const remote = deps.remoteExec.execAsyncRemote.mock.calls[0];
      return remote ? remote[1] : deps.remoteExec.execAsync.mock.calls[0][0];
    };

    it("says Cloudgate's own host builds and runs it when neither Server is set", async () => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(makeApp());

      const program = deployProgram(deps);
      expect(echoedLines(program)[0]).toBe(
        "🔧 [Build] Building and running on Cloudgate's own host.",
      );
      // No Server row to look for, so the only read is the Application's
      // traces setting.
      expect(deps.db.select).toHaveBeenCalledTimes(1);
    });

    it('names the one Server once when the build Server is the run Server', async () => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(
        makeApp({ serverId: 'srv-run', buildServerId: 'srv-run' }),
      );

      expect(echoedLines(deployProgram(deps))[0]).toBe(
        "🔧 [Build] Building and running on Server 'app-runner' (203.0.113.10).",
      );
    });

    it('names the build Server and the run Server apart when they differ', async () => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(
        makeApp({
          serverId: 'srv-run',
          buildServerId: 'srv-build',
          registry: REGISTRY,
        } as Partial<DeployableApplication>),
      );

      expect(echoedLines(deployProgram(deps))[0]).toBe(
        "🔧 [Build] Building on build Server 'ui-self' (203.0.113.42); the service runs on Server 'app-runner' (203.0.113.10).",
      );
    });

    it("names Cloudgate's own host as the runner of an Application built on a Server", async () => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(
        makeApp({
          serverId: null,
          buildServerId: 'srv-build',
          registry: REGISTRY,
        } as Partial<DeployableApplication>),
      );

      expect(echoedLines(deployProgram(deps))[0]).toBe(
        "🔧 [Build] Building on build Server 'ui-self' (203.0.113.42); the service runs on Cloudgate's own host.",
      );
    });

    it('opens the log: the line is the first thing the program writes', async () => {
      const deps = makeDeps();

      await makeEngine(deps).deploy(makeApp({ serverId: 'srv-run' }));

      const program = deployProgram(deps);
      expect(program.startsWith('(set -e;\necho ')).toBe(true);
      expect(program.indexOf('🔧 [Build]')).toBeLessThan(
        program.indexOf('git -c protocol.file.allow=never clone'),
      );
    });

    it('falls back to the id for a Server whose row is gone, rather than failing the deploy', async () => {
      const deps = makeDeps();
      deps.servers.length = 0;

      await makeEngine(deps).deploy(makeApp({ serverId: 'srv-run' }));

      expect(echoedLines(deployProgram(deps))[0]).toBe(
        "🔧 [Build] Building and running on Server 'srv-run'.",
      );
    });

    it('names the Server by id rather than failing the deploy when the rows cannot be read', async () => {
      const deps = makeDeps();
      deps.db.select.mockImplementation(() => {
        throw new Error('connection terminated');
      });

      await makeEngine(deps).deploy(makeApp({ serverId: 'srv-run' }));

      expect(echoedLines(deployProgram(deps))[0]).toBe(
        "🔧 [Build] Building and running on Server 'srv-run'.",
      );
      expect(deps.recorder.updateStatus).toHaveBeenCalledWith('dep-1', 'done');
    });

    /**
     * A Server's name is operator-authored and has no charset, and it is
     * written into a shell program: it is `quote()`d like every other word the
     * engine interpolates (H-34).
     */
    it('keeps a Server name carrying shell syntax inert', async () => {
      const programWith = async (name: string) => {
        const deps = makeDeps();
        deps.servers[0].name = name;
        await makeEngine(deps).deploy(makeApp({ serverId: 'srv-run' }));
        return deployProgram(deps);
      };

      expectValueIsInert(
        await programWith(SEPARATOR_PAYLOAD),
        await programWith(INERT_VALUE),
      );
    });

    /** Every base64-carried line a deploy appended, local and remote. */
    const appended = (deps: Deps): string[] =>
      appendedLogLines([
        ...deps.remoteExec.execAsync.mock.calls.map((call) => call[0]),
        ...deps.remoteExec.execAsyncRemote.mock.calls.map((call) => call[1]),
      ]);

    /**
     * The reachability refusal is in front of the program that `echo`es the line, and a
     * build Server is exactly the configuration it refuses — so the line is
     * written with the refusal, ahead of it.
     */
    it("opens a build Server refusal's log with where it would have built", async () => {
      const deps = makeDeps();

      await expect(
        makeEngine(deps).deploy(
          makeApp({ serverId: 'srv-run', buildServerId: 'srv-build' }),
        ),
      ).rejects.toThrow(/registry/i);

      const lines = appended(deps);
      expect(lines[0]).toBe(
        "🔧 [Build] Building on build Server 'ui-self' (203.0.113.42); the service runs on Server 'app-runner' (203.0.113.10).\n",
      );
      expect(lines[1]).toContain('no registry is set');
    });

    it('opens the log with the line when the clone cannot be composed', async () => {
      const deps = makeDeps();
      deps.githubService.getGithubToken.mockRejectedValue(
        new Error('GitHub refused the installation token'),
      );

      await expect(
        makeEngine(deps).deploy(makeApp({ serverId: 'srv-run' })),
      ).rejects.toThrow('GitHub refused the installation token');

      expect(appended(deps)).toEqual([
        "🔧 [Build] Building and running on Server 'app-runner' (203.0.113.10).\n",
        'GitHub refused the installation token\n',
      ]);
    });

    it('writes the line once when the program ran and failed, since its own echo carried it', async () => {
      const deps = makeDeps();
      deps.remoteExec.execAsync
        .mockRejectedValueOnce(
          new ExecError('script failed', { command: 'set -e; …', exitCode: 1 }),
        )
        .mockResolvedValue(ok);

      await expect(makeEngine(deps).deploy(makeApp())).rejects.toThrow();

      expect(
        appended(deps).filter((line) => line.startsWith('🔧 [Build]')),
      ).toEqual([]);
      expect(echoedLines(deployProgram(deps))[0]).toBe(
        "🔧 [Build] Building and running on Cloudgate's own host.",
      );
    });

    it("opens a refused compose stack's log with the line too", async () => {
      const deps = makeDeps();

      await expect(
        makeEngine(deps).deployCompose(
          makeComposeStack({
            composeFile: 'volumes: {}\n',
            serverId: 'srv-run',
          }),
        ),
      ).rejects.toThrow('declares no services');

      const lines = appended(deps);
      expect(lines[0]).toBe(
        "🔧 [Build] Building and running on Server 'app-runner' (203.0.113.10).\n",
      );
      expect(lines[1]).toContain('declares no services');
    });

    it("opens a compose stack's log the same way, on its one Server", async () => {
      const deps = makeDeps();

      await makeEngine(deps).deployCompose(
        makeComposeStack({ serverId: 'srv-run' }),
      );

      const [, clone] = deps.remoteExec.execAsyncRemote.mock.calls[0];
      expect(clone.startsWith('(set -e;\necho ')).toBe(true);
      expect(echoedLines(clone)[0]).toBe(
        "🔧 [Build] Building and running on Server 'app-runner' (203.0.113.10).",
      );
    });
  });
});

/**
 * A build cancelled while it runs. `DeploymentsService.cancel` aborts the
 * record's signal and writes `cancelled`; everything the engine does after that
 * is pinned here — it must not write a status over the record, must not go on
 * to release, and must return so the queue slot frees.
 */
describe('DeploymentEngineService.deploy', () => {
  describe('a build cancelled while it runs', () => {
    /** The recorder hands out a live signal; `cancel` aborts it. */
    const withLiveSignal = (deps: Deps) => {
      const controller = new AbortController();
      deps.recorder.create.mockResolvedValue({
        deploymentId: 'dep-1',
        logPath: '/etc/cloudgate/logs/shop-api-x1/dep-1.log',
        cancelled: controller.signal,
      });
      return controller;
    };
    const logged = (deps: Deps): string =>
      deps.remoteExec.execAsync.mock.calls
        .map((call) => call[0])
        .filter((command) => command.includes('base64 -d >>'))
        .map((command) =>
          [...command.matchAll(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/g)]
            .map((match) => Buffer.from(match[1], 'base64').toString())
            .join(''),
        )
        .join('');

    it("hands the build program its Deployment's signal", async () => {
      const deps = makeDeps();
      const controller = withLiveSignal(deps);

      await makeEngine(deps).deploy(makeApp());

      const [, options] = deps.remoteExec.execAsync.mock.calls[0];
      expect(options?.signal).toBe(controller.signal);
    });

    it('writes no status over the cancelled record, releases nothing, notifies nothing, and says so in the log', async () => {
      const deps = makeDeps();
      const controller = withLiveSignal(deps);
      // The build program is killed mid-run: its exec rejects once the
      // signal is aborted, as `RemoteExecService` does.
      deps.remoteExec.execAsync.mockImplementationOnce(() => {
        controller.abort();
        return Promise.reject(new Error('Command cancelled'));
      });

      await expect(makeEngine(deps).deploy(makeApp())).rejects.toThrow();

      expect(deps.recorder.closeCancelWindow).toHaveBeenCalledWith('dep-1');
      expect(deps.recorder.updateStatus).not.toHaveBeenCalled();
      expect(deps.applications.updateStatus).not.toHaveBeenCalled();
      expect(deps.dockerFactory.getRemoteDocker).not.toHaveBeenCalled();
      expect(deps.notifier.buildError).not.toHaveBeenCalled();
      expect(logged(deps)).toContain(
        'Cancelled: this build was stopped while it ran',
      );
      expect(logged(deps)).not.toContain('Error occurred');
    });

    it('stops before the Update phase when the cancel lands as the build finishes', async () => {
      const deps = makeDeps();
      const controller = withLiveSignal(deps);
      deps.remoteExec.execAsync.mockImplementationOnce(() => {
        controller.abort();
        return Promise.resolve(ok);
      });

      await expect(makeEngine(deps).deploy(makeApp())).rejects.toThrow();

      expect(deps.dockerFactory.getRemoteDocker).not.toHaveBeenCalled();
      expect(deps.recorder.updateStatus).not.toHaveBeenCalled();
    });

    it('closes the window before it releases, so a later cancel is refused rather than delivered', async () => {
      const deps = makeDeps();
      withLiveSignal(deps);
      const order: string[] = [];
      deps.recorder.closeCancelWindow.mockImplementation(() => {
        order.push('closed');
      });
      deps.dockerFactory.getRemoteDocker.mockImplementation(() => {
        order.push('release');
        return Promise.resolve(deps.docker);
      });

      await makeEngine(deps).deploy(makeApp());

      expect(order).toEqual(['closed', 'release']);
      expect(deps.recorder.updateStatus).toHaveBeenCalledWith('dep-1', 'done');
    });
  });
});

describe('DeploymentEngineService.deployCompose', () => {
  describe('a stack deploy cancelled while it runs', () => {
    it('hands every shell step its signal and writes no status over the cancelled record', async () => {
      const deps = makeDeps();
      const controller = new AbortController();
      deps.recorder.create.mockResolvedValue({
        deploymentId: 'dep-1',
        logPath: '/etc/cloudgate/logs/shop-stack-x1/dep-1.log',
        cancelled: controller.signal,
      });
      // The clone runs; the build (`docker compose up`) is killed.
      deps.remoteExec.execAsync
        .mockImplementationOnce(() => Promise.resolve(ok))
        .mockImplementationOnce(() => {
          controller.abort();
          return Promise.reject(new Error('Command cancelled'));
        });

      await expect(
        makeEngine(deps).deployCompose(makeComposeStack()),
      ).rejects.toThrow();

      const [clone, build] = deps.remoteExec.execAsync.mock.calls;
      expect(clone[1]?.signal).toBe(controller.signal);
      expect(build[1]?.signal).toBe(controller.signal);
      expect(deps.recorder.closeCancelWindow).toHaveBeenCalledWith('dep-1');
      expect(deps.recorder.updateStatus).not.toHaveBeenCalled();
      expect(deps.notifier.buildError).not.toHaveBeenCalled();
      // The clone rewrote the target, so the withheld-status rule still paints the stack.
      expect(deps.composeService.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        'error',
      );
    });
  });
});

/**
 * A Deployment that reserves GPUs reads the run Server's free cards live
 * before anything is released, and fails there when it is short — leaving the
 * service as it was, never left waiting on a pending task.
 */
describe('DeploymentEngineService.deploy with a GPU reservation', () => {
  const card = (n: number) =>
    `{"NamedResourceSpec":{"Kind":"GPU","Value":"GPU-${n}"}}`;
  /**
   * Two cards by ID on `srv-run`; `tasks` are its running tasks' lines, and
   * `toml` its NVIDIA runtime's `config.toml`.
   */
  const gpuServer = (
    deps: Deps,
    tasks: string[],
    toml: string = RUNTIME_TOML.configured,
  ) => {
    deps.remoteExec.execAsyncRemote.mockImplementation(
      (_server, command) =>
        nvidiaRuntimeAnswer(command, toml) ??
        Promise.resolve({
          ...ok,
          stdout:
            command === NODE_GPU_RESOURCES_COMMAND
              ? `[${card(1)},${card(2)}]`
              : command === RUNNING_TASK_GPUS_COMMAND
                ? tasks.join('\n')
                : '',
        }),
    );
    deps.remoteExec.execRemote.mockImplementation(
      (_server, argv) =>
        nvidiaRuntimeAnswer(argv, toml) ?? Promise.resolve({ ...ok }),
    );
  };
  const held = (serviceId: string, n: number) => `${serviceId} [${card(n)}]`;
  const gpuApp = (gpus: number, replicas: number) =>
    makeApp({ serverId: 'srv-run', gpus, replicas });
  const loggedLines = (deps: Deps) =>
    appendedLogLines(
      deps.remoteExec.execAsyncRemote.mock.calls.map(([, c]) => c),
    );
  const line = '2 GPUs needed, 1 of 2 free on app-runner';

  it('fails before release when fewer cards are free than every copy needs', async () => {
    const deps = makeDeps();
    gpuServer(deps, [held('svc-other', 1)]);

    await expect(makeEngine(deps).deploy(gpuApp(1, 2))).rejects.toThrow(line);

    expect(deps.docker.createService).not.toHaveBeenCalled();
    expect(deps.docker.getService().update).not.toHaveBeenCalled();
    expect(loggedLines(deps)).toContain(`${line}\n`);
    expect(loggedLines(deps).join('')).not.toContain('[Update] Releasing');
    expect(deps.recorder.updateStatus).toHaveBeenCalledWith('dep-1', 'error');
    expect(deps.notifier.buildError).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: line }),
    );
  });

  it('fails before release on a Server whose runtime cannot hand a task its card', async () => {
    const deps = makeDeps();
    gpuServer(deps, [], RUNTIME_TOML.theOldWay);
    const refusal =
      'app-runner is not set up to hand a reserved card to its container; run GPU setup on it again';

    await expect(makeEngine(deps).deploy(gpuApp(1, 1))).rejects.toThrow(
      refusal,
    );

    expect(deps.docker.createService).not.toHaveBeenCalled();
    expect(deps.docker.getService().update).not.toHaveBeenCalled();
    expect(loggedLines(deps)).toContain(`${refusal}\n`);
    expect(deps.recorder.updateStatus).toHaveBeenCalledWith('dep-1', 'error');
  });

  it('counts the cards its own running tasks hold as free on a redeploy', async () => {
    const deps = makeDeps();
    deps.docker.getService().inspect.mockResolvedValue({
      ID: 'svc-own',
      Version: { Index: '7' },
      Spec: { TaskTemplate: { ForceUpdate: 0 } },
      UpdateStatus: { State: 'completed' },
    });
    // The update's two tasks, running: the convergence poll ends at once.
    const running = {
      Spec: { ForceUpdate: 0 },
      Status: { State: 'running', Timestamp: '2026-08-24T00:00:00Z' },
    };
    deps.docker.listTasks.mockResolvedValue([running, running]);
    gpuServer(deps, [held('svc-own', 1), held('svc-own', 2)]);

    await makeEngine(deps).deploy(gpuApp(1, 2));

    expect(deps.docker.getService().update).toHaveBeenCalledTimes(1);
    expect(deps.notifier.buildError).not.toHaveBeenCalled();
  });

  it('releases when enough cards are free', async () => {
    const deps = makeDeps();
    gpuServer(deps, [held('svc-other', 1)]);

    await makeEngine(deps).deploy(gpuApp(1, 1));

    expect(deps.docker.createService).toHaveBeenCalledTimes(1);
  });

  it('reads no GPU counts for an Application with no GPUs', async () => {
    const deps = makeDeps();

    await makeEngine(deps).deploy(gpuApp(0, 1));

    const commands = deps.remoteExec.execAsyncRemote.mock.calls.map(
      ([, c]) => c,
    );
    expect(commands).not.toContain(NODE_GPU_RESOURCES_COMMAND);
  });
});

/**
 * A Preview deployment's build of an Application in a Cloud account: the
 * parent's `serverId` is `null`, which the engine reads as the platform host,
 * and a preview has no cloud place of its own (ADR-0021, ADR-0053). Its
 * creates are refused up front; this is the fail-closed half for a build
 * queued before that refusal, or by any path that forgot it.
 */
describe('DeploymentEngineService.deploy, for a preview of an Application in a Cloud account', () => {
  it('fails the build before anything is cloned or built', async () => {
    const deps = makeDeps();
    const engine = makeEngine(deps);

    await expect(
      engine.deploy(
        makeApp({ cloudAccountId: 'acct-1' }),
        {},
        { preview: true, setsApplicationStatus: false },
      ),
    ).rejects.toThrow(/runs in a Cloud account/);

    const programs = deps.remoteExec.execAsync.mock.calls.map(([c]) => c);
    expect(programs.some((program) => program.includes('git'))).toBe(false);
    expect(deps.recorder.updateStatus).toHaveBeenCalledWith('dep-1', 'error');
  });
});
