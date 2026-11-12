import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as ts from 'typescript';

/**
 * **Only the instance-mode module reads `HOSTED_MODE`, and nothing reads
 * `IS_CLOUD`** (ADR-0049; census (a) of the hosted-mode spec).
 *
 * Hosted mode used to be `IS_CLOUD`, read in several places, which is how a
 * redeploy could lose it in one and not another. Every hosted rule now asks
 * `InstanceMode` (`backend/src/instance-mode/`), so a new place that reads the
 * setting itself fails here until it asks the module instead.
 *
 * What counts as a read is the name as code, not as prose: an identifier
 * (`process.env.HOSTED_MODE`, a schema key) or a string literal that is exactly
 * the name (`config.get('HOSTED_MODE')`, `process.env['IS_CLOUD']`). Comments
 * may mention either. Test files are not walked: a test *sets* the mode, and
 * `test/utils/hosted-mode.ts` is how an e2e does so.
 */

const repoRoot = join(__dirname, '..', '..', '..');
const SETTINGS = new Set(['HOSTED_MODE', 'IS_CLOUD']);

/** Where the setting may be read: the instance-mode module, and only it. */
const MODULE_DIR = join('backend', 'src', 'instance-mode') + sep;

/** Source trees an Instance runs, and the CLI that talks to one. */
const ROOTS = ['backend/src', 'frontend/src', 'cli/src'];

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      files.push(...walk(path));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(spec|test)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

/** `file:line name` for every read of either setting in one file. */
function readsIn(path: string): string[] {
  const text = readFileSync(path, 'utf8');
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const name =
      ts.isIdentifier(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : undefined;
    if (name !== undefined && SETTINGS.has(name)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${relative(repoRoot, path)}:${line + 1} ${name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const files = ROOTS.flatMap((root) => walk(join(repoRoot, root)));

describe('InstanceMode, as the one reader of HOSTED_MODE and IS_CLOUD', () => {
  it('walks the source trees it claims to', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(
      files.some((file) => relative(repoRoot, file).startsWith(MODULE_DIR)),
    ).toBe(true);
  });

  it('finds no read outside the instance-mode module', () => {
    const outside = files
      .filter((file) => !relative(repoRoot, file).startsWith(MODULE_DIR))
      .flatMap(readsIn);
    expect(outside).toEqual([]);
  });

  it('finds the module reading HOSTED_MODE, so the walk would see one', () => {
    const inside = files
      .filter((file) => relative(repoRoot, file).startsWith(MODULE_DIR))
      .flatMap(readsIn);
    expect(inside.some((read) => read.endsWith(' HOSTED_MODE'))).toBe(true);
  });
});
