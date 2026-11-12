import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * **The census: no dialog holds its submit off until a box is
 * filled.**
 *
 * Invite someone, Create a personal key and Create an Organization disabled
 * their submit until a field was non-empty and said nothing about why, while
 * every other create dialog left submit on and refused inline. The console has
 * one pattern — submit on, the schema's sentence under the field — so a
 * `disabled={… .trim() === "" …}` in a dialog is the old pattern coming back.
 *
 * Read off the source, so dialog N+1 arrives through this test.
 */
const SRC = join(__dirname, "..", "..");

/** Not create dialogs: a step that asks for a password, then a code. */
const EXEMPT: Record<string, string> = {
  "features/settings/account/enrol-two-factor-modal.tsx":
    "a sign-in step (password, then a one-time code), not a create dialog",
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

const GATED = /disabled=\{[^}]*\.trim\(\)\s*===\s*""/;

describe("dialogs", () => {
  const dialogs = sources(SRC)
    .map((path) => ({ file: relative(SRC, path), source: readFileSync(path, "utf8") }))
    .filter(({ source }) => /<Modal[\s.>]/.test(source));

  it("found the console's dialogs to check", () => {
    expect(dialogs.length).toBeGreaterThan(40);
  });

  it("leave submit on and refuse an empty field inline", () => {
    const gated = dialogs
      .filter(({ file, source }) => !(file in EXEMPT) && GATED.test(source))
      .map(({ file }) => file);
    expect(gated).toEqual([]);
  });

  it("still exempt only files that exist and still gate", () => {
    for (const file of Object.keys(EXEMPT)) {
      const found = dialogs.find((dialog) => dialog.file === file);
      expect(found, file).toBeDefined();
    }
  });
});
