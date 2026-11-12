import type { ConfigReadRequest, ConfigReadResult } from './config-reader.port';

/**
 * One provider's REST calls for a config read, each answered as the
 * provider answered it. `R` is the repository's JSON body.
 */
export interface RestReadCalls<R> {
  /** As an operator knows it: `GitLab`. */
  readonly provider: string;
  /** The repository itself: a 404 is "unreachable". */
  repository(): Promise<Response>;
  defaultBranch(repository: R): string | null | undefined;
  /** One branch: a 404 is "branch missing". */
  branch(repository: R, branch: string): Promise<Response>;
  /** The branch's head commit, from its JSON body. */
  headOf(branch: unknown): string | null | undefined;
  /** The file at that commit: a 404 is "file missing". */
  file(repository: R, commitSha: string): Promise<Response>;
  /** The file's text from its (2xx) answer; `null` when it is no file. */
  textOf(
    file: Response,
    repository: R,
    commitSha: string,
  ): Promise<string | null>;
  fileUrl(repository: R, commitSha: string): string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const answered = (response: Response) =>
  `answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;

/** Base64 as GitLab and Gitea send it (line breaks tolerated), as UTF-8. */
export const fromBase64 = (content: string) =>
  Buffer.from(content, 'base64').toString('utf8');

/** Each segment of a path encoded, its slashes kept: `deploy/cloud%20gate.yaml`. */
export const encodeSegments = (path: string) =>
  path.split('/').map(encodeURIComponent).join('/');

/**
 * The read every REST provider shares (GitHub's flow, and GitLab's, Gitea's and Bitbucket's): the
 * repository (its default branch, and what tells an unreachable repository
 * from a missing branch), the branch's head commit, then the file **at that
 * commit**, so the text and the sha always agree. A provider failure is a
 * typed refusal, never a throw: any answer but the expected 404s, and any
 * error (a token that cannot be refreshed, a network failure), is
 * `repository-unreachable`.
 */
export async function readOverRest<R>(
  request: ConfigReadRequest,
  calls: RestReadCalls<R>,
): Promise<ConfigReadResult> {
  const { repository, path } = request;
  const { provider } = calls;
  const refuse = (
    reason: Extract<ConfigReadResult, { ok: false }>['reason'],
    branch: string | null,
    message: string,
  ): ConfigReadResult => ({ ok: false, reason, branch, message });
  const unreachable = (branch: string | null, why: string) =>
    refuse(
      'repository-unreachable',
      branch,
      `${provider} repository ${repository} could not be reached: ${why}`,
    );

  let branch: string | null = request.ref;
  try {
    const found = await calls.repository();
    if (found.status === 404) {
      return refuse(
        'repository-unreachable',
        branch,
        `${provider} repository ${repository} does not exist or the connection cannot reach it`,
      );
    }
    if (!found.ok) return unreachable(branch, answered(found));
    const repo = (await found.json()) as R;
    branch = request.ref ?? calls.defaultBranch(repo) ?? null;
    if (branch === null) {
      // A repository with no commits has no default branch to read.
      return refuse(
        'branch-missing',
        null,
        `${provider} repository ${repository} has no default branch yet`,
      );
    }

    const head = await calls.branch(repo, branch);
    if (head.status === 404) {
      return refuse(
        'branch-missing',
        branch,
        `${provider} repository ${repository} has no branch ${branch}`,
      );
    }
    if (!head.ok) return unreachable(branch, answered(head));
    const commitSha = calls.headOf(await head.json());
    if (!commitSha) {
      return unreachable(branch, `no head commit for branch ${branch}`);
    }

    const missing = refuse(
      'file-missing',
      branch,
      `There is no file ${path} in ${provider} repository ${repository} on branch ${branch}`,
    );
    const file = await calls.file(repo, commitSha);
    if (file.status === 404) return missing;
    if (!file.ok) return unreachable(branch, answered(file));
    const text = await calls.textOf(file, repo, commitSha);
    if (text === null) return missing;
    return {
      ok: true,
      text,
      commitSha,
      branch,
      fileUrl: calls.fileUrl(repo, commitSha),
    };
  } catch (error) {
    return unreachable(branch, messageOf(error));
  }
}
