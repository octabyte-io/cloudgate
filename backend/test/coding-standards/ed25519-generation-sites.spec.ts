import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as ts from 'typescript';

/**
 * ssh2 1.17's `utils.generateKeyPairSync('ed25519')` strips the leading zero
 * bytes off the 32-byte public key, so about one pair in 256 is malformed in
 * both halves. It was called at two production sites and five test fixtures,
 * each one flaky the same way. Every ed25519 pair is now made by
 * `generateEd25519KeyPair`, so the one `generateKeyPair[Sync]('ed25519', …)`
 * call in `src/` or `test/` is `node:crypto`'s, inside that helper: a second
 * fails here, and so does the helper's own call going away.
 *
 * Calls are read off the TS AST — any callee named `generateKeyPair` or
 * `generateKeyPairSync`, bare or as a property, whose first argument is the
 * string `ed25519` — so a comment that names the call is not a site.
 */
const BACKEND = resolve(__dirname, '../..');
const ROOTS = ['src', 'test'].map((dir) => join(BACKEND, dir));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

const GENERATORS = new Set(['generateKeyPair', 'generateKeyPairSync']);

/** The file, once per ed25519 generation call in it. */
function ed25519Calls(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined;
      const [first] = node.arguments;
      if (
        name !== undefined &&
        GENERATORS.has(name) &&
        first !== undefined &&
        ts.isStringLiteralLike(first) &&
        first.text.toLowerCase() === 'ed25519'
      ) {
        found.push(relative(BACKEND, file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('generateEd25519KeyPair', () => {
  it('is the only place an ed25519 key pair is generated', () => {
    const sites = ROOTS.flatMap(sourceFiles).flatMap(ed25519Calls);

    expect(sites).toEqual(['src/ssh-keys/ed25519-key-pair.ts']);
  });
});
