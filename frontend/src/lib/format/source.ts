import type { Application, SourceType } from "@/lib/api/endpoints/applications";
import type { ComposeSourceType } from "@/lib/api/endpoints/compose";

/**
 * The column each source type reads its source from — a repository for the
 * four providers, a URL, an image, or the upload's build path for `drop` (the
 * upload route is that column's only writer). `raw` is absent: a stack whose
 * source is its own file always has one.
 */
export const SOURCE_COLUMN = {
  github: "repository",
  gitlab: "gitlabRepository",
  gitea: "giteaRepository",
  bitbucket: "bitbucketRepository",
  git: "customGitUrl",
  docker: "dockerImage",
  drop: "dropBuildPath",
} as const satisfies Record<SourceType, keyof Application>;

type SourceColumn = (typeof SOURCE_COLUMN)[keyof typeof SOURCE_COLUMN];

/**
 * Whether an Application or a Compose stack has had a source chosen at all.
 *
 * `source_type` defaults to `github` on both tables, so a row fresh from create
 * says GitHub with no repository behind it — the type alone cannot tell a
 * choice from a column default, and the column the type reads from can. The
 * deploy path refuses on the same rule (`backend/src/deployments/missing-source.ts`),
 * so a card that says "not set" and a Deploy that is refused agree.
 *
 * Here rather than in `features/application/source/` because the Compose
 * Source card and summary ask it too (CODING_STANDARDS §1.4's promotion rule).
 */
export function hasSource(
  row: { sourceType: SourceType | ComposeSourceType } & Partial<
    Record<SourceColumn, string | null>
  >,
): boolean {
  if (row.sourceType === "raw") return true;
  const value = row[SOURCE_COLUMN[row.sourceType]];
  return typeof value === "string" && value.trim() !== "";
}
