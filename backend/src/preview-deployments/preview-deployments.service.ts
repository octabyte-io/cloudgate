import { FrozenOrganizations } from '../cloud/billing/frozen-organizations.service';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { application } from '../applications/application.schema';
import { refuseWhileInMaintenance } from '../servers/server-maintenance';
import type {
  Application,
  ApplicationConfigKind,
  ApplicationStatus,
} from '../applications/application.schema';
import { ApplicationsService } from '../applications/applications.service';
import {
  assertKindAllows,
  KINDS_WITHOUT_PREVIEWS,
} from '../applications/config-kind-locks';
import { isCloudService } from '../common/cloud-service-host-work';
import { runTeardownSteps } from '../common/teardown-steps';
import { generateAppName } from '../db/columns';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { CONVERGENCE_BUDGET_CAP_MS } from '../deployment-engine/await-convergence';
import { buildHostServerId } from '../deployment-engine/build-host';
import { fileMountsDirectoryOnRunServer } from '../deployment-engine/deployment-engine.paths';
import { DeploymentEngineService } from '../deployment-engine/deployment-engine.service';
import type { DeployMeta } from '../deployment-engine/deployment-engine.service';
import type { DeployableApplication } from '../deployment-engine/deployment-engine.types';
import { deployment } from '../deployments/deployment.schema';
import type { Deployment } from '../deployments/deployment.schema';
import { DeploymentsService } from '../deployments/deployments.service';
import type { ServiceMount } from '../docker/docker.types';
import { generateFileMounts } from '../docker/docker.utils';
import { AUDIT_REASON } from '../enterprise/audit-logs/audit-log.schema';
import { AuditLogService } from '../enterprise/audit-logs/audit-log.service';
import { environment } from '../environments/environment.schema';
import type { SourceType } from '../git-providers/git-provider.schema';
import { onBranch } from '../git-providers/source-branch';
import { github } from '../git-providers/strategies/github/github.schema';
import type { Github } from '../git-providers/strategies/github/github.schema';
import { GithubService } from '../git-providers/strategies/github/github.service';
import { project } from '../projects/project.schema';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import { requestedPreviewMaxTtlMinutes } from '../settings/requested-preview-max-ttl';
import { TraefikAppConfigService } from '../traefik/app-config.service';
import { previewDeployment } from './preview-deployment.schema';
import type {
  PreviewDeployment,
  PreviewTrigger,
} from './preview-deployment.schema';
import {
  noPreviewAddress,
  noPreviewAddressMessage,
  noPreviewAddressRefusal,
  previewHost,
  previewHostRuleOf,
} from './preview-host';
import type { PreviewHostRule } from './preview-host';
import { previewTeardownSteps } from './preview-teardown';
import { CLOUD_PREVIEWS_REFUSAL, refuseCloudPreview } from './cloud-preview';
import { dnsResolverCertificatesOn } from './dns-resolver-certificates';
import { dnsChallengeWildcardOf } from './preview-dns-challenge';
import { previewLinks } from '../project-config/outputs';
import { previewCertificatesOf, previewUrl } from './preview-url';
import type { PreviewUrl } from './preview-url';
import { requestedByOf } from './requested-preview-reads';
import type { RequestedBy } from './requested-preview-reads';
import {
  announcesBuilds,
  expiryAfter,
  PREVIEW_EXPIRED_REFUSAL,
  REQUESTED_PREVIEW_DEFAULT_TTL_MINUTES,
  REQUESTED_PREVIEW_REFUSAL_CODE,
  REQUESTED_PREVIEWS_NOT_ALLOWED,
  requestedPreviewDescription,
  requestedPreviewInputRefusal,
  requestedPreviewLimitRefusal,
} from './requested-preview';

/** The pull-request webhook fields preview deployments react to. */
export interface GithubPullRequestEvent {
  action: 'opened' | 'reopened' | 'synchronize' | 'closed';
  pullRequestId: string;
  pullRequestNumber: string;
  pullRequestTitle: string;
  pullRequestURL: string;
  /** The PR's branch — what the preview builds. */
  headBranch: string;
  /** The branch the PR targets — matched against the application's branch. */
  baseBranch: string;
  repository: string;
  owner: string;
  /** The PR author — only collaborators with write access get previews. */
  prAuthor: string;
}

/**
 * A preview as a read answers it: the row, plus the link printed for it by
 * {@link previewUrl} — derived on every read, never stored — and the
 * newest Deployment built into it, `null` before its first: the id
 * whose log `read_deployment_log` reads.
 */
export type PreviewDeploymentRead = PreviewDeployment &
  PreviewUrl & { latestDeploymentId: string | null };

/**
 * A preview as the list and get routes answer it: the read, plus who
 * asked for it — from its create audit row, so a removed requester is still
 * named. `requestedBy` is null on a pull-request preview. Its newest build is
 * the read's own `latestDeploymentId`, read once by {@link
 * PreviewDeploymentsService.latestBuildsOf}.
 */
export type PreviewDeploymentListed = PreviewDeploymentRead & {
  requestedBy: RequestedBy | null;
};

/**
 * What asking for a Requested preview answers: the preview as every
 * later read prints it, plus the `pending` Deployment its first build was
 * queued under — the id a caller follows the build's log by.
 */
export type RequestedPreviewCreated = PreviewDeploymentRead & {
  deploymentId: string;
};

/** What a Requested preview is asked for with; the shape is the DTO's. */
export interface RequestedPreviewInput {
  branch: string;
  ttlMinutes?: number;
}

/**
 * The parent Application as the refusal chain and a requested preview's build
 * need it: the switch, the source type the validation step reads, and what
 * the preview's name, host and printed link are made from.
 */
interface RequestedParent {
  applicationId: string;
  /** What a refusal names it by. */
  name: string;
  appName: string;
  /** Set when it runs in a Cloud account, which has no previews. */
  cloudAccountId: string | null;
  /** Whether its kind has previews at all. */
  configKind: ApplicationConfigKind;
  sourceType: SourceType;
  serverId: string | null;
  /** Where its builds run, which maintenance refuses as the run Server's. */
  buildServerId: string | null;
  previewWildcard: string | null;
  /** Whether the printed link counts DNS-01 certificates. */
  previewDnsChallenge: boolean;
  requestedPreviewsAllowed: boolean;
  /** The cap step's limit. */
  requestedPreviewLimit: number;
}

/**
 * The switch step of the refusal chain (ADR-0026). A precondition on
 * the Application and not on the caller: it never asks who is calling, only
 * whether the operator allowed requested previews here — so it runs only
 * after the grant, and a caller without one never learns the setting.
 */
function refuseUnlessAllowed(parent: {
  requestedPreviewsAllowed: boolean;
}): void {
  if (!parent.requestedPreviewsAllowed) {
    throw new ConflictException({
      message: REQUESTED_PREVIEWS_NOT_ALLOWED,
      code: REQUESTED_PREVIEW_REFUSAL_CODE.notAllowed,
    });
  }
}

/** The `409` of extending or redeploying an expired Requested preview. */
const previewExpired = () =>
  new ConflictException({
    message: PREVIEW_EXPIRED_REFUSAL,
    code: REQUESTED_PREVIEW_REFUSAL_CODE.expired,
  });

/**
 * A Requested preview that is already expired: marked by the sweep or a
 * `DELETE` and waiting only for its copy to go, so nothing more is built into
 * it and its expiry no longer moves. A state of the resource, so `409`.
 */
function refuseIfExpired(preview: PreviewDeployment): void {
  if (preview.expiredAt !== null) throw previewExpired();
}

/**
 * The description a preview's build row carries, by what made the preview:
 * the pull request's number, or the branch that was asked for.
 */
const buildDescription = (preview: PreviewDeployment): string =>
  preview.trigger === 'requested' || preview.pullRequestNumber === null
    ? requestedPreviewDescription(preview.branch)
    : pullRequestDescription(preview.pullRequestNumber);

/** How often a teardown looks again at a preview build it is waiting out.
 * */
const PREVIEW_BUILD_POLL_MS = 1_000;

/**
 * The longest a teardown waits for a preview build to end: the
 * engine's convergence cap plus five minutes for everything around it, so a
 * release that ends at all ends inside it.
 */
const PREVIEW_BUILD_WAIT_MS = CONVERGENCE_BUDGET_CAP_MS + 5 * 60_000;

/** The two machines a preview's artifacts are on. */
type TeardownServers = {
  serverId: string | null;
  buildServerId: string | null;
  /** Set when the parent runs in a Cloud account: nothing is on any machine. */
  cloudAccountId: string | null;
};

/**
 * What a preview build's Deployment row says it is for.
 *
 * Both places that queue a preview build write it — the pull-request webhook
 * and the Redeploy button — because the row lands in the *parent* Application's
 * deployment history beside every other preview's, and a rebuild that left the
 * description empty was the one row in that list an operator could not attribute
 * to a pull request. One expression of the wording, so the two cannot
 * drift back apart.
 */
const pullRequestDescription = (pullRequestNumber: string) =>
  `Pull request #${pullRequestNumber}`;

/**
 * Where a pull-request comment goes: the connection it is posted through, and
 * the repository it lands in.
 *
 * **A type rather than the three columns inline, because two different rows
 * answer it**. A ready preview and a failed build hand over a
 * {@link DeployableApplication}, which carries its own `github` connection from
 * the deploy query's join; a refusal hands over a plain `application` row from
 * {@link PreviewDeploymentsService.findPreviewTargets} — which selects from
 * `application` alone and so has a `githubId` and no credentials — beside the
 * connection the delivery was already verified against. Naming the three fields
 * says that is the whole of what a comment needs, so neither caller has to be a
 * shape it is not.
 *
 * Every field is nullable because every column is: an Application can have no
 * Git connection at all, and `postPrComment` answers that by posting nothing
 * rather than by refusing.
 */
interface PrCommentTarget {
  github?: Github | null;
  owner: string | null;
  repository: string | null;
}

/**
 * Why a pull request got no preview: its Application already holds
 * `previewLimit` of them, it sets no preview wildcard and no IP is
 * recorded for the machine a preview would run on, so no host would resolve,
 * or it runs in a Cloud account, which has no previews (`cloud-preview.ts`).
 * Either way nothing is written or built, and the pull request is told.
 */
type PullRequestPreviewRefusal = 'atLimit' | 'noAddress' | 'inCloud';

/**
 * A number of previews with the noun that agrees with it — `1 preview`,
 * `2 previews`.
 *
 * One expression of the plural because the refusal is told twice, in two
 * registers: {@link previewLimitRefusal} says it to the contributor on the pull
 * request and {@link PreviewDeploymentsService.reportRefusal}'s `warn` says it
 * to the operator in the log. The two sentences are deliberately different —
 * they answer different questions — but the limit inside them is the same
 * number counting the same thing, and a `${n} preview${n === 1 ? '' : 's'}`
 * written out at each site is the kind of copy that comes to disagree on the
 * edge nobody reads twice.
 */
const previewCount = (previews: number): string =>
  `${previews} preview${previews === 1 ? '' : 's'}`;

/**
 * What a pull request refused by `previewLimit` is told, on the pull request
 * itself.
 *
 * **The refusal was the one outcome of a `pull_request` delivery that reported
 * nowhere at all.** {@link PreviewDeploymentsService.ensurePreview} answers
 * `null` at the cap and the webhook `continue`d past it, so the contributor who
 * opened the pull request saw a delivery answer 200 and nothing else — no
 * preview, no comment, no row, no log line — while the two pull requests
 * holding the slots each carried the bot's "ready" comment. A ready preview and
 * a failed build already report here; this is the third outcome of the same
 * event, through the same channel, because the person who needs it is the one
 * person who cannot see the console.
 *
 * **Word for word what the screen promises**, which is the half already
 * fixed on the other side: the "Most previews at once" hint says a pull
 * request past the limit "is refused, not queued — closing one frees its slot",
 * so this says *refused*, names the limit, and sends the reader at the one
 * action that changes the answer. A preview is not written down anywhere when
 * it is refused, so the pull request gets one when it *next pushes* into a free
 * slot rather than when a slot happens to open — which is the sentence's last
 * clause and is what stops it promising a queue the product does not have.
 *
 * **Zero is a different sentence and not the plural one with a `0` in it.**
 * "Closing another pull request frees a slot" is false when the limit is zero —
 * closing every pull request open frees nothing — so a contributor sent to do
 * that by this comment would be sent on an errand that cannot work. What is
 * true there is that the Application's own setting turns previews off, and that
 * is what the zero arm names.
 */
const previewLimitRefusal = (previewLimit: number): string =>
  previewLimit === 0
    ? 'This pull request was refused a preview: this Application builds none at all — its "Most previews at once" is 0. Raising that limit and pushing again builds one.'
    : `This pull request was refused a preview: this Application builds at most ${previewCount(previewLimit)} at once, and that many are already open. Closing another pull request frees a slot, and this one gets a preview the next time it is pushed to.`;

/**
 * The parent Application's mounts as a preview's service spec has to name
 * them: every `file` mount converted to a `bind` of the file the parent's own
 * write created, every other mount untouched.
 *
 * **What broke first.** {@link PreviewDeploymentsService.deployPreview} spreads
 * the parent row — its `mounts` included — over `{ appName: preview.appName }`,
 * and `mechanize.ts`' `buildServiceSettings` resolved the file-mounts directory
 * as `fileMountsDirectoryOnRunServer(serverId, appName)` off that same
 * overridden column. But `MountsService.writeFileMount` addresses its write by
 * `findParentService`'s row, and a preview has no row in any of the eight
 * service tables — so nothing in the product ever wrote
 * `{preview.appName}/files`. The spec's `Source` therefore named a path that
 * did not exist, Docker mints a missing bind source as a **directory**, and the
 * preview container came up with an empty directory where its config file
 * belongs. Nothing failed, which is why it took a probe to find.
 *
 * **A preview inherits its parent's storage and owns only what its own
 * `appName` names** — ADR-0021 — and the measurement that settles it is one
 * file over. `generateVolumeMounts` names `mount.volumeName` and
 * `generateBindMounts` names `mount.hostPath`; neither carries an `appName`, so
 * a preview has always mounted the parent's named volume and the parent's host
 * directory verbatim. A `file` mount is the one kind whose location is
 * *composed* out of an `appName`, and that composition is the only reason it
 * ever looked like the preview's own.
 *
 * **Materializing a copy under `{preview.appName}/files` was the rejected
 * alternative**, and it fails on what it would have to duplicate rather than on
 * effort. `mount.content` is `encryptedText` under ADR-0015 *because a file
 * body is where an operator puts a credential*, and an earlier fix took that
 * column off the deploy path deliberately —
 * `ApplicationsService.findDeployable` projects `mounts` to `ServiceMount`'s
 * five fields — so a copy means decrypting it back onto the deploy path and
 * writing a **second plaintext copy** of that credential onto the machine. It
 * buys no divergence to pay for that: there is no `previewMounts` column, so
 * the copy would be re-materialized byte-identical from the same rows on every
 * deploy, and the enumeration of preview settings has no mount among them — a
 * preview's divergence is operator-authored, lives in
 * `previewEnv`/`previewBuildArgs`, and is bounded to them. It would also
 * multiply ADR-0018's atomicity set from one writer to one per live preview:
 * `MountsService.remove` addresses `{parent.appName}` alone, so a deleted
 * mount's copies would outlive the row inside every preview of it.
 *
 * **Dropping a preview's file mounts was the other**, and it is neither
 * isolation nor honesty: the volume and the bind would still be production's,
 * so it gives up the operator's configuration without giving up anything that
 * configuration endangers, and an application that needs a config file to start
 * would not start.
 *
 * **A `bind` rather than a `file`, and that is the accurate word rather than a
 * trick.** The two emit the identical spec entry — `generateBindMounts` and
 * `generateFileMounts` both produce `{ Type: 'bind', Source, Target }` — and
 * `docker/docker.types.ts` reads `bind` as the *host path*, which is exactly
 * what the parent's materialized file is to a preview: a path on the run Server
 * that this deployment did not create and does not own. The conversion goes
 * through `generateFileMounts` itself rather than re-joining the directory and
 * the `filePath` here, so this is not a second expression of that path (the
 * one-composition rule): the one composition of it stays in
 * `docker/docker.utils.ts`, and a change to how a file mount's source is
 * composed reaches a preview without anyone remembering this function.
 *
 * **Resolved here rather than in `mechanize.ts`** because this is the only
 * place both names are in scope, which is `preview-teardown.ts`' own argument
 * for being where all four delete paths meet. A field on
 * `DeployableApplication` naming the mounts' owner was the shape tried first
 * and `test/coding-standards/deployable-query-result-types.spec.ts` refuses it:
 * that type is what `findDeployable` returns, and every field of it must be one
 * a query fills.
 */
function inheritedMounts(app: DeployableApplication): ServiceMount[] {
  const mounts = app.mounts ?? [];
  return [
    ...mounts.filter((mount) => mount.type !== 'file'),
    ...generateFileMounts(
      mounts,
      // The **parent's** name, and the run Server that both the write and the
      // daemon resolving this source answer for.
      fileMountsDirectoryOnRunServer(app.serverId, app.appName),
    ).map(({ Source, Target }) => ({
      type: 'bind' as const,
      hostPath: Source,
      mountPath: Target,
    })),
  ];
}

/**
 * Per-PR preview environments. A pull request against an application's
 * tracked branch spins up an isolated deployment under its own appName and
 * domain; closing the PR tears it down.
 */
@Injectable()
export class PreviewDeploymentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly applications: ApplicationsService,
    private readonly engine: DeploymentEngineService,
    private readonly githubService: GithubService,
    private readonly remoteExec: RemoteExecService,
    /** Where a preview build is recorded `pending` and queued, and where a
     * redeploy finds the pending build it joins. It reaches the queue
     * lazily itself, so this service no longer holds one. */
    private readonly deployments: DeploymentsService,
    private readonly traefik: TraefikAppConfigService,
    /** A Requested preview's create and extend write their own rows. */
    private readonly auditLogs: AuditLogService,
    private readonly frozen: FrozenOrganizations,
  ) {}

  private readonly logger = new Logger(PreviewDeploymentsService.name);

  /**
   * Handles a GitHub `pull_request` webhook delivery. Webhooks are
   * unauthenticated, so this is keyed by the connection the delivery was
   * verified against and NOT org-scoped.
   */
  async handlePullRequestEvent(
    githubId: string,
    event: GithubPullRequestEvent,
  ): Promise<void> {
    if (
      event.action === 'opened' ||
      event.action === 'reopened' ||
      event.action === 'synchronize'
    ) {
      const targets = await this.findPreviewTargets(githubId, event);
      if (targets.length === 0) return;

      // PR-author gate: previews build arbitrary PR code, so only
      // write/maintain/admin collaborators may spin them up.
      const connection = await this.findConnection(githubId);
      const { hasWriteAccess } =
        await this.githubService.checkUserRepositoryPermissions(connection, {
          owner: event.owner,
          repo: event.repository,
          username: event.prAuthor,
        });
      if (!hasWriteAccess) return;

      for (const app of targets) {
        // A Frozen Organization's pull requests build no preview
        // (ADR-0052); closing one still tears its preview down.
        if (await this.frozen.isFrozenAt({ serviceId: app.applicationId })) {
          continue;
        }
        // A cloud Application's preview would be built and run on the
        // platform host (`cloud-preview.ts`): refused before a row is
        // written, and told like any other refusal.
        if (isCloudService(app)) {
          await this.reportRefusal(app, connection, event, 'inCloud');
          continue;
        }
        const preview = await this.ensurePreview(app, event);
        // Refused — the application is already holding previewLimit previews
        // and this pull request owns none of them, or its preview would have
        // no host that resolves — so nothing is built. It is told so on
        // the pull request and written to the log, because a refusal that
        // reports nowhere is indistinguishable from a webhook that was never
        // delivered.
        if (typeof preview === 'string') {
          await this.reportRefusal(app, connection, event, preview);
          continue;
        }
        // A pull request's push queues every time, as it always has: only a
        // redeploy coalesces.
        await this.deployments.queuePreviewBuild(preview, 'deploy', {
          title: 'Preview Deployment',
          description: pullRequestDescription(event.pullRequestNumber),
        });
      }
    }
    if (event.action === 'closed') {
      const rows = await this.db
        .select({
          preview: previewDeployment,
          serverId: application.serverId,
          buildServerId: application.buildServerId,
          cloudAccountId: application.cloudAccountId,
        })
        .from(previewDeployment)
        .innerJoin(
          application,
          eq(previewDeployment.applicationId, application.applicationId),
        )
        .where(
          and(
            eq(previewDeployment.pullRequestId, event.pullRequestId),
            eq(application.githubId, githubId),
          ),
        );
      for (const row of rows) {
        await this.teardown(row.preview, row);
      }
    }
  }

  /**
   * The cleanup pipeline: remove the Swarm service, the cloned code, and the
   * row — each step best-effort, so a missing service can't strand the
   * others.
   *
   * **The two machine steps take one Server each, and that is a consistency
   * fix rather than a live leak.** This took a single `serverId` and
   * used it for both, and both of its callers read that id off
   * `application.serverId` — while {@link deployPreview} spreads the whole
   * parent row into `engine.deploy`, so `buildServerId` survives and is what
   * decides where the clone lands. On an install with a dedicated build Server
   * the `rm -rf` would therefore be issued to a machine that had never held the
   * directory.
   *
   * **That state is currently unreachable, and the reason is worth stating so
   * nobody "simplifies" this back.** {@link deployPreview} forces `registry:
   * null` and `buildRegistry: null`, and a preview exists only for
   * `sourceType: 'github'` ({@link findPreviewTargets}), so
   * `assertBuiltImageReachesRunServer` throws before the clone for every
   * preview whose `buildServerId` differs from its `serverId`. The wrong
   * machine was therefore never asked in production — but the two Servers are
   * genuinely two, and a preview *becoming* deployable on a build Server (a
   * Registry inherited rather than nulled, or that refusal narrowed) would
   * make it live with nothing here to notice. `preview-teardown.ts` owns both
   * words and both machines now, because `ApplicationsService.remove` and
   * `common/service-cascade.ts` tear the same two artifacts down for the same
   * rows — where the defect *was* live — and a second copy of the pair is how
   * one of them goes wrong again (ADR-0016's lesson, §1.4).
   *
   * The row delete stays here: it is the one step that is this route's rather
   * than the artifact's, and the bulk caller does not want it at all — a
   * cascade destroys the rows itself, in the statement that drops the parent.
   */
  private async teardown(
    preview: PreviewDeployment,
    servers: TeardownServers,
  ): Promise<void> {
    // The builds stop first, so nothing is still creating what the steps
    // below remove. One pass settles every build it can reach; only a
    // release past its cancel window is left, and that is waited out off the
    // request, so neither the webhook nor a `DELETE` holds a caller for the
    // minutes a release can take.
    const { building } = await this.deployments.cancelPreviewBuilds(
      preview.previewDeploymentId,
    );
    if (!building) return this.runTeardown(preview, servers);
    this.logger.log(
      `Preview ${preview.appName} is releasing a build past its cancel window; it is torn down once that build ends.`,
    );
    void this.stopBuilds(preview)
      .then(() => this.runTeardown(preview, servers))
      .catch((error: unknown) => {
        this.logger.error(
          `Preview ${preview.appName} could not be torn down after its build ended: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  /** The teardown steps themselves, once no build of the preview is left. */
  private async runTeardown(
    preview: PreviewDeployment,
    servers: TeardownServers,
  ): Promise<void> {
    // Best effort: keep cleaning what's left, in `common/teardown-steps.ts`'s
    // one loop.
    //
    // The directory step's `leftBehindOnFailure` is deliberately dropped here
    // and not on the two Delete paths, because this route has nowhere truthful
    // to put it: `DELETE /preview-deployments/:id` answers with the preview row
    // itself, and the closed-pull-request webhook answers GitHub. That is the
    // same asymmetry `tearDownApplicationPreviews` already records for the
    // *refusal* — these two callers drop the row regardless — and whether all
    // three should report is a question about this method rather than about the
    // deletes.
    await runTeardownSteps([
      ...previewTeardownSteps(this.remoteExec, {
        appName: preview.appName,
        serverId: servers.serverId,
        buildHostId: buildHostServerId(servers),
        cloudAccountId: servers.cloudAccountId,
      }),
      {
        run: () =>
          this.db
            .delete(previewDeployment)
            .where(
              eq(
                previewDeployment.previewDeploymentId,
                preview.previewDeploymentId,
              ),
            ),
      },
    ]);
  }

  /**
   * Stops the preview's builds and waits out the one that cannot be stopped,
   * before {@link runTeardown} removes anything.
   *
   * **What leaked without it.** A pull request that closed mid-build tore the
   * preview down while its release was still creating the Swarm service, and
   * `deployPreview` then routed the host of a preview that no longer had a
   * row: a container and a router nothing named. Teardown now cancels every
   * pending build of the preview and any running one still inside its
   * cancel window, through {@link DeploymentsService.cancelPreviewBuilds}; a
   * build past its window is releasing, which a kill cannot stop part-way, so
   * teardown waits for it to end and tears down after it. Teardown never races
   * a release.
   *
   * **It changes when teardown runs, never whether.** The wait is bounded by
   * {@link PREVIEW_BUILD_WAIT_MS}, which is longer than the engine's longest
   * convergence budget, so a release that ends at all ends inside it; past it
   * the build is taken to be wedged, and the preview is torn down anyway,
   * which is what every caller of `teardown` has always done.
   *
   * **It runs off the request, and only when it has to.** {@link teardown}
   * makes the first pass itself and tears down inline when nothing is left
   * building, which is every close of a preview with no build, a pending one
   * or one inside its window. Only a release past its window reaches this,
   * and then the webhook and the `DELETE` answer at once while this waits: a
   * wait of up to {@link PREVIEW_BUILD_WAIT_MS} held a GitHub delivery past
   * its ten seconds and a `DELETE` past the 240 s proxy deadline. Its polls
   * are `unref`'d, so a wait in flight never holds a shutting-down process
   * open; the preview's row is then left in place for a `DELETE` to finish.
   */
  private async stopBuilds(preview: PreviewDeployment): Promise<void> {
    const deadline = Date.now() + PREVIEW_BUILD_WAIT_MS;
    for (;;) {
      const { building } = await this.deployments.cancelPreviewBuilds(
        preview.previewDeploymentId,
      );
      if (!building) return;
      if (Date.now() >= deadline) {
        this.logger.warn(
          `Preview ${preview.appName} is being torn down while one of its builds is still running: it did not finish within ${PREVIEW_BUILD_WAIT_MS / 60_000} minutes. Its Swarm service or router may come back after the teardown; check for "${preview.appName}" on the run Server.`,
        );
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, PREVIEW_BUILD_POLL_MS).unref(),
      );
    }
  }

  /** One preview, access-scoped like the list. */
  async findOne(
    ctx: PermissionCtx,
    previewDeploymentId: string,
  ): Promise<PreviewDeploymentListed> {
    const owned = await this.findOwnedPreview(ctx, previewDeploymentId);
    await this.permissions.checkServiceAccess(
      ctx,
      owned.preview.applicationId,
      'read',
    );
    const [read] = await this.asReads(ctx.session.activeOrganizationId, owned, [
      owned.preview,
    ]);
    const [listed] = await this.withRequesters(
      ctx.session.activeOrganizationId,
      [read],
    );
    return listed;
  }

  /**
   * Each read with its requester. The newest build is already on the
   * read, from {@link asReads}, so it is not read a second time here.
   */
  private async withRequesters(
    organizationId: string,
    reads: PreviewDeploymentRead[],
  ): Promise<PreviewDeploymentListed[]> {
    const requesters = await requestedByOf(this.db, organizationId, reads);
    return reads.map((read) => ({
      ...read,
      requestedBy: requesters.get(read.previewDeploymentId) ?? null,
    }));
  }

  /**
   * Each preview as every read answers it: the link {@link previewUrl} prints
   * for it, from one read of the Organization's certificates, and its
   * newest build from {@link latestBuildsOf}. `app` is the parent the
   * previews share: its run Server is the machine whose certificates count,
   * and its wildcard decides which `urlNote` an uncovered host gets.
   *
   * With the parent's DNS-01 switch on, that machine's `acme.json` is
   * read once for the whole list too — and not at all with it off, so a
   * preview read touches no machine unless the answer can depend on it.
   */
  private async asReads(
    organizationId: string,
    app: {
      serverId: string | null;
      previewWildcard: string | null;
      previewDnsChallenge: boolean;
    },
    previews: PreviewDeployment[],
  ): Promise<PreviewDeploymentRead[]> {
    const certificates = await previewCertificatesOf(this.db, organizationId);
    const resolverCertificates = app.previewDnsChallenge
      ? await dnsResolverCertificatesOn(this.db, this.remoteExec, app.serverId)
      : [];
    const latest = await this.latestBuildsOf(previews);
    const now = new Date();
    return previews.map((preview) => ({
      ...preview,
      latestDeploymentId: latest.get(preview.previewDeploymentId) ?? null,
      ...previewUrl({
        host: preview.domain,
        organizationId,
        serverId: app.serverId,
        previewWildcard: app.previewWildcard,
        certificates,
        previewDnsChallenge: app.previewDnsChallenge,
        resolverCertificates,
        now,
      }),
    }));
  }

  /**
   * **The latest build of each preview**: its newest Deployment row by
   * the link column, keyed by preview id; a preview with no build yet
   * is absent. One query for a whole list. {@link asReads} is its one
   * caller, so every read answer — the list, one, create, extend, delete —
   * carries it as `latestDeploymentId`, over HTTP and to the MCP tools alike.
   */
  private async latestBuildsOf(
    previews: readonly PreviewDeployment[],
  ): Promise<Map<string, string>> {
    if (previews.length === 0) return new Map();
    const rows = await this.db
      .selectDistinctOn([deployment.previewDeploymentId], {
        previewDeploymentId: deployment.previewDeploymentId,
        deploymentId: deployment.deploymentId,
      })
      .from(deployment)
      .where(
        inArray(
          deployment.previewDeploymentId,
          previews.map((preview) => preview.previewDeploymentId),
        ),
      )
      .orderBy(
        deployment.previewDeploymentId,
        desc(deployment.createdAt),
        desc(deployment.deploymentId),
      );
    return new Map(
      rows.map((row) => [row.previewDeploymentId!, row.deploymentId]),
    );
  }

  /**
   * What made a preview, read with no scope, or `null` for no such row:
   * how the MCP preview tools reach Requested previews only. A pull-request
   * preview's id answers there exactly as an unknown id does, before any
   * gated call — so an unscoped read tells an Agent nothing it could not
   * already get from a missing id, the narrowing `serviceOwnerOf` is for.
   */
  async triggerOf(previewDeploymentId: string): Promise<PreviewTrigger | null> {
    const [found] = await this.db
      .select({ trigger: previewDeployment.trigger })
      .from(previewDeployment)
      .where(eq(previewDeployment.previewDeploymentId, previewDeploymentId))
      .limit(1);
    return found?.trigger ?? null;
  }

  /**
   * Re-enqueues the preview's build.
   * Whoever can read the application and create deployments may rebuild.
   *
   * The default description is the pull request's, not empty: the row
   * this job writes is a Deployment of the *parent* Application, so it is listed
   * among every other preview's, and `findOwnedPreview` has already read the
   * preview that names the one it belongs to.
   *
   * **Answers the queued Deployment**: the `pending` row of the parent
   * naming this preview. A redeploy while this preview's own build is still
   * waiting joins that build and answers it, queueing nothing — scoped by the
   * link column, so a pending production deploy or another preview's build in
   * the same queue group is never joined.
   *
   * **A Requested preview's redeploy runs the same chain as its create, minus
   * the cap**: the permission, the grant, and then the switch, so an
   * operator who turns requested previews off stops rebuilds of the live ones
   * too. It never moves the expiry. A pull-request preview's redeploy is
   * untouched by the switch, which is not its setting.
   */
  async redeploy(
    ctx: PermissionCtx,
    previewDeploymentId: string,
    meta: DeployMeta = {},
  ): Promise<Deployment> {
    const { deployment } = await this.redeployOwned(
      ctx,
      previewDeploymentId,
      meta,
    );
    return deployment;
  }

  /**
   * {@link redeploy}, answering the preview as a read does beside the queued
   * Deployment (`redeploy_preview`). The read is built from the row
   * the gates already read, so the tool passes the permission, the grant and
   * the switch once, as its twin does (ADR-0023), rather than again through
   * {@link findOne}.
   */
  async redeployAndRead(
    ctx: PermissionCtx,
    previewDeploymentId: string,
  ): Promise<{ deployment: Deployment; read: PreviewDeploymentRead }> {
    const { owned, deployment } = await this.redeployOwned(
      ctx,
      previewDeploymentId,
      {},
    );
    const [read] = await this.asReads(ctx.session.activeOrganizationId, owned, [
      owned.preview,
    ]);
    return { deployment, read };
  }

  /** The gates and the queueing of {@link redeploy}, with the row it read. */
  private async redeployOwned(
    ctx: PermissionCtx,
    previewDeploymentId: string,
    meta: DeployMeta,
  ) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const owned = await this.findOwnedPreview(ctx, previewDeploymentId);
    await this.permissions.checkServiceAccess(
      ctx,
      owned.preview.applicationId,
      'read',
    );
    // Either trigger: a preview made before the refusal is never rebuilt.
    refuseCloudPreview(owned);
    if (owned.preview.trigger === 'requested') {
      refuseUnlessAllowed(owned);
      refuseIfExpired(owned.preview);
    }
    // Nothing new is built or started on a Server in maintenance (spec #1420).
    await refuseWhileInMaintenance(this.db, [
      owned.serverId,
      owned.buildServerId,
    ]);
    const pending =
      await this.deployments.joinQueuedPreviewBuild(previewDeploymentId);
    const deployment =
      pending ??
      (await this.deployments.queuePreviewBuild(owned.preview, 'redeploy', {
        title: meta.title ?? 'Rebuild Preview Deployment',
        description: meta.description ?? buildDescription(owned.preview),
      }));
    return { owned, deployment };
  }

  /**
   * Asks for a Requested preview of `input.branch` (ADR-0026): a copy of
   * the Application built from that branch under its own name and host, until
   * its expiry. Answers the preview with its printed link and the `pending`
   * Deployment its build was queued under. **Never coalesces** — two asks are
   * two previews, even of one branch.
   *
   * Nothing checks the branch exists and no git provider is called: a missing
   * branch fails the build, and the caller reads it in the log.
   */
  async createRequested(
    ctx: PermissionCtx,
    applicationId: string,
    input: RequestedPreviewInput,
    ip?: string,
  ): Promise<RequestedPreviewCreated> {
    const { parent, ttlMinutes, hostRule } = await this.admitRequestedCreate(
      ctx,
      applicationId,
      input,
      ip,
    );

    const appName = generateAppName(`preview-${parent.appName}`);
    const [preview] = await this.db
      .insert(previewDeployment)
      .values({
        applicationId: parent.applicationId,
        trigger: 'requested',
        branch: input.branch,
        requesterId: ctx.user.id,
        expiresAt: expiryAfter(new Date(), ttlMinutes),
        appName,
        domain: previewHost(appName, hostRule),
      })
      .returning();

    let queued: Deployment;
    try {
      queued = await this.deployments.queuePreviewBuild(preview, 'deploy', {
        title: 'Preview Deployment',
        description: requestedPreviewDescription(preview.branch),
      });
    } catch (error) {
      // Nothing was built and nothing is running, so the row names nothing:
      // leaving it would hold a copy's place (and a slot) for a
      // preview that was never queued.
      await this.db
        .delete(previewDeployment)
        .where(
          eq(
            previewDeployment.previewDeploymentId,
            preview.previewDeploymentId,
          ),
        );
      throw error;
    }

    // The caller is the actor, and the row is where "requested by" is read
    // from once the requester is gone: its column is `set null`.
    await this.auditLogs.audit(
      {
        userId: ctx.user.id,
        organizationId: ctx.session.activeOrganizationId,
        ip,
      },
      {
        action: 'create',
        resourceType: 'previewDeployment',
        resourceId: preview.previewDeploymentId,
        resourceName: preview.appName,
        metadata: {
          trigger: 'requested',
          // Also the actor's id, but `audit_log.user_id` is `set null` when
          // the requester goes, and the platform's removal row copies the
          // requester from here.
          requesterId: ctx.user.id,
          applicationId: parent.applicationId,
          branch: preview.branch,
          expiresAt: preview.expiresAt,
          deploymentId: queued.deploymentId,
        },
      },
    );

    const [read] = await this.asReads(
      ctx.session.activeOrganizationId,
      parent,
      [preview],
    );
    return { ...read, deploymentId: queued.deploymentId };
  }

  /**
   * **The refusal chain of a Requested preview's create, in order** — ADR-0026's
   * pin, and the one place the order is written:
   *
   * 1. the key and 2. the rate bucket are the transport's — `AuthGuard` over
   *    HTTP, the MCP dispatcher's bucket for an Agent;
   * 3. the permission, `deployment: ['create']`;
   * 4. the grant on the parent — its row-level access, then the Organization
   *    scope — so an ungranted caller gets the refusal every other preview
   *    route gives and learns nothing about the switch;
   * 5. the switch, `requestedPreviewsAllowed`, a 409, and before it the
   *    recorded kind: a web-private or a worker has no
   *    previews, also a 409, and then the place: an Application in a Cloud
   *    account has none either (`cloud-preview.ts`), a 409 too;
   * 6. input validation against the parent and the instance: a branch-bearing
   *    source type, a TTL within the maximum, and a host the preview can be
   *    reached at — a preview wildcard, or an IP recorded for the machine it
   *    runs on, a 400;
   * 7. the cap, `requestedPreviewLimit`, a 409 — **last**, because it
   *    is the only step that changes with time: a caller who waits out the cap
   *    must never then learn its request was invalid.
   *
   * Extend and redeploy run steps 3–5 (extend also its own validation) and
   * never the cap: only create takes a slot.
   *
   * The request's *shape* is the global pipe's and is checked before step 3 —
   * it reads nothing stored, so it tells an ungranted caller nothing.
   */
  private async admitRequestedCreate(
    ctx: PermissionCtx,
    applicationId: string,
    input: RequestedPreviewInput,
    ip?: string,
  ): Promise<{
    parent: RequestedParent;
    ttlMinutes: number;
    hostRule: PreviewHostRule;
  }> {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    await this.permissions.checkServiceAccess(ctx, applicationId, 'read');
    const parent = await this.findOwnedApplication(ctx, applicationId);
    assertKindAllows(parent.configKind, 'previews');
    refuseCloudPreview(parent);
    refuseUnlessAllowed(parent);
    // A Server in maintenance, run or build, takes no new preview (spec
    // #1420); it ends, so the caller may ask again.
    await refuseWhileInMaintenance(this.db, [
      parent.serverId,
      parent.buildServerId,
    ]);
    const ttlMinutes = await this.admittedTtl(
      parent.sourceType,
      input.ttlMinutes,
    );
    const hostRule = await previewHostRuleOf(this.db, parent);
    if (!hostRule) {
      throw new BadRequestException({
        message: noPreviewAddressMessage(parent.serverId),
        code: REQUESTED_PREVIEW_REFUSAL_CODE.noAddress,
      });
    }
    await this.refuseAtRequestedLimit(ctx, parent, input, ip);
    return { parent, ttlMinutes, hostRule };
  }

  /**
   * The input-validation step create and extend share: the TTL
   * asked for, or the default, once the parent's source builds from a branch
   * and the TTL is within the instance maximum; a `400` naming the maximum
   * otherwise. Answers the minutes to write.
   */
  private async admittedTtl(
    sourceType: SourceType,
    asked: number | undefined,
  ): Promise<number> {
    const ttlMinutes = asked ?? REQUESTED_PREVIEW_DEFAULT_TTL_MINUTES;
    const refusal = requestedPreviewInputRefusal({
      sourceType,
      ttlMinutes,
      maxTtlMinutes: await requestedPreviewMaxTtlMinutes(this.db),
    });
    if (refusal) throw new BadRequestException(refusal);
    return ttlMinutes;
  }

  /**
   * The cap step: refuses a create while the Application already
   * holds `requestedPreviewLimit` Requested previews. Counts `trigger =
   * 'requested'` rows alone — a pull request's preview never takes one of
   * these slots, nor this one of theirs — and every such row, an expired one
   * whose teardown is still pending included, because the cap is for the copy
   * occupying the Server.
   *
   * A `409`, not a `429`: the Application's state, not the caller's rate. It
   * writes a `failed` audit row with its fixed reason, so a looping Agent shows
   * under the Outcome filter, logs a warning, and notifies nobody.
   *
   * Read, then insert, without a lock, as `ensurePreview`'s count is: two
   * creates racing for the last slot can both be admitted.
   */
  private async refuseAtRequestedLimit(
    ctx: PermissionCtx,
    parent: RequestedParent,
    input: RequestedPreviewInput,
    ip?: string,
  ): Promise<void> {
    // Every row, not an aggregate: the expiry the refusal names is the
    // soonest unexpired one's, which a `min` over all of them hid.
    const siblings = await this.db
      .select({
        expiresAt: previewDeployment.expiresAt,
        expiredAt: previewDeployment.expiredAt,
      })
      .from(previewDeployment)
      .where(
        and(
          eq(previewDeployment.applicationId, parent.applicationId),
          eq(previewDeployment.trigger, 'requested'),
        ),
      );
    const refusal = requestedPreviewLimitRefusal({
      limit: parent.requestedPreviewLimit,
      siblings,
      now: new Date(),
    });
    if (!refusal) return;

    this.logger.warn(
      `A requested preview of "${input.branch}" was refused on the Application "${parent.appName}": it holds ${siblings.length} of its limit of ${parent.requestedPreviewLimit}.`,
    );
    await this.auditLogs.audit(
      {
        userId: ctx.user.id,
        organizationId: ctx.session.activeOrganizationId,
        ip,
      },
      {
        action: 'create',
        resourceType: 'previewDeployment',
        resourceName: parent.appName,
        outcome: 'failed',
        metadata: {
          reason: AUDIT_REASON.previewLimit,
          trigger: 'requested',
          applicationId: parent.applicationId,
          branch: input.branch,
          requestedPreviewLimit: parent.requestedPreviewLimit,
          held: siblings.length,
        },
      },
    );
    throw new ConflictException({
      message: refusal,
      code: REQUESTED_PREVIEW_REFUSAL_CODE.atLimit,
    });
  }

  /**
   * Moves a Requested preview's expiry to `now + ttl`: absolute, not
   * added to what is left, and within the instance maximum. Extending is asking
   * again, so it takes what asking takes — `deployment: ['create']`, the grant
   * and the switch — and never the cap. Answers the preview as a read does.
   */
  async extend(
    ctx: PermissionCtx,
    previewDeploymentId: string,
    input: { ttlMinutes?: number },
    ip?: string,
  ): Promise<PreviewDeploymentRead> {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const owned = await this.findOwnedPreview(ctx, previewDeploymentId);
    await this.permissions.checkServiceAccess(
      ctx,
      owned.preview.applicationId,
      'read',
    );
    refuseUnlessAllowed(owned);
    if (owned.preview.trigger !== 'requested') {
      throw new ConflictException(
        'A pull-request preview has no expiry to extend; it lives until its pull request closes',
      );
    }
    refuseIfExpired(owned.preview);
    const ttlMinutes = await this.admittedTtl(
      owned.sourceType,
      input.ttlMinutes,
    );

    // Guarded on the mark as well as read before it: the sweep may mark the
    // row between the read above and this write.
    const [extended] = await this.db
      .update(previewDeployment)
      .set({ expiresAt: expiryAfter(new Date(), ttlMinutes) })
      .where(
        and(
          eq(previewDeployment.previewDeploymentId, previewDeploymentId),
          isNull(previewDeployment.expiredAt),
        ),
      )
      .returning();
    if (!extended) throw previewExpired();

    await this.auditLogs.audit(
      {
        userId: ctx.user.id,
        organizationId: ctx.session.activeOrganizationId,
        ip,
      },
      {
        action: 'update',
        resourceType: 'previewDeployment',
        resourceId: extended.previewDeploymentId,
        resourceName: extended.appName,
        metadata: {
          type: 'extend',
          applicationId: extended.applicationId,
          branch: extended.branch,
          ttlMinutes,
          expiresAt: extended.expiresAt,
        },
      },
    );

    const [read] = await this.asReads(ctx.session.activeOrganizationId, owned, [
      extended,
    ]);
    return read;
  }

  /**
   * Tears the preview down on request, without waiting for the PR to close.
   *
   * **Deleting a Requested preview is expiring it now**: its
   * expiry is set to now and it is marked expired with cause `delete`, and
   * `PreviewExpiryService`'s next pass cancels its builds, tears it down on
   * the machines that made it and drops the row once the copy is gone. So this
   * answers at once, with no Server round trip, and the row it answers is the
   * expired one. A second call is harmless: the mark is written once, and the
   * row answers as it is until the sweep removes it, then 404. A pull-request
   * preview keeps its inline teardown, which answers before a release past
   * its cancel window ends and tears down after it (see `stopBuilds`).
   *
   * **Answers the preview as a read does**, link and latest build
   * included, so `delete_preview` answers what every other preview tool does:
   * the expired row, or a pull-request preview as it was before it went.
   */
  async remove(
    ctx: PermissionCtx,
    previewDeploymentId: string,
  ): Promise<PreviewDeploymentRead> {
    await this.permissions.checkPermission(ctx, { deployment: ['cancel'] });
    const owned = await this.findOwnedPreview(ctx, previewDeploymentId);
    await this.permissions.checkServiceAccess(
      ctx,
      owned.preview.applicationId,
      'read',
    );
    const organizationId = ctx.session.activeOrganizationId;
    if (owned.preview.trigger === 'requested') {
      const expired = await this.expireNow(owned.preview);
      const [read] = await this.asReads(organizationId, owned, [expired]);
      return read;
    }
    // Read before the teardown, whose row delete nulls its builds' link.
    const [read] = await this.asReads(organizationId, owned, [owned.preview]);
    await this.teardown(owned.preview, owned);
    return read;
  }

  /** A Requested preview marked expired by a `DELETE`, or as it already was. */
  private async expireNow(
    preview: PreviewDeployment,
  ): Promise<PreviewDeployment> {
    const now = new Date().toISOString();
    const [expired] = await this.db
      .update(previewDeployment)
      .set({ expiresAt: now, expiredAt: now, expiryCause: 'delete' })
      .where(
        and(
          eq(
            previewDeployment.previewDeploymentId,
            preview.previewDeploymentId,
          ),
          isNull(previewDeployment.expiredAt),
        ),
      )
      .returning();
    if (expired) return expired;
    // Already expired, by its clock or an earlier delete: nothing to change.
    const current = await this.db.query.previewDeployment.findFirst({
      where: eq(
        previewDeployment.previewDeploymentId,
        preview.previewDeploymentId,
      ),
    });
    if (!current) throw new NotFoundException('Preview deployment not found');
    return current;
  }

  /** An application's previews, newest first, access-scoped like the
   * deployment history: previews are visible to whoever can read the app. */
  async findAllByApplicationId(
    ctx: PermissionCtx,
    applicationId: string,
  ): Promise<PreviewDeploymentListed[]> {
    await this.permissions.checkServiceAccess(ctx, applicationId, 'read');
    const app = await this.findOwnedApplication(ctx, applicationId);
    const rows = await this.db.query.previewDeployment.findMany({
      where: eq(previewDeployment.applicationId, app.applicationId),
      orderBy: desc(previewDeployment.createdAt),
    });
    return this.withRequesters(
      ctx.session.activeOrganizationId,
      await this.asReads(ctx.session.activeOrganizationId, app, rows),
    );
  }

  /**
   * Builds the PR branch under the preview's own appName through the regular
   * deployment engine, routes its host, then reports the outcome on the pull
   * request. Internal — the queue processor calls this, so no PermissionCtx.
   *
   * **Three outcomes, and "ready" is only the last**. The comment used
   * to be posted as soon as the build converged, at a host nothing had ever
   * routed, so the one link a reviewer was given answered 404. The router is
   * now written between the two, and the announcement waits for it: a build
   * that fails says *failed*, a build that converged but could not be routed
   * says *could not be routed* — naming the host, so the contributor is not
   * sent to try it — and only a routed preview says *ready*.
   *
   * **Unroutable is `error`, not `done`.** The Swarm service is healthy, but
   * `previewStatus` is what the Previews screen shows beside the host, and
   * `done` there would repeat the claim the comment has just been kept from
   * making. It throws on for the same reason a failed build does: the queue
   * job is what an operator's log attributes the failure to.
   *
   * **A "ready" comment GitHub refuses no longer turns a routed preview into a
   * failed one.** It was inside the same `try` as the build, so a comment
   * hiccup marked the preview `error` and tried to post "failed" about a build
   * that had succeeded; it now runs after the status is settled and throws to
   * the caller as itself.
   */
  async deployPreview(
    previewDeploymentId: string,
    meta: DeployMeta = {},
  ): Promise<void> {
    const preview = await this.db.query.previewDeployment.findFirst({
      where: eq(previewDeployment.previewDeploymentId, previewDeploymentId),
    });
    if (!preview) throw new NotFoundException('Preview deployment not found');

    const app = await this.applications.findDeployable(preview.applicationId);
    // The preview builds the PR branch beside production. Previews never
    // capture rollback snapshots nor push to registries.
    // The branch column the parent's own provider clones from, which is
    // `branch` only for GitHub — see `git-providers/source-branch.ts`.
    const previewApp: DeployableApplication = {
      ...onBranch(app, preview.branch),
      appName: preview.appName,
      rollbackActive: false,
      registry: null,
      buildRegistry: null,
      // previewEnv/previewBuildArgs are what point a preview at a staging
      // database; unset, the build keeps inheriting production's.
      env: app.previewEnv ?? app.env,
      // Its parent's wired variables, filled in at this deploy as the
      // parent's are, less any previewEnv overrides (ADR-0021).
      configLinks: previewLinks(app.configLinks, app.previewEnv),
      buildArgs: app.previewBuildArgs ?? app.buildArgs,
      // And the parent's mount rows keep pointing at the parent's storage,
      // which for a `file` mount takes a conversion rather than an omission
      // (ADR-0021). See {@link inheritedMounts}.
      mounts: inheritedMounts(app),
    };

    const statusBefore = preview.previewStatus;
    await this.setStatus(previewDeploymentId, 'running');
    try {
      // `meta.deploymentId` is the parent's pending row the job names,
      // which the engine claims instead of recording its own.
      const built = await this.engine.deploy(previewApp, meta, {
        announce: announcesBuilds(preview.trigger),
        // The preview's status is this method's to write; the parent's is
        // production's, whichever trigger made the preview.
        setsApplicationStatus: false,
        // It reads the parent's traces setting off the parent's row, and a
        // preview never gets a Trace store's wiring (ADR-0028).
        preview: true,
      });
      // That row was settled before the build could claim it: nothing ran,
      // so nothing is routed or announced, and the preview reads as before.
      if (!built) {
        await this.setStatus(previewDeploymentId, statusBefore);
        return;
      }
    } catch (error) {
      await this.reportFailure(
        previewDeploymentId,
        app,
        preview,
        '❌ Preview deployment failed — check the deployment logs.',
      );
      throw error;
    }

    try {
      await this.traefik.routePreview({
        appName: preview.appName,
        host: preview.domain,
        port: app.previewPort,
        // The run Server, where the Swarm service just converged and whose
        // Traefik is the one that has to know about it.
        parent: { applicationId: app.applicationId, serverId: app.serverId },
        // Read off the parent row this build loaded, so a switch moved while
        // the build ran is what the router gets.
        dnsChallengeWildcard: dnsChallengeWildcardOf(app),
      });
    } catch (error) {
      this.logger.warn(
        `Preview ${preview.appName} of ${buildDescription(preview)} built and is running, but its host ${preview.domain} could not be routed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.reportFailure(
        previewDeploymentId,
        app,
        preview,
        // The host is not echoed: the one kind of value this refuses outright
        // is a stored host that is not a hostname, and the log has it.
        "⚠️ Preview deployment built, but its host could not be routed, so it does not answer yet. The reason is in Cloudgate's log, and the next push to this pull request tries again.",
      );
      throw error;
    }

    await this.setStatus(previewDeploymentId, 'done');
    // A Requested preview has no pull request to tell; its caller reads the
    // outcome from the preview and the log.
    if (preview.pullRequestNumber === null) return;
    // The console's rule, not a scheme of the comment's own: the two
    // used to disagree, `http://` here and `https://` on the Previews screen.
    const [{ url }] = await this.asReads(
      app.environment.project.organizationId,
      app,
      [preview],
    );
    await this.postPrComment(
      app,
      preview.pullRequestNumber,
      `✅ Preview deployment ready: ${url}`,
    );
  }

  /**
   * A preview that did not become reachable: marked `error`, and told on the
   * pull request in `message` — when it has one; a Requested preview's caller
   * reads the status and the log. The comment is best effort — the
   * error the caller rethrows is what it needs to see, not a comment hiccup.
   */
  private async reportFailure(
    previewDeploymentId: string,
    target: PrCommentTarget,
    preview: Pick<PreviewDeployment, 'pullRequestNumber'>,
    message: string,
  ): Promise<void> {
    await this.setStatus(previewDeploymentId, 'error');
    if (preview.pullRequestNumber === null) return;
    try {
      await this.postPrComment(target, preview.pullRequestNumber, message);
    } catch {
      // The build or routing error is what the caller needs to see.
    }
  }

  /**
   * A pull request refused by the limit, told so where it can see it and
   * written to the log where an operator can find it.
   *
   * **Both, because the two readers are two.** The contributor has no console
   * and learns nothing from a log line; the operator watching a busy repository
   * learns nothing from a comment on somebody's pull request, and this is the
   * only trace a refusal leaves — no preview row is written, so there is
   * nothing for the Previews screen to list afterwards. `warn` rather than
   * `log` is the level the reporter searched for and found empty: a refusal is
   * a request the product declined, not a routine step.
   *
   * **The comment is `try`/`catch`ed and the refusal is not.** This runs inside
   * the loop over every previewing Application of one delivery, so an
   * unreachable GitHub would otherwise cost the *webhook* — the remaining
   * Applications' previews included — to report something that has already
   * happened. That is `deployPreview`'s own rule for the failure comment, where
   * the build error is what the caller needs rather than a comment hiccup.
   *
   * The connection rather than `app.github`: {@link findPreviewTargets} selects
   * from `application` alone, so the row carries a `githubId` and not the
   * credentials — and the delivery has already been verified against this
   * connection, which is the one {@link handlePullRequestEvent} read to check
   * the author's write access.
   */
  private async reportRefusal(
    app: Application,
    connection: Github,
    event: GithubPullRequestEvent,
    refusal: PullRequestPreviewRefusal,
  ): Promise<void> {
    const refused = `No preview was built for ${app.owner}/${app.repository} pull request #${event.pullRequestNumber}`;
    const told =
      'Nothing was deployed and no preview row was written; the pull request has been told so.';
    const why: Record<PullRequestPreviewRefusal, () => string> = {
      atLimit: () =>
        `the Application "${app.appName}" is at its limit of ${previewCount(app.previewLimit)} at once. ${told} Tearing a preview down or closing the pull request holding it frees a slot, and "Most previews at once" on the Application's Previews screen is what sets the limit.`,
      noAddress: () =>
        `the Application "${app.appName}" sets no preview wildcard, so its preview host would carry an IP in its name, and ${noPreviewAddress(app.serverId)}. ${told}`,
      inCloud: () =>
        `the Application "${app.appName}" runs in a Cloud account, which has no Preview deployments. ${told} Turning its pull-request previews off stops these refusals.`,
    };
    const comment: Record<PullRequestPreviewRefusal, () => string> = {
      atLimit: () => previewLimitRefusal(app.previewLimit),
      noAddress: () => noPreviewAddressRefusal,
      inCloud: () =>
        `This pull request was refused a preview. ${CLOUD_PREVIEWS_REFUSAL}`,
    };
    this.logger.warn(`${refused}: ${why[refusal]()}`);
    try {
      await this.postPrComment(
        { github: connection, owner: app.owner, repository: app.repository },
        event.pullRequestNumber,
        `⚠️ ${comment[refusal]()}`,
      );
    } catch (error) {
      this.logger.warn(
        `The refusal above could not be posted on ${app.owner}/${app.repository} pull request #${event.pullRequestNumber}: ${error instanceof Error ? error.message : String(error)}. The refusal itself stands — nothing was built for it.`,
      );
    }
  }

  /**
   * An outcome, reported on the pull request it belongs to.
   *
   * **The pull request number is a parameter rather than a `PreviewDeployment`,
   * because the third outcome has no preview row**. A ready preview and
   * a failed build both have one and take theirs from it; a refusal is
   * precisely the case where none was created, and the number is on the event.
   * The target is likewise a {@link PrCommentTarget} rather than a
   * `DeployableApplication`, so the refusal can hand over the connection the
   * delivery was verified against beside a plain `application` row.
   */
  private async postPrComment(
    target: PrCommentTarget,
    pullRequestNumber: string,
    message: string,
  ): Promise<void> {
    if (!target.github || !target.owner || !target.repository) return;
    await this.githubService.postPrComment(target.github, {
      owner: target.owner,
      repo: target.repository,
      issueNumber: Number.parseInt(pullRequestNumber, 10),
      body: `### Cloudgate Preview Deployment\n\n${message}`,
    });
  }

  private async setStatus(
    previewDeploymentId: string,
    status: ApplicationStatus,
  ): Promise<void> {
    await this.db
      .update(previewDeployment)
      .set({ previewStatus: status })
      .where(eq(previewDeployment.previewDeploymentId, previewDeploymentId));
  }

  /** The full github connection row — the collaborator check needs the app
   * credentials the sanitized service surface strips. */
  private async findConnection(githubId: string): Promise<Github> {
    const [found] = await this.db
      .select()
      .from(github)
      .where(eq(github.githubId, githubId))
      .limit(1);
    if (!found) throw new NotFoundException('GitHub provider not found');
    return found;
  }

  /** The applications a PR event previews: same repo/owner/base branch on the
   * verified connection, with previews switched on. */
  private async findPreviewTargets(
    githubId: string,
    event: GithubPullRequestEvent,
  ): Promise<Application[]> {
    return this.db
      .select()
      .from(application)
      .where(
        and(
          eq(application.sourceType, 'github'),
          eq(application.githubId, githubId),
          eq(application.repository, event.repository),
          eq(application.owner, event.owner),
          eq(application.branch, event.baseBranch),
          eq(application.isPreviewDeploymentsActive, true),
          // Never on, but a kind with no previews is never a target.
          notInArray(application.configKind, [...KINDS_WITHOUT_PREVIEWS]),
        ),
      );
  }

  /** The PR's preview row for the application — reused on synchronize,
   * created with a fresh isolated appName and domain on first sight — or why
   * none was: no free slot left under its previewLimit, or no host the
   * preview could be reached at. */
  private async ensurePreview(
    app: Application,
    event: GithubPullRequestEvent,
  ): Promise<PreviewDeployment | PullRequestPreviewRefusal> {
    const existing = await this.db.query.previewDeployment.findFirst({
      where: and(
        eq(previewDeployment.applicationId, app.applicationId),
        eq(previewDeployment.pullRequestId, event.pullRequestId),
      ),
    });
    // A PR that already holds a slot rebuilds into it, cap or no cap.
    if (existing) return existing;

    // The application's previewLimit. Without it a busy repository opens one
    // whole environment — container, router and volume — per open pull
    // request; closing a PR frees the slot again through teardown. Pull
    // requests' previews only: a Requested preview counts against
    // `requestedPreviewLimit` instead, so an Agent's loop never refuses a
    // contributor's pull request its preview.
    const open = await this.db.$count(
      previewDeployment,
      and(
        eq(previewDeployment.applicationId, app.applicationId),
        eq(previewDeployment.trigger, 'pullRequest'),
      ),
    );
    if (open >= app.previewLimit) return 'atLimit';

    const hostRule = await previewHostRuleOf(this.db, app);
    if (!hostRule) return 'noAddress';

    const appName = generateAppName(`preview-${app.appName}`);
    const [created] = await this.db
      .insert(previewDeployment)
      .values({
        applicationId: app.applicationId,
        branch: event.headBranch,
        pullRequestId: event.pullRequestId,
        pullRequestNumber: event.pullRequestNumber,
        pullRequestTitle: event.pullRequestTitle,
        pullRequestURL: event.pullRequestURL,
        appName,
        domain: previewHost(appName, hostRule),
      })
      .returning();
    return created;
  }

  /** The preview row plus its application's two Servers, org-scoped like every
   * controller-facing path (preview → application → environment → project).
   *
   * `buildServerId` as well as `serverId`: the preview's Swarm
   * service is on the run Server and its source tree is on the build host, and
   * a teardown handed only the first ran its `rm -rf` on a machine that never
   * had the directory. `redeploy` still queues against `serverId` alone, which
   * is right — a job's Server is where the workload belongs. */
  private async findOwnedPreview(
    ctx: PermissionCtx,
    previewDeploymentId: string,
  ): Promise<{
    preview: PreviewDeployment;
    /** The parent's, which a refusal names. */
    name: string;
    serverId: string | null;
    buildServerId: string | null;
    /** The parent's Cloud account, when it runs in one. */
    cloudAccountId: string | null;
    previewWildcard: string | null;
    previewDnsChallenge: boolean;
    requestedPreviewsAllowed: boolean;
    sourceType: SourceType;
  }> {
    const [found] = await this.db
      .select({
        preview: previewDeployment,
        name: application.name,
        serverId: application.serverId,
        buildServerId: application.buildServerId,
        // A cloud parent's preview is never rebuilt, and its teardown runs
        // nothing on any machine.
        cloudAccountId: application.cloudAccountId,
        // What `findOne`'s printed link reads beside `serverId`.
        previewWildcard: application.previewWildcard,
        previewDnsChallenge: application.previewDnsChallenge,
        // What a Requested preview's extend and redeploy refuse on.
        requestedPreviewsAllowed: application.requestedPreviewsAllowed,
        sourceType: application.sourceType,
      })
      .from(previewDeployment)
      .innerJoin(
        application,
        eq(previewDeployment.applicationId, application.applicationId),
      )
      .innerJoin(
        environment,
        eq(application.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(previewDeployment.previewDeploymentId, previewDeploymentId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Preview deployment not found');
    return found;
  }

  /** Org scoping (environment → project) for controller-facing paths, the
   * same shape as ApplicationsService.findOwned. */
  private async findOwnedApplication(
    ctx: PermissionCtx,
    applicationId: string,
  ): Promise<RequestedParent> {
    const [found] = await this.db
      .select({
        applicationId: application.applicationId,
        name: application.name,
        // What the list's printed links read.
        serverId: application.serverId,
        // A Requested preview's create refuses a build Server in maintenance.
        buildServerId: application.buildServerId,
        // A Requested preview's create refuses a cloud parent.
        cloudAccountId: application.cloudAccountId,
        previewWildcard: application.previewWildcard,
        previewDnsChallenge: application.previewDnsChallenge,
        // What a Requested preview's create reads.
        appName: application.appName,
        configKind: application.configKind,
        sourceType: application.sourceType,
        requestedPreviewsAllowed: application.requestedPreviewsAllowed,
        // The cap step's limit.
        requestedPreviewLimit: application.requestedPreviewLimit,
      })
      .from(application)
      .innerJoin(
        environment,
        eq(application.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(application.applicationId, applicationId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Application not found');
    return found;
  }
}
