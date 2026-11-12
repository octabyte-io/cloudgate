import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COMPOSE_TYPE_LABEL } from "./compose";

/**
 * **A Compose stack's kind is said in one set of words**.
 *
 * The masthead chip printed the column's own `docker-compose` while the
 * Overview badge beside it said "Docker Compose", and the file editor printed
 * the column too. Every place now reads `COMPOSE_TYPE_LABEL`; this census
 * fails if a `composeType` is rendered straight into JSX or handed to a chip as
 * its label again. `*.test.*` files are out of scope.
 *
 * Falsified: against the tree before the fix it reported
 * `components/shell/resolve-scope.ts` and
 * `features/compose/editor/compose-file-card.tsx`.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

const RAW = [
  /\{\s*[\w.?]+\.composeType\s*\}/, // <Chip>{row.composeType}</Chip>
  /label:\s*[\w.?]+\.composeType\b/, // { kind: "chip", label: row.composeType }
];

describe("COMPOSE_TYPE_LABEL", () => {
  it("names both kinds the way Docker does", () => {
    expect(COMPOSE_TYPE_LABEL).toEqual({
      "docker-compose": "Docker Compose",
      stack: "Swarm stack",
    });
  });

  it("is the only way a composeType reaches the screen", () => {
    const offenders = sources(SRC).filter((path) => {
      const text = readFileSync(path, "utf8");
      return RAW.some((pattern) => pattern.test(text));
    });
    expect(offenders.map((path) => relative(SRC, path))).toEqual([]);
  });
});
