import { Injectable } from '@nestjs/common';

import { GitlabService } from '../../git-providers/strategies/gitlab/gitlab.service';
import type {
  ConfigReader,
  ConfigReadRequest,
  ConfigReadResult,
} from './config-reader.port';
import { encodeSegments, fromBase64, readOverRest } from './rest-config-read';

interface GitlabProject {
  id: number;
  default_branch?: string | null;
  web_url: string;
}

/**
 * The config reader for a GitLab connection: the project from
 * `GET /api/v4/projects/:path` (its full path, nested groups and all,
 * URL-encoded), the branch's head from `…/repository/branches/:branch`, then
 * the file at that commit from `…/repository/files/:file_path?ref=`. Uses
 * the connection's OAuth token, refreshed first, as every GitLab call does.
 */
@Injectable()
export class GitlabConfigReader implements ConfigReader {
  constructor(private readonly gitlab: GitlabService) {}

  async read(request: ConfigReadRequest): Promise<ConfigReadResult> {
    const row = await this.gitlab.findByGitProviderId(
      request.connection.gitProviderId,
    );
    if (!row) {
      return {
        ok: false,
        reason: 'repository-unreachable',
        branch: request.ref,
        message: `The GitLab connection that reached ${request.repository} is gone; connect one that does`,
      };
    }
    const project = `/api/v4/projects/${encodeURIComponent(request.repository)}`;
    return readOverRest<GitlabProject>(request, {
      provider: 'GitLab',
      repository: () => this.gitlab.get(row, project),
      defaultBranch: (found) => found.default_branch,
      branch: (found, branch) =>
        this.gitlab.get(
          row,
          `/api/v4/projects/${found.id}/repository/branches/${encodeURIComponent(branch)}`,
        ),
      headOf: (branch) => (branch as { commit?: { id?: string } }).commit?.id,
      file: (found, sha) =>
        this.gitlab.get(
          row,
          `/api/v4/projects/${found.id}/repository/files/${encodeURIComponent(request.path)}?ref=${encodeURIComponent(sha)}`,
        ),
      textOf: async (file) => {
        const body = (await file.json()) as {
          encoding?: string;
          content?: string;
        };
        return body.encoding === 'base64' && typeof body.content === 'string'
          ? fromBase64(body.content)
          : null;
      },
      fileUrl: (found, sha) =>
        `${found.web_url}/-/blob/${sha}/${encodeSegments(request.path)}`,
    });
  }
}
