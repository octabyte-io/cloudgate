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
 * GitlabService.refreshToken) as the oauth2 credential. GitLab addresses
 * repositories by path namespace, and self-hosted instances keep whichever
 * protocol their URL declares. Branch listing goes through the GitLab API, not
 * a command.
 */
export const gitlabStrategy: GitProviderStrategy = {
  sourceType: 'gitlab',

  cloneProgram(input: SourceCommandInput): SourceProgram {
    const { branch, outputPath, accessToken, gitlabPathNamespace } = input;

    // Fail inside the deployment log with the reasons instead of producing a
    // broken git command.
    const reasons: string[] = [];
    if (!input.repository) reasons.push('Repository not assigned.');
    if (!input.owner) reasons.push('Owner not specified.');
    if (!branch) reasons.push('Branch not defined.');
    if (!gitlabPathNamespace) reasons.push('Path namespace not defined.');
    if (!accessToken) reasons.push('Access token not resolved.');
    if (reasons.length > 0) {
      return sourceProgram(
        [
          'set -e;',
          'echo "Error: ❌ GitLab repository configuration is incomplete";',
          'echo "Reasons:";',
          `echo "${reasons.join('\n')}";`,
          'exit 1;',
        ].join('\n'),
      );
    }

    const url = input.gitlabUrl || 'https://gitlab.com';
    const protocol = url.startsWith('http://') ? 'http' : 'https';
    const host = url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const repoPath = `${host}/${gitlabPathNamespace}.git`;
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
