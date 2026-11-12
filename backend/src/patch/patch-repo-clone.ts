import path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { assertShellSafePath } from '../common/shell-safe-path';
import { runTeardownSteps } from '../common/teardown-steps';
import type {
  BuildHostArtifactOwner,
  TeardownStep,
  UnreclaimedArtifact,
} from '../common/teardown-steps';
import { buildHostServerId } from '../deployment-engine/build-host';
import { patchReposDirectoryOn } from '../deployment-engine/deployment-engine.paths';
import { execOnServerStdout } from '../remote/exec-dispatch';
import type { RemoteExecService } from '../remote/remote-exec.service';
import type { PatchEntityType } from './patch.service';

/**
 * An entity's patch-repo clone: where it is, and the delete that reclaims it.
 *
 * **Why this is a file of its own rather than four more lines of
 * `patch-repo.service.ts`.** The clone is created by `PatchRepoService`, which
 * injects `ApplicationsService`; the reclamation is called by
 * `ApplicationsService.remove`, which would then have to import the module that
 * imports it. That is a runtime import cycle, not merely a Nest one — the
 * `@Injectable()` decorator's `design:paramtypes` on `PatchRepoService` would
 * evaluate `ApplicationsService` while `applications.service.ts` was still
 * mid-load and see `undefined`. `rollbacks/preserved-images.ts` and
 * `preview-deployments/preview-teardown.ts` are the same shape for the same
 * reason and say so: a plain function taking the collaborators it needs, so a
 * delete can reclaim an artifact without depending on the service that made it.
 *
 * {@link resolveRepoPath} lives here rather than in the service for that
 * reason and no other, and the service re-exports it under the name it has
 * always been imported by.
 */

/**
 * An entity's patch-repo clone:
 * `{patchReposDirectoryOn(serverId)}/{type}/{appName}`, the one expression
 * `ensureRepo` clones into, both read routes read from and
 * {@link removePatchRepoStep} removes, so none of the four can disagree about
 * which directory a patch applies to.
 *
 * The path is interpolated into a double-quoted shell word, and `appName` is
 * only *usually* safe: the create DTOs constrain it with `APP_NAME_REGEX`, but
 * `ComposeService.createByTemplate` (the templates and AI deploy paths)
 * inserts one that has only been through `cleanAppName`. So the derived path
 * is checked rather than trusted, on the same rule as `resolveRepoFilePath`,
 * plus a name that must stay a single segment under the type directory.
 *
 * **`serverId` is a required third parameter, and being required *is* the
 * verification** (`previewCodeDirectory` is the precedent). The
 * platform tree has two roots — this instance's `CLOUDGATE_DIRECTORY` and the
 * `/etc/cloudgate` literal `serverSetupCommand` creates on a Server — and this
 * expression resolved the local one for every machine, so a clone dispatched to
 * a build Server was written, read and reported under a root that Server never
 * had. It is the machine that holds *this* clone — `PatchRepoService.findEntity`'s
 * answer: the build host for an Application, the run Server for a Compose
 * stack — and one argument decides the root and the machine together, so a
 * caller cannot name a path on one host and send the command to another.
 * Defaulting it was rejected for exactly that reason: the default would be the
 * local root, which is the bug, and a call site that forgot would be silently
 * back in it.
 */
export function resolveRepoPath(
  type: PatchEntityType,
  appName: string,
  serverId: string | null,
): string {
  const base = path.join(patchReposDirectoryOn(serverId), type);
  const repoPath = path.join(base, appName);
  // Same double-quoted word as `resolveRepoFilePath`, plus the single-segment
  // rule that keeps `appName` under the type directory.
  assertShellSafePath(repoPath);
  if (path.dirname(repoPath) !== base) {
    throw new BadRequestException('Invalid path');
  }
  return repoPath;
}

/**
 * Dropping one entity's patch-repo clone, as a teardown step a delete can
 * report on.
 *
 * Argv, not a shell string: one program and its arguments, so the path
 * arrives as a single word without this file quoting it — and `rm -rf` is
 * exactly where that is worth insisting on, because a word split there deletes
 * something else. {@link resolveRepoPath}'s own guard stands behind it rather
 * than in place of it.
 *
 * The `serverId` is the **build host** ({@link buildHostServerId}), because
 * that is where `ensureRepo` clones — its caller is where that is decided, and
 * this only makes sure the machine that was asked is the machine the report
 * names. `repoPath` arrives already derived, for the same reason: it comes from
 * {@link resolveRepoPath}, which *refuses* some names, and a step whose
 * construction can throw is a step that could 400 a delete.
 *
 * That same `serverId` is also what decided `repoPath`'s **root**,
 * so the two cannot fork: the caller resolves the machine once and hands it to
 * both. Before that the path carried this instance's own root whatever machine
 * was asked, which is what put a local temp directory in a delete report as a
 * directory on a remote build Server.
 *
 * It carries a `leftBehindOnFailure` on `common/teardown-steps.ts`'s rule: this
 * is the only thing that removes the clone at a delete, no presence read covers
 * it, and `rm -rf` exits 0 for a path that is not there — so a non-zero exit or
 * a rejected transport already means *this may still be on that machine*, with
 * no second question asked and nothing reported on a healthy delete.
 */
export const removePatchRepoStep = (
  remoteExec: RemoteExecService,
  serverId: string | null,
  appName: string,
  repoPath: string,
): TeardownStep => ({
  run: () => execOnServerStdout(remoteExec, serverId, ['rm', '-rf', repoPath]),
  leftBehindOnFailure: {
    kind: 'patch-repo',
    appName,
    serverId,
    path: repoPath,
  },
});

/**
 * Drops the patch-repo clones of the Applications a delete is about to
 * destroy, and answers with the ones it could not.
 *
 * **The clone was reclaimed by nothing.** `PatchRepoService.cleanRepos` is the
 * only removal in the product and it globs the whole tree on an
 * operator-named Server, which is a maintenance sweep rather than a
 * reclamation — its own docblock records the gap it leaves as the second of the
 * three reasons it may not be scoped to one organization: *"Reclaiming a
 * deleted service's clone is the route's job, and no query can name one.
 * Nothing removes a clone when its Application or Compose row goes away."* So
 * the residue outlived every delete, under an `appName` that no row named any
 * more, and it holds the entity's **source** — not a cache of public artifacts
 * but the same tree ADR-0018 reclaims two directories along, private-repository
 * contents included.
 *
 * This runs in ADR-0016's slot — after any presence refusal, before the rows —
 * for that ADR's reason and one of this artifact's own. The refusal half: the
 * clone is `ensureRepo`'s cache, and wiping it ahead of a 409 would strip the
 * patch editor of an Application the caller is then told still exists, so it
 * would re-clone on the next open for nothing. The rows half: `appName` is the
 * only name the clone has, and the rows carrying it are about to go.
 *
 * **Applications only, and the compose clone is a known remaining gap.** The
 * tree is `{patchReposDirectoryOn(serverId)}/{application|compose}/{appName}`, so the two
 * types are separable and this closes one of them at every delete that destroys
 * an Application row. `ComposeService.remove` is where the other would go and is
 * not this change's to edit; doing it in the cascade alone would reclaim a
 * stack's clone when its Project is deleted and not when the stack itself is,
 * which is where a rule drifts rather than where it holds (ADR-0018 makes that
 * argument about refusals). ADR-0018's non-goal list names it.
 *
 * Sequential, one step per Application, through `runTeardownSteps` rather than
 * a `try`/`catch` written here: the mechanism is identical to the three machine
 * steps' — an idempotent removal whose failure is the report — and an earlier
 * fix put that loop in `common/` precisely so a fourth caller would not restate
 * it.
 *
 * **And it takes `common/teardown-steps.ts`' {@link BuildHostArtifactOwner}
 * rather than a `PatchRepoOwner` of its own** — the same rule
 * applied to the input rather than to the loop. This file declared one, the
 * clone's name and the machine that holds it, while
 * `applications/build-leftovers.ts` and `applications/built-image.ts` declared
 * the identical three columns beside it, to the point where
 * `common/service-cascade.ts` was handing `reclaimBuildLeftovers` *this*
 * reclamation's projection under a comment apologising for it. Three names over
 * one structure check nothing in a structural type system; that type's docblock
 * carries the argument and what was rejected.
 *
 * There is no grouping to share with those two, and that is a difference in
 * mechanism rather than an omission: this is one `rm -rf` per Application
 * because one clone is one path on one host, and batching by machine would give
 * up the per-path `leftBehindOnFailure` that is the whole of the report.
 */
export async function reclaimApplicationPatchRepos(
  remoteExec: RemoteExecService,
  owners: readonly BuildHostArtifactOwner[],
): Promise<UnreclaimedArtifact[]> {
  const steps: TeardownStep[] = [];
  for (const owner of owners) {
    // One `buildHostServerId` decides the root and the machine, so the removal
    // cannot name a path on one host and be sent to another.
    const serverId = buildHostServerId(owner);
    let repoPath: string;
    try {
      repoPath = resolveRepoPath('application', owner.appName, serverId);
    } catch {
      // `resolveRepoPath` refuses a name that is not a single segment under the
      // type directory, and `ensureRepo` derives the clone's path from the same
      // expression — so a name it refuses never had a clone to leave behind.
      // There is nothing on the machine and therefore nothing to report, which
      // is the one case in which saying nothing is not a swallowed failure.
      continue;
    }
    steps.push(
      removePatchRepoStep(remoteExec, serverId, owner.appName, repoPath),
    );
  }
  return runTeardownSteps(steps);
}
