import { parse as parseDotenv } from 'dotenv';

/** A line that starts an entry, as dotenv reads one: `[export ]KEY=` or `KEY:`. */
const ENTRY = /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)/;

/**
 * A variable blob with only the keys in `keep` left: a key the
 * Environment holds that the config does not list is removed with its value,
 * and everything else — comments, blank lines, quoting, the order — stays as
 * the operator wrote it. A quoted value that runs over several lines goes
 * with its key.
 *
 * The result is read back with dotenv's own parser and must hold exactly the
 * kept keys with their old values; a blob this reading cannot cut cleanly is
 * refused rather than half-rewritten, and the step that asked fails.
 */
export function keepKeys(blob: string, keep: ReadonlySet<string>): string {
  const lines = blob.split('\n');
  const out: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const entry = ENTRY.exec(line);
    if (!entry) {
      out.push(line);
      index += 1;
      continue;
    }
    let end = index;
    const value = line.slice(entry[0].length).trimStart();
    const quote = value[0];
    if (
      (quote === '"' || quote === "'" || quote === '`') &&
      value.indexOf(quote, 1) === -1
    ) {
      end += 1;
      while (end < lines.length && !lines[end].includes(quote)) end += 1;
    }
    if (keep.has(entry[1])) out.push(...lines.slice(index, end + 1));
    index = end + 1;
  }
  const result = out.join('\n');

  const before = parseDotenv(blob);
  const after = parseDotenv(result);
  const expected = Object.keys(before).filter((key) => keep.has(key));
  if (
    Object.keys(after).length !== expected.length ||
    expected.some((key) => after[key] !== before[key])
  ) {
    throw new Error(
      'The variables could not be rewritten without the unlisted keys; remove them in the console',
    );
  }
  return result;
}

/**
 * Variables as a blob dotenv reads back exactly: each value quoted with the
 * first of `'`, `"` and `` ` `` it does not hold, since dotenv's reader has
 * no escapes for a quote inside its own kind. A value holding all three
 * cannot be written so and is refused, as is any that does not read back.
 */
export function dotenvText(
  variables: readonly (readonly [string, string])[],
): string {
  const lines = variables.map(([key, value]) => {
    const quote = ["'", '"', '`'].find((one) => !value.includes(one));
    if (quote === undefined) {
      throw new Error(
        `${key}'s value holds ', " and \`, which a variable cannot be written with`,
      );
    }
    return `${key}=${quote}${value}${quote}`;
  });
  const text = lines.join('\n');
  const read = parseDotenv(text);
  for (const [key, value] of variables) {
    if (read[key] !== value) {
      throw new Error(`${key}'s value cannot be written as a variable`);
    }
  }
  return text;
}
