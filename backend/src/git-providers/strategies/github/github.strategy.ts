import { quote } from 'shell-quote';
import { gitCloneLines } from '../../git-clone-lines';
import { sourceProgram } from '../../source-program';
import type {
  GitProviderStrategy,
  SourceCommandInput,
} from '../../git-provider.strategy';
import type { SourceProgram } from '../../source-program';

/**
 * Clones over https with a short-lived installation token (minted by
 * GithubService.getGithubToken) as the oauth2 credential. Branch listing goes
 * through the GitHub API, not a command.
 */
export const githubStrategy: GitProviderStrategy = {
  sourceType: 'github',

  cloneProgram(input: SourceCommandInput): SourceProgram {
    const { owner, repository, branch, outputPath, githubToken } = input;

    // Fail inside the deployment log with the reasons instead of producing a
    // broken git command.
    const reasons: string[] = [];
    if (!repository) reasons.push('Repository not assigned.');
    if (!owner) reasons.push('Owner not specified.');
    if (!branch) reasons.push('Branch not defined.');
    if (!githubToken) reasons.push('Installation token not resolved.');
    if (reasons.length > 0) {
      return sourceProgram(
        [
          'set -e;',
          'echo "Error: ❌ GitHub repository configuration is incomplete";',
          'echo "Reasons:";',
          `echo "${reasons.join('\n')}";`,
          'exit 1;',
        ].join('\n'),
      );
    }

    const repoPath = `github.com/${owner}/${repository}.git`;
    const cloneUrl = `https://oauth2:${githubToken}@${repoPath}`;
    return sourceProgram(
      [
        'set -e;',
        ...gitCloneLines({
          label: repoPath,
          cloneUrl,
          branch: branch ?? '',
          outputPath,
          enableSubmodules: input.enableSubmodules,
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
