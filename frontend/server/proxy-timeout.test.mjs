import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { parse } from "node:url";

import { proxyRequest } from "next/dist/server/lib/router-utils/proxy-request.js";
import { afterEach, describe, expect, it } from "vitest";

import nextConfig from "../next.config.ts";

/**
 * The console's rewrite proxy, and how long it waits for the backend.
 *
 * `next.config.ts` rewrites `/backend/*` to the backend, and a rewrite to an
 * external destination is served by Next's own `proxyRequest`, which hands
 * `http-proxy` a `proxyTimeout` of `experimental.proxyTimeout || 30000`
 * (`next/dist/server/lib/router-utils/proxy-request.js`, Next 16.2.10). Unset,
 * that is 30 s, and every AI call that took longer was cut there: the socket
 * dropped, the browser got a 21-byte `Internal Server Error`, and the console
 * called it a backend fault.
 *
 * So this drives **Next's own proxy function** with the value the config sets —
 * the same call `router-server.js` makes with `config.experimental.proxyTimeout`
 * — at a stub backend that answers after the old limit, and asserts the answer
 * arrives whole. It waits past 30 s of real time on purpose: `http-proxy`'s
 * limit is a socket timeout, which no fake clock reaches, and a shorter wait
 * would not prove the old ceiling is gone.
 */

/** Past the old 30 s ceiling, with room for a slow CI runner's scheduling. */
const PAST_THE_OLD_LIMIT_MS = 31_000;

const servers = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

describe("nextConfig", () => {
  it("sets the rewrite proxy's limit explicitly rather than inheriting Next's 30 s", () => {
    // `0` is not "no limit" here: `proxyRequest` reads it as `|| 30000`.
    expect(nextConfig.experimental?.proxyTimeout).toBeGreaterThan(30_000);
  });

  /**
   * The ordering that makes the remaining ceiling a *stated* one. The backend
   * gives up on a model at `AI_GENERATION_TIMEOUT_MS` and answers a 400 saying
   * how long it waited; if the proxy gave up first, the browser would get the
   * proxy's bare 500 instead and the sentence would never arrive. Read from the
   * backend's source by name, because the two packages share no module.
   */
  it("waits longer than the backend waits for an AI provider", () => {
    const source = readFileSync(
      new URL("../../backend/src/ai/llm.provider.ts", import.meta.url),
      "utf8",
    );
    const match = source.match(
      /export const AI_GENERATION_TIMEOUT_MS = ([\d_]+);/,
    );
    expect(match).not.toBeNull();
    const backendDeadline = Number(match[1].replaceAll("_", ""));

    expect(nextConfig.experimental.proxyTimeout).toBeGreaterThan(
      backendDeadline,
    );
  });

  it(
    "carries a backend answer that takes longer than 30 s to the caller intact",
    async () => {
      const body = JSON.stringify({ analysis: "The build ran out of memory." });
      const backend = await listen((req, res) => {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(body);
        }, PAST_THE_OLD_LIMIT_MS);
      });

      // The console, reduced to the one thing a `/backend/*` request does.
      const console_ = await listen((req, res) => {
        void proxyRequest(
          req,
          res,
          parse(`${backend}/ai/analyze-logs`, true),
          undefined,
          undefined,
          nextConfig.experimental?.proxyTimeout,
        ).catch(() => undefined);
      });

      const started = Date.now();
      const response = await fetch(`${console_}/backend/ai/analyze-logs`, {
        method: "POST",
      });

      expect(Date.now() - started).toBeGreaterThanOrEqual(30_000);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
    },
    PAST_THE_OLD_LIMIT_MS + 15_000,
  );
});
