import { groupByBuildHost, removeImagesOn } from '../common/teardown-steps';
import type {
  BuildHostArtifactOwner,
  ImageRelease,
  UnreclaimedImages,
} from '../common/teardown-steps';
import type { SourceType } from '../git-providers/git-provider.schema';
import type { RemoteExecService } from '../remote/remote-exec.service';

/**
 * The image a build leaves on the build host, and the delete that reclaims it
 * (ADR-0016's third non-goal, and ADR-0018's).
 *
 * **What was leaking.** Every successful build of a non-docker Application tags
 * `${appName}:latest` on its build host, and nothing in the product ever
 * removed it: `grep 'docker image rm\|docker rmi'` across `src` hit exactly one
 * file, `rollbacks.service.ts`, so the only sweep was `docker image prune --all`
 * from Settings → Maintenance — machine-wide, destructive, and something an
 * operator has to think to run on a Server they have to name. One image per
 * Application, on the machine chosen precisely because builds fill a disk, kept
 * for ever under a name no row referred to any more.
 *
 * **Why the delete rather than a maintenance screen, and why the answer is not
 * ADR-0016's.** ADR-0016 rejected a screen for the preserved tag because the
 * predicate *"a tag on this Server that no `rollback` row names"* consults rows
 * the cascade has already destroyed, leaving only the shape `<word>:v<digits>`
 * to recognise an orphan by — which this platform may not claim. None of that
 * applies here: `${appName}:latest` has **no naming row at all**, so a screen
 * would have nothing to consult even before the delete, and `<word>:latest` is
 * the single most common shape of tag on any Docker host — an operator's own
 * `myapp:latest`, every `postgres:latest` they ever pulled. So the reasoning
 * arrives at the same place from the opposite direction: the tag is derivable
 * from `appName` *while the Application exists* and unrecognisable one second
 * later, which makes the delete the only moment it can be named at all.
 *
 * **The buildkit cache beside it is deliberately not reclaimed, and that is a
 * measured finding rather than a deferral.** A BuildKit cache record carries no
 * image, tag or repository field, so it cannot be attributed to an Application.
 * Measured against Docker 29.3.1: `docker buildx du --verbose` prints a
 * record's complete field set — id, created-at, mutable, reclaimable, shared,
 * size, description, usage count, last-used, type — with no name of any output
 * on it; and `--filter` (the same filter parsing `docker builder prune` takes)
 * selects on `id`, `parents`, `description`, `type`, `until`, `unused-for` and
 * the `inuse`/`shared`/`private` booleans, while `ref=`, `image=`,
 * `repository=` and `label=` match nothing at all. `description` is free text
 * about the build *step* (`local source for dockerfile`), not the output tag, so
 * a `description~=${appName}` filter would be both incomplete — most records'
 * descriptions never mention it — and unsafe, since an operator's own step
 * whose description happens to contain the string would match. A machine-wide
 * `docker builder prune` fired by one Application's delete would be a worse
 * defect than the leak, so this reclaims the image and says so. `railpack` is
 * the one builder that does not leak a cache at all: it creates a
 * `docker-container` buildx builder per build and `docker buildx rm`s it on
 * every exit path without `--keep-state`, so its cache goes with it
 * (`builders/strategies/railpack.strategy.ts`). What is left is the daemon's own
 * shared cache under `dockerfile`/`static`, whose honest reclamation surface is
 * the machine-wide one that already exists — `CleanupService.cleanupBuilders`.
 */

/**
 * The columns of an Application this reclamation needs: which tag its build
 * produced, if any, and which machine produced it.
 *
 * **The one of the four build-host reclamations that needs a fourth column, and
 * that is why it kept a name of its own**. The other three want nothing
 * but `common/teardown-steps.ts`' {@link BuildHostArtifactOwner} — the `appName`
 * that names the artifact and the two ids `buildHostServerId` resolves — and
 * their three identical declarations were collapsed into it. This one asks a
 * *safety* question about the row on top of the *which machine* one:
 * {@link builtImageTag} must answer `null` for `sourceType: 'docker'`, because
 * that arm's image is the operator's own pulled `dockerImage` column.
 *
 * So `sourceType` is required and not `SourceType | null`, which is the one
 * place these reclamations' input types are not interchangeable and is load
 * bearing: `common/service-cascade.ts`' `CascadeChild` carries `sourceType:
 * SourceType | null` and therefore *cannot* satisfy this type, which is why
 * `builtImageOwnersOf` has to drop a child whose `sourceType` has gone rather
 * than project it the way `buildHostArtifactOwnersOf` projects the other three.
 * A guess there deletes somebody's `postgres:17`.
 */
export interface BuiltImageOwner extends BuildHostArtifactOwner {
  sourceType: SourceType;
}

/**
 * The tag this Application's build leaves on its build host, or `null` when it
 * builds nothing.
 *
 * **The docker arm is the point of this function.**
 * `DeploymentEngineService.builtImageName` is the same dispatch on the writing
 * side, and for `sourceType: 'docker'` it answers the `dockerImage` column
 * verbatim — an image the platform *pulled* rather than produced. Reclaiming
 * that would delete an operator's own `postgres:17` off their machine, possibly
 * one every other Application on the host is running, on the strength of one
 * Application's delete. So this reclamation only ever names an image the
 * platform made, and the docker arm names none.
 *
 * `${appName}:latest` and not the Registry tag: `getRegistryTag` is a push into
 * somebody else's registry, and deleting from a registry is neither this
 * delete's business nor reachable with `docker image rm`. The four builders
 * that produce the local tag all produce this one —
 * `dockerfileStrategy`'s `docker build -t ${appName}`, `railpackStrategy`'s
 * `--output type=docker,name=${appName}`, and the `nixpacks`/`pack` arms'
 * `--name ${appName}` — because Docker reads a bare repository as `:latest`,
 * which is also why `builtImageName` writes the tag out.
 *
 * A derivation of the same rule rather than a call into the engine: the engine's
 * is `private`, and a plain function here keeps `applications` and `common` off
 * `DeploymentEngineModule` — `buildHostServerId`'s and
 * `common/service-cascade.ts`' precedent.
 *
 * **What holds the two together, and what used to be claimed instead**.
 * This said the docker arm being "pinned by name" in the specs was why the two
 * cannot drift, and a pin is not that: `built-image.spec.ts` asserted this
 * function against `'web-app:latest'` and `deployment-engine.service.spec.ts`
 * asserted the engine's against its own literal, with nothing relating them, so
 * both stayed green under a change to either. The relation is now asserted
 * where both dispatches reach the wire at once —
 * `test/applications/application-delete-machines.e2e-spec.ts`' *reclaims the
 * image the deploy itself named*, which reads `builtImageName`'s answer off the
 * deploy's own `docker tag` step and requires the delete to name that exact
 * string, the way `source-tree-roots.e2e-spec.ts` takes a removal's expectation
 * from the clone's dispatch. The two literal pins stay: they are what says
 * *which* tag is right, where the cross-assertion only says the two agree.
 */
export function builtImageTag(owner: {
  appName: string;
  sourceType: SourceType;
}): string | null {
  return owner.sourceType === 'docker' ? null : `${owner.appName}:latest`;
}

/**
 * Drops the built images of the Applications a delete is about to destroy, and
 * answers with the ones it could not.
 *
 * **Where in the delete this runs: after the refusal, before the rows** —
 * ADR-0016's slot, for its reason and for one of this artifact's own. The
 * refusal half is sharper here than for any artifact so far: `${appName}:latest`
 * is the image the Swarm service *is running*, so reclaiming it ahead of a 409
 * would untag the live image of an Application the caller is then told still
 * exists, and a node that had not yet pulled it would fail to schedule a task
 * for a workload nobody had asked to change. The rows half is the whole
 * argument above: `appName` is the only thing that names this tag.
 *
 * **No `checkServerAccess`, and that is a difference from
 * `reclaimPreservedImages` rather than an omission.** That one gates every
 * machine it reaches because its ids come out of `rollback.full_context`, a
 * plain `json` column no foreign key constrains whose ids were proved able to name
 * another organization's rows. These ids are `application.serverId` and
 * `application.buildServerId`, real foreign keys into `server`, authorized by
 * `checkServerAccess` on the only paths that write them, and `buildServerId`'s
 * `onDelete: 'set null'` means neither can dangle — which is exactly the
 * distinction ADR-0018 draws for the two ids its teardown steps already exec
 * against. Gating these two and not the run Server the same delete has been
 * execing against all along would be a second rule for the same column rather
 * than consistency.
 *
 * **Machines in first-seen order, one turn each**, so the removal loop's
 * stop-at-the-first-real-failure rule bounds a Project delete by machine count
 * rather than by Application count — see {@link removeImagesOn}, which owns
 * every clause of that and is shared with the preserved-tag reclamation rather
 * than restated here (§1.4). The grouping that feeds it is shared too:
 * `common/teardown-steps.ts`' `groupByBuildHost`, once written here and in
 * `build-leftovers.ts` alike.
 *
 * **What sharing the grouping does not share is the turn, and here that is the
 * whole of the difference.** `reclaimBuildLeftovers` groups by the same rule
 * and then goes on asking the next machine after one has failed, because a
 * failure there is one round trip rather than one per artifact and it reports
 * nothing at all. This one stops asking a machine at the first real failure and
 * answers in {@link UnreclaimedImages}. `groupByBuildHost` performs no I/O, so
 * neither contract can reach the other through it; the loop below is this one's,
 * in full.
 *
 * A plain function taking its collaborator rather than a provider, on
 * `rollbacks/preserved-images.ts`' and `patch/patch-repo-clone.ts`' precedent:
 * four modules' deletes need it, and a provider would point `applications`,
 * `common`, `projects` and `environments` at each other for what is one tag and
 * one shell word.
 */
export async function reclaimBuiltImages(
  remoteExec: RemoteExecService,
  owners: readonly BuiltImageOwner[],
  release: ImageRelease,
): Promise<UnreclaimedImages[]> {
  // Grouped so one build host is one turn; insertion order is the caller's,
  // which for a cascade is `listCascadeChildren`' order. A docker-sourced
  // Application names no tag, so `builtImageTag`'s `null` contributes no word
  // and — if it is the only owner on its machine — no turn either.
  const byBuildHost = groupByBuildHost<BuiltImageOwner>(owners, builtImageTag);

  // One turn per machine, each ended by its first real failure: this
  // reclamation's own contract, owned by `removeImagesOn` and deliberately not
  // by `groupByBuildHost`.
  const unreclaimed: UnreclaimedImages[] = [];
  for (const [serverId, images] of byBuildHost) {
    unreclaimed.push(
      ...(await removeImagesOn(remoteExec, serverId, images, release)),
    );
  }
  return unreclaimed;
}
