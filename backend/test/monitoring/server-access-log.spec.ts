import { hideQueryValues } from '../../src/monitoring/access-log.parser';
import {
  platformHostMatcher,
  serviceIdForLine,
  windowFromTail,
} from '../../src/monitoring/server-access-log';
import type {
  DomainRoute,
  PlatformHostRoute,
} from '../../src/monitoring/server-access-log';

/** One access-log line as Traefik writes it; Duration is nanoseconds. */
const line = (startUtc: string, durationMs = 5, path = '/') =>
  JSON.stringify({
    StartUTC: startUtc,
    Duration: durationMs * 1_000_000,
    RequestHost: 'shop.example.com',
    RequestPath: path,
    RequestMethod: 'GET',
    DownstreamStatus: 200,
  });

const window = {
  start: '2026-11-06T10:00:00.000Z',
  end: '2026-11-06T11:00:00.000Z',
};

describe('hideQueryValues', () => {
  it('replaces every query value with *** and keeps the names', () => {
    expect(hideQueryValues('/reset?token=abc123&user=7')).toBe(
      '/reset?token=***&user=***',
    );
  });

  it('keeps a name that carries no value as it is', () => {
    expect(hideQueryValues('/search?q=shoes&debug')).toBe(
      '/search?q=***&debug',
    );
  });

  it('hides an empty value too, so a value is never told from none by length', () => {
    expect(hideQueryValues('/a?b=')).toBe('/a?b=***');
  });

  it('leaves a path with no query untouched', () => {
    expect(hideQueryValues('/health')).toBe('/health');
  });

  it('hides a value that itself holds an equals sign whole', () => {
    expect(hideQueryValues('/x?sig=a=b==')).toBe('/x?sig=***');
  });
});

describe('serviceIdForLine', () => {
  const routes: DomainRoute[] = [
    { serviceId: 'shop', host: 'shop.example.com', path: '/' },
    { serviceId: 'shop-api', host: 'shop.example.com', path: '/api' },
    { serviceId: 'blog', host: 'Blog.Example.com', path: null },
  ];

  it('matches the Domain whose host and longest path prefix the line carries', () => {
    expect(
      serviceIdForLine(
        { RequestHost: 'shop.example.com', RequestPath: '/api/orders?id=1' },
        routes,
      ),
    ).toBe('shop-api');
    expect(
      serviceIdForLine(
        { RequestHost: 'shop.example.com', RequestPath: '/apiary' },
        routes,
      ),
    ).toBe('shop');
  });

  it('matches a host in any case, and with a port', () => {
    expect(
      serviceIdForLine(
        { RequestHost: 'BLOG.example.com:443', RequestPath: '/post/1' },
        routes,
      ),
    ).toBe('blog');
  });

  it('answers null for a host no Domain names, or no host at all', () => {
    expect(
      serviceIdForLine(
        { RequestHost: 'scanner.invalid', RequestPath: '/' },
        routes,
      ),
    ).toBeNull();
    expect(serviceIdForLine({ RequestPath: '/wp-login.php' }, routes)).toBe(
      null,
    );
  });
});

// ADR-0061: the platform host's log is matched against every Organization's
// Domains there, and a host two Organizations hold is matched by neither.
describe('platformHostMatcher', () => {
  const routes: PlatformHostRoute[] = [
    {
      organizationId: 'a',
      serviceId: 'shop',
      host: 'shop.example.com',
      path: '/',
    },
    {
      organizationId: 'a',
      serviceId: 'shop-api',
      host: 'shop.example.com',
      path: '/api',
    },
    {
      organizationId: 'b',
      serviceId: 'docs',
      host: 'docs.example.com',
      path: null,
    },
    {
      organizationId: 'a',
      serviceId: 'store',
      host: 'Store.example.com',
      path: '/',
    },
    {
      organizationId: 'b',
      serviceId: 'store-blog',
      host: 'store.example.com',
      path: '/blog',
    },
  ];
  const match = platformHostMatcher(routes);

  it("matches a host one Organization holds by its longest path prefix, whichever Organization's it is", () => {
    expect(
      match({ RequestHost: 'shop.example.com', RequestPath: '/api/x?id=***' }),
    ).toEqual({ kind: 'service', serviceId: 'shop-api' });
    expect(
      match({ RequestHost: 'shop.example.com', RequestPath: '/' }),
    ).toEqual({ kind: 'service', serviceId: 'shop' });
    expect(
      match({ RequestHost: 'docs.example.com', RequestPath: '/' }),
    ).toEqual({ kind: 'service', serviceId: 'docs' });
  });

  it('matches no Service on a host two Organizations hold, on any path, and names the host', () => {
    for (const path of ['/blog/x', '/', '/cart']) {
      expect(
        match({ RequestHost: 'STORE.example.com:443', RequestPath: path }),
      ).toMatchObject({ kind: 'shared', host: 'store.example.com' });
    }
  });

  // Rule 7 of #1337: the Instance organization's authority reads every line
  // with its Service named where it matched, a shared host's included. Only
  // that reader is handed `routedTo`; everyone else gets `shared`.
  it("says which Service a shared host's line is routed to, by its longest path prefix across every Organization", () => {
    const at = (path: string) =>
      match({ RequestHost: 'store.example.com', RequestPath: path });
    expect(at('/blog/x')).toEqual({
      kind: 'shared',
      host: 'store.example.com',
      routedTo: 'store-blog',
    });
    expect(at('/cart')).toEqual({
      kind: 'shared',
      host: 'store.example.com',
      routedTo: 'store',
    });
  });

  it('matches nothing for a host no Domain names, or no host at all', () => {
    expect(match({ RequestHost: 'scanner.invalid', RequestPath: '/' })).toEqual(
      {
        kind: 'none',
      },
    );
    expect(match({ RequestPath: '/wp-login.php' })).toEqual({ kind: 'none' });
  });

  it('does not count two Services of one Organization on a host as shared', () => {
    expect(
      match({ RequestHost: 'shop.example.com', RequestPath: '/apiary' }),
    ).toEqual({ kind: 'service', serviceId: 'shop' });
  });
});

describe('windowFromTail', () => {
  it('drops the first, cut line of a read that did not start at the top of the file', () => {
    const whole = `${line('2026-11-06T10:10:00Z')}\n${line('2026-11-06T10:20:00Z')}\n`;
    const cut = whole.slice(20);

    const read = windowFromTail({ text: cut, fromStart: false }, window);

    expect(read.rows.map((row) => row.StartUTC)).toEqual([
      '2026-11-06T10:20:00Z',
    ]);
  });

  it('keeps only lines whose request started inside the window', () => {
    const text = [
      line('2026-11-06T09:59:00Z'),
      line('2026-11-06T10:30:00Z'),
      line('2026-11-06T11:30:00Z'),
    ].join('\n');

    const read = windowFromTail({ text, fromStart: true }, window);

    expect(read.rows.map((row) => row.StartUTC)).toEqual([
      '2026-11-06T10:30:00Z',
    ]);
  });

  it('says how far back it reached when the whole file was read and starts inside the window', () => {
    const text = [
      line('2026-11-06T10:40:00Z', 0),
      line('2026-11-06T10:50:00Z', 0),
    ].join('\n');

    const read = windowFromTail({ text, fromStart: true }, window);

    expect(read.retainedFrom).toBe('2026-11-06T10:40:00.000Z');
  });

  it('says how far back it reached when the read bound cut it off inside the window', () => {
    const text = [
      line('2026-11-06T10:20:00Z', 0),
      line('2026-11-06T10:30:00Z', 0),
      line('2026-11-06T10:45:00Z', 0),
    ].join('\n');

    const read = windowFromTail({ text, fromStart: false }, window);

    // The first line is the cut one, so what is held starts at the second.
    expect(read.retainedFrom).toBe('2026-11-06T10:30:00.000Z');
  });

  it('says nothing about retention once it walked past the start of the window', () => {
    const before = Array.from({ length: 105 }, () =>
      line('2026-11-06T09:00:00Z', 0),
    );
    const text = [...before, line('2026-11-06T10:30:00Z')].join('\n');

    const read = windowFromTail({ text, fromStart: false }, window);

    expect(read.retainedFrom).toBeUndefined();
    expect(read.rows).toHaveLength(1);
  });

  it('counts a long request that started inside the window and landed behind older lines', () => {
    // Started 10:59, ran 30 minutes, so Traefik wrote it at 11:29 — after a
    // run of requests that started and finished after the window.
    const after = Array.from({ length: 150 }, () =>
      line('2026-11-06T11:10:00Z', 1),
    );
    const text = [
      line('2026-11-06T10:59:00Z', 30 * 60 * 1000, '/download'),
      ...after,
    ].join('\n');

    const read = windowFromTail({ text, fromStart: true }, window);

    expect(read.rows.map((row) => row.RequestPath)).toEqual(['/download']);
  });

  it('reads an empty file as no rows and no retention', () => {
    expect(windowFromTail({ text: '', fromStart: true }, window)).toEqual({
      rows: [],
    });
  });
});
