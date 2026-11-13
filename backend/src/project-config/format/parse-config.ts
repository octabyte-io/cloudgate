import { parse, YAMLParseError } from 'yaml';
import type { z } from 'zod';

import {
  EXPRESSIBLE_KINDS,
  MYSQL_USER_MAX_LENGTH,
  projectConfigWireSchema,
  SOURCE_KEYS,
  SOURCE_PROVIDERS,
} from './config-schema';
import { SIZE_NAMES } from './config-size';
import {
  defaultDatabaseIdentifier,
  defaultPostgresUser,
  fromWire,
  POSTGRES_RESERVED_ROLE,
  postgresReservesRole,
} from './config-wire';
import { forwardRenamedAddresses } from '../../native/address-snapshot';
import type { NativeAddressRenames } from '../../native/address-snapshot';
import type {
  ConfigRefusal,
  ParseResult,
  ProjectConfig,
  ServiceEntry,
} from '../project-config.types';

/**
 * Reads a `version: 1` Project config from its text. YAML, and so
 * JSON too, which is valid YAML. The result is either the config in backend
 * field names or one {@link ConfigRefusal} naming where the text went wrong —
 * the first problem, not a list, because a plan is refused by any one of them
 * and the operator fixes them in order.
 *
 * `version` is read before anything else: a file in a format this Cloudgate
 * does not know has no "unknown field" in it, only an unknown version, and
 * reporting `web.foo` for a version 2 file would send the operator after the
 * wrong thing.
 */
export function parseProjectConfig(
  text: string,
  options: {
    /** The rename table; the committed one but in a test of a rename. */
    readonly renames?: NativeAddressRenames;
  } = {},
): ParseResult {
  let document: unknown;
  try {
    // `logLevel` is stated, not inherited: `parse` otherwise prints warnings
    // to stderr (`yaml-parse-log-level.spec.ts`). A low alias budget,
    // since a config has no use for aliases at the scale that is an attack.
    document = parse(text, { logLevel: 'error', maxAliasCount: 100 });
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error;
    return refuse({
      reason: 'syntax',
      at: null,
      message: `The Project config is not valid YAML: ${error.message.split('\n')[0].replace(/:$/, '')}`,
    });
  }

  if (!isMap(document)) {
    return refuse({
      reason: 'invalid',
      at: null,
      message: 'The Project config must be a map with version and services',
    });
  }

  if (!('version' in document)) {
    return refuse({
      reason: 'version',
      at: 'version',
      message: 'version is required; this Cloudgate reads version 1',
    });
  }
  if (document.version !== 1) {
    return refuse({
      reason: 'version',
      at: 'version',
      message: `version ${JSON.stringify(document.version)} is not a version this Cloudgate reads; it reads version 1`,
    });
  }

  const result = projectConfigWireSchema.safeParse(document);
  if (!result.success) {
    return refuse(describeIssue(result.error.issues[0], [], document));
  }
  const forwarded = forwardRenames(fromWire(result.data), options.renames);
  if (!forwarded.ok) return refuse(forwarded.refusal);
  const { config } = forwarded;
  const tooLong = defaultMysqlUserTooLong(config);
  if (tooLong) return refuse(tooLong);
  const postgresUser = postgresUserRefusal(config);
  if (postgresUser) return refuse(postgresUser);
  return { ok: true, config };
}

/**
 * Every described entry's `native.aws` and `native.gcp` under the addresses
 * generated now (ADR-0044 rule 10): an address a rename moved is read
 * as its new name, so a file written before the rename plans exactly as one
 * written after, and the entry keeps what it renamed for the plan's warning.
 * Here, not in the planner, so every reader of the config (plan, console
 * save, deploy) sees one set of names.
 */
function forwardRenames(
  config: ProjectConfig,
  renames: NativeAddressRenames | undefined,
): { ok: true; config: ProjectConfig } | { ok: false; refusal: ConfigRefusal } {
  const services: Record<string, ServiceEntry> = {};
  for (const [name, entry] of Object.entries(config.services)) {
    if (entry.managed === 'console' || entry.native === undefined) {
      services[name] = entry;
      continue;
    }
    const aws = forwardRenamedAddresses(
      name,
      entry.kind,
      'aws',
      entry.native.aws,
      renames,
    );
    const gcp = forwardRenamedAddresses(
      name,
      entry.kind,
      'gcp',
      entry.native.gcp,
      renames,
    );
    const refused = ({ at, message }: { at: string; message: string }) => ({
      ok: false as const,
      refusal: { reason: 'invalid' as const, at, message },
    });
    if (!aws.ok) return refused(aws);
    if (!gcp.ok) return refused(gcp);
    const renamed = [...aws.renamed, ...gcp.renamed];
    services[name] =
      renamed.length === 0
        ? entry
        : {
            ...entry,
            native: { ...entry.native, aws: aws.block, gcp: gcp.block },
            nativeRenamed: renamed,
          };
  }
  return { ok: true, config: { ...config, services } };
}

/**
 * A `mysql` with no `user` takes its Config name with `-` turned into `_`
 * and MySQL takes no user name past 32 characters. The schema
 * refuses a written one; one that would only be defaulted is refused here,
 * since the schema does not see the key. Never shortened: the app connects
 * as the name the operator can read in the config.
 */
function defaultMysqlUserTooLong(config: ProjectConfig): ConfigRefusal | null {
  for (const [name, entry] of Object.entries(config.services)) {
    if (entry.kind !== 'mysql' || entry.managed === 'console') continue;
    if (entry.databaseUser !== undefined) continue;
    const user = defaultDatabaseIdentifier(name);
    if (user.length <= MYSQL_USER_MAX_LENGTH) continue;
    return {
      reason: 'invalid',
      at: `${name}.user`,
      message: `${name}.user: with no user, it would be ${user}, which is longer than MySQL's ${MYSQL_USER_MAX_LENGTH} characters; write a shorter user:`,
    };
  }
  return null;
}

/** PostgreSQL's limit on a role name, past which it truncates one. */
const POSTGRES_ROLE_MAX_LENGTH = 63;

/**
 * A `postgres`'s `user` that every target would refuse, before any
 * create: a written one PostgreSQL reserves, or a defaulted `app_pg_…` past
 * 63 characters, which only a Config name of 60 or more starting `pg-` gets.
 * Never shortened, as {@link defaultMysqlUserTooLong} is not.
 */
function postgresUserRefusal(config: ProjectConfig): ConfigRefusal | null {
  for (const [name, entry] of Object.entries(config.services)) {
    if (entry.kind !== 'postgres' || entry.managed === 'console') continue;
    const at = `${name}.user`;
    if (entry.databaseUser !== undefined) {
      if (!postgresReservesRole(entry.databaseUser)) continue;
      return {
        reason: 'invalid',
        at,
        message: `${at}: ${POSTGRES_RESERVED_ROLE}`,
      };
    }
    const user = defaultPostgresUser(name);
    if (user.length <= POSTGRES_ROLE_MAX_LENGTH) continue;
    return {
      reason: 'invalid',
      at,
      message: `${at}: with no user, it would be ${user}, which is longer than PostgreSQL's ${POSTGRES_ROLE_MAX_LENGTH} characters; write a user:`,
    };
  }
  return null;
}

function refuse(refusal: ConfigRefusal): ParseResult {
  return { ok: false, refusal };
}

type Issue = z.core.$ZodIssue;
type Path = readonly PropertyKey[];

/**
 * One Zod issue, as the sentence an operator reads. `base` is the path of the
 * union an issue was found inside, since a branch's issues are relative to it.
 */
function describeIssue(
  issue: Issue,
  base: Path,
  document: unknown,
): ConfigRefusal {
  const path = [...base, ...issue.path];
  const at = (...more: PropertyKey[]) => dotted([...path, ...more]);

  switch (issue.code) {
    case 'unrecognized_keys': {
      const field = at(issue.keys[0]);
      const entry = entryOf(path, document);
      const reason =
        entry && 'managed' in entry
          ? 'a console-managed entry has only kind and managed'
          : 'it is not a field Cloudgate knows';
      return { reason: 'invalid', at: field, message: `${field}: ${reason}` };
    }

    case 'invalid_key': {
      const key = String(path[path.length - 1]);
      return {
        reason: 'invalid',
        at: key,
        message: `${JSON.stringify(key)} is not a Config name: use lowercase letters, digits and hyphens, starting with a letter, at most 63 characters`,
      };
    }

    case 'invalid_union':
      return describeUnion(issue, path, document);

    default: {
      const field = at();
      const missing = valueAt(document, path) === undefined;
      // Zod's own messages read "Invalid input: expected number, …"; the
      // schema's read as a predicate ("cannot be empty"). Both follow the field.
      const zodDefault = /^Invalid (input|option): /;
      const message = missing
        ? `${field} is required${requiredBecause(path, document)}`
        : zodDefault.test(issue.message)
          ? `${field}: ${issue.message.replace(zodDefault, '')}`
          : `${field} ${issue.message}`;
      return { reason: 'invalid', at: field, message };
    }
  }
}

/**
 * Why a missing field is required, when the reason is not the field itself:
 * a `web-private`'s `port` is how its callers reach it, and an entry that
 * serves nothing is a `worker`.
 */
function requiredBecause(path: Path, document: unknown): string {
  const entry = entryOf(path, document);
  if (
    entry?.kind === 'web-private' &&
    path.length === 3 &&
    path[2] === 'port'
  ) {
    return '; a Private web service is reached at its port. If it serves nothing, make it kind: worker';
  }
  return '';
}

/**
 * A union's failure names the branch the operator meant, not every branch
 * that failed. A Service entry is chosen by its keys — `managed` present is the
 * console-managed form, otherwise its `kind` picks the form. Any other union
 * (a `source`, a `size`) is the branch whose root type matched and which has
 * the fewest problems; when no single branch is that, the field is named with
 * the forms it takes.
 */
function describeUnion(
  issue: Extract<Issue, { code: 'invalid_union' }>,
  path: Path,
  document: unknown,
): ConfigRefusal {
  const field = dotted(path);
  const value = valueAt(document, path);

  if (isEntryPath(path)) {
    if (!isMap(value)) {
      return {
        reason: 'invalid',
        at: field,
        message: `${field} must be a map with a kind`,
      };
    }
    const branch = 'managed' in value ? issue.errors[0] : issue.errors[1];
    const first = branch[0];
    if (first.code === 'invalid_union' && first.errors.length === 0) {
      // The discriminated union found no form for this `kind`.
      if (value.kind === undefined) {
        return {
          reason: 'invalid',
          at: `${field}.kind`,
          message: `${field}.kind is required`,
        };
      }
      return {
        reason: 'invalid',
        at: `${field}.kind`,
        message: `${field}.kind: ${JSON.stringify(value.kind)} is not a kind version 1 describes (${EXPRESSIBLE_KINDS.join(', ')}); list it with managed: console and nothing else`,
      };
    }
    return describeIssue(first, path, document);
  }

  if (folderOnWebPrivate(path, value, document)) {
    return {
      reason: 'invalid',
      at: field,
      message: `${field} cannot name a folder on a web-private: only a web, a worker, a static or a cron is built from a subfolder of the Project folder`,
    };
  }
  const combined = folderCombinedWith(path, value, document);
  if (combined !== null) {
    return {
      reason: 'invalid',
      at: field,
      message: `${field} names a subfolder of the Project folder, so folder cannot be combined with ${combined}; the whole folder is uploaded and built from that subfolder`,
    };
  }

  const branches: readonly Issue[][] = issue.errors;
  const candidates = branches.filter(
    (branch) =>
      !branch.some(
        (i) =>
          i.path.length === 0 &&
          (i.code === 'invalid_type' || i.code === 'invalid_value'),
      ),
  );
  const fewest = Math.min(...candidates.map((branch) => branch.length));
  const best = candidates.filter((branch) => branch.length === fewest);
  if (best.length === 1) return describeIssue(best[0][0], path, document);

  return {
    reason: 'invalid',
    at: field,
    message: `${field} ${unionForms(path, document)}`,
  };
}

/**
 * The other source key an application's `source` names beside `folder`, or
 * `null`. Both branches fail on one unknown key each, so the generic rule
 * would name neither; the operator meant one source, and this says which
 * two they wrote (ADR-0080).
 */
function folderCombinedWith(
  path: Path,
  value: unknown,
  document: unknown,
): string | null {
  if (path[path.length - 1] !== 'source' || !isMap(value)) return null;
  if (!('folder' in value) || entryOf(path, document)?.kind === 'compose') {
    return null;
  }
  return SOURCE_KEYS.find((key) => key in value) ?? null;
}

/** Whether a `web-private`'s `source` names a folder, which it never may. */
function folderOnWebPrivate(
  path: Path,
  value: unknown,
  document: unknown,
): boolean {
  return (
    path[path.length - 1] === 'source' &&
    isMap(value) &&
    'folder' in value &&
    entryOf(path, document)?.kind === 'web-private'
  );
}

function unionForms(path: Path, document: unknown): string {
  switch (path[path.length - 1]) {
    case 'source':
      // A stack's compose file is in a repository, named by `file`.
      if (entryOf(path, document)?.kind === 'compose') {
        return `must name the repository its compose file is in: ${SOURCE_PROVIDERS.join(', ')} (owner/repo) or git (a URL); the file's path in it is file:`;
      }
      return `must name one source: ${SOURCE_PROVIDERS.join(', ')} (owner/repo), git (a URL), image (not a static Service), or folder (a subfolder of the Project folder)`;
    case 'size':
      return `must be one of ${SIZE_NAMES.join(', ')}, or { cpu, memory } with both, e.g. { cpu: 1, memory: 2 GB }`;
    default:
      return 'is not a form this field takes';
  }
}

function isEntryPath(path: Path): boolean {
  return path.length === 2 && path[0] === 'services';
}

/** The Service entry a path is inside, if it is inside one. */
function entryOf(
  path: Path,
  document: unknown,
): Record<string, unknown> | null {
  if (path.length < 2 || path[0] !== 'services') return null;
  const entry = valueAt(document, path.slice(0, 2));
  return isMap(entry) ? entry : null;
}

/** `services.web.source.git` → `web.source.git`: the Service is the subject. */
function dotted(path: Path): string {
  const names =
    path[0] === 'services' && path.length > 1 ? path.slice(1) : path;
  return names.map(String).join('.');
}

function valueAt(document: unknown, path: Path): unknown {
  let value: unknown = document;
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
