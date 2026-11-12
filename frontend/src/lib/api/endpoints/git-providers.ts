import { api } from "../client";

/**
 * The four git providers, as one surface.
 *
 * `git-providers.controller.ts` holds the base rows and each strategy has its
 * own controller — `/github`, `/gitlab`, `/gitea`, `/bitbucket` — with the same
 * three reads on it: list the connections, list a connection's repositories, list
 * a repository's branches. **They differ in exactly two ways**, and both are
 * captured in `REPOSITORY_ADAPTER` below rather than in four copies of a form:
 *
 * 1. **How a repository is addressed.** GitHub and Gitea take `{owner, repo}`,
 *    Bitbucket takes `{owner, repo}` where `repo` is the *slug*, and GitLab takes
 *    a numeric `{projectId}` — because that is what its branches API accepts.
 * 2. **Which columns on the `application` row hold the answer.** `repository` /
 *    `owner` / `branch` for GitHub, `gitlabRepository` / `gitlabOwner` / … for
 *    GitLab, and so on. That mapping belongs to the form, and lives in
 *    `features/application/source/providers.ts`.
 *
 * **F15 added the third difference and the writes.** Creating and editing a
 * connection is `POST /<kind>` and `PATCH /<kind>/:id`, each with its own
 * credential shape; **deleting is not** — there is no `DELETE` on any strategy
 * controller and removal goes through `DELETE /git-providers/:id`, on the *base*
 * row's id rather than the strategy row's. Which is why `GitConnection` carries
 * both ids and why `connectionId` has a sibling below.
 *
 * **The fourth difference arrived with
 * Three of the four
 * can now be connected by being sent to the provider.** Those routes are not on
 * the strategy controllers at all — each of those ends in `GET /:id`, which would
 * shadow a `GET /callback` — so they live under `/git-providers/oauth/…` and are
 * grouped in `oauthApi` at the bottom of this file. Bitbucket has no OAuth flow
 * here: an Atlassian API token is the credential, and pasting it is the flow.
 */

export type GitProviderKind = "github" | "gitlab" | "bitbucket" | "gitea";

/** The base `git_provider` row every connection hangs off. */
export interface GitProvider {
  gitProviderId: string;
  name: string;
  providerType: GitProviderKind;
  createdAt: string;
  organizationId: string;
}

/**
 * A connection, in the shape every strategy's `list()` answers with: the
 * strategy's own row, its secrets removed, plus the base row for the name.
 *
 * The strategy id is under a different key per provider (`githubId`,
 * `gitlabId`, …), which is why `connectionId` exists — one accessor instead of a
 * conditional at every call site.
 */
export interface GitConnection {
  gitProviderId: string;
  gitProvider: GitProvider;
  githubId?: string;
  gitlabId?: string;
  giteaId?: string;
  bitbucketId?: string;
  /** GitHub only, and the honest answer to "can this connection clone yet". */
  installationId?: string | null;
  /** GitLab and Gitea are self-hostable, so the host is part of the identity. */
  gitlabUrl?: string;
  giteaUrl?: string;
  bitbucketWorkspaceName?: string | null;

  // The rest of what each strategy's `sanitize()` returns, declared by F15
  // because an edit form has to start from the stored values. **No secret is
  // declared here, and none arrives.** `github.webhookSecret` used to be the
  // exception — a plain `text` column that no sanitizer stripped, so `GET /github`
  // sent the value that makes an inbound delivery provable. It is `encryptedText`
  // now and `sanitize()` names it alongside the private key and the client secret
  // Not declaring the
  // secrets stays F09's and F13's narrowing: this type is the reason nothing in the
  // app can render or forward one by accident, whatever a route ever sends.
  appName?: string | null;
  appId?: number | null;
  clientId?: string | null;
  gitlabInternalUrl?: string | null;
  giteaInternalUrl?: string | null;
  applicationId?: string | null;
  redirectUri?: string | null;
  groupName?: string | null;
  scopes?: string | null;
  /** Unix seconds. Null on a connection whose token was never granted. */
  expiresAt?: number | null;
  bitbucketUsername?: string | null;
  bitbucketEmail?: string | null;
}

/**
 * The two ids a connection has, and which route wants which.
 *
 * `connectionId` is the **strategy** row's — `PATCH /gitea/:id`,
 * `GET /gitea/:id/repositories`. `gitProviderId` is the **base** row's, and it
 * is the only one `DELETE /git-providers/:id` accepts. Getting them the wrong
 * way round 404s, which is a confusing way to be told a connection exists.
 */

const ID_KEY: Record<GitProviderKind, keyof GitConnection> = {
  github: "githubId",
  gitlab: "gitlabId",
  gitea: "giteaId",
  bitbucket: "bitbucketId",
};

/** The strategy row's own id, whichever key this provider files it under. */
export function connectionId(
  kind: GitProviderKind,
  connection: GitConnection,
): string {
  return String(connection[ID_KEY[kind]] ?? "");
}

/**
 * A repository, normalised.
 *
 * `key` is what the *branch* request needs and nothing else — a numeric project
 * id for GitLab, a slug for Bitbucket, the repository name elsewhere. It is a
 * string here because it goes into a `<Select>`'s value and a query key, and a
 * number that round-trips through both is a number that eventually arrives as
 * `"12"` anyway.
 */
export interface SourceRepository {
  /** Unique within one connection. Used as the option's value. */
  key: string;
  name: string;
  owner: string;
  /** GitLab's `pathNamespace`, which is what a clone URL is built from. */
  pathNamespace?: string;
  /** Bitbucket's slug, which is what its API addresses the repository by. */
  slug?: string;
  /** GitLab's numeric project id — the only id its branches route accepts. */
  projectId?: number;
}

export interface SourceBranch {
  name: string;
  commitSha: string;
}

/** The raw shapes, per provider, exactly as each strategy's DTO declares them. */
interface GithubRepository {
  name: string;
  owner: string;
  url: string;
}
interface GitlabRepository {
  id: number;
  name: string;
  owner: string;
  pathNamespace: string;
}
interface GiteaRepository {
  id: number;
  name: string;
  owner: string;
  url: string;
}
interface BitbucketRepository {
  name: string;
  slug: string;
  owner: string;
  url: string;
}

/**
 * The two provider-shaped decisions, in one table: how a listed repository
 * becomes a `SourceRepository`, and what its branch request asks for.
 */
const REPOSITORY_ADAPTER: Record<
  GitProviderKind,
  {
    toRepository: (raw: unknown) => SourceRepository;
    branchQuery: (repository: SourceRepository) => Record<string, string>;
  }
> = {
  github: {
    toRepository: (raw) => {
      const it = raw as GithubRepository;
      return { key: `${it.owner}/${it.name}`, name: it.name, owner: it.owner };
    },
    branchQuery: (repository) => ({
      owner: repository.owner,
      repo: repository.name,
    }),
  },
  gitlab: {
    toRepository: (raw) => {
      const it = raw as GitlabRepository;
      return {
        key: String(it.id),
        name: it.name,
        owner: it.owner,
        pathNamespace: it.pathNamespace,
        projectId: it.id,
      };
    },
    branchQuery: (repository) => ({ projectId: String(repository.projectId) }),
  },
  gitea: {
    toRepository: (raw) => {
      const it = raw as GiteaRepository;
      return { key: `${it.owner}/${it.name}`, name: it.name, owner: it.owner };
    },
    branchQuery: (repository) => ({
      owner: repository.owner,
      repo: repository.name,
    }),
  },
  bitbucket: {
    toRepository: (raw) => {
      const it = raw as BitbucketRepository;
      return {
        key: `${it.owner}/${it.slug}`,
        name: it.name,
        owner: it.owner,
        slug: it.slug,
      };
    },
    // Bitbucket addresses a repository by its slug, not its display name — the
    // two differ the moment a repository is called "Web Store".
    branchQuery: (repository) => ({
      owner: repository.owner,
      repo: repository.slug ?? repository.name,
    }),
  },
};

export const gitProvidersApi = {
  /** Every connected provider, base rows only. F15 owns the screen for these. */
  list: () => api.get<GitProvider[]>("/git-providers"),

  /** The connections of one kind, which is what a source picker offers. */
  connections: (kind: GitProviderKind) =>
    api.get<GitConnection[]>(`/${kind}`),

  repositories: async (
    kind: GitProviderKind,
    id: string,
  ): Promise<SourceRepository[]> => {
    const raw = await api.get<unknown[]>(`/${kind}/${id}/repositories`);
    return raw.map(REPOSITORY_ADAPTER[kind].toRepository);
  },

  branches: (
    kind: GitProviderKind,
    id: string,
    repository: SourceRepository,
  ) =>
    api.get<SourceBranch[]>(`/${kind}/${id}/branches`, {
      query: REPOSITORY_ADAPTER[kind].branchQuery(repository),
    }),

  /**
   * Connect one. The body is the strategy's own credentials plus `name`, which
   * names the **base** row — so the same key means the same thing on all four.
   */
  create: (kind: GitProviderKind, body: Record<string, unknown>) =>
    api.post<GitConnection>(`/${kind}`, body),

  /** Partial. Omitting a credential keeps the stored one. */
  update: (
    kind: GitProviderKind,
    connection: string,
    body: Record<string, unknown>,
  ) => api.patch<GitConnection>(`/${kind}/${connection}`, body),

  /**
   * **Not `DELETE /<kind>/:id`** — no strategy controller has one. Removal is on
   * the base row, and the strategy row goes with it through the FK cascade.
   */
  remove: (gitProviderId: string) =>
    api.delete<GitProvider>(`/git-providers/${gitProviderId}`),
};

/** The two providers reached by a redirect-and-come-back handshake. */
export type OauthProviderKind = "gitlab" | "gitea";

/**
 * What starting the GitHub App flow answers with.
 *
 * `manifest` has to be **POSTed by the browser** to `action` as a form field
 * called `manifest` — GitHub answers that request with its own app-creation
 * form, pre-filled from the manifest, and then redirects back with a one-time
 * code. So this cannot be a `fetch`: the navigation is the mechanism.
 */
export interface GithubManifestStart {
  /** The connection row the app's credentials will land on. */
  githubId: string;
  gitProviderId: string;
  /** Already on `action`. Returned so the caller can prove the round trip. */
  state: string;
  action: string;
  manifest: Record<string, unknown>;
}

/** What starting a GitLab or Gitea authorization answers with. */
export interface OauthAuthorizeStart {
  state: string;
  /** The provider's own authorize page. Navigate to it. */
  url: string;
  /**
   * The callback URL this handshake uses, which the OAuth application at the
   * provider must have registered. Shown rather than left to be guessed.
   */
  redirectUri: string;
}

/**
 * **Being sent to the provider instead of pasting its credentials**.
 *
 * Only the *starting* halves are here. The return legs — `/github/setup`,
 * `/github/callback`, `/<kind>/callback` — are navigations a provider makes, not
 * requests this app issues, so they have no client here by design. They finish by
 * redirecting the browser back to this screen with `?connected=<kind>`.
 */
export const gitProviderOauthApi = {
  /**
   * Creates an empty connection and returns the manifest for a new GitHub App.
   * The app does not exist yet — the browser's POST to `action` creates it.
   */
  startGithubApp: (body: {
    name: string;
    appName?: string;
    organizationName?: string;
  }) =>
    api.post<GithubManifestStart>(
      "/git-providers/oauth/github/manifest",
      body,
    ),

  /**
   * Where to send the browser to authorize an existing OAuth application. The
   * application itself still has to be registered at the provider by hand; what
   * this obtains is the *grant* — including the expiry, which is the value
   * GitLab's refresh path demands and nothing else ever recorded.
   */
  authorize: (kind: OauthProviderKind, connection: string) =>
    api.post<OauthAuthorizeStart>(
      `/git-providers/oauth/${kind}/${connection}/authorize`,
      {},
    ),
};
