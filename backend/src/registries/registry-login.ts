import { dockerLoginCommand } from './registry.utils';

/**
 * Asking a registry whether a credential works, before a build spends ten
 * minutes finding out.
 *
 * A wrong password used to save as "Registry saved." and surface only at the
 * push, after the whole image was built — `❌ Registry login failed` under a
 * daemon 401. The same gap was in an Application's Docker-image source, where it
 * surfaced at the pull. Both screens now ask this one probe, through two routes
 * (`POST /registries/test-connection` and its saved-row sibling, and
 * `POST /applications/:id/test-registry-login`), because the two credentials
 * live in two tables behind two permissions: a Member who may edit an
 * Application's source holds `registry: []`.
 *
 * **It is the push's own login, not an imitation of it.** A `GET /v2/` with
 * basic auth from this process was the other shape the ticket offered, and it
 * is wrong twice: Docker Hub, GHCR and ECR answer basic auth with a bearer-token
 * challenge that `docker login` follows and a hand-rolled request would have to
 * re-implement; and it would run from the platform process's network, not from
 * the daemon that later pushes, so a registry only the build Server can reach
 * would test red from a host that never pushes to it. So it is
 * {@link dockerLoginCommand} — the builder the push and the pull both use —
 * run on the machine that will log in for real.
 */

/**
 * The variable the probe's password arrives in. Its own prefix, not
 * `CG_REGISTRY_PASSWORD_*`: the probe composes nothing else, but a holder name
 * that says which caller made it keeps a journalled command readable.
 */
export const REGISTRY_LOGIN_PASSWORD_HOLDER = 'CG_REGISTRY_TEST_PASSWORD';

/**
 * `docker login` against a **throwaway** `DOCKER_CONFIG`, removed on exit.
 *
 * A login writes the credential into the config it runs against — base64 in
 * `config.json` on a Linux host with no credential helper. Against the host's
 * own `~/.docker`, a passing test of values nobody saved would replace the
 * login that host already holds for that registry, and would leave the tested
 * credential on disk after the operator cancelled the dialog. The push logs in
 * again before every push, so it needs nothing this left behind; the temp
 * directory is the whole footprint, and the `trap` removes it whichever way the
 * login ends.
 *
 * `export`, not a prefix assignment: `DOCKER_CONFIG=… printf … | docker login`
 * would give the variable to `printf` and not to `docker`.
 *
 * Measured against docker 29.3.1 on Docker Desktop: an empty `DOCKER_CONFIG`
 * directory still reaches the daemon through `/var/run/docker.sock`, and the
 * login answers exactly as it does against the default config.
 */
export function registryLoginProbeCommand(
  registryUrl: string | null | undefined,
  username: string | null | undefined,
): string {
  return [
    'CG_DOCKER_CONFIG="$(mktemp -d)" || exit 1',
    `trap 'rm -rf "$CG_DOCKER_CONFIG"' EXIT`,
    'export DOCKER_CONFIG="$CG_DOCKER_CONFIG"',
    dockerLoginCommand(registryUrl, username, REGISTRY_LOGIN_PASSWORD_HOLDER),
  ].join('\n');
}

/** Long enough for any refusal a registry writes, short enough to render. */
const MAX_MESSAGE_LENGTH = 1000;

const FALLBACK = 'The registry refused the login';

/**
 * What a refused probe says: one plain sentence, and the tool's own output
 * beside it.
 *
 * `message` is the sentence a person reads. `output` is everything `docker
 * login` wrote, for a "Details" disclosure — present only when it says more
 * than `message` does.
 */
export interface RegistryLoginFailure {
  message: string;
  output?: string;
}

/**
 * A docker CLI log line: `time="…" level=info msg="Error logging in to endpoint,
 * trying next endpoint" endpoint="{https://… 0x643c66b0960}" error="…"`.
 * Logrus's prefix, a Go struct's memory address and the error said a second
 * time — the line once found on screen ahead of the actual answer.
 */
const DOCKER_LOG_LINE = /^time="[^"]*"\s+level=/;

/** Stripped off the answer: the daemon's and the CLI's own prefixes. */
const ERROR_PREFIX = /^(?:Error response from daemon:\s*|Error:\s*)+/i;

/**
 * The registry's answer in plain words, from the last line docker wrote that is
 * not one of its log lines.
 *
 * - a login answered with a status — `… failed with status: 401 Unauthorized` —
 *   says the registry refused it, and names the status;
 * - a request that never got an answer — `Get "https://…/v2/": Bad Gateway`,
 *   `… dial tcp: lookup …: no such host`, `… connect: connection refused` —
 *   says the registry could not be reached, and why, in the last clause;
 * - anything else is the line itself, without docker's prefixes.
 */
function plainAnswer(line: string, host: string): string {
  const said = line.replace(ERROR_PREFIX, '').trim();

  const status = /failed with status:\s*(\d{3}.*)$/i.exec(said);
  if (status) {
    const code = status[1].trim();
    return /^40[13]\b/.test(code)
      ? `${host} refused the username or password (${code}).`
      : `${host} refused the login (${code}).`;
  }
  if (/unauthorized|incorrect username or password/i.test(said)) {
    return `${host} refused the username or password.`;
  }

  const unreached = /^(?:Get|Head|Post)\s+"[^"]*":\s*(.+)$/.exec(said);
  if (unreached) {
    const reason = unreached[1].split(': ').pop()?.trim() || unreached[1];
    return `Could not reach ${host} (${reason}).`;
  }

  return said;
}

function capped(text: string): string {
  return text.length > MAX_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…`
    : text;
}

/**
 * What a refused probe says to the person who asked.
 *
 * **stderr first**, because that is where `docker login` puts the daemon's
 * answer — `Error response from daemon: login attempt to http://…/v2/ failed
 * with status: 401 Unauthorized`, or `… connect: connection refused` for a host
 * that is not there — while `ExecError.message` is `Command failed: <the
 * program>` locally and the bare `Remote command failed with exit code 1` over
 * SSH (as found for rclone, and the same here). The message is kept as the
 * answer only when nothing ran at all: an SSH session that was refused.
 *
 * **One sentence, not docker's transcript.** Docker writes its log
 * lines to stderr ahead of the answer, so the raw text read `time="…"
 * level=info msg="Error logging in to endpoint…" endpoint="{https://… 0x…}"`
 * and then the same error again. `message` is the last answer line in plain
 * words ({@link plainAnswer}); the whole of stderr goes in `output`.
 *
 * **The password is taken back out** of both, even though nothing here should
 * ever hold it — it never entered the command, and docker does not echo it.
 * This is the backstop for the one route whose caller never held the secret (a
 * saved row's test), so no future tool's diagnostic can hand a stored
 * credential to a screen. Only a value of six characters or more is masked —
 * the console's `redactSecrets` rule — so a one-letter password cannot turn a
 * sentence into asterisks.
 */
export function registryLoginFailure(
  error: unknown,
  password: string,
  registryUrl?: string | null,
): RegistryLoginFailure {
  const host = registryUrl?.trim() || 'Docker Hub';
  const mask = (text: string) =>
    password.length >= 6 ? text.split(password).join('••••••') : text;
  const { stderr, message } = (error ?? {}) as Record<string, unknown>;

  for (const candidate of [stderr, message]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const raw = mask(candidate.trim());
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const answers = lines.filter((line) => !DOCKER_LOG_LINE.test(line));
    const last = answers.at(-1) ?? lines.at(-1) ?? raw;
    const sentence = capped(plainAnswer(last, host));
    return sentence === raw
      ? { message: sentence }
      : { message: sentence, output: capped(raw) };
  }
  return { message: FALLBACK };
}
