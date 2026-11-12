import type { FetchClient } from '../git-providers/fetch.provider';
import { CATALOGUE_MAX_BYTES } from './check';

/** How long one check of the catalogue may take, redirects and body included. */
export const CATALOGUE_TIMEOUT_MS = 10_000;

/** Redirects followed before the address is called unreachable. */
const MAX_REDIRECTS = 5;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** What one check of the catalogue address came to. */
export type CatalogueDownload =
  /** The address names the release already held, so no body was read. */
  | { readonly kind: 'held' }
  | {
      readonly kind: 'fetched';
      readonly bytes: Uint8Array;
      /**
       * Where a `latest` address redirected to; else the file's validator
       * (`etag "…"` or `last-modified …`); null with neither.
       */
      readonly release: string | null;
    }
  | {
      readonly kind: 'unreachable';
      /** The 10-second deadline passed: a 504 rather than a 502. */
      readonly timedOut: boolean;
      readonly message: string;
    }
  /** What the address served is too large to be a catalogue. */
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Reads the catalogue at `url`, unless it is a release already held.
 *
 * **Release identity is the first redirect.** A `cg-templates` release is
 * immutable, and `…/releases/latest/download/catalogue.zip` answers a 302 to
 * `…/releases/download/<tag>/catalogue.zip` before anything else. Redirects
 * are followed by hand so that hop is read before any body: a check that finds
 * the tag already held stops there (ADR-0062: a version already held is never
 * fetched again). An address that does not redirect, such as a mirror
 * serving one file in place, is held by the file's `ETag`, else its
 * `Last-Modified`: the check asks with `If-None-Match` or
 * `If-Modified-Since`, and a 304, or the same validator from a mirror that
 * ignores the condition, reads no body. Only a mirror that sends neither is
 * read in full on each check.
 *
 * **The 10 MB cap is applied while reading**, not after: a `content-length`
 * past it is refused before the body, and a body that runs past it without
 * one is cut off there, so an oversize file is never held in full.
 *
 * Every hop must stay on http or https, the rule the setting itself has.
 */
export async function downloadCatalogue(
  fetchClient: FetchClient,
  url: string,
  heldRelease: string | null,
): Promise<CatalogueDownload> {
  const host = hostOf(url);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CATALOGUE_TIMEOUT_MS);
  const unreachable = (why: string): CatalogueDownload => ({
    kind: 'unreachable',
    timedOut,
    message: timedOut
      ? `The template catalogue at ${host} did not answer within ${CATALOGUE_TIMEOUT_MS / 1000} seconds`
      : `The template catalogue at ${host} could not be reached: ${why}`,
  });

  try {
    let address = url;
    let release: string | null = null;
    for (let hop = 0; ; hop++) {
      const response = await fetchClient(address, {
        redirect: 'manual',
        signal: controller.signal,
        // Asked of the address itself only: a redirect's target is a
        // release, whose identity is its address.
        ...(hop === 0 ? { headers: conditionsFor(heldRelease) } : {}),
      });
      if (hop === 0 && response.status === 304 && heldRelease !== null) {
        await response.body?.cancel();
        return { kind: 'held' };
      }
      const location = response.headers.get('location');
      if (REDIRECTS.has(response.status) && location) {
        await response.body?.cancel();
        if (hop === MAX_REDIRECTS) return unreachable('too many redirects');
        const next = new URL(location, address);
        if (next.protocol !== 'https:' && next.protocol !== 'http:') {
          return unreachable(`it redirected to a ${next.protocol} address`);
        }
        address = next.toString();
        if (hop === 0) {
          release = address;
          if (release === heldRelease) return { kind: 'held' };
        }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return unreachable(`it answered HTTP ${response.status}`);
      }
      if (hop === 0) {
        // No redirect: the file's own validator is its identity, and a
        // mirror that ignored the condition but names the same one is held.
        release = validatorOf(response.headers);
        if (release !== null && release === heldRelease) {
          await response.body?.cancel();
          return { kind: 'held' };
        }
      }
      const bytes = await readCapped(response, controller);
      if (bytes === null) {
        return {
          kind: 'refused',
          reason: `The template catalogue at ${host} is larger than ${CATALOGUE_MAX_BYTES / (1024 * 1024)} MB; a catalogue is at most that`,
        };
      }
      return { kind: 'fetched', bytes, release };
    }
  } catch (error) {
    return unreachable(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

const ETAG = 'etag ';
const LAST_MODIFIED = 'last-modified ';

/**
 * A copy's identity from the file's own response, for an address that does
 * not redirect: its `ETag`, else its `Last-Modified`, prefixed with which it
 * is so the next check asks the matching condition. Null with neither.
 */
function validatorOf(headers: Headers): string | null {
  const etag = headers.get('etag');
  if (etag) return `${ETAG}${etag}`;
  const modified = headers.get('last-modified');
  return modified ? `${LAST_MODIFIED}${modified}` : null;
}

/** The condition that asks for the file only if it is not the copy held. */
function conditionsFor(held: string | null): Record<string, string> {
  if (held?.startsWith(ETAG)) {
    return { 'if-none-match': held.slice(ETAG.length) };
  }
  if (held?.startsWith(LAST_MODIFIED)) {
    return { 'if-modified-since': held.slice(LAST_MODIFIED.length) };
  }
  return {};
}

/** The body, or null as soon as it is known to be past the cap. */
async function readCapped(
  response: Response,
  controller: AbortController,
): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > CATALOGUE_MAX_BYTES) {
    controller.abort();
    return null;
  }
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    return whole.byteLength > CATALOGUE_MAX_BYTES ? null : whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CATALOGUE_MAX_BYTES) {
      await reader.cancel();
      controller.abort();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
