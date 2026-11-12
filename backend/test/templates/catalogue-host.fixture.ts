import { catalogueZip } from './zip.fixture';

/**
 * A stubbed catalogue host for the catalogue reader's e2e suites: fixture
 * `catalogue.zip` releases (ADR-0072), served the way GitHub serves a
 * `latest` release download, or in place by a mirror, behind the
 * `FETCH_CLIENT` the reader dials through.
 */

/** The official address, written out rather than imported (§1.7). */
export const LATEST =
  'https://github.com/octabyte-io/cg-templates/releases/latest/download/catalogue.zip';

/** Where `latest` redirects for a release tag. */
export const releaseUrl = (tag: string) =>
  `https://github.com/octabyte-io/cg-templates/releases/download/${tag}/catalogue.zip`;

/** Where a release download redirects to, as GitHub's asset host does. */
const assetUrl = (tag: string) =>
  `https://release-assets.githubusercontent.com/${tag}/catalogue.zip?signed=1`;

export const SQUARE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30"/></svg>';

/** One template folder: its id and its files by path. */
export interface Folder {
  readonly id: string;
  readonly revision?: string;
  readonly files: Record<string, string>;
}

/** A readable template with no compose part: one own `web`. */
export function webTemplate(
  id: string,
  overrides: { name?: string; tags?: string[]; cloudgate?: string } = {},
): Folder {
  return {
    id,
    files: {
      'template.yaml': `name: ${overrides.name ?? 'Uptime Kuma'}
description: A self-hosted monitoring tool.
version: "1.23"
tags: [${(overrides.tags ?? ['monitoring']).join(', ')}]
links:
  website: https://uptime.kuma.pet
  source: https://github.com/louislam/uptime-kuma
cloudgate: ${overrides.cloudgate ?? '0.1.0'}
`,
      'cloudgate.yaml': `version: 1
services:
  app:
    kind: web
    source: { image: "louislam/uptime-kuma:1.23" }
`,
      'logo.svg': SQUARE_SVG,
    },
  };
}

/**
 * The bytes of a `catalogue.zip` holding `folders`, written by the test's
 * own zip writer rather than the source's `encodeCatalogue` (§1.7).
 */
export function catalogueFile(...folders: Folder[]): Buffer {
  return catalogueZip(folders);
}

/**
 * The bytes of a format-1 `catalogue.json` holding `folders`: what a
 * `cg-templates` release published before ADR-0072, and what a mirror not
 * yet updated still serves.
 */
export function legacyCatalogueJson(...folders: Folder[]): string {
  return JSON.stringify({
    format: 1,
    templates: folders.map((folder) => ({
      id: folder.id,
      revision: folder.revision ?? 'c0ffee1',
      files: folder.files,
    })),
  });
}

/**
 * A mirror's address: one file served in place, held by its `ETag`, with no
 * release to redirect to.
 */
export const MIRROR = 'https://mirror.example.internal/catalogue.zip';

/** What the stubbed host answers for one release's body. */
export type Served =
  | {
      readonly body: string | Uint8Array;
      readonly headers?: Record<string, string>;
    }
  | { readonly status: number }
  | { readonly fails: string }
  /** Never answers, until the reader gives up and aborts. */
  | { readonly hangs: true };

/**
 * A `FETCH_CLIENT` double serving GitHub's `latest` chain:
 * `LATEST` → 302 `releaseUrl(tag)` → 302 asset → 200 body. `release` names the
 * tag `latest` points at and `served` what its asset answers; `unreachable`
 * makes the first request fail as a refused connection does.
 *
 * `MIRROR` answers `served` in place, with `release` as its `ETag`, and a
 * 304 to an `If-None-Match` naming it.
 */
export class CatalogueHost {
  release = 'v1';
  served: Served = { body: catalogueFile() };
  unreachable = false;
  /** Every address asked for, in order. */
  readonly asked: string[] = [];
  private bodies = 0;

  reset(): void {
    this.release = 'v1';
    this.served = { body: catalogueFile() };
    this.unreachable = false;
    this.asked.length = 0;
    this.bodies = 0;
  }

  /** Bodies read: asset and mirror requests answered 200, not redirects. */
  bodiesRead(): number {
    return this.bodies;
  }

  readonly fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const url = input;
    this.asked.push(url);
    if (this.unreachable) {
      return Promise.reject(new TypeError('fetch failed'));
    }
    if (url === LATEST)
      return Promise.resolve(redirect(releaseUrl(this.release)));
    const tag = /\/releases\/download\/([^/]+)\//.exec(url)?.[1];
    if (tag) return Promise.resolve(redirect(assetUrl(tag)));
    const etag = `"${this.release}"`;
    if (
      url === MIRROR &&
      new Headers(init?.headers).get('if-none-match') === etag
    ) {
      return Promise.resolve(
        new Response(null, { status: 304, headers: { etag } }),
      );
    }
    if (
      url === MIRROR ||
      url.startsWith('https://release-assets.githubusercontent.com/')
    ) {
      const served = this.served;
      if ('fails' in served) return Promise.reject(new TypeError(served.fails));
      if ('hangs' in served) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(
              new DOMException('This operation was aborted', 'AbortError'),
            ),
          );
        });
      }
      if ('status' in served) {
        return Promise.resolve(new Response('nope', { status: served.status }));
      }
      this.bodies += 1;
      return Promise.resolve(
        new Response(new Uint8Array(Buffer.from(served.body)), {
          status: 200,
          headers: { ...(url === MIRROR ? { etag } : {}), ...served.headers },
        }),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}
