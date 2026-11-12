import type { LogEntry } from '../../src/monitoring/access-log.parser';
import { platformHostRows } from '../../src/monitoring/platform-host-requests';
import type { PlatformHostService } from '../../src/monitoring/platform-host-requests';
import type { DomainRoute } from '../../src/monitoring/server-access-log';

/**
 * The platform host's per-line split (ADR-0061): Organization A holds
 * `store.example.com/` and `shop.example.com`, B holds
 * `store.example.com/blog`, so `store.example.com` is shared.
 */
const services: PlatformHostService[] = [
  { serviceId: 'store', name: 'store', organizationId: 'a' },
  { serviceId: 'shop', name: 'shop', organizationId: 'a' },
  { serviceId: 'blog', name: 'blog', organizationId: 'b' },
];
const routes: DomainRoute[] = [
  { serviceId: 'store', host: 'store.example.com', path: '/' },
  { serviceId: 'shop', host: 'shop.example.com', path: null },
  { serviceId: 'blog', host: 'store.example.com', path: '/blog' },
];
const line = (host: string | undefined, path: string): LogEntry =>
  ({
    StartUTC: '2026-11-06T10:00:00Z',
    RequestHost: host,
    RequestPath: path,
  }) as LogEntry;
const lines = [
  line('store.example.com', '/blog/x'),
  line('store.example.com', '/cart'),
  line('shop.example.com', '/?token=s3cret'),
  line('scanner.invalid', '/'),
];
const serviceOf = (rows: { RequestHost?: string; service?: unknown }[]) =>
  rows.map((row) => [row.RequestHost, row.service]);

describe('platformHostRows', () => {
  it("names a shared host's line by the route Traefik took, for the Instance organization's authority", () => {
    const { rows, withheldShared } = platformHostRows(lines, services, routes, {
      instance: true,
      readableIds: new Set(),
      chosen: null,
    });

    expect(serviceOf(rows)).toEqual([
      ['store.example.com', { serviceId: 'blog', name: 'blog' }],
      ['store.example.com', { serviceId: 'store', name: 'store' }],
      ['shop.example.com', { serviceId: 'shop', name: 'shop' }],
      ['scanner.invalid', null],
    ]);
    expect(withheldShared).toBe(0);
  });

  it("filters the instance's read by the Service a shared line was routed to, and withholds nothing", () => {
    const { rows, withheldShared } = platformHostRows(lines, services, routes, {
      instance: true,
      readableIds: new Set(),
      chosen: { serviceIds: new Set(['blog']), noService: false },
    });

    expect(serviceOf(rows)).toEqual([
      ['store.example.com', { serviceId: 'blog', name: 'blog' }],
    ]);
    expect(withheldShared).toBe(0);
  });

  it('withholds a shared host from its Organizations, counting it, and hides query values', () => {
    const { rows, withheldShared } = platformHostRows(lines, services, routes, {
      instance: false,
      readableIds: new Set(['store', 'shop']),
      chosen: null,
    });

    expect(serviceOf(rows)).toEqual([
      ['shop.example.com', { serviceId: 'shop', name: 'shop' }],
    ]);
    expect(rows[0].RequestPath).toBe('/?token=***');
    expect(withheldShared).toBe(2);
  });

  it('counts no withheld line for a read whose Services hold no shared host', () => {
    const { withheldShared } = platformHostRows(lines, services, routes, {
      instance: false,
      readableIds: new Set(['store', 'shop']),
      chosen: { serviceIds: new Set(['shop']), noService: false },
    });

    expect(withheldShared).toBe(0);
  });
});
