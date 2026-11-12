import * as fs from 'node:fs';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { application, redirect } from '../../src/db/schema';
import { REDIRECTS_REFUSAL } from '../../src/domains/cloud-domain';
import type { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { PLATFORM_HOST_REFUSED_CODE } from '../../src/instance-mode/platform-host-refusal';
import { RedirectsService } from '../../src/networking/redirects/redirects.service';
import type {
  PermissionCtx,
  PermissionService,
} from '../../src/rbac/permission.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  CLOUD_PREVIEW_NOT_ROUTED,
  TraefikAppConfigService,
} from '../../src/traefik/app-config.service';
import type { TraefikConfigStatusService } from '../../src/traefik/config-status.service';
import {
  PLATFORM_OWNED,
  TraefikWriterService,
} from '../../src/traefik/traefik-writer.service';

// The platform host's `dynamic/` is a system boundary: no test writes it.
jest.mock('node:fs');

/**
 * A Service in a Cloud account has `serverId: null`, which the Traefik writer
 * reads as the platform host. So a redirect on a cloud Application wrote its
 * Domains' `Host() && PathPrefix()` routers into the platform host's own
 * Traefik, beside the console's, where the longer rule wins (ADR-0053). These
 * pin the three layers that now keep it out: the regeneration skips a cloud
 * Application, the redirect routes refuse one, and on the Hosted instance the
 * writer refuses any platform-host write the platform did not say is its own.
 */

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

const hosted = (isHosted: boolean) =>
  ({
    isHosted,
    refusePlatformHost: (work: 'services' | 'checks') => {
      if (isHosted) {
        throw new BadRequestException({
          message: work,
          code: PLATFORM_HOST_REFUSED_CODE,
        });
      }
    },
  }) as unknown as InstanceMode;

const codeOf = (error: unknown): unknown =>
  (
    (error as BadRequestException).getResponse() as {
      code?: unknown;
    }
  ).code;

/** A db that answers each table with its rows, and records writes. */
const makeDb = (
  tables: Map<unknown, unknown[]>,
  writes: string[] = [],
): DrizzleDB => {
  const select = () => ({
    from: (table: unknown) => {
      const rows = tables.get(table) ?? [];
      const chain = {
        innerJoin: () => chain,
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
  const returning = (what: string) => () => {
    writes.push(what);
    return Promise.resolve([{ redirectId: 'r-1' }]);
  };
  const db = {
    select,
    insert: () => ({ values: () => ({ returning: returning('insert') }) }),
    update: () => ({
      set: () => ({ where: () => ({ returning: returning('update') }) }),
    }),
    delete: () => ({ where: () => ({ returning: returning('delete') }) }),
    // A delete and its routing rewrite share one transaction (#1417); the
    // double hands the callback itself, which records the same writes.
    transaction: (run: (tx: unknown) => Promise<unknown>) => run(db),
  };
  return db as unknown as DrizzleDB;
};

const writerDouble = () => ({
  writeConfig: jest.fn().mockResolvedValue(undefined),
  removeConfig: jest.fn().mockResolvedValue(undefined),
});

const statusDouble = {
  anchor: jest.fn().mockResolvedValue(null),
  verifyInBackground: jest.fn(),
} as unknown as TraefikConfigStatusService;

describe('TraefikAppConfigService, for an Application in a Cloud account', () => {
  const cloudApp = new Map<unknown, unknown[]>([
    [application, [{ cloudAccountId: 'cloud-1' }]],
  ]);

  it('regenerates nothing: no route file is written or removed on the platform host', async () => {
    const writer = writerDouble();
    const service = new TraefikAppConfigService(
      makeDb(cloudApp),
      writer as unknown as TraefikWriterService,
      statusDouble,
    );

    await service.regenerate({
      applicationId: 'app-1',
      appName: 'shop',
      serverId: null,
    });

    expect(writer.writeConfig).not.toHaveBeenCalled();
    expect(writer.removeConfig).not.toHaveBeenCalled();
  });

  it('refuses to route a Preview deployment of one', async () => {
    const writer = writerDouble();
    const service = new TraefikAppConfigService(
      makeDb(cloudApp),
      writer as unknown as TraefikWriterService,
      statusDouble,
    );

    await expect(
      service.routePreview({
        appName: 'shop-preview-1',
        host: 'pr-1.preview.example.com',
        port: 3000,
        parent: { applicationId: 'app-1', serverId: null },
        dnsChallengeWildcard: null,
      }),
    ).rejects.toThrow(new ConflictException(CLOUD_PREVIEW_NOT_ROUTED));
    expect(writer.writeConfig).not.toHaveBeenCalled();
  });

  it('still removes the file of an Application on the platform host with no Domain left', async () => {
    const writer = writerDouble();
    const service = new TraefikAppConfigService(
      makeDb(new Map([[application, [{ cloudAccountId: null }]]])),
      writer as unknown as TraefikWriterService,
      statusDouble,
    );

    await service.regenerate({
      applicationId: 'app-1',
      appName: 'shop',
      serverId: null,
    });

    expect(writer.removeConfig).toHaveBeenCalledWith('shop', null);
  });
});

describe('RedirectsService, for an Application in a Cloud account', () => {
  const permissions = {
    checkPermission: jest.fn().mockResolvedValue(undefined),
    checkServiceAccess: jest.fn().mockResolvedValue(undefined),
  } as unknown as PermissionService;

  const serviceFor = (cloudAccountId: string | null) => {
    const writes: string[] = [];
    const regenerate = jest.fn().mockResolvedValue(undefined);
    const service = new RedirectsService(
      makeDb(
        new Map<unknown, unknown[]>([
          [
            application,
            [
              {
                applicationId: 'app-1',
                appName: 'shop',
                serverId: null,
                cloudAccountId,
              },
            ],
          ],
          [redirect, [{ redirectId: 'r-1', applicationId: 'app-1' }]],
        ]),
        writes,
      ),
      permissions,
      { regenerate } as unknown as TraefikAppConfigService,
    );
    return { service, writes, regenerate };
  };

  const body = {
    applicationId: 'app-1',
    regex: '.*',
    replacement: 'https://elsewhere.example.com/',
    permanent: false,
  };

  it('refuses a create, storing nothing and regenerating nothing', async () => {
    const { service, writes, regenerate } = serviceFor('cloud-1');

    await expect(service.create(ctx, body as never)).rejects.toThrow(
      new BadRequestException(REDIRECTS_REFUSAL),
    );
    expect(writes).toEqual([]);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('refuses an update', async () => {
    const { service, writes } = serviceFor('cloud-1');

    await expect(
      service.update(ctx, 'r-1', { regex: '^/login' }),
    ).rejects.toThrow(new BadRequestException(REDIRECTS_REFUSAL));
    expect(writes).toEqual([]);
  });

  it('lets a redirect stored before the refusal be removed', async () => {
    const { service, writes } = serviceFor('cloud-1');

    await service.remove(ctx, 'r-1');

    expect(writes).toEqual(['delete']);
  });

  it('still takes a redirect on an Application on a Server or the platform host', async () => {
    const { service, writes, regenerate } = serviceFor(null);

    await service.create(ctx, body);

    expect(writes).toEqual(['insert']);
    expect(regenerate).toHaveBeenCalled();
  });
});

describe('TraefikWriterService.writeConfig, on the platform host', () => {
  const execAsyncRemote = jest.fn().mockResolvedValue({ stdout: '' });
  const remoteExec = { execAsyncRemote } as unknown as RemoteExecService;
  const config = { http: { routers: {} } };

  beforeEach(() => jest.clearAllMocks());

  it('refuses a write the platform did not claim on the Hosted instance', async () => {
    const writer = new TraefikWriterService(remoteExec, hosted(true));

    const error: unknown = await writer
      .writeConfig('shop', config, null)
      .catch((caught: unknown) => caught);

    expect(codeOf(error)).toBe(PLATFORM_HOST_REFUSED_CODE);
    expect(jest.mocked(fs).writeFileSync).not.toHaveBeenCalled();
  });

  it("writes the platform's own file on the Hosted instance", async () => {
    const writer = new TraefikWriterService(remoteExec, hosted(true));

    await writer.writeConfig('cloudgate', config, null, PLATFORM_OWNED);

    expect(jest.mocked(fs).writeFileSync).toHaveBeenCalled();
  });

  it("writes a Server's file on the Hosted instance", async () => {
    const writer = new TraefikWriterService(remoteExec, hosted(true));

    await writer.writeConfig('shop', config, 'server-1');

    expect(execAsyncRemote).toHaveBeenCalled();
  });

  it('writes the platform host on a Self-hosted instance, as before', async () => {
    const writer = new TraefikWriterService(remoteExec, hosted(false));

    await writer.writeConfig('shop', config, null);

    expect(jest.mocked(fs).writeFileSync).toHaveBeenCalled();
  });
});

/**
 * The removal's twin of the write rule. `dynamic/<name>.yml` on the platform
 * host is named by whatever the caller passes, and a Service in a Cloud
 * account has `serverId: null`, so a removal that followed its place deleted
 * the platform host's file of that name: an Application whose `appName` is
 * `hosted` took the Hosted instance's own router file with it. On the Hosted
 * instance a platform-host removal the platform does not claim is refused.
 */
describe('TraefikWriterService.removeConfig, on the platform host', () => {
  const execRemote = jest.fn().mockResolvedValue({ stdout: '' });
  const remoteExec = { execRemote } as unknown as RemoteExecService;

  beforeEach(() => jest.clearAllMocks());

  it('refuses a removal the platform did not claim on the Hosted instance', async () => {
    const writer = new TraefikWriterService(remoteExec, hosted(true));

    const error: unknown = await writer
      .removeConfig('hosted', null)
      .catch((caught: unknown) => caught);

    expect(codeOf(error)).toBe(PLATFORM_HOST_REFUSED_CODE);
    expect(jest.mocked(fs).rmSync).not.toHaveBeenCalled();
  });

  it("removes the platform's own file on the Hosted instance", async () => {
    const writer = new TraefikWriterService(remoteExec, hosted(true));

    await writer.removeConfig('cloudgate', null, PLATFORM_OWNED);

    expect(jest.mocked(fs).rmSync).toHaveBeenCalled();
  });

  it("removes a Server's file on the Hosted instance", async () => {
    const writer = new TraefikWriterService(remoteExec, hosted(true));

    await writer.removeConfig('shop', 'server-1');

    expect(execRemote).toHaveBeenCalled();
  });

  it('removes the platform host file on a Self-hosted instance, as before', async () => {
    const writer = new TraefikWriterService(remoteExec, hosted(false));

    await writer.removeConfig('shop', null);

    expect(jest.mocked(fs).rmSync).toHaveBeenCalled();
  });
});
