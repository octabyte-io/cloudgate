import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies GitHub's x-hub-signature-256 header: an HMAC-SHA256 of the raw
 * request body keyed with the webhook secret, formatted `sha256=<hex>`.
 */
/** The push webhook fields we read (trimmed shape of GitHub's payload). */
export interface GithubPushPayload {
  ref?: string;
  /** True when the push deleted the ref; `head_commit` is null then. */
  deleted?: boolean;
  installation?: { id?: number };
  repository?: {
    name?: string;
    owner?: { name?: string; login?: string };
  };
  pusher?: { name?: string };
  head_commit?: { id?: string; message?: string } | null;
  /** The pushed commits, each listing the paths it touched. */
  commits?: Array<{
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
}

/**
 * The most commits GitHub lists in one push delivery; a push of more is
 * listed in part, so its touched files are not known from the payload.
 */
export const GITHUB_PUSH_COMMITS_LISTED = 2048;

export interface GithubPushEvent {
  /** The pushed branch, or '' when the ref is not a branch (a tag push). */
  branch: string;
  repository: string;
  owner: string;
  commitHash: string;
  commitMessage: string;
  /** The push deleted the branch: there is no commit to build. */
  deleted: boolean;
  /** Who pushed, as GitHub names them; '' when the payload omits it. */
  pusher: string;
  /**
   * Every path the pushed commits added, modified or removed, or
   * `null` when the payload does not say: no `commits` list, or one GitHub
   * may have cut short. A reader of `null` assumes any file may have changed.
   */
  changedFiles: string[] | null;
}

const BRANCH_REF = 'refs/heads/';

/**
 * The push event, extracted: branch from the ref, owner preferring the
 * organization name over the login, head commit with its fallbacks.
 *
 * Only a `refs/heads/` ref names a branch. The prefix used to be stripped with
 * `replace`, which left a tag push's `refs/tags/v1` standing in as a branch
 * name; a push deploy matches on this field, so a ref that is not a
 * branch reads as none.
 */
export function parseGithubPushEvent(
  payload: GithubPushPayload,
): GithubPushEvent {
  const ref = payload.ref ?? '';
  return {
    branch: ref.startsWith(BRANCH_REF) ? ref.slice(BRANCH_REF.length) : '',
    repository: payload.repository?.name ?? '',
    owner:
      payload.repository?.owner?.name ?? payload.repository?.owner?.login ?? '',
    commitHash: payload.head_commit?.id ?? '',
    commitMessage: payload.head_commit?.message ?? 'NEW COMMIT',
    deleted: payload.deleted === true,
    pusher: payload.pusher?.name ?? '',
    changedFiles: changedFilesOf(payload.commits),
  };
}

function changedFilesOf(
  commits: GithubPushPayload['commits'],
): string[] | null {
  if (!Array.isArray(commits)) return null;
  if (commits.length >= GITHUB_PUSH_COMMITS_LISTED) return null;
  const paths = new Set<string>();
  for (const commit of commits) {
    for (const list of [commit?.added, commit?.modified, commit?.removed]) {
      if (!Array.isArray(list)) continue;
      for (const path of list) if (typeof path === 'string') paths.add(path);
    }
  }
  return [...paths];
}

/** The pull_request webhook fields we read (trimmed shape of GitHub's payload). */
export interface GithubPullRequestPayload {
  action?: string;
  installation?: { id?: number };
  repository?: {
    name?: string;
    owner?: { name?: string; login?: string };
  };
  pull_request?: {
    id?: number;
    number?: number;
    title?: string;
    html_url?: string;
    head?: { ref?: string };
    base?: { ref?: string };
    user?: { login?: string };
  };
}

/**
 * The pull_request event, extracted: the PR identity plus head/base branches,
 * owner preferring the organization name over the login like the push event.
 */
export function parseGithubPullRequestEvent(payload: GithubPullRequestPayload) {
  return {
    action: (payload.action ?? '') as
      'opened' | 'reopened' | 'synchronize' | 'closed',
    pullRequestId: String(payload.pull_request?.id ?? ''),
    pullRequestNumber: String(payload.pull_request?.number ?? ''),
    pullRequestTitle: payload.pull_request?.title ?? '',
    pullRequestURL: payload.pull_request?.html_url ?? '',
    headBranch: payload.pull_request?.head?.ref ?? '',
    baseBranch: payload.pull_request?.base?.ref ?? '',
    repository: payload.repository?.name ?? '',
    owner:
      payload.repository?.owner?.name ?? payload.repository?.owner?.login ?? '',
    prAuthor: payload.pull_request?.user?.login ?? '',
  };
}

export function verifyGithubWebhookSignature(
  secret: string,
  payload: string,
  signature: string | undefined,
): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const received = signature.slice('sha256='.length);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
