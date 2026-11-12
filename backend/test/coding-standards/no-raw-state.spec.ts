import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { MCP_TOOLS } from '../../src/mcp/tools';

/**
 * **No one ever reads a raw Infrastructure state** (ADR-0036 item 3):
 * not an owner, not an Agent, through no route, console view or MCP
 * tool. What an operator sees of a state is the resource list — type, AWS
 * id or Google name, region, tags or labels — that its cloud's projection,
 * `aws/state-resources.ts` or `gcp/state-resources.ts`, makes inside
 * the tofu runner. This census holds the four places a raw state could leak
 * from:
 *
 * 1. **Routes.** Every HTTP route whose path names a state is listed below,
 *    and each is a Rebuild, which discards a state rather than reading it.
 * 2. **MCP tools.** No tool is named for a state.
 * 3. **The table.** OpenTofu's `states` table, which holds every state
 *    whole, is touched only by `InfrastructureStatesService`, which deletes
 *    rows of it and never selects one.
 * 4. **The runner's read.** `tofu show -json` of a state is typed
 *    `TofuStateShow`, and only the runner, which reads it, and the two
 *    projections, which turn it into a list, name that type.
 */

const src = join(__dirname, '..', '..', 'src');

/** Every `.ts` file under `dir`, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

/** `METHOD /prefix/path` of every handler in a controller file. */
function routesOf(text: string): string[] {
  const routes: string[] = [];
  let prefix = '';
  const pattern =
    /@(Controller|Get|Post|Put|Patch|Delete|All)\(\s*(?:'([^']*)')?/g;
  for (const match of text.matchAll(pattern)) {
    const [, decorator, path = ''] = match;
    if (decorator === 'Controller') {
      prefix = path;
      continue;
    }
    const full = ['', prefix, path]
      .filter((part, i) => i === 0 || part)
      .join('/');
    routes.push(`${decorator.toUpperCase()} ${full || '/'}`);
  }
  return routes;
}

/** Routes naming a state, each with why it reads none. */
const STATE_ROUTES: Readonly<Record<string, string>> = {
  'POST /applications/:id/state/rebuild':
    'Rebuild from the cloud: discards an unreadable state',
  'POST /environments/:id/networks/:networkId/state/rebuild':
    'Rebuild from the cloud: discards an unreadable state',
  // An invitation's state (pending, accepted): not an Infrastructure state.
  'GET /organizations/invitations/:id/state': 'an invitation, not a state',
};

describe('tofuStates, as the only place a raw Infrastructure state lives and none leaves', () => {
  const files = walk(src);

  it('has no route that reads or downloads a state', () => {
    const named = files
      .filter((file) => file.endsWith('.controller.ts'))
      .flatMap((file) => routesOf(readFileSync(file, 'utf8')))
      .filter((route) =>
        route
          .split(' ')[1]
          .split('/')
          .some((segment) =>
            /^(?:.*-)?states?(?:-.*)?$|tfstate/i.test(segment),
          ),
      )
      .sort();

    expect(named).toEqual(Object.keys(STATE_ROUTES).sort());
  });

  it('has no MCP tool for a state', () => {
    expect(
      MCP_TOOLS.map((tool) => tool.name).filter((name) => /state/i.test(name)),
    ).toEqual([]);
  });

  it('hands a state as tofu shows it only to a projection', () => {
    const users = files
      .filter((file) => /\bTofuStateShow\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(src, file))
      .sort();

    expect(users).toEqual([
      'cloud-accounts/aws/state-resources.ts',
      'cloud-accounts/gcp/state-resources.ts',
      'cloud-accounts/tofu/state-show.ts',
      'cloud-accounts/tofu/tofu-runner.ts',
    ]);
  });

  it("touches OpenTofu's states table only to delete from it, in one service", () => {
    const users = files
      .filter((file) => /\btofuStates\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(src, file))
      .sort();

    expect(users).toEqual([
      'cloud-accounts/infrastructure-state/infrastructure-state.schema.ts',
      'cloud-accounts/infrastructure-state/infrastructure-states.service.ts',
    ]);
    const service = readFileSync(join(src, users[1]), 'utf8');
    const uses = [...service.matchAll(/\.(\w+)\(tofuStates\)/g)].map(
      (match) => match[1],
    );
    expect(uses.length).toBeGreaterThan(0);
    expect(new Set(uses)).toEqual(new Set(['delete']));
  });
});
