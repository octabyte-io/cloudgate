import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ModuleRef } from '@nestjs/core';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import {
  aiModelFacet,
  application,
  domain,
  webServerSettings,
} from '../../src/db/schema';
import { DomainsService } from '../../src/domains/domains.service';
import type { CreateDomainDto } from '../../src/domains/dto/domain.dto';
import { instanceOwnHosts } from '../../src/domains/instance-hosts';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import type {
  PermissionCtx,
  PermissionService,
} from '../../src/rbac/permission.service';
import type { TraefikAppConfigService } from '../../src/traefik/app-config.service';

/**
 * The Hosted instance's one hostname is routed from `dynamic/hosted.yml`,
 * written at install from `CLOUDGATE_HOSTNAME`, and never reaches
 * `webServerSettings.host`, so the console-host reservation did not see it:
 * any Organization could add a Domain on it with a path under it, and a
 * `Host() && PathPrefix()` router outranks the console's bare `Host()`
 * (ADR-0053). It reaches the backend as the Instance's own origins, which is
 * what is reserved now.
 */

const SITE = 'cloudgate.octabyte.app';

describe('instanceOwnHosts', () => {
  it("reads the hostnames of the Instance's own origins, once each", () => {
    const env: Record<string, string> = {
      SITE_URL: `https://${SITE}`,
      BETTER_AUTH_URL: `https://${SITE.toUpperCase()}/`,
      CLOUDGATE_API_URL: 'http://203.0.113.10:4000',
    };
    expect(instanceOwnHosts((name) => env[name])).toEqual([
      SITE,
      '203.0.113.10',
    ]);
  });

  it('names nothing for a setting that is unset or not a URL', () => {
    const env: Record<string, string> = { SITE_URL: 'not a url' };
    expect(instanceOwnHosts((name) => env[name])).toEqual([]);
  });
});

describe('DomainsService.create, on the Instance’s own hostname', () => {
  const ctx: PermissionCtx = {
    user: { id: 'user-1' },
    session: { activeOrganizationId: 'org-1' },
  };

  const makeDb = (serverId: string | null): DrizzleDB => {
    const rowsFor = (table: unknown): unknown[] => {
      if (table === application) {
        return [{ serviceId: 'app-1', appName: 'shop', serverId }];
      }
      if (table === domain) return [];
      if (table === webServerSettings) return [];
      if (table === aiModelFacet) return [];
      // `checkServerAccess` and the kind lock read their own rows: an
      // unrelated answer is enough, as nothing here is about them.
      return [];
    };
    const select = () => ({
      from: (table: unknown) => {
        const rows = rowsFor(table);
        const chain = {
          innerJoin: () => chain,
          leftJoin: () => chain,
          where: () => chain,
          orderBy: () => chain,
          limit: () => Promise.resolve(rows),
          then: (
            resolve: (value: unknown[]) => unknown,
            reject: (reason: unknown) => unknown,
          ) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      },
    });
    const insert = () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => Promise.resolve([{ domainId: 'd-1', ...values }]),
      }),
    });
    return {
      select,
      insert,
      transaction: (run: (tx: unknown) => Promise<unknown>) =>
        run({ select, insert }),
    } as unknown as DrizzleDB;
  };

  const serviceFor = (isHosted: boolean, serverId: string | null) => {
    const config = {
      get: (name: string) =>
        name === 'SITE_URL' ? `https://${SITE}` : undefined,
    };
    const moduleRef = {
      get: (token: unknown) => {
        if (token === InstanceMode) return { isHosted };
        if (token === ConfigService) return config;
        throw new Error('unexpected provider');
      },
    } as unknown as ModuleRef;
    return new DomainsService(
      makeDb(serverId),
      {
        checkPermission: jest.fn().mockResolvedValue(undefined),
        checkServiceAccess: jest.fn().mockResolvedValue(undefined),
      } as unknown as PermissionService,
      {
        regenerate: jest.fn().mockResolvedValue(undefined),
      } as unknown as TraefikAppConfigService,
      moduleRef,
    );
  };

  const body = (host: string) =>
    ({
      applicationId: 'app-1',
      host,
      path: '/login',
    }) as unknown as CreateDomainDto;

  it.each([
    ['the platform host', null],
    ['a Server', 'server-1'],
  ])(
    'is refused on the Hosted instance, with a path, on %s',
    async (_where, serverId) => {
      const domains = serviceFor(true, serverId);
      await expect(domains.create(ctx, body(SITE))).rejects.toThrow(
        ConflictException,
      );
      await expect(
        domains.create(ctx, body(SITE.toUpperCase())),
      ).rejects.toThrow(ConflictException);
    },
  );

  it('is refused on the platform host of a Self-hosted instance', async () => {
    await expect(
      serviceFor(false, null).create(ctx, body(SITE)),
    ).rejects.toThrow(ConflictException);
  });

  it("is left to a Server's own Traefik on a Self-hosted instance", async () => {
    await expect(
      serviceFor(false, 'server-1').create(ctx, body(SITE)),
    ).resolves.toMatchObject({ host: SITE });
  });

  it('leaves every other hostname alone', async () => {
    await expect(
      serviceFor(true, 'server-1').create(ctx, body('shop.example.com')),
    ).resolves.toMatchObject({ host: 'shop.example.com' });
  });
});
