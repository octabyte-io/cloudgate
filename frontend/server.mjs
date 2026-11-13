import { createServer } from "node:http";

import next from "next";

import { apiOriginFrom } from "./server/api-origin.mjs";
import {
  stampForwardedFor,
  trustedProxyFrom,
} from "./server/forwarded-for.mjs";

/**
 * `next start` with one line added: the browser's address, on the header Next's
 * own proxy omits. See `server/forwarded-for.mjs` for what omits it and
 * why replacing rather than appending is the right rule here.
 *
 * `.mjs` so it works whatever `package.json` says about `type`, and because
 * `NextCustomServer.prepare()` initialises the request handler through the very
 * same `getRequestHandlers` from `./lib/start-server` that `next start` uses
 * (`next/dist/server/next.js:292-311`) — so external rewrites keep working and
 * `http-proxy` copies the `req.headers` stamped below.
 *
 * No `hostname` is passed: `next start` binds every interface and `listen(port)`
 * matches it. No `upgrade` handling either — the console proxies no WebSockets;
 * the six gateways are dialled straight at `backendOrigin()` (`src/lib/config.ts`).
 */
/**
 * Refused rather than coerced. `Number('')` is `0` and `Number('http://…')` is
 * `NaN`, and `listen()` treats both as "any free port" — so a blank or fat-
 * fingered `PORT` in `/etc/default/cloudgate-console` would start the console
 * on an arbitrary port, report success, and leave Traefik and systemd pointing
 * at nothing. A boot that cannot honour its own port is not a boot.
 */
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(
    `PORT must be a whole number from 1 to 65535, not ${JSON.stringify(process.env.PORT)}`,
  );
}
// The API's public address, which every page is handed for its live screens
// (ADR-0082). Read at start, not at build, so changing it is a restart; and a
// console with none, or one that is not http(s), does not start at all.
apiOriginFrom(process.env.CLOUDGATE_API_URL);
// The Hosted instance's Traefik hop; unset Self-hosted. Read once and
// refused at boot if malformed, like PORT above.
const trustedProxy = trustedProxyFrom(process.env.CONSOLE_TRUSTED_PROXY);

const app = next({ dev: false });
const handle = app.getRequestHandler();

await app.prepare();
createServer((req, res) => {
  stampForwardedFor(req.headers, req.socket?.remoteAddress, trustedProxy);
  void handle(req, res);
}).listen(port);
