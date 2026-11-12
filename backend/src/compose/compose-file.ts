/**
 * The compose file preparation that needs nothing but the file's text: its
 * parse, the ports it publishes, the platform defaults written into a
 * converted file, and the dotenv line a stack's `.env` is written in. It is
 * `compose.utils.ts`' pure part, kept apart so that `cloudgate template try`
 * can bundle it from source (spec #5) and prepare a Template's compose part
 * as an Instance does: nothing reachable from here may load Traefik, the
 * volume lock, a Docker client or Nest at runtime
 * (`test/compose/compose-file.spec.ts`).
 */
import { parse } from 'yaml';

import {
  CONTAINER_LOG_DRIVER,
  containerLogOptions,
} from '../common/config/container-logs';
import type { ComposeSpecification, ComposeSpecSource } from './compose.types';

// Compose parsing with no disk IO: the content is parsed wherever it came from
// (the composeFile column or a cloned repository).

/**
 * Parses compose YAML content into a structured spec; null when empty.
 *
 * **`logLevel: 'error'` is not cosmetic.** `compose.composeFile`
 * is `encryptedText` now, so where its bytes are echoed is part of the
 * classification (ADR 0015) — and this call was the one echo that was neither
 * an author reading their own file back nor the base64 wire shape
 * `error-payloads.ts` elides. `yaml` defaults `logLevel` to `'warn'`;
 * `parseDocument` prettifies **warnings** with the same
 * `prettifyError(source, lineCounter)` it gives errors, so a `YAMLWarning`'s
 * message carries up to 80 characters of the caller's own document plus a
 * caret; and `log.warn` is `process.emitWarning`, which — with no
 * `process.on('warning')` handler anywhere in `src/` — Node's default handler
 * formats onto process **stderr**. Six warning classes are reachable from an
 * operator-authored file (`BAD_DIRECTIVE`, `TAG_RESOLVE_FAILED`, `BAD_ALIAS`,
 * `BAD_INDENT`, the ambiguous-anchor one and the may-be-parsed-as-either one),
 * and a `!!tag` on an `environment:` entry puts the warning's position on the
 * credential's own line. The document still *parses*, which is what made it
 * invisible: no exception exists at any point, so `ExecError`,
 * `elideEncodedPayloads`, `capMessage` and `AllExceptionsFilter` are all
 * downstream of a path that never reaches them, and the leak fires on the
 * read-only routes too.
 *
 * **`'silent'` is rejected, measured rather than read off the documentation**:
 * on `services:\n  db: [unclosed` it makes `parse` *return*
 * `{ services: { db: ['unclosed'] } }` instead of throwing, because
 * `public-api.js` swallows `doc.errors` at that level — which would take
 * {@link composeFileParseRefusal}'s whole contract with it and deploy a
 * half-read document. `'error'` raises the identical `YAMLParseError` the
 * default does; `compose-file-parseable.spec.ts` holds both halves apart.
 *
 * `maxAliasCount` is the other half of this boundary and belongs to a different
 * problem — the expansion bomb {@link composeFileParseRefusal} answers as a
 * `ReferenceError`.
 */
export function parseComposeFile(content: string): ComposeSpecification | null {
  const parsed = parse(content, {
    maxAliasCount: 10_000,
    logLevel: 'error',
  }) as ComposeSpecification | null | undefined;
  return parsed ?? null;
}

/** One fixed TCP port a compose file publishes on its machine's address. */
export interface ComposePublishedPort {
  /** The port on the machine. */
  published: number;
  /** The container port it forwards to. */
  target: number;
  /** The compose service that publishes it. */
  service: string;
}

/** A range longer than this is not expanded into choices (`1-65535`). */
const PUBLISHED_RANGE_LIMIT = 100;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** `8080` → [8080], `8000-8002` → [8000, 8001, 8002]; anything else → []. */
function portNumbers(raw: unknown): number[] {
  const text = typeof raw === 'number' ? String(raw) : raw;
  if (typeof text !== 'string') return [];
  const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(text.trim());
  if (!match) return [];
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from < 1 || to > 65535 || to < from) return [];
  if (to - from >= PUBLISHED_RANGE_LIMIT) return [];
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/**
 * Every fixed TCP port a compose file's services publish — what a
 * Compose TCP Uptime check may dial, on the machine's address rather than an
 * inner service. Both of compose's spellings are read: the short
 * `"[host:]published:target[/protocol]"` and the long `{ published, target,
 * protocol, host_ip }`.
 *
 * Left out, because no dial of the machine's address could reach them: a
 * container port with no published side (compose picks one at random), a UDP
 * port, a port bound to loopback, and a value compose interpolates (`${PORT}`)
 * on the build server after anything here has read it. A file that does not
 * parse publishes nothing.
 */
export function listComposePublishedPorts(
  content: string,
): ComposePublishedPort[] {
  let spec: ComposeSpecification | null;
  try {
    spec = parseComposeFile(content);
  } catch {
    return [];
  }
  const found: ComposePublishedPort[] = [];
  for (const [service, definition] of Object.entries(spec?.services ?? {})) {
    const ports: unknown = definition?.ports;
    if (!Array.isArray(ports)) continue;
    for (const entry of ports) {
      let hostIp: string | undefined;
      let published: unknown;
      let target: unknown;
      let protocol: unknown;
      if (typeof entry === 'string') {
        const [binding, proto] = entry.split('/');
        protocol = proto;
        // A bracketed IPv6 host (`[::1]:8080:80`) keeps its colons.
        const ipv6 = /^\[([^\]]+)\]:(.*)$/.exec(binding);
        const rest = ipv6 ? ipv6[2] : binding;
        const parts = rest.split(':');
        if (ipv6) {
          hostIp = ipv6[1];
          [published, target] = parts;
        } else if (parts.length === 3) {
          [hostIp, published, target] = parts;
        } else if (parts.length === 2) {
          [published, target] = parts;
        } else {
          continue;
        }
      } else if (entry && typeof entry === 'object') {
        const long = entry as Record<string, unknown>;
        published = long.published;
        target = long.target;
        protocol = long.protocol;
        hostIp = typeof long.host_ip === 'string' ? long.host_ip : undefined;
      } else {
        continue;
      }
      if (protocol !== undefined && protocol !== 'tcp') continue;
      if (hostIp && LOOPBACK_HOSTS.has(hostIp)) continue;
      const outside = portNumbers(published);
      const inside = portNumbers(target);
      outside.forEach((port, index) =>
        found.push({
          published: port,
          target: inside[index] ?? inside[0] ?? port,
          service,
        }),
      );
    }
  }
  return found;
}

/** The compose policy Cloudgate defaults when the author's file is silent. */
export const DEFAULT_COMPOSE_RESTART = 'unless-stopped';

/**
 * The platform defaults Cloudgate writes into the **converted** compose file —
 * the copy it owns and already rewrites for Traefik labels and the routed
 * network — as opposed to the operator's own file, which is never touched. That
 * distinction is what makes this acceptable where a volume re-attachment
 * was not: that one would have written a 64-hex volume id into a file the
 * operator maintains.
 *
 * **Presence is the author's statement; absence is the product's default.** A
 * service that declares the key keeps it, whole and unmerged. For `restart:`
 * that includes `restart: "no"`: nothing distinguishes a deliberate `no` from a
 * thoughtless omission except the key being there, so the key being there is
 * the rule. For `logging:` it means an author who writes
 * `driver: json-file` with no options, or `driver: none`, gets what they asked
 * for — merging our two options into their block would half-override a
 * deliberate choice, and a half-overridden block is worse than either outcome.
 * The accepted residual is that a tenant who writes an unbounded
 * `logging:` block can still fill the platform host's disk; a quota or an
 * admission-time refusal would be a different decision, not a merge.
 *
 * The type gates differ and are not an oversight. `restart:` is
 * `docker-compose` only, because `docker stack deploy` ignores it and prints
 * "Ignoring unsupported options: restart" on every deploy, while a Swarm
 * service already comes back from `deploy.restart_policy`'s default
 * `condition: any` — which is the asymmetry the restart default was written for: on a rebooted
 * host every Swarm service reconverged and every compose container stayed
 * `exited` with `RestartPolicy=no`. `logging:` applies to **both**, because
 * `docker stack deploy` maps it onto the same `TaskTemplate.LogDriver` that
 * `mechanize.ts` sets for an Application. Do not make the two symmetrical.
 *
 * `unless-stopped` and not `always`: `ComposeService.stop` runs
 * `docker compose stop` and leaves the containers `Exited` on purpose, and
 * `always` would resurrect a stack the operator stopped while its Cloudgate row
 * still says `stopped`.
 *
 * The `logging` block is built fresh per service rather than shared: `stringify`
 * emits YAML anchors and aliases for a repeated object, so one hoisted object
 * would put `*a1` in the file an operator reads on the Converted tab.
 * `containerLogOptions()` is read on every call and never captured at import
 * (§2.8) — `CONTAINER_LOG_MAX_SIZE` and `CONTAINER_LOG_MAX_FILE` are env knobs
 * `deploy/install.sh` writes into the backend's env file.
 *
 * **Two callers, not one, and the second is the point of H-98.**
 * {@link writeDomainsToCompose} applies this on the way to a deploy, and
 * {@link composeStartCommand} re-applies it to the converted file already on
 * disk on the way to `docker compose up -d` — because a stack whose stored file
 * predates those defaults carries neither key, and Start creates containers from that
 * file. It takes only `composeType` so that both callers can hand it what they
 * have: `start` addresses a file, not a deploy, and has no
 * `isolatedDeployment` question to answer.
 */
export function applyComposeDefaults(
  compose: Pick<ComposeSpecSource, 'composeType'>,
  spec: ComposeSpecification,
  env: NodeJS.ProcessEnv = process.env,
): ComposeSpecification {
  for (const service of Object.values(spec.services ?? {})) {
    // `??=` is the precedence rule and nothing may stand in for it: it writes
    // only where the key is `undefined` or `null`, so an explicit
    // `restart: false` and an author's empty `logging: {}` are both left alone
    // where a truthiness check would overwrite both. (A bare `restart: no`
    // reads as the *string* `"no"` here — `yaml`'s YAML 1.2 core schema drops
    // 1.1's `yes`/`no` booleans — and round-trips back unquoted, so Docker sees
    // what the author wrote either way.)
    service.logging ??= {
      driver: CONTAINER_LOG_DRIVER,
      options: containerLogOptions(env),
    };
    if (compose.composeType === 'docker-compose') {
      service.restart ??= DEFAULT_COMPOSE_RESTART;
    }
  }
  return spec;
}

/**
 * Characters Docker Compose's `.env` reader treats specially in an unquoted
 * value: `$` interpolates, ` #` starts a comment, a leading quote is
 * stripped, a backslash may escape, a newline ends the entry.
 */
const DOTENV_SPECIAL = /[\s"'`$#\\]/;

/**
 * One `KEY=value` line as Docker Compose reads it back exactly. A value
 * holding nothing special stays as it is; any other is double-quoted with
 * `\`, `"`, `$` and newlines escaped, the one quoting Compose reads every
 * value back from (single quotes cannot end in a backslash). Unquoted, a
 * stored `p$ss #1` reached the container as `p`, and a newline split the
 * file. The Swarm path quotes its `export`s for the same reason.
 */
export function composeDotenvLine(line: string): string {
  const at = line.indexOf('=');
  const value = line.slice(at + 1);
  if (at === -1 || !DOTENV_SPECIAL.test(value)) return line;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/\r?\n/g, '\\n');
  return `${line.slice(0, at)}="${escaped}"`;
}
