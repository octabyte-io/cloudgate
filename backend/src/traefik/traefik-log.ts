/**
 * One error Traefik logged about a router it refused to build.
 *
 * `message` is Traefik's own sentence, carried verbatim and never read for
 * meaning. That is the whole discipline of this file: the *name* is the
 * machine-readable half (`traefik/config/names.ts` maps it back to a Cloudgate
 * row), and the sentence is the human half. Deriving "which field was wrong"
 * from `"error parsing regexp: …"` would be a second grammar to maintain
 * against a Go project's log strings, and it would go stale the first time
 * Traefik reworded one.
 */
export interface TraefikRouterError {
  /** Docker's own timestamp for the line, RFC3339Nano, from `--timestamps`. */
  at: string;
  /** e.g. `my-app-router-3@file` — the `@provider` suffix already stripped. */
  routerName: string;
  message: string;
}

/** `\x1b[…m`, which Traefik's console writer emits when stdout is a TTY. */
// ESC *is* the character being matched: Traefik's console writer colours its
// fields and `docker logs` hands those bytes through unchanged, so a parser
// that will not name the control character cannot read the log.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Docker's `--timestamps` prefix: an RFC3339Nano stamp, a space, then the
 * line the container wrote. Anchored, so a line the container itself began
 * with a timestamp — which Traefik's console format does — cannot be mistaken
 * for the prefix once the real one is consumed.
 */
const DOCKER_STAMP = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s(.*)$/s;

/**
 * zerolog's console `key=value` pairs. A value is either bare (no space) or
 * double-quoted with Go's `%q` escaping — Traefik's error strings are the
 * second kind, since they all contain spaces.
 */
const consoleField = (line: string, key: string): string | undefined => {
  const at = line.indexOf(`${key}=`);
  if (at === -1) return undefined;
  let i = at + key.length + 1;
  if (line[i] !== '"') {
    const end = line.indexOf(' ', i);
    return end === -1 ? line.slice(i) : line.slice(i, end);
  }
  i += 1;
  let out = '';
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      out += line[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') return out;
    out += ch;
    i += 1;
  }
  return out;
};

/**
 * zerolog's console sentence: everything between the level and the first
 * `key=value` pair. Traefik writes a router rejection in one of two shapes —
 * `ERR error="…" routerName=…`, whose sentence is a field, and
 * `ERR Router uses a nonexistent certificate resolver certificateResolver=…
 * routerName=…`, whose sentence is the line's own message and which carries no
 * `error=` at all. Reading only the first made the Domains notice
 * report silence over the second.
 *
 * A field starts at a space followed by a bare `word=`, which is zerolog's own
 * spelling; Traefik's sentences are prose and carry no such token.
 */
const FIELD_START = /\s[A-Za-z][A-Za-z0-9_.-]*=/;

const consoleMessage = (afterLevel: string): string | undefined => {
  const field = FIELD_START.exec(afterLevel);
  const text = (field ? afterLevel.slice(0, field.index) : afterLevel).trim();
  return text || undefined;
};

/** Traefik's `log.format: json` line, when a host has set one. */
const fromJson = (
  line: string,
): { routerName: string; message: string } | undefined => {
  if (!line.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.level !== 'error') return undefined;
  const routerName = record.routerName;
  // `error` when the line has one, else the line's own sentence — the json
  // spelling of the same two shapes the console writer has.
  const message =
    typeof record.error === 'string' ? record.error : record.message;
  if (typeof routerName !== 'string' || typeof message !== 'string') {
    return undefined;
  }
  return { routerName, message };
};

/**
 * The router-rejection lines in a chunk of `docker logs --timestamps` output
 * (H-38).
 *
 * **Both of Traefik's log formats, because a host can be on either.** The
 * `traefik.yml` `deploy/install.sh` and `servers/server-setup.ts` write sets
 * `log.level: INFO` and no `log.format`, which is zerolog's console writer —
 * `2026-…Z ERR error="…" entryPointName=web routerName=my-app-router-3@file`,
 * ANSI-wrapped. An operator who edits that file through
 * `/settings/traefik/config` may set `format: json`, and then the same fact
 * arrives as one JSON object. Reading only the format this repo generates would
 * make the surface go quiet on exactly the hosts whose operator cared most
 * about their logs, so both are read and the JSON branch is tried first because
 * it is unambiguous.
 *
 * **Why the log at all, rather than Traefik's API.** `/api/http/routers`
 * carries the same fact in a typed `error` array and a `status: "disabled"`,
 * and it is not reachable: the generated `traefik.yml` has no `api` key, so
 * traefik:v3.6.7 listens on :80 and :443 only and a request to :8080 is refused
 * at connect. `api` is *static* configuration, so switching it on means
 * rewriting `traefik.yml` and restarting Traefik — every connection on 80 and
 * 443 — which this product already refuses to do on the operator's behalf for
 * the access log (`deploy/install.sh`, the `accessLog` note). The application
 * log is the same fact from a source that is already on, already at INFO, and
 * already reachable on both server kinds through the Docker layer.
 *
 * Non-error lines, lines about a router this instance did not write, and lines
 * with no `routerName` at all are dropped here rather than by the caller: the
 * shape of the return type is "rejections", and a caller that had to re-filter
 * would be the second place the format is known.
 */
export const parseTraefikRouterErrors = (
  dockerLogs: string,
): TraefikRouterError[] => {
  const errors: TraefikRouterError[] = [];

  for (const raw of dockerLogs.split('\n')) {
    const line = raw.replace(ANSI, '').trim();
    if (!line) continue;

    const stamped = DOCKER_STAMP.exec(line);
    if (!stamped) continue;
    const [, at, rest] = stamped;

    const json = fromJson(rest);
    if (json) {
      errors.push({ at, ...json, routerName: stripProvider(json.routerName) });
      continue;
    }

    // `ERR` is zerolog's console spelling of level=error. Checked before the
    // fields so an INFO line mentioning a router — the provider-start lines do
    // not, but nothing promises they never will — cannot be read as a refusal.
    const level = /\bERR\b/.exec(rest);
    if (!level) continue;
    const routerName = consoleField(rest, 'routerName');
    const message =
      consoleField(rest, 'error') ??
      consoleMessage(rest.slice(level.index + level[0].length));
    if (!routerName || !message) continue;
    errors.push({ at, routerName: stripProvider(routerName), message });
  }

  return errors;
};

/**
 * `my-app-router-3@file` → `my-app-router-3`. The suffix is the provider that
 * supplied the router, and every router Cloudgate writes comes from the file
 * provider; keeping it would make every index lookup carry a constant.
 */
const stripProvider = (name: string): string => name.split('@')[0];
