import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import * as ts from 'typescript';
import * as schema from '../../src/db/schema';

/**
 * The general form of commit 96f56c4. The property, stated once:
 *
 * > a query-result type's fields are inferred row types, or the query that
 * > fills them is projected to the fields the type declares
 *
 * **What broke.** `ApplicationsService.findDeployable` loads most of its
 * relations as whole rows — `with: { github: true }`, `select().from(port)` —
 * and that is safe *only* because each field on `DeployableApplication` is
 * declared `typeof table.$inferSelect`, generated from the table and therefore
 * incapable of being narrower than the row it is handed. `mounts` was the one
 * field that broke the pattern: the hand-written `ServiceMount` interface
 * (five fields) fed from `select().from(mount)` (sixteen columns), so eleven
 * undeclared columns rode along — one of them `content`, the `encryptedText`
 * body of a file mount (ADR 0006), which reached `rollback.full_context` and
 * was served over HTTP *with the type still saying it could not be there*.
 *
 * **Nothing in the type system was ever going to say so**, and 96f56c4 checked
 * that rather than assuming it: a wider *variable* assigned into a narrower
 * field compiles clean, and only an inline literal trips `TS2353`. So
 * annotating the loader's return type catches a *missing* field and never a
 * surplus one. The invariant is real, load-bearing and unenforced — which is
 * the definition of something to assert over the tree rather than fix one
 * field at a time (`parent-id-writes.spec.ts`' argument).
 *
 * **The property, mechanically.** For each query-result type, every field is
 * matched against the way its loader actually fills it:
 *
 * - filled from the relational tree (`db.query.x.findFirst({ with: … })`) —
 *   whole rows, so the declared type must be that table's own
 *   `typeof table.$inferSelect`;
 * - filled from a `db.select()` of its own — so the columns the projection
 *   names must be exactly the fields the declared type declares.
 *
 * Both directions are checked, which is more than 96f56c4's `Exact<>` did: a
 * projection that *drops* a column the type declares is a field that is
 * `undefined` at runtime against a type that says it is a string, and it fails
 * here for the same reason a surplus column does.
 *
 * The one shape this asks of a loader is that the `const` holding a
 * separately-queried relation be named after the field it becomes — which both
 * loaders already do, because the return is a shorthand `{ …found, ports,
 * mounts }`. Renaming the local without renaming the field reds
 * `leaves no field declaring …` with *"fills `rows`, undeclared"* rather than
 * passing over an unmatched pair, which is the failure direction to want.
 *
 * **Why the encrypted columns are not the property.** 96f56c4's fix was about a
 * secret, so the tempting rule is "no `encryptedText` column reaches the deploy
 * engine". That rule is not merely too strict — it is contradicted by almost
 * every field here. `registry` and `buildRegistry` declare `password`,
 * `customGitSSHKey` declares `privateKey`, and `github`, `gitlab`, `gitea` and
 * `bitbucket` declare between two and three OAuth/webhook secrets each; the
 * `Application` row itself declares six, and `environment` and `project`
 * declare `env`. **Eight of the ten fields** carry a column encrypted at rest,
 * because a build genuinely needs them decrypted — which
 * `ApplicationsService.findDeployable`'s docblock is what says. So the
 * exemption those three fields need is *no exemption at all*: they are
 * `$inferSelect` types, so the property's first branch already answers for
 * them, and `never declares an encrypted column it is not handed` below is the
 * evidence rather than a skip-list. The property is "the type says what it
 * gets", not "the type gets nothing sensitive", and the one column that must
 * stay out — `mount.content` — stays out by not being named, not by being
 * excluded.
 *
 * **Why `DeployableCompose` is in scope.** It is `Compose & { … }` and every
 * field is `$inferSelect` today, so it passes by construction — which is
 * exactly the state `DeployableApplication` looked like it was in before
 * someone read the rows. It is not enumerated by hand here: the two types are
 * discovered from the seam that consumes them,
 * `deployment-queue/deployment-processor.ts`, whose `DeployableApplications`
 * and `DeployableComposes` interfaces each declare
 * `findDeployable(id): Promise<T>`. A third loader added to that seam is in
 * scope the day it is added, and reds `finds the query-result types …` until it
 * is written down.
 *
 * `DeployableComposeSource` is deliberately *not* in scope, and the reason is
 * the property's own wording: it is not a query result. Nothing fills it — it
 * is the parameter shape `compose.utils.ts`' command builders take, and it is
 * `Pick<Compose, …>`, derived from the table rather than hand-written, so it
 * cannot fall behind it the way `ServiceMount` did.
 *
 * **Read with the compiler API rather than the checker.** `ts.createSourceFile`
 * gives the real AST of the four files this reads without building a program
 * over the Nest graph, and every type this has to follow is reachable by
 * resolving one relative `import type` — which is what `resolveDeclaration`
 * does. A name that cannot be resolved is a failure, not a silent pass.
 *
 * What this file does not assert is that Postgres honours a column list; that
 * is not a claim about this repo's code.
 * `test/applications/deployable-relation-projections.spec.ts` holds
 * `findDeployable`'s two projections against the service as it runs, and
 * `applications.e2e-spec.ts` makes the end-to-end half against a real file
 * mount with a real encrypted body.
 */

const backendRoot = join(__dirname, '..', '..');
const srcRoot = join(backendRoot, 'src');

/** The seam that names every type this file is about — see the docblock. */
const SEAM = join(srcRoot, 'deployment-queue', 'deployment-processor.ts');

const sourceCache = new Map<string, ts.SourceFile>();

function parseFile(file: string): ts.SourceFile {
  const cached = sourceCache.get(file);
  if (cached) return cached;
  const parsed = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  sourceCache.set(file, parsed);
  return parsed;
}

/** Local name → the file its relative `import`/`import type` came from. */
function importSources(source: ts.SourceFile): Map<string, string> {
  const sources = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      sources.set(
        element.name.text,
        `${join(dirname(source.fileName), specifier)}.ts`,
      );
    }
  }
  return sources;
}

/* ------------------------------------------------------------------ *
 * 1. What a declared type is.
 * ------------------------------------------------------------------ */

/**
 * A field's declared type, in the only two shapes the property distinguishes:
 * a whole inferred row, or a hand-written list of fields.
 */
type Declared =
  | { readonly kind: 'row'; readonly table: string }
  | { readonly kind: 'fields'; readonly fields: readonly string[] }
  | { readonly kind: 'unresolved'; readonly why: string };

/** `typeof application.$inferSelect` → `application`; anything else → null. */
function inferSelectTable(node: ts.TypeNode): string | null {
  if (!ts.isTypeQueryNode(node)) return null;
  const { exprName } = node;
  if (!ts.isQualifiedName(exprName)) return null;
  if (exprName.right.text !== '$inferSelect') return null;
  return ts.isIdentifier(exprName.left) ? exprName.left.text : null;
}

function propertyNames(
  members: ts.NodeArray<ts.TypeElement>,
): readonly string[] {
  return members
    .filter(ts.isPropertySignature)
    .map((member) => member.name)
    .filter(ts.isIdentifier)
    .map((name) => name.text)
    .sort();
}

/**
 * The declaration a type name resolves to, followed through one relative
 * import. §2.6 — *"every schema file ends with a `relations` export and an
 * inferred `$inferSelect` type"* — is what makes the first branch a one-line
 * recognizer rather than a structural comparison.
 */
function resolveDeclaration(name: string, from: ts.SourceFile): Declared {
  const file = importSources(from).get(name) ?? from.fileName;
  let source: ts.SourceFile;
  try {
    source = parseFile(file);
  } catch {
    return { kind: 'unresolved', why: `no file for ${name} at ${file}` };
  }

  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) {
      return { kind: 'fields', fields: propertyNames(statement.members) };
    }
    if (!ts.isTypeAliasDeclaration(statement)) continue;
    if (statement.name.text !== name) continue;
    const table = inferSelectTable(statement.type);
    if (table) return { kind: 'row', table };
    if (ts.isTypeLiteralNode(statement.type)) {
      return { kind: 'fields', fields: propertyNames(statement.type.members) };
    }
    return {
      kind: 'unresolved',
      why: `${name} is neither an inferred row nor a field list`,
    };
  }
  return { kind: 'unresolved', why: `${name} is not declared in ${file}` };
}

/* ------------------------------------------------------------------ *
 * 2. The fields a query-result type declares.
 * ------------------------------------------------------------------ */

interface Field {
  /** `''` for the row the type is built on, else `github`, `environment.project`. */
  readonly path: string;
  /** As written, so a message can say `mounts[]`. */
  readonly label: string;
  readonly declared: Declared;
}

const isNullish = (node: ts.TypeNode): boolean =>
  node.kind === ts.SyntaxKind.UndefinedKeyword ||
  (ts.isLiteralTypeNode(node) &&
    node.literal.kind === ts.SyntaxKind.NullKeyword);

/**
 * Every leaf of a query-result type, keyed by the path the loader fills.
 *
 * `Application & { environment: Environment & { project: Project } }` is three
 * leaves — the row at `''`, `Environment` at `environment` and `Project` at
 * `environment.project` — because the loader fills all three separately and the
 * property is about each of them.
 */
function fieldsOf(
  node: ts.TypeNode,
  source: ts.SourceFile,
  path: string,
  found: Field[],
): void {
  if (ts.isParenthesizedTypeNode(node)) {
    fieldsOf(node.type, source, path, found);
    return;
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    for (const member of node.types) {
      if (!isNullish(member)) fieldsOf(member, source, path, found);
    }
    return;
  }
  if (ts.isArrayTypeNode(node)) {
    fieldsOf(node.elementType, source, `${path}[]`, found);
    return;
  }
  if (ts.isTypeLiteralNode(node)) {
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      if (!ts.isIdentifier(member.name)) continue;
      const child = path ? `${path}.${member.name.text}` : member.name.text;
      fieldsOf(member.type, source, child, found);
    }
    return;
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    found.push({
      path: path.replace(/\[\]$/, ''),
      label: path,
      declared: resolveDeclaration(node.typeName.text, source),
    });
    return;
  }
  found.push({
    path: path.replace(/\[\]$/, ''),
    label: path,
    declared: { kind: 'unresolved', why: `unreadable type node at ${path}` },
  });
}

interface QueryResultType {
  readonly name: string;
  readonly fields: readonly Field[];
}

/**
 * The types the deployment queue's seam declares — one per
 * `findDeployable(id): Promise<T>` in `deployment-processor.ts`. Discovered
 * rather than listed: see the docblock on why `DeployableCompose` is here.
 */
function queryResultTypes(): QueryResultType[] {
  const seam = parseFile(SEAM);
  const names: string[] = [];
  for (const statement of seam.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    for (const member of statement.members) {
      if (!ts.isMethodSignature(member)) continue;
      if (!ts.isIdentifier(member.name)) continue;
      if (member.name.text !== 'findDeployable') continue;
      const returned = member.type;
      if (!returned || !ts.isTypeReferenceNode(returned)) continue;
      const [resolved] = returned.typeArguments ?? [];
      if (resolved && ts.isTypeReferenceNode(resolved)) {
        names.push(resolved.typeName.getText());
      }
    }
  }

  const sources = importSources(seam);
  return names.sort().map((name) => {
    const file = sources.get(name);
    const fields: Field[] = [];
    if (file) {
      const source = parseFile(file);
      for (const statement of source.statements) {
        if (!ts.isTypeAliasDeclaration(statement)) continue;
        if (statement.name.text !== name) continue;
        fieldsOf(statement.type, source, '', fields);
      }
    }
    return { name, fields };
  });
}

/* ------------------------------------------------------------------ *
 * 3. How the loader fills them.
 * ------------------------------------------------------------------ */

interface Fill {
  readonly path: string;
  /** A whole row out of the relational tree, or a `select()` of its own. */
  readonly kind: 'relation' | 'projection';
  /** The drizzle table, for the row at `''` and for every projection. */
  readonly table?: string;
  readonly columns?: readonly string[];
}

interface Loader {
  readonly at: string;
  /** The table `db.query.x.findFirst` reads — what pairs a loader to a type. */
  readonly baseTable: string;
  readonly fills: readonly Fill[];
}

function each(node: ts.Node, visit: (child: ts.Node) => void): void {
  ts.forEachChild(node, (child) => {
    visit(child);
    each(child, visit);
  });
}

function propertyValue(
  object: ts.ObjectLiteralExpression,
  key: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (property.name.getText() === key) return property.initializer;
  }
  return undefined;
}

/** `with: { environment: { with: { project: true } }, github: true }` flattened. */
function relationPaths(
  object: ts.ObjectLiteralExpression,
  prefix: string,
  found: string[],
): void {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = property.name.getText();
    const path = prefix ? `${prefix}.${key}` : key;
    found.push(path);
    if (ts.isObjectLiteralExpression(property.initializer)) {
      const nested = propertyValue(property.initializer, 'with');
      if (nested && ts.isObjectLiteralExpression(nested)) {
        relationPaths(nested, path, found);
      }
    }
  }
}

const calledMethod = (
  node: ts.Node,
  name: string,
): ts.CallExpression | null => {
  if (!ts.isCallExpression(node)) return null;
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  return node.expression.name.text === name ? node : null;
};

/**
 * A `const x = await this.db.select(…).from(table)…` in the loader — the
 * separately-queried relations, kept out of the relational tree to avoid
 * schema cycles. A bare `select()` selects every column drizzle knows the
 * table has, which is read off the table rather than assumed.
 */
function projectionFills(method: ts.MethodDeclaration): Fill[] {
  const fills: Fill[] = [];
  each(method, (node) => {
    if (!ts.isVariableDeclaration(node)) return;
    if (!ts.isIdentifier(node.name) || !node.initializer) return;

    let table: string | undefined;
    let columns: string[] | undefined;
    let projected = false;
    each(node.initializer, (child) => {
      const from = calledMethod(child, 'from');
      if (from) {
        const [argument] = from.arguments;
        if (argument && ts.isIdentifier(argument)) table = argument.text;
      }
      const select = calledMethod(child, 'select');
      if (select) {
        projected = true;
        const [argument] = select.arguments;
        if (argument && ts.isObjectLiteralExpression(argument)) {
          columns = argument.properties
            .map((property) => property.name?.getText())
            .filter((name): name is string => name !== undefined)
            .sort();
        }
      }
    });
    if (!projected || !table) return;
    fills.push({
      path: node.name.text,
      kind: 'projection',
      table,
      columns: columns ?? columnsOf(table),
    });
  });
  return fills;
}

let loaderCache: Loader[] | null = null;

/** Every `findDeployable` in a service, with what each of its fields is filled from. */
function loaders(): Loader[] {
  if (loaderCache) return loaderCache;
  const found: Loader[] = [];
  for (const file of walk(srcRoot)) {
    if (!/(?:\.service|-service)\.ts$/.test(file)) continue;
    const source = parseFile(file);
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !member.body) continue;
        if (member.name.getText() !== 'findDeployable') continue;

        let baseTable = '';
        const fills: Fill[] = [];
        each(member, (node) => {
          const findFirst = calledMethod(node, 'findFirst');
          if (!findFirst) return;
          const { expression } = findFirst;
          if (!ts.isPropertyAccessExpression(expression)) return;
          baseTable = expression.expression.getText().split('.').pop() ?? '';
          const [argument] = findFirst.arguments;
          if (!argument || !ts.isObjectLiteralExpression(argument)) return;
          const relations = propertyValue(argument, 'with');
          if (relations && ts.isObjectLiteralExpression(relations)) {
            const paths: string[] = [];
            relationPaths(relations, '', paths);
            for (const path of paths) fills.push({ path, kind: 'relation' });
          }
        });
        if (!baseTable) continue;

        found.push({
          at: `${statement.name.text}.findDeployable (${relative(backendRoot, file)})`,
          baseTable,
          fills: [
            { path: '', kind: 'relation', table: baseTable },
            ...fills,
            ...projectionFills(member),
          ],
        });
      }
    }
  }
  loaderCache = found.sort((left, right) => left.at.localeCompare(right.at));
  return loaderCache;
}

/* ------------------------------------------------------------------ *
 * 4. The tables, off the schema barrel.
 * ------------------------------------------------------------------ */

function tableNamed(name: string): PgTable | null {
  const exported = (schema as Record<string, unknown>)[name];
  if (!exported || typeof exported !== 'object') return null;
  try {
    getTableColumns(exported as PgTable);
    return exported as PgTable;
  } catch {
    return null;
  }
}

function columnsOf(name: string): string[] {
  const table = tableNamed(name);
  return table ? Object.keys(getTableColumns(table)).sort() : [];
}

/**
 * Columns stored encrypted at rest (ADR 0006) — `encryptedText` and
 * `encryptedJson` are drizzle `customType`s, so the table reports them as
 * `PgCustomColumn`. Enumerated rather than listed, so a later encrypted column
 * joins the set on its own.
 */
function encryptedColumnsOf(name: string): string[] {
  const table = tableNamed(name);
  if (!table) return [];
  return Object.entries(getTableColumns(table))
    .filter(([, column]) => column.columnType === 'PgCustomColumn')
    .map(([key]) => key)
    .sort();
}

/** Every file under `dir`, recursively — `parent-id-writes.spec.ts`' helper. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * 5. The property.
 * ------------------------------------------------------------------ */

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((item, at) => item === right[at]);

function loaderFor(type: QueryResultType): Loader | undefined {
  const row = type.fields.find((field) => field.path === '');
  if (!row || row.declared.kind !== 'row') return undefined;
  const table = row.declared.table;
  return loaders().find((loader) => loader.baseTable === table);
}

function violations(): string[] {
  const found: string[] = [];
  for (const type of queryResultTypes()) {
    const loader = loaderFor(type);
    if (!loader) {
      found.push(`${type.name}: no findDeployable fills it`);
      continue;
    }
    const filled = new Set(loader.fills.map((fill) => fill.path));
    for (const path of filled) {
      if (!type.fields.some((field) => field.path === path)) {
        found.push(`${type.name}: ${loader.at} fills ${path}, undeclared`);
      }
    }

    for (const field of type.fields) {
      const at = `${type.name}.${field.label || '<the row>'}`;
      const fill = loader.fills.find(
        (candidate) => candidate.path === field.path,
      );
      if (!fill) {
        found.push(`${at}: declared, and nothing in ${loader.at} fills it`);
        continue;
      }
      if (field.declared.kind === 'unresolved') {
        found.push(`${at}: ${field.declared.why}`);
        continue;
      }
      if (fill.kind === 'relation') {
        // A whole row out of the relational tree: only `$inferSelect` is
        // incapable of being narrower than what it is handed.
        if (field.declared.kind !== 'row') {
          found.push(
            `${at}: filled with whole rows, declares a hand-written ${field.declared.fields.length} fields`,
          );
        }
        continue;
      }
      const selected = [...(fill.columns ?? [])].sort();
      const declared =
        field.declared.kind === 'row'
          ? columnsOf(field.declared.table)
          : [...field.declared.fields].sort();
      if (
        field.declared.kind === 'row' &&
        fill.table !== field.declared.table
      ) {
        found.push(
          `${at}: declares ${field.declared.table}, queried from ${fill.table}`,
        );
        continue;
      }
      if (!sameSet(selected, declared)) {
        found.push(
          `${at}: declares [${declared.join(', ')}], query names [${selected.join(', ')}]`,
        );
      }
    }
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * The frozen sets — the anti-rot half.
 * ------------------------------------------------------------------ */

/**
 * The query-result types the seam declares. The assertion above is satisfied
 * perfectly by an empty set, and an empty set is what a rename of
 * `findDeployable`, a move of `deployment-processor.ts` or a `Promise<T>`
 * written some other way all produce. A third one here is a normal thing to
 * add — adding it says the property above was read, which is the point.
 */
const QUERY_RESULT_TYPES: readonly string[] = [
  'DeployableApplication',
  'DeployableCompose',
];

/** Every field the property is asserted over, so the walk going quiet reds. */
const FIELDS: Readonly<Record<string, readonly string[]>> = {
  DeployableApplication: [
    '<the row>',
    'aiModel',
    'bitbucket',
    'buildRegistry',
    'customGitSSHKey',
    'environment',
    'environment.project',
    'gitea',
    'github',
    'gitlab',
    'mounts[]',
    'ports[]',
    'registry',
  ],
  DeployableCompose: [
    '<the row>',
    'bitbucket',
    'customGitSSHKey',
    'environment',
    'environment.project',
    'gitea',
    'github',
    'gitlab',
  ],
};

/**
 * The fields whose declared row carries a column encrypted at rest — the
 * evidence for *"the property is not `no encrypted column reaches the deploy
 * engine`"*. Eight of the ten, and every one of them deliberate: a build
 * checks out a repository with an OAuth token, pushes an image with a registry
 * password, clones over a private key and runs with an env file. Frozen by
 * field rather than by column, so a ninth encrypted column on `application`
 * does not red this — but the first one on `port` would, and that is worth
 * being asked about, because `ports` is the other field a snapshot carries.
 */
const FIELDS_DECLARING_A_SECRET: readonly string[] = [
  'DeployableApplication.<the row>',
  'DeployableApplication.bitbucket',
  'DeployableApplication.buildRegistry',
  'DeployableApplication.customGitSSHKey',
  'DeployableApplication.environment',
  'DeployableApplication.environment.project',
  'DeployableApplication.gitea',
  'DeployableApplication.github',
  'DeployableApplication.gitlab',
  'DeployableApplication.registry',
  'DeployableCompose.<the row>',
  'DeployableCompose.bitbucket',
  'DeployableCompose.customGitSSHKey',
  'DeployableCompose.environment',
  'DeployableCompose.environment.project',
  'DeployableCompose.gitea',
  'DeployableCompose.github',
  'DeployableCompose.gitlab',
];

describe('DeployableApplication, on what its loader hands each field', () => {
  it('leaves no field declaring something other than the columns its query names', () => {
    expect(violations()).toEqual([]);
  });

  it('finds the query-result types the deployment queue declares', () => {
    expect(queryResultTypes().map((type) => type.name)).toEqual([
      ...QUERY_RESULT_TYPES,
    ]);
  });

  it('reads every field of each of them off the type', () => {
    const found = Object.fromEntries(
      queryResultTypes().map((type) => [
        type.name,
        type.fields.map((field) => field.label || '<the row>').sort(),
      ]),
    );

    expect(found).toEqual(FIELDS);
  });

  /**
   * The half that says the second branch of the property is live rather than
   * dead code. `mounts` is the one hand-written declaration among the twenty
   * fields — `ServiceMount` lives in `docker/docker.types.ts` because it is the
   * deploy engine's *input* shape rather than a row shape, and being
   * hand-written is exactly what let it fall behind the table. If it
   * ever becomes `typeof mount.$inferSelect`, the projection branch above stops
   * being exercised by anything and this is what says so.
   *
   * `aiModel` is the second: `DeployableAiModel` declares the three
   * facet columns a deploy reads, and its projection is what keeps the
   * facet's upstream secret out of the engine and out of a rollback's context.
   */
  it('answers for exactly two hand-written fields, and answers each with a projection', () => {
    const byHand = queryResultTypes().flatMap((type) =>
      type.fields
        .filter((field) => field.declared.kind === 'fields')
        .map((field) => `${type.name}.${field.label}`),
    );
    const projected = Object.fromEntries(
      loaders()
        .flatMap((loader) => loader.fills)
        .filter(
          (fill) =>
            fill.kind === 'projection' &&
            (fill.path === 'mounts' || fill.path === 'aiModel'),
        )
        .map((fill) => [fill.path, fill.columns]),
    );

    expect({ byHand, projected }).toEqual({
      byHand: [
        'DeployableApplication.mounts[]',
        'DeployableApplication.aiModel',
      ],
      projected: {
        mounts: ['filePath', 'hostPath', 'mountPath', 'type', 'volumeName'],
        aiModel: ['imageTag', 'model', 'runtime'],
      },
    });
  });

  /**
   * Not implied by the assertion above, which is 96f56c4's argument one level up:
   * adding `content` to `ServiceMount` would make the projection and the
   * declaration agree again, and a decrypted file-mount body would be back in
   * `rollback.full_context` with the type's blessing. A field filled by
   * a projection may name no ciphertext column at all, whatever it declares.
   */
  it('names no encrypted column in a projected field, whatever the field declares', () => {
    const named = loaders()
      .flatMap((loader) => loader.fills)
      .filter((fill) => fill.kind === 'projection')
      .flatMap((fill) =>
        encryptedColumnsOf(fill.table ?? '')
          .filter((column) => (fill.columns ?? []).includes(column))
          .map((column) => `${fill.path}.${column}`),
      );

    expect(named).toEqual([]);
  });

  it('declares the encrypted columns a build needs rather than excluding them', () => {
    const declaring = queryResultTypes().flatMap((type) =>
      type.fields
        .filter(
          (field) =>
            field.declared.kind === 'row' &&
            encryptedColumnsOf(field.declared.table).length > 0,
        )
        .map((field) => `${type.name}.${field.label || '<the row>'}`),
    );

    expect(declaring.sort()).toEqual([...FIELDS_DECLARING_A_SECRET]);
  });
});
