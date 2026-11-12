import { Injectable } from '@nestjs/common';

import { GithubService } from '../../git-providers/strategies/github/github.service';
import type {
  ConfigReader,
  ConfigReadRequest,
  ConfigReadResult,
} from './config-reader.port';

/** GitHub's own status on a failed request, as octokit's RequestError carries it. */
function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The config reader for a GitHub connection: the repository's
 * default branch from `GET /repos/{owner}/{repo}` (which is also what tells
 * an unreachable repository from a missing branch), the branch's head commit
 * from `GET /repos/{owner}/{repo}/branches/{branch}`, then the file at that
 * commit from the contents API, so the text and the sha always agree. Uses
 * the connection's app installation, as every other GitHub call does.
 */
@Injectable()
export class GithubConfigReader implements ConfigReader {
  constructor(private readonly github: GithubService) {}

  async read(request: ConfigReadRequest): Promise<ConfigReadResult> {
    const { repository, path } = request;
    const refuse = (
      reason: Extract<ConfigReadResult, { ok: false }>['reason'],
      branch: string | null,
      message: string,
    ): ConfigReadResult => ({ ok: false, reason, branch, message });

    const row = await this.github.findByGitProviderId(
      request.connection.gitProviderId,
    );
    if (!row) {
      return refuse(
        'repository-unreachable',
        request.ref,
        `The GitHub connection that reached ${repository} is gone; connect one that does`,
      );
    }
    const slash = repository.indexOf('/');
    const owner = repository.slice(0, slash);
    const repo = repository.slice(slash + 1);

    let octokit: ReturnType<GithubService['client']>;
    let defaultBranch: string;
    try {
      octokit = this.github.client(row);
      const { data } = await octokit.rest.repos.get({ owner, repo });
      defaultBranch = data.default_branch;
    } catch (error) {
      return refuse(
        'repository-unreachable',
        request.ref,
        statusOf(error) === 404
          ? `GitHub repository ${repository} does not exist or the connection cannot reach it`
          : `GitHub repository ${repository} could not be reached: ${messageOf(error)}`,
      );
    }

    const branch = request.ref ?? defaultBranch;
    let commitSha: string;
    try {
      const { data } = await octokit.rest.repos.getBranch({
        owner,
        repo,
        branch,
      });
      commitSha = data.commit.sha;
    } catch (error) {
      return statusOf(error) === 404
        ? refuse(
            'branch-missing',
            branch,
            `GitHub repository ${repository} has no branch ${branch}`,
          )
        : refuse(
            'repository-unreachable',
            branch,
            `GitHub repository ${repository} could not be reached: ${messageOf(error)}`,
          );
    }

    const missing = refuse(
      'file-missing',
      branch,
      `There is no file ${path} in GitHub repository ${repository} on branch ${branch}`,
    );
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: commitSha,
      });
      // An array is a directory's listing; a symlink or submodule is no file.
      if (Array.isArray(data) || data.type !== 'file') return missing;
      const file = data as { content?: string; encoding?: string };
      if (file.encoding !== 'base64' || typeof file.content !== 'string') {
        // GitHub sends no body for a file over 1 MB; a config is far smaller.
        return refuse(
          'file-missing',
          branch,
          `${path} in GitHub repository ${repository} on branch ${branch} is too large to be a Project config`,
        );
      }
      return {
        ok: true,
        text: Buffer.from(file.content, 'base64').toString('utf8'),
        commitSha,
        branch,
        fileUrl: `https://github.com/${owner}/${repo}/blob/${commitSha}/${path}`,
      };
    } catch (error) {
      return statusOf(error) === 404
        ? missing
        : refuse(
            'repository-unreachable',
            branch,
            `GitHub repository ${repository} could not be reached: ${messageOf(error)}`,
          );
    }
  }
}
