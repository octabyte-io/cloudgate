import { dockerLoginCommand } from '../../registries/registry.utils';
import type {
  GitProviderStrategy,
  SourceCommandInput,
} from '../git-provider.strategy';
import type { SourceProgram } from '../source-program';

/** Single-quote for the shell; an empty or missing value becomes `''`. */
const shEscape = (s: string | null | undefined): string => {
  if (!s) return "''";
  return `'${s.replace(/'/g, `'\\''`)}'`;
};

/**
 * The variable this strategy's pull credential arrives in — `application.password`
 * for a private image, carried off the command line.
 *
 * A machine-made *holder* rather than the operator's own name, on
 * `builders/build-env.ts`' argument: it keeps operator-chosen names out of the
 * build shell's environment, where `PATH` and `LD_PRELOAD` are live, and it is
 * valid by construction against `RemoteExecService`'s `ENV_NAME`
 * (`[A-Za-z_][A-Za-z0-9_]*`), which is stricter than what a column admits.
 *
 * Un-indexed where a build's holders are numbered, because there is exactly one
 * per clone: a `docker` source has one image and one credential. The prefix is
 * deliberately not `CG_REGISTRY_PASSWORD`, which
 * `DeploymentEngineService.uploadImageCommands` uses for the *push* credentials.
 * A docker source no longer pushes, so today the two never share a
 * program; the namespaces stay apart so a future caller composing both cannot
 * have one overwrite the other.
 */
const PULL_PASSWORD_HOLDER = 'CG_SOURCE_REGISTRY_PASSWORD';

/** A prebuilt image instead of a repo. */
export const dockerStrategy: GitProviderStrategy = {
  sourceType: 'docker',

  cloneProgram(input: SourceCommandInput): SourceProgram {
    const { dockerImage, registryUrl, username, password, platform } = input;
    const lines = ['set -e;'];
    const env: Record<string, string> = {};

    if (!dockerImage) {
      lines.push('echo "Error: ❌ Docker image not found"; exit 1;');
      return { command: lines.join('\n'), env };
    }

    // **The second login site, and the one recorded as unreachable.**
    // The same pipeline `registries/registry.utils.ts` builds — shared as
    // `dockerLoginCommand` now rather than spelled twice, which is what the
    // old comment here asked for and could not have: this one is a step inside
    // an `if !`, and the two spellings had to stay byte-identical for
    // `STDIN_CREDENTIAL` to recognise both. They no longer have to, because
    // neither carries the password: the value is in {@link SourceProgram.env}
    // and the command holds a reference the remote shell expands. What made
    // that reachable is the interface change — a strategy could only return a
    // string before, so there was nowhere for the value to go, which is the
    // one obstacle the build-program change could not measure away.
    if (username && password) {
      env[PULL_PASSWORD_HOLDER] = password;
      lines.push(
        `if ! ${dockerLoginCommand(registryUrl, username, PULL_PASSWORD_HOLDER)}; then`,
        '  echo "❌ Registry login failed";',
        '  exit 1;',
        'fi',
      );
    }

    // `dockerImage` is a `PATCH`-able column and was the one word in this file
    // that went in bare, next to three that already used `shEscape` — which is
    // this file's quoter and does what `quote()` does for the rest of the pass.
    // Not converted to `quote()`: one mechanism per file beats two.
    //
    // **H-47 gave that column a grammar (`imageReferenceSchema`) and this
    // escape does not derive from it.** That was the question H-47 asked here
    // and the answer is no, for two reasons. The first is the rule itself
    // (`builders/build-strategy.ts`): a charset is belt-and-braces *behind* the
    // quoting, and a sink that stopped escaping because a DTO three modules away
    // started validating would be the exact reliance H-12 and H-19 each
    // reopened — "this value is already safe" is never the reason a word is
    // bare. The second is that it would not even be true here: this strategy is
    // handed a `SourceCommandInput` assembled from the *row*, and rows written
    // before H-47 are already in the database, unrevalidated, because a PATCH
    // that omits `dockerImage` never parses it. So the schema is what makes the
    // column mean something and this line is what makes the command safe, and
    // they are two different jobs done in two places on purpose.
    //
    // The ✅ follows the pull rather than announcing it: one printed first sat
    // green above the error of a pull that failed.
    lines.push(
      `echo ${shEscape(`Pulling image ${dockerImage}`)};`,
      `if ! docker pull ${platform ? `--platform ${shEscape(platform)} ` : ''}${shEscape(dockerImage)}; then`,
      `  echo ${shEscape(`❌ Failed to pull image ${dockerImage}`)};`,
      '  exit 1;',
      'fi',
      `echo ${shEscape(`✅ Pulled image ${dockerImage}`)};`,
    );
    return { command: lines.join('\n'), env };
  },

  listBranches(): null {
    return null;
  },

  getCommitInfo(): null {
    return null;
  },
};
