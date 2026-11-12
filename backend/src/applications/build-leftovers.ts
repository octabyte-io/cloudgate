import { buildLeftoverReclamation } from '../builders/build-leftovers';
import { groupByBuildHost } from '../common/teardown-steps';
import type { BuildHostArtifactOwner } from '../common/teardown-steps';
import { execOnServer } from '../remote/exec-dispatch';
import type { RemoteExecService } from '../remote/remote-exec.service';

/**
 * The artifacts a *killed* build left on the build host, and the delete that
 * reclaims them (ADR-0016's post-refusal slot, the delete-time half of the
 * next-build reclaim).
 *
 * **What was leaking, and what the next-build reclaim left open.** `railpackStrategy` removes its
 * per-build buildx builder on both failure branches and at the end, and
 * `nixpacksStrategy`'s `publishDirectory` branch removes its copy-out container
 * on the failure branch and at the end — so for both, the one path where
 * nothing removes the artifact is the path where **no branch runs**: a
 * `SIGKILL`, a dropped SSH channel, a cancelled Deployment. `09cbf5f` and
 * its follow-up answer that in the *next* build of the same Application, which
 * the queue makes exact (`getGroup` returns `application:<id>` and
 * `InMemoryQueue` admits one job per group). That **bounds** each leak at one
 * leftover per Application rather than closing it: an Application that never
 * builds again keeps its leftover — a buildkit container plus its state volume,
 * or a `Created` container holding a writable layer — under a name no row
 * records, for ever. This is the half that closes it.
 *
 * **Why this slot: after the presence refusal, before the rows.** The rows half
 * is ADR-0016's own argument at its plainest — `appName` is the only thing that
 * names either artifact, and one statement later it does not exist. The refusal
 * half is *not* the sharp version `reclaimBuiltImages` has (that tag is the
 * image the Swarm service is running), and it is not merely conventional
 * either: what the sweeps match is a *pattern*, so a build genuinely in flight
 * would have its live builder and its live copy-out container removed
 * underneath it. Running after the refusal keeps that impossible for a **kept**
 * Application, which is the one outcome where a live build still matters. For a
 * delete that proceeds it is moot, and deliberately so: the same delete has
 * already `rm -rf`'d the source tree the build is reading and `docker image
 * rm --force`'d the tag it is writing, so a delete is already incompatible with
 * an in-flight build and this adds no hazard of its own. That is why the queue
 * premise the next-build reclaim leans on is not needed here and is not claimed.
 *
 * **Why it reports nothing, which is a question `built-image.ts` answered the
 * other way.** `UnreclaimedArtifact` states two criteria for earning a
 * `kind`: is the thing a path, and does something break differently from the
 * entries already there.
 *
 * - **It is not a path.** A buildx builder name and a container name are
 *   neither paths nor image references. That type's field was renamed from
 *   `directory` to `path` precisely so that no entry would sit in a field named
 *   for something it is not, and a fourth `kind` was declined for
 *   `web-app:latest` on exactly this ground. `railpack-web-app-<nonce>` fails
 *   it the same way. Nor can it borrow `unreclaimedImages`, which `built-image.ts` *could*:
 *   that field holds image references, and neither of these is one.
 * - **And there is no artifact to name even in principle.** This is the
 *   decisive half, and it is a difference in *mechanism* rather than a judgement
 *   about severity. Every entry in both existing fields names an artifact the
 *   delete knows exists: `TeardownStep.leftBehindOnFailure` works because
 *   `rm -rf` exits 0 for a path that is not there, so a non-zero exit already
 *   means *this exists and I could not remove it*; `removeImagesOn` works
 *   because it names one tag per command and reads the daemon's own *no such
 *   image*. A **sweep** has neither property: it exits 0 whether it matched
 *   nothing or everything, and a failed exec means *the sweep did not run* —
 *   which is not the same claim as *this was left behind*. An entry carrying no
 *   artifact name is the field-named-for-nothing that rename refused to write, and
 *   reporting one on every unreachable build host would turn these fields back
 *   into *"this route can leak"* from *"these were left behind"*, which is the
 *   property the whole family exists to keep.
 *
 * What stops that being a hole is that the failure modes are **correlated by
 * construction**: this sweep goes to the build host, and every other build-host
 * reclamation the same delete performs already reports on that same machine
 * when it cannot be reached — the source-tree `rm -rf`
 * (`kind: 'source-tree'`), the patch-repo clone (`kind: 'patch-repo'`) and
 * `${appName}:latest` (`unreclaimedImages`). So an operator reading the answer
 * is already told *this build host could not be reached and things were left on
 * it*; a fourth entry naming nothing adds no action. And in the one case where
 * the transport is fine but the daemon refuses, there is nothing to sweep
 * either: an Application with no build has no leftover.
 *
 * **Rejected: enumerate first, then remove exactly, so the report could name
 * names.** `docker ps -a --format '{{.Names}}'` and `docker buildx ls` could be
 * read back into this process, filtered by the length rule in TypeScript, and
 * removed one exact name at a time in `removeImagesOn`'s shape. That buys a
 * report only in the narrow case where the *listing* succeeds and a *removal*
 * fails — which is precisely the pattern-collision case where a running
 * container of an operator's own is refused on purpose (see
 * `builders/strategies/nixpacks.strategy.ts`'s
 * `leftoverNixpacksContainerReclamation` on the absent `--force`), so the
 * one thing it would newly report is a thing that is not a leak. It costs a
 * second round trip per build host on **every** delete, and reading a teardown's
 * stdout is the shape `TeardownStep`'s docblock rejects outright, because the
 * loop cannot type what comes back.
 *
 * **What this does not reach, and where that half lives.** Every sweep
 * these deletes send names an *Application's* `appName`, and a **preview's**
 * build leaves `railpack-{preview.appName}-{nonce}` under a name of its own:
 * `deployPreview` spreads the parent's row over `{ appName: preview.appName }`,
 * and `buildLeftoverReclamation`'s pattern is a prefix plus the nonce's exact
 * width, so the parent's sweep can never match it. It is not a filter to widen
 * — a preview is not a `CascadeChild` at all (ADR-0018) — so the preview's
 * sweep is a third step of `preview-deployments/preview-teardown.ts`'
 * `previewTeardownSteps`, which is the only place all four preview delete paths
 * meet, the closed-pull-request webhook and `DELETE /preview-deployments/:id`
 * included. Two lanes, one program, because the program is the half that has
 * been wrong once.
 *
 * A plain function taking its collaborator rather than a provider, on
 * `built-image.ts`', `rollbacks/preserved-images.ts`' and
 * `patch/patch-repo-clone.ts`' precedent: three deletes need it, and a provider
 * would point `applications`, `common`, `projects` and `environments` at each
 * other for one shell program.
 */

/**
 * Sweeps each build host once for the leftovers of every Application on it that
 * this delete is about to make unnameable, and answers nothing.
 *
 * `void` and not an array, which is the whole of the reporting decision above
 * stated in the signature: there is no claim this could return. Nothing throws,
 * on `reclaimPreservedImages`' two reasons — a leftover is disk rather than
 * ADR-0008's unmanaged container, and *forget this Application* must stay
 * completable while a machine is down.
 *
 * **Machines in first-seen order, one turn each**, so a Project delete costs one
 * round trip per build host rather than one per Application. That grouping was
 * written here and in `built-image.ts` alike and is now
 * `common/teardown-steps.ts`' `groupByBuildHost`, which carries every clause of
 * it (§1.4).
 *
 * **The turn itself stays here, and that is the difference from
 * `reclaimBuiltImages` rather than a leftover of the extraction.** That one
 * hands each machine's list to `removeImagesOn`, which stops at the first
 * failure that is not `imageAlreadyGone`, because an unreachable Server there
 * must not multiply an SSH connect timeout by an Application's tag count. There
 * is no such rule to apply here and none is needed: a failure here is one round
 * trip rather than one per artifact, so there is nothing to multiply, and a
 * machine that failed does not stop the next machine being asked. `groupByBuildHost`
 * deliberately does not perform the turn, so neither reclamation can acquire
 * the other's failure semantics by sharing the grouping — the loop below is the
 * contract, in full, next to the `void` it answers with.
 *
 * No `checkServerAccess`, which is `reclaimBuiltImages`' stated difference from
 * `reclaimPreservedImages` rather than an omission: these two ids are
 * `application.serverId` and `application.buildServerId`, real foreign keys into
 * `server` authorized on the only paths that write them, not ids out of
 * `rollback.full_context`.
 */
export async function reclaimBuildLeftovers(
  remoteExec: RemoteExecService,
  owners: readonly BuildHostArtifactOwner[],
): Promise<void> {
  // This mapper never answers `null`, which is the one of `groupByBuildHost`'s
  // three clauses this caller does not use: `builtImageTag` withholds a name
  // for a docker-sourced Application because that arm's image is the
  // operator's own, and no such safety question arises here — both leftover
  // names are platform-made. Nor may the sweep be conditioned on the row
  // anyway: `sourceType`, `buildType` and `publishDirectory` are all `PATCH`
  // columns, so an Application that built with railpack yesterday and is
  // `docker`-sourced today still has yesterday's leftover.
  const byBuildHost = groupByBuildHost(owners, (owner) =>
    buildLeftoverReclamation(owner.appName),
  );

  // One turn per machine, and every machine is asked even after one has failed:
  // this reclamation's own contract, not `groupByBuildHost`'s and not
  // `removeImagesOn`'s.
  for (const [serverId, programs] of byBuildHost) {
    try {
      await execOnServer(remoteExec, serverId, programs.join('\n'));
    } catch {
      // Best-effort and unreported, for the reasons this module's header
      // argues: a sweep that did not run is not an artifact that was left, and
      // every other build-host reclamation in this same delete already names
      // this machine when it is the machine that is unreachable.
    }
  }
}
