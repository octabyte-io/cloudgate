import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../src/auth/decorators/public.decorator';
import { AuditInterceptor } from '../../src/enterprise/audit-logs/audit.interceptor';
import { AuditLogsModule } from '../../src/enterprise/audit-logs/audit-logs.module';
import {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
} from '../../src/enterprise/audit-logs/audit-log.schema';
import {
  auditTargetFor,
  KIND_BY_SEGMENT,
  NOT_RECORDED_ROUTES,
  ROUTE_OVERRIDES,
  routeKey,
  routeOf,
} from '../../src/enterprise/audit-logs/audit-routes';

/**
 * The trail's vocabulary against its real writers.
 *
 * The console's Kind and Action filters are built from `AUDIT_RESOURCE_TYPES`
 * and `AUDIT_ACTIONS`. Those lists used to name thirty kinds while three were
 * ever written, so twenty-seven filters could never match. This census makes
 * each word earn its place from a writer that exists *now*:
 *
 * - **Routes.** Every controller in `src` is loaded and every mutating handler
 *   is read off the same Nest metadata the router uses, then put through
 *   `auditTargetFor` — the function `AuditInterceptor` calls. What that yields
 *   is what the interceptor writes, not what a list says it writes.
 * - **Services.** A service that writes its own entries is declared below
 *   against the literal it writes, and the file is read to confirm the literal
 *   and the `audit(` call are still there. Conversely every
 *   `resourceType: '<kind>'` literal in a file that calls `auditLogs.audit(` must
 *   be declared, so a new service writer cannot add a kind unnoticed.
 *
 * Then the vocabulary must equal the union, exactly: a word no writer produces
 * (the filter would offer a kind that can never match) and a produced word the
 * vocabulary lacks (the DTO would refuse to filter for it) both fail.
 */

const backendRoot = join(__dirname, '..', '..');

/** Each kind or action a service writes itself, and the files writing it. */
const SERVICE_WRITTEN_KINDS: Readonly<Record<string, readonly string[]>> = {
  // The MCP dispatcher's refusal that names no tool call — an expired key on
  // `initialize` — is a refused connection.
  session: ['src/auth/auth.config.ts', 'src/mcp/mcp-dispatcher.ts'],
  organization: [
    'src/organizations/organizations.service.ts',
    // The 30-day deletion of a lapsed Organization, written as the platform.
    'src/cloud/billing/lapse-clock.service.ts',
    // An Operator's suspend and lift and Enterprise switch,
    // in the target's log and the Instance organization's.
    'src/operator/operator.service.ts',
  ],
  user: [
    'src/organizations/organizations.service.ts',
    'src/users/users.service.ts',
    'src/agents/agents.service.ts',
    // The key a `cloudgate login` mints, and the one it replaces.
    'src/auth/device-login.service.ts',
  ],
  customRole: ['src/enterprise/custom-roles/custom-roles.service.ts'],
  server: [
    'src/enterprise/forward-auth/forward-auth.service.ts',
    'src/settings/request-metrics.service.ts',
    'src/settings/request-logging.service.ts',
  ],
  domain: ['src/enterprise/forward-auth/forward-auth.service.ts'],
  // A Requested preview's create and extend, and the platform's row
  // when an expired one's copy is gone.
  // A cloud Service's Forget, with what is left in AWS, and the clean finish
  // of its Delete, which no request waits on (ADR-0038).
  application: ['src/applications/cloud-delete.ts'],
  // A bucket on AWS's Forget and the clean finish of its Delete.
  bucket: ['src/buckets/cloud-bucket-deletes.service.ts'],
  // A cloud database's Forget and the clean finish of its Delete.
  database: ['src/databases/common/cloud-database-deletes.ts'],
  // The clean finish of a stack on a Stack VM's Delete, which no request
  // waits on (#1367, ADR-0038).
  compose: ['src/compose/stack-vm-deletes.ts'],
  // An Environment's cloud Delete: its Forget, with what is left in AWS, and
  // its clean finish, which no request waits on (ADR-0038).
  environment: ['src/project-config/environment-cloud-deletes.service.ts'],
  previewDeployment: [
    'src/preview-deployments/preview-deployments.service.ts',
    'src/preview-deployments/preview-expiry.service.ts',
  ],
};

/** Actions only a service writes (the routes produce the rest). */
const SERVICE_WRITTEN_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  login: ['src/auth/auth.config.ts', 'src/mcp/mcp-dispatcher.ts'],
  logout: ['src/auth/auth.config.ts'],
  // Every MCP read tool's row. The dispatcher writes it with the
  // action the tool declares, so the literal lives with the declarations.
  read: ['src/mcp/tools/navigation.tools.ts'],
};

/**
 * Actions in the vocabulary a ticket in flight will write, and that nothing
 * writes yet — each with the ticket that owns the writer.
 *
 * Empty since `read` got its writer, after landing ahead of it.
 * An entry here is held narrow: it names its ticket, and it reds the moment an
 * audit-writing file produces the action, because that is when the entry has
 * to move into {@link SERVICE_WRITTEN_ACTIONS} against the file that writes it.
 */
const PENDING_WRITER_ACTIONS: Readonly<Record<string, string>> = {};

interface Route {
  method: string;
  path: string;
  isPublic: boolean;
  where: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

function mutatingRoutes(): Route[] {
  const routes: Route[] = [];
  for (const file of walk(join(backendRoot, 'src'))) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exported = require(file) as Record<string, unknown>;
    for (const value of Object.values(exported)) {
      if (typeof value !== 'function') continue;
      if (!Reflect.hasMetadata('path', value)) continue;
      const proto = (value as { prototype: object }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        // The descriptor, not `proto[name]`: a getter on a controller would
        // run against a prototype with nothing injected.
        const handler: unknown = Object.getOwnPropertyDescriptor(
          proto,
          name,
        )?.value;
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const route = routeOf(value, handler);
        // `ALL` too: an `@All` handler serves every verb, so it can write, and
        // the interceptor never records it (`auditTargetFor` answers null for
        // it). It is here so it has to be named, as the Trace store proxy is
        // rather than slipping past both the interceptor and this list.
        if (
          !route ||
          !['POST', 'PUT', 'PATCH', 'DELETE', 'ALL'].includes(route.method)
        )
          continue;
        routes.push({
          ...route,
          isPublic:
            Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true ||
            Reflect.getMetadata(IS_PUBLIC_KEY, value) === true,
          where: `${relative(backendRoot, file)} :: ${name}`,
        });
      }
    }
  }
  return routes;
}

function read(file: string): string {
  return readFileSync(join(backendRoot, file), 'utf8');
}

/** Every file that writes a row itself, through either door. */
function auditWriterFiles(): string[] {
  return allTs(join(backendRoot, 'src')).filter((file) => {
    const source = readFileSync(file, 'utf8');
    return (
      source.includes('auditLogs.audit(') ||
      source.includes('auditLogs.record(') ||
      source.includes('auditLogs.recordAsPlatform(')
    );
  });
}

/**
 * Every file that writes a row it describes itself: through `audit` for a
 * caller, or `recordAsPlatform` for the platform, which is a service
 * writer with no caller.
 */
function serviceWriterFiles(): string[] {
  return allTs(join(backendRoot, 'src')).filter((file) => {
    const source = readFileSync(file, 'utf8');
    return (
      source.includes('auditLogs.audit(') ||
      source.includes('auditLogs.recordAsPlatform(')
    );
  });
}

function allTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allTs(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('AUDIT_RESOURCE_TYPES', () => {
  // Loading every controller compiles most of `src`.
  jest.setTimeout(120_000);
  let routes: Route[];

  beforeAll(() => {
    routes = mutatingRoutes();
  });

  it('has AuditInterceptor registered app-wide, so what auditTargetFor classifies is written', () => {
    // Everything below proves what the interceptor *would* write; without its
    // APP_INTERCEPTOR registration in a module AppModule imports, it writes
    // nothing and every route kind is again a filter that can never match.
    const providers = (Reflect.getMetadata('providers', AuditLogsModule) ??
      []) as unknown[];
    expect(providers).toContainEqual({
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    });
    // ConfigModule validates process.env the moment app.module is imported, and
    // CI has no backend/.env, so the placeholders go in first and the module is
    // required after them, as test/openapi/openapi.spec.ts does. Only the
    // decorator metadata is read, so placeholders are enough, and `??=` leaves
    // a real backend/.env alone.
    process.env.DATABASE_URL ??= 'postgres://audit:audit@127.0.0.1:1/audit';
    process.env.APP_ENCRYPTION_SECRET ??=
      'test-encryption-secret-at-least-32-chars';
    process.env.BETTER_AUTH_SECRET ??=
      'test-auth-secret-at-least-32-chars-long';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../../src/app.module') as {
      AppModule: new () => unknown;
    };
    expect(Reflect.getMetadata('imports', AppModule)).toContain(
      AuditLogsModule,
    );
  });

  it('finds the routes it censuses', () => {
    // A walk that silently found nothing would pass everything below.
    expect(routes.length).toBeGreaterThan(250);
  });

  it('classifies every signed-in mutating route as recorded or named as not recorded', () => {
    const unclassified = routes
      .filter((route) => !route.isPublic)
      .filter(
        (route) =>
          auditTargetFor(route.method, route.path) === null &&
          !(routeKey(route.method, route.path) in NOT_RECORDED_ROUTES),
      )
      .map((route) => `${routeKey(route.method, route.path)} (${route.where})`);
    expect(unclassified).toEqual([]);
  });

  it('names no route as not recorded or overridden that no controller serves', () => {
    const served = new Set(
      routes.map((route) => routeKey(route.method, route.path)),
    );
    expect(
      [
        ...Object.keys(NOT_RECORDED_ROUTES),
        ...Object.keys(ROUTE_OVERRIDES),
      ].filter((key) => !served.has(key)),
    ).toEqual([]);
  });

  it('keeps no kind for a path segment no recorded route starts with', () => {
    const used = new Set(
      routes
        .filter((route) => auditTargetFor(route.method, route.path))
        .map((route) => route.path.split('/').filter(Boolean)[0]),
    );
    expect(
      Object.keys(KIND_BY_SEGMENT).filter((segment) => !used.has(segment)),
    ).toEqual([]);
  });

  it('leaves each route named as service-written with a service that still writes', () => {
    const gone = Object.entries(NOT_RECORDED_ROUTES)
      .filter(([, why]) => 'service' in why)
      .map(([key, why]) => [key, (why as { service: string }).service])
      .filter(([, file]) => !read(file).includes('auditLogs.audit('));
    expect(gone).toEqual([]);
  });

  it('finds each declared service-written kind in the file declared to write it', () => {
    const missing = Object.entries(SERVICE_WRITTEN_KINDS).flatMap(
      ([kind, files]) =>
        files
          .filter((file) => !read(file).includes(`resourceType: '${kind}'`))
          .map((file) => `${kind} in ${file}`),
    );
    expect(missing).toEqual([]);
  });

  it('declares every kind a service writes', () => {
    const undeclared = serviceWriterFiles().flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/resourceType: '(\w+)'/g)]
        .map((match) => match[1])
        .filter(
          (kind) =>
            !(SERVICE_WRITTEN_KINDS[kind] ?? []).includes(
              relative(backendRoot, file),
            ),
        )
        .map((kind) => `${kind} in ${relative(backendRoot, file)}`),
    );
    expect(undeclared).toEqual([]);
  });

  it('offers exactly the kinds a route or a service writes', () => {
    const written = new Set<string>(Object.keys(SERVICE_WRITTEN_KINDS));
    for (const route of routes) {
      if (route.isPublic) continue;
      const target = auditTargetFor(route.method, route.path);
      if (target) written.add(target.resourceType);
    }
    expect([...AUDIT_RESOURCE_TYPES].sort()).toEqual([...written].sort());
  });

  it('offers exactly the actions a route or a service writes', () => {
    const missing = Object.entries(SERVICE_WRITTEN_ACTIONS).flatMap(
      ([action, files]) =>
        files
          .filter((file) => !read(file).includes(`'${action}'`))
          .map((file) => `${action} in ${file}`),
    );
    expect(missing).toEqual([]);

    const written = new Set<string>(Object.keys(SERVICE_WRITTEN_ACTIONS));
    for (const route of routes) {
      if (route.isPublic) continue;
      const target = auditTargetFor(route.method, route.path);
      if (target) written.add(target.action);
    }
    // A pending action is not written yet, and one that is written is not
    // pending: the next test holds the second half.
    expect(
      Object.keys(PENDING_WRITER_ACTIONS).filter((action) =>
        written.has(action),
      ),
    ).toEqual([]);
    // Every service writer's create/update/delete is also a route action, so
    // those three need no declaration of their own.
    expect([...AUDIT_ACTIONS].sort()).toEqual(
      [...written, ...Object.keys(PENDING_WRITER_ACTIONS)].sort(),
    );
  });

  it('keeps an action pending only until a file writes it, and names the ticket that will', () => {
    expect(
      Object.entries(PENDING_WRITER_ACTIONS)
        .filter(([, ticket]) => !/^#\d+$/.test(ticket))
        .map(([action]) => action),
    ).toEqual([]);

    // `action: 'read'` as a value, not the `action: 'read' | …` parameter
    // types half the services declare.
    const writing = auditWriterFiles().flatMap((file) =>
      Object.keys(PENDING_WRITER_ACTIONS)
        .filter((action) =>
          new RegExp(`action: '${action}'(?!\\s*\\|)`).test(
            readFileSync(file, 'utf8'),
          ),
        )
        .map(
          (action) =>
            `${action} in ${relative(backendRoot, file)} — move it to SERVICE_WRITTEN_ACTIONS`,
        ),
    );
    expect(writing).toEqual([]);
  });
});
