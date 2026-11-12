import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ssoDialsMustBePublic,
  ssoRouteOf,
} from '../../src/auth/sso-dial-scope';
import { OutboundAddressGuard } from '../../src/outbound/outbound-address-guard';
import type { AddressResolver } from '../../src/outbound/outbound-address';
import { selfHostedOwnAddresses } from '../outbound/self-hosted-own-addresses';

/**
 * The SSO plugin fetches with `globalThis.fetch` and takes no fetch of ours,
 * so a Hosted customer's SSO request runs inside the guard's scoped fetch
 * (ADR-0076). These drive the real global fetch against a local listener.
 */
describe('OutboundAddressGuard.runWithGuardedFetch', () => {
  let server: Server;
  let port: number;
  let hits: number;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits += 1;
      res.end('internal');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    hits = 0;
  });

  // `localhost` stands for a name that passed a check once and now resolves
  // onto the box (a rebind): real DNS answers it too, so only the guard stops it.
  const resolve: AddressResolver = (host: string) =>
    Promise.resolve(host === 'localhost' ? ['127.0.0.1'] : []);
  const guard = new OutboundAddressGuard(
    resolve,
    {} as never,
    {} as never,
    selfHostedOwnAddresses,
  );

  it('refuses a fetch whose name resolves to a non-public address, and never connects', async () => {
    await expect(
      guard.runWithGuardedFetch(() => fetch(`http://localhost:${port}/token`)),
    ).rejects.toThrow();
    expect(hits).toBe(0);
  });

  it('refuses a literal loopback address inside the scope', async () => {
    await expect(
      guard.runWithGuardedFetch(() => fetch(`http://127.0.0.1:${port}/`)),
    ).rejects.toThrow();
    expect(hits).toBe(0);
  });

  it('leaves every fetch outside the scope as it was, even one made at the same time', async () => {
    const inside = guard.runWithGuardedFetch(() =>
      fetch(`http://127.0.0.1:${port}/`),
    );
    const outside = fetch(`http://127.0.0.1:${port}/`);

    await expect(inside).rejects.toThrow();
    await expect((await outside).text()).resolves.toBe('internal');
    expect(hits).toBe(1);
  });
});

describe('ssoRouteOf', () => {
  it('names the SSO routes the plugin may dial from, and nothing else', () => {
    expect(ssoRouteOf('/api/auth/sign-in/sso')).toBe('/sign-in/sso');
    expect(ssoRouteOf('/api/auth/sso/callback/acme')).toBe(
      '/sso/callback/acme',
    );
    expect(ssoRouteOf('/api/auth/sign-in/email')).toBeNull();
    expect(ssoRouteOf('/api/auth/get-session')).toBeNull();
    expect(ssoRouteOf('/backend/sso/callback/acme')).toBeNull();
  });
});

describe('ssoDialsMustBePublic', () => {
  const INSTANCE = 'org-instance';
  const deps = (hosted: boolean) => ({
    hosted,
    lookups: {
      organizationOfProvider: (providerId: string) =>
        Promise.resolve(
          providerId === 'staff-idp'
            ? INSTANCE
            : providerId === 'acme'
              ? 'org-acme'
              : null,
        ),
      organizationRoutedTo: () => Promise.resolve('org-acme'),
    },
    mustBePublic: (organizationId: string | null) =>
      Promise.resolve(organizationId !== INSTANCE),
  });

  it("guards a customer's callback, sign-in and registration on the Hosted instance", async () => {
    await expect(
      ssoDialsMustBePublic(
        { path: '/api/auth/sso/callback/acme', body: {} },
        deps(true),
      ),
    ).resolves.toBe(true);
    await expect(
      ssoDialsMustBePublic(
        { path: '/api/auth/sign-in/sso', body: { email: 'a@acme.com' } },
        deps(true),
      ),
    ).resolves.toBe(true);
    await expect(
      ssoDialsMustBePublic(
        {
          path: '/api/auth/sso/register',
          body: { organizationId: 'org-acme' },
        },
        deps(true),
      ),
    ).resolves.toBe(true);
  });

  it('guards a route whose Organization cannot be told', async () => {
    await expect(
      ssoDialsMustBePublic(
        { path: '/api/auth/sso/callback/unknown', body: {} },
        deps(true),
      ),
    ).resolves.toBe(true);
  });

  it("leaves the Instance organization's SSO, non-SSO routes and a Self-hosted instance alone", async () => {
    await expect(
      ssoDialsMustBePublic(
        { path: '/api/auth/sso/callback/staff-idp', body: {} },
        deps(true),
      ),
    ).resolves.toBe(false);
    await expect(
      ssoDialsMustBePublic(
        { path: '/api/auth/sign-in/email', body: {} },
        deps(true),
      ),
    ).resolves.toBe(false);
    await expect(
      ssoDialsMustBePublic(
        { path: '/api/auth/sso/callback/acme', body: {} },
        deps(false),
      ),
    ).resolves.toBe(false);
  });
});
