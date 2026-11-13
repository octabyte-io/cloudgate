import type { NextConfig } from "next";

import {
  API_PREFIX,
  AUTH_PATH,
  BACKEND_INTERNAL_ORIGIN,
  GATEWAY_PATH,
  MCP_PATH,
} from "./src/lib/config";

const nextConfig: NextConfig = {
  experimental: {
    /**
     * How long the rewrite proxy below waits for the backend: four minutes.
     *
     * **Unset, it was 30 s, and nobody had chosen that.** Next's
     * `proxyRequest` hands `http-proxy` `proxyTimeout || 30000`, so every AI
     * call that took longer — a draft from any model that accepted the request
     * and started generating — had its socket dropped here while the backend
     * was still waiting on the model. The browser got a bare 500 reading
     * "Internal Server Error", the console turned that into "the backend hit an
     * error … check the backend logs", and the only trace was `Failed to proxy
     * … socket hang up` in *this* process's log.
     *
     * The number is set against the backend's own AI deadline,
     * `AI_GENERATION_TIMEOUT_MS` (three minutes), and must stay above it: that
     * deadline answers with a 400 saying how long it waited, and a proxy that
     * gave up first would swallow the sentence and put the bare 500 back.
     * `server/proxy-timeout.test.mjs` holds both halves.
     *
     * It is one limit for every `/backend/*`, `/api/auth/*` and `/mcp`
     * request — Next offers no per-rewrite value. The MCP endpoint's own tool
     * deadline (`TOOL_DEADLINE_MS`, 30 s) sits well below it, so a slow tool is
     * a result the agent reads rather than a socket this proxy cut
     * (ADR-0025); `server/mcp-deadline.test.mjs` holds that ordering. That costs nothing: it is an *idle* timeout
     * on the backend socket, so it only ever ends a request the backend has gone
     * quiet on for four minutes, and before this the same requests were cut at
     * thirty seconds. `0` does not mean "no limit" here (`|| 30000`), which is
     * why it is a number rather than an off switch.
     */
    proxyTimeout: 240_000,
    /**
     * How much of a request body the rewrite proxy passes on: 1 GiB.
     *
     * **Unset, it was 10 MB, and the rest of the body was dropped.** Next
     * clones every request body before proxying it, and the clone the rewrite
     * proxy sends ends at this limit (`server/body-streams.js`). The backend,
     * told a longer `content-length`, waited for bytes that never came until
     * `proxyTimeout` above cut the socket, so every `cloudgate deploy` or
     * console upload over 10 MB failed four minutes later with a bare 500
     * (#30). `server/upload-body.test.mjs` holds it.
     *
     * The clone is held in this process's memory while it is sent, as the
     * backend holds the whole upload (multer's memory storage), so the
     * number is a ceiling on one upload, not a size anyone is expected to
     * reach: `cloudgate deploy` warns from 100 MB.
     */
    proxyClientMaxBodySize: 1024 * 1024 * 1024,
  },
  /**
   * The backend, served from our own origin, so the session cookie is
   * first-party and no preflight is involved. `src/lib/config.ts` explains why
   * that is the only arrangement that works.
   *
   * Four rules, because the halves have different constraints: better-auth
   * has to live at the path it thinks it lives at, the REST routes have to
   * stay out of the app's own route tree, and the MCP endpoint is documented as
   * the console's address plus `/mcp` (ADR-0025) — no Traefik entry and
   * no installer change, so it exists on a bare `http://host:3000` install too.
   * The Gateway's `/ai/*` is the fourth, for the same bare install.
   *
   * `beforeFiles` so a page can never shadow the backend by accident.
   *
   * **A rewrite to an external destination is a *server-side* proxy, so the
   * browser never opens a socket to the backend for either of these paths —
   * this process does.** The backend's socket peer is therefore the
   * console and not the person, which is why `session.ip_address` and
   * better-auth's sign-in throttle both named this host on every request until
   * `server.mjs` started forwarding `x-forwarded-for`. It is also why the
   * destination is `BACKEND_INTERNAL_ORIGIN`: nothing in a rewrite is dialled
   * by a browser, so on the shipped install it is loopback.
   */
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: `${AUTH_PATH}/:path*`,
          destination: `${BACKEND_INTERNAL_ORIGIN}${AUTH_PATH}/:path*`,
        },
        {
          source: `${API_PREFIX}/:path*`,
          destination: `${BACKEND_INTERNAL_ORIGIN}/:path*`,
        },
        {
          source: MCP_PATH,
          destination: `${BACKEND_INTERNAL_ORIGIN}${MCP_PATH}`,
        },
        {
          // The Gateway, on an install with no console domain: with
          // one, Traefik's own routers take `/ai/` before it reaches here, and
          // they have no 240 s idle cut; this rewrite has `proxyTimeout`'s.
          source: `${GATEWAY_PATH}/:path*`,
          destination: `${BACKEND_INTERNAL_ORIGIN}${GATEWAY_PATH}/:path*`,
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
