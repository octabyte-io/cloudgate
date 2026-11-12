import { NotFoundException } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import { application } from '../applications/application.schema';
import { checkServerAccess } from '../common/owned-server';
import { removeImagesOn } from '../common/teardown-steps';
import type { ImageRelease, UnreclaimedImages } from '../common/teardown-steps';
import type { DrizzleDB } from '../db/drizzle.module';
import { buildHostServerId } from '../deployment-engine/build-host';
import { deployment } from '../deployments/deployment.schema';
import type { PermissionCtx } from '../rbac/permission.service';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { rollback } from './rollback.schema';

/**
 * The Server the snapshot's preserved image sits on: whichever machine ran the
 * `docker tag` in `DeploymentEngineService.captureRollback`, which is the one
 * that *built* the Deployment. `null` is the platform host, per ADR-0008.
 *
 * One function and three call sites, rather than the expression restated in
 * each (§1.4). `RollbacksService.rollback` refuses when the answer is not
 * the Server it would converge on, `RollbacksService.remove` addresses the
 * answer, and {@link listPreservedImages} addresses it in bulk for a delete
 * that is about to destroy the rows — the same question asked for three
 * purposes. It was already one rule that only one of them implemented once:
 * `remove` reached the Application's live `serverId` and so ran its
 * `docker image rm` on a machine that had never held the tag, which failed, and
 * a failed removal kept the row. Two copies of a rule that has been wrong once
 * is how it goes wrong again.
 *
 * The `||` itself is {@link buildHostServerId}, which is the same question the
 * deploy asks — *which machine built this* — and this is the third of its four
 * call sites. It was written out here as well until a fix found the two Delete
 * paths that had no copy of it at all and aimed their `rm -rf` at the run
 * Server; the rule is now stated once and the reason it is `||` rather than
 * `??` lives with it.
 *
 * The caller supplies the Application's live pair as the object's defaults and
 * spreads the snapshot over it, which is `rollback`'s `{ ...fresh, ...snapshot }`
 * in miniature and is why this takes a merged context rather than a snapshot
 * and a fallback: a snapshot that carries an explicit `serverId: null` was
 * captured on the platform host and must not be re-attributed to the Server the
 * Application has since moved to, while one predating the columns has no
 * opinion and inherits the live row's.
 *
 * Moved here from `rollbacks.service.ts`, unchanged. It is the rollback
 * module's rule, and the delete paths that now need it live in three other
 * modules — importing a service to ask it would point `applications`,
 * `projects` and `environments` at `RollbacksModule`, which already depends on
 * `ApplicationsModule`.
 */
export function preservedImageServerId(context: {
  serverId?: string | null;
  buildServerId?: string | null;
}): string | null {
  return buildHostServerId(context);
}

/**
 * {@link imageAlreadyGone} moved to `common/teardown-steps.ts` when
 * the second bulk reclamation — `applications/built-image.ts` — needed the same
 * predicate and the same removal loop. Re-exported here because
 * `RollbacksService.remove` has imported it from this file and the
 * rule is still this module's, and because its own docblock's first reason
 * (a refusal an operator has nothing left to act on) is a rollback
 * refusal rather than anything a delete does.
 */
export { imageAlreadyGone } from '../common/teardown-steps';

/** A preserved snapshot image and the machine that holds it. */
export interface PreservedImage {
  /** `capture`'s `${appName}:v${version}` tag. */
  image: string;
  /** {@link preservedImageServerId}'s answer; `null` is the platform host. */
  serverId: string | null;
}

/**
 * What a delete left on a machine, per Server, for the caller's answer.
 *
 * `common/teardown-steps.ts`'s {@link UnreclaimedImages}, renamed
 * because it stopped being about *preserved* images the moment a second
 * reclamation answered in the same response field; that type carries the
 * argument for why an image is not an `UnreclaimedArtifact` with a `kind`.
 */
export type { UnreclaimedImages } from '../common/teardown-steps';

/**
 * Every preserved image the given Applications' snapshots name, oldest first.
 *
 * `rollback.image` is the **only** record of the tag: nothing else in the
 * database names `${appName}:v${version}`, and a `docker images` listing on the
 * host cannot tell a preserved snapshot from anything else
 * (`RollbacksService.remove` states this at length). `rollback.deploymentId` and
 * `deployment.applicationId` both cascade, so this list exists exactly once —
 * in the window between a delete deciding to proceed and the row going — and
 * never again. That is the whole argument for reclaiming here rather than from
 * a maintenance screen later; ADR-0016 carries it.
 *
 * **No organization predicate, deliberately.** Every caller has already
 * resolved these `applicationId`s through its own org-scoped read and a
 * `checkServiceAccess(…, 'delete')`, so a second one here would be answering a
 * question that has been answered. The id this function *does* have to check is
 * the Server's, which {@link reclaimPreservedImages} does with
 * `checkServerAccess` for this reason: `full_context` is a plain `json`
 * column no foreign key constrains, and the rollback-snapshot leak is the proof
 * that ids in it can name another organization's rows.
 *
 * `asc(rollback.version)` rather than `createdAt`, on
 * `findAllByApplicationId`'s reasoning inverted: version is the monotonic
 * capture order and `createdAt` can tie within a millisecond. The order is not
 * cosmetic — it decides which tags a bounded report names first.
 */
export async function listPreservedImages(
  db: DrizzleDB,
  applicationIds: readonly string[],
): Promise<PreservedImage[]> {
  if (applicationIds.length === 0) return [];
  const rows = await db
    .select({
      image: rollback.image,
      fullContext: rollback.fullContext,
      serverId: application.serverId,
      buildServerId: application.buildServerId,
    })
    .from(rollback)
    .innerJoin(deployment, eq(rollback.deploymentId, deployment.deploymentId))
    .innerJoin(
      application,
      eq(deployment.applicationId, application.applicationId),
    )
    .where(inArray(deployment.applicationId, [...applicationIds]))
    .orderBy(asc(rollback.version));

  return rows.flatMap((row) =>
    row.image
      ? [
          {
            image: row.image,
            // `RollbacksService.remove`'s merge, narrowed to the pair: the
            // snapshot's own answer wins where it has one — including an
            // explicit `null`, which is the platform host and not "unknown" —
            // and a row predating the columns inherits the live Application's.
            serverId: preservedImageServerId({
              serverId: row.serverId,
              buildServerId: row.buildServerId,
              ...row.fullContext,
            }),
          },
        ]
      : [],
  );
}

/**
 * Drops the preserved images of the Applications a delete is about to destroy,
 * and answers with what it could not reclaim.
 *
 * **Why the reclamation is here and not on a maintenance screen.** The ticket
 * offered both and leaned to the screen. The screen cannot be built: its
 * predicate is *"a preserved image on this Server that no `rollback` row
 * names"*, and every row that could name one is destroyed by the same cascade
 * that creates the orphan — `application` gone takes its `deployment` rows,
 * which take their `rollback` rows. So an operator's Server no longer holds an
 * `app_name` to match against either, and all that is left to recognise an
 * orphan by is the *shape* `<word>:v<digits>`, which is not this platform's to
 * claim: an operator's own `myapp:v3` matches it, and on a host two `server`
 * rows point at (which `captureRollback`'s docblock notes is a real
 * configuration) the tag may be another organization's live rollback point,
 * whose naming row this caller cannot see. A listing that can find the orphans
 * cannot be safe, and one that is safe cannot find them. Here, all three facts
 * — the tag, the machine, and whether the machine is still this organization's
 * — are available at once. ADR-0016 carries the argument in full.
 *
 * **Where in the delete this must run: after the refusal, before the row.**
 * Both halves are load-bearing and neither is a preference.
 * `ApplicationsService.remove` and `cascadeDelete` may still refuse — a
 * workload they could not confirm gone is a 409 with the tree intact — and
 * reclaiming ahead of that would leave a live Application whose console still
 * offers Rollback on snapshots whose images have been deleted: a recoverable
 * refusal turned into silently unrestorable rollback points. Reclaiming after
 * the row is not merely late but impossible, per {@link listPreservedImages}.
 *
 * **A Server this organization no longer has is skipped entirely.** That case
 * exists because of an asymmetry in one table: `application.serverId` is
 * `onDelete: 'cascade'` while `buildServerId` is `onDelete: 'set null'`, and
 * `ServersService.carriedConfiguration` deliberately keeps the second out of
 * the refusal that would otherwise block the Server's retirement. So the build
 * arm is the only one that can name a `server` row that is gone, and attempting
 * the removal cannot even fail usefully:
 * `ServerConnectionProvider.getConnection` has no row to read an SSH key out
 * of, so nothing on that machine was ever this instance's to reclaim.
 * `checkServerAccess` and not a bare existence check, because it answers the
 * second half of the same question in the same select — *still ours* — and
 * without the organization predicate this would run a `docker image rm` on
 * another organization's machine off an id no caller had to be entitled to.
 *
 * **How the tags are actually removed is `common/teardown-steps.ts`'s
 * {@link removeImagesOn}, not this function's.** One command per
 * tag, `--force`, the first real failure ending that machine's turn and
 * reporting the tags not yet attempted, {@link imageAlreadyGone} read as the
 * outcome this wanted, and nothing thrown — every one of those was decided
 * here and is now stated in one place, because
 * `applications/built-image.ts` reclaims a second image off the same machines
 * with the same semantics and a second copy of this loop is how the two would
 * come to disagree. What stays here is what is genuinely this reclamation's:
 * where the tags come from, and the `checkServerAccess` above that no
 * FK-derived id needs.
 *
 * **Nothing here throws, and a leftover image never blocks a delete.** The
 * rollback `remove` refuses on a failed removal because the row survives to keep
 * recording the tag; here the row is a child of the thing being destroyed and
 * cannot survive, so the choice is between naming the leak and making *forget
 * this Application* impossible on a machine that is down. That shape is already
 * settled — "a dead server must not make deletion impossible", answered with a
 * truthful response rather than a bare 200 — and a leftover image is disk rather
 * than ADR-0008's unmanaged container, which is the property `force` exists to
 * guard.
 */
export async function reclaimPreservedImages(
  db: DrizzleDB,
  remoteExec: RemoteExecService,
  ctx: PermissionCtx,
  applicationIds: readonly string[],
  release: ImageRelease,
): Promise<UnreclaimedImages[]> {
  const preserved = await listPreservedImages(db, applicationIds);
  if (preserved.length === 0) return [];

  // Grouped so `checkServerAccess` is one select per machine rather than one
  // per tag; insertion order is the version order `listPreservedImages` read.
  const byServer = new Map<string | null, string[]>();
  for (const { serverId, image } of preserved) {
    const images = byServer.get(serverId);
    if (images) images.push(image);
    else byServer.set(serverId, [image]);
  }

  const unreclaimed: UnreclaimedImages[] = [];
  for (const [serverId, images] of byServer) {
    // A `NotFoundException` here is the answer rather than a failure, and is
    // not reported: the Server is retired or was never this organization's, so
    // there is no image this instance can reach and nothing an operator of it
    // could act on. `checkServerAccess` resolves an absent id to `undefined`
    // without throwing, which is the platform host (ADR-0008).
    const reachable = await checkServerAccess(db, ctx, serverId).then(
      () => true,
      (error) => {
        if (error instanceof NotFoundException) return false;
        throw error;
      },
    );
    if (!reachable) continue;

    // Argv, the same four words `RollbacksService.remove` sends. The tag
    // is `${appName}:v${version}` and `appName` is `APP_NAME_REGEX` at its mint
    // (`db/columns.ts`'s `cleanAppName`), so the argv removes a word from review
    // rather than fixing a live injection.
    unreclaimed.push(
      ...(await removeImagesOn(remoteExec, serverId, images, release)),
    );
  }
  return unreclaimed;
}
