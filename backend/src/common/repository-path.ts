import { SHELL_UNSAFE } from './shell-safe-path';

/**
 * Why a path inside a Service's repository cannot be used, or `null`: the one
 * rule a build path ({@link buildPathRefusal} in `build-path.ts`) and a
 * Patch's file (`patch/patch-file-path.ts`) share, each adding what is its
 * own around it.
 *
 * A `..` segment, wherever it sits, is what leaves the checkout. The
 * `SHELL_UNSAFE` characters and NUL are what a quoted shell word does not
 * stop, or what no file name can hold; both paths go into programs run on the
 * build host, as root on the Hosted platform host.
 *
 * A link inside the checkout that leads out of it is not visible in the text;
 * the steps that use each path check that on the machine.
 */
export function repositoryPathRefusal(value: string): string | null {
  if (value.split('/').includes('..')) {
    return 'must stay inside the repository: it cannot have a `..` segment';
  }
  if (SHELL_UNSAFE.test(value) || value.includes('\0')) {
    return 'cannot carry a double quote, backtick, `$`, backslash, NUL or line break';
  }
  return null;
}
