/**
 * The string fields of a failed exec that outlive the failure.
 *
 * `stack` and `ExecError`'s command/stdout/stderr are in here alongside
 * `message` because the exception filter hands the whole exception to the
 * logger, and the logger is pino: its error serializer writes the stack and
 * every own property, so masking the message alone would leave the same text in
 * the journal one field over. Measured, on one `logger.error(execError)` line:
 * the command appeared six times — `err.message`, `err.stack`, `err.command`,
 * `err.originalError.message`, `err.originalError.stack` and
 * `err.originalError.cmd`.
 *
 * **One list, two masks.** `destinations/s3-credentials.ts`'s
 * `redactS3CredentialsInError` walks it to take *known credential values* back
 * out of an rclone failure; {@link elidePayloadsInError} walks it to take *a
 * secret it cannot know the value of* out of any failed exec. The two are
 * different mechanisms for different problems — one knows the secret and
 * searches for it, the other cannot and recognises instead either the wire shape
 * the platform itself emitted ({@link ENCODED_FILE_BODY},
 * {@link STDIN_CREDENTIAL}, {@link URL_CREDENTIAL}) or, in the one case where
 * the secret announces itself, its format ({@link PEM_PRIVATE_KEY}) — but they
 * cover the same fields, and a field added here has to be covered by both or the
 * next one is added to one and missed by the other. It lives in
 * `common/logging/` rather than in either module because it is a fact about what
 * pino writes.
 *
 * Exported for its tests and for those two walkers, and for nothing else.
 * Unlike the recursion depth — a knob nobody turns — this list *is*
 * both masks' guarantee, and a unit test enumerating the array is the only place
 * the *whole* list can be driven: no route produces an error carrying a secret
 * in six fields at once.
 */
export const REDACTED_ERROR_FIELDS = [
  'message',
  'stack',
  'command',
  // Node's own spelling: `child_process.exec` names the failed line `cmd`, so an
  // ExecError that wraps one carries the command twice under two keys, and pino
  // writes both. `command` alone left the text in the journal one field over.
  'cmd',
  'stdout',
  'stderr',
] as const;

/** What replaces an encoded file body. Not base64, so eliding is idempotent. */
const elidedBody = (encodedLength: number, padding: number): string =>
  `[file body elided: ${Math.max(
    0,
    Math.floor((encodedLength * 3) / 4) - padding,
  )} bytes]`;

/**
 * The wire shape every operator-authored file body travels in — **and only the
 * bodies that travel in it**.
 *
 * Thirteen builders in this tree write a file to a host the same way — mounts,
 * schedules, patches, the compose file and its env file, the traefik configs and
 * certificate keys, the builder strategies' `.env` and `Dockerfile`, the git raw
 * strategy, the custom-git strategy's SSH key, a drop archive's entries and
 * `docker-ops`' container upload — and all thirteen emit
 * `echo <base64> | base64 -d > <path>`, because that is the only way to get an
 * arbitrary byte string past a shell (`docker/docker.utils.ts`'s
 * `getCreateFileCommand`). The quoting differs (`"` everywhere but the container
 * upload's `'`), so the quote is captured and matched back rather than assumed.
 *
 * **`git.strategy.ts`'s SSH key is the thirteenth, and it was the counterexample
 * that made this docblock's original claim false.** It wrote
 * `echo <the PEM> > /tmp/cloudgate/id_rsa` — the `echo` anchor and *not* the
 * `| base64 -d` one — so a failed private clone printed `sshKey.privateKey`, an
 * `encryptedText` column, into six fields of one journal line while this comment
 * listed "certificate keys" among what it covered. That was true of traefik's
 * cert keys, which go through `getCreateFileCommand`, and false of this one, and
 * nothing distinguished them. The builder now ships the key in the same shape as
 * every other body — see {@link PEM_PRIVATE_KEY} for the second layer under it,
 * and `git.strategy.ts` for why the shape change is a strict improvement on the
 * shell as well as in the journal.
 *
 * Anchored on `echo` **and** on the `| base64 -d` that follows, so what is
 * elided is only ever a payload this platform itself encoded for transit. A bare
 * run of base64-alphabet characters is not enough to act on: a container id, an
 * image digest and a commit sha are all in that alphabet, and blanking those
 * would take the identifiers out of the very messages that exist to name them.
 *
 * **Known gaps, all of them latent.** Every shape below would defeat this
 * pattern and none is reachable from `src/` today, which is why they are
 * recorded here rather than matched: a widened pattern is a widened blast
 * radius, and each of these is one grep away for whoever writes the fourteenth
 * builder.
 *
 * - **`set -x`.** Nothing in `src/` runs these scripts traced, which is the one
 *   thing that would split the pipeline across two lines and hide the suffix.
 * - **A payload chunked across a newline** — `echo "AAA\nBBB" | base64 -d`,
 *   which `base64 -d` accepts happily. The body class stops at the newline, so
 *   the second anchor is never reached and nothing is elided. Note that the
 *   spec's own `expectNoDecodablePayload` oracle *cannot see this one either*:
 *   it decodes each base64 run separately and neither half yields the secret,
 *   while a human rejoins them by deleting a newline.
 * - **A different way of writing the same pipeline**: `echo -n`, `printf %s …`
 *   in place of `echo`, `base64 --decode` or `base64 -di` in place of
 *   `base64 -d`, and a heredoc (`base64 -d <<'EOF'`) instead of a pipe.
 * - **`https://<token>@host`** — see {@link URL_CREDENTIAL}, which needs a `:`
 *   before the `@`.
 */
const ENCODED_FILE_BODY =
  /(\becho\s+)(["']?)([A-Za-z0-9+/]*)(={0,2})\2(\s*\|\s*base64\s+-d)/g;

/**
 * A PEM private key, elided on its **format** rather than on a wire shape.
 *
 * The other patterns here recognise a shape this platform emits, because the
 * platform cannot know which bytes of an operator's file are the secret. A
 * private key is the one exception in this tree: it says what it is, in an
 * armour that is specified and that nothing else in a diagnostic message
 * carries. So it is elided wherever it appears, in whatever command, quoted or
 * bare, whether or not it went through base64 — which is what makes this file's
 * coverage claim true for the next builder that materializes key material
 * without reading {@link ENCODED_FILE_BODY} first.
 *
 * Both markers are kept, so a reader still sees *that* a key was written and
 * which kind. `PRIVATE KEY` is required in the label: `-----BEGIN
 * CERTIFICATE-----` is a public certificate, it is not a secret, and on a
 * traefik failure it is the diagnosis.
 *
 * **The gap is a key with no `-----END`** — a PEM truncated by a capped stdout,
 * say. Deliberately not handled: the alternative is eliding from `BEGIN` to the
 * end of the string, which on a multi-step command would swallow every verb
 * after it and turn a diagnosable failure into a blank. A truncated key is also
 * a truncated key: what survives is unusable as one.
 */
const PEM_PRIVATE_KEY =
  /(-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)[\s\S]*?(-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----)/g;

/**
 * The password of a `docker login`, on its way in over stdin.
 *
 * **Nothing in `src/` emits this shape any more, and that is a fix rather than a
 * reason to delete the pattern.** Two sites used to compose one —
 * `registries/registry.utils.ts`, which `deployment-engine.service.ts` runs
 * before a push, and `git-providers/strategies/docker.strategy.ts`, which
 * builds the same pipeline before pulling a private image — and both emitted
 * `printf %s <shEscape(password)> | docker login <url> -u <user>
 * --password-stdin` with the decrypted value in the middle. Both now emit
 * `printf %s "$CG_…"` and hand the value to `RemoteExecOptions.env` instead, so
 * this pattern's live consumers are gone and what it covers is **`docker`'s own
 * wire format**: the next caller that has a password in hand and reaches for
 * `--password-stdin` is masked before anybody reviews it. It is a backstop, not
 * the guarantee, and `registries/registry.utils.ts`' `dockerLoginCommand`
 * carries the argument for why never-carry replaced it.
 *
 * **`--password-stdin` was never what this pattern duplicated.** What that flag
 * buys is real and narrower than it reads: the password never becomes a word of
 * `docker`'s argv, so it is not in the host's process table and not in
 * `docker`'s own logs. It was nonetheless a word of the *shell command string*
 * that carries the pipeline, and that string is exactly what `ExecError`
 * captures and pino writes six times over. A refused login — an expired PAT, a
 * rotated deploy token — is the single likeliest failure on the push path, so
 * this was the credential most likely of all of them to be journalled.
 *
 * Anchored on `printf %s` **and** on the `| docker login` that follows, on
 * {@link ENCODED_FILE_BODY}'s discipline: `printf %s` alone is an ordinary verb
 * — `backups/commands/utils.ts` writes lines with it — and a pattern anchored on
 * it alone would blank whatever it was printing.
 *
 * The word between them is matched as a shell word rather than as "everything
 * up to the pipe", so the elision cannot run away across a newline: `shEscape`
 * single-quotes, and a password carrying a quote arrives as the three
 * concatenated chunks `'a'\''b'`, which is why the class admits a quoted run, an
 * escaped quote and a bare character but never unquoted whitespace or a `|`.
 *
 * **The lookahead is that fix's, and it was a live mis-elision the moment the
 * holder landed.** `"$CG_REGISTRY_PASSWORD_0"` is a perfectly good match for
 * that shell-word class — every character in it is outside `\s`, `'` and `|` —
 * so the first thing the mask did to a never-carry login was rewrite it as
 * `printf %s '[credential elided]'`, which is *worse than leaving it alone in
 * both directions*: it destroys the one piece of diagnosis the new shape adds
 * (which holder the value arrived in, and therefore that it arrived at all),
 * and it tells a reader a secret was in a string that never held one — the
 * elision markers in this file are read as "a secret was here". A variable
 * reference is not a credential, so the pattern is told not to treat one as
 * a candidate at all.
 *
 * Narrow on purpose: exactly a double-quoted expansion of a `ENV_NAME`-shaped
 * variable, immediately before the pipe. `printf %s "$FOO$BAR"`,
 * `printf %s "${FOO}"` and an unquoted `printf %s $FOO` are all still elided,
 * because none of them is a shape this tree writes and a wider exemption is a
 * wider hole — a password *containing* a `$` would start slipping through the
 * moment the class stopped being anchored to the whole word.
 */
const STDIN_CREDENTIAL =
  /(\bprintf\s+%s\s+)(?!"\$[A-Za-z_][A-Za-z0-9_]*"\s*\|)(?:'[^']*'|\\'|[^\s'|])+(\s*\|\s*docker\s+login\b)/g;

/**
 * A credential in a URL's userinfo component.
 *
 * The git strategies clone over `https://oauth2:<token>@host/owner/repo.git`
 * (`git-providers/strategies/github|gitlab|gitea`), so the whole command — and
 * therefore `ExecError.command`, its message and Node's `cmd` — carries a
 * provider token. Only the password half goes: the scheme, the user (`oauth2`
 * says *which* credential this was) and the host and path are the diagnosis.
 *
 * **Every separator is optionally backslash-escaped**, because that is what
 * arrives. `shell-quote`'s `quote()` — which every git strategy runs the clone
 * URL through — does not wrap a word like this one in single quotes; it
 * backslash-escapes the characters that need it, so the command really reads
 * `https\://oauth2\:ghs_…\@github.com/…`. A pattern written for the URL as an
 * author types it matches none of the three sites that actually build one.
 *
 * The two components are lazy and stop at the separator that follows, so a URL
 * with no userinfo cannot be read as one: `https://s3.example.com:443/x` needs
 * an `@` this pattern never finds, and `/` is outside both character classes.
 *
 * **`https://<token>@host` is not covered, and that is a decision rather than an
 * oversight.** It is GitHub's other accepted spelling — a PAT as the whole
 * userinfo, no `:` — and all three git strategies write `oauth2:<token>@`
 * instead, so nothing in `src/` emits it. Covering it means making the
 * `user:` half optional, and a `scheme://word@host` with no colon is
 * *ambiguous*: `ssh://git@git.example.com:2222/team/repo.git` is the shape
 * `git.strategy.ts` really does build, where the word is the SSH account name —
 * public, diagnostic, and the first thing a reader checks when a clone is
 * refused. A pattern that elided the bare form would blank `git` on every
 * failed SSH clone in order to cover a URL this tree does not write. The day a
 * strategy writes one, the honest fix is to make *that* builder spell it
 * `oauth2:<token>@` like its three siblings, not to widen this pattern until it
 * cannot tell a username from a token.
 *
 * **The scheme is bounded to 64 characters, and without that bound this
 * pattern is quadratic**. Unbounded, `[a-z][a-z0-9+.-]*` swallows a
 * whole run of word characters at every start position before failing to find
 * `:` — measured, one 600 kB line of a Deployment log (a minified bundle, a base64
 * blob) held the event loop past the e2e harness's five-minute watchdog once
 * the MCP mask began running this over deployment logs. Bounded, each start costs at most 64 steps, and a
 * longer scheme still matches on its last 64 characters, which leaves the
 * replacement's output the same.
 */
const URL_CREDENTIAL =
  /([a-z][a-z0-9+.-]{0,63}\\?:\/\/)([^\s/?#@'"]*?)(\\?:)([^\s/?#@'"]*?)(\\?@)/gi;

/**
 * Take the payload out of a command, and leave the command.
 *
 * **What a reader still learns from an elided command.** Everything except the
 * bytes: which verbs ran and in which order (`mkdir -p`, `chmod +x`, `mv -f`,
 * `base64 -d`, `git clone`, `docker cp`, `docker login`), every path they
 * touched, every flag, which registry and which user a login was attempted as,
 * which host a key was trusted for, the shell's own `set -e`, and — from
 * `ExecError`'s other fields, which are not touched — the exit code, the host's
 * `serverId`, and whatever the failing tool wrote on stdout and stderr. The
 * payload's decoded size is kept too, which is the one thing about the body
 * itself that a diagnosis wants: an empty script and a 4 kB script fail
 * differently.
 *
 * **A size is kept for a body and not for a credential.** {@link elidedBody}
 * reports how many bytes were written, because a file's length is diagnostic and
 * is not the secret. {@link STDIN_CREDENTIAL} and {@link URL_CREDENTIAL} report
 * nothing, because a password's length *is* a fact about the password, and
 * nothing about a refused login is diagnosed by knowing the token was 40
 * characters.
 *
 * **What it costs.** Two sites carry a *path* rather than a body through this
 * shape and lose it: `realtime/gateways/deployment-logs.gateway.ts`'s
 * `tail -f "$(echo <b64> | base64 -d)"`, and
 * `deployment-engine.service.ts`'s `appendToLogCommand`, whose payload is the
 * log line being appended. Both are recoverable from the surrounding record (a
 * deployment's log path is derived from its id), and neither is worth a
 * per-call-site opt-out that the next call site would inherit wrongly.
 *
 * Idempotent, and each pattern separately: every marker written here contains a
 * space and a `[`, which is outside `ENCODED_FILE_BODY`'s body class, is not a
 * PEM body, and — quoted back into the shell word it replaces — matches
 * `STDIN_CREDENTIAL` a second time to the same text.
 */
export const elideEncodedPayloads = (text: string): string =>
  text
    .replace(
      ENCODED_FILE_BODY,
      (
        _match,
        echo: string,
        quote: string,
        body: string,
        padding: string,
        pipe: string,
      ) =>
        `${echo}${quote}${elidedBody(body.length + padding.length, padding.length)}${quote}${pipe}`,
    )
    .replace(PEM_PRIVATE_KEY, '$1[private key elided]$2')
    .replace(STDIN_CREDENTIAL, "$1'[credential elided]'$2")
    .replace(URL_CREDENTIAL, '$1$2$3[credential elided]$5');

/**
 * {@link elideEncodedPayloads} over every field of an error that reaches a log.
 *
 * In place, and returning the same error, for the reason
 * `redactS3CredentialsInError` gives: what these routes throw *is* the status
 * code they answer with, and rebuilding the error here would answer that
 * question by accident. `ExecError`'s constructor calls this on the
 * `originalError` it has just taken ownership of, and the pino serializer calls
 * it on a fresh object pino made, so no caller is surprised by the mutation.
 *
 * `originalError` and `cause` are each followed one level down, because that is
 * where the raw `child_process` error sits with its own copy of the command and
 * where pino's serializer follows too; deeper than that nothing in this tree
 * nests, and a cycle would not terminate.
 */
export const elidePayloadsInError = <T>(error: T): T => {
  elideInPlace(error, 1);
  return error;
};

const elideInPlace = (error: unknown, depth: number): void => {
  if (!error || typeof error !== 'object') return;
  const fields = error as Record<string, unknown>;
  for (const field of REDACTED_ERROR_FIELDS) {
    const value = fields[field];
    if (typeof value === 'string') {
      fields[field] = elideEncodedPayloads(value);
    }
  }
  if (depth > 0) {
    elideInPlace(fields.originalError, depth - 1);
    elideInPlace(fields.cause, depth - 1);
  }
};
