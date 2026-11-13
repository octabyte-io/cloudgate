import { once } from "node:events";
import { createServer, request } from "node:http";
import { parse } from "node:url";

import { getCloneableBody } from "next/dist/server/body-streams.js";
import { proxyRequest } from "next/dist/server/lib/router-utils/proxy-request.js";
import { afterEach, describe, expect, it } from "vitest";

import nextConfig from "../next.config.ts";

/**
 * An upload through the console's rewrite proxy, and how much of it arrives.
 *
 * Before proxying, Next clones every request body
 * (`router-utils/resolve-routes.js`, `getCloneableBody(req,
 * config.experimental.proxyClientMaxBodySize)`), and the clone the rewrite
 * proxy sends on **ends at that limit**: 10 MB unless set
 * (`server/body-streams.js`, Next 16.2.10). The backend, told a longer
 * `content-length`, then waits for bytes that never come until the proxy's
 * `proxyTimeout` drops the socket, and the CLI reads a bare 500 four
 * minutes later (#30). Every `cloudgate deploy` that sends more than 10 MB
 * failed that way, however fast the link.
 *
 * So this drives Next's own clone and proxy, the two calls `router-server.js`
 * makes, with the limit the config sets, and asserts a body past the old
 * 10 MB reaches the backend whole.
 */

/** Past Next's default 10 MB clone limit. */
const PAST_THE_OLD_LIMIT = 12 * 1024 * 1024;

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
  return server.address().port;
}

describe("the console proxy and an upload", () => {
  it(
    "carries an upload past 10 MB to the backend whole",
    async () => {
      const backend = await listen((req, res) => {
        let received = 0;
        req.on("data", (chunk) => {
          received += chunk.length;
        });
        req.on("end", () => res.end(String(received)));
      });

      // The console, reduced to what a `/backend/*` request goes through.
      const console_ = await listen((req, res) => {
        const body = getCloneableBody(
          req,
          nextConfig.experimental?.proxyClientMaxBodySize,
        );
        void proxyRequest(
          req,
          res,
          parse(`http://127.0.0.1:${backend}/applications/app_1/drop`, true),
          undefined,
          body.cloneBodyStream(),
          // Short, so a truncated body fails fast rather than in four minutes.
          2_000,
        ).catch(() => undefined);
      });

      const answer = new Promise((resolve) => {
        const req = request(
          {
            port: console_,
            method: "POST",
            path: "/backend/applications/app_1/drop",
            headers: { "content-length": String(PAST_THE_OLD_LIMIT) },
          },
          async (res) => {
            let text = "";
            for await (const chunk of res) text += chunk;
            resolve({ status: res.statusCode, text });
          },
        );
        req.end(Buffer.alloc(PAST_THE_OLD_LIMIT));
      });

      expect(await answer).toEqual({
        status: 200,
        text: String(PAST_THE_OLD_LIMIT),
      });
    },
    15_000,
  );
});
