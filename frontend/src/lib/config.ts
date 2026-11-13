/**
 * Where the backend is, and how the browser reaches it.
 *
 * **The browser never calls Nest's origin directly.** Everything goes through
 * this app's own origin and is rewritten to Nest by `next.config.ts`. Two reasons.
 * Neither is a wall any more — both were, and the backend has since grown a
 * setting for each — but the same-origin proxy is still the arrangement that works
 * with no settings at all, which is what a self-hosted default has to be:
 *
 * 1. Nest answers a cross-origin browser request only for an origin named in
 *    `CORS_ALLOWED_ORIGINS`, and that list is **empty by default**
 *    (`backend/src/common/config/cors.ts`). It used to be worse — `enableCors()`
 *    bare sent `Access-Control-Allow-Origin: *` with no
 *    `Access-Control-Allow-Credentials`, a pairing a browser refuses, and the
 *    session is a cookie so every call is credentialed. Naming the origins is what
 *    made credentials possible at all,
 *    but the shipped arrangement still names none: same-origin is the intended
 *    path, not a fallback.
 * 2. better-auth rejects a request whose `Origin` it does not trust. Being
 *    `BETTER_AUTH_URL` used to be the only unlicensed way onto that list;
 *    `TRUSTED_ORIGINS` can now name more of them
 * so an origin other
 *    than this app's can be trusted. It still has to be *named* on the backend,
 *    one origin at a time, and this app's origin is trusted for free.
 *
 * Which is why `AUTH_PATH` is `/api/auth`, the same path Nest mounts it on, and
 * not under `API_PREFIX`: every URL better-auth generates — email links, OAuth
 * callbacks — is built from `BETTER_AUTH_URL` and has to actually resolve, so
 * pointing it at this app means this app has to serve that path. Set
 * `BETTER_AUTH_URL=http://localhost:3000` in `backend/.env`.
 *
 * The REST routes have no such constraint (nothing generates a URL from them),
 * so they sit under `API_PREFIX`, out of the way of the app's own route tree.
 *
 * WebSockets do go straight to {@link backendOrigin} — an upgrade handshake is
 * not a fetch, so CORS never enters into it, and `localhost:3000` and
 * `localhost:4000` are the same site, so the browser attaches the session
 * cookie for free.
 */

import { apiOriginFrom } from "../../server/api-origin.mjs";

/**
 * Where the root layout leaves the API's origin for the page's own scripts.
 * A global rather than a prop, because the readers are module functions
 * (`gatewayUrl`, `errorMessage`) that no React tree reaches.
 */
const PAGE_GLOBAL = "__CLOUDGATE_API_URL__";

declare global {
  interface Window {
    [PAGE_GLOBAL]?: string;
  }
}

/**
 * The API's origin as this console process was started with it: the
 * `CLOUDGATE_API_URL` in its environment (ADR-0082), checked by the same rule
 * `server.mjs` refuses a bad value with at boot.
 *
 * Under `next dev` only, an unset value is `http://localhost:4000`, where
 * `pnpm dev:backend` listens, so a default local setup still needs no frontend
 * env file. A built console has no such default: `server.mjs` stops instead.
 */
function startedApiOrigin(env: {
  CLOUDGATE_API_URL?: string;
  NODE_ENV?: string;
}): string {
  const value =
    env.CLOUDGATE_API_URL ??
    (env.NODE_ENV === "development" ? "http://localhost:4000" : undefined);
  return apiOriginFrom(value);
}

/**
 * The script the root layout puts ahead of every other one on a page: it hands
 * the browser the address the server was started with. Read per request, so a
 * restart with a new `CLOUDGATE_API_URL` is all that changing it takes; nothing
 * about it is in the client bundle.
 */
export function apiOriginScript(env: {
  CLOUDGATE_API_URL?: string;
  NODE_ENV?: string;
}): string {
  const origin = JSON.stringify(startedApiOrigin(env)).replace(/</g, "\\u003c");
  return `window.${PAGE_GLOBAL}=${origin};`;
}

/**
 * Nest's public origin. Reached from the browser only over a socket.
 *
 * In the browser, what the root layout handed the page; on the server, this
 * process's own environment. A page with nothing handed to it is a bug in the
 * layout, not a setting, so it throws rather than guessing an address.
 */
export function backendOrigin(): string {
  if (typeof window === "undefined") return startedApiOrigin(process.env);
  const handed = window[PAGE_GLOBAL];
  if (typeof handed !== "string") {
    throw new Error(
      "This page was not handed the API's address. The root layout writes CLOUDGATE_API_URL into every page; reload it.",
    );
  }
  return handed;
}

/**
 * Where `next.config.ts`'s rewrites reach Nest — **server-side only**, so it
 * may be an address the browser cannot resolve, and on the shipped install it
 * is loopback. Separate from {@link backendOrigin}, which has to be an origin
 * the operator's browser can dial for the six gateways.
 *
 * It stays build-time, unlike that one (ADR-0082): rewrite destinations are
 * written into the routes manifest by `next build`, and on an install it is
 * always loopback. Unset, it is where `pnpm dev:backend` listens.
 */
export const BACKEND_INTERNAL_ORIGIN =
  process.env.BACKEND_INTERNAL_ORIGIN ?? "http://localhost:4000";

/** The same-origin prefix `next.config.ts` forwards to Nest's REST routes. */
export const API_PREFIX = "/backend";

/**
 * better-auth's handler. The same path on both sides on purpose — see above.
 */
export const AUTH_PATH = "/api/auth";

/**
 * The MCP endpoint an Agent dials (ADR-0025): the console's own origin
 * plus this path, which `next.config.ts` forwards to Nest's `POST /mcp`. The
 * same path on both sides, so the documented address is always "your
 * console's address + `/mcp`".
 */
export const MCP_PATH = "/mcp";

/**
 * The Gateway's path (ADR-0040): an AI model's endpoint is the platform
 * host URL plus `/ai/<AI model id>/v1`. With a console domain, Traefik's own
 * gateway routers send it to the backend; on an install reached by IP and
 * port alone, `next.config.ts` forwards it, so the endpoint the Model tab
 * shows answers either way. The same path on both sides.
 */
export const GATEWAY_PATH = "/ai";

/**
 * Origin the six gateways are dialled on. `http:` → `ws:`, `https:` → `wss:`;
 * {@link backendOrigin} is already one of the two, because `apiOriginFrom`
 * refuses anything else when the console starts.
 */
export function wsOrigin(): string {
  const origin = backendOrigin();
  if (origin.startsWith("https:")) return `wss:${origin.slice("https:".length)}`;
  return `ws:${origin.slice("http:".length)}`;
}
