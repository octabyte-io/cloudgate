import { downloadCatalogue } from '../../src/templates/catalogue-download';
import { catalogueZip } from './zip.fixture';

/** A mirror serving one file in place, with no release to redirect to. */
const MIRROR = 'https://mirror.example.internal/catalogue.zip';

/** A `catalogue.zip` with no templates: bytes that are not UTF-8 text. */
const BODY = catalogueZip([]);

/**
 * A mirror that answers `validators` beside its body, and a 304 to a
 * request whose `If-None-Match` or `If-Modified-Since` matches them unless
 * it `ignoresConditions`. Records each request's headers.
 */
function mirror(
  validators: Record<string, string>,
  options: { ignoresConditions?: boolean } = {},
) {
  const asked: Headers[] = [];
  let bodiesRead = 0;
  const fetch = (_url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    asked.push(headers);
    const matches =
      (validators.etag !== undefined &&
        headers.get('if-none-match') === validators.etag) ||
      (validators['last-modified'] !== undefined &&
        headers.get('if-modified-since') === validators['last-modified']);
    if (matches && !options.ignoresConditions) {
      return Promise.resolve(
        new Response(null, { status: 304, headers: validators }),
      );
    }
    // Pulled only when read: no chunk is queued ahead of a reader.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodiesRead += 1;
          controller.enqueue(new Uint8Array(BODY));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    return Promise.resolve(
      new Response(body, { status: 200, headers: validators }),
    );
  };
  return { fetch, asked, bodiesRead: () => bodiesRead };
}

describe('downloadCatalogue on an address that does not redirect', () => {
  it('holds the copy by its ETag, and a 304 to it reads no body (ADR-0062: a version already held is never fetched again)', async () => {
    const host = mirror({ etag: '"v1"' });

    const first = await downloadCatalogue(host.fetch, MIRROR, null);
    expect(first).toEqual({
      kind: 'fetched',
      bytes: expect.any(Uint8Array) as unknown,
      release: 'etag "v1"',
    });
    // The zip's bytes as served, none changed on the way.
    expect(
      first.kind === 'fetched' && Buffer.from(first.bytes).equals(BODY),
    ).toBe(true);

    const again = await downloadCatalogue(host.fetch, MIRROR, 'etag "v1"');
    expect(again).toEqual({ kind: 'held' });
    expect(host.asked[1].get('if-none-match')).toBe('"v1"');
    expect(host.bodiesRead()).toBe(1);
  });

  it('reads no body when the mirror ignores the condition and answers the same ETag', async () => {
    const host = mirror({ etag: '"v1"' }, { ignoresConditions: true });

    expect(await downloadCatalogue(host.fetch, MIRROR, 'etag "v1"')).toEqual({
      kind: 'held',
    });
    expect(host.bodiesRead()).toBe(0);
  });

  it('reads a changed file in full, under its new ETag', async () => {
    const host = mirror({ etag: '"v2"' });

    expect(await downloadCatalogue(host.fetch, MIRROR, 'etag "v1"')).toEqual({
      kind: 'fetched',
      bytes: expect.any(Uint8Array) as unknown,
      release: 'etag "v2"',
    });
  });

  it('holds the copy by its Last-Modified when the mirror sends no ETag', async () => {
    const stamp = 'Tue, 10 Nov 2026 08:00:00 GMT';
    const host = mirror({ 'last-modified': stamp });

    const first = await downloadCatalogue(host.fetch, MIRROR, null);
    expect(first).toMatchObject({ release: `last-modified ${stamp}` });

    expect(
      await downloadCatalogue(host.fetch, MIRROR, `last-modified ${stamp}`),
    ).toEqual({ kind: 'held' });
    expect(host.asked[1].get('if-modified-since')).toBe(stamp);
    expect(host.bodiesRead()).toBe(1);
  });

  it('has no identity when the mirror sends neither, and is read in full each time', async () => {
    const host = mirror({});

    expect(await downloadCatalogue(host.fetch, MIRROR, null)).toMatchObject({
      kind: 'fetched',
      release: null,
    });
    expect(host.asked[0].get('if-none-match')).toBeNull();
  });
});
