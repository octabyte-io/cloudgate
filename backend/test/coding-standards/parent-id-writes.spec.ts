import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { SERVICE_TABLES } from '../../src/common/service-parent';
import * as schema from '../../src/db/schema';

/**
 * Rule A — *"exactly one parent id, and the row is written
 * from the one that was authorized"* — asserted as a property over the tree
 * rather than fixed a module at a time.
 *
 * **What broke first, three times.** A table with two mutually exclusive parent
 * foreign keys, and a create that resolved *one* of them, authorized that one,
 * and then wrote the row with a spread of the request body — which writes
 * **both**. A cross-organization sweep found the shape, one fix closed `patch`
 * (an owned `applicationId` beside another organization's `composeId` landed a
 * patch on the victim's Compose stack, rendered by
 * `generateApplyPatchesCommand` as a `base64 -d >` inside their build tree),
 * and another closed `domain` (the same body landed a Traefik router on the
 * victim's stack). Each fix was found by *reading*, and each one's own commit
 * message says the rule now lives in three places with nothing holding a fourth
 * to it. That is the part worth changing, and it is why this is a property and
 * not a list of the two tables that were fixed.
 *
 * **ADR-0013's stale enumeration is the argument.** It was found to carry a
 * consequence listing call sites that had moved on without it. A list of the
 * modules that hold a rule rots exactly as fast as the modules do; a property
 * asserted over the directory does not.
 *
 * **The property.**
 *
 * 1. A table is in scope when it declares **two or more nullable foreign keys
 *    into different service tables** — read off the drizzle metadata via
 *    `getTableConfig`, not off a hand-kept list, with `SERVICE_TABLES`
 *    (exported for this and for the six-table resolver, see
 *    `common/service-parent.ts`) deciding what counts as a service table. Seven
 *    tables qualify, which is already four more than the three the issue named.
 * 2. A `*.service.ts` writing one of those tables — `.insert(t).values(…)` or
 *    `.update(t).set(…)` — may **spread** into the write only if every parent
 *    column that a request DTO reaching that method can carry is then named
 *    **literally** in the same write. Naming the column is what makes the row
 *    written from the id the method resolved; a spread is what makes it written
 *    from the id the caller sent.
 *
 * A DTO's reach is resolved **one hop**, `composed-creates.spec.ts`' discipline:
 * a parameter of the writing method itself, or of a method in the same class
 * that calls it. That is what catches `PatchService.insertRow`, whose own
 * signature mentions no DTO and whose caller `create` takes a `CreatePatchDto`
 * carrying both ids — the exact reading in which the `patch` defect was still
 * expressible after its fix, and which this file's arrival closed.
 *
 * 3. **A table in scope carries a `CHECK` naming its parent columns.** Added by
 *    a follow-up, and the sentence first written here said the opposite: *"it
 *    does not require a database `CHECK`"*, because when this file was written
 *    only two of the seven had one. That was a description of the tree, not a
 *    decision about it — `patch` and `domain` were constrained first and the
 *    other five filed as the follow-up, which constrained them all in `0064`.
 *    With the set complete, the honest form of the rule is the requirement
 *    rather than the observation: the point of a property over an enumeration
 *    is that an *eighth* table arrives held to it, and a rule this file only
 *    notices is a rule the eighth table gets to skip.
 *
 * **What the property still deliberately does not say.** It does not require
 * the DTO to refuse a body carrying two ids. That is the third half and it
 * answers a different question: a `CHECK` violation is a 500 naming a database
 * constraint, where `createPatchSchema`'s and `createDomainSchema`'s
 * `superRefine`s make a both-ids *body* a 400 at a field path. A caller needs
 * the 400; the constraint is what a fourth write path cannot get wrong. This
 * file is the third, and the one that reads the whole tree.
 *
 * **The shape the tree actually converged on, which is worth knowing before
 * adding an eighth table.** Five of the seven in-scope tables — `mount`,
 * `schedule`, `backup`, `volume_backup` and (in the write direction)
 * `deployment` — never expose their parent columns on the wire at all: their
 * create DTOs fold the eight-or-so foreign keys into one `serviceId` plus a
 * `serviceType`/`backupType` discriminant, and their update DTOs omit both, so
 * a spread of the body *cannot* carry a parent id and the assertion below
 * passes without those modules having to name a column. `patch` and `domain`
 * are the two that publish `applicationId`/`composeId` as optional wire fields,
 * which is why they are the two that had the defect. The folded shape is the
 * stronger answer and the one to copy.
 */

const backendRoot = join(__dirname, '..', '..');

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

/**
 * Comments blanked, lines preserved — `composed-creates.spec.ts`' helper, and
 * load-bearing here for the same reason: this file's own property is quoted in
 * prose inside `patch.service.ts`, `domains.service.ts` and
 * `common/credential-refs.ts`, so reading a docblock as code would make every
 * file that *explains* the rule look like one that breaks it.
 */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
      ) {
        return '';
      }
      return line.replace(/([^:'"`])\/\/.*$/, '$1');
    })
    .join('\n');
}

/* ------------------------------------------------------------------ *
 * 1. The tables the rule is about, read off the schema metadata.
 * ------------------------------------------------------------------ */

interface ParentTable {
  /** The `pgTable` name, e.g. `volume_backup`. */
  readonly sqlName: string;
  /** The TS property names of the mutually exclusive parent columns. */
  readonly parents: readonly string[];
  /**
   * The names of the `check()` constraints declared on the table — the
   * database's own statement of the rule, read off the same metadata as the
   * columns rather than out of `drizzle/`, so a constraint that exists in a
   * migration but has fallen out of the schema file (and so out of every
   * future migration drizzle-kit generates) does not count.
   */
  readonly checks: readonly string[];
}

/** The eight service tables, by SQL name, off the one map that lists them. */
const SERVICE_TABLE_NAMES = new Set(
  Object.values(SERVICE_TABLES).map((columns) => getTableName(columns.table)),
);

/**
 * Every table declaring two or more **nullable** foreign keys into different
 * service tables, keyed by the schema barrel's export name — which is the
 * identifier a `.insert(…)` names.
 *
 * Nullable is the point: two `notNull()` foreign keys are a join row, where
 * both being set is the whole idea. Two nullable ones are a polymorphic parent,
 * where exactly one may be set and nothing in Postgres says so.
 */
function parentTables(): Map<string, ParentTable> {
  const found = new Map<string, ParentTable>();
  for (const [exported, value] of Object.entries(schema)) {
    if (typeof value !== 'object' || value === null) continue;
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as PgTable);
    } catch {
      // Not a pgTable — the barrel also exports enums, relations and types.
      continue;
    }
    // SQL column name → TS property name. `getTableConfig` reports the SQL
    // name; a DTO key and a `.values({ … })` key are the TS one.
    const propertyOf = new Map<string, string>();
    for (const [property, column] of Object.entries(value)) {
      const name = (column as AnyPgColumn | undefined)?.name;
      if (typeof name === 'string') propertyOf.set(name, property);
    }
    const parents = config.foreignKeys
      .map((key) => key.reference())
      .filter((reference) =>
        SERVICE_TABLE_NAMES.has(getTableName(reference.foreignTable)),
      )
      .flatMap((reference) => reference.columns)
      .filter((column) => !column.notNull)
      .map((column) => propertyOf.get(column.name))
      .filter((property): property is string => property !== undefined);
    if (new Set(parents).size >= 2) {
      found.set(exported, {
        sqlName: getTableName(value as PgTable),
        parents: [...new Set(parents)].sort(),
        checks: config.checks.map((constraint) => constraint.name).sort(),
      });
    }
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * 2. What each request DTO can carry.
 * ------------------------------------------------------------------ */

/**
 * `createZodDto` class name → the keys its schema declares.
 *
 * Read off the schema object at runtime rather than parsed out of the file:
 * these schemas are built with `.extend`, `.pick`, `.omit`, `.partial` and
 * `.superRefine`, and a text parser would silently answer "declares nothing"
 * for the composed ones — which is the failure mode that makes a sweep pass
 * over an empty set. `.superRefine` wraps the object, so the wrapper is
 * unwrapped until a `shape` appears; a DTO whose schema is not an object at all
 * contributes no keys, which is correct.
 */
function dtoShapes(): Map<string, ReadonlySet<string>> {
  const shapes = new Map<string, ReadonlySet<string>>();
  for (const file of walk(join(backendRoot, 'src'))) {
    if (!file.endsWith('.dto.ts')) continue;
    // `require`, not a static import: the point of this sweep is that it reads
    // whatever DTO files are in the tree, including ones written after it. A
    // list of static imports is the enumeration the file exists to avoid. Safe
    // to load eagerly — a `*.dto.ts` imports zod and `nestjs-zod` and nothing
    // that starts a Nest module graph. `test/openapi/openapi.spec.ts` disables
    // the same rule for the same "load what is there" reason.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require(file) as Record<string, unknown>;
    for (const [exported, value] of Object.entries(module)) {
      if (typeof value !== 'function') continue;
      let candidate = (value as { schema?: unknown }).schema as
        | { shape?: Record<string, unknown>; _def?: Record<string, unknown> }
        | undefined;
      for (let hop = 0; hop < 8 && candidate && !candidate.shape; hop += 1) {
        const def = candidate._def ?? {};
        candidate = (def.schema ?? def.innerType ?? def.in) as typeof candidate;
      }
      if (candidate?.shape) {
        shapes.set(exported, new Set(Object.keys(candidate.shape)));
      }
    }
  }
  return shapes;
}

/* ------------------------------------------------------------------ *
 * 3. The writes.
 * ------------------------------------------------------------------ */

interface Method {
  readonly name: string;
  readonly body: string;
  /** Declared parameter type names, e.g. `CreatePatchDto`. */
  readonly parameterTypes: readonly string[];
}

interface ServiceFile {
  readonly file: string;
  readonly className: string;
  readonly methods: readonly Method[];
}

/** `composed-creates.spec.ts`' declaration regex — see its docblock. */
const DECLARATION =
  /^ {2}(?:public |private |protected )?(?:static )?(?:abstract )?(?:async )?\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/;

const NOT_METHODS = new Set([
  'constructor',
  'catch',
  'do',
  'for',
  'if',
  'return',
  'switch',
  'while',
]);

function parseServiceFile(path: string): ServiceFile | null {
  const text = withoutComments(readFileSync(path, 'utf8'));
  const declared = /export (?:abstract )?class ([A-Za-z_$][\w$]*)/.exec(text);
  if (!declared) return null;

  const lines = text.split('\n');
  const methods: Method[] = [];
  lines.forEach((line, index) => {
    const named = DECLARATION.exec(line);
    if (!named || NOT_METHODS.has(named[1])) return;
    let end = index;
    while (end < lines.length && !/^ {2}\}/.test(lines[end])) end += 1;
    const body = lines.slice(index, end + 1).join('\n');
    // The signature is everything up to the first `{` of the body, which is
    // where every `name: Type` in it is a parameter's.
    const signature = body.slice(0, body.indexOf('{'));
    methods.push({
      name: named[1],
      body,
      parameterTypes: [...signature.matchAll(/:\s*([A-Za-z_$][\w$]*)/g)].map(
        ([, type]) => type,
      ),
    });
  });

  return { file: relative(backendRoot, path), className: declared[1], methods };
}

function serviceFiles(): ServiceFile[] {
  return walk(join(backendRoot, 'src'))
    .filter((file) => /(?:\.service|-service)\.ts$/.test(file))
    .sort()
    .map(parseServiceFile)
    .filter((parsed): parsed is ServiceFile => parsed !== null);
}

/** The balanced `(...)` argument starting at `open` (the index of the paren). */
function balancedArgument(text: string, open: number): string {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    const char = text[at];
    if (char === '(' || char === '{' || char === '[') depth += 1;
    else if (char === ')' || char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, at);
    }
  }
  return text.slice(open + 1);
}

/**
 * A spread whose operand is an identifier or a property of one — `...data`,
 * `...rest`, `...values`.
 *
 * The property form was `BackupRunRecorderService.start`'s `...options.fk`
 * until it was replaced with `...parentColumns(options.parent)`, and no write
 * to a parent table spells one today. The pattern still admits it: a write
 * that reintroduces one is exactly what this walk must not stop seeing.
 *
 * A parenthesized spread (`...(finished && { finishedAt })`) is deliberately
 * not one: its operand is a literal written right there, so it cannot carry a
 * key the caller chose, and `DeploymentsService.updateStatus` is the shape.
 */
const NAMED_SPREAD = /\.\.\.\s*([A-Za-z_$][\w$.]*)/;

interface Write {
  /** `Class.method`. */
  readonly at: string;
  readonly table: string;
  readonly parents: readonly string[];
  /** The `.values(…)` / `.set(…)` argument, plus any object it spreads. */
  readonly written: string;
  readonly spreads: boolean;
}

/**
 * Every `.insert(t)`/`.update(t)` on an in-scope table, with what its
 * `.values(…)`/`.set(…)` writes.
 *
 * A bare identifier argument (`.set(data)`) counts as a spread of everything
 * that identifier holds, which is what it is. An identifier is followed one
 * hop into a `const <name> = { … }` in the same method —
 * `MountsService.insertMount` and `SchedulesService.create` both build the row
 * that way — so the object that is really written is the one examined.
 */
function writesToParentTables(
  files: readonly ServiceFile[],
  tables: ReadonlyMap<string, ParentTable>,
): Write[] {
  const writes: Write[] = [];
  for (const parsed of files) {
    for (const method of parsed.methods) {
      for (const [, verb, table] of method.body.matchAll(
        /\.(insert|update)\(\s*([A-Za-z_$][\w$]*)\s*\)/g,
      )) {
        const scope = tables.get(table);
        if (!scope) continue;
        const setter = verb === 'insert' ? '.values(' : '.set(';
        const at = method.body.indexOf(setter, method.body.indexOf(table));
        if (at === -1) continue;
        let written = balancedArgument(
          method.body,
          at + setter.length - 1,
        ).trim();
        // `.set(data)` — a bare identifier. Follow it one hop into a `const`
        // object literal in the same method if there is one; otherwise the
        // identifier itself is the whole of what is written.
        const bare = /^[A-Za-z_$][\w$]*$/.exec(written);
        if (bare) {
          const declared = new RegExp(
            `const\\s+${bare[0]}\\s*(?::[^=]*)?=\\s*\\{`,
          ).exec(method.body);
          written = declared
            ? balancedArgument(
                method.body,
                method.body.indexOf('{', declared.index),
              )
            : `...${bare[0]}`;
        }
        writes.push({
          at: `${parsed.className}.${method.name}`,
          table,
          parents: scope.parents,
          written,
          spreads: NAMED_SPREAD.test(written),
        });
      }
    }
  }
  return writes;
}

/**
 * The parent columns a request body reaching `at` can carry — the DTO
 * parameters of the writing method, plus those of the methods in the same
 * class that call it (one hop, `composed-creates.spec.ts`' discipline).
 */
function reachableParents(
  files: readonly ServiceFile[],
  shapes: ReadonlyMap<string, ReadonlySet<string>>,
  write: Write,
): string[] {
  const [className, methodName] = write.at.split('.');
  const owner = files.find((parsed) => parsed.className === className);
  if (!owner) return [];
  const reaching = owner.methods.filter(
    (method) =>
      method.name === methodName ||
      new RegExp(`this\\.${methodName}\\(`).test(method.body),
  );
  const carried = new Set<string>();
  for (const method of reaching) {
    for (const type of method.parameterTypes) {
      const shape = shapes.get(type);
      if (!shape) continue;
      for (const parent of write.parents) {
        if (shape.has(parent)) carried.add(parent);
      }
    }
  }
  return [...carried].sort();
}

/* ------------------------------------------------------------------ *
 * The frozen sets — the anti-rot half.
 * ------------------------------------------------------------------ */

/**
 * Every table with two or more mutually exclusive service-parent columns,
 * frozen by SQL name.
 *
 * The more important half of this file. The assertion below is satisfied
 * perfectly by an empty set of writes, and an empty set is exactly what a
 * `getTableConfig` signature change, a schema-barrel move or a rename of
 * `SERVICE_TABLES` produces. An eighth table here is a normal thing to add —
 * but adding one says "I have read the property above", which is the point.
 */
const PARENT_TABLES: readonly string[] = [
  'backup',
  'deployment',
  'domain',
  // An Error-rate threshold's two owner columns (Application, Compose).
  'error_rate_threshold',
  // An Existing database's Service, a postgres or a redis.
  'existing_database',
  // An Infrastructure state's owners, a cloud `web` (Application) or
  // a postgres on RDS, beside the Environment network.
  'infrastructure_state_record',
  'mount',
  'patch',
  'schedule',
  // A Service's traces setting, the Error-rate threshold's two owners.
  'trace_store',
  // An Uptime check's eight owner columns, mount's shape.
  'uptime_check',
  'volume_backup',
];

/**
 * The `CHECK` each of those tables states its rule with, frozen by name
 * (the first two, and the follow-up's five).
 *
 * The assertion below only demands that a table in scope carries *some* check;
 * this is what makes that demand readable, because "some check" is satisfied by
 * a constraint about something else entirely. Freezing the names is also how a
 * *renamed* constraint gets noticed: the name is what a violation surfaces as,
 * and `test/db/parent-consistency.e2e-spec.ts` and
 * `test/patch/parent-id-constraint.e2e-spec.ts` both assert on it.
 *
 * **The two shapes are deliberate and are not converging.** `patch`, `domain`
 * and `deployment` have no discriminant column, so their constraint can only
 * count keys — `<>` (exactly one) on the first two, `num_nonnulls(…) <= 1` on
 * `deployment`, which admits the parentless deployment `ownerOf` answers 404
 * for and `run-history.e2e-spec.ts` pins. The other four carry a discriminant
 * already, so theirs says the stronger thing: the column that is set is the one
 * the discriminant names. Each `check()`'s own docblock carries its argument.
 */
const PARENT_CONSTRAINTS: Readonly<Record<string, readonly string[]>> = {
  backup: ['backup_parent_matches_type'],
  // The second: a row naming a preview has an Application, the half
  // of "only beside that preview's parent" its composite foreign key, being
  // MATCH SIMPLE, cannot state. The link is a qualifier, not a sixth parent.
  // The third: a Cron service's Run record is marked on its
  // `application` arm, so a row with no Application cannot carry the mark.
  // The fourth (S14): "for Service" lists an Environment network's Domain
  // run on a Service, so only a network's run carries it; not a parent.
  deployment: [
    'deployment_at_most_one_parent',
    'deployment_cron_run_has_an_application',
    'deployment_for_service_on_a_network_run',
    'deployment_preview_qualifies_an_application',
  ],
  domain: ['domain_exactly_one_parent'],
  // The second is not a parent rule: the window is one of the four offered.
  error_rate_threshold: [
    'error_rate_threshold_parent_matches_service_type',
    'error_rate_threshold_window_allowed',
  ],
  // Exactly one Service, counted: there is no discriminant column.
  existing_database: ['existing_database_one_service'],
  // Exactly one owner, counted: there is no discriminant column.
  infrastructure_state_record: ['infrastructure_state_record_one_owner'],
  mount: ['mount_parent_matches_service_type'],
  patch: ['patch_exactly_one_parent'],
  schedule: ['schedule_parent_matches_schedule_type'],
  // The second is not a parent rule: retention is one of the three offered.
  trace_store: [
    'trace_store_parent_matches_service_type',
    'trace_store_retention_allowed',
  ],
  // Only the parent rule is a parent rule; the rest are here because the
  // property reads every check on the table: an HTTP check needs its Domain,
  // a TCP check its port, a header value its name, and a
  // disabled reason an off check.
  uptime_check: [
    'uptime_check_disabled_reason_only_when_off',
    'uptime_check_header_value_has_name',
    'uptime_check_http_has_domain',
    'uptime_check_parent_matches_service_type',
    'uptime_check_tcp_has_port',
  ],
  volume_backup: ['volume_backup_parent_matches_service_type'],
};

/**
 * The writes that reach one of those tables through a spread, frozen by
 * `Class.method`. The same anti-rot argument one level down: if the walk stops
 * finding writes — a `.values(` renamed, a service file renamed out of
 * `*.service.ts` — the assertion passes over nothing and this is what says so.
 *
 * Every entry here is *safe*, and for one of four reasons:
 *
 * - **The body cannot carry a parent id.** `MountsService`, `SchedulesService`,
 *   `BackupsService` and `VolumeBackupsService` all fold the parent foreign keys
 *   into one `serviceId` plus a discriminant on create and omit them entirely on
 *   update, so there is no parent id in the DTO for the spread to pick up.
 *   `DomainsService.update` is the same by omission — `updateDomainSchema` drops
 *   both ids and, as a plain `z.object`, strips them off a body that sends them
 *   anyway, which the `domain` fix pinned with a test rather than trusting.
 * - **The write names both columns itself.** `PatchService.insertRow` is the
 *   only one, and it is the one the assertion above is really about: its
 *   caller's `CreatePatchDto` does carry both ids, and what makes the spread
 *   safe is that the method sets `applicationId`/`composeId` from the parent it
 *   was handed. Before this file it took one `typeof patch.$inferInsert` and
 *   spread that, which is the reading in which the `patch` defect survived its
 *   fix.
 * - **No request DTO reaches it at all.** `PatchService.updateRow` is the only
 *   one: it takes a `PatchUpdate` that omits both ids by declaration (the
 *   `patch` fix narrowed it from `Partial<Patch>` for exactly this).
 * - **The spread's operand is computed from a discriminated union**, so it
 *   cannot hold two parent columns whatever it was handed. Both writes here
 *   spread `parentColumns(…)`, the one function that turns a parent into
 *   columns, whose parameter is one arm of `DeploymentParent`
 *   (`deployment-engine/ports/deployment-recorder.ts`) — each arm carrying
 *   exactly one id and pinning the other four to `never` — and whose body
 *   returns that one column. `DeploymentsService.create` was fixed this way: it
 *   replaced `applicationId: input.applicationId ?? null, composeId:
 *   input.composeId ?? null`, which named both columns and so satisfied the
 *   assertion below while still writing whatever a caller passed for both.
 *   `BackupRunRecorderService.start` joined it later (ADR-0017's own
 *   outstanding item): it had spread an internal `options.fk` built by its
 *   callers — safe, because no request DTO reaches it, but a second spelling
 *   of the same three parents — and now takes `RunRecordParent`, the same
 *   union `Extract`ed to its three run-record arms.
 */
const SPREADING_WRITES: readonly string[] = [
  'BackupRunRecorderService.start',
  'BackupsService.create',
  'BackupsService.update',
  // Spreads a run's own `cronRun` JSON to mark it stopped; it sets
  // no parent id, and no request DTO reaches it.
  'CronRunsService.endOnce',
  'DeploymentsService.create',
  // Spreads the `postgres` or `redis` arm of a `DeploymentParent`
  // through `parentColumns`, one id each; no request DTO reaches it.
  'DeploymentsService.recordDatabaseCloudRun',
  'DomainsService.update',
  // Spreads a `StateOwner`, a union whose every arm is one owner id,
  // built by the Applier and the network's run; no request DTO reaches it.
  'InfrastructureStatesService.create',
  'MountsService.insertMount',
  'MountsService.update',
  'PatchService.insertRow',
  'PatchService.updateRow',
  'SchedulesService.create',
  'SchedulesService.update',
  'VolumeBackupsService.create',
  'VolumeBackupsService.update',
];

describe('SERVICE_TABLES, as what decides a mutually exclusive parent id', () => {
  it('leaves no write spreading a body that can carry a parent id it does not name', () => {
    const tables = parentTables();
    const files = serviceFiles();
    const shapes = dtoShapes();

    const violations = writesToParentTables(files, tables)
      .filter((write) => write.spreads)
      .flatMap((write) =>
        reachableParents(files, shapes, write)
          // Named literally in the write, so the spread cannot decide it — The
          // `patch` and `domain` fix, and the only thing that makes a spread
          // safe when the body can carry the column.
          .filter(
            (parent) => !new RegExp(`\\b${parent}\\s*:`).test(write.written),
          )
          .map((parent) => `${write.at} -> ${write.table}.${parent}`),
      );

    expect(violations).toEqual([]);
  });

  it('leaves no table with two mutually exclusive parents unconstrained', () => {
    // The half a service-layer sweep cannot reach. Every write path this
    // file walks is one somebody wrote in a `*.service.ts`; a migration, a
    // fixture, an engine-facing insert and a hand-run `UPDATE` are all outside
    // it, and the `CHECK` is the only statement of the rule that holds them.
    const unconstrained = [...parentTables().values()]
      .filter((table) => table.checks.length === 0)
      .map((table) => table.sqlName)
      .sort();

    expect(unconstrained).toEqual([]);
  });

  it('states each rule under the constraint name a violation reports', () => {
    const found = Object.fromEntries(
      [...parentTables().values()]
        .sort((left, right) => left.sqlName.localeCompare(right.sqlName))
        .map((table) => [table.sqlName, table.checks]),
    );

    expect(found).toEqual(PARENT_CONSTRAINTS);
  });

  it('finds the tables it was frozen against', () => {
    const found = [...parentTables().values()]
      .map((table) => table.sqlName)
      .sort();

    expect(found).toEqual([...PARENT_TABLES]);
  });

  it('finds the spreading writes it was frozen against', () => {
    const found = writesToParentTables(serviceFiles(), parentTables())
      .filter((write) => write.spreads)
      .map((write) => write.at)
      .sort();

    expect([...new Set(found)]).toEqual([...SPREADING_WRITES]);
  });

  /**
   * The half that says the DTO resolution is live. `CreatePatchDto` and
   * `CreateDomainDto` are the only two request bodies in the tree that publish
   * `applicationId` and `composeId` as optional wire fields — they are the two
   * tables that had the defect — so if the shape reader ever answers "declares
   * nothing", the assertion above passes over an empty set of reachable
   * parents and this is what fails instead.
   */
  it('reads both parent ids off the two DTOs that publish them', () => {
    const shapes = dtoShapes();

    expect({
      CreatePatchDto: [...(shapes.get('CreatePatchDto') ?? [])]
        .filter((key) => key === 'applicationId' || key === 'composeId')
        .sort(),
      CreateDomainDto: [...(shapes.get('CreateDomainDto') ?? [])]
        .filter((key) => key === 'applicationId' || key === 'composeId')
        .sort(),
    }).toEqual({
      CreatePatchDto: ['applicationId', 'composeId'],
      CreateDomainDto: ['applicationId', 'composeId'],
    });
  });
});
