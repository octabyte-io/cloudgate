import type { Compose, ComposeSourceType } from "@/lib/api/endpoints/compose";
import type { IconName } from "@/lib/design/icons";
import { hasSource } from "@/lib/format/source";
import {
  fieldText,
  GIT_PROVIDERS,
  isGitProviderKind,
  type PathSpec,
} from "@/features/application/source/providers";

/**
 * Where a Compose stack's file comes from, as data.
 *
 * **Six types, and all six are offered** — which is the difference from F09's
 * source card, where `drop` is absent because no endpoint accepts an archive.
 * A stack's six are the shared `source_type` enum minus `docker` (an image is not
 * a stack) and `drop`, and `updateComposeSchema`'s own `sourceType` enum refuses
 * both. The sixth, `raw`, is the one an Application does not have and it is the
 * interesting one: the file is stored *in Cloudgate*, in the
 * `composeFile` column, so the editor on the Overview tab is the source.
 */

/**
 * The path field, for a stack.
 *
 * An Application's build path is a *directory inside* the repository; a stack's
 * `composePath` is **which file is the stack**, and it is one column rather than
 * one per provider. That difference is the whole of `PathSpec`
 * (`features/application/source/providers.ts`).
 *
 * `updateComposeSchema` types it `z.string().min(1)`, so an empty box is refused
 * by the backend — the fallback is what gets sent instead, and it is the same
 * value the column defaults to.
 */
export const COMPOSE_PATH: PathSpec = {
  column: () => "composePath",
  customGitColumn: "composePath",
  label: "Compose file",
  hint: "Where the file sits in the repository, from its root. The deploy runs against this file.",
  placeholder: "./docker-compose.yml",
  fallback: "./docker-compose.yml",
};

export const COMPOSE_SOURCES: readonly ComposeSourceType[] = [
  "raw",
  "github",
  "gitlab",
  "bitbucket",
  "gitea",
  "git",
];

export const COMPOSE_SOURCE_META: Record<
  ComposeSourceType,
  { title: string; description: string; icon: IconName }
> = {
  raw: {
    title: "A file written here",
    description:
      "The compose file is stored in Cloudgate and edited on this screen. Nothing is cloned.",
    icon: "pencil",
  },
  github: {
    title: "GitHub",
    description: "The file comes from a repository a connected GitHub account can reach.",
    icon: "branch",
  },
  gitlab: {
    title: "GitLab",
    description: "From a project on gitlab.com or your own GitLab.",
    icon: "branch",
  },
  bitbucket: {
    title: "Bitbucket",
    description: "From a repository in a Bitbucket workspace.",
    icon: "branch",
  },
  gitea: {
    title: "Gitea",
    description: "From a repository on a Gitea instance you run.",
    icon: "branch",
  },
  git: {
    title: "Any git URL",
    description: "Cloned from a URL you give, with an SSH key if it is private.",
    icon: "net",
  },
};

/** What the summary reads as for a stack {@link hasSource} says has none. */
const UNSET_SOURCE = {
  label: "Not set",
  detail: null,
  branch: null,
} as const;

/**
 * What this stack's source reads as in one line.
 *
 * Read by the Overview's source card, the Deployments tab's empty state and the
 * editor card, so the three cannot describe the same source differently. Kept
 * apart from F09's `sourceSummary` rather than merged with it: the two describe
 * *different sets* — that one knows about `docker` and `drop` and this one knows
 * about `raw` — and a shared function would have to accept keys neither row can
 * hold. What they do share is `hasSource`: a stack created "From a repository"
 * keeps the column's `github` default with no repository, and reads "Not set"
 * here rather than GitHub on the Source and Stack cards.
 */
export function composeSourceSummary(row: Compose): {
  label: string;
  detail: string | null;
  branch: string | null;
} {
  if (!hasSource(row)) return UNSET_SOURCE;
  if (row.sourceType === "raw") {
    return { label: COMPOSE_SOURCE_META.raw.title, detail: null, branch: null };
  }
  if (row.sourceType === "git") {
    return {
      label: COMPOSE_SOURCE_META.git.title,
      detail: row.customGitUrl,
      branch: row.customGitBranch,
    };
  }

  const spec = GIT_PROVIDERS[row.sourceType];
  const owner = fieldText(row, spec.ownerKey);
  const repository = fieldText(row, spec.repositoryKey);
  return {
    label: spec.label,
    detail: owner && repository ? `${owner}/${repository}` : repository || null,
    branch: fieldText(row, spec.branchKey) || null,
  };
}

/** Whether the file is stored here, or cloned from somewhere. */
export function isRawSource(row: Compose): boolean {
  return row.sourceType === "raw";
}

export { isGitProviderKind };
