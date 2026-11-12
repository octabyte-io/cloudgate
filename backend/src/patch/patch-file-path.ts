import { repositoryPathRefusal } from '../common/repository-path';

/**
 * Why a Patch's `filePath` cannot be written into a build, or `null` when it
 * can.
 *
 * A Patch's path is joined onto the Service's fresh checkout and written or
 * removed there by a shell program that runs on the build host — for a cloud
 * Application on the Hosted instance that is the platform host, as root. So
 * the path must name a file **inside the checkout**: relative, and passing
 * the rule a build path shares (`common/repository-path.ts`: no `..`
 * segment, none of the characters a quoted shell word does not stop, no NUL).
 * A path that is only `.` segments names the checkout itself, which no patch
 * can be.
 *
 * One rule, asked twice: by the schemas that write a Patch (a 400 naming
 * `filePath`) and by `PatchService.generateApplyPatchesCommand` at deploy
 * time, so a row saved before the rule existed fails the deploy instead of
 * running. The apply step also `quote()`s the path; this is what keeps it
 * inside the checkout, which quoting cannot.
 */
export function patchFilePathProblem(filePath: string): string | null {
  if (filePath.length === 0) {
    return 'must not be empty';
  }
  const refusal = repositoryPathRefusal(filePath);
  if (refusal !== null) {
    return refusal;
  }
  if (filePath.startsWith('/')) {
    return 'must be relative to the repository root, not absolute';
  }
  if (
    filePath.split('/').every((segment) => segment === '' || segment === '.')
  ) {
    return 'must name a file inside the repository';
  }
  return null;
}
