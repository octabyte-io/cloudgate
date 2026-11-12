import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * The console's unit tests.
 *
 * `*-spec.ts` is already spoken for in this tree — it names the declarative form
 * and resource specs — so tests are `*.test.ts(x)`, co-located with the module
 * they cover the way everything else here is.
 */
export default defineConfig({
  test: {
    /**
     * Three projects, because they need different environments: the console's
     * own tests boot jsdom, and the local ESLint rules' fixtures and the
     * custom server's forwarding are both node-side. One config so that
     * `pnpm --filter frontend test` runs all of them — a fixture nothing runs is
     * a fixture that rots.
     */
    projects: [
      {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        test: {
          name: "console",
          environment: "jsdom",
          include: ["src/**/*.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "lint-rules",
          include: ["eslint-rules/**/*.test.mjs"],
        },
      },
      {
        test: {
          name: "server",
          environment: "node",
          include: ["server/**/*.test.mjs"],
        },
      },
    ],
  },
});
