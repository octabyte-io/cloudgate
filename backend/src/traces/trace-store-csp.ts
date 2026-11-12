import { createHash } from 'node:crypto';

/**
 * The `sandbox` flags every proxied Trace store response is served under, and
 * the console's frame carries too: scripts, forms and popups, and never
 * `allow-same-origin` or `allow-top-navigation`. The console's
 * `TRACE_STORE_FRAME_SANDBOX` is the same string.
 */
export const TRACE_STORE_SANDBOX = 'allow-scripts allow-forms allow-popups';

/**
 * The policy every proxied Trace store response is served under (ADR-0075).
 *
 * **The security boundary is `sandbox`.** The store runs on the Service's own
 * Server, which on the Hosted instance is the customer's, so what it serves is
 * untrusted: a customer can replace the store with any HTTP server. Served
 * sandboxed without `allow-same-origin`, a page runs in an opaque origin,
 * whatever its scripts are: it cannot read the console, and its requests carry
 * no session (`trace-store-frame.ts` says how they are authorized instead). It
 * is a response header, so a store page opened outside the console's frame is
 * sandboxed all the same, and it is on every response, a script included, so
 * no answer is served without it.
 *
 * The rest is defence in depth, and also keeps an XSS through span data from
 * doing more inside the sandbox than the UI itself can:
 *
 * - **`script-src` has no `'unsafe-inline'` or `'unsafe-eval'`.** Jaeger
 *   2.21.0's UI needs neither: its bundles load from `'self'`, and its one
 *   eval, zod's `Function('')` probe, is in a `try` and falls back. The hashes
 *   are what lets the UI's own inline head scripts run; nothing relies on them
 *   for safety, since the store chose the page they are computed from.
 * - **`base-uri 'self'`, not `'none'`.** The UI's first inline script writes a
 *   `<base href>` of its own path, which `'none'` would refuse and log; an
 *   injected `<base>` pointing anywhere else is still refused.
 * - **Styles may be inline**: the UI's component library sets `style`
 *   attributes, and a style cannot run script.
 */
export function traceStoreContentSecurityPolicy(
  scriptHashes: readonly string[],
): string {
  return [
    "default-src 'none'",
    ["script-src 'self'", ...scriptHashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'none'",
    "object-src 'none'",
    `sandbox ${TRACE_STORE_SANDBOX}`,
  ].join('; ');
}

const HEAD_END = /<\/head\s*>/i;
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SRC_ATTRIBUTE = /(?:^|\s)src\s*=/i;

/**
 * The `'sha256-…'` source of each inline script in an HTML page's head, as
 * the page is served, so the store's own scripts run under
 * `traceStoreContentSecurityPolicy` and a store image bump cannot silently
 * break the page. Computed from the body forwarded, not pinned. A convenience
 * for the UI, not a check: the store wrote the page, so it chose what is
 * hashed, and only the sandbox stands between its scripts and the console.
 *
 * Only the head: the store's scripts are all there (its `<base>` writer and
 * its config), and a script anywhere else in the page is not the store's to
 * vouch for, so it gets no hash and does not run. A page with no head end
 * gets no hash at all. A script with a `src` is `'self'`'s, and its text is
 * ignored by the browser, so it is not hashed.
 */
export function inlineScriptHashes(html: string): string[] {
  const headEnd = html.search(HEAD_END);
  if (headEnd === -1) return [];
  const hashes: string[] = [];
  for (const [, attributes, text] of html.slice(0, headEnd).matchAll(SCRIPT)) {
    if (SRC_ATTRIBUTE.test(attributes)) continue;
    const digest = createHash('sha256').update(text, 'utf8').digest('base64');
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}
