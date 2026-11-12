import { BlockList, isIP } from "node:net";

/**
 * The one header Next's own proxy does not forward.
 *
 * `next.config.ts`'s rewrites are a *server-side* proxy, and
 * `next/dist/server/lib/router-utils/proxy-request.js:26-37` builds its
 * `http-proxy` with `headers: { 'x-forwarded-host': … }` and no `xfwd`, so the
 * backend sees a socket from this process and no claim about the browser at
 * all — its `session.ip_address` and better-auth's sign-in throttle both end up
 * naming this host on every request. The second half is the one that bites: one
 * resolved address for every console user is one rate-limit bucket for the
 * whole install, exhaustible from outside by anyone willing to spend a third of
 * a request per second on `/sign-in`.
 *
 * Next does stamp `x-forwarded-for` from the socket, at
 * `dist/server/base-server.js:577`, but that is the render path — the external
 * rewrite is decided and proxied by the router server before base-server sees
 * the request, which is why the header is missing on exactly the two paths that
 * need it.
 *
 * **Replaced, not appended.** Nothing terminates the connection in front of the
 * console on the topology this project ships (`docs/deploy.md` §3), so a chain
 * arriving here is a claim with nothing behind it — the same argument
 * `AuthController.toWebRequest` makes in its no-proxy-declared branch. The
 * `delete` is not a no-op on a request that carries no such header: it is what
 * makes the assignment below the only way one can arrive.
 *
 * That is not a forgery hole either, and this is the sentence to read before
 * "fixing" it: a browser that sends `x-forwarded-for: 1.2.3.4` produces
 * `<browser>` here, the backend appends its own peer giving
 * `<browser>, 127.0.0.1`, and better-auth strips the trusted loopback hop and
 * stops at the browser. The forged value never enters the chain.
 *
 * **One hop trusted, on the Hosted instance only.** There Traefik
 * terminates TLS on 443 and reaches the console over docker_gwbridge, so the
 * socket peer is Traefik on every request, and replacing the chain with it
 * would put every Hosted sign-in in one rate-limit bucket and one
 * `session.ip_address` — the same collapse, one hop further out. So the Hosted
 * install names that bridge in `CONSOLE_TRUSTED_PROXY` ({@link trustedProxyFrom}),
 * and a request whose peer is inside it has the **last** entry of its chain
 * kept: the address Traefik appended for the connection it accepted. Everything
 * left of it is the browser's own claim (Traefik drops incoming `X-Forwarded-*`
 * from an untrusted client anyway) and is dropped here as well, so exactly one
 * hop is believed. A peer outside the range — anything that reaches the
 * console without going through Traefik — gets the replace rule above, so a
 * forged chain sent straight at the console still never enters it. Unset, as on
 * every Self-hosted install, nothing changes.
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string | undefined} peer the socket's remote address
 * @param {BlockList | null} [trustedProxy] from {@link trustedProxyFrom}
 */
export function stampForwardedFor(headers, peer, trustedProxy = null) {
  const chain = headers["x-forwarded-for"];
  delete headers["x-forwarded-for"];
  if (!peer) return;
  const from = unmapIpv4(peer);
  if (trustedProxy && chain !== undefined && isIn(trustedProxy, from)) {
    const appended = lastEntry(chain);
    if (appended) {
      headers["x-forwarded-for"] = appended;
      return;
    }
  }
  headers["x-forwarded-for"] = from;
}

/**
 * `CONSOLE_TRUSTED_PROXY` — one address or CIDR range, the hop whose
 * `x-forwarded-for` entry the console believes (see {@link stampForwardedFor}).
 * Unset or blank is null: no hop is trusted. Anything else that is not an
 * address or a range is refused at boot rather than ignored, because a typo
 * here would quietly bring the one-bucket collapse back.
 *
 * @param {string | undefined} value
 * @returns {BlockList | null}
 */
export function trustedProxyFrom(value) {
  const text = value?.trim();
  if (!text) return null;
  const [address, prefixText, extra] = text.split("/");
  const family = isIP(address);
  const max = family === 6 ? 128 : 32;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (
    !family ||
    extra !== undefined ||
    (prefixText !== undefined && !/^\d+$/.test(prefixText)) ||
    prefix > max
  ) {
    throw new Error(
      `CONSOLE_TRUSTED_PROXY must be one address or CIDR range, not ${JSON.stringify(value)}`,
    );
  }
  const list = new BlockList();
  list.addSubnet(address, prefix, family === 6 ? "ipv6" : "ipv4");
  return list;
}

function isIn(list, address) {
  const family = isIP(address);
  return family !== 0 && list.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** The rightmost entry, if it is an address; Node joins repeats with ", ". */
function lastEntry(chain) {
  const joined = Array.isArray(chain) ? chain.join(",") : chain;
  const last = unmapIpv4(joined.split(",").pop()?.trim() ?? "");
  return isIP(last) ? last : null;
}

/**
 * `::ffff:198.51.100.9` → `198.51.100.9`. Node hands back the mapped form on a
 * dual-stack listener, and the dotted form is what the backend appends, what
 * better-auth records and what an operator writes in `TRUST_PROXY` — the mirror
 * of `normalizeAddress` in `backend/src/auth/auth.controller.ts`, duplicated
 * across packages because there is nothing shared between them. `::ffff:` with
 * no dot is the hex form and is left alone.
 */
export function unmapIpv4(address) {
  return address.startsWith("::ffff:") && address.includes(".")
    ? address.slice("::ffff:".length)
    : address;
}
