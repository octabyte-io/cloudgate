import { apiOriginScript } from "@/lib/config";

/**
 * What the root layout does for every page it serves: hand the browser the
 * API's address the console was started with (ADR-0082). A console test is a
 * page that layout served, so it gets the same script, with the address
 * `pnpm dev:backend` listens on.
 */
new Function(apiOriginScript({ CLOUDGATE_API_URL: "http://localhost:4000" }))();
