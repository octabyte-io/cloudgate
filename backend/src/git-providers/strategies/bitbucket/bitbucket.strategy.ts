import { quote } from 'shell-quote';
import { gitCloneLines } from '../../git-clone-lines';
import { sourceProgram } from '../../source-program';
import type {
  GitProviderStrategy,
  SourceCommandInput,
} from '../../git-provider.strategy';
import type { SourceProgram } from '../../source-program';

/**
 * Clones over https with whichever Basic-auth credential the connection
 * carries: an Atlassian API token as the x-bitbucket-api-token-auth user, or
 * username + app password. Branch listing goes through the Bitbucket API, not a
 * command.
 */
export const bitbucketStrategy: GitProviderStrategy = {
  sourceType: 'bitbucket',

  cloneProgram(input: SourceCommandInput): SourceProgram {
    const { owner, repository, branch, outputPath } = input;
    const { apiToken, username, appPassword } = input;

    // Fail inside the deployment log with the reasons instead of producing a
    // broken git command.
    const reasons: string[] = [];
    if (!repository) reasons.push('Repository not assigned.');
    if (!owner) reasons.push('Owner not specified.');
    if (!branch) reasons.push('Branch not defined.');
    if (!apiToken && !(username && appPassword)) {
      reasons.push('Credentials not resolved.');
    }
    if (reasons.length > 0) {
      return sourceProgram(
        [
          'set -e;',
          'echo "Error: ❌ Bitbucket repository configuration is incomplete";',
          'echo "Reasons:";',
          `echo "${reasons.join('\n')}";`,
          'exit 1;',
        ].join('\n'),
      );
    }

    const repoPath = `bitbucket.org/${owner}/${repository}.git`;
    const credentials = apiToken
      ? `x-bitbucket-api-token-auth:${apiToken}`
      : `${username}:${appPassword}`;
    const cloneUrl = `https://${credentials}@${repoPath}`;
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
