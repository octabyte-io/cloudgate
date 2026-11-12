import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getAccessFallbackHTTPStatus,
  isHTTPAccessFallbackError,
} from "next/dist/client/components/http-access-fallback/http-access-fallback";
import { describe, expect, it } from "vitest";

import { scopeTabEntries, type TabScopeKind } from "@/lib/shell/tab-registry";

/**
 * A tab slug the registry does not declare has to answer **404**, not merely
 * render the not-found screen.
 *
 * The bug this guards
 * had the screen right and the status wrong: every scope's invented slug drew
 * `(console)/not-found.tsx` inside the shell and returned `200 OK`, so a link
 * checker, an uptime probe or a `curl -f` read every mistyped console address as
 * healthy. Any test that asserted the *screen* would have passed throughout.
 *
 * So there are two halves here, because the bug had two:
 *
 * 1. **The route asks for a 404.** Each `[[...tab]]/page.tsx` is called directly
 *    and the thrown error is read for the HTTP status it carries — `notFound()`
 *    throws with a `NEXT_HTTP_ERROR_FALLBACK;404` digest, and Next reads that
 *    same digest to set the status line, so this is the status and not a proxy
 *    for it.
 * 2. **Nothing above the route can swallow it.** A `loading.tsx` anywhere
 *    between `app/` and one of these pages wraps it in a Suspense boundary, and
 *    Next then flushes the shell — status line included — before the page
 *    component ever runs. That is precisely what `(console)/loading.tsx` did.
 *    Half 1 stays green while it happens, which is why half 2 exists.
 */

/**
 * The first of these pulls the whole route graph — registry, shell, six scopes'
 * tab tables — through the transform, which is well past vitest's 5s default.
 */
const SLOW = 30_000;

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every scope route, its params, and a slug it really has. */
const SCOPES: {
  kind: TabScopeKind;
  dir: string;
  params: Record<string, string>;
  page: () => Promise<{ default: (props: never) => Promise<unknown> }>;
}[] = [
  {
    kind: "application",
    dir: "(console)/applications/[applicationId]/[[...tab]]",
    params: { applicationId: "app_1" },
    page: () => import("./applications/[applicationId]/[[...tab]]/page"),
  },
  {
    kind: "compose",
    dir: "(console)/compose/[composeId]/[[...tab]]",
    params: { composeId: "cmp_1" },
    page: () => import("./compose/[composeId]/[[...tab]]/page"),
  },
  {
    kind: "database",
    dir: "(console)/databases/[kind]/[databaseId]/[[...tab]]",
    params: { kind: "postgres", databaseId: "db_1" },
    page: () => import("./databases/[kind]/[databaseId]/[[...tab]]/page"),
  },
  {
    kind: "environment",
    dir: "(console)/environments/[environmentId]/[[...tab]]",
    params: { environmentId: "env_1" },
    page: () => import("./environments/[environmentId]/[[...tab]]/page"),
  },
  {
    kind: "project",
    dir: "(console)/projects/[projectId]/[[...tab]]",
    params: { projectId: "prj_1" },
    page: () => import("./projects/[projectId]/[[...tab]]/page"),
  },
  {
    kind: "server",
    dir: "(console)/servers/[serverId]/[[...tab]]",
    params: { serverId: "srv_1" },
    page: () => import("./servers/[serverId]/[[...tab]]/page"),
  },
];

/**
 * The HTTP status a `notFound()` throw asks for, or `null` if it did not throw.
 *
 * Read with Next's own parser rather than by matching the string, so this
 * asserts against the very code that sets the status line and not a copy of it.
 * Anything else thrown is a real failure and is rethrown as one.
 */
async function statusOf(render: () => Promise<unknown>): Promise<number | null> {
  try {
    await render();
    return null;
  } catch (error) {
    if (!isHTTPAccessFallbackError(error)) throw error;
    return getAccessFallbackHTTPStatus(error);
  }
}

describe("an undeclared tab slug", () => {
  it.each(SCOPES)("404s at $kind scope", async ({ kind, params, page }) => {
    const { default: Page } = await page();
    const declared = scopeTabEntries(kind).map((entry) => entry.slug);
    expect(declared).not.toContain("nonsense");

    expect(
      await statusOf(() =>
        Page({ params: Promise.resolve({ ...params, tab: ["nonsense"] }) } as never),
      ),
    ).toBe(404);
  }, SLOW);

  it.each(SCOPES)("leaves every declared $kind tab alone", async ({ kind, params, page }) => {
    const { default: Page } = await page();

    for (const { slug } of scopeTabEntries(kind)) {
      expect(
        await statusOf(() =>
          Page({
            params: Promise.resolve({ ...params, tab: slug ? slug.split("/") : undefined }),
          } as never),
        ),
      ).toBeNull();
    }
  }, SLOW);
});

it("404s a database engine we do not have", async () => {
  const { default: Page } = await import(
    "./databases/[kind]/[databaseId]/[[...tab]]/page"
  );

  expect(
    await statusOf(() =>
      Page({
        params: Promise.resolve({ kind: "nonsense", databaseId: "db_1" }),
      } as never),
    ),
  ).toBe(404);
}, SLOW);

/**
 * An address no route declares lands in the console's catch-all, inside the
 * shell, and still answers 404 — where it used to reach the root
 * not-found with no masthead or rail.
 */
it("404s an address no route declares, from inside the console", async () => {
  const { default: Page } = await import("./[...missing]/page");

  expect(await statusOf(() => Page())).toBe(404);
  expect(readdirSync(join(APP, "(console)", "[...missing]"))).not.toContain(
    "loading.tsx",
  );
});

describe("no Suspense boundary above a scope route", () => {
  it.each(SCOPES)("$dir has no loading.tsx over it", ({ dir }) => {
    const above: string[] = [];

    // Walk down from `app/` to the route's own segment. A `loading.tsx` at any
    // step wraps everything below it, so the status line is gone before the
    // registry check runs (Next's own `loading.js` docs say so, and this was the
    // measurement: with `(console)/loading.tsx` in place every invented slug
    // answered 200; without it, 404).
    let here = APP;
    for (const segment of ["", ...dir.split("/")]) {
      here = segment ? join(here, segment) : here;
      if (readdirSync(here).includes("loading.tsx")) {
        above.push(join(relative(APP, here) || ".", "loading.tsx").split(sep).join("/"));
      }
    }

    expect(above).toEqual([]);
  });
});
