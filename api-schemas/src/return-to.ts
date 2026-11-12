import { z } from 'zod';

/**
 * A `returnTo`: where the console sends someone back to after they leave it
 * for a page Cloudgate does not own (Stripe Checkout), as a path on the
 * console's own origin. The backend prefixes it with `SITE_URL`, so a value
 * that a browser would read as a host instead of a path would make the
 * Checkout's return an open redirect off a Stripe page the person trusts.
 *
 * The rules match the console's `safeNextPath`, which judges `?next=` the same
 * way, and refuse rather than fall back, because a body is not an address bar
 * and a wrong value is the caller's bug:
 *
 * - it starts with `/`, so `https://evil.example` and `javascript:` fail;
 * - its second character is neither `/` nor `\`, since browsers read `//` and
 *   `/\` (a backslash is normalised to `/`) as the start of a host;
 * - it holds no whitespace or control character, which browsers strip before
 *   resolving and so can hide one of the two above.
 *
 * A query string and a fragment are kept: they are part of where someone was.
 */
export const returnToSchema = z
  .string()
  .max(2000, 'returnTo is at most 2000 characters')
  .refine((value) => value.startsWith('/'), {
    message: 'returnTo must be a path on this site, starting with /',
  })
  .refine((value) => value[1] !== '/' && value[1] !== '\\', {
    message: 'returnTo must be a path on this site, not another address',
  })
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\s\u0000-\u001f\u007f]/.test(value), {
    message: 'returnTo cannot hold spaces or control characters',
  });

export type ReturnTo = z.infer<typeof returnToSchema>;

/**
 * The same `returnTo` with `checkout=<outcome>` added to its query string, so
 * the page Checkout returns to can tell a paid return from a cancelled one.
 * A fragment stays last, where a browser expects it.
 */
export function withCheckoutOutcome(
  returnTo: ReturnTo,
  outcome: 'success' | 'cancelled',
): string {
  const hashAt = returnTo.indexOf('#');
  const path = hashAt === -1 ? returnTo : returnTo.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : returnTo.slice(hashAt);
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}checkout=${outcome}${hash}`;
}
