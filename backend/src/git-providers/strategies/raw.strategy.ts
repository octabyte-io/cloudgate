import { quote } from 'shell-quote';
import { encodeBase64 } from '../../docker/docker.utils';
import { sourceProgram } from '../source-program';
import type {
  GitProviderStrategy,
  SourceCommandInput,
} from '../git-provider.strategy';
import type { SourceProgram } from '../source-program';

/** Inline file content, no repository. */
export const rawStrategy: GitProviderStrategy = {
  sourceType: 'raw',

  // Base64 keeps quotes, `$`, and newlines in the content from being
  // interpreted by the shell. The base64 covers the *content*; the path it
  // lands on is a separate word and is quoted like every other value word.
  // `fileName` is not the compose row's `composePath`, as this comment
  // used to claim: the one caller (`deployment-engine.service.ts`) passes a
  // literal, which is why the clone step lands on `docker-compose.yml` whatever
  // the column says.
  cloneProgram(input: SourceCommandInput): SourceProgram {
    const { outputPath, content, fileName = 'docker-compose.yml' } = input;
    return sourceProgram(
      [
        'set -e;',
        `rm -rf ${quote([outputPath])};`,
        `mkdir -p ${quote([outputPath])};`,
        `echo "${encodeBase64(content ?? '')}" | base64 -d > ${quote([`${outputPath}/${fileName}`])};`,
        `echo ${quote([`File '${fileName}' created: ✅`])};`,
      ].join('\n'),
    );
  },

  listBranches(): null {
    return null;
  },

  getCommitInfo(): null {
    return null;
  },
};
