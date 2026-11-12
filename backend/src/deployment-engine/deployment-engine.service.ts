import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { quote } from 'shell-quote';
import { eq } from 'drizzle-orm';
import { hfTokenEnv } from '../ai-models/ai-model-facet';
import { clearWiredChanged, wiredEnv } from '../project-config/outputs';
import { INFERENCE_RUNTIMES } from '../ai-models/inference-runtime';
import { awaitModelReady } from '../ai-models/model-readiness';
import { recordServedModel } from '../ai-models/ai-model-facet';
import { pruneWeightsVolume } from '../ai-models/weights-volume';
import { writeGatewayRoute } from '../gateway/gateway-route';
import { ApplicationsService } from '../applications/applications.service';
import { ownerOnlyDirectoryCommand } from '../common/files/owner-only';
import { byCloud, cloudOrLegacy } from '../cloud-accounts/cloud-provider';
import {
  BUILD_IDENTITY_VERSION,
  MAKES_BUILD_IDENTITY,
  buildsInItsCloud,
  copiesInItsCloud,
  cloudBuildCheckedOutLine,
  cloudBuildHostsLine,
  cloudBuildNextLine,
  cloudBuildSetupRefusal,
  stageCloudBuildSourceCommand,
} from '../cloud-builds/cloud-build-place';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { cloudAccount } from '../db/schema';
import { deployment as deploymentTable } from '../deployments/deployment.schema';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import type { BuildProgram } from '../builders/build-strategy';
import { ComposeService } from '../compose/compose.service';
import type { DeployableCompose } from '../compose/compose.types';
import {
  getBuildComposeProgram,
  getComposeFilePath,
  writeDomainsToCompose,
} from '../compose/compose.utils';
import { encodeBase64 } from '../docker/docker.utils';
import { RemoteDockerFactory } from '../docker/remote-docker.factory';
import { DomainsService } from '../domains/domains.service';
import { getGitProviderStrategy } from '../git-providers/git-provider.strategy';
import type { SourceProgram } from '../git-providers/source-program';
import { SourceCloneService } from '../git-providers/source-clone.service';
import { PatchService } from '../patch/patch.service';
import { refuseCloudPreview } from '../preview-deployments/cloud-preview';
import type { Registry } from '../registries/registry.schema';
import {
  dockerLoginCommand,
  getRegistryTag,
} from '../registries/registry.utils';
import { ExecError } from '../remote/exec-error';
import { execOnServer } from '../remote/exec-dispatch';
import { RemoteExecService } from '../remote/remote-exec.service';
import { runTargetOn } from '../remote/run-target';
import type { RunTarget } from '../remote/run-target';
import {
  applicationTraceOwner,
  composeTraceOwner,
  ensureTraceWiring,
} from '../traces/trace-store';
import type { TraceStoreOwner, TraceWiring } from '../traces/trace-store';
import { composeTraceWiringOf } from '../traces/compose-trace-wiring';
import {
  applicationBuildProgram,
  buildAppDirectoryIn,
} from './application-build-program';
import {
  applicationsDirectoryOn,
  cloudBuildDirectory,
  composeDirectoryOn,
  staticUploadDirectory,
} from './deployment-engine.paths';
import {
  awaitConvergence,
  convergenceFailed,
  convergenceLogLine,
  convergencePlan,
} from './await-convergence';
import type {
  DeployableAiModel,
  DeployableApplication,
} from './deployment-engine.types';
import { buildHostServerId } from './build-host';
import {
  assertCloudBuild,
  CLOUD_BUILT_LINE,
  CLOUD_PUSH_LINE,
  STATIC_SERVED,
  cloudHostsLogLine,
  cloudStaticStagedLine,
  cloudStaticUploadLine,
  cloudOf,
  CLOUD_RUN_PLATFORM,
  x86HostOnlyCommand,
  runsAsCloudStatic,
  runsInCloud,
  stageStaticFilesCommand,
} from './cloud-build';
import { deployHostsLogLine, stackVmHostsLogLine } from './deploy-hosts';
import { publishStackVmPorts } from '../compose/stack-vm-ports';
import { FAILURE_TAIL_LINES, summarizeBuildOutput } from './failure-reason';
import { assertGpusFree } from './gpu-deploy-check';
import { mechanizeDockerContainer, releasedImageName } from './mechanize';
import { DEPLOYMENT_NOTIFIER } from './ports/deployment-notifier';
import type {
  DeploymentNotification,
  DeploymentNotifier,
} from './ports/deployment-notifier';
import { DEPLOYMENT_RECORDER } from './ports/deployment-recorder';
import type {
  DeploymentRecord,
  DeploymentRecorder,
} from './ports/deployment-recorder';
import { ROLLBACK_RECORDER } from './ports/rollback-recorder';
import type { RollbackRecorder } from './ports/rollback-recorder';

/** Metadata for the deployment record: its title and description, and the
 * `pending` row the queued job names, which the build claims instead
 * of recording a fresh one. */
export interface DeployMeta {
  title?: string;
  description?: string;
  deploymentId?: string;
}

/**
 * Where a build's outcome is reported, beside its own Deployment row, which
 * always is. The caller's decision, not the build's: not part of
 * {@link DeployMeta}, because that is what a queued job carries and a caller's
 * DTO fills.
 */
export interface DeployOutcome {
  /**
   * Whether the outcome goes to the Organization's notification channels.
   * Every caller but one takes the default, `true`. The one that passes
   * `false` is a Requested preview's build, and the decision is
   * `preview-deployments/requested-preview.ts`' `announcesBuilds` — a rule
   * about the preview's trigger, stated there so the missing notification is
   * not read as a bug here.
   */
  announce?: boolean;
  /**
   * Whether `done` or `error` is written onto the Application's own
   * `applicationStatus`. `false` for every preview build, of either trigger:
   * the build runs on the parent's row, so writing it there made
   * production read `error` after an Agent's preview failed, and would have
   * written `done` over a real production error. The preview's own status is
   * `PreviewDeploymentsService.deployPreview`'s to write.
   */
  setsApplicationStatus?: boolean;
  /**
   * Whether this build is a preview's. A preview never gets its parent's
   * Trace store wiring (ADR-0028): nothing else on the call can say so,
   * because a preview's build runs on its parent's row and so reads
   * its parent's traces setting. Every preview build passes `true` — the one
   * caller is `PreviewDeploymentsService.deployPreview` — and nothing else
   * does.
   */
  preview?: boolean;
}

/**
 * The Push phase's steps, plus the registry passwords they log in with.
 *
 * `BuildProgram` and `SourceProgram`'s pair, spelled a third time because this
 * one is a *list* of steps rather than one program: `uploadImageCommands`
 * returns the `||`-chained lines the composed deploy joins, and there are none
 * of them when no Registry is linked. The environment is what the fourth of the
 * tree's four never-carry sites needed and is the reason this interface exists
 * at all — before it, the method could only return strings, so the only place a
 * password could go was into one.
 */
interface CarriedPush {
  readonly commands: string[];
  readonly env: Record<string, string>;
}

/**
 * Whether a Deployment of this Application pushes its image to a Registry:
 * either column counts, because `uploadImageCommands` pushes through either
 * or both. One predicate for the three places that ask — the Push phase, the
 * dedicated-build-Server guard, and the ❌ line's "pushed" — so they cannot
 * disagree about whether a push ran.
 *
 * **Never for a docker source, whatever is linked**. It builds nothing:
 * its image is the operator's `dockerImage`, which `releasedImageName` releases
 * verbatim and `mechanize.ts`' `resolveAuthConfig` pulls with the
 * Application's *own* `registryUrl`/`username`/`password` — neither reads the
 * linked Registry. A push there was a login, a `docker tag` and a
 * `docker push` of `getRegistryTag`'s word on every Deployment, into somebody's
 * registry storage, and no service ever ran that tag. The columns can still
 * hold a Registry — `sourceType` and `registryId` are independently
 * `PATCH`-able, and a source switched back to a build uses it again — so the
 * answer is decided here rather than by clearing them.
 */
/**
 * The registry digest reference of `image` among `docker image inspect`'s
 * `RepoDigests` (JSON), matched by repository; `null` when none matches.
 * Docker lists a Docker Hub image without its `docker.io/` and `library/`.
 */
export function digestOf(image: string, repoDigests: string): string | null {
  const repository = (name: string) =>
    name.replace(/^docker\.io\//, '').replace(/^library\//, '');
  const lastSlash = image.lastIndexOf('/');
  const tagAt = image.indexOf(':', lastSlash + 1);
  const atAt = image.indexOf('@', lastSlash + 1);
  const end = [tagAt, atAt].filter((at) => at > 0);
  const name = image.slice(0, end.length ? Math.min(...end) : undefined);
  let digests: unknown;
  try {
    digests = JSON.parse(repoDigests.trim() || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(digests)) return null;
  const match = digests.find(
    (entry): entry is string =>
      typeof entry === 'string' &&
      repository(entry.split('@')[0]) === repository(name),
  );
  return match ? `${name}@${match.split('@')[1]}` : null;
}

const pushesToRegistry = (application: DeployableApplication): boolean =>
  application.sourceType !== 'docker' &&
  Boolean(application.registry || application.buildRegistry);

/**
 * Clones the source, builds the image, and releases it as a Swarm service —
 * every shell step piped into the deployment's log file and executed locally or
 * over ssh depending on which server builds.
 *
 * The Update phase is the one step no redirection can carry: it talks to the
 * Docker API in this process, so it writes its own lines through `appendToLog`
 * Without them
 * the log ended on the builder's last output and the phase that actually put
 * the new image in front of traffic left no trace at all.
 *
 * **What `finishedAt` and `error` mean now.** The Update
 * phase now waits for the Service's tasks (`awaitConvergence`) before the status
 * call, so the stamp `DeploymentsService.updateStatus` writes moved from *"the
 * spec was accepted"* to *"convergence was decided"*. Neither `updateStatus` nor
 * the schema changed — the poll simply runs in front of the existing stamp — and
 * the consequences are:
 *
 * - Every duration derived from `finishedAt - startedAt` is longer by the
 *   convergence time. That is the number becoming honest, not a regression: it
 *   previously measured the build plus one API round trip.
 * - The cancellation path is untouched, and nothing races the new stamp: a
 *   *queued* Deployment is dequeued before the Update phase ever runs, and one
 *   the queue has already handed to a worker is refused with a 409
 *   (`DeploymentsService.cancel`) — so no `cancelled` row can be overwritten by
 *   a poll finishing minutes later. The longer poll widens the window in which
 *   that refusal is what a cancel gets, which is the existing behaviour saying
 *   the same thing about a longer phase.
 * - `error` gained no new cause that is not an *observation*. A rollback Swarm
 *   admits to, and a spent budget in which every task carries an `Err`, are
 *   `error`; a bare spent budget is `done` with a ⚠️ line, because a failure is
 *   never invented from a clock. There is no new `deploymentStatusEnum` value.
 *
 * **Every word this file interpolates into a shell program is `quote()`d, and
 * that quoting is the defence** (`builders/build-strategy.ts` states the rule
 * for the tree; H-34 is why this paragraph names it here). Two different
 * values reach these commands and they were both bare:
 *
 * - `deployment.logPath`, in the `>> …` of six commands. It is machine-made —
 *   `logsDirectoryOn()` plus an `APP_NAME_REGEX` `appName` plus a `nanoid()`
 *   (`deployments.service.ts`'s `initializeLog`) — so it was a charset at a
 *   distance and nothing worse, which is exactly what H-19's three sinks were.
 * - `dockerImage`, through {@link builtImageName}, in the `docker tag` /
 *   `docker push` words and the two `echo`s beside them. That one had **no**
 *   constraint anywhere: `updateApplicationSchema` types it
 *   `z.string().nullable()`, so a `PATCH /applications/:id` setting
 *   `sourceType: 'docker'` and a `dockerImage` carrying `;` put a second
 *   command into the string the next deploy hands `execAsyncRemote`, running as
 *   the account that drives Docker. `git-providers/strategies/docker.strategy.ts`
 *   had already `shEscape`d the same column for the same reason and
 *   says so in its own comment; the words here were the copies that were
 *   missed. **This was live, not hardening.** A docker source
 *   pushes nothing, so the column reaches only the `echo`s and the rollback
 *   `docker tag`; the push words keep their quoting regardless.
 *
 * `quote()` and not H-12's `"…"`: nothing refuses `$` or a backtick in front of
 * these sinks, so double quotes would leave a substitution alive — the shape
 * `getCreateFileCommand` was reopened for. The charsets that do exist stay
 * behind the quoting rather than in place of it.
 */
@Injectable()
export class DeploymentEngineService {
  constructor(
    private readonly remoteExec: RemoteExecService,
    private readonly dockerFactory: RemoteDockerFactory,
    private readonly applications: ApplicationsService,
    private readonly composeService: ComposeService,
    private readonly domainsService: DomainsService,
    private readonly sourceClone: SourceCloneService,
    private readonly patches: PatchService,
    @Inject(DEPLOYMENT_RECORDER)
    private readonly recorder: DeploymentRecorder,
    @Inject(DEPLOYMENT_NOTIFIER)
    private readonly notifier: DeploymentNotifier,
    @Inject(ROLLBACK_RECORDER)
    private readonly rollbacks: RollbackRecorder,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly instanceMode: InstanceMode,
  ) {}

  /** A cloud Service's Cloud account: its name and permissions version. */
  private async cloudAccountOf(
    cloudAccountId: string,
  ): Promise<{ name: string; policyVersion: number } | null> {
    const [found] = await this.db
      .select({
        name: cloudAccount.name,
        policyVersion: cloudAccount.policyVersion,
      })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
    return found ?? null;
  }

  /**
   * Prunes an AI model's weights volume back to the model it now serves
   * once its pull has succeeded. A failure is logged and the Deployment
   * stands: the model is served, and what was not pruned goes at the next
   * successful deploy.
   */
  private async pruneWeights(
    serverId: string | null,
    appName: string,
    facet: DeployableAiModel,
    log: (line: string) => Promise<unknown>,
  ): Promise<void> {
    try {
      const pruned = await pruneWeightsVolume(
        this.remoteExec,
        serverId,
        appName,
        facet,
      );
      if (pruned.length > 0) {
        await log(
          `🧹 [Model] Pruned ${pruned.map((m) => `'${m}'`).join(', ')} from the weights volume`,
        );
      }
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      await log(
        `⚠️ [Model] Pruning the weights volume failed, so models other than '${facet.model}' may remain: ${said}`,
      );
    }
  }

  /**
   * Builds and releases `application`. Answers whether it built at all:
   * `false` when the row its job named was settled before the build started
   * so nothing ran. `PreviewDeploymentsService.deployPreview` reads it
   * so that a build that never ran is not announced as ready; a
   * failure throws.
   */
  async deploy(
    application: DeployableApplication,
    meta: DeployMeta = {},
    {
      announce = true,
      setsApplicationStatus = true,
      preview = false,
    }: DeployOutcome = {},
  ): Promise<boolean> {
    const deployment = await this.recorder.create({
      kind: 'application',
      applicationId: application.applicationId,
      title: meta.title ?? 'Manual deployment',
      description: meta.description ?? '',
      deploymentId: meta.deploymentId,
    });
    // The row this job named was settled before the build started.
    if (!deployment) return false;
    // Building may happen on a dedicated build server; the service always
    // runs on the application's own server. The `||` used to be written out
    // here and nowhere else, which is how two Delete paths came to run their
    // `rm -rf` on the run Server — see {@link buildHostServerId}.
    const buildServerId = buildHostServerId(application);
    // The host line, until the program that `echo`es it first has been handed to
    // `exec`. A deploy refused before then — a build Server with no
    // Registry, or a clone that cannot be composed — writes it through
    // `appendErrorToLog` instead, ahead of the reason, so the log opens with
    // where it builds on every path; the build Server is the one where that matters most.
    let hostsNotYetLogged: string | undefined;

    try {
      // A preview of an Application in a Cloud account has no place to run
      // but the platform host, which its parent's `null` names: failed before
      // anything is read, cloned or built (`cloud-preview.ts`). Its creates
      // are refused up front; this is for a build queued before that.
      if (preview) refuseCloudPreview(application);
      // The first line of the log names the build host and the run
      // Server — the log is the only record of where *this* Deployment built,
      // since the Application's setting can change after it. Read before any
      // refusal, so every refusal can carry it.
      // A cloud Service builds here and runs in its Cloud account.
      const cloud = runsInCloud(application);
      const cloudStatic = runsAsCloudStatic(application);
      // Cloud Run runs x86 images only, and Cloudgate never
      // emulates another CPU: a ready-made image is pulled as amd64 on any
      // host, and a git build on a host that is not x86 stops first.
      const runsOn =
        cloud && !cloudStatic
          ? await cloudOf(this.db, application.cloudAccountId ?? '')
          : null;
      // ADR-0047: on the Hosted instance the image is built in the
      // cloud's own build service, in this Deployment's Cloud run; this
      // build slot only checks the source out and copies it aside.
      const inItsCloud =
        runsOn !== null &&
        buildsInItsCloud(this.instanceMode.isHosted, application);
      // A ready-made image is copied there too, by a short build of
      // its own, so nothing is pulled here and its credential stays here.
      const copies =
        inItsCloud && copiesInItsCloud(this.instanceMode.isHosted, application);
      const account = inItsCloud
        ? await this.cloudAccountOf(application.cloudAccountId ?? '')
        : null;
      const hosts =
        inItsCloud && runsOn !== null
          ? cloudBuildHostsLine({
              cloud: runsOn,
              accountName: account?.name ?? application.cloudAccountId ?? '',
              region: application.region,
              copies,
            })
          : cloud
            ? await cloudHostsLogLine(this.db, application)
            : await deployHostsLogLine(
                this.db,
                buildServerId,
                application.serverId,
              );
      hostsNotYetLogged = hosts;

      if (cloud) assertCloudBuild(application);
      else this.assertBuiltImageReachesRunServer(application, buildServerId);
      if (inItsCloud && runsOn !== null) {
        // A Cloud account set up before the build identity existed has
        // nothing to build as: refused before anything is checked out.
        const refused = cloudBuildSetupRefusal({
          accountName: account?.name ?? application.cloudAccountId ?? '',
          policyVersion: account?.policyVersion ?? null,
          needs: byCloud(runsOn, BUILD_IDENTITY_VERSION),
          madeBy: byCloud(runsOn, MAKES_BUILD_IDENTITY),
        });
        if (refused) throw new Error(refused);
      }
      // Where a static site is served, which its lines name.
      const servedOn = cloudStatic
        ? cloudOrLegacy(
            await cloudOf(this.db, application.cloudAccountId ?? ''),
          )
        : null;
      // The one platform its cloud runs images on (ADR-0043): ECS takes the
      // image as it is built, Cloud Run takes amd64 only.
      const platform =
        runsOn === null
          ? null
          : byCloud(runsOn, { aws: null, gcp: CLOUD_RUN_PLATFORM });
      const clone: SourceProgram = copies
        ? { command: '', env: {} }
        : await this.cloneProgram(
            application,
            platform === null ? {} : { platform },
          );
      // The Service directory is closed before anything is written into it
      // the `.env` a build writes lands in the build context, where it
      // keeps a mode the image's own user can read, so the directory above the
      // context is what keeps it from every local account — see
      // `common/files/owner-only.ts`. Every deploy, so an older install's
      // directory is corrected by its next one.
      const steps = [
        'set -e;',
        `echo ${quote([hosts])} ;`,
        ...(platform !== null && application.sourceType !== 'docker'
          ? [x86HostOnlyCommand()]
          : []),
        `${ownerOnlyDirectoryCommand(path.dirname(this.codeDirectory(application)))};`,
        clone.command,
      ];
      // Every secret the composed program *references* rather than carries.
      // Three producers contribute to one map — a private
      // image's pull password, the build's operator-authored environment, and
      // the registry passwords the push logs in with — and the three use
      // disjoint holder prefixes (`CG_SOURCE_REGISTRY_PASSWORD`,
      // `CG_BUILD_ENV_*`, `CG_REGISTRY_PASSWORD_*`) so that no two of them
      // composed into one program can have one silently overwrite another.
      // A docker source contributes only the first: it neither
      // builds nor pushes.
      const env: Record<string, string> = { ...clone.env };
      // A docker-sourced application ships a prebuilt image — nothing to build.
      if (application.sourceType !== 'docker') {
        // The stored patches are applied on top of the fresh clone before the
        // build sees the tree.
        steps.push(
          await this.patches.generateApplyPatchesCommand({
            id: application.applicationId,
            type: 'application',
            // The build host, which is the machine this whole program is
            // dispatched to below and the machine `codeDirectory` cloned onto.
            // `PatchService` cannot derive it — `findParentService`
            // projects the run Server only — and naming the runner here wrote
            // the patch beside a tree that is not there.
            serverId: buildServerId,
          }),
        );
        if (inItsCloud && runsOn !== null) {
          // The build is the Cloud run's, in the cloud's build
          // service; the checkout is copied aside for it to zip.
          steps.push(
            stageCloudBuildSourceCommand({
              from: this.codeDirectory(application),
              to: cloudBuildDirectory(
                application.appName,
                deployment.deploymentId,
              ),
              cloud: runsOn,
            }),
          );
        } else if (cloudStatic) {
          // Nothing is built for S3 + CloudFront; `publish` is copied
          // aside for this Deployment's Cloud run to upload.
          steps.push(
            stageStaticFilesCommand({
              checkout: this.codeDirectory(application),
              from: path.join(
                this.buildAppDirectory(application),
                application.publishDirectory || '.',
              ),
              to: staticUploadDirectory(
                application.appName,
                deployment.deploymentId,
              ),
              publish: application.publishDirectory || '.',
              place: byCloud(cloudOrLegacy(servedOn), STATIC_SERVED).place,
            }),
          );
        } else {
          const program = this.buildProgram(application);
          steps.push(program.command);
          Object.assign(env, program.env);
        }
      }
      const push: CarriedPush = cloud
        ? {
            commands: [
              `echo ${quote([
                inItsCloud && runsOn !== null
                  ? cloudBuildNextLine(runsOn, copies)
                  : servedOn
                    ? cloudStaticUploadLine(servedOn)
                    : CLOUD_PUSH_LINE,
              ])} ;`,
            ],
            env: {},
          }
        : this.uploadImageCommands(application);
      steps.push(...push.commands);
      Object.assign(env, push.env);
      const command = steps.join('\n');
      // `< /dev/null` is the one thing the build environment costs this line, and
      // it is measured rather than defensive. With an environment the program
      // no longer *is* the SSH `exec` request — `RemoteExecService` sends it as
      // a script on the channel — so the shell reading it has the channel as
      // its own stdin, and any command inside that reads stdin would consume
      // the rest of the script. Under bash it really does: a script of
      // `echo one / cat / echo two` fed to `bash -s` runs `echo one`, hands
      // `echo two` to `cat`, and exits 0 having silently skipped the rest;
      // dash reads byte-at-a-time and does not. Nothing in a clone, a patch, a
      // build or a push reads stdin today, so this closes a latent failure
      // rather than an observed one — but the failure it closes is a build that
      // *truncates and succeeds*, which is the worst shape a deploy can take.
      // The redirect binds the subshell only, so the outer shell goes on
      // reading the script.
      const commandWithLog = `(${command}) >> ${quote([deployment.logPath])} 2>&1 < /dev/null`;

      // From here the program's own first `echo` carries the line.
      hostsNotYetLogged = undefined;
      await this.exec(buildServerId, commandWithLog, env, deployment.cancelled);
      this.endCancellableSteps(deployment);

      // The rest of a cloud Service's Deployment is its Cloud run,
      // which the queue hands the row to once this build slot is free. No
      // image snapshot: a `static` site's rollback point is its folder,
      // taken by its Cloud run once switched to; a `web` on ECS has
      // no rollback.
      if (cloud) {
        await this.appendToLog(
          buildServerId,
          deployment.logPath,
          inItsCloud && runsOn !== null
            ? cloudBuildCheckedOutLine(runsOn, copies)
            : servedOn
              ? cloudStaticStagedLine(servedOn)
              : CLOUD_BUILT_LINE,
        );
        return true;
      }

      // A Cron service's build is the image each of its runs starts a
      // fresh container from (ADR-0034), so a Build deployment of one ends
      // here: no Swarm service is released, and none is converged on.
      if (application.configKind === 'cron') {
        const pinned = await this.pinCronImage(
          application,
          deployment,
          buildServerId,
        );
        await this.appendToLog(
          buildServerId,
          deployment.logPath,
          `✅ [Build] '${pinned}' is built; a Cron service starts a fresh container from it for each run, so nothing is released now`,
        );
        await this.settleDone(application, deployment.deploymentId, {
          announce,
          setsApplicationStatus,
        });
        return true;
      }

      if (application.rollbackActive) {
        await this.captureRollback(application, deployment, buildServerId);
      }

      const docker = await this.dockerFactory.getRemoteDocker(
        application.serverId,
      );
      // A GPU reservation the run Server cannot meet now fails here,
      // before the release, so the previous version keeps running.
      await assertGpusFree(this.remoteExec, docker, this.db, application);

      // The Update phase talks to the Docker API in this process, so
      // nothing it does rides the `>> logPath` redirection the shell steps
      // ride, and every deployment log used to end on the builder's last line
      // — leaving a `running` badge above a success message with nothing to
      // separate "still converging" from "finished ten minutes ago". These two
      // appends are on `buildServerId`, not `application.serverId`: the log
      // file lives on the server that built (deployment-engine.paths.ts), which
      // is the server `appendErrorToLog` is already handed below.
      await this.appendToLog(
        buildServerId,
        deployment.logPath,
        // `releasedImageName` and not {@link builtImageName}: this line names
        // the image the converge below is about to put in front of traffic,
        // which with a Registry linked is the registry-qualified tag and not
        // the local one the build left behind. The two are the same
        // word on the default single-box install, which is why they read alike
        // for as long as they did.
        `🚀 [Update] Releasing '${releasedImageName(application)}' as Swarm service '${application.appName}'`,
      );
      // A traced Application's Trace store is running before the
      // Service starts, and the Service is told where to send. Never for a
      // preview (ADR-0028).
      const traces = preview
        ? null
        : await this.startTraceStore(
            applicationTraceOwner(application),
            buildServerId,
            deployment.logPath,
          );
      // A "deploy to pick up the new value" notice marked before the
      // variables below are built is answered by this deploy.
      const wiredBuiltAt = new Date().toISOString();
      const released = await mechanizeDockerContainer(application, docker, {
        // A mode change removes the service before creating it again,
        // and the log says so before the removal rather than after it.
        log: (line) =>
          this.appendToLog(buildServerId, deployment.logPath, line),
        // An AI model's Hugging Face token, read here and never
        // carried on `application`, whose rollback context is stored.
        injectedEnv: {
          ...traces?.env,
          ...(application.aiModel &&
            (await hfTokenEnv(this.db, application.applicationId))),
        },
        // Its wired variables, built now from their sources and never
        // carried on `application`, whose rollback context is stored.
        wiredEnv: await wiredEnv(
          this.db,
          application.environmentId,
          application.configLinks,
        ),
      });
      // `mechanizeDockerContainer` resolving says the spec was accepted,
      // not that the tasks are up, so the log used to end on a ✅ that reported
      // an *acceptance* and left the operator with no way to tell a converged
      // Deployment from one whose tasks never started. The poll runs here,
      // between the release and the status call, which is what moves
      // `finishedAt` from "the spec was accepted" to "convergence was decided"
      // with no change to `updateStatus` or to the schema — see `awaitConvergence`.
      //
      // `released` is passed in because the poll's answer is now gated on
      // Swarm having *decided* the update. With `Order: 'start-first'` the
      // previous generation is still running while Swarm makes up its mind, so
      // the poll used to see it, call the Deployment converged on iteration 0
      // and record `done` two seconds ahead of the rollback Swarm was already
      // running. A release Swarm is about to roll back no longer reports done.
      const outcome = await awaitConvergence(
        docker,
        application.appName,
        convergencePlan(application),
        released,
      );
      const line = convergenceLogLine(application.appName, released, outcome, {
        // The same two facts `uploadImageCommands` decides the Push phase by,
        // so the ❌ line never claims a build or a push that did not run.
        built: application.sourceType !== 'docker',
        pushed: pushesToRegistry(application),
      });
      // An observed failure — a rollback, or a whole generation of tasks
      // carrying an error — is thrown so it takes the same path every other
      // failed Deployment takes: the sentence into the log, `error` on the row,
      // and `buildError` to whoever is subscribed. A spent budget with neither
      // is not a failure and falls through to `done` carrying its ⚠️ line.
      if (convergenceFailed(outcome)) {
        throw new Error(line);
      }
      await this.appendToLog(buildServerId, deployment.logPath, line);
      // An AI model is ready when its runtime has its model, not when
      // its tasks are up, so the Deployment is not done until then.
      if (application.aiModel) {
        const words =
          INFERENCE_RUNTIMES[application.aiModel.runtime].readinessWords;
        await this.appendToLog(
          buildServerId,
          deployment.logPath,
          `🧠 [Model] ${words.doing} '${application.aiModel.model}' into '${application.appName}'`,
        );
        await awaitModelReady(
          this.remoteExec,
          application.serverId,
          application.appName,
          application.aiModel,
        );
        await this.appendToLog(
          buildServerId,
          deployment.logPath,
          `✅ [Model] '${application.aiModel.model}' is ${words.done}; the AI model is ready`,
        );
        // The model this version serves, which the gateway holds calls to
        // from now on: an edit of the model takes effect here, not on save.
        await recordServedModel(
          this.db,
          application.applicationId,
          application.aiModel.model,
        );
        await this.pruneWeights(
          application.serverId,
          application.appName,
          application.aiModel,
          (line) => this.appendToLog(buildServerId, deployment.logPath, line),
        );
        // The gateway's way in, written at each deploy so a deploy also puts
        // a lost one back.
        await writeGatewayRoute(this.db, this.remoteExec, application);
        await this.appendToLog(
          buildServerId,
          deployment.logPath,
          `🔀 [Gateway] '${application.appName}' is routed for the gateway`,
        );
      }

      await this.settleDone(application, deployment.deploymentId, {
        announce,
        setsApplicationStatus,
      });
      // A preview's build runs on its parent's row; its deploy is
      // not the parent's.
      if (!preview) {
        await clearWiredChanged(
          this.db,
          {
            serviceType: 'application',
            serviceId: application.applicationId,
          },
          wiredBuiltAt,
        );
      }
      return true;
    } catch (error) {
      this.recorder.closeCancelWindow(deployment.deploymentId);
      if (deployment.cancelled.aborted) {
        // The record is `cancelled` already and the service was never
        // touched — the window closes before the release — so the log is the
        // only thing left to write. No `buildError`: nothing failed.
        await this.logCancelled(
          buildServerId,
          deployment.logPath,
          hostsNotYetLogged,
        );
        throw error;
      }
      const reason = await this.failureReason(
        buildServerId,
        deployment.logPath,
        error,
      );
      await this.appendErrorToLog(
        buildServerId,
        deployment.logPath,
        error,
        hostsNotYetLogged,
      );
      if (setsApplicationStatus) {
        await this.applications.updateStatus(
          application.applicationId,
          'error',
          { keepCronPause: true },
        );
      }
      await this.recorder.updateStatus(deployment.deploymentId, 'error');
      if (announce) {
        await this.notifier.buildError({
          ...this.notification(application),
          errorMessage: reason,
        });
      }
      throw error;
    }
  }

  /**
   * A Build deployment that succeeded, settled: the row's status before the
   * Deployment's — the console re-reads the row once, when it sees
   * the Deployment settle, so the other order leaves a window where that one
   * read is still stale — then the announcement.
   */
  private async settleDone(
    application: DeployableApplication,
    deploymentId: string,
    {
      announce,
      setsApplicationStatus,
    }: { announce: boolean; setsApplicationStatus: boolean },
  ) {
    if (setsApplicationStatus) {
      await this.applications.updateStatus(application.applicationId, 'done', {
        keepCronPause: true,
      });
    }
    await this.recorder.updateStatus(deploymentId, 'done');
    if (announce) {
      await this.notifier.buildSuccess(this.notification(application));
    }
  }

  /**
   * Materializes the source, writes the domain-injected compose file plus .env,
   * and brings the project up with `docker compose up` / `docker stack deploy`
   * — every shell step piped into the deployment's log file.
   *
   * **A `raw` stack is converted before anything is written**
   * The clone
   * step is destructive — `rm -rf <dir>` then a base64 write — and domain
   * injection happens in this process, so cloning first and injecting inside
   * the build command would mean a deploy that fails on injection has already
   * replaced the file on the target while the containers keep running with the
   * previous deploy's labels. The directory the platform says it deploys from
   * then describes a stack nobody is running, and a hand-run `up` from it
   * silently un-routes the thing. Loading the domains and running
   * `writeDomainsToCompose` *first* moves every refusal it can make in front of
   * the first write: either the file on the target is the one the stack is
   * running with, or nothing was touched. That guarantee is what lets a refusal
   * leave `composeStatus` alone
   * — see the
   * `catch` below.
   *
   * A git source cannot be pre-converted — its content only exists once the
   * clone has run — so that path keeps the original order.
   */
  async deployCompose(
    compose: DeployableCompose,
    meta: DeployMeta = {},
  ): Promise<void> {
    const deployment = await this.recorder.create({
      kind: 'compose',
      composeId: compose.composeId,
      title: meta.title ?? 'Manual deployment',
      description: meta.description ?? '',
      deploymentId: meta.deploymentId,
    });
    // The row this job named was settled before the build started.
    if (!deployment) return;
    // Where the stack runs, and so where every program below goes: its Stack
    // VM through its cloud's tunnel, its Server over SSH, or the platform host
    // (`remote/run-target.ts`). None of the steps below picks a transport for
    // itself. A Stack VM's stack keeps its Deployment log on the platform
    // host, which is why every logged step goes through `execToLog`.
    const target = runTargetOn(compose, {
      remoteExec: this.remoteExec,
    });
    // Rooted on the machine this clone is dispatched to, not on this process.
    // A stack has one Server — `findCompose` hard-codes
    // `buildServerId: null` — so `compose.serverId` is both the run Server and
    // the build host, and it is the same id the `exec` below carries. This is
    // the compose tree's writer, so every reader and destroyer of it converted
    // in the same change: see `composeDirectoryOn`.
    const codeDirectory = path.join(
      composeDirectoryOn(target.remoteId),
      compose.appName,
      'code',
    );

    // `composeStatus = 'error'` means "this stack is in a state nobody
    // knows", and the re-ordering above made it possible to know better —
    // every refusal domain injection can make now happens in front of the first
    // write, so a refused deploy is provably a no-op on the target. Painting
    // that `error` put a red pill on the same screen as "2 of 2 running" and
    // sent operators looking for damage that did not happen. Same argument, in
    // the same words, as `compose.service.ts:330-336` for a 409 out of
    // `removeContainers`.
    let targetWritten = false;
    // The host line, as for an Application: logged by the clone program's first
    // `echo`, or — for a refusal in front of it — ahead of the reason.
    let hostsNotYetLogged: string | undefined;

    try {
      // A stack's one Server, or its Stack VM, both builds and runs it: a
      // compose `build:` runs there, inside `docker compose up --build`, and
      // never in a cloud's build service (ADR-0070, not ADR-0047).
      const hosts = compose.cloudAccountId
        ? await stackVmHostsLogLine(this.db, {
            cloudAccountId: compose.cloudAccountId,
            region: compose.region,
          })
        : await deployHostsLogLine(this.db, compose.serverId, compose.serverId);
      hostsNotYetLogged = hosts;

      const domains = await this.domainsService.findComposeDomains(
        compose.composeId,
      );
      // A Stack VM's Domains are rules on its cloud's load balancer, which
      // reaches each one's port on the Stack VM: published there by the
      // deploy at the same number, never routed by Traefik (#1371).
      const stackVmRoutes = compose.cloudAccountId
        ? await this.domainsService.findStackVmRoutes(compose.composeId)
        : [];

      // Throws here — before the clone's `rm -rf` — for a domain naming a
      // service the file does not declare, or a file that is not a compose
      // file at all. The target keeps the deploy it is running.
      const clone =
        compose.sourceType === 'raw'
          ? getGitProviderStrategy('raw').cloneProgram({
              outputPath: codeDirectory,
              content: writeDomainsToCompose(
                compose,
                compose.composeFile,
                domains,
              ),
              fileName: 'docker-compose.yml',
            })
          : await this.sourceClone.cloneProgram(compose, codeDirectory, {
              // Where the clone runs, which decides whether its host is
              // checked: a Stack VM's runs in its own cloud network.
              on: { serverId: target.remoteId, serviceId: compose.composeId },
            });
      // Before the await, not after it: a clone that dies inside its own
      // `rm -rf` has written the target, and that is the state `error` is for.
      targetWritten = true;
      // `clone.env` is empty for every source type a Compose stack can be put
      // into — `docker` is the only strategy that fills one, and
      // `updateComposeSchema`'s `sourceType` admits `git`, `github`, `gitlab`,
      // `bitbucket`, `gitea` and `raw` and not that (the *column* is the shared
      // `sourceTypeEnum`, so this is the DTO's constraint rather than the
      // schema's). So the transport here is unchanged in practice, and it is
      // written as the general case rather than as an assumption.
      //
      // The `< /dev/null` is **pre-emptive, and deliberately so**. It
      // costs nothing on a program with an empty environment — the transport
      // then sends the command as the SSH `exec` request and no shell is
      // reading a script at all — and it closes the hazard the comment above
      // used to merely record: the moment a Compose source type does carry a
      // clone credential, `RemoteExecService.buildEnvScript` puts the program
      // on `sh -s`'s stdin, and any step inside it that reads stdin consumes
      // the rest. Under bash that is a program which **truncates and exits 0**,
      // which is the worst shape a deploy can take and the exact reason
      // `deploy` carries the same redirect. Closing it now rather than
      // after the first such source type is the whole point: the failure is
      // silent, so nothing would report it. The redirect binds the subshell
      // only, so the outer shell goes on reading the script.
      // The stack's directory is closed first, for the Application deploy's
      // reason: `getBuildComposeCommand` writes the `.env` with every
      // generated secret into `code`, where a `build: .` can carry it into an
      // image, so the mode that protects it is the directory's.
      hostsNotYetLogged = undefined;
      await target.execToLog(
        `set -e;\necho ${quote([hosts])} ;\n${ownerOnlyDirectoryCommand(path.dirname(codeDirectory))};\n${clone.command}`,
        deployment.logPath,
        { env: clone.env, signal: deployment.cancelled },
      );

      // Patches are applied as their own logged step after the clone — never
      // for raw stacks (there is no repository to patch). An entity with no
      // patches skips the exec rather than paying for an empty `(set -e;)`
      // round trip.
      if (compose.sourceType !== 'raw') {
        const applyPatches = await this.patches.generateApplyPatchesCommand({
          id: compose.composeId,
          type: 'compose',
          // Only roots the stack's code directory, where the clone put it.
          serverId: target.remoteId,
        });
        if (applyPatches) {
          await target.execToLog(
            `set -e;\n${applyPatches}`,
            deployment.logPath,
            { signal: deployment.cancelled },
          );
        }
      }

      // The *un*-converted content: `getBuildComposeCommand` injects, and
      // injecting twice would append every router label a second time.
      const content = publishStackVmPorts(
        await this.readComposeContent(compose, target),
        stackVmRoutes,
      );
      // H-83, and **this is the only seam that can see it for a git-sourced
      // stack.** A raw stack's compose file is a column, so every write surface
      // checks it; a git stack's lives in the repository, reaches no DTO and no
      // service method, and is first readable one line above — which is why a
      // write-path guard alone would have left the majority source type wide
      // open. The organization comes off the row's own `environment → project`
      // rather than a session, because a queue job has none.
      //
      // After the clone rather than before it, unavoidably: the file does not
      // exist until the clone has run. So a refusal here lands with
      // `targetWritten` already true and the stack goes to `error`, which is
      // correct rather than a regression — the clone's `rm -rf` *has*
      // rewritten the target, so "in a state nobody knows" is exactly true. For
      // a raw stack the static half has already fired at `writeDomainsToCompose`
      // above, before the first write, and only the ownership query waits.
      await this.composeService.assertComposeContentClaimable(
        {
          organizationId: compose.environment.project.organizationId,
          serverId: compose.serverId,
        },
        content,
      );
      // A traced Compose's Trace store is running before its services
      // start, and every inner service is told where to send. After every
      // refusal above, so a refused deploy starts no store; a Compose has no
      // preview, so this is every build of one.
      // A Trace store runs beside its Service on the same machine, and a
      // Stack VM has none yet: its stack's `null` Server must not start one
      // on the platform host.
      const traces = compose.cloudAccountId
        ? null
        : await this.startTraceStore(
            composeTraceOwner(compose),
            compose.serverId,
            deployment.logPath,
          );
      const build = getBuildComposeProgram(
        compose,
        content,
        domains,
        traces && composeTraceWiringOf(traces),
      );
      // Every build carries its `.env` in its environment — and a
      // stack its variables, a traced one its converted file — so the remote
      // reads the program on `sh -s`'s stdin: stdin is closed for the build,
      // for the clone step's reason above. On the platform host the builder
      // has already refused a value over the kernel's cap on one.
      await target.execToLog(build.command, deployment.logPath, {
        env: build.env,
        signal: deployment.cancelled,
      });
      this.endCancellableSteps(deployment);

      await this.composeService.updateStatus(compose.composeId, 'done');
      // The ports and volumes of the file this deploy admitted above: for
      // a TCP Uptime check on a stack whose file is in a repository, and
      // for a plan's destroy line.
      await this.composeService.recordDeployedFile(compose, content);
      await this.recorder.updateStatus(deployment.deploymentId, 'done');
      await this.notifier.buildSuccess(this.composeNotification(compose));
    } catch (error) {
      this.recorder.closeCancelWindow(deployment.deploymentId);
      if (deployment.cancelled.aborted) {
        // As for an Application — except that a stack's last shell step
        // *is* its release (`docker compose up` / `docker stack deploy`), so a
        // cancel can land after the target was written, and the `error` rule for
        // that state holds whatever stopped the deploy.
        await this.logCancelled(
          compose.serverId,
          deployment.logPath,
          hostsNotYetLogged,
        );
        if (targetWritten) {
          await this.composeService.updateStatus(compose.composeId, 'error');
        }
        throw error;
      }
      const reason = await this.failureReason(
        compose.serverId,
        deployment.logPath,
        error,
      );
      await this.appendErrorToLog(
        compose.serverId,
        deployment.logPath,
        error,
        hostsNotYetLogged,
      );
      // The Deployment row below is the record of an *attempt*, so it goes to
      // `error` either way — as do the log line and the notification. Only
      // the stack's own status is withheld: a refusal that never
      // reached the exec above left the stack exactly as the operator left it,
      // `done` for one that is serving and `idle` for one never deployed.
      // The stack's status is written first, as for an Application.
      if (targetWritten) {
        await this.composeService.updateStatus(compose.composeId, 'error');
      }
      await this.recorder.updateStatus(deployment.deploymentId, 'error');
      await this.notifier.buildError({
        ...this.composeNotification(compose),
        errorMessage: reason,
      });
      throw error;
    }
  }

  /** The compose file as cloned onto the build server, *before* domain
   * injection — the stored definition for raw sources (the clone wrote the
   * converted form of exactly this). */
  private async readComposeContent(
    compose: DeployableCompose,
    target: RunTarget,
  ): Promise<string> {
    if (compose.sourceType === 'raw') return compose.composeFile;
    // Argv for the same reason `ComposeService.readComposeFile` passes argv: the
    // path is built from `composePath`, a `z.string().min(1)` column set through
    // `PATCH /compose/:id`, and remotely this still reaches a shell — the
    // difference is that `execOnServer` words it once for both sites instead of
    // each site remembering to. This is the copy an earlier worklist missed
    // while naming the one in `compose.service.ts`, which is the whole argument
    // for putting the joining behind the service rather than trusting a site
    // list.
    const { stdout } = await target.exec(['cat', getComposeFilePath(compose)]);
    return stdout;
  }

  private composeNotification(
    compose: DeployableCompose,
  ): DeploymentNotification {
    return {
      projectName: compose.environment.project.name,
      applicationName: compose.name,
      applicationType: 'compose',
      environmentName: compose.environment.name,
      organizationId: compose.environment.project.organizationId,
      projectId: compose.environment.projectId,
      environmentId: compose.environmentId,
      serviceId: compose.composeId,
    };
  }

  /**
   * One shell program on the build host, and the environment it reads values
   * out of instead of off its own command line.
   *
   * **Both branches carry the environment the same way**, which is
   * `destinations/rclone-exec.ts`'s precedent verbatim and the reason this is a
   * few lines rather than a plumbing project: remotely it travels as a script
   * on the SSH channel, where `ExecError` records only the command; locally it
   * is the child's environment, spread over `process.env` because
   * `ExecOptions.env` *replaces* rather than extends — a build handed a
   * two-variable environment would otherwise run with whatever `PATH` the
   * shell falls back to rather than the account's.
   *
   * An empty environment passes `undefined`, and that is deliberate: with no
   * environment `execAsyncRemote` sends the program as the SSH `exec` request
   * itself, under the account's login shell, exactly as every deploy in this
   * tree always has. So the transport only changes for a build that actually
   * has an operator variable to protect, and a `docker`-sourced Application —
   * which has no build step at all — is untouched.
   *
   * **No `shell` is passed, and that is a measured decision rather than a
   * default taken.** An environment makes the remote read the program with
   * `sh -s` instead of the login shell, which is the hazard once recorded
   * against ever reaching this seam; `RemoteExecService`'s `buildEnvScript`
   * carries the measurement — every builder's composed program is POSIX and
   * behaves identically under `bash -c`, `dash -s` and `bash -s`, and the local
   * branch has run these same programs under `/bin/sh` all along, because
   * `promisify(exec)` spawns one. Read that docblock before adding a bash
   * construct to a clone, a patch or a builder: with an environment it would break the
   * builds that carry an environment and only those.
   */
  private async exec(
    serverId: string | null,
    command: string,
    env: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<void> {
    // A build step carries its Deployment's cancel signal, which is not
    // an environment and changes nothing about which shell reads the program.
    // `execOnServer` is the one local-or-remote fork, and it spreads the
    // environment over `process.env` on the local branch.
    await execOnServer(this.remoteExec, serverId, command, { env, signal });
  }

  /**
   * A traced Service's wiring, with its Trace store made sure of first
   * (for an Application or a Compose); null when its traces are
   * off. `ensureTraceWiring` holds the rule — neither a store that will not
   * start nor a setting that cannot be read fails the Deployment — and its
   * lines go to the Deployment's log on `buildServerId`.
   */
  private startTraceStore(
    owner: TraceStoreOwner,
    buildServerId: string | null,
    logPath: string,
  ): Promise<TraceWiring | null> {
    const append = (line: string) =>
      this.appendToLog(buildServerId, logPath, line);
    return ensureTraceWiring(this.db, this.remoteExec, owner, {
      info: append,
      warn: append,
    });
  }

  /**
   * The build's shell steps are done: close its cancel window, and if a
   * cancel arrived before it closed, stop here rather than go on to release.
   * Both halves are synchronous so no cancel can fall between them.
   */
  private endCancellableSteps(deployment: DeploymentRecord): void {
    this.recorder.closeCancelWindow(deployment.deploymentId);
    deployment.cancelled.throwIfAborted();
  }

  /**
   * The last line of a build cancelled while it ran, after the host
   * line when the cancel came before the program that would have written it.
   * Best effort: the record already says `cancelled`, and a Server that cannot
   * be reached for one line must not turn the cancel into a failure.
   */
  private async logCancelled(
    serverId: string | null,
    logPath: string,
    lead?: string,
  ): Promise<void> {
    const line =
      'Cancelled: this build was stopped while it ran, and every process it had started was killed. Deploy again to build it.';
    try {
      await this.exec(
        serverId,
        (lead ? this.appendToLogCommand(logPath, lead) : '') +
          this.appendToLogCommand(logPath, `\n${line}`),
      );
    } catch {
      // See above.
    }
  }

  private notification(
    application: DeployableApplication,
  ): DeploymentNotification {
    return {
      projectName: application.environment.project.name,
      applicationName: application.name,
      applicationType: 'application',
      environmentName: application.environment.name,
      organizationId: application.environment.project.organizationId,
      projectId: application.environment.projectId,
      environmentId: application.environmentId,
      serviceId: application.applicationId,
    };
  }

  /**
   * The rollback branch of the push: records the snapshot and preserves the
   * released image under its version tag, so later builds can't overwrite what
   * the snapshot points at.
   *
   * **All three words are `quote()`d, and that is the defence.** The tag being
   * copied is {@link builtImageName}, which for a docker-sourced Application is
   * the unconstrained `dockerImage` column verbatim — so `docker tag ${…}` with
   * a bare word was a second command on the build server, not a bad tag (H-34).
   * `snapshot.image` is `${appName}:v${version}` and `logPath` is machine-made,
   * so those two are the charset-at-a-distance case; they are quoted anyway,
   * because a word that happens to be safe and a word that is *made* safe read
   * identically at the next edit. `RollbacksService.remove` reaches the same tag
   * as argv; there is no argv here, because the redirect that puts the
   * output in the Deployment's log is the point of the command.
   *
   * **A dedicated build Server gets no snapshot at all, and is told so**.
   * The tag is preserved by a `docker tag` *here*, on the Server that
   * built, while `RollbacksService.rollback` converges onto it through a Docker
   * handle taken from the Application's own `serverId`. Those are the same
   * machine whenever `buildServerId` is unset, which is every default install;
   * when they differ, the preserved tag exists only on the build Server and
   * nothing carries it across — {@link uploadImageCommands} pushes
   * `getRegistryTag`, which is a different name, and only when a Registry is
   * linked at all. The snapshot was captured anyway, offered in the console,
   * and failed at the one moment it was wanted: nothing in `rollback` polls for
   * convergence, so the API call succeeds and the run Server's tasks then fail
   * pulling `docker.io/library/${appName}` — a bare tag is Docker Hub, which is
   * the sibling defect whose credential half is fixed.
   *
   * The disk was the other half and it was worse, because it accumulated:
   * `RollbacksService.remove` deletes the preserved image with an
   * `execOnServer` against `owned.serverId`, the **run** Server, so a tag made
   * here on a build Server could not be reclaimed through the console at all —
   * the `docker image rm` fails for an image that machine never had, and that
   * failure deliberately keeps the row (its docblock says why). One
   * unreclaimable image per Deployment, on the host chosen precisely because
   * builds fill a disk.
   *
   * Refusing here rather than at rollback time is the point: the operator finds
   * out on the Deployment that would have produced the snapshot. The two
   * alternatives offered were both rejected. Tagging on the run Server
   * cannot work — this runs *before* the converge, so the released image is not
   * on the run Server yet, and in a multi-node Swarm it may never be on that
   * particular one. Pushing a `:v${version}` tag to the Application's Registry
   * would make a rollback pullable anywhere, but it is a write into somebody
   * else's registry with a per-Deployment storage cost they did not ask for,
   * and it would put a registry reference on the pinned converge path that
   * just stopped carrying a credential. If rollbacks on build-Server installs
   * are wanted, that is the change to make deliberately, with the credential
   * question reopened.
   *
   * The comparison is Server identity, not host identity: two Server rows
   * pointing at one machine read as different Servers here and lose a capture
   * that would have worked. Server identity is what the platform knows, and
   * over-refusing costs a snapshot while under-refusing costs the rollback.
   */
  private async captureRollback(
    application: DeployableApplication,
    deployment: { deploymentId: string; logPath: string },
    buildServerId: string | null,
  ): Promise<void> {
    if (buildServerId !== application.serverId) {
      await this.appendToLog(
        buildServerId,
        deployment.logPath,
        `⏭️ [Rollback] No snapshot captured: this Application builds on a dedicated build Server, so the '${application.appName}:v<version>' tag that preserves this image would exist only there. No registry serves that tag, so the Server running this service could not be put back onto it. Build where it runs to keep rollback points.`,
      );
      return;
    }
    const snapshot = await this.rollbacks.capture(
      deployment.deploymentId,
      application,
    );
    const command = `(docker tag ${quote([this.builtImageName(application)])} ${quote([snapshot.image])}) >> ${quote([deployment.logPath])} 2>&1`;
    await this.exec(buildServerId, command);
  }

  /**
   * The image a Cron service's runs start from, pinned to this build and
   * written on its row (spec: "It uses the image of the last successful
   * build"). `releasedImageName` is a moving name — `:latest`, a registry's
   * `:latest`, or an image source's own tag — so a later build that moved it
   * and then failed, or a tag moved upstream, would otherwise change what
   * the next run starts from.
   *
   * - **Built and kept on the Server that built it** (no Registry, which
   *   {@link assertBuiltImageReachesRunServer} allows only when that is the
   *   run Server): a tag of this build's own, `<appName>:build-<id>`, with the
   *   older build tags untagged. One still used by a run in flight is
   *   refused by Docker and kept, and goes at a later build.
   * - **Pushed to a Registry, or pulled from one** (an image source): the
   *   registry's digest of what this build left, `<repository>@sha256:…`,
   *   which every Server pulls alike.
   *
   * A pin that cannot be made or read falls back to the moving name, and the
   * log says so: the build itself succeeded.
   */
  private async pinCronImage(
    application: DeployableApplication,
    deployment: { deploymentId: string; logPath: string },
    buildServerId: string | null,
  ): Promise<string> {
    const released = releasedImageName(application);
    let pinned: string | null = null;
    try {
      if (
        application.sourceType !== 'docker' &&
        !pushesToRegistry(application)
      ) {
        const tag = `${application.appName}:build-${deployment.deploymentId}`;
        const others = `docker image ls --format '{{.Repository}}:{{.Tag}}' ${quote([application.appName])} | grep ':build-' | grep -vxF ${quote([tag])} | xargs -r docker image rm >/dev/null 2>&1 || true`;
        await execOnServer(
          this.remoteExec,
          buildServerId,
          `docker tag ${quote([this.builtImageName(application)])} ${quote([tag])} && { ${others}; }`,
        );
        pinned = tag;
      } else {
        const { stdout } = await execOnServer(
          this.remoteExec,
          buildServerId,
          `docker image inspect --format '{{json .RepoDigests}}' ${quote([released])}`,
        );
        pinned = digestOf(released, stdout);
      }
    } catch {
      pinned = null;
    }
    if (pinned === null) {
      await this.appendToLog(
        buildServerId,
        deployment.logPath,
        `⚠️ [Build] This build's image could not be pinned, so each run starts from '${released}' as it is then`,
      );
      return released;
    }
    // Its runs read it from the row (`lastSuccessfulBuild`).
    await this.db
      .update(deploymentTable)
      .set({ cronImage: pinned })
      .where(eq(deploymentTable.deploymentId, deployment.deploymentId));
    return pinned;
  }

  /**
   * The image a build leaves behind — the pulled image for a docker source,
   * the appName:latest tag every builder produces otherwise.
   *
   * **Not a safe word, and every caller quotes it.** The `docker` branch is
   * `application.dockerImage` verbatim, and that column is
   * `z.string().nullable()` in `updateApplicationSchema` — no charset, no mint,
   * nothing (H-34). `docker.strategy.ts` `shEscape`s the same column and
   * records why; this is the value that reaches the other sites, in
   * `captureRollback` and {@link uploadImageCommands}. The docker
   * branch reaches only the Push phase's `echo` there — a docker source never
   * gets to the `docker tag` / `docker push` words — and they stay quoted
   * anyway, for the reason the class docblock gives.
   */
  private builtImageName(application: DeployableApplication): string {
    return application.sourceType === 'docker'
      ? application.dockerImage || ''
      : `${application.appName}:latest`;
  }

  /**
   * The shell that appends one line to a Deployment's log, base64-carried so
   * quoting can't break the echo and so a `\n` in the line is a real newline
   * on every shell (a bare `echo "a\nb"` is two lines under dash and one
   * literal `\n` under bash).
   *
   * Extracted from `appendErrorToLog`: the Update phase runs against
   * the Docker API in this process, outside the `>> logPath` redirection every
   * shell step rides, so it needs its own writer. Two writers drifting apart is
   * how the log ends up quoting one phase's output and mangling another's.
   *
   * The path is the one the Deployment row carries (ADR-0007) — the log is
   * addressed by its Deployment, never by a caller-supplied path. It is
   * `quote()`d rather than left in the `"…"` it used to sit in: double quotes
   * stop a separator and not a substitution, and there is no
   * `assertShellSafePath` in front of this sink to make up the difference the
   * way there is at `getCreateFileCommand` (H-12, H-34). One mechanism for the
   * file, so the six redirects and this one cannot drift into two grammars.
   */
  private appendToLogCommand(logPath: string, line: string): string {
    return `echo "${encodeBase64(`${line}\n`)}" | base64 -d >> ${quote([logPath])};`;
  }

  /** One line into the Deployment's log, on the server the log file lives on. */
  private async appendToLog(
    serverId: string | null,
    logPath: string,
    line: string,
  ): Promise<void> {
    await this.exec(serverId, this.appendToLogCommand(logPath, line));
  }

  /**
   * What a failed Deployment's notification says went wrong — the event
   * promises *"the message the builder printed"*.
   *
   * **Not `error.message` for an `ExecError`, which is the script.** Every
   * build step runs inside one `(…) >> logPath 2>&1` subshell, so the builder's
   * output goes to the log and the rejected exec carries an empty stderr and a
   * `message` of `Command execution failed: Command failed: ` plus the whole
   * generated program — which names `nixpacks build` and a registry push for a
   * clone that never got past its first step, and ends on a log redirect. The
   * reason is in the log and nowhere else, so it is read back from there, on
   * the machine the log lives on, *before* {@link appendErrorToLog} adds its
   * banner (which says "check the logs" to someone reading the logs).
   *
   * A step that did not write to the log — a `cat` of a compose file, an
   * append that failed — has its reason on its own stderr instead, and that is
   * preferred when there is one. Any other error is a sentence this engine
   * composed (a convergence verdict, a refusal) and is already the reason.
   *
   * Only the notification changes. The log, the row's `error` status and the
   * error rethrown to the queue — which keeps `command` and `message` for the
   * job's own record — are exactly what they were. The read can fail and must
   * not replace the failure it is describing, so a failed read falls through to
   * a sentence that still says which step gave up and never quotes the script.
   */
  private async failureReason(
    serverId: string | null,
    logPath: string,
    error: unknown,
  ): Promise<string> {
    if (!(error instanceof ExecError)) {
      return error instanceof Error ? error.message : 'Error building';
    }
    const own = summarizeBuildOutput(error.stderr ?? '');
    if (own) return own;
    try {
      const { stdout } = await execOnServer(this.remoteExec, serverId, [
        'tail',
        '-n',
        String(FAILURE_TAIL_LINES),
        logPath,
      ]);
      const logged = summarizeBuildOutput(stdout);
      if (logged) return logged;
    } catch {
      // Falls through: the failure being reported outranks this one.
    }
    return `A build step failed with exit code ${error.exitCode ?? 'unknown'} and left nothing in the Deployment log to say why.`;
  }

  /** The error branch: surface the failure inside the deployment log.
   * ExecError output already landed there via the log redirection; other
   * errors carry their message over base64 so quoting can't break the echo.
   *
   * The banner stays a plain `echo`, not a base64 line: it is what an operator
   * greps a log tail for and what the suite matches on, and it is fixed text
   * with nothing in it that quoting can break. Its *redirect target* is not
   * fixed text and is `quote()`d like every other one in this file (H-34).
   *
   * `lead` is the host line when the failure came before the program that
   * would have written it, carried in the same exec so a refusal costs no
   * extra round trip. */
  private async appendErrorToLog(
    serverId: string | null,
    logPath: string,
    error: unknown,
    lead?: string,
  ): Promise<void> {
    let command = lead ? this.appendToLogCommand(logPath, lead) : '';
    if (!(error instanceof ExecError)) {
      const message = error instanceof Error ? error.message : String(error);
      command += this.appendToLogCommand(logPath, message);
    }
    command += `echo "\nError occurred ❌, check the logs for details." >> ${quote([logPath])};`;
    await this.exec(serverId, command);
  }

  /**
   * `{applicationsDirectoryOn(buildHost)}/{appName}/code` — where the source
   * lands.
   *
   * **Rooted on the machine that holds it, not on this process.** This resolved through
   * `applicationsDirectory()` — i.e. `localCloudgateDirectory()` — for every machine
   * alike, including a Server
   * the build was dispatched to, whose tree `serverSetupCommand` laid out at
   * `REMOTE_CLOUDGATE_DIRECTORY`. `cloudgate-directory.ts` states the rule in
   * as many words: *"every path baked into a command sent over SSH … has to be
   * that literal, whatever this instance's own layout is"*. So on an install
   * that sets `CLOUDGATE_DIRECTORY`, a dispatched build cloned into a root that
   * did not exist on the builder — and the whole set was nonetheless
   * *self-consistent*, because the Deletes resolved it the same wrong way,
   * which is why nothing broke.
   *
   * **This is the writer, and it is why the conversion had to be atomic.**
   * ADR-0018's rule is that whoever creates an artifact and whoever destroys it
   * must answer *which machine* the same way; stated for roots it is the same
   * rule, and `applicationsDirectoryOn` landed without flipping anything
   * precisely because converting the Deletes while this stayed local would have
   * written the tree under one root and `rm -rf`'d it from the other — moving
   * the leak rather than closing it, which is what ADR-0018 records
   * `uploadDrop` doing for the machine half. The five call sites moved together:
   * this one, `ApplicationsService.uploadDrop`,
   * `ApplicationsService.remove`, `common/service-cascade.ts`'s application arm
   * and `preview-teardown.ts`'s `previewCodeDirectory`.
   *
   * The Server it asks is {@link buildHostServerId} over the application's own
   * pair — never `serverId`, which answers where the *workload* runs — and it
   * is derived here rather than threaded from {@link deploy}'s own
   * `buildServerId` because the answer is a pure function of two columns this
   * row already carries, and one question with one answer is the point.
   */
  private codeDirectory(application: DeployableApplication): string {
    return path.join(
      applicationsDirectoryOn(buildHostServerId(application)),
      application.appName,
      'code',
    );
  }

  private async cloneProgram(
    application: DeployableApplication,
    options: { readonly platform?: string } = {},
  ): Promise<SourceProgram> {
    return this.sourceClone.cloneProgram(
      application,
      this.codeDirectory(application),
      {
        ...options,
        // The build host, where `codeDirectory` is.
        on: {
          serverId: buildHostServerId(application),
          serviceId: application.applicationId,
        },
      },
    );
  }

  /** The build path inside the checkout, the folder `publish` is read from. */
  private buildAppDirectory(application: DeployableApplication): string {
    return buildAppDirectoryIn(this.codeDirectory(application), application);
  }

  /**
   * The one configuration in which a build produces an image the run Server
   * can never see, refused before the build runs.
   *
   * A dedicated build Server builds `${appName}:latest` **there**, and
   * {@link uploadImageCommands} is the only thing that moves it anywhere — it
   * pushes `getRegistryTag(...)` and only when a Registry is linked, emitting
   * its "No registry is set" line and nothing else otherwise. The converge then
   * runs on `application.serverId` against `getImageName(...)`, which with no
   * Registry is the bare `${appName}:latest` that machine has never had. So a
   * build Server without a Registry does not merely lose rollbacks: the
   * Application cannot deploy at all.
   *
   * **What it did instead is worse than a failed converge, and that is why this
   * throws rather than warning.** A bare tag is not a missing image to the
   * daemon — Docker normalizes a single-component reference to
   * `docker.io/library/<appName>:latest`, so the run Server's tasks pull *the
   * Docker Official Image of that name* if one exists. `appName` is
   * caller-supplied (`createApplicationSchema`, held only to `APP_NAME_REGEX`),
   * so an Application called `redis`, `nginx`, `wordpress` or `node` deployed
   * a stranger's image under this Application's name, network, mounts, Traefik
   * routers and `env` — with the Application's secrets in that container's
   * environment — and `awaitConvergence` watched the tasks come up and recorded
   * the Deployment `done`. A **green deploy of software nobody here built** is
   * not a state an operator can be expected to notice, which is the whole
   * argument for failing loudly at the top of the run. Where the name matches
   * no official image the pull fails, moby falls back to a local image that is
   * not there either, and the Deployment errors on a convergence timeout that
   * names neither the Registry nor the build Server.
   *
   * **`sourceType === 'docker'` is exempt, and that exemption is the reason the
   * refusal is not at the DTO** (the other option). A docker-sourced
   * Application builds nothing: the "build" step is `dockerStrategy.clone`'s
   * `docker pull`, and the converge runs `application.dockerImage` verbatim
   * with the Application's own pull credential (`resolveAuthConfig`'s docker
   * branch). A dedicated build Server with no Registry is a perfectly good
   * configuration for one, and `rollbacks.e2e-spec.ts` deploys exactly that.
   * `sourceType`, `registryId`, `buildRegistryId` and `buildServerId` are four
   * independently `PATCH`-able columns on a `.partial()` schema, so a
   * write-time check sees one request against one snapshot of the row and any
   * later write to any of the other three re-breaks what it just held. Holding
   * it would mean checking the merged post-state on *every* PATCH, which
   * refuses a rename or a memory limit on the rows already in this state — the
   * rows this check is about. Here all four are known at once, and about the deploy
   * that is actually running.
   *
   * `buildRegistry` counts as well as `registry`, because
   * {@link uploadImageCommands} pushes to either and `getImageName` resolves
   * `registry ?? buildRegistry` — the two agree on which tag the run Server
   * pulls, so either one alone makes the image reachable.
   *
   * Thrown inside `deploy`'s `try` on `generateConfigContainer`'s precedent, so
   * the refusal takes the path every failed Deployment takes: the sentence into
   * the Deployment log, `error` on the row, and `buildError` to whoever is
   * subscribed. Before the first shell step, so it costs no build.
   */
  private assertBuiltImageReachesRunServer(
    application: DeployableApplication,
    buildServerId: string | null,
  ): void {
    if (application.sourceType === 'docker') return;
    if (buildServerId === application.serverId) return;
    if (pushesToRegistry(application)) return;
    const imageName = this.builtImageName(application);
    throw new Error(
      `Cannot deploy: this Application builds on a dedicated build Server and no registry is set, so the image '${imageName}' stays on the Server that built it. The Server that runs '${application.appName}' would be told to pull '${imageName}', which Docker reads as 'docker.io/library/${imageName}' — Docker Hub, not this build. Link a registry to this Application so the built image is pushed where the run Server can pull it, or build where it runs.`,
    );
  }

  /**
   * Login, tag, and push the built image so the deploy server can pull — the
   * registry/buildRegistry branches (rollback registries land with Phase 24).
   *
   * With no registry this returned `[]`, so Push — a phase the console's
   * *Phases of a Deployment* card names and the log well beside it is the only
   * place any phase reports — left no line at all on the default single-box
   * install, and the log simply ended on the builder's last output. A
   * line saying nothing was pushed costs nothing: it is composed into the same
   * redirected command the build already runs, so it adds no round trip.
   *
   * **That line only ever reports something harmless.** It said
   * "the image stays on the Server this deployment ran on" on the configuration
   * where that was fine — one Server — and on the one where it was fatal, a
   * dedicated build Server whose image the converge then could not find. The
   * second is refused before the build now; see
   * {@link assertBuiltImageReachesRunServer} for what it did instead.
   *
   * **There are two fallback lines, and the docker arm is why.** A
   * docker-sourced Application builds nothing — its "build" is
   * `docker.strategy.ts`' `docker pull` — so `imageName` here is the operator's
   * own `dockerImage` reference, an image every Server pulls for itself. Saying
   * it "stays on the Server this deployment ran on" described a build that
   * could not be moved, which is the state
   * {@link assertBuiltImageReachesRunServer} refuses for every other source
   * type and exempts this one from for exactly this reason. The phase still
   * reports rather than falling silent, on the argument above: a source that
   * pushes nothing is the case where an operator most wants the log to say so.
   *
   * **And that line is the whole phase for a docker source, Registry
   * or not.** It used to log in to a linked Registry, `docker tag` the pulled
   * image and push it, while the converge released `dockerImage` verbatim with
   * the Application's own pull credential — a push nothing read. The
   * decision is {@link pushesToRegistry}'s, so the ❌ line's "pushed" and this
   * phase cannot disagree about it.
   *
   * **Both interpolated words are `quote()`d, and that is the defence** (H-34).
   * Two unconstrained columns meet here and neither is guarded anywhere else:
   * `imageName` is {@link builtImageName}, i.e. the `z.string().nullable()`
   * `dockerImage`; and `registryTag` is `getRegistryTag`, which is built from
   * `registry.imagePrefix` — also `z.string().nullish()` — falling back to the
   * username, with the tail of `imageName` on the end. `registry.url` is the
   * one part that carries a charset (`registryUrlSchema`), which is precisely
   * the reliance that reads as safety and is not: it constrains one of the
   * three pieces of the word.
   *
   * The two `echo`s are quoted as **whole words** rather than left as `"…"`
   * with a value inside, because `$(…)` substitutes through double quotes and
   * the "No registry is set" line is the one that runs on the ordinary
   * single-box install with no registry at all. `quote()` emits the same
   * double-quoted form for a sentence carrying apostrophes and no
   * metacharacter, so the operator's log line is byte-identical to what it was.
   * Argv was rejected here and only here: these are `||`-chained steps inside
   * one redirected shell program, and there is no argv for a `||`.
   *
   * **The password is the one word that is no longer here at all.** This
   * is the site once called the most journalled secret in the tree — a refused
   * login is the likeliest failure on the push path, `registry.password` is
   * `encryptedText` (ADR 0006), and `ExecError` captures the whole command,
   * from where pino writes it six times over. The credential fix measured away three of the
   * four obstacles to never-carry and found this site *already reachable*: it
   * is a step in the same composed program `exec` had just started handing an
   * environment to, so the only thing needed was somewhere for a value to
   * travel. It travels in {@link CarriedPush.env}, under a holder named here,
   * and the command holds a reference the remote shell expands
   * (`registries/registry.utils.ts`' `dockerLoginCommand`).
   *
   * The holder is indexed rather than named after the Registry, because both
   * arms below can fire for one Application — `registry` and `buildRegistry`
   * are independent columns and this method pushes through either or both — so
   * the index is the number of pushes composed so far, exactly as
   * `build-env.ts` numbers a build's variables. It is a literal prefix plus a
   * number, which is what makes it safe to leave un-`quote()`d in the command
   * (see `dockerLoginCommand`), and it is valid against `RemoteExecService`'s
   * `ENV_NAME` by construction.
   */
  private uploadImageCommands(application: DeployableApplication): CarriedPush {
    const imageName = this.builtImageName(application);

    const commands: string[] = [];
    const env: Record<string, string> = {};
    const push = (registry: Registry, banner: string) => {
      const registryTag = getRegistryTag(registry, imageName);
      const holder = `CG_REGISTRY_PASSWORD_${Object.keys(env).length}`;
      env[holder] = registry.password;
      commands.push(
        `echo ${quote([`${banner} Uploading image to '${registryTag}'`])} ;`,
        `${dockerLoginCommand(registry.url, registry.username, holder)} || { echo "❌ Registry login failed" ; exit 1; }`,
        'echo "✅ Registry Login Success" ;',
        `docker tag ${quote([imageName])} ${quote([registryTag])} || { echo "❌ Error tagging image" ; exit 1; }`,
        `docker push ${quote([registryTag])} || { echo "❌ Error pushing image" ; exit 1; }`,
        'echo "✅ Image Pushed" ;',
      );
    };
    if (!pushesToRegistry(application)) {
      commands.push(
        `echo ${quote([
          application.sourceType === 'docker'
            ? `📦 [Push] Nothing to push — this Application runs '${imageName}' as pulled.`
            : `📦 [Push] No registry is set — the image '${imageName}' stays on the Server this deployment ran on.`,
        ])} ;`,
      );
      return { commands, env };
    }
    if (application.registry) {
      push(application.registry, '📦 [Enabled Registry Swarm]');
    }
    if (application.buildRegistry) {
      push(application.buildRegistry, '🔑 [Enabled Build Registry]');
    }
    return { commands, env };
  }

  /**
   * The build step: a shell program, plus the values its tools must read out of
   * the environment rather than off the command line.
   *
   * The strategies used to return a string with the operator's resolved
   * `env` / `projectEnv` / `environmentEnv` / `buildArgs` / `buildSecrets`
   * spliced into it, and `ExecError.command` captured all of it. What made the
   * environment reachable here first — and not at the registry-login sites
   * looked at before — is that this method *is* the origin of those values: nothing had
   * to be threaded back out of `SourceCloneService`'s clone command, whose
   * string return was the obstacle recorded on the login builder. The
   * declaration goes straight into {@link exec}, and the composed
   * `( … ) >> logPath 2>&1` above is untouched, because an environment is
   * prepended to the program rather than woven into it.
   *
   * **That obstacle is gone**, and the sentence above is kept as the
   * history rather than as the state: `cloneProgram` returns a
   * {@link SourceProgram}, so a private image's pull credential and both
   * registry passwords travel the same way these values do, and {@link deploy}
   * merges all three maps into one. The three prefixes are disjoint by
   * construction — see the comment at that merge.
   */
  private buildProgram(application: DeployableApplication): BuildProgram {
    return applicationBuildProgram(
      application,
      this.codeDirectory(application),
    );
  }
}
