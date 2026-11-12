import { quote } from 'shell-quote';
import { parseEnvironmentKeyValuePair } from '../docker/docker.utils';

/**
 * One operator variable, and the machine-made name that carries its value.
 *
 * `key` is the operator's own variable name and reaches the command string;
 * `holder` is this module's invention and reaches the *environment*. The value
 * appears in neither — it is in {@link CarriedBuildEnv.env}, which the exec
 * layer sends on the SSH channel.
 */
export interface CarriedEntry {
  /** The operator's variable name, as the build tool must see it. */
  readonly key: string;
  /** `CG_BUILD_…_<n>`: the shell variable this key's value arrives in. */
  readonly holder: string;
}

/** A build's operator-authored environment, carried off the command line. */
export interface CarriedBuildEnv {
  /**
   * `holder` → value, for `RemoteExecOptions.env` / `ExecOptions.env`. Empty
   * when the operator set no variables, which is what keeps a build with
   * nothing to protect on the transport it has always used.
   *
   * What that transport costs, measured against the two hazards once recorded
   * as the reason this seam looked unreachable — the `sh -s` substitution and
   * the local branch's *replacing* `env` — is on `RemoteExecService`'s
   * `buildEnvScript`. Neither is live; the second is handled at
   * `DeploymentEngineService.exec` and would come back if a caller stopped
   * spreading `process.env`.
   */
  readonly env: Record<string, string>;
  /** The variables, in the operator's declaration order. */
  readonly entries: readonly CarriedEntry[];
}

/**
 * Move a build's environment out of the command string and into the
 * environment, without changing a single byte of what the build tool receives.
 *
 * **The defect.** Six of the seven builders spliced the *resolved values*
 * of `application.env`, `project.env` and `environment.env` into a command line
 * — `nixpacks build … --env STRIPE_KEY\=sk_live_…`, `pack build … --env …`,
 * `railpack prepare … --env …`, `docker build … --build-arg …` — and
 * `dockerfile.strategy.ts` additionally put `application.buildSecrets` in as a
 * bare shell assignment prefix, `SECRET_TOKEN=sk_live_… docker build …`. All
 * three env columns are `encryptedText` (ADR 0006/0015), and `ExecError`
 * captures the whole command, from where pino writes it six times over
 * (`common/logging/error-payloads.ts`). So every failed build journalled the
 * operator's entire environment in clear — not base64, not URL userinfo, so
 * none of the three log-elision patterns touched it.
 *
 * **Never-carry, and this is the shape of it.** ADR 0015's last bullet asks for
 * the environment rather than a fourth pattern, and the whole difficulty was
 * always the *plumbing*, not the idea. What makes it a small change is that a
 * value can be referenced by a command without being in it: the word this
 * module emits is
 *
 * ```
 * --env NODE_ENV"=$CG_BUILD_ENV_0"
 * ```
 *
 * which the remote shell expands, at run time, out of an environment that
 * arrived on the SSH channel. `ExecError.command` records the word above
 * verbatim — a variable name, an `=`, and a name this file invented. There is
 * nothing in it to elide, nothing to decode, and no pattern to keep correct.
 *
 * **Why a holder and not the operator's own name.** The obvious spelling is the
 * value-less flag form every one of these tools accepts (`--env NODE_ENV`,
 * `--build-arg NODE_ENV`), reading `NODE_ENV` out of the tool's own
 * environment. It was rejected twice over. It puts *operator-chosen names* into
 * the build shell's environment, where `PATH`, `HOME`, `IFS` and `LD_PRELOAD`
 * are live — an `env` of `PATH=/tmp` currently reaches nixpacks as one more
 * variable and would instead break the build that runs it. And for two of the
 * three tools the behaviour is source-only: `pack` documents it
 * (`internal/commands/build.go`: *"in the form 'VAR=VALUE' or 'VAR'. When using
 * latter value-less form, value will be taken from current environment"*),
 * while nixpacks (`src/nixpacks/environment.rs`) and railpack
 * (`core/app/environment.go`) only implement it, and nixpacks' regex makes
 * `--env FOO=` inherit as well, so an operator's explicit empty value would
 * silently pick up the host's. A holder needs none of that: the tools keep
 * receiving `KEY=VALUE`, exactly as they do today, and the flag's parsing is
 * not load-bearing at all.
 *
 * A holder also settles the name question the exec layer would otherwise
 * decide. `RemoteExecService`'s `ENV_NAME` admits `[A-Za-z_][A-Za-z0-9_]*`,
 * while dotenv admits `[\w.-]+` as a key — so `FOO.BAR=x` is a legal
 * `application.env` line today, and putting it on the channel under its own
 * name would fail the deploy. `CG_BUILD_ENV_0` is valid by construction.
 *
 * **The key is still `quote()`d** (`BuildStrategy`'s rule). It is the one
 * operator-controlled byte range left in the word, and while dotenv's key
 * charset happens to hold nothing a shell reacts to, that is a charset in
 * another module — precisely the "safe at a distance" reasoning `BuildStrategy`
 * refuses. `quote()` and the expansion compose without a gap, because adjacent
 * quoted runs concatenate into one word: `'a b'"=$CG_BUILD_ENV_0"` is the
 * single argument `a b=<value>`.
 *
 * The holder itself is **not** quoted, and must not be: `quote()` escapes the
 * `$`, which is the whole mechanism. It is safe because it is not a value —
 * `holderPrefix` is a literal at each call site and the index is a number.
 */
export const carryBuildEnv = (
  holderPrefix: string,
  pairs: readonly string[],
): CarriedBuildEnv => {
  const env: Record<string, string> = {};
  const entries: CarriedEntry[] = [];

  for (const pair of pairs) {
    const [key, value] = parseEnvironmentKeyValuePair(pair);
    if (!key) continue;
    const holder = `${holderPrefix}_${entries.length}`;
    env[holder] = value;
    entries.push({ key, holder });
  }

  return { env, entries };
};

/**
 * The one shell word a `--env` / `--build-arg` flag takes: the operator's key,
 * and their value expanded out of the environment at run time.
 *
 * Double quotes and not single, because the point is that `$holder` expands;
 * double quotes are enough because they still stop word splitting and globbing,
 * and the value is never re-parsed after the expansion.
 */
export const envFlagWord = ({ key, holder }: CarriedEntry): string =>
  `${quote([key])}"=$${holder}"`;

/**
 * The value of a buildx `--secret` flag: the secret keeps the operator's key as
 * its id, so `/run/secrets/<key>` inside the build is unchanged, and its value
 * is read out of the holder.
 *
 * **Naming the variable explicitly is a fix as well as a requirement.** Both
 * `dockerfile.strategy.ts`'s `--secret type=env,id=<key>` and
 * `railpack.strategy.ts`'s `--secret id=<key>,env=<key>` relied on the id and
 * the variable being the same name, which the holder ends. But buildx's own
 * fallback made the old spelling worse than it read: with neither `env` nor
 * `src` resolved, `session/secrets/secretsprovider/store.go` checks
 * `os.LookupEnv(id)` and, when the variable is *unset*, falls back to
 * `type=file` and reads a **local file named after the id** — so a missing
 * secret was a `failed to stat SECRET_TOKEN` in the build directory rather than
 * a statement that the variable was not set. An explicit `env=` takes that
 * branch away.
 */
export const secretFlagValue = ({ key, holder }: CarriedEntry): string =>
  `id=${quote([key])},env=${holder}`;
