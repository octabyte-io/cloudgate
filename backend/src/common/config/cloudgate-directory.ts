import * as path from 'node:path';

/**
 * The two roots of Cloudgate's own directory tree, which are deliberately not
 * the same value.
 *
 * `REMOTE_CLOUDGATE_DIRECTORY` is what `serverSetupCommand` creates on a
 * Server, so every path baked into a command sent over SSH — and every mount
 * source in a spec that Server's Docker will resolve — has to be that literal,
 * whatever this instance's own layout is. Point one instance at
 * /var/lib/cloudgate and a build dispatched to a Server provisioned by another
 * instance would otherwise write somewhere that does not exist on it.
 *
 * `localCloudgateDirectory()` is where *this* process reads and writes:
 * deployment logs, source trees, SSH keys, Traefik config, schedules,
 * volume-backup locks. That is the relocatable one, because the
 * alternative is a backend that only runs where its own user can write to /etc.
 *
 * Resist unifying them. They start out equal and only diverge once an operator
 * sets CLOUDGATE_DIRECTORY, which is exactly when the difference matters.
 */
export const REMOTE_CLOUDGATE_DIRECTORY = '/etc/cloudgate';

/** The local root when CLOUDGATE_DIRECTORY is unset: a Server's own layout. */
export const DEFAULT_CLOUDGATE_DIRECTORY = REMOTE_CLOUDGATE_DIRECTORY;

/** What a CLOUDGATE_DIRECTORY has to be, in the words the operator gets back. */
export const CLOUDGATE_DIRECTORY_REQUIREMENT =
  'must be an absolute path below the filesystem root, with no ".." segment';

/**
 * Whether a value may root the local tree: absolute, no `..` segment, and not
 * the filesystem root. '/' would collapse `readValidDirectory`'s containment to
 * a tautology — every path on the host resolves inside '/' — and a relative
 * root would resolve against whatever directory the process happened to start
 * in. Since ADR-0007 that containment is a backstop behind the entitlement
 * check rather than the boundary itself, which lowers what this protects
 * without changing that a backstop silently passing everything is worse than
 * none.
 */
export function isValidCloudgateDirectory(value: string): boolean {
  if (!path.isAbsolute(value)) return false;
  if (value.split(path.sep).includes('..')) return false;
  const resolved = path.resolve(value);
  return resolved !== path.parse(resolved).root;
}

/**
 * Which of the two roots above a path belongs to, given the machine that holds
 * it — the fork stated once instead of once per directory.
 *
 * **What was wrong.** Every tree on `deployment-engine.paths.ts` but one
 * resolved {@link localCloudgateDirectory} for every machine alike, while their
 * own docblocks said the tree lived "on the build server"; `logsDirectoryOn`
 * was the only helper there that asked which machine it was answering for.
 * With `CLOUDGATE_DIRECTORY` unset the two roots are the same literal, so every
 * one of those call sites was self-consistent and nothing had broken — which is
 * the same mechanism ADR-0018 records for the run/build Server pair: *a
 * wrong-root bug is invisible to any test that asserts only the words of the
 * command*, because `rm -rf /etc/cloudgate/applications/web-app` reads
 * identically whichever root it came from. Set the variable and a command baked
 * with the local root and dispatched over SSH names a directory
 * `serverSetupCommand` never created on that host — which was then reached in practice
 * rather than reasoned about: a patch block wrote each patched file under the
 * local root while the clone it was patching sat under the remote one, `mkdir
 * -p` succeeded, `set -e` never fired, and the build went green on unpatched
 * source.
 *
 * **That worklist is empty, and this file deliberately does not restate what
 * replaced it.** `deployment-engine.paths.ts`' header is the one place that says
 * which trees ask this and what the no-argument exports that survive there are
 * for; a second census here is a second thing to go stale, which is exactly
 * what the sentence this paragraph replaced became inside one batch — a reader
 * following it would have drawn a conclusion about seven trees from the file
 * that defines the fork (§1.2). What keeps a *new* local-root expression
 * from arriving unexplained is not a census in prose either: it is
 * `test/coding-standards/platform-root-call-sites.spec.ts`, which enumerates
 * every call of the three no-argument helpers in `src/` off the TS AST and
 * makes the file holding it declare why it is local.
 *
 * **`serverId ? remote : local`, and the truthiness is the semantics** — the
 * same reading `buildHostServerId` gives the same shape of value, and the same
 * reason it is `||` and not `??`: `null` is the platform host (ADR-0008) and an
 * empty string is not a `server` row's id either, so both mean *this process's
 * own tree*.
 *
 * It takes a `serverId` rather than a `Server` row because that is all the
 * question needs and all its callers hold — a teardown holds an id, and
 * `logsDirectoryOn` has taken one from the start.
 *
 * **Adopting it for a further tree is one edit per directory, and each has to
 * be atomic with its own writer.** ADR-0018's lesson stated for roots rather
 * than machines: whoever creates an artifact and whoever destroys it have to
 * answer this the same way, so converting a removal whose writer still resolves
 * locally does not fix a leak, it moves one. That is why each conversion landed
 * as one commit covering a whole tree's writers and destroyers rather than one
 * per call site, and why a tree's local spelling is deleted with
 * its last caller instead of left as a helper with no correct call site.
 */
export function cloudgateDirectoryOn(
  serverId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return serverId ? REMOTE_CLOUDGATE_DIRECTORY : localCloudgateDirectory(env);
}

/**
 * This instance's own root, from CLOUDGATE_DIRECTORY.
 *
 * Read on every call rather than once at import: `ConfigModule.forRoot`
 * publishes the validated env (a .env file, plus the default above) only after
 * every module has been imported, so a constant computed at import time would
 * silently miss a .env entry.
 */
export function localCloudgateDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.CLOUDGATE_DIRECTORY?.trim();
  if (!configured) return DEFAULT_CLOUDGATE_DIRECTORY;
  if (!isValidCloudgateDirectory(configured)) {
    throw new Error(
      `CLOUDGATE_DIRECTORY ${CLOUDGATE_DIRECTORY_REQUIREMENT} (got "${configured}")`,
    );
  }
  return path.resolve(configured);
}
