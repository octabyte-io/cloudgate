import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * **A container-addressed route says which `docker` statement it needs, and
 * says it where the guard and the reader both see it**.
 *
 * The gap this holds is one that was named earlier and could not be closed in
 * code. A route that takes a container id is authorized twice: once by its own
 * `@RequirePermission`, which `PermissionsGuard` runs before anything is
 * resolved, and once by `ContainerAccessService`, which resolves the id to the
 * Service that owns it and falls through to a machine-level `docker` statement
 * when no Service does (ADR-0008). **Those two are not the same statement**:
 * the five lifecycle verbs and the file upload declare `docker: ['write']`
 * while the gate's machine branch asks `docker: ['read']`, and
 * `CustomRolesService.validatePermissions` accepts `write` with no `read` —
 * which is exactly the caller that was found able to tell an unmanaged
 * container from a foreign one, and its own organization's from everybody
 * else's.
 *
 * Both of those are fixed as *refusals*. What is not fixed, and cannot be by a
 * translation, is that **nothing makes the next container-addressed route say
 * anything at all**. `PermissionsGuard`'s third statement is `if (!required)
 * return true;` — a documented fail-open (`route-permissions.spec.ts` carries
 * why it stays) — so a route added with no decorator would be gated by the
 * gate's `docker: ['read']` alone, silently re-opening a closed shape
 * with no compiler signal anywhere. TypeScript cannot see it: the decorator is
 * metadata and the gate is three call frames away in another module.
 *
 * So it is checked from here, in `route-permissions.spec.ts`' and
 * `describe-names.spec.ts`' shape — walk `src`, read the metadata, assert a
 * property. **Nothing is frozen**: there is no list of route names to keep in
 * step, and a route that arrives declaring its statement passes without being
 * written down anywhere.
 *
 * The three properties, and what each one would have caught:
 *
 * 1. **Every container-addressed route declares a statement**, and declares it
 *    on the resource the gate behind it reasons about. This is "a route
 *    added asking neither" — the one the guard's fail-open makes silent.
 * 2. **Its declaration covers what its own service method claims.** A route
 *    declaring `read` over a method that asks `write` is a decorator that lies
 *    to the reader and to `PermissionGrid`, and it is the state the
 *    `docker: ['write']` changes each had to fix by hand in two places.
 * 3. **It reaches the shared gate.** A container id authorized by a `docker`
 *    statement and nothing else is the earlier finding verbatim — that any
 *    organization could stop, delete or `docker cp` into another's container on
 *    the platform host.
 *
 * **What is deliberately *not* asserted, because it is false and was meant to
 * be.** The property was first worded as *"every container-addressed route's
 * declared statement is a superset of what its gate asks"*. Taken literally
 * that is a claim about the **actions**, and it does not hold: the gate's
 * machine branch asks `docker: ['read']`, the five verbs and the upload declare
 * `docker: ['write']`, and `write` does not imply `read` — they were made two
 * actions precisely so a *read* statement would stop authorizing `docker rm
 * -f`, and `validatePermissions` accepts either alone. Asserting the superset
 * would demand that every destructive route re-declare `read`, which is the
 * conflation that split undid. So the action relation is left where ADR-0008
 * records it, and what is held here is the half a superset was standing in for:
 * the two are about **one resource**, so an operator has one grant to reason
 * about and a new route cannot arrive gated on some other one — and each
 * route's own declaration covers its own body, which is the half that had to be
 * corrected by hand.
 */

const backendRoot = join(__dirname, '..', '..');

/**
 * What makes a route container-addressed: it takes a container id in its path.
 *
 * The path parameter rather than a list of route names, so the property is
 * about the shape of the request and a new route joins the set by being what it
 * is. `ContainerIdParamsDto` is the DTO every one of them validates the
 * parameter with, and the name is fixed by that.
 */
const CONTAINER_PARAM = ':containerId';

/** The gate a container-addressed route is required to reach (ADR-0008). */
const GATE_FILE = join(
  backendRoot,
  'src',
  'realtime',
  'container-access.service.ts',
);

/**
 * The gate's own entry points, as a reader of `docker-ops.service.ts` meets
 * them: the public method on `ContainerAccessService` and the private wrapper
 * that every route on `DockerOpsService` goes through.
 */
const GATE_ENTRIES = ['authorizeContainer', 'authorizeManagedContainer'];

/** Every `.ts` file under `dir`, recursively. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.isFile() && path.endsWith('.ts')) found.push(path);
  }
  return found;
}

const sourceFiles = walk(join(backendRoot, 'src'));

/**
 * A class method's declaration line. `route-permissions.spec.ts`' regex, plus
 * `<` so a generic method is one too; both files parse by *method* rather than
 * by decorator because Nest applies `@Post`, `@HttpCode` and
 * `@RequirePermission` in any order and only the declaration is a fixed point.
 */
const DECLARATION =
  /^ {2}(?:(?:public|private|protected)\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*[(<]/;

/** The contiguous decorator block above a method, read upwards. */
function decoratorsAbove(lines: string[], index: number): string {
  const found: string[] = [];
  for (let i = index - 1; i >= 0; i -= 1) {
    const text = lines[i].trim();
    if (
      text === '' ||
      text.startsWith('*') ||
      text.startsWith('//') ||
      text.startsWith('/*')
    ) {
      continue;
    }
    if (!text.startsWith('@')) break;
    found.push(text);
  }
  return found.join(' ');
}

/** A method's body: its declaration through the closing brace at class indent. */
function bodyAt(lines: string[], index: number): string[] {
  for (let i = index + 1; i < lines.length; i += 1) {
    if (/^ {2}\}/.test(lines[i])) return lines.slice(index, i);
  }
  return lines.slice(index);
}

interface Method {
  /** `docker` actions this method claims through `checkPermission`. */
  readonly dockerActions: string[];
  /** Method names it calls, so a delegating wrapper can be followed. */
  readonly calls: string[];
}

/**
 * Every method in `src` by name, with the `docker` actions it claims and the
 * methods it calls.
 *
 * Keyed by bare method name and unioned across collisions, which is the loose
 * end this shares with `route-permissions.spec.ts`' word check. It is the safe
 * direction: a collision can only add actions and call edges, so it can make an
 * assertion demand *more* of a route, never less — a false red rather than a
 * false green.
 */
function methodsInSrc(): Map<string, Method> {
  const methods = new Map<string, Method>();

  for (const file of sourceFiles) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const declared = DECLARATION.exec(line);
      if (!declared || declared[1] === 'constructor') return;
      if (line.trim().startsWith('@')) return;

      const body = bodyAt(lines, index).join('\n');
      const dockerActions = [
        ...body.matchAll(
          /checkPermission\([^,]*,\s*\{\s*docker:\s*\[([^\]]*)\]/g,
        ),
      ].flatMap(([, actions]) =>
        actions
          .split(',')
          .map((action) => action.replace(/['"\s]/g, ''))
          .filter(Boolean),
      );
      const calls = [...body.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/g)].map(
        ([, name]) => name,
      );

      const existing = methods.get(declared[1]);
      methods.set(declared[1], {
        dockerActions: [
          ...new Set([...(existing?.dockerActions ?? []), ...dockerActions]),
        ],
        calls: [...new Set([...(existing?.calls ?? []), ...calls])],
      });
    });
  }
  return methods;
}

/**
 * Breadth-first from a handler through the methods it calls, so a one-line
 * wrapper — `restartContainer` over `containerOp` — is read as the gate and the
 * statement its body reaches rather than as a method that asks for nothing.
 * Bounded by the visited set, not by a depth.
 *
 * **The walk stops at the gate** (`stops`), which is what keeps `claimed` the
 * *route's* claim rather than the whole stack's. Descending into
 * `ContainerAccessService` would fold the machine branch's `docker: ['read']`
 * into every route, and that action is deliberately not the five verbs'
 * declaration — the divergence this file exists to make legible,
 * not one to launder into a false green.
 */
function walkFrom(
  methods: Map<string, Method>,
  start: string,
  stops: readonly string[],
): { reached: Set<string>; claimed: Set<string> } {
  const reached = new Set<string>();
  const claimed = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (reached.has(name)) continue;
    reached.add(name);
    if (stops.includes(name)) continue;
    const method = methods.get(name);
    if (!method) continue;
    for (const action of method.dockerActions) claimed.add(action);
    for (const next of method.calls) {
      if (!reached.has(next)) queue.push(next);
    }
  }
  return { reached, claimed };
}

interface Route {
  /** Path relative to `backend/`, so a failure is a thing you can open. */
  readonly file: string;
  readonly verb: string;
  readonly path: string;
  readonly handler: string;
  /** `resource:action` from `@RequirePermission`, or null when there is none. */
  readonly declared: string | null;
  /** Every method reachable from the handler, the gate included. */
  readonly reached: Set<string>;
  /** Every `docker` action those methods claim through `checkPermission`. */
  readonly claimed: Set<string>;
}

const VERBS = ['Get', 'Post', 'Patch', 'Put', 'Delete'] as const;

/** Every handler in `src/**\/*.controller.ts` whose path names a container id. */
function containerAddressedRoutes(): Route[] {
  const methods = methodsInSrc();
  const routes: Route[] = [];

  for (const file of sourceFiles
    .filter((path) => path.endsWith('.controller.ts'))
    .sort()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const prefix = lines
      .map((line) => /^@Controller\(['"]([^'"]*)['"]\)/.exec(line)?.[1])
      .find((found) => found !== undefined);

    lines.forEach((line, index) => {
      const declared = DECLARATION.exec(line);
      if (!declared || declared[1] === 'constructor') return;
      if (line.trim().startsWith('@')) return;

      const decorators = decoratorsAbove(lines, index);
      const verb = new RegExp(
        `@(${VERBS.join('|')})\\((?:['"]([^'"]*)['"])?\\)`,
      ).exec(decorators);
      if (!verb) return;

      const path = `/${[prefix, verb[2]].filter(Boolean).join('/')}`;
      if (!path.includes(CONTAINER_PARAM)) return;

      const { reached, claimed } = walkFrom(methods, declared[1], GATE_ENTRIES);

      const required = /@RequirePermission\('(\w+)',\s*'(\w+)'\)/.exec(
        decorators,
      );

      routes.push({
        file: relative(backendRoot, file),
        verb: verb[1].toUpperCase(),
        path,
        handler: declared[1],
        declared: required ? `${required[1]}:${required[2]}` : null,
        reached,
        claimed,
      });
    });
  }
  return routes;
}

/**
 * The resource the gate's machine branch asks for, read out of the gate rather
 * than written down here.
 *
 * `machineAccess` is what an **unmanaged** container falls through to, and its
 * statement is the one every container-addressed route's declaration has to be
 * about — the pair that came apart with `docker: ['write']` and stayed apart
 * until the refusal was translated. Reading it means the day it moves to
 * another resource this file says so, instead of asserting a literal that used
 * to be true.
 */
function gateResource(): string {
  const source = readFileSync(GATE_FILE, 'utf8');
  const asked = /checkPermission\([^,]*,\s*\{\s*(\w+):\s*\[/.exec(source);
  return asked ? asked[1] : 'the gate asks for no statement at all';
}

const name = ({ verb, path, handler }: Route) => `${verb} ${path} (${handler})`;

/**
 * The gates a read keyed on a Service's `appName` may reach.
 *
 * The first three are `ContainerAccessService`'s — the refusing gate, the one
 * it wraps, and the filtering predicate the metrics read picks series with.
 * The fourth is the **swarm** routes' machine gate, and it is a structural
 * exception rather than a list of routes: CONTEXT.md, *Managed container*,
 * puts a swarm service outside Service resolution (H-63), so
 * `GET /swarm/apps/info` is a machine-level read on purpose and its sibling
 * `GET /swarm/apps` lists every Swarm service on the machine anyway.
 */
const APP_NAME_GATES = [
  'authorizeAppName',
  'authorizeAppNames',
  'firstReadable',
  'instanceOrServerScoped',
];

/** A file under a `dto/` directory. */
const DTO_FILE = /[\\/]dto[\\/][^\\/]+\.ts$/;

/** A `createZodDto` class and its schema argument. */
const ZOD_DTO = /export class (\w+) extends createZodDto\(([\s\S]*?)\) \{\}/g;

/** `appName` as an object key: `appName,` shorthand or `appName:`. */
const APP_NAME_KEY = /(?:^|[{,])\s*appName\s*[,:}]/m;

/** A source file with its comment lines dropped. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => {
      const text = line.trim();
      return !(
        text.startsWith('//') ||
        text.startsWith('*') ||
        text.startsWith('/*')
      );
    })
    .join('\n');
}

/**
 * Every `createZodDto` class under `src/**\/dto/`, by class name, whose schema
 * has an `appName` key.
 *
 * The schema is the `createZodDto(...)` argument; a bare identifier there is
 * followed to its `const` in the same file. Comment lines are dropped first,
 * so a docblock that mentions `appName` does not make a DTO keyed on it.
 */
function dtosKeyedOnAppName(): Set<string> {
  const keyed = new Set<string>();
  for (const file of sourceFiles.filter((path) => DTO_FILE.test(path))) {
    const code = codeOf(file);
    for (const [, className, argument] of code.matchAll(ZOD_DTO)) {
      let schema = argument.trim();
      if (/^\w+$/.test(schema)) {
        const start = code.indexOf(`const ${schema} =`);
        schema =
          start === -1 ? '' : code.slice(start, code.indexOf(';\n', start));
      }
      if (APP_NAME_KEY.test(schema)) keyed.add(className);
    }
  }
  return keyed;
}

interface AppNameRead {
  /** Path relative to `backend/`, so a failure is a thing you can open. */
  readonly file: string;
  readonly path: string;
  readonly handler: string;
  /** Every method reachable from the handler, a gate included. */
  readonly reached: Set<string>;
}

/**
 * Every `@Get` handler in `src/**\/*.controller.ts` whose `@Query()` DTO has
 * an `appName` key — a read whose answer is keyed on a Service's name.
 *
 * Selected by the DTO's schema rather than by route name, so a new read joins
 * the set by being what it is.
 */
function appNameKeyedReads(): AppNameRead[] {
  const methods = methodsInSrc();
  const keyed = dtosKeyedOnAppName();
  const reads: AppNameRead[] = [];

  for (const file of sourceFiles
    .filter((path) => path.endsWith('.controller.ts'))
    .sort()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const prefix = lines
      .map((line) => /^@Controller\(['"]([^'"]*)['"]\)/.exec(line)?.[1])
      .find((found) => found !== undefined);

    lines.forEach((line, index) => {
      const declared = DECLARATION.exec(line);
      if (!declared || declared[1] === 'constructor') return;
      if (line.trim().startsWith('@')) return;

      const get = /@Get\((?:['"]([^'"]*)['"])?\)/.exec(
        decoratorsAbove(lines, index),
      );
      if (!get) return;

      const query = /@Query\(\)\s*\w+\??:\s*(\w+)/.exec(
        bodyAt(lines, index).join('\n'),
      );
      if (!query || !keyed.has(query[1])) return;

      reads.push({
        file: relative(backendRoot, file),
        path: `/${[prefix, get[1]].filter(Boolean).join('/')}`,
        handler: declared[1],
        reached: walkFrom(methods, declared[1], APP_NAME_GATES).reached,
      });
    });
  }
  return reads;
}

describe('CODING_STANDARDS.md', () => {
  describe('§2.2, on container-addressed routes and their gate', () => {
    /**
     * The premise, asserted first so the three below cannot pass by finding
     * nothing. A regex that stops matching — a renamed path parameter, a
     * `@Controller` prefix written another way — would otherwise turn this
     * whole file green.
     */
    it('finds the container-addressed routes at all', () => {
      const routes = containerAddressedRoutes();

      expect(routes.length).toBeGreaterThanOrEqual(7);
      expect(new Set(routes.map((route) => route.file))).toEqual(
        new Set(['src/docker-ops/docker-ops.controller.ts']),
      );
    });

    /**
     * In the original words: *"a route added asking neither would reintroduce
     * the shape with no compiler signal"*. The guard's fail-open is what makes
     * an undecorated one silent, and the gate's `docker: ['read']` is what it
     * would fall back to — a *read* statement authorizing whatever the new
     * route does, which is the read-authorizes-write defect arriving a third
     * time.
     *
     * The resource is read off the gate rather than spelled `docker` here, so a
     * route gated on some other resource is red for the reason it is wrong: the
     * caller's grant on **that** resource decides one half of the answer and
     * their `docker` grant decides the other, and nothing reconciles the two.
     */
    it('leaves no container-addressed route without a statement on the gate’s own resource', () => {
      const resource = gateResource();

      const unstated = containerAddressedRoutes()
        .filter((route) => route.declared?.split(':')[0] !== resource)
        .map(
          (route) => `${name(route)} declares ${route.declared ?? 'nothing'}`,
        );

      expect(unstated).toEqual([]);
    });

    /**
     * The decorator and the service layer are two statements of one claim, and
     * the `docker: ['write']` changes each had to move both by hand. A route
     * whose declaration does not cover what its own body asks for is a
     * decorator a reader — and the console's `PermissionGrid`, which renders
     * off the catalogue and the decorators — is entitled to believe and should
     * not.
     *
     * Superset rather than equality: a route is free to declare more than it
     * claims, which is what a route asking `['read', 'write']` over a body that
     * checks only one of them would be, and that direction refuses more callers
     * rather than fewer.
     */
    it('declares at least the docker actions its own service method claims', () => {
      const short = containerAddressedRoutes()
        .map((route) => ({
          route,
          missing: [...route.claimed].filter(
            (action) => route.declared !== `${gateResource()}:${action}`,
          ),
        }))
        .filter(({ missing }) => missing.length > 0)
        .map(
          ({ route, missing }) =>
            `${name(route)} declares ${route.declared ?? 'nothing'} and claims ${missing.join(', ')}`,
        );

      expect(short).toEqual([]);
    });

    /**
     * The cross-organization container finding, held rather than re-found. The
     * statement is an *organization* capability and `ownedServerId` resolves an
     * absent `serverId` to the platform host by design (ADR-0008's second
     * consequence), so neither of the two checks in front of the gate is a
     * claim about *this container* — a route that skipped the gate would be
     * reachable by id from every organization on the shared machine, which is
     * the finding verbatim.
     *
     * Reached transitively, so the five one-line lifecycle wrappers over
     * `containerOp` count as reaching it, which is where its fix deliberately put
     * the single call.
     */
    it('reaches the shared container gate from every one of them', () => {
      const ungated = containerAddressedRoutes()
        .filter(
          (route) => !GATE_ENTRIES.some((entry) => route.reached.has(entry)),
        )
        .map(name);

      expect(ungated).toEqual([]);
    });
  });

  /**
   * **A read whose answer is keyed on a Service's `appName` reaches the
   * container gate**.
   *
   * The routes above are addressed by a container *id*, which the gate
   * resolves to a Service. These are addressed by the *name* a Service's
   * containers carry, and five of them skipped the resolution altogether: a
   * base member searched every organization's containers on the platform host
   * by name prefix, an owner of one organization read another's Swarm tasks,
   * and the metrics read answered from whichever stored series best matched a
   * substring. ADR-0008, as extended, carries the rule.
   *
   * **Nothing is frozen**, in keeping with the describe above: a new read keyed
   * on `appName` passes by reaching one of {@link APP_NAME_GATES}, not by being
   * written down here.
   */
  describe("§2.2, on routes keyed on a Service's appName", () => {
    /**
     * The premise, so the property below cannot pass by finding nothing: a DTO
     * resolution that stops matching would otherwise select no route at all.
     */
    it('finds the appName-keyed reads at all', () => {
      const reads = appNameKeyedReads();

      expect(reads.length).toBeGreaterThanOrEqual(6);
      expect(new Set(reads.map((read) => read.file))).toEqual(
        new Set([
          'src/docker-ops/docker-ops.controller.ts',
          'src/docker-ops/swarm.controller.ts',
          'src/monitoring/monitoring.controller.ts',
        ]),
      );
    });

    it('reaches an entitlement gate from every one of them', () => {
      const ungated = appNameKeyedReads()
        .filter(
          (read) => !APP_NAME_GATES.some((gate) => read.reached.has(gate)),
        )
        .map((read) => `GET ${read.path} (${read.handler})`);

      expect(ungated).toEqual([]);
    });
  });
});
