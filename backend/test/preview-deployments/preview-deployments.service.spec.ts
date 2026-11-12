import type { FrozenOrganizations } from '../../src/cloud/billing/frozen-organizations.service';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { server } from '../../src/servers/server.schema';
import type { ApplicationsService } from '../../src/applications/applications.service';
import type { DeployMeta } from '../../src/deployment-engine/deployment-engine.service';
import type { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import type { GithubService } from '../../src/git-providers/strategies/github/github.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import type { PermissionService } from '../../src/rbac/permission.service';
import type { PreviewDeployment } from '../../src/preview-deployments/preview-deployment.schema';
import type { DeploymentsService } from '../../src/deployments/deployments.service';
import type { TraefikAppConfigService } from '../../src/traefik/app-config.service';
import type { AuditLogService } from '../../src/enterprise/audit-logs/audit-log.service';
import { buildLeftoverReclamation } from '../../src/builders/build-leftovers';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import { PreviewDeploymentsService } from '../../src/preview-deployments/preview-deployments.service';
import { SEPARATOR_PAYLOAD } from '../utils/shell-safety';

const ok = { stdout: '', stderr: '', exitCode: 0 };

const ctx = {
  session: { activeOrganizationId: 'org-1' },
} as unknown as PermissionCtx;

/**
 * The reads `remove` makes, and nothing else: the org-scoped
 * preview → application → environment → project join, the read answer's
 * certificates and latest build — none here — then the delete.
 * Written out rather than driven through Postgres because what is under test
 * is the shape of the two commands teardown emits, which the e2e cannot vary —
 * the appName it would see comes from `generateAppName`.
 */
const makeDb = (preview: PreviewDeployment, servers: Servers) => {
  const chain = {
    innerJoin: () => chain,
    where: () =>
      Object.assign(Promise.resolve([]), {
        limit: () => Promise.resolve([{ preview, ...servers }]),
      }),
  };
  // No Server is in maintenance: its read answers none.
  const noServer = {
    where: () => ({ limit: () => Promise.resolve([]) }),
  };
  return {
    select: () => ({
      from: (table: unknown) => (table === server ? noServer : chain),
    }),
    selectDistinctOn: () => ({
      from: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }),
    }),
    delete: () => ({ where: () => Promise.resolve(undefined) }),
  } as unknown as DrizzleDB;
};

const makeRemoteExec = () => ({
  execAsync: jest.fn().mockResolvedValue(ok),
  execAsyncRemote: jest.fn().mockResolvedValue(ok),
  execFileAsync: jest.fn().mockResolvedValue(ok),
  execRemote: jest.fn().mockResolvedValue(ok),
});

/**
 * The parent Application's two Servers, which is what `findOwnedPreview`
 * projects — the run Server the Swarm service is on, and the build
 * Server the source tree is on.
 */
interface Servers {
  serverId: string | null;
  buildServerId: string | null;
}

const makeService = (
  preview: PreviewDeployment,
  servers: Servers,
  remoteExec: ReturnType<typeof makeRemoteExec>,
  // Teardown first stops the preview's builds; none is in flight here.
  deployments: DeploymentsService = {
    cancelPreviewBuilds: jest
      .fn()
      .mockResolvedValue({ cancelled: [], building: false }),
  } as unknown as DeploymentsService,
) =>
  new PreviewDeploymentsService(
    makeDb(preview, servers),
    {
      checkPermission: jest.fn().mockResolvedValue(undefined),
      checkServiceAccess: jest.fn().mockResolvedValue(undefined),
    } as unknown as PermissionService,
    {} as ApplicationsService,
    {} as DeploymentEngineService,
    {} as GithubService,
    remoteExec,
    // Where a preview build is recorded and queued, and where teardown
    // stops the preview's builds before it removes anything.
    deployments,
    // Only `deployPreview` routes, and nothing here deploys.
    {} as TraefikAppConfigService,
    // Only a Requested preview's create and extend write a row.
    {} as AuditLogService,
    // Only a pull request's build asks.
    {} as FrozenOrganizations,
  );

/**
 * H-34. `teardown` built `docker service rm ${preview.appName}` and
 * `rm -rf ${codeDirectory}` as strings, so the appName was a bare word in both.
 * It is `generateAppName('preview-…')` over a `cleanAppName` parent today —
 * traced, and safe — which is the charset-at-a-distance the same run had just
 * watched fail twice. Each command is one program and its arguments with no
 * shell construct anywhere in it, so the answer is argv rather than `quote()`
 * locally nothing parses the words at all, and remotely `execRemote`
 * joins them once behind its own test. The payload is fed in directly, because
 * the claim is that the command builder is safe on its own.
 */
describe('PreviewDeploymentsService.remove', () => {
  const preview = {
    previewDeploymentId: 'prev-1',
    applicationId: 'app-1',
    appName: `preview-${SEPARATOR_PAYLOAD}`,
    // What the read answer prints a link for.
    domain: 'preview-1.preview.example.com',
  } as unknown as PreviewDeployment;

  it('removes the Swarm service and the code as argv on the platform host', async () => {
    const remoteExec = makeRemoteExec();

    await makeService(
      preview,
      { serverId: null, buildServerId: null },
      remoteExec,
    ).remove(ctx, 'prev-1');

    expect(remoteExec.execFileAsync).toHaveBeenNthCalledWith(1, 'docker', [
      'service',
      'rm',
      preview.appName,
    ]);
    // The platform host's own tree, so the root is this process's
    // CLOUDGATE_DIRECTORY rather than the `/etc/cloudgate` a Server has — the
    // two only read alike while that variable is unset.
    expect(remoteExec.execFileAsync).toHaveBeenNthCalledWith(2, 'rm', [
      '-rf',
      `${cloudgateDirectoryOn(null)}/applications/${preview.appName}`,
    ]);
    // Nothing that *removes* was handed to a shell. The one program that goes
    // as a program is the leftover sweep, which has no argv to go as — it is
    // a `for`/`case` loop over two `docker` listings — and the payload reaches
    // it `quote()`d, so the appName is one inert word there too.
    expect(remoteExec.execAsync).toHaveBeenCalledTimes(1);
    expect(remoteExec.execAsync).toHaveBeenCalledWith(
      buildLeftoverReclamation(preview.appName),
    );
    expect(remoteExec.execAsync).toHaveBeenCalledWith(
      expect.stringContaining(`'railpack-${preview.appName}-'`),
    );
  });

  /**
   * The teardown removed the Swarm service, the cloned code and the row,
   * and left the image the build had tagged: 242 MB per pull request on the
   * reporter's host, and every preview mints a fresh `appName`
   * (`generateAppName('preview-…')`), so the images never overwrite one another
   * and accumulate one per pull request for ever.
   *
   * **The same reclamation the Application delete has run, at a
   * fourth call site rather than a second spelling of it.** The word comes from
   * `applications/built-image.ts`' `builtImageTag` and the removal from
   * `common/teardown-steps.ts`' `removeImagesOn`, which is what makes the pin
   * below more than a literal: that derivation is already held against the
   * engine's own `builtImageName` by
   * `test/applications/application-delete-machines.e2e-spec.ts`' *reclaims the
   * image the deploy itself named*, so a preview cannot come to name a tag the
   * build does not produce without reddening that too.
   *
   * The build host, not the run Server — the image is where it was built
   * (ADR-0018), which on the platform host is this same `execFileAsync`.
   */
  it('removes the image the preview build tagged, on the build host', async () => {
    const remoteExec = makeRemoteExec();

    await makeService(
      preview,
      { serverId: null, buildServerId: null },
      remoteExec,
    ).remove(ctx, 'prev-1');

    expect(remoteExec.execFileAsync).toHaveBeenCalledWith('docker', [
      'image',
      'rm',
      `${preview.appName}:latest`,
      '--force',
    ]);
  });

  /**
   * The removal is safe or it is not worth having: a preview that never built
   * has no image, and `docker image rm` exits non-zero for one the daemon does
   * not hold. `removeImagesOn` reads that as the outcome it wanted
   * (`imageAlreadyGone`) and never throws either way, so a teardown cannot fail
   * — or stop short of the row — because of an image.
   */
  it('tears the rest of the preview down when the image is already gone', async () => {
    const remoteExec = makeRemoteExec();
    remoteExec.execFileAsync.mockImplementation(
      (_program: string, args: string[]) =>
        args[0] === 'image'
          ? Promise.reject(
              new Error(
                `Error response from daemon: No such image: ${preview.appName}:latest`,
              ),
            )
          : Promise.resolve(ok),
    );

    await expect(
      makeService(
        preview,
        { serverId: null, buildServerId: null },
        remoteExec,
      ).remove(ctx, 'prev-1'),
    ).resolves.toMatchObject(preview);

    // And the sweep after it still ran, which is what says the failure ended
    // the image and nothing else.
    expect(remoteExec.execAsync).toHaveBeenCalledWith(
      buildLeftoverReclamation(preview.appName),
    );
  });

  it('removes the Swarm service and the code as argv on a Server', async () => {
    const remoteExec = makeRemoteExec();

    await makeService(
      preview,
      { serverId: 'srv-1', buildServerId: null },
      remoteExec,
    ).remove(ctx, 'prev-1');

    expect(remoteExec.execRemote).toHaveBeenNthCalledWith(1, 'srv-1', [
      'docker',
      'service',
      'rm',
      preview.appName,
    ]);
    // The router for the preview's host, as argv like the rest.
    expect(remoteExec.execRemote).toHaveBeenNthCalledWith(2, 'srv-1', [
      'rm',
      '-f',
      `/etc/cloudgate/traefik/dynamic/${preview.appName}.yml`,
    ]);
    expect(remoteExec.execRemote).toHaveBeenNthCalledWith(3, 'srv-1', [
      'rm',
      '-rf',
      `/etc/cloudgate/applications/${preview.appName}`,
    ]);
    // As above: the sweep is the only program, and it is sent to the build host
    // — here the same machine, there being no dedicated build Server.
    expect(remoteExec.execAsyncRemote).toHaveBeenCalledTimes(1);
    expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
      'srv-1',
      buildLeftoverReclamation(preview.appName),
    );
  });

  /**
   * `teardown` took **one** `serverId` and used it for both commands,
   * while `deployPreview` spreads the parent Application's whole row into
   * `engine.deploy` — so `buildServerId` survives, and it is what decides where
   * the engine clones the preview's source. On an install with a dedicated
   * build Server the `rm -rf` was therefore issued to the run Server, which had
   * never held that directory: it exited non-zero and the best-effort loop
   * swallowed it, so the tree stayed on the builder for ever.
   *
   * **The assertion names the host, because the words are identical either
   * way.** Both the broken and the fixed code emit
   * `rm -rf /etc/cloudgate/applications/<appName>`; they differ only in who is
   * asked. So a mutation restoring `serverId` for the second step reds this and
   * nothing else in the file.
   */
  it('drops the Swarm service on the run Server and the code on the build Server', async () => {
    const remoteExec = makeRemoteExec();

    await makeService(
      preview,
      { serverId: 'run-1', buildServerId: 'build-1' },
      remoteExec,
    ).remove(ctx, 'prev-1');

    expect(remoteExec.execRemote.mock.calls).toEqual([
      ['run-1', ['docker', 'service', 'rm', preview.appName]],
      // The router for its host is on the run Server with the service, because
      // that is the Traefik that serves it — never the builder.
      [
        'run-1',
        ['rm', '-f', `/etc/cloudgate/traefik/dynamic/${preview.appName}.yml`],
      ],
      [
        'build-1',
        ['rm', '-rf', `/etc/cloudgate/applications/${preview.appName}`],
      ],
      // And the image, on the machine that built it rather than the one that
      // ran it — the third artifact `preview.appName` is the only name
      // of. Its id is read first, to follow the image once its tag is gone.
      [
        'build-1',
        [
          'docker',
          'image',
          'inspect',
          '--format',
          '{{.Id}}',
          `${preview.appName}:latest`,
        ],
      ],
      [
        'build-1',
        ['docker', 'image', 'rm', `${preview.appName}:latest`, '--force'],
      ],
    ]);
  });
});

/**
 * Every preview build is recorded as a Deployment of the *parent*
 * Application, so the rebuild's row is listed beside one row per previewing
 * pull request — and this one queued `description: ''`, which is the whole
 * defect: the list showed `Rebuild Preview Deployment` with nothing under it
 * and no way to tell which of the open pull requests it rebuilt.
 *
 * **The description is what is asserted, because the title never distinguished
 * them.** The row is written `pending` at enqueue, by
 * `DeploymentsService.queuePreviewBuild` off this exact title and description,
 * so the build asked for with the wrong description is a row carrying it. The
 * explicit-`description` case is the second half: this is a `??` default
 * rather than an override, and a caller that names its own reason for the
 * rebuild still gets it.
 */
describe('PreviewDeploymentsService.redeploy', () => {
  const preview = {
    previewDeploymentId: 'prev-1',
    applicationId: 'app-1',
    appName: 'preview-app',
    pullRequestNumber: '42',
  } as unknown as PreviewDeployment;

  /** Nothing of this preview's is pending, so every redeploy queues one. */
  const makeDeployments = () => ({
    joinQueuedPreviewBuild: jest.fn().mockResolvedValue(null),
    queuePreviewBuild: jest.fn().mockResolvedValue({ deploymentId: 'dep-1' }),
  });

  const redeploy = async (
    deployments: ReturnType<typeof makeDeployments>,
    meta?: DeployMeta,
  ) =>
    makeService(
      preview,
      { serverId: 'run-1', buildServerId: null },
      makeRemoteExec(),
      deployments as unknown as DeploymentsService,
    ).redeploy(ctx, 'prev-1', meta);

  it('queues a deployment whose description names the pull request', async () => {
    const deployments = makeDeployments();

    await redeploy(deployments);

    expect(deployments.queuePreviewBuild).toHaveBeenCalledWith(
      preview,
      'redeploy',
      {
        title: 'Rebuild Preview Deployment',
        // Word for word what `handlePullRequestEvent` writes for the
        // automatic build, so the two rows read alike in the same list.
        description: 'Pull request #42',
      },
    );
  });

  it('keeps a description the caller asked for', async () => {
    const deployments = makeDeployments();

    await redeploy(deployments, {
      title: 'Rebuild',
      description: 'Rebuilt by hand',
    });

    expect(deployments.queuePreviewBuild).toHaveBeenCalledWith(
      preview,
      'redeploy',
      { title: 'Rebuild', description: 'Rebuilt by hand' },
    );
  });
});
