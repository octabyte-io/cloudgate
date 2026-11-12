import { Injectable } from '@nestjs/common';

import { GiteaService } from '../../git-providers/strategies/gitea/gitea.service';
import type {
  ConfigReader,
  ConfigReadRequest,
  ConfigReadResult,
} from './config-reader.port';
import { encodeSegments, fromBase64, readOverRest } from './rest-config-read';

interface GiteaRepository {
  default_branch?: string | null;
  html_url: string;
}

/**
 * The config reader for a Gitea connection: the repository from
 * `GET /api/v1/repos/{owner}/{repo}`, the branch's head from
 * `…/branches/{branch}`, then the file at that commit from
 * `…/contents/{filepath}?ref=`. Uses the connection's OAuth token, refreshed
 * first, as every Gitea call does.
 */
@Injectable()
export class GiteaConfigReader implements ConfigReader {
  constructor(private readonly gitea: GiteaService) {}

  async read(request: ConfigReadRequest): Promise<ConfigReadResult> {
    const row = await this.gitea.findByGitProviderId(
      request.connection.gitProviderId,
    );
    if (!row) {
      return {
        ok: false,
        reason: 'repository-unreachable',
        branch: request.ref,
        message: `The Gitea connection that reached ${request.repository} is gone; connect one that does`,
      };
    }
    const repo = `/api/v1/repos/${encodeSegments(request.repository)}`;
    return readOverRest<GiteaRepository>(request, {
      provider: 'Gitea',
      repository: () => this.gitea.get(row, repo),
      defaultBranch: (found) => found.default_branch,
      branch: (_found, branch) =>
        this.gitea.get(row, `${repo}/branches/${encodeSegments(branch)}`),
      headOf: (branch) => (branch as { commit?: { id?: string } }).commit?.id,
      file: (_found, sha) =>
        this.gitea.get(
          row,
          `${repo}/contents/${encodeSegments(request.path)}?ref=${encodeURIComponent(sha)}`,
        ),
      textOf: async (file) => {
        // An array is a directory's listing; a symlink or submodule is no file.
        const body = (await file.json()) as
          | { type?: string; encoding?: string | null; content?: string | null }
          | unknown[];
        if (Array.isArray(body) || body.type !== 'file') return null;
        return body.encoding === 'base64' && typeof body.content === 'string'
          ? fromBase64(body.content)
          : null;
      },
      fileUrl: (found, sha) =>
        `${found.html_url}/src/commit/${sha}/${encodeSegments(request.path)}`,
    });
  }
}
