import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * CODING_STANDARDS §2.6: **a foreign key always declares its `onDelete`.**
 * Left out, Postgres takes `no action` — often what was meant, but the
 * reader cannot tell a key that was weighed from one that was forgotten.
 * Two earlier reviews each found such keys one table at a time; this
 * asserts it over the tree instead.
 *
 * **Why it reads the source.** Drizzle builds an undeclared key as
 * `no action` (`ForeignKeyBuilder._onDelete`), so the built schema cannot
 * tell the two apart, and `drizzle-kit generate` answers "nothing to
 * migrate" either way. Only the call site says whether it was declared.
 */
const SRC = path.join(__dirname, '../../src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Each `.references(…)` call in `text`, with the line it starts on. */
function referenceCalls(text: string): { line: number; call: string }[] {
  const calls: { line: number; call: string }[] = [];
  const opener = /\.references\(/g;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    let at = match.index + match[0].length;
    for (let depth = 1; depth > 0 && at < text.length; at++) {
      if (text[at] === '(') depth++;
      else if (text[at] === ')') depth--;
    }
    calls.push({
      line: text.slice(0, match.index).split('\n').length,
      call: text.slice(match.index, at).replace(/\s+/g, ' '),
    });
  }
  return calls;
}

describe('backend/src every foreign key declares its onDelete (§2.6)', () => {
  const files = sourceFiles(SRC);

  it('reads the schema files', () => {
    expect(
      files.filter((file) => file.endsWith('.schema.ts')).length,
    ).toBeGreaterThan(50);
  });

  it('finds no .references() whose onDelete is left to the default', () => {
    const undeclared = files.flatMap((file) =>
      referenceCalls(fs.readFileSync(file, 'utf8'))
        .filter(({ call }) => !call.includes('onDelete'))
        .map(({ line, call }) => `${path.relative(SRC, file)}:${line} ${call}`),
    );
    expect(undeclared).toEqual([]);
  });
});
