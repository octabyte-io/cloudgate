/**
 * The `.gitignore` pattern syntax, as `cloudgate deploy` reads both
 * `.gitignore` and `.cloudgateignore` (CLI spec: "same syntax"). Written here
 * rather than taken from a package because the published CLI has no runtime
 * dependencies (`cli/build.mjs`), and the part of git's syntax a project's
 * ignore files use is small: comments, `!`, a trailing `/`, an anchoring `/`,
 * `*`, `?`, `[…]` and `**`.
 *
 * Not git itself (`git check-ignore`) on purpose: the folder need not be a git
 * repository, git need not be installed (a CI image), and git would also read
 * the person's global excludes, which nobody else deploying the folder has.
 */

/** One pattern line, compiled. */
export interface IgnoreRule {
  /** The folder holding the file it came from, relative to the upload root (`''` for the root). */
  base: string;
  /** `!pattern`: brings back what an earlier rule left out. */
  negated: boolean;
  /** `pattern/`: matches folders only. */
  directoryOnly: boolean;
  /** A pattern with no `/` but a trailing one matches a name at any depth. */
  matchesName: boolean;
  regex: RegExp;
}

/**
 * The rules in one ignore file's text, for a file sitting in `base`.
 * Blank lines and `#` comments are skipped; `\#` and `\!` start a pattern
 * with that character; trailing spaces are dropped unless escaped.
 */
export function parseIgnoreFile(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1);
    }
    let directoryOnly = false;
    if (line.endsWith('/')) {
      directoryOnly = true;
      line = line.replace(/\/+$/, '');
    }
    if (!line) continue;
    const matchesName = !line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    rules.push({
      base,
      negated,
      directoryOnly,
      matchesName,
      regex: new RegExp(`^${globToRegex(line)}$`),
    });
  }
  return rules;
}

/**
 * Whether `rules`, in precedence order (later wins), leave out the entry at
 * `path` (relative to the upload root). `undefined` when no rule matches it.
 * A rule applies only below its own file's folder.
 */
export function ignoredBy(
  rules: readonly IgnoreRule[],
  path: string,
  isDirectory: boolean,
): IgnoreRule | undefined {
  let decided: IgnoreRule | undefined;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    let relative: string;
    if (!rule.base) relative = path;
    else if (path.startsWith(`${rule.base}/`))
      relative = path.slice(rule.base.length + 1);
    else continue;
    const subject = rule.matchesName
      ? relative.slice(relative.lastIndexOf('/') + 1)
      : relative;
    if (rule.regex.test(subject)) decided = rule;
  }
  return decided;
}

/** A glob, as a regex source matching a whole `/`-separated path. */
function globToRegex(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      const atStart = i === 0 || glob[i - 1] === '/';
      const atEnd = i + 2 === glob.length || glob[i + 2] === '/';
      if (atStart && atEnd) {
        if (i + 2 === glob.length) {
          // `foo/**`: everything inside.
          out += '.*';
          i += 2;
        } else {
          // `**/` (leading or middle): zero or more folders.
          out += '(?:.*/)?';
          i += 3;
        }
        continue;
      }
      out += '[^/]*';
      i += 2;
      continue;
    }
    if (char === '*') {
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close === -1) {
        out += '\\[';
      } else {
        let set = glob.slice(i + 1, close);
        if (set.startsWith('!')) set = `^${set.slice(1)}`;
        out += `[${set.replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else if (char === '\\' && i + 1 < glob.length) {
      i += 1;
      out += escapeRegex(glob[i]);
    } else {
      out += escapeRegex(char);
    }
    i += 1;
  }
  return out;
}

function escapeRegex(char: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(char) ? `\\${char}` : char;
}
