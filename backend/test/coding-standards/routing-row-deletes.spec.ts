import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * **A delete of a row a Server's Traefik file is written from is one change
 * with that file's rewrite** (#1417).
 *
 * The defect was one shape at three sites: `DomainsService.remove`,
 * `RedirectsService.remove` and `SecurityService.remove` each committed the
 * delete and *then* asked `TraefikAppConfigService` to rewrite the Server's
 * file. On a Server that did not answer, the write threw after the row was
 * gone, so the route answered a 500 the operator could not act on, the row was
 * lost, and the file went on routing — for a basic-auth user, went on letting
 * them in. The fix is ADR-0068's: the rewrite reads through the delete's own
 * transaction, so a write that fails rolls the delete back.
 *
 * **Enumerated from the producer.** The tables are the ones the routing
 * writers themselves read — every `.from(<table>)` in a method of
 * `TraefikAppConfigService` that writes through `this.writer` — so a fourth
 * table the emitter learns to interpolate joins this gate without anyone
 * editing it. The sites are every `.delete(<table>)` of those tables in `src`.
 *
 * **What a site must look like.** Its `.delete` is issued on the handle a
 * `.transaction(async (tx) => …)` callback was given, and that callback hands
 * the same handle to another call — the rewrite. That cannot prove the call is
 * the rewrite, which needs a call graph this parser does not have; what it
 * catches is the shape that was wrong, a delete committed on `this.db`.
 *
 * **Both directions.** A site outside the rule fails unless it is in
 * {@link NOT_ROUTED}, and an entry there whose site is gone, or now follows the
 * rule, fails too, so the list cannot become an amnesty.
 */

const backendRoot = join(__dirname, '..', '..');
const srcRoot = join(backendRoot, 'src');
const appConfigPath = join(srcRoot, 'traefik', 'app-config.service.ts');

/**
 * Deletes of a routed table that write no Traefik file at all, by
 * `file :: method`, each with the reason.
 */
const NOT_ROUTED: Record<string, string> = {
  'src/domains/domains.service.ts :: removeCloudDomain':
    'a Domain in a Cloud account has no Traefik file: its removal is its own Cloud run, queued after the row goes (CONTEXT.md "Domain")',
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

const parse = (path: string): ts.SourceFile =>
  ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

const repoPath = (path: string): string =>
  relative(backendRoot, path).split('\\').join('/');

/** Calls `x.<name>(…)` under `node`, in source order. */
function callsNamed(node: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => {
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      child.expression.name.text === name
    ) {
      found.push(child);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * The tables `TraefikAppConfigService`'s file writers read: every
 * `.from(<identifier>)` in a method that calls `this.writer.<anything>`.
 */
function routedTables(): string[] {
  const source = parse(appConfigPath);
  const tables = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isClassDeclaration(node) &&
      node.name?.text === 'TraefikAppConfigService'
    ) {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.body) continue;
        const writes = member.body.getText(source).includes('this.writer.');
        if (!writes) continue;
        for (const call of callsNamed(member.body, 'from')) {
          const [table] = call.arguments;
          if (table && ts.isIdentifier(table)) tables.add(table.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...tables].sort();
}

interface DeleteSite {
  /** `file :: method`, the key {@link NOT_ROUTED} uses. */
  readonly site: string;
  readonly table: string;
  readonly inRewritingTransaction: boolean;
}

/** The name of the method or function a node sits in. */
function enclosingName(node: ts.Node): string {
  for (let at = node.parent; at; at = at.parent) {
    if (
      (ts.isMethodDeclaration(at) || ts.isFunctionDeclaration(at)) &&
      at.name &&
      ts.isIdentifier(at.name)
    ) {
      return at.name.text;
    }
  }
  return '<module>';
}

/**
 * Whether `call` (an `x.delete(…)`) is issued on the handle a
 * `.transaction(cb)` callback received, and that callback passes the handle to
 * some other call.
 */
function inRewritingTransaction(call: ts.CallExpression): boolean {
  const receiver = (call.expression as ts.PropertyAccessExpression).expression;
  if (!ts.isIdentifier(receiver)) return false;
  for (let at = call.parent; at; at = at.parent) {
    if (!ts.isArrowFunction(at) && !ts.isFunctionExpression(at)) continue;
    const [handle] = at.parameters;
    if (!handle || !ts.isIdentifier(handle.name)) continue;
    if (handle.name.text !== receiver.text) continue;
    const opener = at.parent;
    const isTransaction =
      ts.isCallExpression(opener) &&
      ts.isPropertyAccessExpression(opener.expression) &&
      opener.expression.name.text === 'transaction' &&
      opener.arguments[0] === at;
    if (!isTransaction) return false;
    let handedOn = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.arguments.some(
          (argument) =>
            ts.isIdentifier(argument) && argument.text === receiver.text,
        )
      ) {
        handedOn = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(at.body);
    return handedOn;
  }
  return false;
}

function deleteSites(tables: readonly string[]): DeleteSite[] {
  const sites: DeleteSite[] = [];
  for (const path of walk(srcRoot).sort()) {
    const source = parse(path);
    for (const call of callsNamed(source, 'delete')) {
      const [table] = call.arguments;
      if (!table || !ts.isIdentifier(table)) continue;
      if (!tables.includes(table.text)) continue;
      sites.push({
        site: `${repoPath(path)} :: ${enclosingName(call)}`,
        table: table.text,
        inRewritingTransaction: inRewritingTransaction(call),
      });
    }
  }
  return sites;
}

describe('TraefikAppConfigService, and every delete of a row it routes from', () => {
  const tables = routedTables();
  const sites = deleteSites(tables);

  /** A walk that finds nothing passes the two below for the wrong reason. */
  it('finds the routed tables and their deletes at all', () => {
    expect(tables).toEqual(
      expect.arrayContaining(['domain', 'redirect', 'security']),
    );
    expect(sites.length).toBeGreaterThan(0);
  });

  it('rewrites the Server’s file inside the transaction of every delete of a routed row', () => {
    const outside = sites
      .filter((site) => !site.inRewritingTransaction)
      .filter((site) => !(site.site in NOT_ROUTED))
      .map(
        ({ site, table }) =>
          `${site} deletes from \`${table}\` outside a transaction that rewrites the file — a Server that cannot be reached then loses the row behind a 500`,
      );

    expect(outside).toEqual([]);
  });

  it('keeps no exemption whose delete is gone or now follows the rule', () => {
    const stale = Object.keys(NOT_ROUTED).filter(
      (key) =>
        !sites.some(
          (site) => site.site === key && !site.inRewritingTransaction,
        ),
    );

    expect(stale).toEqual([]);
  });
});
