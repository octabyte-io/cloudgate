import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

import { cloudKindEnum } from '../../src/cloud-accounts/cloud-account.schema';

/**
 * **No per-cloud comparison outside the cloud seam** (ADR-0043).
 *
 * The defect this exists for: code that asked `cloud === 'gcp'` and treated
 * every other answer as AWS. There were 62 such comparisons in 27 files when
 * this gate was written. A third cloud, or a change to one cloud's flow, meant
 * finding every one of them, and the one missed fell through to the other
 * cloud's behaviour without a word.
 *
 * The seam is `src/cloud-accounts/cloud-provider.ts`: `onCloud` and
 * `byCloud` choose a cloud's half from a table that names every cloud, so a
 * new cloud is a type error at each site, and the clouds' own code lives in
 * `cloud-accounts/aws/**` and `cloud-accounts/gcp/**`. Those three places are
 * the only ones allowed to compare with a cloud's name.
 *
 * **What is counted**, in `src` (specs excluded):
 *
 * - every `===`, `!==`, `==` or `!=` with a string literal naming a cloud on
 *   either side, and every `case` naming one;
 * - every default to a cloud: `x ?? 'aws'`, or a `CloudKind` parameter that
 *   defaults to a cloud's name. A cloud that is not known is read by the
 *   seam's one rule, `cloudOrLegacy`, which says why it is AWS;
 * - every table keyed by the clouds whose values are all `true` or `false`
 *   (`byCloud(cloud, { aws: false, gcp: true })`), which rebuilds "this
 *   cloud, else that one" behind the seam's back: a cloud's table holds what
 *   that cloud does or is, not whether it is the one;
 * - every comparison with a string that one of the file's cloud tables
 *   answers (`instance === 'cloud-sql'`), a stand-in for a cloud's name.
 *
 * The clouds are read from `cloud_kind` itself (`cloudKindEnum`), not listed
 * here, so a cloud added to the enum is counted from the commit that adds it.
 *
 * **None is left outside the seam.** The 62 were moved one area per commit
 * behind a baseline by file that could only shrink; its last commit emptied
 * it, and the baseline went with it. A comparison added anywhere outside the
 * seam now fails, naming its file, line and source.
 */

const backendRoot = join(__dirname, '..', '..');
const srcRoot = join(backendRoot, 'src');

/** The cloud seam and the clouds' own folders, which may compare with a cloud's name. */
const SEAM = [
  /^src\/cloud-accounts\/cloud-provider\.ts$/,
  /^src\/cloud-accounts\/aws\//,
  /^src\/cloud-accounts\/gcp\//,
];

/** Every non-spec `.ts` file under `dir`, recursively. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) {
      found.push(path);
    }
  }
  return found;
}

const repoPath = (path: string): string =>
  relative(backendRoot, path).split('\\').join('/');

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** Each comparison with, or default to, a cloud's name in `text`, as `line: source`. */
export function cloudComparisons(
  path: string,
  text: string,
  clouds: readonly string[],
): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const names = (node: ts.Node): boolean =>
    ts.isStringLiteralLike(node) && clouds.includes(node.text);
  const found: string[] = [];
  const at = (node: ts.Node): string =>
    `${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.getText().split('\n')[0]}`;
  // A table keyed by exactly the clouds: `byCloud`'s, or a `PerCloud` one.
  const cloudTable = (node: ts.Node): node is ts.ObjectLiteralExpression => {
    if (!ts.isObjectLiteralExpression(node)) return false;
    const keys = node.properties.map((property) =>
      property.name &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        ? property.name.text
        : null,
    );
    return (
      keys.length === clouds.length &&
      clouds.every((cloud) => keys.includes(cloud))
    );
  };
  // The string values of the file's cloud tables, which stand in for a cloud
  // when compared with (`instance === 'cloud-sql'`).
  const proxies = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (cloudTable(node)) {
      for (const property of node.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isStringLiteralLike(property.initializer)
        ) {
          proxies.add(property.initializer.text);
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const isProxy = (node: ts.Node): boolean =>
    ts.isStringLiteralLike(node) && proxies.has(node.text);
  const visit = (node: ts.Node): void => {
    // A table that answers only true or false rebuilds "this cloud, else
    // that one": its table should hold what each cloud does.
    if (
      cloudTable(node) &&
      node.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) &&
          (property.initializer.kind === ts.SyntaxKind.TrueKeyword ||
            property.initializer.kind === ts.SyntaxKind.FalseKeyword),
      )
    ) {
      found.push(at(node));
    }
    if (
      ts.isBinaryExpression(node) &&
      EQUALITY.has(node.operatorToken.kind) &&
      (isProxy(node.left) || isProxy(node.right))
    ) {
      found.push(at(node));
    }
    const hit =
      (ts.isBinaryExpression(node) &&
        EQUALITY.has(node.operatorToken.kind) &&
        (names(node.left) || names(node.right))) ||
      (ts.isCaseClause(node) && names(node.expression)) ||
      // A default to a cloud, rather than the seam's named rule for one.
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        names(node.right)) ||
      (ts.isParameter(node) &&
        node.type?.getText() === 'CloudKind' &&
        node.initializer !== undefined &&
        names(node.initializer));
    if (hit) found.push(at(node));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('onCloud and byCloud, as the only place a cloud is told apart', () => {
  const clouds = cloudKindEnum.enumValues;
  const census: Record<string, string[]> = {};
  for (const path of walk(srcRoot)) {
    const file = repoPath(path);
    if (SEAM.some((allowed) => allowed.test(file))) continue;
    const found = cloudComparisons(path, readFileSync(path, 'utf8'), clouds);
    if (found.length > 0) census[file] = found;
  }

  it('reads the clouds from cloud_kind', () => {
    expect(clouds).toEqual(expect.arrayContaining(['aws', 'gcp']));
  });

  it('counts a comparison, a reversed one, a loose one and a case', () => {
    const sample = [
      "if (row.cloud === 'gcp') {}",
      "if ('aws' !== cloud) {}",
      "if (cloud == 'gcp') {}",
      "switch (cloud) { case 'aws': break; }",
      "const unrelated = kind === 'google';",
    ].join('\n');
    expect(cloudComparisons('sample.ts', sample, clouds)).toHaveLength(4);
  });

  it('counts a bare default to a cloud, and not the named rule', () => {
    const sample = [
      "const cloud = row?.cloud ?? 'aws';",
      "function f(cloud: CloudKind = 'aws') {}",
      'const named = cloudOrLegacy(row?.cloud);',
      'function g(cloud: CloudKind = LEGACY_CLOUD) {}',
      "function h(provider: StateProvider = 'aws') {}",
    ].join('\n');
    expect(cloudComparisons('sample.ts', sample, clouds)).toEqual([
      "1: row?.cloud ?? 'aws'",
      "2: cloud: CloudKind = 'aws'",
    ]);
  });

  it('counts a table of true and false, and a comparison with a stand-in for a cloud', () => {
    const sample = [
      'const onGoogle = byCloud(cloud, { aws: false, gcp: true });',
      "const kind = byCloud(cloud, { aws: 'rds', gcp: 'cloud-sql' } as const);",
      "if (kind === 'cloud-sql') {}",
      'const facts = byCloud(cloud, { aws: { x: false }, gcp: { x: true } });',
      "const named = byCloud(cloud, { aws: 'AWS', gcp: 'Google Cloud' });",
      'const unrelated = { aws: false, google: true, azure: true };',
    ].join('\n');
    expect(cloudComparisons('sample.ts', sample, clouds)).toEqual([
      '1: { aws: false, gcp: true }',
      "3: kind === 'cloud-sql'",
    ]);
  });

  it('finds the seam where it allows comparisons', () => {
    // A move or rename of the seam must fail here, not widen what is allowed.
    const files = walk(srcRoot).map(repoPath);
    for (const allowed of SEAM) {
      expect(files.some((file) => allowed.test(file))).toBe(true);
    }
  });

  it('finds no comparison outside the seam', () => {
    // On a failure: each file, with every comparison in it by line.
    expect(census).toEqual({});
  });
});
