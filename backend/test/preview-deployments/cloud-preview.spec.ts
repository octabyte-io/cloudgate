import { ConflictException } from '@nestjs/common';
import type { ApplicationsService } from '../../src/applications/applications.service';
import type { FrozenOrganizations } from '../../src/cloud/billing/frozen-organizations.service';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import type { DeploymentsService } from '../../src/deployments/deployments.service';
import type { AuditLogService } from '../../src/enterprise/audit-logs/audit-log.service';
import type { GithubService } from '../../src/git-providers/strategies/github/github.service';
import {
  CLOUD_APPLICATION_HAS_NO_PREVIEWS_CODE,
  refuseCloudPreviewSwitches,
} from '../../src/preview-deployments/cloud-preview';
import type { PreviewDeployment } from '../../src/preview-deployments/preview-deployment.schema';
import { PreviewDeploymentsService } from '../../src/preview-deployments/preview-deployments.service';
import type { GithubPullRequestEvent } from '../../src/preview-deployments/preview-deployments.service';
import {
  previewTeardownSteps,
  tearDownApplicationPreviews,
} from '../../src/preview-deployments/preview-teardown';
import type {
  PermissionCtx,
  PermissionService,
} from '../../src/rbac/permission.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { TraefikAppConfigService } from '../../src/traefik/app-config.service';

/**
 * A Preview deployment runs beside its parent as a Swarm service on the
 * parent's Server, sharing its storage (ADR-0021). A Service in a Cloud account
 * has no Server: its `serverId` is `null`, which every exec dispatcher reads as
 * the platform host, so a preview of one built, ran and was torn down on the
 * machine Cloudgate itself runs on (ADR-0053). Previews of an Application in a
 * Cloud account are refused wherever one could start, and every step that
 * would act on one for such a parent does nothing on any machine.
 */

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

const makeRemoteExec = () => {
  const ok = { stdout: '', stderr: '', exitCode: 0 };
  return {
    execAsync: jest.fn().mockResolvedValue(ok),
    execAsyncRemote: jest.fn().mockResolvedValue(ok),
    execFileAsync: jest.fn().mockResolvedValue(ok),
    execRemote: jest.fn().mockResolvedValue(ok),
  };
};

const execCalls = (remoteExec: ReturnType<typeof makeRemoteExec>) =>
  Object.values(remoteExec).flatMap(
    (fn: jest.Mock): unknown[] => fn.mock.calls as unknown[],
  );

/**
 * A database answering each `select` with the next of `answers`, whether it is
 * awaited after its `where` or after its `limit`; every write is recorded.
 */
const dbAnswering = (...answers: unknown[][]) => {
  interface Chain extends Promise<unknown[]> {
    from: () => Chain;
    innerJoin: () => Chain;
    where: () => Chain;
    orderBy: () => Chain;
    limit: () => Promise<unknown[]>;
  }
  const chainOf = (rows: unknown[]): Chain => {
    const chain: Chain = Object.assign(Promise.resolve(rows), {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
    });
    return chain;
  };
  const db = {
    select: jest.fn(() => chainOf(answers.shift() ?? [])),
    selectDistinctOn: jest.fn(() => chainOf([])),
    insert: jest.fn(() => ({
      values: () => ({ returning: () => Promise.resolve([]) }),
    })),
    delete: jest.fn(() => ({ where: () => Promise.resolve(undefined) })),
    update: jest.fn(() => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    })),
    query: {
      previewDeployment: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    $count: jest.fn().mockResolvedValue(0),
  };
  return db;
};

const makeService = ({
  db,
  remoteExec = makeRemoteExec(),
  deployments = {},
  github = {},
  engine = {},
}: {
  db: ReturnType<typeof dbAnswering>;
  remoteExec?: ReturnType<typeof makeRemoteExec>;
  deployments?: Partial<Record<keyof DeploymentsService, jest.Mock>>;
  github?: Partial<Record<keyof GithubService, jest.Mock>>;
  engine?: Partial<Record<keyof DeploymentEngineService, jest.Mock>>;
}) =>
  new PreviewDeploymentsService(
    db as unknown as DrizzleDB,
    {
      checkPermission: jest.fn().mockResolvedValue(undefined),
      checkServiceAccess: jest.fn().mockResolvedValue(undefined),
    } as unknown as PermissionService,
    {} as ApplicationsService,
    engine as unknown as DeploymentEngineService,
    github as unknown as GithubService,
    remoteExec,
    {
      cancelPreviewBuilds: jest
        .fn()
        .mockResolvedValue({ cancelled: [], building: false }),
      ...deployments,
    } as unknown as DeploymentsService,
    {} as TraefikAppConfigService,
    { audit: jest.fn().mockResolvedValue(null) } as unknown as AuditLogService,
    {
      isFrozenAt: jest.fn().mockResolvedValue(false),
    } as unknown as FrozenOrganizations,
  );

const codeOf = (error: unknown): unknown =>
  error instanceof ConflictException
    ? (error.getResponse() as { code?: string }).code
    : undefined;

/** A cloud Application as the refusal chain reads it. */
const CLOUD_PARENT = {
  applicationId: 'app-1',
  name: 'Shop',
  appName: 'shop-x1',
  configKind: 'web',
  sourceType: 'github',
  serverId: null,
  cloudAccountId: 'acct-1',
  previewWildcard: '*.preview.example.com',
  previewDnsChallenge: false,
  requestedPreviewsAllowed: true,
  requestedPreviewLimit: 3,
};

const PREVIEW = {
  previewDeploymentId: 'prev-1',
  applicationId: 'app-1',
  appName: 'preview-shop-x1-abc',
  branch: 'feature',
  domain: 'preview-shop-x1-abc.preview.example.com',
  trigger: 'pullRequest',
  pullRequestNumber: '7',
  expiredAt: null,
} as unknown as PreviewDeployment;

/** What `findOwnedPreview` projects, for a preview of a cloud parent. */
const OWNED_CLOUD_PREVIEW = {
  preview: PREVIEW,
  name: 'Shop',
  serverId: null,
  buildServerId: null,
  cloudAccountId: 'acct-1',
  previewWildcard: '*.preview.example.com',
  previewDnsChallenge: false,
  requestedPreviewsAllowed: true,
  sourceType: 'github',
};

describe('previewTeardownSteps', () => {
  it('has no step for a preview whose parent runs in a Cloud account', () => {
    expect(
      previewTeardownSteps(makeRemoteExec() as unknown as RemoteExecService, {
        appName: 'preview-shop-x1-abc',
        serverId: null,
        buildHostId: null,
        cloudAccountId: 'acct-1',
      }),
    ).toEqual([]);
  });

  it('still tears down a preview whose parent is on the platform host or a Server', () => {
    expect(
      previewTeardownSteps(makeRemoteExec() as unknown as RemoteExecService, {
        appName: 'preview-shop-x1-abc',
        serverId: null,
        buildHostId: null,
        cloudAccountId: null,
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe('tearDownApplicationPreviews', () => {
  it('runs nothing on any machine for a preview of a cloud Application, and reports it gone', async () => {
    const remoteExec = makeRemoteExec();
    const db = dbAnswering([
      {
        appName: 'preview-shop-x1-abc',
        serverId: null,
        buildServerId: null,
        cloudAccountId: 'acct-1',
      },
    ]);

    const report = await tearDownApplicationPreviews(
      db as unknown as DrizzleDB,
      remoteExec,
      ['app-1'],
    );

    expect(execCalls(remoteExec)).toEqual([]);
    expect(report).toEqual({ orphaned: [], unreclaimedArtifacts: [] });
  });
});

describe('PreviewDeploymentsService, for an Application in a Cloud account', () => {
  it('refuses a Requested preview, writing nothing and queueing nothing', async () => {
    const db = dbAnswering([CLOUD_PARENT]);
    const queuePreviewBuild = jest.fn();
    const service = makeService({ db, deployments: { queuePreviewBuild } });

    const error: unknown = await service
      .createRequested(ctx, 'app-1', { branch: 'feature' })
      .catch((caught: unknown) => caught);

    expect(codeOf(error)).toBe(CLOUD_APPLICATION_HAS_NO_PREVIEWS_CODE);
    expect((error as Error).message).toContain('Shop runs in a Cloud account');
    expect(db.insert).not.toHaveBeenCalled();
    expect(queuePreviewBuild).not.toHaveBeenCalled();
  });

  it('refuses a rebuild of a preview made before the refusal', async () => {
    const db = dbAnswering([OWNED_CLOUD_PREVIEW]);
    const queuePreviewBuild = jest.fn();
    const joinQueuedPreviewBuild = jest.fn();
    const service = makeService({
      db,
      deployments: { queuePreviewBuild, joinQueuedPreviewBuild },
    });

    const error: unknown = await service
      .redeploy(ctx, 'prev-1')
      .catch((caught: unknown) => caught);

    expect(codeOf(error)).toBe(CLOUD_APPLICATION_HAS_NO_PREVIEWS_CODE);
    expect(joinQueuedPreviewBuild).not.toHaveBeenCalled();
    expect(queuePreviewBuild).not.toHaveBeenCalled();
  });

  it('removes a preview made before the refusal without running anything on the platform host', async () => {
    const remoteExec = makeRemoteExec();
    const db = dbAnswering([OWNED_CLOUD_PREVIEW]);
    const service = makeService({ db, remoteExec });

    await service.remove(ctx, 'prev-1');

    expect(execCalls(remoteExec)).toEqual([]);
    expect(db.delete).toHaveBeenCalled();
  });

  describe('a pull request', () => {
    const event: GithubPullRequestEvent = {
      action: 'opened',
      pullRequestId: 'pr-1',
      pullRequestNumber: '7',
      pullRequestTitle: 'A change',
      pullRequestURL: 'https://github.com/acme/shop/pull/7',
      headBranch: 'feature',
      baseBranch: 'main',
      repository: 'shop',
      owner: 'acme',
      prAuthor: 'dev',
    };
    const target = {
      ...CLOUD_PARENT,
      owner: 'acme',
      repository: 'shop',
      branch: 'main',
      isPreviewDeploymentsActive: true,
      previewLimit: 3,
    };

    it('builds no preview and tells the pull request why', async () => {
      const db = dbAnswering([target], [{ githubId: 'gh-1' }]);
      const queuePreviewBuild = jest.fn();
      const postPrComment = jest.fn().mockResolvedValue(undefined);
      const service = makeService({
        db,
        deployments: { queuePreviewBuild },
        github: {
          checkUserRepositoryPermissions: jest
            .fn()
            .mockResolvedValue({ hasWriteAccess: true }),
          postPrComment,
        },
      });

      await service.handlePullRequestEvent('gh-1', event);

      expect(db.insert).not.toHaveBeenCalled();
      expect(queuePreviewBuild).not.toHaveBeenCalled();
      expect(postPrComment).toHaveBeenCalledWith(
        { githubId: 'gh-1' },
        expect.objectContaining({
          issueNumber: 7,
          body: expect.stringContaining('Cloud account') as unknown,
        }),
      );
    });

    it('tears down a preview made before the refusal without running anything on the platform host', async () => {
      const remoteExec = makeRemoteExec();
      const db = dbAnswering([
        {
          preview: PREVIEW,
          serverId: null,
          buildServerId: null,
          cloudAccountId: 'acct-1',
        },
      ]);
      const service = makeService({ db, remoteExec });

      await service.handlePullRequestEvent('gh-1', {
        ...event,
        action: 'closed',
      });

      expect(execCalls(remoteExec)).toEqual([]);
      expect(db.delete).toHaveBeenCalled();
    });
  });
});

describe('refuseCloudPreviewSwitches', () => {
  const cloud = {
    name: 'Shop',
    cloudAccountId: 'acct-1',
    isPreviewDeploymentsActive: false,
    requestedPreviewsAllowed: false,
  };

  it.each([
    [{ isPreviewDeploymentsActive: true }],
    [{ requestedPreviewsAllowed: true }],
  ])('refuses switching previews on for a cloud Application: %j', (data) => {
    let error: unknown;
    try {
      refuseCloudPreviewSwitches(cloud, data);
    } catch (caught) {
      error = caught;
    }
    expect(codeOf(error)).toBe(CLOUD_APPLICATION_HAS_NO_PREVIEWS_CODE);
  });

  it('lets a switch already on stay on, and any switch go off', () => {
    const on = {
      ...cloud,
      isPreviewDeploymentsActive: true,
      requestedPreviewsAllowed: true,
    };
    expect(() =>
      refuseCloudPreviewSwitches(on, {
        isPreviewDeploymentsActive: true,
        requestedPreviewsAllowed: false,
      }),
    ).not.toThrow();
  });

  it('leaves an Application on a Server alone', () => {
    expect(() =>
      refuseCloudPreviewSwitches(
        { ...cloud, cloudAccountId: null },
        { isPreviewDeploymentsActive: true, requestedPreviewsAllowed: true },
      ),
    ).not.toThrow();
  });
});
