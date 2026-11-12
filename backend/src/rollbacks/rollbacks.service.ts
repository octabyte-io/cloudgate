import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, desc, eq } from 'drizzle-orm';
import { hfTokenEnv } from '../ai-models/ai-model-facet';
import { wiredEnv } from '../project-config/outputs';
import { application } from '../applications/application.schema';
import {
  APPLICATION_CREDENTIAL_REFS,
  ApplicationsService,
} from '../applications/applications.service';
import { checkServerAccess } from '../common/owned-server';
import { refuseWhileInMaintenance } from '../servers/server-maintenance';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import type { DeployableApplication } from '../deployment-engine/deployment-engine.types';
import {
  gpuReleaseRefusal,
  releaseOf,
} from '../deployment-engine/gpu-deploy-check';
import { mechanizeDockerContainer } from '../deployment-engine/mechanize';
import type {
  RollbackRecorder,
  RollbackSnapshot,
} from '../deployment-engine/ports/rollback-recorder';
import { deployment } from '../deployments/deployment.schema';
import type { ServiceMount } from '../docker/docker.types';
import { RemoteDockerFactory } from '../docker/remote-docker.factory';
import { environment } from '../environments/environment.schema';
import { project } from '../projects/project.schema';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { execOnServer } from '../remote/exec-dispatch';
import { RemoteExecService } from '../remote/remote-exec.service';
import {
  applicationTraceOwner,
  ensureTraceWiring,
} from '../traces/trace-store';
// Both moved out of this file so the three delete paths that destroy
// `rollback` rows can ask the same question this service asks. `remove`'s two
// call sites are unchanged; see `preserved-images.ts` for why they moved.
import { imageAlreadyGone, preservedImageServerId } from './preserved-images';
import { rollback } from './rollback.schema';
import type { Rollback, RollbackContext } from './rollback.schema';
import { STATIC_ROLLBACK_RUNNER } from './static-rollback-runner.port';
import type { StaticRollbackRunner } from './static-rollback-runner.port';

/**
 * What a Rollback answers: a `static` site on AWS's queued Deployment,
 * or `null` on a Server, where nothing is queued.
 */
export interface RollbackAnswer {
  deploymentId: string | null;
}

/**
 * The columns {@link RollbackContext} omits, deleted off the snapshot before
 * it is written. `rollback.full_context` is a plain `json` column that
 * {@link RollbacksService.findAllByApplicationId} hands to every reader of the
 * Application, so a name absent from this list is stored in cleartext and
 * served — which is why the first seven entries, all of them `encryptedText`
 * on `application` (ADR 0006), are here at all. They are re-read off the live
 * row at rollback time instead.
 *
 * **Not every name below is an encrypted column, and reading it that way is
 * what produced the `refreshToken` gap.** Three kinds of name are on this list
 * and only the first is about a column type: a secret stored encrypted, a
 * *relation* that loads one (`environment` is the eighth entry and is an
 * Environment row, not a column — it carries `env`, and the seven credential
 * relations below it carry the rest), and a value that is not a secret at all
 * but cannot be split from one (`registryUrl` and `username`, argued at the end
 * of this block). `refreshToken` was a fourth kind once: a secret by intent
 * that had never been given the secret-bearing type, excluded here and plain
 * `text` on the table, so this list and the schema disagreed about what it was,
 * which is the disagreement that was fixed. It is `encryptedText` now on both
 * `application` and `compose`.
 *
 * The count in the sentence above moved from eight to seven for the *other*
 * reason: `environment` was never an encrypted column and had been miscounted
 * as one since the sentence was written. Seven is true only because the
 * sweep settled `refreshToken` — had that gone the other way the number would
 * be six. `test/rollbacks/rollback-context.spec.ts` enumerates its encrypted
 * columns off the table rather than listing them, so it began asserting this
 * one with no edit here, and
 * `test/coding-standards/secret-bearing-columns.spec.ts` is what stops the
 * fourth kind recurring anywhere in the tree.
 *
 * **The credential ids joined the relations later.** The list named the
 * seven relations — `github`, `registry`, `customGitSSHKey` and the four
 * beside them — and not the id columns they load through, so a snapshot
 * persisted `githubId`…`buildRegistryId` and {@link RollbacksService.rollback}
 * merged that snapshot *over* the live row, letting the snapshot's ids win.
 * A fix is what made this worth saying: it had just established those seven
 * ids as the live exposure on the Application's write path — a caller
 * attaching another organization's registry or SSH key and getting a build
 * that authenticated as the victim — and could not reach this file. Latent
 * here rather than live, because nothing under `deployment-engine/` reads a
 * `*Id` off the context (`mechanizeDockerContainer` consumes the *relations*,
 * which come from the live row) and `rollback` writes nothing back onto
 * `application`. Latent is not a reason to leave it: the first engine change
 * to read one of these ids off the context would restore the live bug and
 * would look like a one-line change at the time.
 *
 * **Spreading `APPLICATION_CREDENTIAL_REFS` rather than restating it** is what
 * makes that unrepeatable. The annotation is
 * `Exclude<keyof DeployableApplication, keyof RollbackContext>[]`, so an
 * eighth credential id added to that list does not compile here until
 * `RollbackContext` omits it too — and once it does, this loop deletes it with
 * no edit. The rejected alternative was a literal list plus a spec asserting
 * the two agree: a test that has to be written to catch the next arm is the
 * thing that failed in the rollback-snapshot leak. The other direction is
 * already pinned — `test/applications/application-credential-refs.spec.ts`
 * holds `APPLICATION_CREDENTIAL_REFS` to `updateApplicationSchema`'s own `*Id`
 * keys.
 *
 * `previewEnv` and `previewBuildArgs` are the same defect a level duller:
 * both are `encryptedText`, both arrived three weeks after this list
 * was written, and a new column is simply absent from the type as well as
 * from the list, so nothing objected. `buildServerId` and `serverId` are
 * deliberately *not* excluded — they name a Server rather than a credential —
 * and the snapshot's copies are load-bearing rather than merely
 * harmless: they are the record of which Server the preserved image tag was
 * made on, which is what {@link RollbacksService.rollback} refuses on.
 * {@link RollbacksService.remove} reads the same pair through
 * `preservedImageServerId`, to know which machine the image it is dropping is
 * on — so the snapshot's copies are now load-bearing on two paths, not one.
 * The Docker connection itself still comes off `fresh.serverId`.
 *
 * **`registryUrl` and `username` joined them, and for the opposite
 * reason to everything above.** Neither is encrypted, neither is a secret and
 * neither costs anything at rest. They are excluded because a credential is
 * the *triple*: `resolveAuthConfig`'s docker branch reads `registryUrl`,
 * `username` and `password` off this context — the Application's own columns,
 * not the `registry` relation, which is why the relation exclusions never
 * reached this arm — and hands the three to the daemon as one blob. Excluding
 * one of three split the triple across two rows. A registry rotation is one
 * save of the console's docker source form, which moves all four docker-source
 * fields at once, so after one a rollback paired the retired host and the
 * retired user with the **live** secret, and `mechanizeDockerContainer` handed
 * that blob to the daemon as `X-Registry-Auth` — which is the credential the
 * Swarm service pulls its image with, not a value the converge inspects and
 * discards. The rule this encodes: a credential's fields are excluded together
 * or not at all, whatever their column types say.
 *
 * The cost was weighed and it is zero: excluding these means a
 * rollback can no longer reproduce a deploy that used a different registry —
 * except that it never could. `rollback` pins `mechanize` to
 * `owned.rollback.image`, which is `capture`'s `${appName}:v${version}` tag,
 * made by a local `docker tag` in `DeploymentEngineService.captureRollback` and
 * served by no registry, so the snapshot's registry coordinates had no consumer
 * to lose. The alternative rejected was refusing a rollback whose snapshot and
 * live row disagree here: honest, and it fails on exactly the day the operator
 * most wants a rollback. (Keeping all three, `password` included, is what the
 * leak fix spent its diff removing.) `dockerImage` deliberately stays — it is
 * config a rollback restores, and on the pinned-image path nothing reads it.
 *
 * **The consumer is gone, so these two are now a rule rather than a
 * live fix.** A converge pinned to `options.image` carries
 * `mechanize`'s `NO_PULL_CREDENTIAL` and never calls `resolveAuthConfig` at
 * all, so no snapshot value — split or whole — can reach the daemon on this
 * path any more. They stay excluded because the rule is what protects the next
 * arm: the day a pinned image becomes a *registry* reference (see
 * `DeploymentEngineService.captureRollback`), `resolveAuthConfig`
 * comes back and must be handed a triple that agrees with itself.
 */
const EXCLUDED_FROM_CONTEXT: Exclude<
  keyof DeployableApplication,
  keyof RollbackContext
>[] = [
  'env',
  'buildArgs',
  'buildSecrets',
  'password',
  'previewEnv',
  'previewBuildArgs',
  'refreshToken',
  'environment',
  'github',
  'gitlab',
  'gitea',
  'bitbucket',
  'customGitSSHKey',
  'registry',
  'buildRegistry',
  'registryUrl',
  'username',
  ...APPLICATION_CREDENTIAL_REFS,
];

/**
 * A mount as the snapshot stores it: `ServiceMount`'s five declared fields and
 * nothing else.
 *
 * `DeployableApplication.mounts` is typed `ServiceMount[]`, which has no
 * `content` — but {@link ApplicationsService.findDeployable} **used to** fill
 * it from `select().from(mount)`, i.e. whole rows (it projects now,
 * see below), and `mount.content` is an
 * `encryptedText` column holding the body of a file mount, which is where an
 * operator puts a config file with credentials in it. Structural typing
 * accepts the wider row without complaint, so the plaintext reached
 * `full_context` and the reader endpoint with the type still saying it could
 * not.
 *
 * A whitelist and not `delete mount.content`: the point is that the snapshot
 * carries what `mechanize` reads and nothing it does not, so a later secret
 * column on `mount` is excluded by having never been named. No-op for the
 * converge — `generateVolumeMounts`, `generateBindMounts` and
 * `generateFileMounts` read exactly these five.
 *
 * **The source is fixed and this stays, for a reason stronger than defence
 * in depth.** `findDeployable` now projects `mounts` to these same five
 * columns, so on the **write** path this function is genuinely redundant for
 * `content` — the row it is handed no longer has one. On the **read** path it
 * is not redundant at all, and cannot be made so by any change to a query:
 * {@link toRollbackContext} runs over `full_context` rows coming *back out* of
 * the column, and every snapshot captured before the leak fix still holds
 * the decrypted body it found. `0062_scrub-legacy-rollback-context.sql`
 * reaches those at rest; this reaches the ones an install has not
 * migrated yet, and the window between the two fixes.
 *
 * So the two projections are not a duplicate of one shape. This one answers
 * *"what may a persisted, HTTP-served snapshot contain"*, over rows this
 * process did not produce; `findDeployable`'s answers *"what does the deploy
 * engine get handed"*, and is what stops every **other** consumer of a
 * `DeployableApplication` from inheriting the leak. Deleting either one
 * leaves a live path open.
 */
function toSnapshotMount(mount: ServiceMount): ServiceMount {
  return {
    type: mount.type,
    mountPath: mount.mountPath,
    volumeName: mount.volumeName ?? null,
    hostPath: mount.hostPath ?? null,
    filePath: mount.filePath ?? null,
  };
}

/**
 * The config snapshot a rollback redeploys with — run on the way **in** and on
 * the way back **out** again.
 *
 * Applying it to a row that was read is not belt-and-braces: it is the only
 * thing that reaches the snapshots already in the column (the leak fix's first
 * residual). Every row captured before this list covered the credential ids
 * still holds them, no write revisits a `full_context`, and the ids sitting
 * there are the Application's own row *as it stood* — which, before an earlier
 * fix, could legitimately be another organization's `registryId`, because that
 * is exactly the write that fix closed. Two paths reach such a row: {@link
 * RollbacksService.rollback} merges the snapshot over the live one, so a stale
 * id wins; and {@link RollbacksService.findAllByApplicationId} serves
 * `full_context` verbatim to every reader of the Application. Stripping on read
 * closes both without a migration.
 *
 * What it does not do is remove the cleartext **at rest** — a database dump or
 * a backup of a legacy row still carries it. That is
 * `0062_scrub-legacy-rollback-context.sql`, and this function stays
 * necessary beside it: it covers a row captured between the leak fix and the
 * moment an install actually applies that migration.
 */
function toRollbackContext(
  app: DeployableApplication | RollbackContext,
): RollbackContext {
  const context: Partial<DeployableApplication> = { ...app };
  for (const key of EXCLUDED_FROM_CONTEXT) delete context[key];
  if (context.mounts) context.mounts = context.mounts.map(toSnapshotMount);
  return context as RollbackContext;
}

/**
 * Snapshots of successful deployments an application can be rolled back to.
 * Implements the Phase 24 `RollbackRecorder` port the deployment engine
 * captures through.
 */
@Injectable()
export class RollbacksService implements RollbackRecorder {
  private readonly logger = new Logger(RollbacksService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly applications: ApplicationsService,
    private readonly dockerFactory: RemoteDockerFactory,
    private readonly remoteExec: RemoteExecService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Records the snapshot and derives its image tag from the serial version.
   * Internal — the engine calls this after a successful build, so no
   * PermissionCtx.
   */
  async capture(
    deploymentId: string,
    app: DeployableApplication,
  ): Promise<RollbackSnapshot> {
    return this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(rollback)
        .values({ deploymentId })
        .returning();
      const image = `${app.appName}:v${inserted.version}`;
      await tx
        .update(rollback)
        .set({ image, fullContext: toRollbackContext(app) })
        .where(eq(rollback.rollbackId, inserted.rollbackId));
      return { image };
    });
  }

  /**
   * **A `static` site on AWS's point is not this**: it names a folder
   * of the site's bucket, and going back to it queues a Deployment of the
   * Service ({@link queueStaticRollback}), answered with its id. The rest of
   * this block is a Server's rollback, which is unchanged.
   *
   * Converges the application's Swarm service back onto the snapshot's image
   * and config. Secrets excluded from the snapshot (env, credentials) come
   * from the live application row instead.
   *
   * **The spread order is the snapshot over the live row, and that is the
   * point**: a rollback is meant to redeploy the config as it was. It is also
   * why {@link EXCLUDED_FROM_CONTEXT} rather than this line is where the leak
   * was fixed — reordering the spread would have made the snapshot stop
   * restoring anything, so the answer is that the snapshot must not *hold* a
   * key it has no business winning on. Every one of them is re-read here off
   * `fresh`.
   *
   * **A snapshot whose image was preserved on another Server is refused, and
   * that reads the Server pair off the snapshot**. The tag this
   * converges onto is made by a `docker tag` in
   * `DeploymentEngineService.captureRollback`, on the Server that *built* the
   * Deployment, and no registry serves it — so when that Server is not the one
   * `fresh.serverId` names, the tag is on no machine this converge can reach.
   * What happened without the guard is quieter than a failed rollback rather
   * than louder: the update was accepted, nothing here polls for convergence,
   * and the run Server's tasks then failed pulling
   * `docker.io/library/${appName}` — a bare tag is Docker Hub — with no copy of
   * the image on the node to fall back to. The `UpdateConfig`
   * `generateConfigContainer` writes is `Order: 'start-first'` with
   * `FailureAction: 'rollback'`, so the generation that was already up keeps
   * serving and Swarm puts the previous spec back: the likeliest outcome is not
   * an outage but a rollback that silently did not happen. The operator saw a
   * 204.
   *
   * {@link preservedImageServerId} over the merged context, and not `fresh`'s
   * pair, is the whole precision of the check, and it is why
   * {@link EXCLUDED_FROM_CONTEXT} keeps those two columns: the snapshot records
   * where its own tag was made. A single-Server install that later points
   * builds at a dedicated Server keeps every snapshot it already took, and an
   * Application moved to another Server loses them — both of which reading the
   * live row alone gets backwards. What neither can see is an image deleted off
   * a Server that is still the right one, which is `remove`'s business and
   * stays a converge-time failure.
   */
  async rollback(
    ctx: PermissionCtx,
    rollbackId: string,
  ): Promise<RollbackAnswer> {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const owned = await this.findOwnedRollback(ctx, rollbackId);
    await this.permissions.checkServiceAccess(ctx, owned.applicationId, 'read');
    // Nothing is restored onto a Server in maintenance (spec #1420).
    await refuseWhileInMaintenance(this.db, [owned.serverId]);
    // A `static` site on AWS's point is a folder of its bucket, and
    // going back to it is a Deployment of the Service.
    if (owned.rollback.folder) {
      return this.queueStaticRollback(
        owned.applicationId,
        owned.rollback,
        owned.rollback.folder,
      );
    }
    if (!owned.rollback.image || !owned.rollback.fullContext) {
      throw new NotFoundException('Rollback context not found');
    }

    const fresh = await this.applications.findDeployable(owned.applicationId);
    const context: DeployableApplication = {
      ...fresh,
      ...toRollbackContext(owned.rollback.fullContext),
    };
    if (preservedImageServerId(context) !== fresh.serverId) {
      throw new ConflictException(
        'Rollback point cannot be restored: its image was preserved on the server that built that deployment, not the server this service runs on',
      );
    }
    const docker = await this.dockerFactory.getRemoteDocker(fresh.serverId);
    // The point keeps its `gpus`, and restoring it starts tasks as a
    // deploy's release does, so it is admitted as one is (ADR-0039) — refused
    // before anything is released, in the deploy's words. A 409, as above:
    // the point is there, the machine cannot take it now.
    const gpuRefusal = await gpuReleaseRefusal(
      this.remoteExec,
      this.db,
      releaseOf(docker, context),
    );
    if (gpuRefusal) throw new ConflictException(gpuRefusal);
    await mechanizeDockerContainer(context, docker, {
      image: owned.rollback.image,
      injectedEnv: {
        ...(await this.traceWiring(fresh)),
        // The Hugging Face token off the live facet, as a deploy reads
        // it; the snapshot never held it.
        ...(fresh.aiModel && (await hfTokenEnv(this.db, fresh.applicationId))),
      },
      // The live row's links, filled in now as a deploy fills them;
      // the snapshot never held a value.
      wiredEnv: await wiredEnv(this.db, fresh.environmentId, fresh.configLinks),
    });
    return { deploymentId: null };
  }

  /**
   * A `static` site on AWS's Rollback (the spec's "Rollback"): a
   * build-less Deployment of the Service, queued with its pushes' Cloud runs,
   * that switches the distribution back to the point's folder, clears the
   * cache and waits, with its own log. It restores files only: the
   * distribution's settings stay as the Project config says. Answered with
   * the Deployment's id, so the console can open its log.
   */
  private async queueStaticRollback(
    applicationId: string,
    point: Rollback,
    folder: string,
  ): Promise<RollbackAnswer> {
    const deploymentId = await this.staticRollbacks().queue({
      applicationId,
      folder,
      title: `Rollback to v${point.version}`,
      description: `Restores the files of Deployment ${point.deploymentId}; the distribution's settings stay as the Project config says`,
    });
    return { deploymentId };
  }

  /** The Project config module's runner, which this module cannot import. */
  private staticRollbacks(): StaticRollbackRunner {
    return this.moduleRef.get<StaticRollbackRunner>(STATIC_ROLLBACK_RUNNER, {
      strict: false,
    });
  }

  /**
   * A traced Application's `OTEL_*`, injected into a Rollback as a deploy
   * injects them, off the live row — traces are a setting of the
   * Application now, not of the snapshot. `ensureTraceWiring` is the deploy's
   * own rule: its Trace store is made sure of first, and neither a store that
   * will not start nor a setting that cannot be read refuses the Rollback.
   * There is no Deployment log here, so a warning goes to the backend's.
   */
  private async traceWiring(
    fresh: DeployableApplication,
  ): Promise<Record<string, string> | undefined> {
    const warn = (line: string) =>
      this.logger.warn(`Rollback of ${fresh.appName}: ${line}`);
    const wiring = await ensureTraceWiring(
      this.db,
      this.remoteExec,
      applicationTraceOwner(fresh),
      { info: () => undefined, warn },
    );
    return wiring?.env;
  }

  /**
   * Drops the preserved image from the Server that holds it, then the row.
   *
   * **The Server is the one the snapshot names, not the one the Application
   * runs on**. This ran through `owned.serverId` — the run Server — while
   * `DeploymentEngineService.captureRollback` makes the tag on the Server that
   * *built* the Deployment, so on a build-Server install the removal failed for
   * an image that machine never had, and the retention below kept the row.
   * Beside the 409, which refuses to restore exactly those snapshots, that left
   * rows that could be neither rolled back nor deleted: one unreclaimable image
   * per Deployment, on the host chosen precisely because builds fill disks.
   * {@link preservedImageServerId} is the build-host rule itself rather than a
   * second copy of it.
   *
   * **A Server this organization no longer has is skipped, and the row goes.**
   * That case exists because of an asymmetry in one table:
   * `application.serverId` is `onDelete: 'cascade'` while `buildServerId` is
   * `onDelete: 'set null'` — the live row forgets the builder and the
   * snapshot's JSON copy of it does not — and
   * `ServersService.carriedConfiguration` deliberately keeps `buildServerId`
   * out of the refusal that would otherwise block that Server's retirement. So
   * the build arm, which is the arm this fix newly reaches, is the one that can
   * name a `server` row that is gone. Attempting the removal anyway is this
   * issue in a new shape and cannot even fail usefully:
   * `ServerConnectionProvider.getConnection` has no row to read an SSH key out
   * of, so nothing on that machine was ever this instance's to reclaim.
   *
   * **The run arm is not the mirror of that, and this paragraph was
   * corrected.** It used to read "retiring a run Server takes the Application
   * and every snapshot under it", which is what the schema says and not what
   * the product does: `ServersService.remove` has refused a Server that any
   * Application names, so `application.serverId`'s cascade is not
   * reachable through the HTTP surface at all. What destroys these rows is the
   * ordinary delete of the Application, its Environment or its Project, and
   * {@link reclaimPreservedImages} is what now reclaims the images first.
   *
   * `checkServerAccess` and not a bare existence check, because it answers the
   * second half of the same question in the same select — *still ours*.
   * `full_context` is a `json` column no foreign key constrains and the
   * rollback-snapshot leak is the proof that ids in it can name another
   * organization's rows, so without the organization predicate this method
   * would run a `docker image rm` on another organization's machine, off an id
   * no caller had to be entitled to.
   *
   * **A failed removal still keeps the row, and now says so as a 409.** The
   * row is the only record of the tag — nothing else in the database names
   * `${appName}:v${version}`, and a `docker images` listing cannot tell a
   * preserved snapshot from anything else — so dropping it on a failure leaks
   * the disk the capture guard exists to protect, silently and for ever.
   * What was wrong was the *shape* of the refusal rather than the retention:
   * `ExecError` is not an `HttpException`, so an operator got a 500 quoting a
   * remote command. A `ConflictException` on the 409's precedent instead — the
   * row is there and it is the caller's, what is wrong is the state of the
   * machine — and the three things an operator can do about it are: bring the
   * Server back, remove the image by hand, or retire the Server from
   * Cloudgate, after which the arm above applies. Rejected: deleting the row
   * regardless and logging, which trades a refusal the operator can act on for
   * a leak nobody can find.
   */
  async remove(ctx: PermissionCtx, rollbackId: string) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const owned = await this.findOwnedRollback(ctx, rollbackId);
    await this.permissions.checkServiceAccess(ctx, owned.applicationId, 'read');

    if (owned.rollback.folder) {
      await this.dropFolder(owned.applicationId, owned.rollback.folder);
    } else if (owned.rollback.image) {
      // `rollback`'s `{ ...fresh, ...snapshot }` merge, narrowed to the pair:
      // the snapshot's own answer wins where it has one — including an
      // explicit `null`, which is the platform host and not "unknown" — and a
      // row predating the columns inherits the live Application's.
      const serverId = preservedImageServerId({
        serverId: owned.serverId,
        buildServerId: owned.buildServerId,
        ...owned.rollback.fullContext,
      });
      await this.dropPreservedImage(ctx, serverId, owned.rollback.image);
    }
    const [removed] = await this.db
      .delete(rollback)
      .where(eq(rollback.rollbackId, rollbackId))
      .returning();
    return removed;
  }

  /**
   * A `static` site on AWS's point's folder half of {@link remove}:
   * removing the point removes its files, unless the distribution serves
   * them now, when the folder stays for the next Deployment's clean-up. A
   * folder that could not be deleted keeps the row, as an image that could
   * not be removed does: the row is what spares the folder and names it.
   */
  private async dropFolder(
    applicationId: string,
    folder: string,
  ): Promise<void> {
    const removal = await this.staticRollbacks().removeFolder({
      applicationId,
      folder,
    });
    if (!removal.ok) {
      throw new ConflictException(
        `Rollback point cannot be deleted: removing its files (deployments/${folder}/) from the site's bucket failed (${removal.message}), and the point is kept so the folder is not left with nothing naming it`,
      );
    }
  }

  /** The image half of {@link remove}: everything that has to happen on a
   * machine before the row may go. See that method for why each arm is what it
   * is. */
  private async dropPreservedImage(
    ctx: PermissionCtx,
    serverId: string | null,
    image: string,
  ): Promise<void> {
    // A `NotFoundException` here is the answer rather than a failure: the
    // Server is retired or was never this organization's, and either way there
    // is no image this instance can reach. `checkServerAccess` resolves an
    // absent id to `undefined` without throwing, which is the platform host.
    const reachable = await checkServerAccess(this.db, ctx, serverId).then(
      () => true,
      (error) => {
        if (error instanceof NotFoundException) return false;
        throw error;
      },
    );
    if (!reachable) return;

    try {
      // Argv. The tag was already safe rather than exploitable — it is
      // `${appName}:v${version}`, and `appName` is `APP_NAME_REGEX` at its mint
      // (`db/columns.ts`'s `cleanAppName`) — so this removes a word from review
      // rather than fixing a live injection.
      await execOnServer(this.remoteExec, serverId, [
        'docker',
        'image',
        'rm',
        image,
        '--force',
      ]);
    } catch (error) {
      if (imageAlreadyGone(error)) return;
      throw new ConflictException(
        `Rollback point cannot be deleted: removing its preserved image ${image} from the server that holds it failed, and the snapshot is kept so the image is not left on disk with nothing naming it`,
      );
    }
  }

  /**
   * Rollback snapshots for an application, newest-first — visible to
   * whoever can read the application, like deployment history.
   *
   * Each `fullContext` goes back through {@link toRollbackContext} on the way
   * out. This is a `json` column, not a DTO-shaped response, so whatever a
   * past version of `capture` wrote is what a reader gets — and the leaked rows
   * were written carrying the credential ids. Answering from the current
   * exclusion list makes the response match `RollbackContext`, which is what
   * the console's own `RollbackContext` already claims it is — the route
   * declares no response schema, so nothing else was ever going to say so.
   */
  async findAllByApplicationId(ctx: PermissionCtx, applicationId: string) {
    await this.permissions.checkServiceAccess(ctx, applicationId, 'read');
    await this.assertOwnedApplication(ctx, applicationId);
    const rows = await this.db
      .select({ rollback })
      .from(rollback)
      .innerJoin(deployment, eq(rollback.deploymentId, deployment.deploymentId))
      .where(eq(deployment.applicationId, applicationId))
      // version is the monotonic capture order; createdAt can tie within a ms.
      .orderBy(desc(rollback.version));
    return rows.map((row) => ({
      ...row.rollback,
      fullContext: row.rollback.fullContext
        ? toRollbackContext(row.rollback.fullContext)
        : row.rollback.fullContext,
    }));
  }

  /** The rollback row plus its application, org-scoped like every
   * controller-facing path (rollback → deployment → application → project). */
  private async findOwnedRollback(ctx: PermissionCtx, rollbackId: string) {
    const [found] = await this.db
      .select({
        rollback,
        applicationId: application.applicationId,
        serverId: application.serverId,
        // The live pair, which {@link remove} uses as the defaults a snapshot
        // is merged over — a row captured before these columns existed has no
        // opinion about where its image was made, and the Application's own
        // answer is the same one `rollback` falls through to.
        buildServerId: application.buildServerId,
      })
      .from(rollback)
      .innerJoin(deployment, eq(rollback.deploymentId, deployment.deploymentId))
      .innerJoin(
        application,
        eq(deployment.applicationId, application.applicationId),
      )
      .innerJoin(
        environment,
        eq(application.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(rollback.rollbackId, rollbackId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Rollback not found');
    return found;
  }

  /** Org scoping (environment → project) for controller-facing paths, the
   * same shape as DeploymentsService.findOwnedApplication. */
  private async assertOwnedApplication(
    ctx: PermissionCtx,
    applicationId: string,
  ): Promise<void> {
    const [found] = await this.db
      .select({ applicationId: application.applicationId })
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
  }
}
