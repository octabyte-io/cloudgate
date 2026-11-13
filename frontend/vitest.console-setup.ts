import { apiOriginScript } from "@/lib/config";

/**
 * What the root layout does for every page it serves: hand the browser the
 * API's address the console was started with (ADR-0082). A console test is a
 * page that layout served, so it gets the same script, with the address
 * `pnpm dev:backend` listens on.
 *
 * Only where there is a page: a file marked `// @vitest-environment node`
 * (`src/proxy.test.ts`, the request proxy) runs where the server does, with no
 * `window` to hand anything to, and reads the address from its environment.
 */
if (typeof window !== "undefined") {
  new Function(
    apiOriginScript({ CLOUDGATE_API_URL: "http://localhost:4000" }),
  )();
}
