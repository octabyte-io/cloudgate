import { describe, expect, it } from "vitest";

/**
 * An invented tab under a real scope is titled as the 404 it is.
 *
 * `/projects/<id>/nonsense` renders `(console)/not-found.tsx` — "That page is not
 * here." — and was titled `Project · Cloudgate`, because `generateMetadata` fell
 * back to the scope's noun. The client-side title (`scope-title.tsx`) says
 * nothing about a tab the scope does not have, so this is the only title that
 * page gets. The database route already did this; these are the other five.
 */

/** The first pulls the route graph through the transform (`undeclared-tab.test.ts`). */
const SLOW = 30_000;

type Meta = (props: {
  params: Promise<Record<string, unknown>>;
}) => Promise<{ title?: unknown }>;

const SCOPES: {
  name: string;
  params: Record<string, string>;
  real: { tab: string[]; title: string };
  page: () => Promise<{ generateMetadata: Meta }>;
}[] = [
  {
    name: "Server",
    params: { serverId: "srv_1" },
    real: { tab: [], title: "Overview" },
    page: () =>
      import("./servers/[serverId]/[[...tab]]/page") as unknown as Promise<{
        generateMetadata: Meta;
      }>,
  },
  {
    name: "Project",
    params: { projectId: "prj_1" },
    real: { tab: ["settings"], title: "Settings" },
    page: () =>
      import("./projects/[projectId]/[[...tab]]/page") as unknown as Promise<{
        generateMetadata: Meta;
      }>,
  },
  {
    name: "Environment",
    params: { environmentId: "env_1" },
    real: { tab: ["variables"], title: "Variables" },
    page: () =>
      import(
        "./environments/[environmentId]/[[...tab]]/page"
      ) as unknown as Promise<{ generateMetadata: Meta }>,
  },
  {
    name: "Application",
    params: { applicationId: "app_1" },
    real: { tab: [], title: "Overview" },
    page: () =>
      import(
        "./applications/[applicationId]/[[...tab]]/page"
      ) as unknown as Promise<{ generateMetadata: Meta }>,
  },
  {
    name: "Compose stack",
    params: { composeId: "cmp_1" },
    real: { tab: [], title: "Overview" },
    page: () =>
      import("./compose/[composeId]/[[...tab]]/page") as unknown as Promise<{
        generateMetadata: Meta;
      }>,
  },
];

describe("a resource scope route's generateMetadata", () => {
  for (const scope of SCOPES) {
    it(
      `titles an invented ${scope.name} tab "Not found"`,
      async () => {
        const { generateMetadata } = await scope.page();

        const meta = await generateMetadata({
          params: Promise.resolve({ ...scope.params, tab: ["nonsense"] }),
        });

        expect(meta.title).toBe("Not found");
      },
      SLOW,
    );

    it(`keeps a real ${scope.name} tab's label`, async () => {
      const { generateMetadata } = await scope.page();

      const meta = await generateMetadata({
        params: Promise.resolve({ ...scope.params, tab: scope.real.tab }),
      });

      expect(meta.title).toBe(scope.real.title);
    }, SLOW);
  }
});
