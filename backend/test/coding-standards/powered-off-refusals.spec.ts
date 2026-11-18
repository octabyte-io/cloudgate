import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * **Everything that refuses a Server in maintenance refuses a powered-off
 * Bought Server too.**
 *
 * A Bought Server an Operator powered off (#1401) keeps its stage, so an
 * action that asked only about maintenance went on to its machine over SSH
 * and failed there with a 500: a rollback, a Compose Start or restart, an
 * Application Start or reload, a database Start or rebuild, a container's
 * start or restart, a Cron service's Run now, a drop upload and a preview.
 * The deploy paths were fixed first (#115) by `deployRefusal`, and these were
 * the same missing question one step further on.
 *
 * Maintenance's refusal is the producer here: `refuseWhileInMaintenance` and
 * `maintenanceRefusal` are called exactly where something is about to start
 * or run on a Server (spec #1420, CONTEXT.md "Maintenance"), which is exactly
 * where a powered-off machine would be reached. So every function in `src`
 * that calls one of them, found off the AST, must also call a power-off
 * refusal: `refuseWhilePoweredOff`, or the deploy paths'
 * `refuseDeployUntilReady` / `deployRefusal`, which hold back a powered-off
 * Bought Server as well as one not Ready.
 *
 * `EXEMPT` names a function that does not, with why; an entry whose function
 * no longer refuses maintenance, or now refuses power-off itself, fails too.
 *
 * ### Falsified
 *
 * Run before the fix, it named the twelve functions `powered-off.e2e-spec.ts`
 * drives: `rollback`, the Compose `start` and `restart`, the Application
 * `start`, `reload` and `findDropTarget`, the database `start` and `rebuild`,
 * `runNow`, `containerOp`, and the preview `redeployOwned` and
 * `admitRequestedCreate`.
 */

const backendRoot = join(__dirname, '..', '..');
const srcRoot = join(backendRoot, 'src');

const MAINTENANCE = new Set(['refuseWhileInMaintenance', 'maintenanceRefusal']);
const POWER_OFF = new Set([
  'refuseWhilePoweredOff',
  'refuseDeployUntilReady',
  'deployRefusal',
]);

/**
 * Functions that refuse maintenance and not power-off, each with why. Keyed
 * `<file from backend/>#<function>`.
 */
const EXEMPT: Record<string, string> = {
  'src/deployments/deployments.service.ts#deployOnGithubPush':
    "a push's build is a deploy: it is queued, and `refuseServerClaim`'s `deployRefusal` ends it at the claim with the power-off refusal",
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

const repoPath = (path: string): string =>
  relative(backendRoot, path).split('\\').join('/');

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;

/** A function's name: its own, or the variable or property it is bound to. */
function nameOf(fn: FunctionLike, source: ts.SourceFile): string {
  if (fn.name) return fn.name.getText(source);
  const parent = fn.parent;
  if (
    (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
    parent.name
  ) {
    return parent.name.getText(source);
  }
  return `<anonymous:${source.getLineAndCharacterOfPosition(fn.getStart(source)).line + 1}>`;
}

/** The bare callee name of a call: `f(…)` and `this.x.f(…)` both give `f`. */
function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

interface Site {
  /** `<file>#<function>`, from `backend/`. */
  readonly key: string;
  readonly refusesMaintenance: boolean;
  readonly refusesPowerOff: boolean;
}

/**
 * Each named function in the text, outermost named one taking in the
 * callbacks inside it, with whether it calls a maintenance refusal and
 * whether a power-off one.
 */
function scan(file: string, text: string): Site[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites = new Map<
    string,
    { refusesMaintenance: boolean; refusesPowerOff: boolean }
  >();
  const visit = (node: ts.Node, owner: string | null): void => {
    let here = owner;
    if (
      owner === null &&
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node))
    ) {
      here = `${file}#${nameOf(node, source)}`;
      // Two functions of one name in a file are told apart by line, so one
      // that asks never covers one that does not.
      if (sites.has(here)) {
        here += `:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
      }
      sites.set(here, { refusesMaintenance: false, refusesPowerOff: false });
    }
    if (here !== null && ts.isCallExpression(node)) {
      const name = calleeName(node);
      const site = sites.get(here)!;
      if (name && MAINTENANCE.has(name)) site.refusesMaintenance = true;
      if (name && POWER_OFF.has(name)) site.refusesPowerOff = true;
    }
    ts.forEachChild(node, (child) => visit(child, here));
  };
  visit(source, null);
  return [...sites].map(([key, facts]) => ({ key, ...facts }));
}

/** Every function in `src` outside the two refusals' own files. */
const OWN_FILES = new Set([
  'src/servers/server-maintenance.ts',
  'src/bought-servers/server-readiness.ts',
]);
const sites = walk(srcRoot)
  .map(repoPath)
  .filter((file) => !OWN_FILES.has(file))
  .flatMap((file) => scan(file, readFileSync(join(backendRoot, file), 'utf8')));
const refusingMaintenance = sites.filter((site) => site.refusesMaintenance);

describe('refuseWhilePoweredOff, beside every maintenance refusal', () => {
  it('every function that refuses a Server in maintenance refuses a powered-off Bought Server', () => {
    expect(
      refusingMaintenance
        .filter((site) => !site.refusesPowerOff && !(site.key in EXEMPT))
        .map((site) => site.key),
    ).toEqual([]);
  });

  it('every exemption still refuses maintenance and still does not refuse power-off', () => {
    for (const key of Object.keys(EXEMPT)) {
      expect({
        key,
        site: refusingMaintenance.find((site) => site.key === key) ?? null,
      }).toEqual({
        key,
        site: { key, refusesMaintenance: true, refusesPowerOff: false },
      });
    }
  });

  /** The gate on the gate: the walk finds the sites it exists for. */
  it('finds the known maintenance refusals', () => {
    expect(refusingMaintenance.map((site) => site.key)).toEqual(
      expect.arrayContaining([
        'src/rollbacks/rollbacks.service.ts#rollback',
        'src/compose/compose.service.ts#restart',
        'src/docker-ops/docker-ops.service.ts#containerOp',
        'src/cron-services/cron-runs.service.ts#runNow',
        'src/databases/common/database-service.ts#start',
        'src/deployments/deployments.service.ts#queueBuild',
      ]),
    );
  });

  it('tells a function that asks both from one that asks only maintenance', () => {
    expect(
      scan(
        'a.ts',
        [
          'class A {',
          '  async both() { await refuseWhilePoweredOff(db, [id], "x"); await refuseWhileInMaintenance(db, [id]); }',
          '  async one() { await refuseWhileInMaintenance(db, [id]); }',
          '}',
          '// refuseWhileInMaintenance(db, [id]) in a comment counts for nothing',
          'const deploy = async () => { await refuseDeployUntilReady(db, [id]); await this.x.maintenanceRefusal(db, [id]); };',
        ].join('\n'),
      ),
    ).toEqual([
      { key: 'a.ts#both', refusesMaintenance: true, refusesPowerOff: true },
      { key: 'a.ts#one', refusesMaintenance: true, refusesPowerOff: false },
      { key: 'a.ts#deploy', refusesMaintenance: true, refusesPowerOff: true },
    ]);
  });
});
