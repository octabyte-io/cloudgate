import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RESOURCE_PAGES, scopeFromPath } from "./scope";

/**
 * A page that sits beside a resource's dynamic segment, like `/servers/buy`
 * beside `/servers/[serverId]`, is not that resource.
 *
 * `scopeFromPath` reads the URL alone, so it took `buy` for a Server id: the
 * shell asked for the Server called `buy`, got a 404, and titled the working
 * Buy a Server page "Not found" (#194). Next matches the static folder first;
 * the scope has to agree with it.
 *
 * The census reads the console's route folders, the producer of every
 * address, so a page added beside any resource segment fails here until
 * `RESOURCE_PAGES` names it; and a name left there after its folder is gone
 * fails too.
 */

const CONSOLE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../app/(console)",
);

/** The folders directly under a route folder, route groups left out. */
function folders(dir: string): string[] {
  try {
    return readdirSync(join(CONSOLE, dir), { withFileTypes: true })
      .filter((each) => each.isDirectory())
      .map((each) => each.name);
  } catch {
    return [];
  }
}

const isDynamic = (name: string) => name.startsWith("[");

/** Every resource segment, each with the static pages beside its id. */
const ON_DISK = Object.keys(RESOURCE_PAGES).map((segment) => ({
  segment,
  pages: folders(segment).filter((name) => !isDynamic(name)),
  hasId: folders(segment).some(isDynamic),
}));

describe("scopeFromPath", () => {
  it.each(ON_DISK)(
    "keeps every page beside a $segment id at Organization scope",
    ({ segment, pages }) => {
      for (const page of pages) {
        expect(scopeFromPath(`/${segment}/${page}`).kind).toBe("organization");
      }
    },
  );

  it.each(ON_DISK)(
    "names exactly the pages that exist beside a $segment id",
    ({ segment, pages }) => {
      expect([...RESOURCE_PAGES[segment as keyof typeof RESOURCE_PAGES]].sort())
        .toEqual([...pages].sort());
    },
  );

  it("still opens a Server's scope for its id, and its tabs", () => {
    expect(ON_DISK.find((each) => each.segment === "servers")?.hasId).toBe(
      true,
    );
    expect(scopeFromPath("/servers/srv_1")).toEqual({
      kind: "server",
      id: "srv_1",
      variant: null,
      tab: "",
    });
    expect(scopeFromPath("/servers/srv_1/settings").tab).toBe("settings");
  });

  it("titles /servers/buy as the Organization's page it is", () => {
    expect(scopeFromPath("/servers/buy")).toEqual({
      kind: "organization",
      id: null,
      variant: null,
      tab: "/servers/buy",
    });
  });
});
