import { Injectable } from '@nestjs/common';

import { BitbucketService } from '../../git-providers/strategies/bitbucket/bitbucket.service';
import type {
  ConfigReader,
  ConfigReadRequest,
  ConfigReadResult,
} from './config-reader.port';
import { encodeSegments, readOverRest } from './rest-config-read';

interface BitbucketRepository {
  mainbranch?: { name?: string } | null;
  links: { html: { href: string } };
}

/**
 * The config reader for a Bitbucket Cloud connection: the repository
 * from `GET /2.0/repositories/{workspace}/{repo_slug}` (its main branch), the
 * branch's head from `…/refs/branches/{name}`, then the file at that commit
 * from `…/src/{commit}/{path}`: first `?format=meta`, since the same URL
 * answers a directory with its listing, then the raw text. Uses the
 * connection's Basic-auth credentials, as every Bitbucket call does.
 */
@Injectable()
export class BitbucketConfigReader implements ConfigReader {
  constructor(private readonly bitbucket: BitbucketService) {}

  async read(request: ConfigReadRequest): Promise<ConfigReadResult> {
    const row = await this.bitbucket.findByGitProviderId(
      request.connection.gitProviderId,
    );
    if (!row) {
      return {
        ok: false,
        reason: 'repository-unreachable',
        branch: request.ref,
        message: `The Bitbucket connection that reached ${request.repository} is gone; connect one that does`,
      };
    }
    const repo = `/repositories/${encodeSegments(request.repository)}`;
    const src = (sha: string) =>
      `${repo}/src/${encodeURIComponent(sha)}/${encodeSegments(request.path)}`;
    return readOverRest<BitbucketRepository>(request, {
      provider: 'Bitbucket',
      repository: () => this.bitbucket.get(row, repo),
      defaultBranch: (found) => found.mainbranch?.name,
      branch: (_found, branch) =>
        this.bitbucket.get(
          row,
          `${repo}/refs/branches/${encodeSegments(branch)}`,
        ),
      headOf: (branch) =>
        (branch as { target?: { hash?: string } }).target?.hash,
      file: (_found, sha) => this.bitbucket.get(row, `${src(sha)}?format=meta`),
      textOf: async (file, _found, sha) => {
        const meta = (await file.json()) as { type?: string };
        if (meta.type !== 'commit_file') return null;
        const content = await this.bitbucket.get(row, src(sha));
        if (!content.ok) {
          throw new Error(`answered ${content.status} reading ${request.path}`);
        }
        return content.text();
      },
      fileUrl: (found, sha) =>
        `${found.links.html.href}/src/${sha}/${encodeSegments(request.path)}`,
    });
  }
}
