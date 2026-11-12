import type { DiffRow } from "@/components/console/diff-view";

/**
 * Two texts, as rows a `DiffView` can render.
 *
 * Lives here rather than under `features/application/advanced/` because two
 * features diff text now — the Application patch editor and a Compose stack's
 * Converted panel — and a helper more than one feature imports belongs to none
 * of them. Same move `env-blob.ts` and `units.ts` made into this folder, for the
 * same reason.
 *
 * A **longest-common-subsequence** diff rather than a line-by-line comparison,
 * because the cheap version is worse than useless on the thing these screens
 * show: insert one line at the top of a config file and a positional comparison
 * marks every remaining line as both removed and added, which reads as "you
 * rewrote the file" when you added a line. The LCS gives the same alignment
 * `git diff` does.
 *
 * No dependency for this either. A diff library brings hunk headers, word-level
 * highlighting and patch parsing to answer a question about two strings that are
 * both already in memory and are, in practice, a few hundred lines of config.
 *
 * The table is `O(n·m)`, so it is capped: past `MAX_LINES` the comparison falls
 * back to "everything removed, everything added", which is honest — it says the
 * files differ and stops claiming to know how. A patch that large is a file
 * nobody is reading in a diff anyway.
 */

const MAX_LINES = 2_000;

export function diffLines(before: string, after: string): DiffRow[] {
  const from = split(before);
  const to = split(after);

  if (from.length > MAX_LINES || to.length > MAX_LINES) {
    return [
      ...from.map((text): DiffRow => ({ kind: "del", text })),
      ...to.map((text): DiffRow => ({ kind: "add", text })),
    ];
  }

  // table[i][j] = length of the longest common subsequence of from[i…] and to[j…]
  const table: number[][] = Array.from({ length: from.length + 1 }, () =>
    new Array<number>(to.length + 1).fill(0),
  );
  for (let i = from.length - 1; i >= 0; i -= 1) {
    for (let j = to.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        from[i] === to[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < from.length && j < to.length) {
    if (from[i] === to[j]) {
      rows.push({ kind: "ctx", text: from[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ kind: "del", text: from[i] });
      i += 1;
    } else {
      rows.push({ kind: "add", text: to[j] });
      j += 1;
    }
  }
  while (i < from.length) {
    rows.push({ kind: "del", text: from[i] });
    i += 1;
  }
  while (j < to.length) {
    rows.push({ kind: "add", text: to[j] });
    j += 1;
  }

  return rows;
}

/** Whether anything actually differs — for a "no changes yet" state. */
export function hasChanges(rows: DiffRow[]): boolean {
  return rows.some((row) => row.kind !== "ctx");
}

/** A trailing newline is not a line, and counting it as one shows a phantom row. */
function split(value: string): string[] {
  if (value === "") return [];
  return value.replace(/\n$/, "").split("\n");
}
