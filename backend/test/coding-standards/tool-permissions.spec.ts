import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { routeOf } from '../../src/enterprise/audit-logs/audit-routes';
import { ROW_SCOPED, routesOf } from '../../src/mcp/tool-definition';
import type { AnyRoute, ToolPermissions } from '../../src/mcp/tool-definition';
import { MCP_TOOLS } from '../../src/mcp/tools';
import { REQUIRE_PERMISSION_KEY } from '../../src/rbac/decorators/require-permission.decorator';
import { BASELINE } from './route-permissions.baseline';

/**
 * "The same check" held by a census, not by care (ADR-0023).
 *
 * Every MCP tool names its HTTP twin and must declare permissions identical to
 * it; its service method must take `ctx: PermissionCtx` first; and the counts
 * that would let an agent-only permission in quietly are frozen. The six
 * assertions, each below under its own `it`:
 *
 * 1. a named twin, served by a real route;
 * 2. permissions identical to a decorated twin's `@RequirePermission`;
 * 3. an undecorated twin written down — see the adjustment below;
 * 4. the target method taking `ctx` first, which catches a tool wired to the
 *    ctx-less, unchecked half of a pair (`runManual`/`runScheduled`);
 * 5. the ungated count frozen at zero;
 * 6. the no-twin count frozen (at zero).
 *
 * **A tool taking a Service kind has a twin per kind.** `get_service`
 * is `GET /applications/:id` for an Application and `GET /postgres/:id` for a
 * Postgres, so every assertion runs per *route* — each kind's twin, target
 * and enforcing call — against the tool's one `permissions`. The kinds each
 * such tool routes are frozen too. A database engine's target method is
 * inherited from `BaseDatabaseService`, so the file an assertion reads is the
 * one whose class declares the method, not the engine's own.
 *
 * **The adjustment to assertion 3.** It was first written as "an undecorated
 * twin is already in `route-permissions.spec.ts`'s `BASELINE`". That cannot
 * hold for a read: `BASELINE` lists only *mutating* handlers (its
 * `MUTATING_VERBS`), and every twin of the Project tools — `GET /projects`,
 * `GET /environments`, `GET /environments/:id` — is an undecorated `GET`,
 * gated in the service layer. Waiving the assertion for reads would leave the
 * twin's statement unchecked, which is the drift it exists to catch. So it is
 * split by verb:
 *
 * - an undecorated **mutating** twin must be in `BASELINE`, as first written
 *   (`BASELINE` now lives in `route-permissions.baseline.ts` so this file can
 *   read it);
 * - an undecorated **read** twin must name, in `twin.enforcedIn`, the call in
 *   its service that enforces the statement — and this file reads that method
 *   out of the named file, finds the call, and checks it asks for exactly the
 *   tool's permissions: `check*Access(ctx, id, '<action>')` for a statement,
 *   `findMember(ctx)` plus a grant column for {@link ROW_SCOPED}. Renaming the
 *   method, dropping the call or changing its action reds here.
 */

const backendRoot = join(__dirname, '..', '..');

/**
 * The eleven tools of the agent spec's table — the seven reads and the four
 * writes — and the six Requested-preview tools of the preview spec's table,
 * each twinned to a preview route under that route's statement, all of which
 * the agent roles already held: 11 → 17 with ADR-0023 unamended.
 * `get_service_health` reads a Service's health under the Health tab's own
 * `service: ['read']`, which both agent roles already held: 17 → 18, no role
 * changed. The Project config tools (spec US70) read a Project's config on its
 * entitlement and an Environment's plan and ask for one under `environment:
 * ['read']`, all of which both roles already held: 18 → 21, no role changed —
 * and no apply tool, which would need a Service write no agent role holds. The
 * count is frozen (ADR-0023).
 */
const FROZEN_TOOLS = [
  'list_projects',
  'list_environments',
  'get_environment',
  'get_service',
  'list_deployments',
  'read_deployment_log',
  'list_domains',
  'get_service_health',
  'deploy_service',
  'start_service',
  'stop_service',
  'cancel_deployment',
  'create_preview',
  'list_previews',
  'get_preview',
  'extend_preview',
  'redeploy_preview',
  'delete_preview',
  'get_project_config',
  'get_plan',
  'request_plan',
];

/**
 * Tools taking a Service kind, one twin per kind. Written out so a
 * kind added to a tool — a ninth engine, a new owner — is a reviewed edit and
 * its twin is checked below like every other.
 */
const FROZEN_ROUTES: Readonly<Record<string, readonly string[]>> = {
  get_service: [
    'application',
    // A bucket is read as any Service is; it is never started or stopped.
    'bucket',
    'compose',
    'libsql',
    'mariadb',
    'mongo',
    'mysql',
    'postgres',
    'redis',
  ],
  list_deployments: ['application', 'compose'],
  list_domains: ['application', 'compose'],
  get_service_health: [
    'application',
    // A bucket is read as any Service is; it is never started or stopped.
    'bucket',
    'compose',
    'libsql',
    'mariadb',
    'mongo',
    'mysql',
    'postgres',
    'redis',
  ],
  deploy_service: ['application', 'compose'],
  start_service: [
    'application',
    'compose',
    'libsql',
    'mariadb',
    'mongo',
    'mysql',
    'postgres',
    'redis',
  ],
  stop_service: [
    'application',
    'compose',
    'libsql',
    'mariadb',
    'mongo',
    'mysql',
    'postgres',
    'redis',
  ],
};

/**
 * The only Service-health methods a tool may call (spec "No MCP
 * tool writes it"): the two reads, each gated like the Health tab's summary.
 * A check's or a threshold's write lives on another service, or behind a
 * mutating route, and both are refused below — so adding a method here is the
 * edit that would let an Agent silence an Incident, and has to be argued.
 */
const FROZEN_HEALTH_READS = [
  'ServiceHealthService.forAgent',
  'ServiceHealthService.openIncidents',
];

/** Tools that declare no statement and filter by grant columns instead. */
const FROZEN_ROW_SCOPED = [
  'list_projects',
  'list_environments',
  // A Project is read on its entitlement alone; there is no `project: read`.
  'get_project_config',
];

/**
 * `checkProjectAccess(ctx, 'read', id)`: no statement, only the member's
 * `accessedProjects` (for a role short of owner and admin) — the row-scoped
 * check addressed to one Project.
 */
const PROJECT_READ_CHECK = /\.checkProjectAccess\(ctx, 'read', \w+\)$/;

/** A tool with no HTTP twin needs a statement no route declares — the ADR-0023 tripwire. */
const FROZEN_NO_TWIN_COUNT = 0;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Grant-column check → the statement it enforces. */
const ACCESS_CHECK_RESOURCE: Record<string, string> = {
  checkProjectAccess: 'project',
  checkEnvironmentAccess: 'environment',
  checkServiceAccess: 'service',
};

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}

const SOURCES = walk(join(backendRoot, 'src')).map((file) => ({
  file: relative(backendRoot, file),
  text: readFileSync(file, 'utf8'),
}));

/** The `src` file declaring `export [abstract] class <name>`. */
function fileDeclaring(name: string): { file: string; text: string } {
  const found = SOURCES.find(({ text }) =>
    new RegExp(`^export (?:abstract )?class ${name}\\b`, 'm').test(text),
  );
  if (!found) throw new Error(`no file in src declares class ${name}`);
  return found;
}

interface ClassLike {
  readonly name: string;
  readonly prototype: object;
}

/**
 * The file whose class body declares `method` for `service` — the service's
 * own, or the base class it inherits the method from (the six database
 * engines' `findOne` is `BaseDatabaseService`'s).
 */
function fileDeclaringMethod(
  service: ClassLike,
  method: string,
): { file: string; text: string } {
  for (
    let current: ClassLike | null = service;
    current && current !== Function.prototype;
    current = Object.getPrototypeOf(current) as ClassLike | null
  ) {
    if (Object.prototype.hasOwnProperty.call(current.prototype, method)) {
      return fileDeclaring(current.name);
    }
  }
  return fileDeclaring(service.name);
}

/** A class member's body, from its declaration to its closing brace at two spaces. */
function methodBody(text: string, method: string): string | null {
  const lines = text.split('\n');
  const declaration = new RegExp(
    `^ {2}(?:(?:public|private|protected)\\s+)?(?:async\\s+)?${method}\\s*[(<]`,
  );
  const start = lines.findIndex((line) => declaration.test(line));
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line === '  }');
  return lines.slice(start, end + 1).join('\n');
}

/** Every route of every tool: the tool, or one per kind. */
const ROUTES = MCP_TOOLS.flatMap((tool) =>
  routesOf(tool).map(({ label, route }) => ({ tool, label, route })),
);

/** Every service method a tool calls: each route's target, and its join's. */
const TARGETS = [
  ...ROUTES.map(({ label, route }) => ({ label, target: route.target })),
  ...MCP_TOOLS.filter((tool) => tool.join).map((tool) => ({
    label: `${tool.name} join`,
    target: tool.join!.target,
  })),
];

function handlerOf(route: AnyRoute): object {
  return (route.twin.controller.prototype as Record<string, object>)[
    route.twin.handler
  ];
}

function decoration(route: AnyRoute): Record<string, string[]> | undefined {
  return (Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handlerOf(route)) ??
    Reflect.getMetadata(REQUIRE_PERMISSION_KEY, route.twin.controller)) as
    Record<string, string[]> | undefined;
}

function normalized(
  permissions: ToolPermissions | Record<string, string[]>,
): string | Record<string, string[]> {
  if (permissions === ROW_SCOPED) return ROW_SCOPED;
  const entries = Object.entries(permissions as Record<string, string[]>);
  return Object.fromEntries(
    entries
      .map(([resource, actions]): [string, string[]] => [
        resource,
        [...actions].sort(),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** The statement an in-service call enforces, read off its source text. */
function enforcedBy(
  check: string,
): ToolPermissions | Record<string, string[]> | null {
  if (/\.findMember\(ctx\)$/.test(check)) return ROW_SCOPED;
  if (PROJECT_READ_CHECK.test(check)) return ROW_SCOPED;
  const access = /\.(check\w+Access)\(ctx, \w+, '(\w+)'\)$/.exec(check);
  if (access && ACCESS_CHECK_RESOURCE[access[1]]) {
    return { [ACCESS_CHECK_RESOURCE[access[1]]]: [access[2]] };
  }
  const direct = /\.checkPermission\(ctx, \{ (\w+): \[([^\]]*)\] \}\)$/.exec(
    check,
  );
  if (direct) {
    return {
      [direct[1]]: direct[2].split(',').map((a) => a.trim().replace(/'/g, '')),
    };
  }
  return null;
}

describe('MCP_TOOLS', () => {
  it('serves exactly the frozen tool list, which a new tool has to be argued onto', () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(FROZEN_TOOLS);
  });

  it('routes each kind-taking tool by exactly the frozen kinds', () => {
    expect(
      Object.fromEntries(
        MCP_TOOLS.filter((tool) => tool.routes).map((tool) => [
          tool.name,
          Object.keys(tool.routes!).sort(),
        ]),
      ),
    ).toEqual(FROZEN_ROUTES);
  });

  it('names a twin for every route, served by a real route, and holds the no-twin count', () => {
    const noTwin = ROUTES.filter(({ route }) => !route.twin?.controller);
    expect(noTwin.length).toBe(FROZEN_NO_TWIN_COUNT);

    const unserved = ROUTES.filter(
      ({ route }) =>
        !handlerOf(route) || !routeOf(route.twin.controller, handlerOf(route)),
    ).map(
      ({ label, route }) =>
        `${label} → ${route.twin.controller.name}.${route.twin.handler}`,
    );
    expect(unserved).toEqual([]);
  });

  it("declares permissions identical to a decorated twin's @RequirePermission", () => {
    const drifted = ROUTES.filter(({ route }) => decoration(route))
      .filter(
        ({ tool, route }) =>
          JSON.stringify(normalized(tool.permissions)) !==
          JSON.stringify(normalized(decoration(route)!)),
      )
      .map(
        ({ tool, label, route }) =>
          `${label}: ${JSON.stringify(tool.permissions)} ≠ ${JSON.stringify(decoration(route))}`,
      );
    expect(drifted).toEqual([]);
  });

  it('finds an undecorated mutating twin in BASELINE', () => {
    const unlisted = ROUTES.filter(({ route }) => !decoration(route))
      .map((entry) => ({
        entry,
        route: routeOf(entry.route.twin.controller, handlerOf(entry.route))!,
      }))
      .filter(({ route }) => MUTATING.has(route.method))
      .map(({ entry, route }) => {
        const file = fileDeclaring(entry.route.twin.controller.name).file;
        const verb = route.method;
        return `${file} :: ${verb} ${entry.route.twin.handler}`;
      })
      .filter((key) => !(key in BASELINE));
    expect(unlisted).toEqual([]);
  });

  it('names, for an undecorated read twin, the in-service call that enforces exactly the same statement', () => {
    const problems: string[] = [];
    const undecorated = ROUTES.filter(({ route }) => !decoration(route));
    for (const { tool, label, route: declared } of undecorated) {
      const route = routeOf(declared.twin.controller, handlerOf(declared))!;
      if (MUTATING.has(route.method)) continue;
      const enforced = declared.twin.enforcedIn;
      if (!enforced) {
        problems.push(
          `${label}: its twin ${route.method} ${route.path} is undecorated and names no enforcedIn`,
        );
        continue;
      }
      const service = fileDeclaringMethod(
        declared.target.service,
        declared.target.method,
      );
      if (enforced.file !== service.file) {
        problems.push(
          `${label}: enforcedIn names ${enforced.file}, not ${service.file}`,
        );
        continue;
      }
      const body = methodBody(service.text, enforced.method);
      if (!body) {
        problems.push(
          `${label}: ${enforced.file} has no method ${enforced.method}`,
        );
        continue;
      }
      if (!body.includes(enforced.check)) {
        problems.push(
          `${label}: ${enforced.method} no longer calls ${enforced.check}`,
        );
      }
      // The enforcing method is the target, or one the target calls.
      const target = methodBody(service.text, declared.target.method) ?? '';
      if (
        enforced.method !== declared.target.method &&
        !target.includes(`this.${enforced.method}(`)
      ) {
        problems.push(
          `${label}: ${declared.target.method} does not call ${enforced.method}`,
        );
      }
      const statement = enforcedBy(enforced.check);
      if (
        JSON.stringify(statement && normalized(statement)) !==
        JSON.stringify(normalized(tool.permissions))
      ) {
        problems.push(
          `${label}: declares ${JSON.stringify(tool.permissions)} but ${enforced.check} enforces ${JSON.stringify(statement)}`,
        );
      }
      if (
        statement === ROW_SCOPED &&
        !PROJECT_READ_CHECK.test(enforced.check) &&
        !/\baccessed(Projects|Environments|Services)\b/.test(body)
      ) {
        problems.push(`${label}: ${enforced.method} reads no grant column`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('calls a service method that takes ctx: PermissionCtx first, a join included', () => {
    const wrong = TARGETS.filter(({ target }) => {
      const { text } = fileDeclaringMethod(target.service, target.method);
      return !new RegExp(
        `^ {2}(?:override\\s+)?(?:async\\s+)?${target.method}\\(\\s*ctx: PermissionCtx\\b`,
        'm',
      ).test(text);
    }).map(
      ({ label, target }) =>
        `${label} → ${target.service.name}.${target.method}`,
    );
    expect(wrong).toEqual([]);
  });

  it("calls, inside a route's or a join's call, only service methods that take ctx: PermissionCtx first", () => {
    // The target is not the only method a `call` can reach: a second read
    // written inline (`service.a(await service.b(ctx, …))`) bypasses the
    // join and the assertion above. So every method a call invokes on the
    // service it is handed is held to the target's rule.
    const calls = [
      ...ROUTES.map(({ label, route }) => ({
        label,
        service: route.target.service,
        call: route.call as (...args: never[]) => unknown,
      })),
      ...MCP_TOOLS.filter((tool) => tool.join).map((tool) => ({
        label: `${tool.name} join`,
        service: tool.join!.target.service,
        call: tool.join!.call as (...args: never[]) => unknown,
      })),
    ];
    const wrong: string[] = [];
    let seen = 0;
    for (const { label, service, call } of calls) {
      const source = call.toString();
      const param = /^(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/.exec(source)?.[1];
      if (!param)
        throw new Error(`${label}: cannot read its call's parameters`);
      const invoked = new Set(
        [...source.matchAll(new RegExp(`\\b${param}\\.(\\w+)\\(`, 'g'))].map(
          (match) => match[1],
        ),
      );
      for (const method of invoked) {
        seen += 1;
        const { text } = fileDeclaringMethod(service, method);
        if (
          !new RegExp(
            `^ {2}(?:async\\s+)?${method}\\(\\s*ctx: PermissionCtx\\b`,
            'm',
          ).test(text)
        ) {
          wrong.push(`${label} → ${service.name}.${method}`);
        }
      }
    }
    // A reading that found no calls would pass everything. (A call that
    // hands its service to a helper, or indexes it by a verb, is not read
    // here; its target is held by the assertion above.)
    expect(seen).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });

  it("reaches no Uptime check's or Error-rate threshold's write: only the frozen health reads, no mutating health twin, no statement past service:read", () => {
    const inHealth = (name: string) =>
      fileDeclaring(name).file.startsWith('src/service-health/');
    // Every service-health method any tool calls, route or join.
    expect(
      TARGETS.filter(({ target }) => inHealth(target.service.name))
        .map(({ target }) => `${target.service.name}.${target.method}`)
        .filter((at, index, all) => all.indexOf(at) === index)
        .sort(),
    ).toEqual(FROZEN_HEALTH_READS);
    // No twin is a mutating route on a service-health controller.
    expect(
      ROUTES.filter(({ route }) => inHealth(route.twin.controller.name))
        .map(({ label, route }) => ({
          label,
          method: routeOf(route.twin.controller, handlerOf(route))!.method,
        }))
        .filter(({ method }) => MUTATING.has(method)),
    ).toEqual([]);
    // Configuring a check or a threshold is `service: ['update']`.
    expect(
      MCP_TOOLS.filter(
        (tool) =>
          tool.permissions !== ROW_SCOPED &&
          (tool.permissions.service ?? []).some(
            (action: string) => action !== 'read',
          ),
      ).map((tool) => tool.name),
    ).toEqual([]);
  });

  it('holds the ungated count at zero and the row-scoped tools to the frozen list', () => {
    // Ungated: no statement and no in-service row check named — nothing but
    // the key. `ToolRegistry` refuses an undeclared tool at boot; this is the
    // count a reviewer would have to raise on purpose.
    const ungated = ROUTES.filter(
      ({ tool, route }) =>
        tool.permissions === ROW_SCOPED && !route.twin.enforcedIn,
    );
    expect(ungated).toHaveLength(0);
    expect(
      MCP_TOOLS.filter((tool) => tool.permissions === ROW_SCOPED).map(
        (tool) => tool.name,
      ),
    ).toEqual(FROZEN_ROW_SCOPED);
  });
});
