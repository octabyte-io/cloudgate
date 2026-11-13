import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * The backend half of removing repository links. The property, stated once:
 *
 * > no string in `src/` names this project's repository
 *
 * **What broke.** The ntfy channel's "Send a test" delivered an action button,
 * "visit Cloudgate on Github", pointing at `github.com/octabyte-io/cloudgate`:
 * an advert in an operator's own alert, which is not where it belongs. The
 * console half of the same ticket is four sentences that each stated
 * a gap and linked the issue that tracked it — every one closed, so every
 * sentence was false and every link dead to a self-hosting operator. That half
 * is `frontend/src/features/no-tracker-links.test.ts`; this one covers what
 * Cloudgate *sends* rather than renders — a notification payload, an error
 * message, a generated script — because a grep of the console alone would
 * have missed the ntfy site.
 *
 * **Strings, not comments.** A code comment citing an issue is how this tree
 * records why, and nothing reads it but a developer with access; so the walk is
 * over the AST's string-shaped nodes (literals and template parts), where a
 * comment is not a node at all.
 *
 * The last `describe` is the gate on the gate: an empty list is this spec's
 * passing state, so the detector is run against synthetic sources that must
 * each be reported, and the walk is held to a floor.
 */

const backendRoot = join(__dirname, '..', '..');
const srcRoot = join(backendRoot, 'src');

/** The project's repository, and every URL under it (issues, pulls, blobs). */
const REPOSITORY = /github\.com\/octabyte-io\/cloudgate\b/i;

/** Every `.ts` file under `dir`, recursively. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found.sort();
}

/** `file:line :: text` for every string-shaped node in `text` naming the repository. */
function linksIn(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      REPOSITORY.test(node.text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${file}:${line + 1} :: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const files = walk(srcRoot);

// A path-first title, on `yaml-parse-log-level.spec.ts`' precedent and
// `describe-names.spec.ts`' escape: the unit is a property of a tree.
describe('backend/src — the strings Cloudgate sends, none naming its own repository', () => {
  it('leaves no string literal pointing at the repository', () => {
    const links = files.flatMap((file) =>
      linksIn(relative(backendRoot, file), readFileSync(file, 'utf8')),
    );

    expect(links).toEqual([]);
  });

  describe('the detector itself', () => {
    it('reads the tree, notifications included', () => {
      expect(files.length).toBeGreaterThanOrEqual(300);
      expect(
        files.some((file) =>
          file.endsWith(join('notifications', 'channels', 'ntfy.strategy.ts')),
        ),
      ).toBe(true);
    });

    it.each([
      [
        'the ntfy action as it was',
        "const actions = 'view, visit Cloudgate on Github, https://github.com/octabyte-io/cloudgate, clear=true;';\n",
      ],
      [
        'an issue link in a template',
        'const text = `see https://github.com/octabyte-io/cloudgate/issues/${n} for why`;\n',
      ],
      [
        'a link in a no-substitution template',
        'const text = `https://github.com/octabyte-io/cloudgate/issues/27`;\n',
      ],
    ])('reports %s', (_shape, text) => {
      expect(linksIn('synthetic.ts', text)).toHaveLength(1);
    });

    it('does not report a comment citing an issue', () => {
      const text =
        '// [#27](https://github.com/octabyte-io/cloudgate/issues/27)\n' +
        '/** https://github.com/octabyte-io/cloudgate/issues/12 */\n' +
        "const x = 'fine';\n";

      expect(linksIn('synthetic.ts', text)).toEqual([]);
    });
  });
});
