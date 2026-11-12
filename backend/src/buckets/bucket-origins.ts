import { BadRequestException } from '@nestjs/common';

// A bucket's browser-upload origins: the web origins an operator
// trusts to upload to it straight from a browser. Pure, so what is refused
// and how a list is read is tested without a Server.

/**
 * A host a browser can name: DNS labels of letters, digits and hyphens (a
 * name or an IPv4 address), or a bracketed IPv6 address. The URL parser
 * lets through `*`, `&` and quotes, none of which an origin ever holds.
 */
const HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/;

/**
 * What a trusted origin may do on the bucket from a browser: read,
 * upload — a single PUT, a POST form or a multipart upload — and ask for an
 * object's headers, with any request header, seeing the ETag a multipart
 * upload needs back. The same on a Server's Garage and on S3.
 */
export const BUCKET_CORS_METHODS = ['GET', 'PUT', 'POST', 'HEAD'] as const;

/** The response header a browser may read: a multipart upload's ETag. */
export const BUCKET_CORS_EXPOSED_HEADERS = ['ETag'] as const;

/** How many origins one bucket trusts at most. */
export const MAX_BUCKET_ORIGINS = 50;

/**
 * One web origin as a browser sends it in `Origin`: `http` or `https`, a
 * host, an optional port — no path, query, fragment, user or wildcard. It is
 * compared byte for byte by Garage and S3, so anything a browser would never
 * send (`HTTPS://App.example.com`, a trailing slash, the default port) is
 * refused rather than saved as a rule that can never match. Throws a 400
 * naming the origin (ADR-0005).
 */
export function parseBrowserOrigin(raw: string): string {
  const written = raw.trim();
  let url: URL | null = null;
  try {
    url = new URL(written);
  } catch {
    url = null;
  }
  if (
    url === null ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.origin !== written ||
    !HOST.test(url.hostname)
  ) {
    throw new BadRequestException(
      `${JSON.stringify(written)} is not a web origin — write it as a browser sends it, scheme://host or scheme://host:port, with no path`,
    );
  }
  return written;
}

/**
 * A bucket's whole new origin list: each one {@link parseBrowserOrigin}'s,
 * a repeat kept once, in the order written. More than
 * {@link MAX_BUCKET_ORIGINS} is refused.
 */
export function parseBucketOrigins(raw: readonly string[]): string[] {
  const origins = Array.from(new Set(raw.map(parseBrowserOrigin)));
  if (origins.length > MAX_BUCKET_ORIGINS) {
    throw new BadRequestException(
      `A bucket trusts at most ${MAX_BUCKET_ORIGINS} origins`,
    );
  }
  return origins;
}
