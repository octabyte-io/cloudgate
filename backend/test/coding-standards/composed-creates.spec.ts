import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The `service: ['update']` carve-out, applied to a **composed** operation and
 * held there.
 *
 * A composed create is a method that authorizes once at the parent — always
 * `checkServiceAccess(ctx, parent.projectId, 'create')` — inserts a Service,
 * grants the caller row-level access to it with
 * `PermissionService.addNewService`, and then populates it by calling *other*
 * services' permission-checking methods. `AiService.deploy` is the one that
 * populates anything (its sibling, the `template.toml` deploy, was removed in
 * #1364; a Template's parts are created by a Plan's Apply, whose
 * `PlanApplier.check` asks every statement first); the other
 * create-a-Service paths stop at the grant.
 *
 * Every service *definition* write points at a `service: ['update']`
 * action, `MountsService.create` among them. That is right for `POST /mounts`,
 * which edits a definition somebody else's statement built — and it broke both
 * composed creates, because they reach the same method for the config files
 * that **are** the definition they are in the middle of writing. A custom role
 * holding `service: ['create', 'read']` authorized the stack, wrote it, was
 * granted it, and was then refused its own mounts, with the compose row left
 * committed. `service: ['create']` had become a statement no caller could carry
 * to completion.
 *
 * A single e2e caught it — `test/ai/ai.e2e-spec.ts`, and only because that
 * suite happens to build a custom `deployer` role. The `template.toml` deploy
 * had the same defect and no such assertion, which is the reason this file exists: a
 * permission boundary held by whether one suite remembered to use a custom role
 * is held by nothing. So the property is checked over the *set* — every
 * composed create, including ones not written yet.
 *
 * **The property.** A composed create authorized `service: ['create']` at the
 * Project before it wrote anything. Nothing it reaches afterwards may demand a
 * level *above* that from the same caller — no `'update'` on the Service it
 * just made, on the Environment above it, or on the Project above that. What it
 * may still demand is a *different resource's* statement, which asks a
 * different question: `DomainsService.create` requires `domain: ['create']` and
 * `MountsService.createForNewService` requires `volume: ['create']`, and both
 * still run a `checkServiceAccess` at `'read'` — the entitlement half, *which*
 * Service, which `CONTEXT.md`'s Service entry separates from the level.
 *
 * The shape is `route-permissions.spec.ts`'s and `describe-names.spec.ts`'s,
 * for their stated reason: nothing in ESLint can hold this. Deciding whether
 * `this.mounts.create(...)` demands a level means resolving `mounts` to a class
 * in another file and reading that method's gates. So it is checked from here —
 * walk, resolve one hop, assert the list is empty.
 *
 * Resolution is deliberately **one hop**: a composed create's own body, its
 * constructor's declared dependency types, and the gates written literally in
 * the method it names. That is why `MountsService` writes its level as a
 * literal in each of its two entry points rather than threading it through one
 * private on a parameter — the gate is readable where the caller lands, which
 * is where a reader looks for it too.
 */

const backendRoot = join(__dirname, '..', '..');

/**
 * Every composed create in `src`, frozen. It can grow — a sixth
 * create-a-Service path is a normal thing to add — but not silently: an
 * addition here says "I have read the property above and my new path holds
 * it". It is also the anti-rot half, and the more important one. If
 * `addNewService` is ever renamed, the walk below finds nothing and every
 * assertion in this file passes over an empty set; this is what says so.
 *
 * The three console creates are named by their insert halves:
 * each public `create` runs its insert inside a console Save
 * (`project-config/console-saves`), which keeps a Cloudgate-kept Project
 * config in step and grants nothing.
 */
const COMPOSED_CREATES: readonly string[] = [
  'AiService.deploy',
  'ApplicationsService.insertApplication',
  'BaseDatabaseService.insertDatabase',
  // A plan's bucket create; there is no console create.
  'BucketsService.create',
  // A stack on a Server or this host, and, through `compose-stack-vms.ts`,
  // one on its own Stack VM: a plan's (ADR-0070) and a console's (#1372).
  'ComposeService.insertCompose',
];

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
 * Comments blanked, lines preserved.
 *
 * Load-bearing rather than tidiness: this file's own docblocks quote
 * `checkServiceAccess(projectId, 'create')` and `service: ['update']` in prose,
 * and so do the two call sites it is about. Reading those as gates would make
 * every method that *explains* a level look like one that claims it, which is
 * the failure mode a text-matching gate has and the one that makes it useless.
 * A trailing `//` is only cut when it does not follow a `:` or a quote, so a
 * `https://` in a string survives.
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

interface Method {
  readonly name: string;
  readonly body: string;
}

interface ServiceFile {
  readonly file: string;
  readonly className: string;
  /** Constructor property name → declared type, e.g. `mounts` → `MountsService`. */
  readonly dependencies: ReadonlyMap<string, string>;
  readonly methods: readonly Method[];
}

/**
 * A method declaration at class-body indent. Prettier is an `error` in this
 * config, so two spaces is the class body and four is inside a method — which
 * is what keeps an object literal's method-ish line out of this.
 */
const DECLARATION =
  /^ {2}(?:public |private |protected )?(?:static )?(?:abstract )?(?:async )?\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/;

/** Control-flow keywords that a bare declaration regex would otherwise take. */
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

  const dependencies = new Map<string, string>();
  for (const [, property, type] of text.matchAll(
    /(?:private|public|protected)\s+readonly\s+([A-Za-z_$][\w$]*):\s*([A-Za-z_$][\w$]*)/g,
  )) {
    dependencies.set(property, type);
  }

  const lines = text.split('\n');
  const methods: Method[] = [];
  lines.forEach((line, index) => {
    const named = DECLARATION.exec(line);
    if (!named || NOT_METHODS.has(named[1])) return;
    let end = index;
    while (end < lines.length && !/^ {2}\}/.test(lines[end])) end += 1;
    methods.push({
      name: named[1],
      body: lines.slice(index, end + 1).join('\n'),
    });
  });

  return {
    file: relative(backendRoot, path),
    className: declared[1],
    dependencies,
    methods,
  };
}

function serviceFiles(): ServiceFile[] {
  return walk(join(backendRoot, 'src'))
    .filter((file) => /(?:\.service|-service)\.ts$/.test(file))
    .sort()
    .map(parseServiceFile)
    .filter((parsed): parsed is ServiceFile => parsed !== null);
}

/**
 * Does this method claim a definition-write level for its caller?
 *
 * Two spellings, and both are in the tree because the `update` change put them
 * there: a `check…Access(…, 'update')` written out, or a call to the module's
 * `findOwnedForUpdate` sibling, which is that same call with the ownership
 * lookup behind it. `checkServiceAccess`, `checkEnvironmentAccess` and
 * `checkProjectAccess` are all matched — the other two resources have the same
 * action, and a composed create is no more entitled to those than to this one.
 */
function claimsUpdate(body: string): boolean {
  if (/\bfindOwnedForUpdate\s*\(/.test(body)) return true;
  const flat = body.replace(/\s+/g, ' ');
  for (const [, args] of flat.matchAll(
    /\bcheck[A-Za-z]*Access\(([^;]*?)\)\s*;/g,
  )) {
    if (args.includes("'update'")) return true;
  }
  return false;
}

/**
 * `Class.method` for every method that claims one.
 *
 * `PermissionService` is excluded: `checkServiceAccess` *takes* the action as a
 * parameter and names it in its own signature, so it would list itself and
 * every caller that reaches it would look like a violation of what it is.
 */
function methodsClaimingUpdate(files: readonly ServiceFile[]): Set<string> {
  const claimed = new Set<string>();
  for (const parsed of files) {
    if (parsed.className === 'PermissionService') continue;
    for (const method of parsed.methods) {
      if (claimsUpdate(method.body))
        claimed.add(`${parsed.className}.${method.name}`);
    }
  }
  return claimed;
}

/** The methods that grant on create — see the docblock at the top. */
function composedCreates(
  files: readonly ServiceFile[],
): { owner: ServiceFile; method: Method }[] {
  return files.flatMap((owner) =>
    owner.methods
      .filter((method) => /\.addNewService\(/.test(method.body))
      .map((method) => ({ owner, method })),
  );
}

describe('PermissionService.addNewService, as the marker of a composed create', () => {
  it('leaves no composed create reaching a level its own authorization does not cover', () => {
    const files = serviceFiles();
    const claimed = methodsClaimingUpdate(files);

    const reached = composedCreates(files).flatMap(({ owner, method }) =>
      [
        ...method.body.matchAll(
          /this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(/g,
        ),
      ]
        .map(([, property, called]) => ({
          type: owner.dependencies.get(property),
          called,
        }))
        .filter(
          ({ type }) => type !== undefined && type !== 'PermissionService',
        )
        .map(({ type, called }) => `${type as string}.${called}`)
        .filter((target) => claimed.has(target))
        .map((target) => `${owner.className}.${method.name} -> ${target}`),
    );

    expect(reached).toEqual([]);
  });

  /**
   * The anti-rot half, and the one that makes the assertion above mean
   * something: an empty set satisfies "leaves no composed create reaching …"
   * perfectly, and a rename of `addNewService` produces exactly that.
   */
  it('finds the composed creates it was frozen against', () => {
    const found = composedCreates(serviceFiles())
      .map(({ owner, method }) => `${owner.className}.${method.name}`)
      .sort();

    expect(found).toEqual([...COMPOSED_CREATES]);
  });

  /**
   * The other direction, which is the one that must **not** move. The `update`
   * change raised `POST /mounts`, `PATCH /mounts/:mountId` and `DELETE
   * /mounts/:mountId` to `service: ['update']` for a reason argued at length in
   * `MountsService.create`'s docblock — `volume` is the Docker volume, not the
   * Mount row that references it — and the fix above must not have been bought
   * by lowering them. It was not: the internal twin is a second method, named,
   * and it is the only one that takes `'read'`.
   *
   * Both directions in one object so a failure names which one moved.
   */
  it('leaves the standalone mount writes claiming a definition-write level', () => {
    const claimed = methodsClaimingUpdate(serviceFiles());
    const level = (method: string) => claimed.has(`MountsService.${method}`);

    expect({
      create: level('create'),
      update: level('update'),
      remove: level('remove'),
      createForNewService: level('createForNewService'),
    }).toEqual({
      create: true,
      update: true,
      remove: true,
      createForNewService: false,
    });
  });

  /**
   * What makes "internal" a property rather than a comment. The twin is safe
   * only because its callers authorized the whole composed operation at the
   * Project first; a controller reaching it directly would be `POST /mounts`
   * with the `update` gate taken back off.
   */
  it('exposes no internal composed-create twin to a controller', () => {
    const reached = walk(join(backendRoot, 'src'))
      .filter((file) => file.endsWith('.controller.ts'))
      .filter((file) =>
        withoutComments(readFileSync(file, 'utf8')).includes(
          'createForNewService',
        ),
      )
      .map((file) => relative(backendRoot, file));

    expect(reached).toEqual([]);
  });
});
