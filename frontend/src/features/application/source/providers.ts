import type { Application } from "@/lib/api/endpoints/applications";
import type { Compose } from "@/lib/api/endpoints/compose";
import type { GitProviderKind } from "@/lib/api/endpoints/git-providers";
import type { IconName } from "@/lib/design/icons";
import { hasSource } from "@/lib/format/source";

/**
 * **The four git providers, as data.**
 *
 * They differ in one thing that matters to a form: which columns on the
 * `application` row hold the answer. GitHub writes `repository` / `owner` /
 * `branch` / `buildPath`; GitLab writes `gitlabRepository` / `gitlabOwner` / …
 * and *also* a numeric `gitlabProjectId` and a `gitlabPathNamespace`; Gitea and
 * Bitbucket each have their own prefix, and Bitbucket has a second name column
 * because its API addresses a repository by slug while its UI shows a title.
 *
 * That is the entire difference. So there is one `GitSourceForm` parameterised by
 * this table rather than four near-identical files — which is what the phase
 * brief asks for, and what stops a fix landing in one provider and not the other
 * three.
 *
 * `connectionKey` is the FK to the connection row: `githubId`, `gitlabId`, and so
 * on. It is not a repository field, which is why it sits apart.
 */

export type ApplicationField = keyof Application;

/**
 * A row a source form can read: an `application`, or a `compose` (F12).
 *
 * **The two hold the git-provider columns under the same names** — `repository` /
 * `owner` / `branch` / `githubId`, `gitlabRepository` / … / `gitlabProjectId`, and
 * so on — which is what lets one form serve both and is worth stating because it
 * is the *only* reason this is a union rather than two forms. There is exactly one
 * structural difference, and `PathSpec` below is it.
 */
export type SourceRow = Application | Compose;

/**
 * Where a source form's path field is saved, and what it is called there.
 *
 * The one place the two rows disagree. An Application has a build path **per
 * provider** (`buildPath`, `gitlabBuildPath`, `giteaBuildPath`,
 * `bitbucketBuildPath`, `customGitBuildPath`) because each provider's columns are
 * independent; a Compose stack has a single `composePath` for all of them, and it
 * means something different — not where the build starts but which file *is* the
 * stack. So the column, the label and the words are a parameter, and the caller
 * that knows which row it is holding supplies them.
 */
export type PathSpec = {
  /** The column to save into, given the provider whose form is open. */
  column: (spec: GitProviderSpec) => string;
  /** The column a custom-git form saves into — there is no provider there. */
  customGitColumn: string;
  label: string;
  hint: string;
  placeholder: string;
  /** What an empty column means, sent instead of `""`. */
  fallback: string;
};

/** An Application's: a directory inside the repository, per provider. */
export const BUILD_PATH: PathSpec = {
  column: (spec) => spec.buildPathKey,
  customGitColumn: "customGitBuildPath",
  label: "Build path",
  hint: "Where in the repository the build starts. Leave it at / unless this is a monorepo.",
  placeholder: "/",
  fallback: "/",
};

export type GitProviderSpec = {
  kind: GitProviderKind;
  label: string;
  icon: IconName;
  /** Which connection this Application clones through. */
  connectionKey: ApplicationField;
  /** The repository's own name, as the row records it. */
  repositoryKey: ApplicationField;
  ownerKey: ApplicationField;
  branchKey: ApplicationField;
  buildPathKey: ApplicationField;
  /**
   * Bitbucket's slug and GitLab's path namespace: a second identifier the clone
   * needs and the display name is not. `null` where the name is enough.
   */
  slugKey: ApplicationField | null;
  /** GitLab's numeric project id — the only thing its branches route accepts. */
  projectIdKey: ApplicationField | null;
  /** What this provider calls a repository, in its own words. */
  noun: string;
  /**
   * And its plural, spelled out.
   *
   * Not `${noun}s` — that produced **"repositorys"** on screen, which is the
   * classic cost of deriving English from a singular. Two words in a table beat
   * a rule with an exception.
   */
  plural: string;
};

export const GIT_PROVIDERS: Record<GitProviderKind, GitProviderSpec> = {
  github: {
    kind: "github",
    label: "GitHub",
    icon: "branch",
    connectionKey: "githubId",
    repositoryKey: "repository",
    ownerKey: "owner",
    branchKey: "branch",
    buildPathKey: "buildPath",
    slugKey: null,
    projectIdKey: null,
    noun: "repository",
    plural: "repositories",
  },
  gitlab: {
    kind: "gitlab",
    label: "GitLab",
    icon: "branch",
    connectionKey: "gitlabId",
    repositoryKey: "gitlabRepository",
    ownerKey: "gitlabOwner",
    branchKey: "gitlabBranch",
    buildPathKey: "gitlabBuildPath",
    slugKey: "gitlabPathNamespace",
    projectIdKey: "gitlabProjectId",
    noun: "project",
    plural: "projects",
  },
  bitbucket: {
    kind: "bitbucket",
    label: "Bitbucket",
    icon: "branch",
    connectionKey: "bitbucketId",
    repositoryKey: "bitbucketRepository",
    ownerKey: "bitbucketOwner",
    branchKey: "bitbucketBranch",
    buildPathKey: "bitbucketBuildPath",
    slugKey: "bitbucketRepositorySlug",
    projectIdKey: null,
    noun: "repository",
    plural: "repositories",
  },
  gitea: {
    kind: "gitea",
    label: "Gitea",
    icon: "branch",
    connectionKey: "giteaId",
    repositoryKey: "giteaRepository",
    ownerKey: "giteaOwner",
    branchKey: "giteaBranch",
    buildPathKey: "giteaBuildPath",
    slugKey: null,
    projectIdKey: null,
    noun: "repository",
    plural: "repositories",
  },
};

export function isGitProviderKind(value: string): value is GitProviderKind {
  return value in GIT_PROVIDERS;
}

/**
 * A string field off the row, or `""` — never `null` reaching an input.
 *
 * The key is a plain `string` rather than `keyof Application` because the row may
 * be either kind (see `SourceRow`) and the *spec* is where the column names are
 * checked. One cast, in one function, instead of a union index at every call site.
 */
export function fieldText(
  row: SourceRow | undefined,
  key: string | null,
): string {
  if (!row || !key) return "";
  const value = (row as unknown as Record<string, unknown>)[key];
  return value === null || value === undefined ? "" : String(value);
}

/**
 * What this Application's source reads as in one line, whatever kind it is.
 *
 * Used by the Overview's configuration list and by the Deployments tab's empty
 * state, so the two cannot describe the same source differently. A row with
 * no source reads "Not set" rather than the type its column defaults to
 * (`hasSource`), so no caller presents the default as a choice.
 */
export function sourceSummary(application: Application): {
  label: string;
  detail: string | null;
  branch: string | null;
} {
  const { sourceType } = application;
  if (!hasSource(application)) {
    return { label: "Not set", detail: null, branch: null };
  }

  if (sourceType === "docker") {
    return {
      label: "Docker image",
      detail: application.dockerImage,
      branch: null,
    };
  }
  if (sourceType === "git") {
    return {
      label: "Custom git",
      detail: application.customGitUrl,
      branch: application.customGitBranch,
    };
  }
  if (sourceType === "drop") {
    return { label: "Uploaded files", detail: null, branch: null };
  }

  const spec = GIT_PROVIDERS[sourceType];
  const owner = fieldText(application, spec.ownerKey);
  const repository = fieldText(application, spec.repositoryKey);
  return {
    label: spec.label,
    detail: owner && repository ? `${owner}/${repository}` : repository || null,
    branch: fieldText(application, spec.branchKey) || null,
  };
}

/**
 * **What a push can deploy, as the backend delivers it** — the one rule
 * the Source cards and the source form both read, so a card that says "deploys
 * are manual" never sits over a form offering a switch.
 *
 * The one inbound trigger is the GitHub App's webhook, and
 * `DeploymentsService.deployOnGithubPush` deploys a `github` **Application**
 * on a push to its branch. Nothing else arrives: GitLab, Bitbucket and Gitea
 * have no push route, a custom git URL has no provider to push from and no
 * deploy-webhook URL to call (the `refreshToken` column is minted and never
 * checked), and no route deploys a Compose stack on a push at all. `sourceType`
 * is passed apart from the row because the form asks about the source being
 * chosen, not the one saved.
 */
export function pushCanDeploy(row: SourceRow, sourceType: string): boolean {
  return "applicationId" in row && sourceType === "github";
}

/**
 * Whether a push *will* deploy this row as saved: a source a push reaches, with
 * automatic deploys on and the Push trigger. A tag push names no branch, so
 * `deployOnGithubPush` builds nothing for it and a Tag row is manual.
 */
export function deploysOnPush(row: SourceRow): boolean {
  return (
    pushCanDeploy(row, row.sourceType) &&
    row.autoDeploy !== false &&
    row.triggerType !== "tag"
  );
}
