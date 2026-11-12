/**
 * What a git-provider strategy produces: the shell program that materializes
 * the source, and the values that program reads out of its own environment
 * rather than off its own command line.
 *
 * **The second field is `BuildProgram`'s shape on purpose.** An earlier
 * change gave the *build* strategies exactly this pair for exactly this reason,
 * and recorded the clone command's bare `string` return as the one obstacle it
 * could not measure away: `git-providers/strategies/docker.strategy.ts` builds
 * a `docker login` for a private image pull, and `application.password` is
 * `encryptedText` (ADR 0006) travelling as a word of a command that `ExecError`
 * captures and pino writes six times over. There was nowhere for the value to
 * go, because a strategy could only return a string. Now there is, and the
 * property is ADR 0015's first choice rather than its second: a secret that
 * never enters a command string cannot be journalled, mis-elided, or leaked by
 * the next tool that reads the string.
 *
 * Six of the seven strategies return `{}` — see {@link sourceProgram}.
 *
 * **The git strategies' provider tokens are deliberately *not* moved here**, and
 * the reason is that they are not arguments: `github`, `gitlab`, `gitea` and
 * `bitbucket` put the credential in the *userinfo of a URL* that `git` must
 * receive as one word, so an environment reference cannot replace it without a
 * credential helper or `GIT_ASKPASS` — a different change with a different
 * argument. Those four stay on `common/logging/error-payloads.ts`'s
 * `URL_CREDENTIAL`, which is the mask that recognises their shape.
 *
 * **Its own module, and that is a runtime constraint rather than taste.**
 * {@link sourceProgram} is a *value*, and `git-provider.strategy.ts` imports
 * every strategy in order to build the dispatch map — so a strategy importing
 * the helper from there closes a require cycle that TypeScript is happy with and
 * Node is not: the strategy modules load first, find a half-initialised
 * `git-provider.strategy` exports object, and the map is built over
 * `undefined`. Measured as `TypeError: Cannot read properties of undefined
 * (reading 'sourceType')` at module load, on seven suites at once. The
 * interfaces could have stayed there, because a type import is erased and
 * cannot form a cycle; keeping the pair together is what stops the next reader
 * from moving the helper back.
 */
export interface SourceProgram {
  readonly command: string;
  readonly env: Record<string, string>;
}

/**
 * A clone program that needs no environment, which is six of the seven
 * strategies.
 *
 * A named wrapper rather than `{ command, env: {} }` at nineteen return sites,
 * because the empty environment is a *claim* — "this program carries no secret
 * a shell could leak" — and a claim is worth reading as one word. It is also
 * what keeps those six clones on the transport they have always used: an empty
 * map means `DeploymentEngineService.exec` passes no options, so
 * `execAsyncRemote` sends the program as the SSH `exec` request under the
 * account's login shell instead of piping it to `sh -s`.
 */
export const sourceProgram = (command: string): SourceProgram => ({
  command,
  env: {},
});
