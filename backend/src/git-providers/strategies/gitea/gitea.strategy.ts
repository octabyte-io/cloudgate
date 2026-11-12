import { quote } from 'shell-quote';
import { gitCloneLines } from '../../git-clone-lines';
import { sourceProgram } from '../../source-program';
import type {
  GitProviderStrategy,
  SourceCommandInput,
} from '../../git-provider.strategy';
import type { SourceProgram } from '../../source-program';

/**
 * Clones over http(s) with the short-lived OAuth access token (kept fresh by
 * GiteaService.refreshToken) as the oauth2 credential. Self-hosted instances
 * keep whichever protocol their URL declares. Branch listing goes through the
 * Gitea API, not a command.
 */
export const giteaStrategy: GitProviderStrategy = {
  sourceType: 'gitea',

  cloneProgram(input: SourceCommandInput): SourceProgram {
    const { owner, repository, branch, outputPath, accessToken } = input;

    // Fail inside the deployment log with the reasons instead of producing a
    // broken git command.
    const reasons: string[] = [];
    if (!repository) reasons.push('Repository not assigned.');
    if (!owner) reasons.push('Owner not specified.');
    if (!branch) reasons.push('Branch not defined.');
    if (!accessToken) reasons.push('Access token not resolved.');
    if (reasons.length > 0) {
      return sourceProgram(
        [
          'set -e;',
          'echo "Error: ❌ Gitea repository configuration is incomplete";',
          'echo "Reasons:";',
          `echo "${reasons.join('\n')}";`,
          'exit 1;',
        ].join('\n'),
      );
    }

    const url = input.giteaUrl || 'https://gitea.com';
    const protocol = url.startsWith('http://') ? 'http' : 'https';
    const host = url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const repoPath = `${host}/${owner}/${repository}.git`;
    const cloneUrl = `${protocol}://oauth2:${accessToken}@${repoPath}`;
    return sourceProgram(
      [
        'set -e;',
        ...gitCloneLines({
          label: repoPath,
          cloneUrl,
          branch: branch ?? '',
          outputPath,
          enableSubmodules: input.enableSubmodules,
          dial: input.dial,
        }),
      ].join('\n'),
    );
  },

  listBranches(): null {
    return null;
  },

  getCommitInfo(input): string {
    return `git -C ${quote([input.outputPath])} log -1 --pretty=format:"%H---DELIMITER---%B"`;
  },
};
