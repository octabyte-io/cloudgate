/**
 * The variables a compose file interpolates, as Docker Compose reads them:
 * `${NAME}`, `$NAME`, `${NAME:?error}` and `${NAME?error}` need a value;
 * `${NAME:-default}`, `${NAME-default}`, `${NAME:+other}` and `${NAME+other}`
 * do not, since Compose fills them in without one; `$$` is a literal dollar.
 *
 * Only values are read, never keys or comments, because Compose interpolates
 * only values. The raw text was the first thing tried and rejected: a `$`
 * in a YAML comment would have asked the author for a rule nothing reads.
 *
 * Text after a default's `:-` is read on, so `${A:-${B}}` needs `B`. Compose
 * would only read `B` when `A` is unset, but `A` has no rule then (it has a
 * default), so `B` is what setup must make.
 */
export interface ComposeVariables {
  /** Names used with no default: each needs an input rule (ADR-0064). */
  readonly needs: ReadonlySet<string>;
  /** Every name used, with a default or without. */
  readonly mentions: ReadonlySet<string>;
}

const BRACED = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-+?])?/;
const BARE = /^\$([A-Za-z_][A-Za-z0-9_]*)/;

export function composeVariables(document: unknown): ComposeVariables {
  const needs = new Set<string>();
  const mentions = new Set<string>();
  const read = (value: unknown): void => {
    if (typeof value === 'string') {
      readText(value, needs, mentions);
    } else if (Array.isArray(value)) {
      value.forEach(read);
    } else if (value !== null && typeof value === 'object') {
      Object.values(value).forEach(read);
    }
  };
  read(document);
  return { needs, mentions };
}

function readText(text: string, needs: Set<string>, mentions: Set<string>) {
  let at = 0;
  while (at < text.length) {
    if (text[at] !== '$') {
      at += 1;
      continue;
    }
    if (text[at + 1] === '$') {
      at += 2;
      continue;
    }
    const rest = text.slice(at);
    const braced = BRACED.exec(rest);
    const match = braced ?? BARE.exec(rest);
    if (!match) {
      at += 1;
      continue;
    }
    const [read, name, modifier] = match;
    mentions.add(name);
    if (!braced || modifier === undefined || modifier.endsWith('?')) {
      needs.add(name);
    }
    at += read.length;
  }
}
