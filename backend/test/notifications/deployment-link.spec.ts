import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../src/common/config/env.schema';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { DeploymentNotification } from '../../src/deployment-engine/ports/deployment-notifier';
import type { NotificationDispatcherService } from '../../src/notifications/dispatcher.service';
import { DeploymentNotifierAdapter } from '../../src/notifications/deployment-notifier.adapter';
import { InstanceUrlService } from '../../src/settings/instance-url.service';

/**
 * **A deploy notification's link opens the Deployment.**
 *
 * It was wrong twice on every install that had not assigned a console domain,
 * and either half alone made it useless:
 *
 * - the origin was `http://<serverIp>:${PORT}`, and `PORT` is *this process's*
 *   listener — so the link pointed at the API, which answered it with its own
 *   404 JSON;
 * - the path was
 *   `/dashboard/project/:p/environment/:e/services/:type/:id?tab=deployments`,
 *   which the console has never served, so substituting the right port by hand
 *   only moved the operator from the API's 404 to the console's not-found page.
 *
 * **The path is asserted against the console's own route tables, not against a
 * second copy of the string.** That is the whole point of this file and what
 * the ticket asked for: a test that pins `…/applications/:id/deployments` as a
 * literal would have passed just as happily on the `/dashboard/project/…` form
 * it was written beside, because nothing in `backend/` knows what the console
 * serves. So the two facts are read off `frontend/src` — which first segment
 * opens which scope (`components/shell/scope.ts`'s `RESOURCE_SEGMENT`, the map
 * `scopeFromPath` reads) and which tab slugs a scope declares
 * (`lib/shell/tabs/*.ts`, the tables the route's own `tabScreen` check reads) —
 * and a link naming anything else fails here rather than in an operator's
 * browser. Same argument, and the same compiler-API reading, as
 * `coding-standards/teardown-report-is-rendered.spec.ts`.
 *
 * What this deliberately does not assert: that the Deployments panel renders
 * anything in particular. That is the console's own suite. This holds the one
 * thing neither side can check alone — that the address the backend mails out
 * is an address the console answers.
 */

const repoRoot = join(__dirname, '..', '..', '..');
const consoleSrc = join(repoRoot, 'frontend', 'src');

const parse = (path: string): ts.SourceFile =>
  ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

/** `const <name> = <expr>`, unwrapped of a trailing `as const satisfies …`. */
function initializerOf(source: ts.SourceFile, name: string): ts.Expression {
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
      ? unwrap(node.expression)
      : node;

  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = unwrap(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`no const ${name} in ${source.fileName}`);
  return found;
}

const keyOf = (property: ts.PropertyAssignment): string =>
  ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
    ? property.name.text
    : '';

function literalProps(
  object: ts.ObjectLiteralExpression,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const value = property.initializer;
    if (ts.isStringLiteral(value)) out[keyOf(property)] = value.text;
    if (ts.isNumericLiteral(value)) out[keyOf(property)] = Number(value.text);
  }
  return out;
}

/**
 * First path segment → the scope it opens and how many segments name the
 * resource, exactly as the console's `scopeFromPath` reads it.
 */
const RESOURCE_SEGMENTS: Record<string, { kind: string; depth: number }> =
  (() => {
    const source = parse(join(consoleSrc, 'components', 'shell', 'scope.ts'));
    const object = initializerOf(source, 'RESOURCE_SEGMENT');
    if (!ts.isObjectLiteralExpression(object))
      throw new Error('RESOURCE_SEGMENT is not an object literal');

    const out: Record<string, { kind: string; depth: number }> = {};
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      if (!ts.isObjectLiteralExpression(property.initializer)) continue;
      const { kind, depth } = literalProps(property.initializer);
      out[keyOf(property)] = { kind: String(kind), depth: Number(depth) };
    }
    return out;
  })();

/** The tab slugs, by label, a scope declares — a slug it does not have 404s. */
function declaredTabs(kind: string): Record<string, string> {
  const source = parse(join(consoleSrc, 'lib', 'shell', 'tabs', `${kind}.ts`));
  const table = initializerOf(source, `${kind.toUpperCase()}_TABS`);
  if (!ts.isArrayLiteralExpression(table))
    throw new Error(`${kind.toUpperCase()}_TABS is not an array literal`);

  const out: Record<string, string> = {};
  for (const entry of table.elements) {
    if (!ts.isObjectLiteralExpression(entry)) continue;
    const { slug, label } = literalProps(entry);
    out[String(label)] = String(slug);
  }
  return out;
}

/** What the console resolves a pathname to, or null for one it does not serve. */
function consoleRoute(
  pathname: string,
): { kind: string; id: string; tab: string } | null {
  const segments = pathname.split('/').filter(Boolean);
  const entry = RESOURCE_SEGMENTS[segments[0] ?? ''];
  if (!entry || segments.length < 1 + entry.depth) return null;
  const { kind, depth } = entry;
  const tab = segments.slice(1 + depth).join('/');
  if (!Object.values(declaredTabs(kind)).includes(tab)) return null;
  return { kind, id: segments[depth], tab };
}

type Settings = {
  host: string | null;
  https: boolean;
  serverIp: string | null;
};

/** The default install in the ticket: an IP, no console domain assigned. */
const DEFAULT_INSTALL: Settings = {
  host: null,
  https: false,
  serverIp: '203.0.113.42',
};

/**
 * The environment `deploy/install.sh` writes: the API's own `PORT`, and
 * `BETTER_AUTH_URL` naming the console's origin. It writes no `CONSOLE_PORT`,
 * which is why that key is absent here rather than set to 3000.
 */
const INSTALLED_ENV: Record<string, unknown> = {
  PORT: 4000,
  BETTER_AUTH_URL: 'http://203.0.113.42:3000',
};

const notification: DeploymentNotification = {
  projectName: 'ui-main',
  applicationName: 'ui-whoami',
  applicationType: 'application',
  environmentName: 'production',
  organizationId: 'org-1',
  projectId: 'xPGnIItsFHEKBAQuzp_VS',
  environmentId: 'gvPjILtTCqwlZ-dIfwa_e',
  serviceId: 'Ms5cBf9qWg5K9ptAFt--7',
};

/** No Service under test here has a domain; another spec owns that field. */
const noDomains = {
  select: () => ({
    from: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }),
  }),
} as unknown as DrizzleDB;

function makeNotifier(
  settings: Settings | null,
  env: Record<string, unknown> = INSTALLED_ENV,
) {
  const instanceUrl = new InstanceUrlService(
    {
      query: {
        webServerSettings: {
          findFirst: () => Promise.resolve(settings ?? undefined),
        },
      },
    } as unknown as DrizzleDB,
    { get: (key: string) => env[key] } as unknown as ConfigService<Env, true>,
  );
  const dispatch = jest.fn().mockResolvedValue(undefined);
  const notifier = new DeploymentNotifierAdapter(
    noDomains,
    { dispatch } as unknown as NotificationDispatcherService,
    instanceUrl,
  );
  return { notifier, dispatch };
}

async function linkFor(
  overrides: Partial<DeploymentNotification> = {},
  settings: Settings | null = DEFAULT_INSTALL,
  env: Record<string, unknown> = INSTALLED_ENV,
): Promise<string | undefined> {
  const { notifier, dispatch } = makeNotifier(settings, env);
  await notifier.buildSuccess({ ...notification, ...overrides });
  const [, event] = dispatch.mock.calls[0] as [string, { buildLink?: string }];
  return event.buildLink;
}

describe('frontend/src/components/shell/scope.ts — the table this file reads', () => {
  // If these ever come back empty the assertions below would pass vacuously,
  // which is the one way a census can lie. Read the tables, then check them.
  it('names the segments and the Deployments tab the notifier links to', () => {
    expect(RESOURCE_SEGMENTS.applications).toEqual({
      kind: 'application',
      depth: 1,
    });
    expect(RESOURCE_SEGMENTS.compose).toEqual({ kind: 'compose', depth: 1 });
    expect(declaredTabs('application').Deployments).toBe('deployments');
    expect(declaredTabs('compose').Deployments).toBe('deployments');
  });

  it('refuses the shape the notification used to carry', () => {
    expect(
      consoleRoute(
        '/dashboard/project/xPGnIItsFHEKBAQuzp_VS/environment/gvPjILtTCqwlZ-dIfwa_e/services/application/Ms5cBf9qWg5K9ptAFt--7',
      ),
    ).toBeNull();
  });
});

describe('DeploymentNotifierAdapter.buildSuccess, on the buildLink it carries', () => {
  it('opens the Deployment on the console, not on this process, on a default install', async () => {
    const link = await linkFor();

    expect(link).toBe(
      'http://203.0.113.42:3000/applications/Ms5cBf9qWg5K9ptAFt--7/deployments',
    );
    // The two halves of the defect, named so a partial regression is legible:
    // the API's listener, and a path nothing serves.
    expect(link).not.toContain(':4000');
    expect(link).not.toContain('/dashboard/');
  });

  it.each(['application', 'compose'])(
    'builds a %s link the console actually serves',
    async (applicationType) => {
      const link = await linkFor({ applicationType });
      const url = new URL(link as string);

      // A query string was how the old link named the tab. The console's tab
      // is a path segment, so anything left here is a tab nobody opens.
      expect(url.search).toBe('');

      const route = consoleRoute(url.pathname);
      expect(route).not.toBeNull();
      expect(route).toEqual({
        kind: applicationType,
        id: notification.serviceId,
        tab: declaredTabs(applicationType).Deployments,
      });
    },
  );

  it('uses the console domain once one is assigned on /settings/instance', async () => {
    const link = await linkFor(
      {},
      {
        host: 'panel.example.com',
        https: true,
        serverIp: '203.0.113.42',
      },
    );

    expect(link).toBe(
      'https://panel.example.com/applications/Ms5cBf9qWg5K9ptAFt--7/deployments',
    );
  });

  it('honours an explicit CONSOLE_PORT over the origin BETTER_AUTH_URL names', async () => {
    const link = await linkFor({}, DEFAULT_INSTALL, {
      ...INSTALLED_ENV,
      CONSOLE_PORT: 3100,
    });

    expect(link).toBe(
      'http://203.0.113.42:3100/applications/Ms5cBf9qWg5K9ptAFt--7/deployments',
    );
  });

  it("falls back to the install script's own console port when nothing names one", async () => {
    const link = await linkFor({}, DEFAULT_INSTALL, { PORT: 4000 });

    expect(link).toBe(
      'http://203.0.113.42:3000/applications/Ms5cBf9qWg5K9ptAFt--7/deployments',
    );
  });

  it('omits the link entirely for a service type the console has no scope for', async () => {
    // Not defensiveness for its own sake: a guessed segment is exactly the
    // mistake this ticket is about, and no link says "open the console" while
    // a wrong one costs a sign-in to learn nothing.
    expect(await linkFor({ applicationType: 'database' })).toBeUndefined();
  });

  it('omits the link while neither a console domain nor a server IP is configured', async () => {
    expect(
      await linkFor({}, { host: null, https: false, serverIp: null }),
    ).toBe(undefined);
    // `web_server_settings` empty altogether — a box that has not finished
    // its own setup, which is the case the service's null return exists for.
    expect(await linkFor({}, null)).toBeUndefined();
  });
});
