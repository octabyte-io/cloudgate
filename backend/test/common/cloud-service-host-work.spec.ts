import { ConflictException } from '@nestjs/common';

import {
  CLOUD_SERVICE_HAS_NO_CONTAINER_CODE,
  refuseCloudServiceHostWork,
} from '../../src/common/cloud-service-host-work';
import * as serviceParent from '../../src/common/service-parent';
import type { ServiceParent } from '../../src/common/service-parent';
import { MountsService } from '../../src/mounts/mounts.service';
import type {
  PermissionCtx,
  PermissionService,
} from '../../src/rbac/permission.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { SchedulesService } from '../../src/scheduling/schedules/schedules.service';
import { buildScriptRemovalCommand } from '../../src/scheduling/schedules/schedule-commands';
import type { Schedule } from '../../src/scheduling/schedules/schedule.schema';
import type { VolumeBackup } from '../../src/volume-backups/volume-backup.schema';
import { VolumeBackupsService } from '../../src/volume-backups/volume-backups.service';
import { SELF_HOSTED } from '../utils/instance-mode-double';

/**
 * A Service in a Cloud account has `serverId: null`, and every exec dispatcher
 * reads `null` as the platform host. So a volume backup, a mount or a command
 * schedule on a cloud Application or Bucket used to run on the platform host,
 * as root, for a Service that does not run there.
 *
 * Each surface is driven through its real service with Postgres and the shell
 * stubbed: a cloud parent is refused with the 409 before anything runs or is
 * written, at create and at run; a Server-hosted parent goes on exactly as
 * before. `test/coding-standards/cloud-service-exec-census.spec.ts` holds
 * every exec site to one of these refusals or to a written reason.
 */

const ctx: PermissionCtx = {
  user: { id: 'usr-1' },
  session: { activeOrganizationId: 'org-1' },
};

const parentOf = (
  place: 'cloud' | 'server',
  serviceType: 'application' | 'bucket' = 'application',
): ServiceParent => ({
  serviceId: `${serviceType}-1`,
  name: 'checkout-api',
  appName: 'checkout-api-abc123',
  serverId: place === 'server' ? 'srv-1' : null,
  projectName: 'storefront',
  organizationId: 'org-1',
  composeType: null,
  cloudAccountId: place === 'cloud' ? 'ca-1' : null,
});

/** What a call did, so a refusal can assert nothing happened. */
interface Effects {
  executed: string[];
  writes: string[];
  runs: number;
}

/**
 * A drizzle stand-in: every builder method chains. A read answers no rows,
 * so no lookup behind the decision under test finds anything; a write's
 * `returning()` answers `written`. `insert`, `update` and `delete` are
 * recorded as writes.
 */
function dbStub(effects: Effects, written: unknown): unknown {
  const chainFrom = (rows: unknown[]): unknown =>
    new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'then') {
            return (resolve: (value: unknown) => void) => resolve(rows);
          }
          return () => {
            if (
              property === 'insert' ||
              property === 'update' ||
              property === 'delete'
            ) {
              effects.writes.push(property);
            }
            return chainFrom(property === 'returning' ? [written] : rows);
          };
        },
      },
    );
  return chainFrom([]);
}

function remoteExecStub(effects: Effects): RemoteExecService {
  const record = (command: unknown) => {
    effects.executed.push(String(command));
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return {
    execAsync: record,
    execAsyncRemote: (_serverId: string, command: string) => record(command),
    execRemote: (_serverId: string, argv: string[]) => record(argv.join(' ')),
    execFileAsync: (program: string, args: string[]) =>
      record([program, ...args].join(' ')),
  } as unknown as RemoteExecService;
}

const permissions = {
  checkPermission: () => Promise.resolve(),
  checkServiceAccess: () => Promise.resolve(),
  checkInstanceAuthority: () => Promise.resolve(),
} as unknown as PermissionService;

const runRecorderStub = (effects: Effects) => ({
  start: () => {
    effects.runs += 1;
    return Promise.resolve({
      deploymentId: 'dep-1',
      logPath: '/var/log/run.log',
    });
  },
  finish: () => Promise.resolve(),
});

/** The 409 this ticket adds, with nothing else accepted as a refusal. */
async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ConflictException) {
      const body = error.getResponse() as { code: string; message: string };
      expect(body.code).toBe(CLOUD_SERVICE_HAS_NO_CONTAINER_CODE);
      return body.message;
    }
    throw error;
  }
  throw new Error('expected a 409, and the call went through');
}

describe('refuseCloudServiceHostWork', () => {
  it('refuses a Service in a Cloud account, naming it and where its equivalent lives', () => {
    expect(() =>
      refuseCloudServiceHostWork(parentOf('cloud'), 'commandSchedules'),
    ).toThrow(
      'checkout-api runs in a Cloud account, so it has no container or volume on a machine Cloudgate manages. Command schedules are Server-only. Run a command on a timetable as a Cron service, which runs in that Cloud account.',
    );
  });

  it('passes a Service on a Server or the platform host', () => {
    expect(() =>
      refuseCloudServiceHostWork(parentOf('server'), 'volumeBackups'),
    ).not.toThrow();
    expect(() =>
      refuseCloudServiceHostWork(
        { name: 'on-the-host', cloudAccountId: null },
        'mounts',
      ),
    ).not.toThrow();
  });
});

describe('VolumeBackupsService, for a Service in a Cloud account', () => {
  const row = {
    volumeBackupId: 'vb-1',
    name: 'nightly',
    volumeName: 'shop-data',
    prefix: 'daily',
    appName: 'volume-backup-abc123',
    serviceType: 'application',
    applicationId: 'application-1',
    bucketId: 'bucket-1',
    serviceName: null,
    turnOff: false,
    schedule: '0 3 * * *',
    keepLatestCount: null,
    enabled: true,
    destinationId: 'dst-1',
  } as unknown as VolumeBackup;

  const serviceFor = (parent: ServiceParent) => {
    const effects: Effects = { executed: [], writes: [], runs: 0 };
    const destinations = {
      findOne: () => Promise.resolve({ destinationId: 'dst-1' }),
      findOneWithCredentials: () =>
        Promise.resolve({ destinationId: 'dst-1', bucket: 'b' }),
      findForScheduledRun: () =>
        Promise.resolve({ destinationId: 'dst-1', bucket: 'b' }),
    };
    const service = new VolumeBackupsService(
      dbStub(effects, row) as never,
      permissions,
      remoteExecStub(effects),
      destinations as never,
      runRecorderStub(effects) as never,
      { register: () => undefined, unregister: () => undefined } as never,
      { dispatch: () => Promise.resolve() } as never,
      { isFrozenAt: () => Promise.resolve(false) } as never,
      SELF_HOSTED,
    );
    jest
      .spyOn(service as never, 'findParentService')
      .mockResolvedValue(parent as never);
    jest.spyOn(service as never, 'findRow').mockResolvedValue({
      ...row,
      serviceType: parent.serviceId.split('-')[0],
    } as never);
    jest
      .spyOn(service as never, 'checkTarballAccess')
      .mockResolvedValue(undefined as never);
    return { service, effects };
  };

  const create = (service: VolumeBackupsService, serviceType: string) =>
    service.create(ctx, {
      name: 'nightly',
      serviceId: `${serviceType}-1`,
      serviceType,
      volumeName: 'shop-data',
      prefix: 'daily',
      destinationId: 'dst-1',
      schedule: '0 3 * * *',
      enabled: true,
      turnOff: false,
    } as never);

  const restore = (service: VolumeBackupsService) =>
    service.restore(ctx, {
      serviceId: 'application-1',
      serviceType: 'application',
      volumeName: 'shop-data',
      backupFileName: 'checkout-api-abc123/daily/shop-data-1.tar',
      destinationId: 'dst-1',
    } as never);

  it.each(['application', 'bucket'] as const)(
    'refuses a create on a cloud %s, writing nothing',
    async (serviceType) => {
      const { service, effects } = serviceFor(parentOf('cloud', serviceType));
      expect(await refusal(create(service, serviceType))).toContain(
        'Volume backups are Server-only',
      );
      expect(effects.writes).toEqual([]);
    },
  );

  it('refuses an update, a manual run, a scheduled run and a restore, running nothing', async () => {
    const { service, effects } = serviceFor(parentOf('cloud'));
    await refusal(service.update(ctx, 'vb-1', { prefix: 'weekly' }));
    await refusal(service.runManual(ctx, 'vb-1'));
    await refusal(service.runScheduled('vb-1'));
    await refusal(restore(service));
    expect(effects).toEqual({ executed: [], writes: [], runs: 0 });
  });

  it('leaves a Service on a Server as it was', async () => {
    const { service, effects } = serviceFor(parentOf('server'));
    await create(service, 'application');
    await service.update(ctx, 'vb-1', { prefix: 'weekly' });
    await service.runManual(ctx, 'vb-1');
    expect(effects.writes).toEqual(['insert', 'update']);
    expect(effects.runs).toBe(1);
    expect(effects.executed.length).toBeGreaterThan(0);
  });
});

describe('MountsService, for a Service in a Cloud account', () => {
  const fileMount = {
    mountId: 'mnt-1',
    type: 'file',
    serviceType: 'application',
    applicationId: 'application-1',
    filePath: 'config/app.env',
    content: 'A=1',
    mountPath: '/etc/app.env',
  };

  const serviceFor = (parent: ServiceParent) => {
    const effects: Effects = { executed: [], writes: [], runs: 0 };
    const service = new MountsService(
      dbStub(effects, fileMount) as never,
      permissions,
      remoteExecStub(effects),
    );
    jest
      .spyOn(service as never, 'findParentService')
      .mockResolvedValue(parent as never);
    jest
      .spyOn(service as never, 'findRow')
      .mockResolvedValue(fileMount as never);
    return { service, effects };
  };

  const createFile = {
    serviceId: 'application-1',
    serviceType: 'application',
    type: 'file',
    filePath: 'config/app.env',
    content: 'A=1',
    mountPath: '/etc/app.env',
  } as never;
  const createVolume = {
    serviceId: 'application-1',
    serviceType: 'application',
    type: 'volume',
    volumeName: 'shop-data',
    mountPath: '/data',
  } as never;

  it('refuses a file or a volume mount create, and an update, writing nothing anywhere', async () => {
    const { service, effects } = serviceFor(parentOf('cloud'));
    expect(await refusal(service.create(ctx, createFile))).toContain(
      'File and volume mounts are Server-only',
    );
    await refusal(service.create(ctx, createVolume));
    await refusal(service.createForNewService(ctx, createFile));
    await refusal(service.update(ctx, 'mnt-1', { content: 'A=2' }));
    expect(effects.executed).toEqual([]);
    expect(effects.writes).toEqual([]);
  });

  it('removes a row saved earlier without running anything on the platform host', async () => {
    const { service, effects } = serviceFor(parentOf('cloud'));
    await service.remove(ctx, 'mnt-1');
    expect(effects.executed).toEqual([]);
    expect(effects.writes).toEqual(['delete']);
  });

  it('leaves a Service on a Server as it was', async () => {
    const { service, effects } = serviceFor(parentOf('server'));
    await service.create(ctx, createFile);
    await service.update(ctx, 'mnt-1', { content: 'A=2' });
    await service.remove(ctx, 'mnt-1');
    expect(effects.writes).toEqual(['insert', 'update', 'delete']);
    expect(effects.executed).toHaveLength(3);
  });
});

describe('SchedulesService, for a Service in a Cloud account', () => {
  const scheduleRow = {
    scheduleId: 'sch-1',
    appName: 'schedule-abc123',
    scheduleType: 'application',
    applicationId: 'application-1',
    composeId: null,
    serverId: null,
    organizationId: null,
    serviceName: null,
    shellType: 'sh',
    command: 'echo hi',
    script: null,
    cronExpression: '0 * * * *',
    timezone: null,
    enabled: true,
  } as unknown as Schedule;

  afterEach(() => jest.restoreAllMocks());

  const serviceFor = (parent: ServiceParent) => {
    const effects: Effects = { executed: [], writes: [], runs: 0 };
    jest.spyOn(serviceParent, 'findParentService').mockResolvedValue(parent);
    const service = new SchedulesService(
      dbStub(effects, scheduleRow) as never,
      permissions,
      remoteExecStub(effects),
      { register: () => undefined, unregister: () => undefined } as never,
      runRecorderStub(effects) as never,
      { isFrozenAt: () => Promise.resolve(false) } as never,
    );
    jest
      .spyOn(service as never, 'findRow')
      .mockResolvedValue(scheduleRow as never);
    return { service, effects };
  };

  const create = (service: SchedulesService) =>
    service.create(ctx, {
      name: 'hourly',
      scheduleType: 'application',
      serviceId: 'application-1',
      cronExpression: '0 * * * *',
      shellType: 'sh',
      command: 'echo hi',
    } as never);

  it('refuses a create, an update, a manual run and a scheduled run, running nothing', async () => {
    const { service, effects } = serviceFor(parentOf('cloud'));
    expect(await refusal(create(service))).toContain(
      'Command schedules are Server-only',
    );
    await refusal(service.update(ctx, 'sch-1', { command: 'echo 2' }));
    await refusal(service.runManual(ctx, 'sch-1'));
    await refusal(service.runScheduled('sch-1'));
    expect(effects).toEqual({ executed: [], writes: [], runs: 0 });
  });

  it('removes a row saved earlier without running anything on the platform host', async () => {
    const { service, effects } = serviceFor(parentOf('cloud'));
    await service.remove(ctx, 'sch-1');
    // Its run logs are the platform's own files and go as on any delete; the
    // schedule's own directory is never touched.
    expect(effects.executed).not.toContain(
      buildScriptRemovalCommand('schedule-abc123', null),
    );
    expect(effects.writes).toEqual(['delete']);
  });

  it('leaves a Service on a Server as it was', async () => {
    const { service, effects } = serviceFor(parentOf('server'));
    await create(service);
    await service.runManual(ctx, 'sch-1');
    expect(effects.writes).toEqual(['insert']);
    expect(effects.runs).toBe(1);
    expect(effects.executed).toHaveLength(1);
  });
});
