import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { ApplicationsService } from '../../src/applications/applications.service';
import { ComposeService } from '../../src/compose/compose.service';
import { LibsqlService } from '../../src/databases/libsql/libsql.service';
import { MariadbService } from '../../src/databases/mariadb/mariadb.service';
import { MongoService } from '../../src/databases/mongo/mongo.service';
import { MysqlService } from '../../src/databases/mysql/mysql.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { RedisService } from '../../src/databases/redis/redis.service';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import {
  bitbucket,
  environment,
  gitea,
  github,
  gitlab,
  project,
  registry,
  server,
  sshKey,
} from '../../src/db/schema';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { defaultMetricsConfig } from '../../src/servers/server.schema';

/**
 * The property, stated once:
 *
 * > a relation included on a service read carries no secret — the whole column
 * > where the column *is* the credential, the field where the column is mostly
 * > configuration — and which columns those are is derived from the schema
 * > rather than listed at the call site
 *
 * **What broke, and why nine projections were the defect rather than the fix.**
 * `server.metricsConfig` decrypts on read and `metricsConfig.server.token` is
 * the entirety of `POST /notifications/receive`'s authentication. The nested
 * `server` relation on `GET /applications/:id`, `GET /compose/:id` and all six
 * database service reads spread the row whole, behind
 * `checkServiceAccess(ctx, id, 'read')` — which the base `memberRole` satisfies
 * with one id in `accessedServices`, while that role holds `notification: []`.
 * So a member who could not list an organization's channels could write
 * attacker-chosen text into all of them, unauthenticated, from off-instance.
 * `test/servers/nested-server-secrets.e2e-spec.ts` runs that attack.
 *
 * The token was not the finding. Those same reads carried **hand-written**
 * denylists — `registry: { columns: { password: false } }`,
 * `github: { columns: { clientSecret: false, privateKey: false } }` — and the
 * hand was wrong in four places at once:
 *
 * - `customGitSSHKey: true` returned the whole `ssh_key` row, `privateKey`
 *   included, which is the secret `SshKeysService`'s whole projection withholds;
 * - `github` withheld two of three and not `webhookSecret`, which
 *   `GithubService.sanitize` withholds with the sentence *"handing it out would
 *   let any reader forge one"*;
 * - `gitlab` withheld both tokens and not `secret`, the OAuth application
 *   secret its own `SanitizedGitlab` withholds;
 * - and the `server` row was spread whole, which is the ticket.
 *
 * That is `stripSshPrivateKey`'s finding at a different scale: a list
 * *named for the columns somebody happened to think of*, with nowhere for the
 * next one to be declared, repeated at nine sites so that four of them could
 * disagree. `src/common/service-read-relations.ts` is the one place; this file
 * is what checks the place is full, and it derives the requirement rather than
 * tabulating it — the shape `web-server-settings-projection.spec.ts` argues for
 * and `secret-bearing-columns.spec.ts` supplies the completeness half of.
 *
 * **Two signals, and the first one is complete here in a way it is not on the
 * settings singleton.** `secret-bearing-columns.spec.ts` already asserts that a
 * column whose name says it holds a credential is `encryptedText` or
 * `encryptedJson`, so *encrypted at rest* is not merely a floor for these
 * tables: a credential column that is not encrypted is already red next door.
 * That lets this file read one signal off drizzle (`PgCustomColumn`) and skip
 * the credential vocabulary at the column level entirely — which matters,
 * because the vocabulary over-matches badly here: `sshKeyId` and `publicKey`
 * are both "key" and both must be returned. The vocabulary is still the second
 * signal at the depth `drizzle-kit` cannot see — a *field* inside a declared
 * blob, which is where `metricsConfig`'s secret lives.
 *
 * **What this file deliberately does not cover.** Relations on reads of
 * something *other* than a Service: `DomainsService.findOne` includes
 * `application` and `compose` whole, and `BackupsService.findAll` includes
 * `destination`. Those rows are the caller's own Service and its declared
 * destination, not a credential the Service merely references, and the tables
 * are not in {@link RELATION_TABLES} — so a `server: true` added to either
 * *would* be caught by `every service read that includes one of these relations
 * is declared here`, and a new secret column on `application` would not. The
 * limit is recorded rather than left to be discovered.
 */

const backendRoot = join(__dirname, '..', '..');

/**
 * Every relation name a read may include that resolves to a table which can
 * carry a credential, and the table it resolves to.
 *
 * Keyed by relation name because that is what a `with` block spells, but two
 * names resolve to `registry` (pull and push credentials) and two to `server`
 * (`server` and `buildServer`): declaring the *table* is what stops those pairs
 * drifting apart, and it is why `src/common/service-read-relations.ts` is keyed
 * by table too.
 *
 * `environment` and `project` are here because they are on every one of these
 * reads and both carry an `encryptedText` column — so they have to be
 * classified rather than silently skipped, which {@link RETURNED_ENCRYPTED}
 * does with the argument.
 */
const RELATION_TABLES: Readonly<Record<string, PgTable>> = {
  environment,
  project,
  customGitSSHKey: sshKey,
  registry,
  buildRegistry: registry,
  github,
  gitlab,
  gitea,
  bitbucket,
  server,
  buildServer: server,
};

/**
 * Columns encrypted at rest that a service read still returns, keyed
 * `relation.column`, each with the sentence that makes it one. A reason rather
 * than a bare name, on the deploy-webhook bug's lesson: a list of names with no
 * argument beside them is the artefact this family of specs exists because of.
 */
const RETURNED_ENCRYPTED: Readonly<Record<string, string>> = {
  'server.metricsConfig': [
    'the secret is one field deep, not the column. The blob is the host’s',
    'sampling configuration — refresh rates, ports, thresholds, retention, the',
    'container include/exclude lists — and only `server.token` authenticates',
    'anything, so the column is returned and the field is withheld at its own',
    'depth (ADR 0019). That depth is also the only place its presence flag may',
    'stand: `hasToken` is what the console’s `isCollecting` reads, and lifting',
    'it to the row is what the ADR forbids.',
  ].join(' '),
  'buildServer.metricsConfig': 'The same column through the other relation.',
  'environment.env': [
    'the env chain the service’s own deploy interpolates. A caller entitled to',
    'this Service already receives these variables inside its own container —',
    '`prepareEnvironmentVariables(defaultEnv, project.env, environment.env)` —',
    'and the Service’s own `env` column is returned beside it on the root row,',
    'so withholding the chain discloses nothing and breaks the screen that',
    'edits it. Not a credential the Service *references*, which is the',
    'distinction this whole property turns on.',
  ].join(' '),
  'project.env': 'The same argument one level up the chain.',
};

/**
 * Fields inside a returned blob that the read withholds. Derived the same way —
 * {@link namesACredential} over the column's declared default decides *that* a
 * field must be withheld — so this map carries only the reasons, and a field
 * the vocabulary flags with no entry here fails by name.
 */
const WITHHELD_FIELDS: Readonly<Record<string, string>> = {
  'metricsConfig.server.token': [
    'the metrics agent credential. `POST /notifications/receive` authenticates',
    'on possession of it alone, and the copy on a `server` row drives',
    '`receiveServerThreshold`’s Remote branch —',
    '`dispatch(found.organizationId, …)`, every channel the organization has',
    '.',
  ].join(' '),
};

/** Declared defaults of a returned blob column, keyed `relation.column`. */
const BLOB_DEFAULTS: Readonly<Record<string, unknown>> = {
  'server.metricsConfig': defaultMetricsConfig,
  'buildServer.metricsConfig': defaultMetricsConfig,
};

/**
 * The words that make a name a claim about its contents, matched against whole
 * camelCase words. Deliberately the same regex as
 * `secret-bearing-columns.spec.ts` and `web-server-settings-projection.spec.ts`,
 * spelled a third time rather than imported: a jest spec exports nothing, and a
 * shared fixture between coding-standards properties would let a widening in
 * one silently change what the others assert.
 */
const VOCABULARY =
  /^(token|secret|secrets|password|passwd|credential|credentials|passphrase|salt|signature|key|keys)$/;

/** Whether a column or field name claims to hold a credential. */
function namesACredential(name: string): boolean {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => VOCABULARY.test(word));
}

/** The presence flag that stands in for a withheld field: `has` + its name. */
const presenceFlagFor = (name: string): string =>
  `has${name[0].toUpperCase()}${name.slice(1)}`;

/**
 * Whether a column is one of the secret-bearing types. `encryptedText` and
 * `encryptedJson` are drizzle `customType`s and nothing else on these tables
 * is, so `PgCustomColumn` is the whole test — `isoTimestamp` and `nanoidPk`
 * report `PgText`. Asserted below to find exactly the columns it should.
 */
const encryptedColumns = (table: PgTable): string[] =>
  Object.entries(getTableColumns(table))
    .filter(([, column]) => column.columnType === 'PgCustomColumn')
    .map(([key]) => key);

/** The leaf paths of a declared blob default, dotted. Arrays are leaves. */
function fieldsOf(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
    fieldsOf(v, prefix ? `${prefix}.${key}` : key),
  );
}

/** Read a dotted path out of a value, or `undefined`. */
const at = (value: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[key]
          : undefined,
      value,
    );

/** Whether a dotted path is present at all — `undefined` is absent. */
function has(value: unknown, path: string): boolean {
  const parent = path.includes('.')
    ? at(value, path.slice(0, path.lastIndexOf('.')))
    : value;
  if (!parent || typeof parent !== 'object') return false;
  return path.slice(path.lastIndexOf('.') + 1) in parent;
}

/** Every string anywhere in a value, for the relocation assertion. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(stringsIn);
  }
  return [];
}

/** A distinctive value for one column or field, so a *move* is detectable. */
const marker = (path: string) => `«${path}»`;

/** Every string leaf of a declared default replaced by its path's marker. */
function withMarkers(value: unknown, prefix: string): unknown {
  if (typeof value === 'string') return marker(prefix);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, v]) => [
      key,
      withMarkers(v, `${prefix}.${key}`),
    ]),
  );
}

/* ------------------------------------------------------------------ *
 * The reads, driven
 * ------------------------------------------------------------------ */

const ORGANIZATION = 'org-1';

interface RelationConfig {
  columns?: Record<string, boolean>;
  with?: Record<string, RelationConfig | true>;
}

/**
 * A row built from the relation config the service actually passed, with the
 * `columns` denylist **honoured** — the fake stands in for what Postgres does
 * with a column list, so a value the query declined to load is genuinely absent
 * and the relocation assertion below can be made over the whole answer.
 *
 * Every remaining string is the marker for where it sat, derived from the
 * schema rather than typed out: a column added to any of these tables appears
 * here with no edit, which is what lets the assertions fail by name.
 */
function rowFor(
  relation: string,
  table: PgTable,
  config: RelationConfig | true,
): Record<string, unknown> {
  const denied = config === true ? {} : (config.columns ?? {});
  const nested = config === true ? {} : (config.with ?? {});
  const row: Record<string, unknown> = {};
  for (const key of Object.keys(getTableColumns(table))) {
    if (denied[key] === false) continue;
    const blob = BLOB_DEFAULTS[`${relation}.${key}`];
    row[key] = blob ? withMarkers(blob, key) : marker(`${relation}.${key}`);
  }
  for (const [name, childConfig] of Object.entries(nested)) {
    const childTable = RELATION_TABLES[name];
    if (!childTable) continue;
    row[name] = rowFor(name, childTable, childConfig);
  }
  // The org check in every `findOne` compares this against the ctx.
  if (relation === 'project') row.organizationId = ORGANIZATION;
  return row;
}

interface Capture {
  /** The relation config the read passed, by relation name. */
  relations: Record<string, RelationConfig | true>;
  /** What the read answered. */
  answer: unknown;
}

/** `db` for one read: capture the `with` tree, answer a marker row. */
function makeDb(table: PgTable, capture: { relations?: unknown }): DrizzleDB {
  const findFirst = (config: {
    with?: Record<string, RelationConfig | true>;
  }) => {
    const relations = config.with ?? {};
    capture.relations = relations;
    const row: Record<string, unknown> = { appName: marker('root.appName') };
    for (const [name, childConfig] of Object.entries(relations)) {
      const childTable = RELATION_TABLES[name];
      // A relation this file does not know about is asserted on separately;
      // answering `null` keeps the read from throwing before that assertion.
      row[name] = childTable
        ? rowFor(name, childTable, childConfig)
        : { organizationId: ORGANIZATION };
    }
    return Promise.resolve(row);
  };
  const queries = Object.fromEntries(
    Object.keys(SERVICE_READS).map((key) => [key, { findFirst }]),
  );
  void table;
  // `ApplicationsService.findOne`'s AI-model facet is a column
  // projection beside the tree, not a relation of it, so it is no part of
  // this rule; it answers "a plain Application" here. That its upstream
  // secret is never read back is `test/ai-models/ai-model-create.e2e-spec.ts`'s.
  const select = () => ({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve([]) }),
    }),
  });
  return { query: queries, select } as unknown as DrizzleDB;
}

/** A ctx whose organization matches the marker row's. */
const ctx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: ORGANIZATION },
};

/**
 * The service reads the rule governs: `GET /applications/:id`,
 * `GET /compose/:id`, and the six engines — which are one method,
 * `BaseDatabaseService.findOne`, driven separately anyway because the claim is
 * about the HTTP surface and an engine that stopped delegating would otherwise
 * go unnoticed (`create-routes-server-id.e2e-spec.ts`' argument).
 *
 * Keyed by the drizzle query name each one reads, which is also what
 * {@link makeDb} answers on.
 */
const SERVICE_READS: Readonly<
  Record<string, { service: abstract new (...args: never[]) => object }>
> = {
  application: { service: ApplicationsService },
  compose: { service: ComposeService },
  postgres: { service: PostgresService },
  mysql: { service: MysqlService },
  mariadb: { service: MariadbService },
  mongo: { service: MongoService },
  redis: { service: RedisService },
  libsql: { service: LibsqlService },
};

/**
 * `findOne` on one service, with `db` and `permissions` stubbed and every other
 * dependency an empty object.
 *
 * Positional rather than named because that is what a Nest constructor is, and
 * only the first two positions are read on this path: `db` and `permissions`
 * are first and second on all eight (the six engines share
 * `BaseDatabaseService`'s and declare no constructor of their own). The extra
 * stubs are the remaining slots, which JS ignores if a constructor takes fewer.
 */
async function readWith(
  query: string,
): Promise<Capture & { relations: Record<string, RelationConfig | true> }> {
  const capture: { relations?: unknown } = {};
  const permissions = { checkServiceAccess: () => Promise.resolve() };
  const Service = SERVICE_READS[query].service as unknown as new (
    ...args: unknown[]
  ) => { findOne: (c: PermissionCtx, id: string) => Promise<unknown> };
  const service = new Service(
    makeDb(RELATION_TABLES.server, capture),
    permissions,
    ...Array.from({ length: 10 }, () => ({})),
  );
  const answer = await service.findOne(ctx, 'id-1');
  return {
    relations: (capture.relations ?? {}) as Record<
      string,
      RelationConfig | true
    >,
    answer,
  };
}

/** Withheld columns of one relation: encrypted, and not deliberately returned. */
const withheldColumnsOf = (relation: string): string[] =>
  encryptedColumns(RELATION_TABLES[relation]).filter(
    (column) => !(`${relation}.${column}` in RETURNED_ENCRYPTED),
  );

/* ------------------------------------------------------------------ *
 * The reads that exist at all
 * ------------------------------------------------------------------ */

/** Every `.ts` under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** The balanced `{ … }` starting at `open`. */
function block(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/**
 * Every `with: { … }` in `src` that names one of {@link RELATION_TABLES}'
 * relations, keyed `file::method`.
 *
 * Keyed by the enclosing method rather than by line, so an edit above a read
 * does not have to be reflected here. Methods in this tree are declared at one
 * indent level, which is what the pattern reads.
 */
function relationIncludes(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const file of sourceFiles(join(backendRoot, 'src'))) {
    const text = readFileSync(file, 'utf8');
    const path = relative(backendRoot, file);
    for (const match of text.matchAll(/\bwith:\s*\{/g)) {
      const open = match.index + match[0].length - 1;
      const names = Object.keys(RELATION_TABLES).filter((name) =>
        new RegExp(`\\b${name}\\s*:`).test(block(text, open)),
      );
      if (names.length === 0) continue;
      const before = text.slice(0, match.index);
      const methods = [
        ...before.matchAll(
          /^ {2}(?:async\s+)?(?:protected\s+|private\s+|public\s+)?(?:async\s+)?(\w+)\s*\(/gm,
        ),
      ];
      const method = methods.length
        ? methods[methods.length - 1][1]
        : '<top level>';
      const key = `${path}::${method}`;
      found[key] = [...new Set([...(found[key] ?? []), ...names])].sort();
    }
  }
  return found;
}

/**
 * Every read in `src` that includes one of these relations, and what it is.
 *
 * A read not listed here reds `every service read that includes one of these
 * relations is declared here`, which is the half that makes the property
 * survive a tenth read: `nested-server-secrets.e2e-spec.ts` drives three of the
 * eight over the wire and nothing at all drives a ninth.
 */
const DECLARED_READS: Readonly<Record<string, string>> = {
  'src/applications/applications.service.ts::findOne': 'service read',
  'src/compose/compose.service.ts::findOne': 'service read',
  'src/databases/postgres/postgres.service.ts::queryById': 'engine read',
  'src/databases/mysql/mysql.service.ts::queryById': 'engine read',
  'src/databases/mariadb/mariadb.service.ts::queryById': 'engine read',
  'src/databases/mongo/mongo.service.ts::queryById': 'engine read',
  'src/databases/redis/redis.service.ts::queryById': 'engine read',
  'src/databases/libsql/libsql.service.ts::queryById': 'engine read',
  'src/applications/applications.service.ts::findDeployable': [
    'internal, and the docblock exists to say so: the build needs the registry',
    'password, the git-provider tokens and the deploy key decrypted in order to',
    'push and to clone. It takes no `PermissionCtx` and no controller reaches',
    'it; `deployable-relation-projections.spec.ts` is what holds its',
    'own seam.',
  ].join(' '),
  'src/compose/compose.service.ts::findDeployable':
    'internal, the same argument one module over.',
};

/** The two reasons that mean "this read answers a caller", so it must be driven. */
const ANSWERS_A_CALLER = ['service read', 'engine read'];

/**
 * Which `file::method` in {@link DECLARED_READS} each key of
 * {@link SERVICE_READS} is.
 *
 * **This map is the only thing that makes the declaration and the driving one
 * list rather than two**, and it exists because the two halves of this file's
 * completeness argument could otherwise be satisfied separately. The `with:`
 * scan reds an *undeclared* read; the assertions drive whatever is in
 * `SERVICE_READS`. Nothing joined them — so a tenth read could be declared
 * `'service read'`, satisfying the scan, and never added to `SERVICE_READS`, so
 * no assertion in this file ever looked at its relations. That is the escape
 * hatch this closes, and it is exactly the shape of the defect this is about:
 * two lists, each individually complete, disagreeing about what they cover.
 */
const DRIVEN_KEYS: Readonly<Record<string, string>> = {
  application: 'src/applications/applications.service.ts::findOne',
  compose: 'src/compose/compose.service.ts::findOne',
  postgres: 'src/databases/postgres/postgres.service.ts::queryById',
  mysql: 'src/databases/mysql/mysql.service.ts::queryById',
  mariadb: 'src/databases/mariadb/mariadb.service.ts::queryById',
  mongo: 'src/databases/mongo/mongo.service.ts::queryById',
  redis: 'src/databases/redis/redis.service.ts::queryById',
  libsql: 'src/databases/libsql/libsql.service.ts::queryById',
};

/** The reads whose relations this file's assertions actually drive. */
const DRIVEN = Object.keys(SERVICE_READS);

describe('withoutSecrets, on every secret a service read’s relations carry', () => {
  /**
   * The signal, pinned against these tables before anything is derived from it.
   * Without this the whole file could pass vacuously: a `columnType` drizzle
   * renames finds no encrypted columns anywhere and every derived requirement
   * becomes empty.
   */
  it('reads the signal it derives everything else from', () => {
    // "Finds these, and does not find those" rather than the exact sets: an
    // equality would be the table this file argues against, and would go red on
    // a *correctly* withheld new secret column.
    const encrypted = Object.fromEntries(
      Object.entries(RELATION_TABLES).map(([relation, table]) => [
        relation,
        encryptedColumns(table),
      ]),
    );

    expect({
      missing: (
        [
          ['customGitSSHKey', 'privateKey'],
          ['registry', 'password'],
          ['github', 'clientSecret'],
          ['github', 'privateKey'],
          // The two the hand-written denylists missed, and the reason the
          // requirement is derived rather than written down.
          ['github', 'webhookSecret'],
          ['gitlab', 'secret'],
          ['gitlab', 'accessToken'],
          ['gitea', 'clientSecret'],
          ['bitbucket', 'appPassword'],
          ['server', 'metricsConfig'],
          ['environment', 'env'],
        ] as const
      ).filter(([relation, column]) => !encrypted[relation].includes(column)),
      overreached: (
        [
          ['server', 'sshKeyId'],
          ['server', 'ipAddress'],
          ['customGitSSHKey', 'publicKey'],
          ['registry', 'username'],
          ['github', 'clientId'],
        ] as const
      ).filter(([relation, column]) => encrypted[relation].includes(column)),
      // …and the vocabulary would have, which is why it is not the column-level
      // signal here: `secret-bearing-columns.spec.ts` makes "encrypted" the
      // complete one instead.
      vocabularyOverreach: ['sshKeyId', 'publicKey'].filter(
        (name) => !namesACredential(name),
      ),
    }).toEqual({ missing: [], overreached: [], vocabularyOverreach: [] });
  });

  it.each(DRIVEN)(
    '%s: withholds every encrypted column that is not deliberately returned',
    async (query) => {
      const { relations } = await readWith(query);
      const offenders: string[] = [];

      const walk = (
        name: string,
        config: RelationConfig | true,
        path: string,
      ) => {
        const table = RELATION_TABLES[name];
        if (!table) return;
        const denied = config === true ? {} : (config.columns ?? {});
        for (const column of encryptedColumns(table)) {
          const returned = `${name}.${column}` in RETURNED_ENCRYPTED;
          if (returned) {
            // Returned on a written argument, and the argument has to be about
            // a column that still exists.
            expect(RETURNED_ENCRYPTED[`${name}.${column}`]).not.toHaveLength(0);
            if (denied[column] === false) {
              offenders.push(
                `${path}.${column} withheld but declared returned`,
              );
            }
            continue;
          }
          if (denied[column] !== false) offenders.push(`${path}.${column}`);
        }
        const nested = config === true ? {} : (config.with ?? {});
        for (const [child, childConfig] of Object.entries(nested)) {
          walk(child, childConfig, `${path}.${child}`);
        }
      };
      for (const [name, config] of Object.entries(relations)) {
        walk(name, config, name);
      }

      expect(offenders).toEqual([]);
    },
  );

  it.each(DRIVEN)(
    '%s: withholds every credential-named field of a returned blob, at its own depth',
    async (query) => {
      const { relations, answer } = await readWith(query);

      for (const relation of Object.keys(relations)) {
        for (const column of Object.keys(BLOB_DEFAULTS)
          .filter((key) => key.startsWith(`${relation}.`))
          .map((key) => key.slice(relation.length + 1))) {
          if (!(relation in relations)) continue;
          const blob = BLOB_DEFAULTS[`${relation}.${column}`];
          for (const field of fieldsOf(blob, column)) {
            const name = field.slice(field.lastIndexOf('.') + 1);
            const withheld = namesACredential(name) || field in WITHHELD_FIELDS;
            const path = `${relation}.${field}`;
            if (!withheld) {
              expect({ path, present: has(answer, path) }).toEqual({
                path,
                present: true,
              });
              continue;
            }
            expect(WITHHELD_FIELDS[field]).toBeDefined();
            expect({ path, present: has(answer, path) }).toEqual({
              path,
              present: false,
            });
            const flag = `${path.slice(0, path.lastIndexOf('.') + 1)}${presenceFlagFor(name)}`;
            expect({ path, flag, type: typeof at(answer, flag) }).toEqual({
              path,
              flag,
              type: 'boolean',
            });
          }
        }
      }
    },
  );

  /**
   * The assertion a projection which merely *relocated* a secret cannot pass —
   * `stripSshPrivateKey`'s mistake in the other direction, and the same
   * argument `nested-server-secrets.e2e-spec.ts` makes over the wire against
   * every string in the response.
   */
  it.each(DRIVEN)('%s: never relocates a withheld value', async (query) => {
    const { relations, answer } = await readWith(query);
    const strings = stringsIn(answer);

    const withheld = Object.keys(relations).flatMap((relation) => {
      if (!RELATION_TABLES[relation]) return [];
      const columns = withheldColumnsOf(relation).map(
        (column) => `${relation}.${column}`,
      );
      const fields = Object.keys(BLOB_DEFAULTS)
        .filter((key) => key.startsWith(`${relation}.`))
        .flatMap((key) =>
          fieldsOf(BLOB_DEFAULTS[key], key.slice(relation.length + 1))
            .filter(
              (field) =>
                namesACredential(field.slice(field.lastIndexOf('.') + 1)) ||
                field in WITHHELD_FIELDS,
            )
            .map((field) => field),
        );
      return [...columns, ...fields];
    });
    // The premise: there is something to look for.
    expect(withheld.length).toBeGreaterThan(0);

    expect(withheld.filter((path) => strings.includes(marker(path)))).toEqual(
      [],
    );
  });

  it.each(DRIVEN)(
    '%s: returns the relation it was asked for',
    async (query) => {
      // A projection that answered `null` for every relation would satisfy every
      // assertion above. This is the premise those rest on: the read really does
      // carry these rows, minus the secrets.
      const { relations, answer } = await readWith(query);

      expect(
        Object.keys(relations).filter((relation) => !has(answer, relation)),
      ).toEqual([]);
      expect(Object.keys(relations)).toContain('server');
    },
  );

  it('includes no relation this file does not know the table of', async () => {
    // The half that makes the derivation total for a read that grows: a tenth
    // relation added to one of these `with` trees reds this until it is listed
    // in RELATION_TABLES, rather than being covered by nothing.
    const unknown: string[] = [];
    for (const query of DRIVEN) {
      const { relations } = await readWith(query);
      const walk = (config: RelationConfig | true, path: string) => {
        const nested = config === true ? {} : (config.with ?? {});
        for (const [name, child] of Object.entries(nested)) {
          if (!RELATION_TABLES[name]) unknown.push(`${path}.${name}`);
          else walk(child, `${path}.${name}`);
        }
      };
      for (const [name, config] of Object.entries(relations)) {
        if (!RELATION_TABLES[name]) unknown.push(`${query}.${name}`);
        else walk(config, `${query}.${name}`);
      }
    }

    expect([...new Set(unknown)]).toEqual([]);
  });

  /**
   * The join between the two halves, and the reason this file is the whole
   * guardrail rather than half of one.
   *
   * `server` is **deliberately absent** from `withoutSecrets` — the column is
   * returned and the field withheld, so there is nothing for a drizzle
   * `columns` list to say — which means the eight `server: true` /
   * `buildServer: true` includes are protected by a *projection at the call
   * site*: `BaseDatabaseService.findOne`'s `SanitizedDatabaseRead<TNested>`
   * return type for the six engines, and a `nestedServer(...)` wrap each in
   * `ApplicationsService.findOne` and `ComposeService.findOne`. The engines'
   * half is structural — one annotation on one base method the six cannot opt
   * out of, so a forgotten wrap is a build failure. The other two are not:
   * their return types are inferred, and dropping the wrap compiles.
   *
   * So for those two the assertions in this file are the whole check, and a
   * check that a read can be *declared out of* is not one. With this, adding a
   * ninth read reds twice and both refusals name what is missing: the `with:`
   * scan until it is declared, and this until it is driven.
   */
  it('every read declared as answering a caller is one this file drives', () => {
    expect({
      // Declared as answering a caller, and nothing here looks at it.
      undriven: Object.entries(DECLARED_READS)
        .filter(([, reason]) => ANSWERS_A_CALLER.includes(reason))
        .map(([key]) => key)
        .filter((key) => !Object.values(DRIVEN_KEYS).includes(key)),
      // Driven, and not mapped to the read it is — which would let the
      // assertion above pass by naming nothing.
      unmapped: DRIVEN.filter((query) => !(query in DRIVEN_KEYS)),
      // Mapped to a `file::method` that is not declared, or is declared
      // internal: either way the two lists have stopped describing one thing.
      misdeclared: Object.entries(DRIVEN_KEYS)
        .filter(
          ([, key]) => !ANSWERS_A_CALLER.includes(DECLARED_READS[key] ?? ''),
        )
        .map(([query, key]) => `${query} → ${key}`),
    }).toEqual({ undriven: [], unmapped: [], misdeclared: [] });
  });

  it('every service read that includes one of these relations is declared here', () => {
    const found = relationIncludes();

    expect({
      undeclared: Object.keys(found).filter((key) => !(key in DECLARED_READS)),
      // A declared read that has stopped including any of these relations is
      // stale, and a stale entry is how an exemption outlives its argument.
      stale: Object.keys(DECLARED_READS).filter((key) => !(key in found)),
      // Every internal exemption carries a sentence, not a bare name.
      unargued: Object.entries(DECLARED_READS)
        .filter(([, reason]) => reason.length === 0)
        .map(([key]) => key),
    }).toEqual({ undeclared: [], stale: [], unargued: [] });
  });
});
