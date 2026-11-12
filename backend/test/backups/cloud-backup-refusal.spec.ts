import { ConflictException, HttpException } from '@nestjs/common';
import type { Backup } from '../../src/backups/backup.schema';
import { BackupsService } from '../../src/backups/backups.service';
import { CLOUD_SERVICE_HAS_NO_CONTAINER_CODE } from '../../src/common/cloud-service-host-work';
import { PLATFORM_HOST_REFUSED_CODE } from '../../src/instance-mode/platform-host-refusal';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { instanceModeDouble } from '../utils/instance-mode-double';

// The Existing database and cloud database refusals read their own rows and
// have their own specs; a Compose stack is what is under test here.
jest.mock('../../src/databases/postgres/existing-postgres', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../src/databases/postgres/existing-postgres',
  ),
  refuseExistingDatabaseBackup: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/databases/common/server-only-dumps', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../src/databases/common/server-only-dumps',
  ),
  refuseCloudDatabaseDump: jest.fn().mockResolvedValue(undefined),
}));

/**
 * A Compose stack on its own Stack VM (ADR-0070) has `serverId: null`, like
 * every Service in a Cloud account, and `execRclone` read that as the
 * platform host: a Compose Backup ran `docker` on the shared box, and a
 * restore's rclone probe dialled the caller's endpoint from it with the
 * caller's keys, its error coming back in the 400 (ADR-0053). Each entry
 * point now refuses before the Destination is read and before a run is
 * recorded; on the Hosted instance a row on the platform host itself is
 * refused there too.
 */
describe('BackupsService, for a Service that does not run on the platform host', () => {
  const ctx: PermissionCtx = {
    user: { id: 'usr-1' },
    session: { activeOrganizationId: 'org-1' },
  };

  /** Thrown by every collaborator past the refusal. */
  const PAST_THE_REFUSAL = new Error('reached past the refusal');

  const row = {
    backupId: 'bk-1',
    schedule: '0 3 * * *',
    enabled: true,
    prefix: 'daily',
    database: 'shop',
    appName: 'stack-abc123',
    keepLatestCount: null,
    destinationId: 'dst-1',
    backupType: 'compose',
    databaseType: 'postgres',
    composeId: 'cmp-1',
    serviceName: 'db',
    metadata: null,
  } as unknown as Backup;

  const stackOnItsVm = {
    serviceId: 'cmp-1',
    name: 'Shop stack',
    appName: 'stack-abc123',
    serverId: null,
    cloudAccountId: 'cloud-1',
    projectName: 'shop',
    organizationId: 'org-1',
    composeType: 'docker-compose',
  };

  const serviceFor = (
    parent: Record<string, unknown>,
    isHosted = false,
  ): { service: BackupsService; effects: string[] } => {
    const effects: string[] = [];
    const reject = (what: string) => () => {
      effects.push(what);
      return Promise.reject(PAST_THE_REFUSAL);
    };
    const service = new BackupsService(
      {
        insert: reject('insert'),
        update: reject('update'),
      } as never,
      {
        checkPermission: () => Promise.resolve(),
        checkServiceAccess: () => Promise.resolve(),
      } as never,
      {
        execAsync: reject('exec on the platform host'),
        execAsyncRemote: reject('exec on a Server'),
      } as never,
      {
        findOne: reject('destination'),
        findOneWithCredentials: reject('destination'),
        findForScheduledRun: () => Promise.resolve({ bucket: 'b' }),
      } as never,
      { start: reject('run recorded') } as never,
      null as never,
      null as never,
      { isFrozenAt: () => Promise.resolve(false) } as never,
      instanceModeDouble(isHosted),
    );
    jest
      .spyOn(service as never, 'findParentService')
      .mockResolvedValue(parent as never);
    jest.spyOn(service as never, 'findRow').mockResolvedValue(row as never);
    jest
      .spyOn(service as never, 'checkBackupFileAccess')
      .mockResolvedValue(undefined as never);
    return { service, effects };
  };

  const codeOf = async (call: Promise<unknown>): Promise<unknown> => {
    const error: unknown = await call.then(
      () => null,
      (thrown: unknown) => thrown,
    );
    if (!(error instanceof HttpException)) throw error;
    return (error.getResponse() as { code?: unknown }).code;
  };

  const createDto = {
    schedule: '0 3 * * *',
    prefix: 'daily',
    database: 'shop',
    destinationId: 'dst-1',
    databaseType: 'postgres' as const,
    backupType: 'compose' as const,
    serviceId: 'cmp-1',
    serviceName: 'db',
  };

  const restoreDto = {
    databaseId: 'cmp-1',
    databaseType: 'postgres' as const,
    backupType: 'compose' as const,
    databaseName: 'shop',
    backupFile: 'stack-abc123/daily/2026-07-23T10-20-30-456Z.sql.gz',
    destinationId: 'dst-1',
  };

  describe('a Compose stack on its own Stack VM', () => {
    it.each([
      ['create', (s: BackupsService) => s.create(ctx, createDto as never)],
      ['update', (s: BackupsService) => s.update(ctx, 'bk-1', {})],
      ['a manual run', (s: BackupsService) => s.runManual(ctx, 'bk-1')],
      ['a scheduled run', (s: BackupsService) => s.runScheduled('bk-1')],
      ['restore', (s: BackupsService) => s.restore(ctx, restoreDto as never)],
    ])('refuses %s, touching nothing', async (_what, call) => {
      const { service, effects } = serviceFor(stackOnItsVm);

      expect(await codeOf(call(service))).toBe(
        CLOUD_SERVICE_HAS_NO_CONTAINER_CODE,
      );
      expect(effects).toEqual([]);
    });

    it('says where its data is kept instead', async () => {
      const { service } = serviceFor(stackOnItsVm);

      await expect(service.restore(ctx, restoreDto as never)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.restore(ctx, restoreDto as never)).rejects.toThrow(
        /Shop stack runs in a Cloud account.*Stack VM's data disk/,
      );
    });
  });

  describe('a Service on the platform host', () => {
    const onTheHost = { ...stackOnItsVm, cloudAccountId: null };

    it('is refused a restore on the Hosted instance before its Destination is read', async () => {
      const { service, effects } = serviceFor(onTheHost, true);

      expect(await codeOf(service.restore(ctx, restoreDto as never))).toBe(
        PLATFORM_HOST_REFUSED_CODE,
      );
      expect(effects).toEqual([]);
    });

    it('is refused a scheduled run on the Hosted instance before it is recorded', async () => {
      const { service, effects } = serviceFor(onTheHost, true);

      expect(await codeOf(service.runScheduled('bk-1'))).toBe(
        PLATFORM_HOST_REFUSED_CODE,
      );
      expect(effects).toEqual([]);
    });

    it('keeps its restore on a Self-hosted instance', async () => {
      const { service, effects } = serviceFor(onTheHost, false);

      await expect(service.restore(ctx, restoreDto as never)).rejects.toBe(
        PAST_THE_REFUSAL,
      );
      expect(effects).toEqual(['destination']);
    });
  });
});
