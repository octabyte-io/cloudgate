import type { ModuleRef } from '@nestjs/core';
import { BadRequestException } from '@nestjs/common';

import { DomainsService } from '../../src/domains/domains.service';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { webServerSettings } from '../../src/db/schema';
import { server } from '../../src/servers/server.schema';
import type {
  PermissionCtx,
  PermissionService,
} from '../../src/rbac/permission.service';
import type { TraefikAppConfigService } from '../../src/traefik/app-config.service';

/**
 * Which address a generated `sslip.io` host carries, on the platform host.
 *
 * `generateDomain` read the address off the Server row and nothing else, so
 * `serverId === null` — the default for a new Application, "This Cloudgate
 * host" — always minted `<app>-<hash>.sslip.io`: a name with no address in it,
 * which sslip.io answers with nothing. The instance records its own public
 * address on the `web_server_settings` singleton (Settings → Instance) and the
 * method never looked.
 *
 * What is pinned here is the *shape of the name*, which is all this seam
 * decides. Whether the host then resolves is DNS's answer and needs a live
 * resolver; `domains.e2e-spec.ts` covers the route, not the address.
 *
 * Written against the reads the method makes rather than through Postgres, on
 * `domain-parent-insert.spec.ts`' terms.
 */

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

/** The Server row `checkServerAccess` answers with, when one is asked for. */
const SERVER_ROW = { serverId: 'server-1', ipAddress: '203.0.113.42' };

/**
 * The two reads `generateDomain` can make: the Server row, and the settings
 * singleton the platform host's address lives on. `settings` is the whole
 * table's contents, so `[]` is an instance that has never saved its settings.
 */
const makeDb = (settings: { serverIp: string | null }[]) => {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === server) return [SERVER_ROW];
    if (table === webServerSettings) return settings;
    throw new Error('unexpected table read');
  };

  const select = () => ({
    from: (table: unknown) => {
      const rows = rowsFor(table);
      const chain = {
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(rows),
      };
      return chain;
    },
  });

  return { select } as unknown as DrizzleDB;
};

function makeService(settings: { serverIp: string | null }[]): DomainsService {
  return new DomainsService(
    makeDb(settings),
    {
      checkPermission: jest.fn().mockResolvedValue(undefined),
    } as unknown as PermissionService,
    {
      regenerate: jest.fn().mockResolvedValue(undefined),
    } as unknown as TraefikAppConfigService,
    // Reached only by a Domain on a Service in a Cloud account.
    {} as ModuleRef,
  );
}

describe('DomainsService.generateDomain, on the platform host', () => {
  it("carries the instance's own recorded address, in the shape a Server row gets", async () => {
    const domains = makeService([{ serverIp: '203.0.113.42' }]);

    const platform = await domains.generateDomain(ctx, 'blog', null);
    const onServer = await domains.generateDomain(ctx, 'blog', 'server-1');

    // The same address, written the same way, from the two paths — the point
    // of reusing one construction rather than a second copy of the dashing.
    expect(platform).toMatch(/^blog-[0-9a-f]{6}-203-0-113-42\.sslip\.io$/);
    expect(onServer).toMatch(/^blog-[0-9a-f]{6}-203-0-113-42\.sslip\.io$/);
  });

  it('refuses rather than minting a name with no address in it', async () => {
    const domains = makeService([{ serverIp: null }]);

    // The old answer was `blog-<hash>.sslip.io`, offered as a working host.
    await expect(domains.generateDomain(ctx, 'blog', null)).rejects.toThrow(
      BadRequestException,
    );
    await expect(domains.generateDomain(ctx, 'blog', null)).rejects.toThrow(
      /Settings → Instance/,
    );
  });

  it('refuses on a fresh instance that has no settings row yet', async () => {
    const domains = makeService([]);

    await expect(domains.generateDomain(ctx, 'blog', null)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('refuses an address sslip.io cannot answer from', async () => {
    // The field takes "an IP or a hostname" (Settings → Instance), and a
    // hostname dashed into an sslip.io name resolves to nothing exactly like
    // the empty one did — the bug this issue is about, one setting later.
    const domains = makeService([{ serverIp: 'console.example.com' }]);

    await expect(domains.generateDomain(ctx, 'blog', null)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('dashes an IPv6 address the way the Server path does', async () => {
    const domains = makeService([{ serverIp: '2001:db8::1' }]);

    expect(await domains.generateDomain(ctx, 'blog', null)).toMatch(
      /^blog-[0-9a-f]{6}-2001-db8--1\.sslip\.io$/,
    );
  });

  it('truncates the application name to 40 characters, as before', async () => {
    const domains = makeService([{ serverIp: '203.0.113.42' }]);

    const generated = await domains.generateDomain(ctx, 'a'.repeat(60), null);

    expect(generated).toMatch(/^a{40}-[0-9a-f]{6}-203-0-113-42\.sslip\.io$/);
  });
});

describe('DomainsService.generateDomain, for a Compose stack (#1371)', () => {
  /** The stack row the parent lookup answers with, however it is joined. */
  const withStack = (row: { cloudAccountId: string | null }) => {
    const select = () => ({
      from: (table: unknown) => {
        const rows =
          table === webServerSettings
            ? [{ serverIp: '203.0.113.42' }]
            : [
                {
                  serviceId: 'cmp-1',
                  appName: 'shop',
                  serverId: null,
                  composeType: 'docker-compose',
                  environmentId: 'env-1',
                  cloud: row.cloudAccountId ? 'aws' : null,
                  ...row,
                },
              ];
        const chain = {
          innerJoin: () => chain,
          leftJoin: () => chain,
          where: () => chain,
          orderBy: () => chain,
          limit: () => Promise.resolve(rows),
        };
        return chain;
      },
    });
    return new DomainsService(
      { select } as unknown as DrizzleDB,
      {
        checkPermission: jest.fn().mockResolvedValue(undefined),
      } as unknown as PermissionService,
      {} as TraefikAppConfigService,
      {} as ModuleRef,
    );
  };

  it('refuses a generated host for a stack on its Stack VM, saying why and what to do', async () => {
    await expect(
      withStack({ cloudAccountId: 'ca-1' }).generateDomain(
        ctx,
        'shop',
        null,
        'cmp-1',
      ),
    ).rejects.toThrow(
      new BadRequestException(
        "A Stack VM has no generated host: an sslip.io name carries a Server's public address, and a Stack VM has none. Type a host of your own, then add the DNS records shown",
      ),
    );
  });

  it('still generates one for a stack on the platform host', async () => {
    await expect(
      withStack({ cloudAccountId: null }).generateDomain(
        ctx,
        'shop',
        null,
        'cmp-1',
      ),
    ).resolves.toMatch(/^shop-[0-9a-f]{6}-203-0-113-42\.sslip\.io$/);
  });
});
