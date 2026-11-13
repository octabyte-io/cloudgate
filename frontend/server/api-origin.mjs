/**
 * The API's public origin, from `CLOUDGATE_API_URL` (ADR-0082).
 *
 * The browser dials the six gateways there directly — the console proxies no
 * WebSockets — so this is the one address a page needs that is not its own. It
 * is read when the console starts, not when it is built: one build serves
 * every instance, and changing the address is a restart.
 *
 * Here rather than in `src/lib/config.ts` because `server.mjs` refuses a bad
 * value before Next is even prepared, and it runs as plain Node with no
 * TypeScript; the root layout reads it through the same function, so the two
 * cannot disagree about what is acceptable.
 *
 * **Refused, not defaulted, when it is missing.** A default of
 * `http://localhost:4000` is what the old build-time variable fell back to, and
 * it produced a console that signs in and serves REST while every live feed
 * dials the operator's own machine. Anything but `http:` or `https:` is
 * refused too: the gateways are dialled on `ws:` or `wss:`, and there is no
 * other scheme to swap.
 *
 * @param {string | undefined} value
 * @returns {string} the origin, with no trailing slash or path
 */
export function apiOriginFrom(value) {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      "CLOUDGATE_API_URL is not set. Set it to the API's public address, such as http://203.0.113.10:4000, in /etc/default/cloudgate-console on an install, then start the console again.",
    );
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error(
      `CLOUDGATE_API_URL must be an http:// or https:// address, such as http://203.0.113.10:4000, not ${JSON.stringify(value)}.`,
    );
  }
  return parsed.origin;
}
