import type { Registry } from './registry.schema';

/** Dockerode's AuthConfig shape (createService/pull authconfig option). */
export interface RegistryAuthConfig {
  username: string;
  password: string;
  serveraddress: string;
}

/**
 * The dockerode auth object for pulls/pushes against this registry. An empty
 * serveraddress means the default registry (Docker Hub).
 */
export function getAuthConfig(registry: Registry): RegistryAuthConfig {
  return {
    username: registry.username,
    password: registry.password,
    serveraddress: registry.url,
  };
}

/** Single-quote for the shell; an empty or missing value becomes `''`. */
const shEscape = (s: string | null | undefined): string => {
  if (!s) return "''";
  return `'${s.replace(/'/g, `'\\''`)}'`;
};

/**
 * `docker login` for this registry — formerly `safeDockerLoginCommand` — with
 * the one word that was a credential replaced by a reference to one.
 *
 * **What this used to be, and why the name changed.** It took the password and
 * `shEscape`d it into the pipeline —
 * `printf %s '<the password>' | docker login … --password-stdin`. An earlier
 * change shipped a mask for that shape (`error-payloads.ts`'s
 * `STDIN_CREDENTIAL`) and recorded never-carry as unreachable on four grounds; a
 * later one measured three of them away and left the plumbing. This is the
 * plumbing, and the rename is the same device `BuildStrategy.getCommand` →
 * `getProgram` was: a third parameter that changed meaning from *the secret* to
 * *the name of the variable holding the secret* is a change no call site may
 * absorb silently, and only a rename makes that a compile error. "Safe" also
 * stopped describing anything this function does — the escaping it was named for
 * is gone, because there is no longer a value to escape.
 *
 * **What `--password-stdin` bought, and what it never did.** It keeps the
 * password out of `docker`'s argv — not in the host's process table, not in
 * `ps` for every other account on that box, not in docker's own logs — which is
 * why this shape exists rather than `docker login -p <password>`. It never kept
 * the password out of the *shell command string* carrying the pipeline, and
 * that string is what a different consumer reads: `ExecError` captures the
 * command it could not run and pino writes it six times over. `registry.password`
 * and a docker-sourced Application's own `password` are both `encryptedText`
 * (ADR 0006), and a refused login — an expired PAT, a rotated deploy token — is
 * the likeliest failure on the push path, so this was the single most journalled
 * secret in the tree.
 *
 * **Now it is neither.** The holder is expanded by the remote shell out of an
 * environment that arrived on the SSH channel (`RemoteExecOptions.env` →
 * `buildEnvScript`'s `export` lines), or locally out of the child's own
 * environment. `ExecError.command` records `printf %s "$CG_REGISTRY_PASSWORD_0"`
 * — a verb, a format, and a name this tree invented. There is nothing in it to
 * elide, nothing to decode, and no pattern to keep correct, which is ADR 0015's
 * last bullet in one line: a secret that never enters a command string cannot be
 * journalled, mis-elided, or leaked by the next tool that reads the string.
 *
 * **Double quotes, not single, and not `quote()`d.** The point is that the
 * variable expands; double quotes still stop word splitting and globbing, and
 * `printf %s` never re-parses what it prints, so a password containing a space,
 * a `*` or a `'` crosses intact — the property `shEscape` used to buy, now
 * bought by the shell. `quote()` on the reference would escape the `$` and pass
 * `docker login` the literal string `$CG_REGISTRY_PASSWORD_0`; `build-env.ts`'s
 * `envFlagWord` records the same trap for the same reason. Nothing
 * operator-controlled is bare: `registryUrl` and `username` still go through
 * `shEscape`, and `passwordHolder` is a literal prefix plus an index at both
 * call sites.
 *
 * **`STDIN_CREDENTIAL` stays and is now a backstop rather than the guarantee.**
 * Both live spellings of this pipeline — here and
 * `git-providers/strategies/docker.strategy.ts` — reference a holder now,
 * so the pattern matches nothing `src/` emits. It is kept because it recognises
 * `docker`'s own wire format rather than a shape this tree chose: the next
 * caller to write a `docker login` from a value it holds is covered before it is
 * reviewed. Its docblock says which of the two it is.
 */
export function dockerLoginCommand(
  registryUrl: string | null | undefined,
  username: string | null | undefined,
  passwordHolder: string,
): string {
  return `printf %s "$${passwordHolder}" | docker login ${shEscape(registryUrl)} -u ${shEscape(username)} --password-stdin`;
}

/**
 * The repository name is everything after the last '/' —
 * "docker.io/myuser/myrepo:tag" becomes "myrepo:tag".
 */
function extractRepositoryName(imageName: string): string {
  const lastSlashIndex = imageName.lastIndexOf('/');
  if (lastSlashIndex === -1) return imageName;
  return imageName.substring(lastSlashIndex + 1);
}

/**
 * The fully-qualified tag an image is pushed to on this registry —
 * [url/]prefix/repository, where the prefix is the registry's imagePrefix or
 * username, lowercased (image refs must be lowercase).
 */
export function getRegistryTag(registry: Registry, imageName: string): string {
  const repositoryName = extractRepositoryName(imageName);
  const targetPrefix = (
    registry.imagePrefix || registry.username
  ).toLowerCase();
  return registry.url
    ? `${registry.url}/${targetPrefix}/${repositoryName}`
    : `${targetPrefix}/${repositoryName}`;
}

export interface ImageNameOptions {
  appName: string;
  /** The image ref of a docker-sourced application — used verbatim. */
  dockerImage?: string | null;
  /** The registry the built image is pushed through, if any. */
  registry?: Registry | null;
}

/**
 * The image a service runs. Built applications are appName:latest, qualified
 * with the registry tag when the image is pushed through a registry;
 * docker-sourced applications run their image as given.
 */
export function getImageName(options: ImageNameOptions): string {
  const { appName, dockerImage, registry } = options;
  if (dockerImage) return dockerImage;
  const imageName = `${appName}:latest`;
  return registry ? getRegistryTag(registry, imageName) : imageName;
}
