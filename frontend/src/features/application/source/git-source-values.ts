import { z } from "zod";

import type { SourceRepository } from "@/lib/api/endpoints/git-providers";

import {
  fieldText,
  type GitProviderSpec,
  type PathSpec,
  type SourceRow,
} from "./providers";

export const gitSourceSchema = z.object({
  connection: z.string().min(1, "Choose which connection to clone through."),
  repository: z.string().min(1, "Choose a repository to build."),
  branch: z.string().min(1, "Choose a branch to build from."),
  buildPath: z.string(),
  triggerType: z.enum(["push", "tag"]),
  autoDeploy: z.boolean(),
});

export type GitSourceValues = z.infer<typeof gitSourceSchema>;

/**
 * The form's six answers, spread across whichever columns **this** provider names.
 *
 * This is the only place the four providers really differ, which is why it is here
 * beside the spec rather than inside the form: a slug for Bitbucket, a numeric
 * project id for GitLab, and neither for the other two. `picked` is the row from
 * the listing — the form falls back to the typed key when the listing has not
 * arrived, because a save that drops the repository is worse than one that saves a
 * key the provider will recognise.
 */
export function sourceInput(
  spec: GitProviderSpec,
  path: PathSpec,
  values: GitSourceValues,
  picked: SourceRepository | undefined,
): Record<string, unknown> {
  return {
    sourceType: spec.kind,
    [spec.connectionKey]: values.connection,
    [spec.repositoryKey]: picked?.name ?? values.repository,
    [spec.ownerKey]: picked?.owner ?? "",
    [spec.branchKey]: values.branch,
    [path.column(spec)]: values.buildPath.trim() || path.fallback,
    ...(spec.slugKey
      ? { [spec.slugKey]: picked?.slug ?? picked?.pathNamespace ?? null }
      : {}),
    ...(spec.projectIdKey
      ? { [spec.projectIdKey]: picked?.projectId ?? null }
      : {}),
    triggerType: values.triggerType,
    autoDeploy: values.autoDeploy,
  };
}

/**
 * The repository key the row already holds, in the shape the listing will use.
 *
 * It has to be reconstructed rather than stored, because the row keeps the
 * *parts* — owner, name, and for two providers a slug or a numeric id —
 * and the listing keys on the combination. Getting this wrong shows a form with
 * no repository selected on an Application that plainly has one.
 */
export function repositoryKeyOf(
  row: SourceRow,
  spec: GitProviderSpec,
): string {
  if (spec.projectIdKey) return fieldText(row, spec.projectIdKey);
  const owner = fieldText(row, spec.ownerKey);
  const name = spec.slugKey
    ? fieldText(row, spec.slugKey) || fieldText(row, spec.repositoryKey)
    : fieldText(row, spec.repositoryKey);
  return owner && name ? `${owner}/${name}` : "";
}
