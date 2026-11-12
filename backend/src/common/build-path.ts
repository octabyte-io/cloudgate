import { z } from 'zod';

import { repositoryPathRefusal } from './repository-path';

/**
 * Why a Service's build path cannot be used, or `null`: the folder inside the
 * repository its build starts in, joined onto the checkout by
 * `buildAppDirectoryIn`.
 *
 * **A leading `/` is the repository's root, not the host's.** It is how the
 * column's default, the console's placeholder and Project config's `path` have
 * always spelled it (`/`, `/apps/web`), so it is kept; `path.join` reads it the
 * same way. What leaves the checkout is a `..` segment, so that is what is
 * refused, wherever it sits. On a cloud static site the folder is copied off
 * the platform host into the customer's bucket, so a build path of `../../..`
 * copied the host's own directories.
 *
 * The `SHELL_UNSAFE` characters and NUL are refused too, behind the quoting
 * every build command already does (`builders/build-strategy.ts`): no folder
 * in a repository a Service builds from needs one. Both refusals are
 * {@link repositoryPathRefusal}, the rule a Patch's file path shares.
 *
 * A link inside the checkout that leads out of it is not visible here; the
 * cloud static staging step resolves the folder's real path for that
 * (`stageStaticFilesCommand`).
 */
export function buildPathRefusal(value: string): string | null {
  return repositoryPathRefusal(value);
}

/**
 * {@link buildPathRefusal} as a schema, its message naming `field`. `subject`
 * is the string rule it is layered onto, so a column's length rule stays in
 * the published contract (as `insideDirectorySchema`'s does).
 */
export const buildPathSchema = (
  field: string,
  subject: z.ZodString = z.string(),
) =>
  subject.superRefine((value, context) => {
    const refusal = buildPathRefusal(value);
    if (refusal !== null) {
      context.addIssue({ code: 'custom', message: `${field} ${refusal}` });
    }
  });
