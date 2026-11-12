import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LinkButton } from "./link-button";

describe("LinkButton", () => {
  it("is announced as a link, never as a button", () => {
    render(<LinkButton href="/settings/license">Go to License</LinkButton>);
    const link = screen.getByRole("link", { name: "Go to License" });
    expect(link.getAttribute("href")).toBe("/settings/license");
    expect(link.hasAttribute("role")).toBe(false);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("stays a plain link when it reloads the document", () => {
    render(
      <LinkButton href="/" reload variant="pri">
        Continue
      </LinkButton>,
    );
    const link = screen.getByRole("link", { name: "Continue" });
    expect(link.tagName).toBe("A");
    expect(link.hasAttribute("role")).toBe(false);
  });
});

/**
 * **No Base UI `Button` is rendered as a link anywhere else.** Five sites built
 * their own link-button with `nativeButton={false}` and a `render` anchor, and
 * every one of them carried the same `role="button"`. One mistake at
 * several sites is a census, not several assertions: a control that goes
 * somewhere is a `LinkButton`.
 */
describe("the census of hand-rolled link-buttons", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  function* sourceFiles(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const here = join(dir, entry.name);
      if (entry.isDirectory()) yield* sourceFiles(here);
      else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
        yield here;
      }
    }
  }

  it("finds no `nativeButton={false}` outside LinkButton", () => {
    const offenders = [...sourceFiles(SRC)]
      .filter((file) => /nativeButton=\{false\}/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file))
      .filter((file) => !file.endsWith(join("console", "link-button.tsx")));
    expect(offenders).toEqual([]);
  });
});
