/**
 * The best-effort teardown loop, and the artifacts whose failure nothing else
 * can see.
 *
 * Three deletes ran the identical loop — `ApplicationsService.remove`,
 * `common/service-cascade.ts`'s `tearDownCascadeChildren` and
 * `PreviewDeploymentsService.teardown` — each over an array of thunks, each
 * with its own `try`/`catch` and its own copy of the comment saying why the
 * `catch` is empty: *a missing service must not strand the directory, and what
 * is left is decided by the presence read rather than by which step threw*.
 * That reasoning is right about two of the three steps and was wrong
 * about the third, which is why the loop is here now rather than written a
 * fourth time (§1.4).
 *
 * **What the presence read cannot see.** The read is
 * `applicationServicePresence` on the *run* Server and it asks the daemon about
 * one Swarm service. So it answers for the `docker service rm` — a failed
 * removal shows up as `'present'` and is reported as an `OrphanedWorkload` — and
 * it answers for nothing else. The `rm -rf` of the source tree is on the
 * **build host**, is the only thing in the product that removes that tree, and
 * a failure of it (an unreachable builder, a permission the SSH user does not
 * have, a busy mount) was caught, discarded, and appeared in no report at all.
 * The delete then answered `200` having leaked a directory it knew it had not
 * removed, which is precisely what *"say what you leave behind"* forbids
 * and what ADR-0018's *"every row it destroys is asked what it left behind"*
 * claims does not happen.
 *
 * **Why reporting rather than refusing, and why not a presence probe for the
 * directory.** Refusing was settled twice already and the answers both apply
 * here: a leftover directory is disk rather than ADR-0008's unmanaged
 * container (`reclaimPreservedImages`' reason for not gating on `?force=true`),
 * and *forget this Application* must stay completable when a machine is down.
 * A probe — `test -d`, the shape `presenceProbeCommand` takes for a
 * workload — was rejected because the exec layer already answers: `rm -rf`
 * exits **0** for a path that is not there, so a non-zero exit or a rejected
 * transport is exactly *"this directory may still exist and I could not remove
 * it"* and nothing else. A healthy delete therefore reports nothing without
 * anyone asking a second question, which is what keeps the new field meaning
 * "these were left behind" instead of "this route can leak directories".
 *
 * **The third machine step answers for itself too.** The Traefik
 * dynamic-config removal has the identical shape — an idempotent `rm -f` on the
 * run Server, covered by no presence read — and a failure of it leaves a public
 * hostname routed at nothing. It was filed rather than folded in because
 * the field it added was called `unreclaimedDirectories` and that artifact is a
 * *file*, so one field would have ended up named for neither. That is settled
 * below by fixing the *name* rather than by adding a second field: see
 * {@link UnreclaimedArtifact}. So all three of an Application's machine steps
 * now say what they left, and ADR-0018's open item is closed.
 *
 * **A fourth artifact answers here too, and it is the one that is
 * not a step.** The `files` half of `{root}/applications/{appName}` is written
 * and bind-mounted on the **run** Server while all three of those `rm -rf`s
 * name the build host, so an install with a dedicated build Server never
 * reclaimed it at all. {@link reclaimFileMounts} is that removal, and it sits
 * in ADR-0016's post-refusal slot rather than in the step array for the reason
 * it gives: nothing re-materializes a file mount, so this is the one of the
 * four whose early removal would break an Application the caller is then told
 * still exists.
 *
 * **The images a delete reclaims are here too, and they are
 * deliberately not {@link UnreclaimedArtifact}s.** Two reclamations now issue
 * `docker image rm` — the preserved rollback tag (`rollbacks/preserved-images.ts`)
 * and the `${appName}:latest` a build leaves on the build host
 * (`applications/built-image.ts`) — and both answer in
 * {@link UnreclaimedImages}, which the response has carried as
 * `unreclaimedImages`. See that type for why an image is not an
 * artifact with a `kind`, and {@link removeImagesOn} for the one removal loop
 * they share.
 *
 * **And the reclamations' *input* shape is here too, beside their
 * output shapes.** Four deletes now ask the same question of an Application —
 * *which build host holds the artifact named after this `appName`* — and the
 * first answers were three separately declared interfaces and two
 * copies of one grouping loop. Both are now one: {@link BuildHostArtifactOwner}
 * and {@link groupByBuildHost}. The grouping is deliberately the *pure* half
 * only; the per-machine turn stays at each call site, because the two
 * reclamations that group have two failure contracts and two reporting
 * contracts and neither may inherit the other's.
 */

import { buildHostServerId } from '../deployment-engine/build-host';
import {
  deploymentLogsDirectoryOn,
  fileMountsDirectoryOnRunServer,
} from '../deployment-engine/deployment-engine.paths';
import { systemSettleClock } from '../compose/compose.utils';
import type { SettleClock } from '../compose/compose.utils';
import { execOnServer } from '../remote/exec-dispatch';
import type { RemoteExecService } from '../remote/remote-exec.service';
import type { OrphanedWorkload } from './workload-presence';

/**
 * Which artifact an {@link UnreclaimedArtifact} is about.
 *
 * **The discriminant names the artifact, not the filesystem shape, and that is
 * the decision this type had to make** (ADR-0018's open item). Two arms are trees
 * and one is a file, so `'file' | 'directory'` would be a taxonomy the operator
 * can already read off the path while telling them nothing they need: what
 * differs between these is *what breaks*. A `'source-tree'` left on a builder
 * is disk. A `'patch-repo'` is disk and a cache `ensureRepo` would rebuild. A
 * `'traefik-config'` is a live router fragment on the run Server, so a public
 * hostname keeps being advertised and answers 404 at the edge — the one entry
 * here an operator has to act on *now*, and the reason the delete's answer has
 * to distinguish them at all.
 *
 * **`'file-mounts'` is the fourth arm, and it is the first candidate since
 * the `kind` arrived to clear both of this type's criteria**. Two were refused on
 * them: `${appName}:latest` failed the first — an image reference is not
 * a *path on a machine* — and the build-leftover sweep failed both, a buildx
 * builder name being neither a path nor an artifact a sweep can name at all.
 * This one is a directory `rm -rf` on a named Server, so the first criterion is
 * not close. The second is the one worth stating, because *"another tree on
 * another machine"* is exactly the argument that would make it a
 * `'source-tree'` and it is wrong twice.
 *
 * What differs is **what is inside it and therefore what the operator's next
 * move is.** The three arms above hold platform-generated content: a
 * `'source-tree'` and a `'patch-repo'` are clones the next `ensureRepo` or the
 * next build would rewrite, and a `'traefik-config'` is regenerated by the next
 * deploy. Each is `rm -rf`-able without a thought. This tree holds the bodies
 * of the operator's own **file mounts** — `mount.content`, which ADR-0015
 * encrypts at rest precisely because *"a file body is where an operator puts a
 * credential"* — materialized in plaintext by `MountsService`, and nothing in
 * the product rewrites one: `writeFileMount` has exactly two callers,
 * `MountsService.create` and `.update`, so a deploy does not re-materialize it.
 * `mount.applicationId` is `onDelete: 'cascade'`, so by the time an operator
 * reads this entry the encrypted rows are gone and the leftover directory is
 * the **last copy in existence** of what they wrote. *"Read it before you
 * remove it"* is a different follow-up from *"remove it"*, which is what the
 * `kind` is for.
 *
 * And reusing `'source-tree'` would put two entries with the same `kind` and
 * the same `appName` on two different machines in one report, told apart only
 * by a consumer parsing `/files` off the end of the path — the state the
 * discriminant was introduced to avoid, restated one directory along. It would
 * also be false: no source is in it.
 *
 * **`'deployment-logs'` is the fifth**: `{logs}/{appName}` on the
 * machine that wrote an owner's deployment logs. A path on a machine, so the
 * first criterion holds; and what is inside differs from every arm above —
 * it is neither a clone something rewrites nor the operator's own input, but
 * the only record of what every build or run printed, which nothing
 * regenerates and which, once the Deployment rows have cascaded, no screen can
 * open any more. `ADR-0020`'s nightly sweep still reaches it after the
 * retention window, which is why the console calls it safe to remove.
 *
 * **`'network'` is the sixth, and the first that is not a path**: the
 * Docker network a Compose stack's **Network isolation** creates, named
 * `appName`, on the stack's own Server. It fails the first criterion as the built
 * image reference did, and it is here anyway because the reason that refusal
 * gave — images already have `unreclaimedImages` — has no equivalent: a
 * network is one name on one Server for one `appName`, the exact triple this
 * type carries, and a third top-level field for a single optional name would
 * be the per-artifact split this type argues against. So for this kind `path` holds
 * the network's name, which is what an operator passes to `docker network rm`.
 * What is inside it differs from every arm above too: nothing — the delete got
 * as far as detaching Traefik and taking the stack down, and only the removal
 * of the now-empty network did not happen.
 *
 * **`'volume'` is the seventh, and the first a delete leaves on purpose**
 * a Docker volume an Application Delete was asked to remove with
 * `?deleteVolumes=true` and kept — `path` holds the volume's name, `network`'s
 * precedent, and {@link UnreclaimedArtifact.reason} says why. It is the one
 * kind that is the operator's *data* rather than something Cloudgate made, and
 * the one whose report line can mean *"removing it would have destroyed another
 * Service's data"*, so the why is not optional for it the way it is for the
 * idempotent removals above (`applications/application-volumes.ts`).
 *
 * **`'trace-store'` is the eighth**: a Service's Trace store on its run
 * Server — its container, whose name is in `path` as `network`'s is, or its
 * directory, whose path is (`traces/trace-store.ts`). One kind for both
 * because they are one artifact to the operator, the traces this Service sent,
 * and the path tells the two apart.
 *
 * **`'compose-directory'` is the ninth**: a Compose stack's project
 * directory on its one Server, reported once its `rm -rf` left the teardown
 * program for a step of its own (`compose/compose-directory.ts`). Not a
 * `'source-tree'`, for `'file-mounts'`' reason: beside the stack's clone it
 * holds the stack's file mounts (`files/`) and its Trace store's data
 * (`traces/`), and nothing regenerates either — so *"the build's checkout,
 * safe to remove"* would be false about it. It has no separate `'file-mounts'`
 * entry, because its `files/` is inside it on the same Server.
 */
export type UnreclaimedArtifactKind =
  | 'source-tree'
  | 'compose-directory'
  | 'traefik-config'
  | 'patch-repo'
  | 'file-mounts'
  | 'deployment-logs'
  | 'network'
  | 'volume'
  | 'trace-store';

/**
 * A path on a machine that a delete could not confirm it removed, for the
 * caller's answer.
 *
 * `appName` because that is the only name any of these artifacts has — the
 * parent Application's own, or a preview's `preview-…` one — and the row is
 * gone from the database by the time an operator reads this, so the response is
 * the last place the triple (kind, machine, path) exists. Flat, like
 * `workload-presence.ts`'s `OrphanedWorkload`, rather than grouped by Server
 * the way `unreclaimedImages` is: that one groups because its reclamation
 * iterates per machine and pays one `checkServerAccess` for each, and there is
 * no such loop here — one path belongs to one `appName` on one host.
 *
 * **One field with a `kind` rather than one field per artifact, and that
 * stopped being a close call.** This was `UnreclaimedDirectory`
 * `{ appName, serverId, directory }` for exactly one artifact, the source tree
 * the Traefik config and the patch-repo clone joined it in the same
 * ticket. A second field for the file — `unreclaimedConfigs` beside
 * `unreclaimedDirectories` — splits on the one property that does not matter
 * and does not even separate the three: the patch-repo clone is a tree, so it
 * would land in `unreclaimedDirectories` beside the source tree,
 * indistinguishable from it unless a consumer parses
 * `{applications,patch-repos}/…` out of the path. So a discriminant was needed
 * either way, and once there is one, splitting the array by filesystem shape as
 * well is a second taxonomy that answers a question nobody asked. The
 * mechanism is also one — {@link TeardownStep.leftBehindOnFailure}, an
 * idempotent removal whose non-zero exit already means *may still exist* — so
 * one mechanism keeps one array, {@link TeardownReport} stays two fields, and
 * each of the three deletes keeps one merge point instead of one per artifact.
 *
 * `path` rather than `directory` for the same reason `kind` exists: three of
 * the four are trees and one is a file, and `directory` holding
 * `…/traefik/dynamic/web-app.yml` would be the field named for neither that
 * was declined.
 */
export interface UnreclaimedArtifact {
  kind: UnreclaimedArtifactKind;
  appName: string;
  /**
   * The machine that still holds it — the **build host** for a source tree or a
   * patch-repo clone, the **run** Server for a Traefik config or a file-mounts
   * tree. `null` is the platform host (ADR-0008).
   *
   * The two answers can be two machines for one `appName` in one report, which
   * is the shape ADR-0018 is about rather than a duplicate: `{root}/applications/{appName}`
   * spans both hosts, its `code` half on the builder and its `files` half on
   * the runner (`deployment-engine.paths.ts`).
   */
  serverId: string | null;
  path: string;
  /**
   * Why it was left, when the kind alone does not say. Set on every
   * `'volume'` entry — kept because another Service uses it (and which), its
   * Volume lock was held, or `docker volume rm` failed with this line — and
   * absent on the others, whose only reason is *"the removal failed"*.
   */
  reason?: string;
}

/**
 * One machine step of a teardown, and what it leaves behind if it fails.
 *
 * An object rather than the bare thunk this was, so that the step which knows
 * what it is removing is the thing that says so, rather than the loop guessing
 * from a return value it cannot type: the compose arm's step resolves to the
 * teardown command's stdout, so *"a truthy answer is a leak"* would report a
 * banner as a directory. `leftBehindOnFailure` is absent on every step the
 * presence read already answers for, which is the whole of the distinction.
 */
export interface TeardownStep {
  run: () => Promise<unknown>;
  /**
   * What this step leaves on its machine when `run` throws. Set only where this
   * step is the *only* thing that removes the artifact and no presence read
   * covers it — the source-tree `rm -rf` and the patch-repo clone's on the
   * build host, and the Traefik config's `rm -f` and the file-mounts tree's
   * `rm -rf` on the run Server. The
   * `docker service rm` and the compose teardown carry none, because
   * `applicationServicePresence` and `readComposeWorkloadPresence` answer for
   * those and answer better: a failed removal shows up as `'present'`, which is
   * a 409 rather than a line in a report.
   */
  leftBehindOnFailure?: UnreclaimedArtifact;
}

/**
 * Runs every step, best-effort, and answers with what the failures left.
 *
 * Sequential and never short-circuiting, which is the rule the three copies of
 * this loop each stated: a Swarm service that was never created must not
 * strand the source tree behind it, so a throw ends that step and nothing
 * else. The thrown error itself is deliberately not propagated and not logged
 * here — the caller's answer is built out of the presence read and this array,
 * and a delete that raised on a `docker service rm` for a service that is
 * already gone would be the orphan bug inverted.
 */
export async function runTeardownSteps(
  steps: readonly TeardownStep[],
): Promise<UnreclaimedArtifact[]> {
  const unreclaimed: UnreclaimedArtifact[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch {
      if (step.leftBehindOnFailure) unreclaimed.push(step.leftBehindOnFailure);
    }
  }
  return unreclaimed;
}

/**
 * Drops the **file-mounts** trees of the Services a delete is about to destroy,
 * on the machines that run them, and answers with the ones it could not.
 *
 * **What broke first.** `{root}/applications/{appName}` spans two machines
 * — the `code` half written and reclaimed on the build host, the
 * `files` half written and bind-mounted on the **run** Server — and all three
 * `rm -rf`s in the product name the *parent* directory on the build host only
 * (`ApplicationsService.remove`, `common/service-cascade.ts`' application arm,
 * `preview-teardown.ts`' `previewCodeDirectory`). `MountsService.writeFileMount`
 * dispatches to `parent.serverId`. So on an install where `buildServerId` is
 * set and differs, the removal landed on the machine holding the half it did
 * not need to and the operator's own config files outlived every delete;
 * `mount.applicationId` is `onDelete: 'cascade'`, and a cascade runs no
 * commands, so the row went and the file did not. Invisible by construction in
 * this ADR's usual way — the two ids coincide on every install with no
 * dedicated build Server, and `rm -rf` reads the same whichever machine is
 * asked — which is why the tests assert *which host was asked*.
 *
 * **Not a fourth teardown step, and the slot is the decision.** This runs in
 * ADR-0016's post-refusal, pre-row slot beside the image and clone
 * reclamations, rather than in the `teardown` array those three deletes run
 * *before* their presence read. Nothing in the product re-materializes a file
 * mount — `writeFileMount`'s only callers are `MountsService.create` and
 * `.update`, so a deploy does not — while the source tree beside it is rewritten
 * by the next clone. Removing this ahead of a 409 would therefore destroy the
 * config files of an Application the caller is then told still exists, with no
 * path in the product that puts them back short of the operator re-saving every
 * mount by hand. That is `reclaimPreservedImages`' argument at a second
 * artifact, and the reason this is a reclamation rather than a step.
 *
 * **Two destroyers, not three, which is a correction to the ticket's own
 * framing.** ADR-0018's atomicity rule binds the writer of a tree to its
 * destroyers, and the writer here addresses `{parent.appName}/files` for a
 * Service row — so the set is `ApplicationsService.remove` and the cascade.
 * `preview-teardown.ts` is *not* in it: a preview has no row in any of the eight
 * service tables, `findParentService` cannot resolve one, and nothing writes
 * `{preview.appName}/files` at all today. That file carries what would have to
 * change if that alters.
 *
 * **The owner is taken structurally rather than as a fifth named type**
 * (the owner-type lesson, applied by not repeating it): what this needs is an `appName`
 * and the **run** Server, which is `application.serverId` and never
 * {@link buildHostServerId}'s answer, and a `FileMountOwner` declaring those two
 * would be structurally satisfied by {@link BuildHostArtifactOwner} anyway — the
 * separate name would buy the appearance of a check nothing performs. What
 * names the question is the caller's projection, `common/service-cascade.ts`'
 * `fileMountOwnersOf`.
 *
 * One `rm -rf` per Service, sequential, through {@link runTeardownSteps} rather
 * than a `try`/`catch` written here — the mechanism is the same idempotent
 * removal every other reported artifact uses, and `rm -rf` exits 0 for a path
 * that is not there, so a healthy delete reports nothing without a second
 * question being asked. Argv: three words, and `rm -rf` is exactly where
 * a word split deletes something else.
 *
 * **Unconditional, rather than gated on whether the Service has a `file` mount
 * at all.** A gate would be a `select` on `mount` before every delete to save a
 * round trip on some of them, and — the deciding half — it would make the
 * removal a branch that the common install never takes, which is how this
 * artifact's own defect stayed invisible. The source-tree `rm -rf` is issued
 * for an Application that never deployed on the same reasoning: an idempotent
 * removal that exits 0 for a path that is not there needs no permission to run.
 */
export async function reclaimFileMounts(
  remoteExec: RemoteExecService,
  owners: readonly { appName: string; serverId: string | null }[],
): Promise<UnreclaimedArtifact[]> {
  return runTeardownSteps(
    owners.map(({ appName, serverId }) => {
      // One expression for the path the report names and the path the removal
      // is aimed at, taken from the writer's own helper — so this cannot name a
      // tree `MountsService` does not write, and a root that forked between
      // them would fail rather than agree with itself.
      const path = fileMountsDirectoryOnRunServer(serverId, appName);
      return {
        run: () => execOnServer(remoteExec, serverId, ['rm', '-rf', path]),
        leftBehindOnFailure: {
          kind: 'file-mounts' as const,
          appName,
          serverId,
          path,
        },
      };
    }),
  );
}

/**
 * Whether `appName` names exactly one directory directly under the logs root,
 * which is the only thing {@link reclaimDeploymentLogs} may `rm -rf`.
 *
 * `{logs}/{appName}` with an empty name, `.` or `..` is the logs root or its
 * parent, and a `/` reaches somewhere else entirely — one bad row would wipe
 * every owner's logs on the machine. `APP_NAME_REGEX` holds names at their mint
 * and admits `.` and `..`, and it is a charset two modules away besides (the
 * H-12 shape), so this is checked here, where the `rm` is: a leading letter or
 * digit, then letters, digits, `.`, `_` and `-`. A refused name is not removed
 * and is reported as left behind, like any other removal that did not happen.
 */
export function isLogOwnerName(appName: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(appName);
}

/**
 * Drops the deployment-log directories of the owners a delete is about to
 * destroy, on the machines that wrote them, and answers with the ones it could
 * not.
 *
 * **What broke.** Every Deployment row an owner has cascades with it, and the
 * `{logs}/{appName}` directory holding those rows' logs did not go anywhere:
 * no delete removed it, so it stayed on the host under an `appName` no row
 * named any more, unreachable from any screen, until ADR-0020's nightly sweep
 * aged it out 90 days later. That is five deletes with one leftover — an
 * Application, a Compose stack, an Application schedule, a database backup and
 * a volume backup — plus the Project/Environment cascade over the first two,
 * so it is one helper here rather than five copies.
 *
 * **Retention is not replaced.** ADR-0020 chose age on the file because a
 * delete-time removal *alone* cannot reach logs whose rows were destroyed
 * before it existed, nor a log on a machine the delete could not reach; both
 * are still the sweep's. This closes the common case — the delete that could
 * reach the machine — and names the other one in the report.
 *
 * **Which machine is the caller's**, and it must be the machine the writer
 * chose: `buildHostServerId`'s answer for an Application
 * (`DeploymentsService.initializeLog`), `compose.serverId` for a stack, and
 * the run target `BackupRunRecorderService.start` was given for the other three. A
 * log written before an Application's build Server changed is on the old
 * machine and is left to retention.
 *
 * **The slot is ADR-0016's post-refusal one** in the two deletes that can
 * refuse: logs nothing regenerates must not be removed ahead of a 409 that
 * keeps the owner. Argv and `rm -rf`, so an owner that never ran
 * reports nothing without a second question.
 */
export async function reclaimDeploymentLogs(
  remoteExec: RemoteExecService,
  owners: readonly { appName: string; serverId: string | null }[],
): Promise<UnreclaimedArtifact[]> {
  return runTeardownSteps(
    owners.map(({ appName, serverId }) => {
      // One expression for the path removed and the path reported, and the
      // writers' own (ADR-0018).
      const path = deploymentLogsDirectoryOn(serverId, appName);
      return {
        run: () =>
          isLogOwnerName(appName)
            ? execOnServer(remoteExec, serverId, ['rm', '-rf', path])
            : Promise.reject(
                new Error(`refusing to remove logs for appName "${appName}"`),
              ),
        leftBehindOnFailure: {
          kind: 'deployment-logs' as const,
          appName,
          serverId,
          path,
        },
      };
    }),
  );
}

/**
 * `row` with `unreclaimedArtifacts` spread on when there are any, and `row`
 * unchanged when there are none — absent rather than empty, like every field
 * in this family, so a healthy delete's answer is just the row.
 */
export function withUnreclaimedArtifacts<TRow extends object>(
  row: TRow,
  unreclaimedArtifacts: readonly UnreclaimedArtifact[],
): TRow & { unreclaimedArtifacts?: UnreclaimedArtifact[] } {
  return unreclaimedArtifacts.length > 0
    ? { ...row, unreclaimedArtifacts: [...unreclaimedArtifacts] }
    : row;
}

/**
 * What one delete's machine-side teardown observed: the workloads it could not
 * confirm gone, and the paths it could not confirm removed.
 *
 * Two arrays and not one, because they are two kinds of claim decided by two
 * mechanisms — `orphaned` is a *presence read* and is what a 409 is taken on;
 * `unreclaimedArtifacts` is a *failed removal* and never refuses a delete.
 * It stays at two as artifacts are added, which is
 * {@link UnreclaimedArtifact}'s argument for the `kind`.
 * `tearDownCascadeChildren` and `tearDownApplicationPreviews` answer in the
 * same shape because their callers merge the two answers into one response.
 */
export interface TeardownReport {
  orphaned: OrphanedWorkload[];
  unreclaimedArtifacts: UnreclaimedArtifact[];
}

/**
 * The images one delete could not reclaim, grouped by the machine that still
 * holds them.
 *
 * **Why an image is not an {@link UnreclaimedArtifact}, which is a decision
 * that had to be made.** The obvious move was a fourth `kind` — `'built-image'` —
 * because the mechanism is the same idempotent removal and the `kind` built the
 * discriminant so a fourth artifact would cost one entry. It is wrong for the
 * two reasons that type states about itself. `UnreclaimedArtifact` is *"a path
 * on a machine"* and its `path` was renamed from `directory` precisely so no
 * entry would sit in a field named for something it is not — `web-app:latest`
 * is an image reference, not a path, so a `'built-image'` entry would put the
 * field back in the state the `kind` declined to leave it in. And the `kind` exists
 * because *what breaks* differs between a tree, a cache and a live router
 * fragment; nothing breaks differently between a leftover `${appName}:latest`
 * and a leftover `${appName}:v3`. They are the same claim, they take the same
 * follow-up (`docker image rm` that tag on that Server, or the machine-wide
 * prune from Settings → Maintenance), and the field for that claim already
 * existed.
 *
 * Grouped by Server rather than flat with an `appName`, which is the other
 * difference from `UnreclaimedArtifact`: an image reclamation iterates
 * *machines* — `reclaimPreservedImages` pays one `checkServerAccess` per
 * machine, and both reclamations stop asking a machine that has failed — so the
 * per-machine list is the shape the loop produces rather than one imposed on
 * it. The `appName` an artifact entry needs to be identifiable is inside the
 * tag here, which is why nothing is lost.
 *
 * Moved out of `rollbacks/preserved-images.ts` and renamed from
 * `UnreclaimedPreservedImages`: it stopped being about preserved images the
 * moment a second reclamation answered in it, and the two reclamations that do
 * live in two feature modules while the response field they share is one.
 */
export interface UnreclaimedImages {
  /** `null` is the platform host (ADR-0008). */
  serverId: string | null;
  images: string[];
}

/**
 * Whether a failed `docker image rm` failed because there was nothing to
 * remove.
 *
 * `docker image rm` exits non-zero for an image the daemon does not have, so
 * without this an operator who has run `docker image prune -a` meets
 * `RollbacksService.remove`'s refusal with nothing left to act on — the row
 * would be retained to keep track of an image that does not exist, for ever.
 * That is the same shape one step along, so it was answered there rather than
 * left for the next ticket. The two bulk reclamations read it for the milder
 * reason that an image already gone is the outcome they wanted and must not be
 * reported as left behind — and for `applications/built-image.ts` that is not
 * milder at all but load-bearing: an Application that never deployed has no
 * `${appName}:latest`, so without this every one of them would be named as a
 * leak by every delete and the field would stop meaning *these were left
 * behind*.
 *
 * Read off the daemon's message because the exit code cannot carry it: `docker`
 * exits 1 for every removal failure alike. Rejected: a `docker image inspect`
 * ahead of the removal, which is a second round trip and the same race; and
 * dockerode's structured 404, which means taking this call off the argv
 * transport it was given and onto `RemoteDockerFactory`. A message this fails
 * to recognise costs a refusal — the behaviour that was there before — rather
 * than a wrong deletion.
 *
 * Here rather than in `rollbacks/preserved-images.ts`, for that
 * file's own stated lesson: it is now read by three call sites in two feature
 * modules, and two copies of a rule that has been wrong once is how it goes
 * wrong again.
 */
export function imageAlreadyGone(error: unknown): boolean {
  const failure = error as {
    stderr?: string;
    stdout?: string;
    message?: string;
  };
  return /no such image/i.test(
    `${failure?.stderr ?? ''} ${failure?.stdout ?? ''} ${failure?.message ?? ''}`,
  );
}

/** How often {@link removeImagesOn} re-asks for an image a stopping task holds. */
export const IMAGE_RELEASE_POLL_MS = 1_000;

/**
 * The ceiling on the wait for the task containers a `docker service rm` left
 * stopping, per machine, shared by every {@link removeImagesOn} call one
 * {@link ImageReleaseWait} is handed to.
 *
 * A task gets Swarm's stop grace period — ten seconds by default — before it
 * is killed, and a Node server running as PID 1 ignores the `SIGTERM` and uses
 * all of it, which is the Application #1415 was found on. So the budget is that
 * default plus the container's removal, with the margin
 * `COMPOSE_SETTLE_BUDGET_MS` takes over its own measurement. An Application
 * with a longer `stopGracePeriodSwarm` can outlast it; its image is then named
 * in {@link UnreclaimedImages} by id rather than left unreported.
 */
export const IMAGE_RELEASE_BUDGET_MS = 30_000;

/**
 * Leave to wait for the containers holding a delete's images to go, for at
 * most {@link IMAGE_RELEASE_BUDGET_MS} per machine across the whole delete.
 *
 * **One per delete, not one per call.** An Application's delete reclaims its
 * preserved tags and then its built tag, often on one machine and often one
 * image, and the container that holds them stops once: a budget per call
 * would let a container that outlasts it cost the delete the wait twice for
 * the same answer. So the deadline is per machine, started at that machine's
 * first wait, and every call handed this object shares it.
 */
export interface ImageReleaseWait {
  readonly clock: SettleClock;
  /** This machine's deadline, started on first ask. */
  deadlineOn(serverId: string | null): number;
}

/**
 * What {@link removeImagesOn} does with an image whose tag it has just
 * removed, decided by the caller that knows whether the workload is gone.
 *
 * - An {@link ImageReleaseWait} when the delete **confirmed** the service gone
 *   (or has none on these machines): the only container left holding the
 *   image is a stopping task, so the image is followed by id until that task
 *   has gone.
 * - `'untag-only'` when it did not — a **forced** delete past a presence read
 *   that answered `'present'` or `'unknown'`. A running container then holds
 *   the image, so a removal by id would wait the whole budget for a refusal
 *   that is certain. Only the tag goes, as before #1415, and the image is not
 *   reported: it is the image of the workload `?force=true` chose to leave
 *   running, and naming it would cost a probe per tag (ADR-0018: *no probe, no
 *   second round trip*) to say what the forced delete already knows.
 *
 * A required argument rather than a default, so no caller inherits a wait —
 * or the lack of one — it never chose.
 */
export type ImageRelease = ImageReleaseWait | 'untag-only';

/**
 * An {@link ImageReleaseWait} for one delete. `clock` is a seam for the wait,
 * as `awaitComposeWorkloadAbsent`'s is.
 */
export function awaitImageRelease(
  clock: SettleClock = systemSettleClock,
): ImageReleaseWait {
  const deadlines = new Map<string | null, number>();
  return {
    clock,
    deadlineOn(serverId) {
      let deadline = deadlines.get(serverId);
      if (deadline === undefined) {
        deadline = clock.now() + IMAGE_RELEASE_BUDGET_MS;
        deadlines.set(serverId, deadline);
      }
      return deadline;
    },
  };
}

/** Every stream of a failed exec's text, for the readers below. */
const failureText = (error: unknown): string => {
  const failure = error as {
    stderr?: string;
    stdout?: string;
    message?: string;
  };
  return `${failure?.stderr ?? ''} ${failure?.stdout ?? ''} ${failure?.message ?? ''}`;
};

/**
 * Whether a failed `docker image rm <id>` was refused because a container,
 * running or stopped, still uses the image: the one refusal that settles.
 * Read off the message for {@link imageAlreadyGone}'s reason.
 */
function imageInUse(error: unknown): boolean {
  return /being used by (running|stopped) container/i.test(failureText(error));
}

/**
 * Whether a failed exec was the Docker daemon answering — a refusal of this
 * one image (`image has dependent child images`, say) — rather than a machine
 * that did not answer. Only the second ends a machine's turn: a refusal costs
 * one round trip, an unreachable Server an SSH timeout per tag.
 */
function daemonRefused(error: unknown): boolean {
  return /Error response from daemon/i.test(failureText(error));
}

/**
 * Drops these tags on one machine, and the image behind a tag once no tag is
 * left on it, and answers with what it could not drop, stopping at the first
 * failure that is neither {@link imageAlreadyGone} nor the daemon refusing one
 * image.
 *
 * The loop both image reclamations share, stated once. `reclaimPreservedImages`
 * wrote it for the preserved tag and `reclaimBuiltImages` needs it verbatim, and
 * every clause in it is a decision that was argued once and must not be
 * re-decided differently at the second call site:
 *
 * - **One command per tag rather than one per machine**, so that a batch where
 *   one tag is already gone and another is genuinely held cannot read as wholly
 *   reclaimed: `docker image rm a b` exits 1 with both complaints in one
 *   message and {@link imageAlreadyGone} would answer for the pair.
 * - **The first real failure ends this machine's turn**, and the tags not yet
 *   attempted are reported with it. An unreachable Server must not multiply an
 *   SSH connect timeout by the tag count — an Application with a hundred
 *   Deployments has a hundred preserved tags, and a Project delete has one
 *   `${appName}:latest` per Application. A daemon that *answered* and refused
 *   one image by id is not that: the image is named by id and the next tag is
 *   still tried.
 * - **`--force`**, which is a tag removal rather than a stronger one: `docker
 *   image rm` refuses a tag any container still references, including the
 *   `Shutdown` tasks a `docker service rm` leaves behind for several seconds
 *   (`awaitComposeWorkloadAbsent` is the same daemon lag one subsystem along).
 *   Without it a healthy delete would report a leak it does not have, which is
 *   the property this whole family of fields exists to keep. It untags; the
 *   image data survives as long as anything references it.
 * - **So the image is followed by its id (#1415)**, unless `release` is
 *   `'untag-only'` ({@link ImageRelease} says when). Untagging the last tag of
 *   an image a stopping task still runs leaves the image itself dangling —
 *   886 MB for a small Express app — until the nightly prune. So the tag's id
 *   is read before the untag, and when the untag did not delete the image and
 *   no tag is left on it, `docker image rm <id>` removes it once the task's
 *   container has gone, re-asked every {@link IMAGE_RELEASE_POLL_MS} until the
 *   machine's deadline in `release`. That removal is *without* `--force`, on
 *   purpose: on an id, `--force` strips every tag the image carries, and
 *   without it the daemon refuses an image any container, ours or not, still
 *   uses. An image still carrying another tag is not this delete's to remove
 *   and is left as it is: the preserved tag and `${appName}:latest` often name
 *   one image, and whichever goes last takes it. A pulled image never reaches
 *   here at all — `builtImageTag` names nothing for it.
 * - **Nothing throws.** A leftover image is disk rather than ADR-0008's
 *   unmanaged container, so it is reported and never refused — ADR-0016's
 *   argument, and *"a dead server must not make deletion impossible"*. An image
 *   whose tag went but whose container outlasted the budget, or which the
 *   daemon refused by id, is reported by its id, the one name left for it.
 *
 * Argv the caller does not quote.
 */
export async function removeImagesOn(
  remoteExec: RemoteExecService,
  serverId: string | null,
  images: readonly string[],
  release: ImageRelease,
): Promise<UnreclaimedImages[]> {
  const leftBehind: string[] = [];
  for (const [index, image] of images.entries()) {
    let imageId = '';
    try {
      if (release !== 'untag-only') {
        imageId = (
          await execOnServer(remoteExec, serverId, [
            'docker',
            'image',
            'inspect',
            '--format',
            '{{.Id}}',
            image,
          ])
        ).stdout.trim();
      }
      const untagged = await execOnServer(remoteExec, serverId, [
        'docker',
        'image',
        'rm',
        image,
        '--force',
      ]);
      if (
        release === 'untag-only' ||
        imageId === '' ||
        untagged.stdout.includes(`Deleted: ${imageId}`)
      ) {
        continue;
      }
    } catch (error) {
      if (imageAlreadyGone(error)) continue;
      return [{ serverId, images: [...leftBehind, ...images.slice(index)] }];
    }
    const outcome = await removeUntaggedImage(
      remoteExec,
      serverId,
      imageId,
      release,
    );
    if (outcome === 'held' || outcome === 'refused') leftBehind.push(imageId);
    if (outcome === 'unanswered') {
      return [
        {
          serverId,
          images: [...leftBehind, imageId, ...images.slice(index + 1)],
        },
      ];
    }
  }
  return leftBehind.length > 0 ? [{ serverId, images: leftBehind }] : [];
}

/**
 * {@link removeImagesOn}'s second half: the image behind a tag it has just
 * removed, by id, once no tag is left on it and no container uses it.
 *
 * `'removed'` is gone, by this removal or before it. `'still-tagged'` is an
 * image another tag names, left in place because it is not this delete's to
 * remove. `'held'` is a container that outlasted the budget and `'refused'` the
 * daemon declining this image for any other reason; both are reported by id
 * and the turn goes on. `'unanswered'` is an exec the machine did not answer,
 * and ends the machine's turn.
 */
async function removeUntaggedImage(
  remoteExec: RemoteExecService,
  serverId: string | null,
  imageId: string,
  release: ImageReleaseWait,
): Promise<'removed' | 'still-tagged' | 'held' | 'refused' | 'unanswered'> {
  for (;;) {
    try {
      const tags = await execOnServer(remoteExec, serverId, [
        'docker',
        'image',
        'inspect',
        '--format',
        '{{len .RepoTags}}',
        imageId,
      ]);
      if (tags.stdout.trim() !== '0') return 'still-tagged';
      await execOnServer(remoteExec, serverId, [
        'docker',
        'image',
        'rm',
        imageId,
      ]);
      return 'removed';
    } catch (error) {
      if (imageAlreadyGone(error)) return 'removed';
      if (!imageInUse(error)) {
        return daemonRefused(error) ? 'refused' : 'unanswered';
      }
    }
    const remainingMs = release.deadlineOn(serverId) - release.clock.now();
    if (remainingMs <= 0) return 'held';
    await release.clock.sleep(Math.min(IMAGE_RELEASE_POLL_MS, remainingMs));
  }
}

/**
 * The columns of an Application that name an artifact on its **build host**:
 * the name every per-build artifact carries, and the two ids
 * {@link buildHostServerId} resolves.
 *
 * **Three declarations of one shape, and one call site was already cross-using
 * two of them.** `patch/patch-repo-clone.ts`' `PatchRepoOwner`,
 * `applications/built-image.ts`' `BuiltImageOwner` and
 * `applications/build-leftovers.ts`' `BuildLeftoverOwner` each arrived
 * with the reclamation that needed it, and `common/service-cascade.ts` ended up
 * handing `reclaimBuildLeftovers` the patch-repo projection under a comment
 * apologising for it — *"it takes `patchRepoOwnersOf`'s projection rather than a
 * fourth of its own"*. That is the projection three reclamations want, so it is
 * named for what it is and the apology is gone;
 * `common/service-cascade.ts`' `buildHostArtifactOwnersOf` is the one that
 * builds it.
 *
 * **Rejected: keeping the three separate so a reclamation cannot be handed the
 * wrong projection.** That is the only reason to keep three, and TypeScript
 * does not supply it. The three were structurally identical, so the cross-use
 * above compiled with no cast and no complaint, and so would a fourth
 * reclamation's copy — the separate names bought the *appearance* of a check
 * that was never performed, which is worse than one name, because a reviewer
 * meeting `reclaimBuildLeftovers(…, patchRepoOwnersOf(children))` has to
 * establish for themselves that nothing verified it. What does protect a
 * reclamation is a field it genuinely needs and the others do not: see
 * `BuiltImageOwner`, which extends this and cannot be satisfied by a bare
 * three-column projection.
 *
 * **Rejected: naming it for the Application, or reusing `CascadeChild`.** This
 * is not *an Application* and must not start collecting the columns of one.
 * `common/service-cascade.ts`' `CascadeChild` carries `serviceType`,
 * `serviceId` and a nullable `sourceType` on top of these three, because it is
 * a teardown target for eight service types of which seven have no build host
 * at all; `preview-deployments/preview-teardown.ts`' `PreviewTeardownTarget`
 * carries the build host *already resolved* beside the run Server, and
 * deliberately is not this shape. Named for the row, this type would collect
 * whatever column the next delete happened to want. Named for the question, it
 * holds exactly what {@link buildHostServerId} plus an `appName`-derived
 * artifact name need — which is CONTEXT.md's **Build host** list: the source
 * tree, the `${appName}` images, the patch-repo clone, a killed build's
 * leftovers.
 *
 * The name says *build-host artifact owner* rather than *build-server owner*
 * for CONTEXT.md's own reason: `buildServerId` is one of the two **inputs** and
 * is `null` on the default single-Server install, so it is not the name of the
 * machine. `null` for both is the platform host (ADR-0008), not "unknown".
 */
export interface BuildHostArtifactOwner {
  appName: string;
  serverId: string | null;
  buildServerId: string | null;
}

/**
 * Groups these owners by the build host that holds their artifacts — one entry
 * per machine, machines in first-seen order — and drops an owner that names no
 * such artifact.
 *
 * **Two copies of this loop, and the second cited the first as precedent
 * instead of sharing it.** `applications/built-image.ts`' `reclaimBuiltImages`
 * and `applications/build-leftovers.ts`' `reclaimBuildLeftovers`
 * each wrote the same `Map<string | null, string[]>` build-up in the same
 * commit range, the second's docblock pointing at the first — which records the
 * duplication rather than removing it. Three decisions live in those six lines
 * and each is one this file exists to state once (§1.4):
 *
 * - **The key is {@link buildHostServerId}'s answer, never the run Server.**
 *   That is the whole of ADR-0018, and its mechanism is that a wrong-machine
 *   call issues a byte-identical command — so a third reclamation grouping by
 *   `owner.serverId` would be green on every single-Server install.
 * - **Insertion order is the caller's, so one machine is one turn.** A Project
 *   delete costs one round trip per build host rather than one per Application,
 *   and for a cascade the order is `listCascadeChildren`'s, so a report reads
 *   the same way twice.
 * - **A `null` word means *this owner has no such artifact*, not *name nothing
 *   on that machine*.** `builtImageTag` answers `null` for a docker-sourced
 *   Application because that arm's image is the operator's own pulled
 *   `dockerImage`; such an owner contributes no word and, if it is the only one
 *   on its machine, no turn either.
 *
 * **What is deliberately *not* in here, and it is why the extraction is safe:
 * the per-machine turn.** The two reclamations differ on two axes and both
 * differences sit after the grouping. `reclaimBuiltImages` hands each machine's
 * list to {@link removeImagesOn}, which stops at the first failure that is not
 * {@link imageAlreadyGone} — an unreachable Server must not multiply an SSH
 * connect timeout by an Application's tag count — and reports in
 * {@link UnreclaimedImages}. `reclaimBuildLeftovers` sends one composed program
 * per machine, goes on asking the next machine after one has failed because a
 * failure there is one round trip rather than one per artifact, and answers
 * `void` because a sweep that did not run is not an artifact left behind.
 *
 * So a `forEachBuildHost(owners, wordFor, run)` that also performed the turn
 * was rejected: it would have to take the stop rule and the report as
 * parameters, and a flag deciding failure semantics is exactly how one
 * reclamation silently acquires the other's. This function performs no I/O and
 * has no failure or reporting semantics to inherit or to hide; the `for` loop
 * that does the asking stays at each call site, next to the answer it returns,
 * where the contract is what a reader sees rather than an argument they have to
 * follow into a helper.
 *
 * `wordFor` rather than a fixed `appName` mapper, because the callers produce
 * two kinds of word from the same three columns: a shell program from
 * `builders/build-leftovers.ts`' `buildLeftoverReclamation`, an image reference
 * from `applications/built-image.ts`' `builtImageTag` — and only the second can
 * answer that there is nothing to name.
 */
export function groupByBuildHost<T extends BuildHostArtifactOwner>(
  owners: readonly T[],
  wordFor: (owner: T) => string | null,
): Map<string | null, string[]> {
  const byBuildHost = new Map<string | null, string[]>();
  for (const owner of owners) {
    const word = wordFor(owner);
    if (word === null) continue;
    const serverId = buildHostServerId(owner);
    const words = byBuildHost.get(serverId);
    if (words) words.push(word);
    else byBuildHost.set(serverId, [word]);
  }
  return byBuildHost;
}
