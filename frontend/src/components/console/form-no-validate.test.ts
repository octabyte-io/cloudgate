import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * **The census: every console `<form>` carries `noValidate`.**
 *
 * `ResourceField` renders a number box as `<input type="number" min max>`, so
 * on a form without `noValidate` the browser checks it first: Replicas `-1`
 * or a container port of `99999` got the browser's own tooltip instead of the
 * console's inline error, and the native check held back every other field's
 * error until it was satisfied. The zod schema behind `useApiForm` is the one
 * place a refusal is worded, so the browser's is switched off everywhere.
 *
 * Read off the source rather than listed, so form N+1 arrives through this
 * test. `app/dev/*` is left out: those are the developer's own primitives
 * pages, not the console, and one of them leans on `required` on purpose.
 */

const SRC = join(__dirname, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

/** The opening tag from `start`, to its `>` outside any `{…}` or string. */
function openingTag(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (depth === 0 && (char === '"' || char === "'")) {
      quote = char;
    } else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return source.slice(start, index + 1);
  }
  return source.slice(start);
}

/** Every JSX `<form` opening tag in a file, skipping comment lines. */
function formTags(source: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(/<form(?=[\s>])/g)) {
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    const before = source.slice(lineStart, match.index).trim();
    if (before.startsWith("*") || before.startsWith("//") || before.includes("`")) {
      continue;
    }
    tags.push(openingTag(source, match.index));
  }
  return tags;
}

describe("console forms", () => {
  const files = sources(SRC).filter(
    (path) => !relative(SRC, path).startsWith(join("app", "dev")),
  );
  const forms = files.flatMap((path) =>
    formTags(readFileSync(path, "utf8")).map((tag) => ({
      file: relative(SRC, path),
      tag,
    })),
  );

  it("found the console's forms to check", () => {
    expect(forms.length).toBeGreaterThan(50);
  });

  it("leave validation to the form's schema, not the browser", () => {
    const missing = forms
      .filter(({ tag }) => !/\bnoValidate\b/.test(tag))
      .map(({ file }) => file);
    expect(missing).toEqual([]);
  });
});
