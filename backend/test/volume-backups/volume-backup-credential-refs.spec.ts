import { NotFoundException } from '@nestjs/common';
import type { ServiceParent } from '../../src/common/service-parent';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { DestinationsService } from '../../src/destinations/destinations.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { PermissionService } from '../../src/rbac/permission.service';
import {
  createVolumeBackupSchema,
  updateVolumeBackupSchema,
} from '../../src/volume-backups/dto/volume-backup.dto';
import type {
  CreateVolumeBackupDto,
  UpdateVolumeBackupDto,
} from '../../src/volume-backups/dto/volume-backup.dto';
import type { VolumeBackup } from '../../src/volume-backups/volume-backup.schema';
import {
  VOLUME_BACKUP_CREDENTIAL_REFS,
  VolumeBackupsService,
} from '../../src/volume-backups/volume-backups.service';
import { SELF_HOSTED } from '../utils/instance-mode-double';

/**
 * The credential-ref check one table over from
 * `test/backups/backup-credential-refs.spec.ts`, and the same five-seam shape:
 * `destinationId` is the one credential-bearing parent id a volume backup
 * carries, `create` and `update` are the two seams that **write** it, and both
 * resolved it by hand with the result discarded — `update` then writing
 * `.set(data)`, so the id that landed was the request's rather than the
 * lookup's.
 *
 * The sibling spec carries the argument. What differs here is only which
 * schemas the list has to cover.
 */

const ctx: PermissionCtx = {
  user: { id: 'usr-1' },
  session: { activeOrganizationId: 'org-1' },
};

const row = {
  volumeBackupId: 'vb-1',
  name: 'nightly uploads',
  volumeName: 'shop-data',
  prefix: 'daily',
  appName: 'volume-backup-abc123',
  serviceType: 'application',
  applicationId: 'app-1',
  serviceName: null,
  turnOff: false,
  schedule: '0 3 * * *',
  keepLatestCount: null,
  enabled: true,
  destinationId: 'dst-1',
} as unknown as VolumeBackup;

const parent = {
  serverId: null,
  organizationId: 'org-1',
  name: 'checkout-api',
  projectName: 'storefront',
  appName: 'main-app',
  serviceType: 'application',
} as unknown as ServiceParent;

interface Written {
  values?: Record<string, unknown>;
}

const makeDb = (written: Written) =>
  ({
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => {
          written.values = values;
          return Promise.resolve([{ ...row, ...values }]);
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            written.values = values;
            return Promise.resolve([{ ...row, ...values }]);
          },
        }),
      }),
    }),
  }) as unknown as DrizzleDB;

/** Answering with a row carrying the id it was handed, as the real lookup
 * does — its `where` being `destination_id = ? AND organization_id = ?`. */
const makeDestinations = () => ({
  findOne: jest.fn((_ctx: PermissionCtx, id: string) =>
    Promise.resolve({ destinationId: id }),
  ),
  findOneWithCredentials: jest.fn((_ctx: PermissionCtx, id: string) =>
    Promise.resolve({ destinationId: id }),
  ),
});

type Destinations = ReturnType<typeof makeDestinations>;

function makeService(destinations: Destinations = makeDestinations()) {
  const written: Written = {};
  const service = new VolumeBackupsService(
    makeDb(written),
    {
      checkPermission: jest.fn().mockResolvedValue(undefined),
      checkServiceAccess: jest.fn().mockResolvedValue(undefined),
    } as unknown as PermissionService,
    null as never,
    destinations as unknown as DestinationsService,
    null as never,
    { register: jest.fn(), unregister: jest.fn() } as never,
    null as never,
    null as never,
    SELF_HOSTED,
  );
  jest
    .spyOn(service as never, 'findParentService')
    .mockResolvedValue(parent as never);
  jest.spyOn(service as never, 'findRow').mockResolvedValue(row as never);
  return { service, written, destinations };
}

const createDto = {
  name: 'nightly uploads',
  volumeName: 'shop-data',
  prefix: 'daily',
  schedule: '0 3 * * *',
  serviceType: 'application' as const,
  serviceId: 'app-1',
  turnOff: false,
  destinationId: 'dst-1',
} satisfies CreateVolumeBackupDto;

const patch = (data: Partial<UpdateVolumeBackupDto>) =>
  data as UpdateVolumeBackupDto;

describe('VolumeBackupsService, on the credential-bearing id in its body', () => {
  it('resolves create destinationId through the Destination lookup and inserts the id it authorized', async () => {
    const { service, written, destinations } = makeService();

    await service.create(ctx, createDto);

    expect(destinations.findOne).toHaveBeenCalledWith(ctx, 'dst-1');
    // `findOne`, not `findOneWithCredentials`: the resolved id is all this
    // module asked for, so no decrypted secret access key reaches it.
    expect(destinations.findOneWithCredentials).not.toHaveBeenCalled();
    // `volumeBackupId` is minted in `create` rather than left to the column
    // default, because the cron job is keyed by it and is registered first
    // so it is the one written value this spec cannot name.
    const { volumeBackupId, ...inserted } = written.values ?? {};
    expect(typeof volumeBackupId).toBe('string');
    expect(inserted).toEqual({
      name: 'nightly uploads',
      volumeName: 'shop-data',
      prefix: 'daily',
      schedule: '0 3 * * *',
      serviceType: 'application',
      applicationId: 'app-1',
      turnOff: false,
      destinationId: 'dst-1',
    });
  });

  it('refuses create when the Destination lookup does not find the row, and writes nothing', async () => {
    const destinations = makeDestinations();
    const refusal = new NotFoundException('Destination not found');
    destinations.findOne.mockRejectedValue(refusal);
    const { service, written } = makeService(destinations);

    await expect(service.create(ctx, createDto)).rejects.toThrow(refusal);

    expect(written.values).toBeUndefined();
  });

  it('resolves update destinationId through the Destination lookup and writes the id it authorized', async () => {
    const { service, written, destinations } = makeService();

    await service.update(
      ctx,
      'vb-1',
      patch({ prefix: 'weekly', destinationId: 'dst-2' }),
    );

    expect(destinations.findOne).toHaveBeenCalledWith(ctx, 'dst-2');
    expect(destinations.findOneWithCredentials).not.toHaveBeenCalled();
    expect(written.values).toEqual({
      prefix: 'weekly',
      destinationId: 'dst-2',
    });
  });

  it('refuses update when the Destination lookup does not find the row, and writes nothing', async () => {
    const destinations = makeDestinations();
    const refusal = new NotFoundException('Destination not found');
    destinations.findOne.mockRejectedValue(refusal);
    const { service, written } = makeService(destinations);

    await expect(
      service.update(ctx, 'vb-1', patch({ destinationId: 'dst-2' })),
    ).rejects.toThrow(refusal);

    expect(written.values).toBeUndefined();
  });

  it('resolves nothing for a PATCH that mentions no destination', async () => {
    const { service, written, destinations } = makeService();

    await service.update(ctx, 'vb-1', patch({ schedule: '0 4 * * *' }));

    expect(destinations.findOne).not.toHaveBeenCalled();
    expect(written.values).toEqual({ schedule: '0 4 * * *' });
  });
});

describe('VOLUME_BACKUP_CREDENTIAL_REFS', () => {
  /**
   * `serviceId` is the owning Service and is `findParentService`'s job — the
   * eight-table polymorphic parent, which answers about a workload rather than
   * about a credential.
   */
  const NOT_A_CREDENTIAL_ROW = ['serviceId'];

  it.each([
    ['createVolumeBackupSchema', createVolumeBackupSchema],
    ['updateVolumeBackupSchema', updateVolumeBackupSchema],
  ])('covers every parent id %s accepts', (_name, schema) => {
    const ids = Object.keys(schema.shape)
      .filter((key) => key.endsWith('Id'))
      .filter((key) => !NOT_A_CREDENTIAL_ROW.includes(key));

    expect([...ids].sort()).toEqual([...VOLUME_BACKUP_CREDENTIAL_REFS].sort());
  });
});
