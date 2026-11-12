import { sourceTypeEnum } from '../../src/git-providers/git-provider.schema';
import type { SourceType } from '../../src/git-providers/git-provider.schema';
import type { SourceCommandInput } from '../../src/git-providers/git-provider.strategy';
import { getGitProviderStrategy } from '../../src/git-providers/git-provider.strategy';

/**
 * A source program prints a ✅ only after the step it reports has succeeded.
 *
 * The console's log tones colour any line carrying ✅ as a success, and every
 * clone program used to echo `Cloning repo … ✅` *before* `git clone` ran — so
 * a failed clone showed a green tick directly above `Permission denied`. It was
 * one mistake at six sites (the git, github, gitlab, gitea and bitbucket clones
 * and the docker pull), which is why this is a census rather than a test per
 * strategy: it enumerates `sourceTypeEnum`, so a ninth source type has to
 * declare its step here or fail to compile.
 *
 * Both directions: a program whose declared step is gone fails (the
 * declaration is stale), and so does a ✅ on any line before the step.
 */

/**
 * The line of each source program that does the work a ✅ may report: the
 * fetch, or for `raw` and `drop`, which fetch nothing, the write or the check.
 */
/**
 * A clone, with any `-c` options git is given before the subcommand — every
 * clone line runs `git -c protocol.file.allow=never clone`.
 */
const GIT_CLONE = /\bgit (?:-c \S+ )*clone\b/;

const STEP: Record<SourceType, RegExp> = {
  docker: /\bdocker pull\b/,
  git: GIT_CLONE,
  github: GIT_CLONE,
  gitlab: GIT_CLONE,
  bitbucket: GIT_CLONE,
  gitea: GIT_CLONE,
  raw: /\| base64 -d > /,
  drop: /^if \[ ! -d /,
};

/** Every field a strategy reads, filled, so no program takes its refusal path. */
const COMPLETE_INPUT: SourceCommandInput = {
  outputPath: '/etc/cloudgate/applications/app-census/code',
  url: 'https://github.com/octabyte-io/cloudgate.git',
  branch: 'main',
  content: 'services: {}',
  dockerImage: 'nginx:1.27',
  registryUrl: 'registry.example.com',
  username: 'octabyte',
  password: 'registry-password',
  owner: 'octabyte-io',
  repository: 'cloudgate',
  githubToken: 'ghs_token',
  accessToken: 'oauth-token',
  gitlabUrl: 'https://gitlab.com',
  gitlabPathNamespace: 'octabyte-io/cloudgate',
  giteaUrl: 'https://gitea.com',
  apiToken: 'bitbucket-token',
};

describe('GitProviderStrategy.cloneProgram, on where a source program may print a ✅', () => {
  const programs = sourceTypeEnum.enumValues.map((sourceType) => ({
    sourceType,
    lines: getGitProviderStrategy(sourceType)
      .cloneProgram(COMPLETE_INPUT)
      .command.split('\n'),
  }));

  it('finds the declared step in every source program', () => {
    const missing = programs
      .filter(({ sourceType, lines }) =>
        lines.every((line) => !STEP[sourceType].test(line)),
      )
      .map(({ sourceType }) => sourceType);

    expect(missing).toEqual([]);
  });

  it('prints no ✅ before the step it would report', () => {
    const early = programs.flatMap(({ sourceType, lines }) => {
      const step = lines.findIndex((line) => STEP[sourceType].test(line));
      return lines
        .slice(0, step === -1 ? lines.length : step + 1)
        .filter((line) => line.includes('✅'))
        .map((line) => `${sourceType}: ${line}`);
    });

    expect(early).toEqual([]);
  });
});
