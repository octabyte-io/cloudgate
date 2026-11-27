import type { CSSProperties } from "react";

/**
 * The most a wrapped line's continuation rows hang, in columns. A deeply nested
 * line at phone width still has to leave itself room to wrap into.
 */
export const MAX_HANG = 24;

/**
 * How far a wrapped line's continuation rows hang: its leading whitespace, in
 * columns (a tab to the next multiple of `tabSize`, the browser's default 8),
 * capped at `MAX_HANG`.
 *
 * Code and diffs wrap rather than scroll sideways, and a wrap that sends the
 * continuation back to column zero is a line whose indentation lies. Hanging it
 * at the line's own indentation keeps a wrapped YAML value inside its block.
 */
export function hangColumns(line: string, tabSize = 8): number {
  let columns = 0;
  for (const char of line) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += tabSize - (columns % tabSize);
    else break;
  }
  return Math.min(columns, MAX_HANG);
}

/**
 * `--hang` for one line, read by a padding of `+ var(--hang)` and an equal
 * negative `text-indent`: the first row starts where it always did and every
 * row after it starts at the line's indentation. In `ch`, which in a mono face
 * is exactly one column.
 */
export function hangStyle(line: string): CSSProperties {
  return { "--hang": `${hangColumns(line)}ch` } as CSSProperties;
}
