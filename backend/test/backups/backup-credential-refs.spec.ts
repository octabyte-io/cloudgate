import { NotFoundException } from '@nestjs/common';
import type { Backup } from '../../src/backups/backup.schema';
import {
  BACKUP_CREDENTIAL_REFS,
  BackupsService,
} from '../../src/backups/backups.service';
import {
  createBackupSchema,
  updateBackupSchema,
} from '../../src/backups/dto/backup.dto';
import type {
  CreateBackupDto,
  UpdateBackupDto,
} from '../../src/backups/dto/backup.dto';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { DestinationsService } from '../../src/destinations/destinations.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { PermissionService } from '../../src/rbac/permission.service';
import { SELF_HOSTED } from '../utils/instance-mode-double';

// The Existing database and cloud database refusals read their
// own rows; neither is what this spec is about, and the fake db has no reads
// for them. Each has its own specs.
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
 * `destinationId` is the one credential-bearing parent id a Backup
 * carries, and `create` and `update` are the two seams that **write** it.
 * Both resolved it by hand — `findOneWithCredentials(ctx, …)`, its result
 * discarded — and `update` then wrote `.set(data)`, so the id that landed was
 * the one the request carried rather than the one the lookup authorized.
 *
 * That is the rule `common/credential-refs.ts` holds for the whole tree
 * (one sentence, one loop, one extraction), and this module is the one
 * it was shaped around: `resolveCredentialRefs` takes no `PermissionCtx`
 * precisely so a request-scoped caller here can close over `ctx` while
 * `runScheduled` resolves the same column with none.
 *
 * What is pinned here is what the e2e half (`backups.e2e-spec.ts`,
 * `backup-authorization.e2e-spec.ts`) cannot vary cheaply:
 *
 * - that the lookup is the **owning** service's, and is `findOne` rather than
 *   `findOneWithCredentials`, so no registration and no `PATCH` puts a
 *   destination's decrypted secret access key in a local of this module —
 *   as much of the rule *"resolving an id has no business decrypting a secret"*
 *   as this service's API offers, and `BackupsService.credentialRefResolvers`
 *   records why it is not the whole of it;
 * - that the write is built from the authorization result, so a resolver that
 *   ever answered with a different id would be honoured rather than ignored;
 * - that a `PATCH` mentioning no destination resolves nothing, which is the
 *   difference between this guard and one that refuses every rename;
 * - and that {@link BACKUP_CREDENTIAL_REFS} covers the schemas — the assertion
 *   a *second* credential id has to fail against.
 *
 * Written against the two writes the service makes rather than through
 * Postgres, on `application-credential-refs.spec.ts`' terms.
 */

const ctx: PermissionCtx = {
  user: { id: 'usr-1' },
  session: { activeOrganizationId: 'org-1' },
};

const row = {
  backupId: 'bk-1',
  schedule: '0 3 * * *',
  enabled: true,
  prefix: 'daily',
  database: 'shop',
  appName: 'backup-abc123',
  keepLatestCount: null,
  destinationId: 'dst-1',
  backupType: 'database',
  databaseType: 'postgres',
  postgresId: 'pg-1',
  serviceName: null,
  metadata: null,
} as unknown as Backup;

const parent = {
  serviceId: 'pg-1',
  name: 'Main DB',
  appName: 'main-db',
  serverId: null,
  projectName: 'cloudgate',
  organizationId: 'org-1',
  composeType: null,
};

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

/**
 * The Destination lookup, answering with a row carrying the id it was handed —
 * which is what the real `DestinationsService.findOne` does, its `where` being
 * `destination_id = ? AND organization_id = ?`.
 */
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
  const service = new BackupsService(
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
  // Both are Postgres reads that run before the resolution under test —
  // `service-access-level.spec.ts`' reason for spying the same two out.
  jest
    .spyOn(service as never, 'findParentService')
    .mockResolvedValue(parent as never);
  jest.spyOn(service as never, 'findRow').mockResolvedValue(row as never);
  return { service, written, destinations };
}

const createDto = {
  schedule: '0 3 * * *',
  prefix: 'daily',
  database: 'shop',
  destinationId: 'dst-1',
  databaseType: 'postgres' as const,
  backupType: 'database' as const,
  serviceId: 'pg-1',
} satisfies CreateBackupDto;

const patch = (data: Partial<UpdateBackupDto>) => data as UpdateBackupDto;

describe('BackupsService, on the credential-bearing id in its body', () => {
  it('resolves create destinationId through the Destination lookup and inserts the id it authorized', async () => {
    const { service, written, destinations } = makeService();

    await service.create(ctx, createDto);

    expect(destinations.findOne).toHaveBeenCalledWith(ctx, 'dst-1');
    // `findOne`, not `findOneWithCredentials`: the resolved id is all this
    // module asked for, so no decrypted secret access key reaches it.
    expect(destinations.findOneWithCredentials).not.toHaveBeenCalled();
    expect(written.values).toEqual({
      schedule: '0 3 * * *',
      prefix: 'daily',
      database: 'shop',
      destinationId: 'dst-1',
      databaseType: 'postgres',
      backupType: 'database',
      postgresId: 'pg-1',
    });
  });

  it('refuses create when the Destination lookup does not find the row, and writes nothing', async () => {
    // The refusal is `DestinationsService`' own, unmodified — one `where`
    // covers a foreign id and an id that exists nowhere, so the two are
    // refused byte-identically (§2.2 / ADR-0008).
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
      'bk-1',
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
      service.update(ctx, 'bk-1', patch({ destinationId: 'dst-2' })),
    ).rejects.toThrow(refusal);

    expect(written.values).toBeUndefined();
  });

  it('resolves nothing for a PATCH that mentions no destination', async () => {
    // `updateBackupSchema` is `.partial()`, so `undefined` is "this PATCH does
    // not mention the column". A guard that resolved it would refuse every
    // reschedule.
    const { service, written, destinations } = makeService();

    await service.update(ctx, 'bk-1', patch({ schedule: '0 4 * * *' }));

    expect(destinations.findOne).not.toHaveBeenCalled();
    expect(written.values).toEqual({ schedule: '0 4 * * *' });
  });
});

describe('BACKUP_CREDENTIAL_REFS', () => {
  /**
   * `serviceId` is the backed-up Service and is `findParentService`'s job — a
   * polymorphic parent resolved over eight tables, which answers about a
   * workload rather than about a credential.
   */
  const NOT_A_CREDENTIAL_ROW = ['serviceId'];

  it.each([
    ['createBackupSchema', createBackupSchema],
    ['updateBackupSchema', updateBackupSchema],
  ])('covers every parent id %s accepts', (_name, schema) => {
    // The direction the `Record<BackupCredentialRef, …>` lookup table cannot
    // check. That type refuses a *name* added to the list with no lookup
    // beside it; this refuses a second `*Id` added to a schema with no entry
    // in the list, which is how the earlier defect came to exist one module over.
    const ids = Object.keys(schema.shape)
      .filter((key) => key.endsWith('Id'))
      .filter((key) => !NOT_A_CREDENTIAL_ROW.includes(key));

    expect([...ids].sort()).toEqual([...BACKUP_CREDENTIAL_REFS].sort());
  });
});
