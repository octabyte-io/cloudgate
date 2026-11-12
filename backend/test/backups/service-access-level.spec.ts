import { ForbiddenException } from '@nestjs/common';
import type { Backup } from '../../src/backups/backup.schema';
import { BackupsService } from '../../src/backups/backups.service';
import type { DestinationsService } from '../../src/destinations/destinations.service';
import { ac, memberRole, ownerRole } from '../../src/rbac/access-control';
import type {
  PermissionCtx,
  Permissions,
} from '../../src/rbac/permission.service';
import { PermissionService } from '../../src/rbac/permission.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { SchedulingService } from '../../src/scheduling/scheduling.service';
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
 * The backup-authorization fix, both halves.
 *
 * **The level.** Registering a backup, re-pointing one and restoring a dump all
 * reached `PermissionService.checkServiceAccess` with no `action`, so all three
 * were authorized by `service: ['read']` on the backed-up Service — while a
 * restore's effect is to overwrite that Service's database from a key that
 * comes off the wire. The three now claim `'update'`; `BackupsService.create`
 * carries the argument and what it costs whom. It is an earlier finding one module
 * over.
 *
 * **The prefix.** A Destination's bucket is organization-wide, so raising the
 * level alone left a caller entitled to Service A able to name **Service B's**
 * dump as `backupFile` and read B's data through A.
 * `BackupsService.checkBackupFileAccess` binds the key to the Service whose
 * `appName` it sits under, and that half is asserted here through the
 * entitlement column rather than the level.
 *
 * **Why this is not a call-shape assertion.** The gate is driven through the
 * **real role definitions**: the stub `PermissionService` implements the two
 * things the real one does — `role.authorize` on the requested statement, and
 * `role.authorize({ service: [action] })` for the level — and the roles are
 * `ownerRole` and `memberRole` imported from `access-control.ts` plus an
 * `ac.newRole` custom role, the way `test/rbac/access-control.spec.ts` builds
 * one. So the expectation comes from the statement tables rather than from
 * restating the literal in the service (§1.7): if `memberRole` ever loses
 * `service: ['update']`, the capability assertions here go red rather than
 * silently agreeing.
 *
 * **`'past the gate'` is proved by a sentinel, not by success.** Every write
 * under test reaches the Destination lookup once the permission checks are
 * done — `findOne` from the two write seams, still
 * `findOneWithCredentials` from a run and a restore — so a stub that throws a
 * distinctive error from both says "the gates passed" without this spec
 * standing up a Destination, a run recorder and a shell. The parent-service
 * lookup and the row read are spied out for the same reason — they run
 * *before* the gate and are Postgres, and
 * what is under test is the decision between them.
 */
describe('BackupsService, the level its writes claim and the prefix its restore accepts', () => {
  /** Thrown by the collaborator that sits behind every gate under test. */
  const PAST_THE_GATE = new Error('reached the destination lookup');

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

  type Role = ReturnType<typeof ac.newRole>;

  /**
   * A Service that claims a bucket prefix, as
   * `BackupsService.servicesOwningPrefixes` reads one back.
   */
  interface PrefixOwner {
    serviceId: string;
    appName: string;
    organizationId: string;
  }

  /**
   * A `PermissionService` that decides exactly what the real one decides — the
   * requested statement, then `service: [action]` for the level, then the
   * row-level `accessedServices` membership. The entitlement half *is* modelled
   * here, unlike that earlier spec, because the prefix bound is a decision about a
   * Service the caller is not entitled to and there is nothing else to separate
   * it from the target.
   *
   * `entitled: null` stands for a privileged role, which
   * `checkServiceAccess` waves past the row-level branch entirely.
   */
  const gateFor = (role: Role, entitled: string[] | null): PermissionService =>
    ({
      checkPermission: (_ctx: PermissionCtx, permissions: Permissions) => {
        if (!role.authorize(permissions).success) {
          throw new ForbiddenException('Insufficient permissions');
        }
        return Promise.resolve();
      },
      checkServiceAccess: (
        _ctx: PermissionCtx,
        serviceId: string,
        action: 'create' | 'read' | 'update' | 'delete' = 'read',
      ) => {
        if (!role.authorize({ service: [action] }).success) {
          throw new ForbiddenException("You don't have access to this service");
        }
        if (entitled && !entitled.includes(serviceId)) {
          throw new ForbiddenException("You don't have access to this service");
        }
        return Promise.resolve();
      },
    }) as unknown as PermissionService;

  /** What a call did, so a refusal can also assert that nothing happened. */
  type Effects = { writes: string[]; executed: string[]; scheduled: string[] };

  const serviceFor = (
    role: Role,
    options: { entitled?: string[] | null; prefixOwners?: PrefixOwner[] } = {},
  ) => {
    const effects: Effects = { writes: [], executed: [], scheduled: [] };
    const { entitled = null, prefixOwners = [] } = options;

    const db = {
      // `listByService` reads through the relational builder rather than the
      // query builder, and it is a read: it has to get past the gate too.
      query: { backup: { findMany: () => Promise.resolve([row]) } },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([row]),
            orderBy: () => Promise.resolve([row]),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => {
            effects.writes.push('insert');
            return Promise.resolve([row]);
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => {
              effects.writes.push('update');
              return Promise.resolve([row]);
            },
          }),
        }),
      }),
      delete: () => ({
        where: () => ({
          returning: () => {
            effects.writes.push('delete');
            return Promise.resolve([row]);
          },
        }),
      }),
    };

    // Two sentinels rather than one: a write seam resolves
    // `destinationId` through `findOne` (the credential-ref loop, which is
    // handed back an id and no secret), and a run or a restore still reaches
    // `findOneWithCredentials` for the row rclone authenticates with. Both are
    // behind every gate under test, so either one firing means the gates
    // passed.
    const destinations = {
      findOne: () => Promise.reject(PAST_THE_GATE),
      findOneWithCredentials: () => Promise.reject(PAST_THE_GATE),
    } as unknown as DestinationsService;

    const remoteExec = {
      execAsync: (command: string) => {
        effects.executed.push(command);
        return Promise.resolve({ stdout: '', stderr: '' });
      },
      execAsyncRemote: (_serverId: string, command: string) => {
        effects.executed.push(command);
        return Promise.resolve({ stdout: '', stderr: '' });
      },
    } as unknown as RemoteExecService;

    const scheduling = {
      register: (id: string) => {
        effects.scheduled.push(`register ${id}`);
      },
      unregister: (id: string) => {
        effects.scheduled.push(`unregister ${id}`);
      },
    } as unknown as SchedulingService;

    const service = new BackupsService(
      db as never,
      gateFor(role, entitled),
      remoteExec,
      destinations,
      null as never,
      scheduling,
      null as never,
      null as never,
      SELF_HOSTED,
    );

    // All four are Postgres reads that run before the decision under test.
    // `servicesOwningPrefixes` became the eight-table union `serviceScope`
    // builds now — a hand-rolled query builder cannot stand that up, and
    // it does not need to: what is in question is what
    // `checkBackupFileAccess` does with the answer, not the SQL that gets it.
    // Which eight tables it really reaches is asserted over HTTP instead, in
    // `backup-authorization.e2e-spec.ts`.
    jest
      .spyOn(service as never, 'findParentService')
      .mockResolvedValue(parent as never);
    jest
      .spyOn(service as never, 'findParentForServiceType')
      .mockResolvedValue(parent as never);
    jest.spyOn(service as never, 'findRow').mockResolvedValue(row as never);
    jest
      .spyOn(service as never, 'servicesOwningPrefixes')
      .mockResolvedValue(prefixOwners as never);

    return { service, effects };
  };

  /**
   * `'refused'` when a gate answered 403, `'past the gate'` when the call
   * reached the collaborator behind it. Anything else is rethrown rather than
   * folded into one of the two — a spec that reported a missing stub as
   * `'refused'` would pass for the wrong reason.
   */
  const outcomeOf = async (
    call: Promise<unknown>,
  ): Promise<'refused' | 'past the gate'> => {
    try {
      await call;
      return 'past the gate';
    } catch (error) {
      if (error instanceof ForbiddenException) return 'refused';
      if (error === PAST_THE_GATE) return 'past the gate';
      throw error;
    }
  };

  const createDto = {
    schedule: '0 3 * * *',
    prefix: 'daily',
    database: 'shop',
    destinationId: 'dst-1',
    databaseType: 'postgres' as const,
    backupType: 'database' as const,
    serviceId: 'pg-1',
  };

  const restoreDto = {
    databaseId: 'pg-1',
    databaseType: 'postgres' as const,
    backupType: 'database' as const,
    databaseName: 'shop',
    backupFile: 'main-db/daily/2026-07-23T10-20-30-456Z.sql.gz',
    destinationId: 'dst-1',
  };

  const everyRoute = async (role: Role) => {
    const register = serviceFor(role);
    const repoint = serviceFor(role);
    const restore = serviceFor(role);
    const run = serviceFor(role);
    const read = serviceFor(role);
    const list = serviceFor(role);
    const remove = serviceFor(role);

    return {
      create: await outcomeOf(register.service.create(ctx, createDto)),
      update: await outcomeOf(
        repoint.service.update(ctx, 'bk-1', {
          prefix: 'weekly',
          destinationId: 'dst-2',
        }),
      ),
      restore: await outcomeOf(restore.service.restore(ctx, restoreDto)),
      runManual: await outcomeOf(run.service.runManual(ctx, 'bk-1')),
      findOne: await outcomeOf(read.service.findOne(ctx, 'bk-1')),
      listByService: await outcomeOf(
        list.service.listByService(ctx, {
          serviceId: 'pg-1',
          serviceType: 'postgres',
        }),
      ),
      remove: await outcomeOf(remove.service.remove(ctx, 'bk-1')),
    };
  };

  /**
   * The role the fix's first half is about: a licensed custom role granted every
   * `backup` action and `service: ['read']` — "may see and operate this
   * Service" — which is precisely what `checkServiceAccess`'s defaulted
   * `'read'` used to accept for all three writes.
   */
  const readOnlyOnTheService = ac.newRole({
    service: ['read'],
    backup: ['read', 'create', 'update', 'delete', 'restore'],
  });

  it('refuses a caller holding service read to register, re-point and restore', async () => {
    expect(await everyRoute(readOnlyOnTheService)).toMatchObject({
      create: 'refused',
      update: 'refused',
      restore: 'refused',
    });
  });

  it('writes nothing and reaches no host when it refuses the register', async () => {
    const { service, effects } = serviceFor(readOnlyOnTheService);

    await expect(service.create(ctx, createDto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(effects).toEqual({ writes: [], executed: [], scheduled: [] });
  });

  it('writes nothing and reaches no host when it refuses the restore', async () => {
    const { service, effects } = serviceFor(readOnlyOnTheService);

    await expect(service.restore(ctx, restoreDto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(effects).toEqual({ writes: [], executed: [], scheduled: [] });
  });

  /**
   * The other half of the level, and the one that says the fix is not a feature
   * removal: the reads, the manual run and the delete are untouched, so a role
   * built to see its Service and run the backups somebody else registered keeps
   * working. That is the deliberate carve-out — `runManual` executes a stored row that
   * only an `'update'` holder can now have written.
   */
  it('leaves the reads, the manual run and the delete open to that same caller', async () => {
    expect(await everyRoute(readOnlyOnTheService)).toMatchObject({
      runManual: 'past the gate',
      findOne: 'past the gate',
      listByService: 'past the gate',
      remove: 'past the gate',
    });
  });

  it('lets the base member role register, re-point and restore as it always could', async () => {
    // `memberRole` holds `service: ['read', 'update']`, so the base
    // member loses nothing here. If that line ever changes, this goes red.
    expect(await everyRoute(memberRole)).toEqual({
      create: 'past the gate',
      update: 'past the gate',
      restore: 'past the gate',
      runManual: 'past the gate',
      findOne: 'past the gate',
      listByService: 'past the gate',
      remove: 'past the gate',
    });
  });

  it('lets an owner register, re-point and restore', async () => {
    expect(await everyRoute(ownerRole)).toEqual({
      create: 'past the gate',
      update: 'past the gate',
      restore: 'past the gate',
      runManual: 'past the gate',
      findOne: 'past the gate',
      listByService: 'past the gate',
      remove: 'past the gate',
    });
  });

  /**
   * The anti-rot assertion. Every capability above would also pass if the level
   * had been raised past `'update'` to `'delete'` — `ownerRole` holds that too
   * — and `memberRole` does not, which is why `'delete'` is rejected in
   * `create`'s docblock as a feature removal. Asserted on the role rather than
   * on the service call so the reason is legible.
   */
  it('records that the base member holds the update it now needs and no delete', () => {
    expect({
      read: memberRole.authorize({ service: ['read'] }).success,
      update: memberRole.authorize({ service: ['update'] }).success,
      delete: memberRole.authorize({ service: ['delete'] }).success,
    }).toEqual({ read: true, update: true, delete: false });
  });

  /**
   * The fix's second half, and the one the level cannot reach: `memberRole` holds
   * `service: ['read', 'update']`, so a base member passes the raised gate on
   * the Service they are entitled to — and the bucket is shared, so the key is
   * where the reach was.
   */
  describe('the prefix a restore key sits under', () => {
    /** Service B, which this caller is not entitled to. */
    const foreignOwner: PrefixOwner = {
      serviceId: 'pg-2',
      appName: 'ledger-db',
      organizationId: 'org-1',
    };

    it('refuses a key under another service’s prefix', async () => {
      const { service, effects } = serviceFor(memberRole, {
        entitled: ['pg-1'],
        prefixOwners: [foreignOwner],
      });

      await expect(
        service.restore(ctx, {
          ...restoreDto,
          backupFile: 'ledger-db/daily/2026-07-23T10-20-30-456Z.sql.gz',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(effects).toEqual({ writes: [], executed: [], scheduled: [] });
    });

    it('accepts the caller’s own prefix', async () => {
      const { service } = serviceFor(memberRole, {
        entitled: ['pg-1'],
        prefixOwners: [
          { serviceId: 'pg-1', appName: 'main-db', organizationId: 'org-1' },
        ],
      });

      expect(await outcomeOf(service.restore(ctx, restoreDto))).toBe(
        'past the gate',
      );
    });

    /**
     * A compose backup's dumps live under `{appName}_{serviceName}`, so the
     * leading segment is not an `appName` and has to be trimmed back to one —
     * `bucketPrefixCandidates`. Without the trim this key would read as unowned
     * and every compose dump would stay reachable.
     */
    it('refuses a compose stack’s {appName}_{serviceName} prefix through the trim', async () => {
      const { service } = serviceFor(memberRole, {
        entitled: ['pg-1'],
        prefixOwners: [
          {
            serviceId: 'cmp-1',
            appName: 'shop-stack',
            organizationId: 'org-1',
          },
        ],
      });

      expect(
        await outcomeOf(
          service.restore(ctx, {
            ...restoreDto,
            backupFile: 'shop-stack_db/daily/2026-07-23.sql.gz',
          }),
        ),
      ).toBe('refused');
    });

    /**
     * The shadowing attack `checkBackupFileAccess` requires *every* resolved
     * owner to be entitled for: `appName` is unique per table, so a caller who
     * may create Services can mint one carrying a victim's name in another
     * table. A rule satisfied by any one entitled owner would let their own row
     * vouch for the victim's prefix.
     */
    it('refuses a prefix a caller’s own service shares a name with', async () => {
      const { service } = serviceFor(memberRole, {
        entitled: ['pg-1'],
        prefixOwners: [
          { serviceId: 'pg-1', appName: 'ledger-db', organizationId: 'org-1' },
          foreignOwner,
        ],
      });

      expect(
        await outcomeOf(
          service.restore(ctx, {
            ...restoreDto,
            backupFile: 'ledger-db/daily/2026-07-23.sql.gz',
          }),
        ),
      ).toBe('refused');
    });

    /**
     * The decision rather than a gap, argued in `checkBackupFileAccess`: a
     * prefix no Service claims is a dump of a Service that was destroyed and
     * recreated, or one uploaded by hand, and refusing those is refusing
     * disaster recovery at the moment it is needed. It is not a way back to a
     * live Service's data, because a live Service's prefix always resolves.
     */
    it('accepts a prefix no service claims', async () => {
      const { service } = serviceFor(memberRole, {
        entitled: ['pg-1'],
        prefixOwners: [],
      });

      expect(
        await outcomeOf(
          service.restore(ctx, {
            ...restoreDto,
            backupFile: 'restored-by-hand/2026-07-23.sql.gz',
          }),
        ),
      ).toBe('past the gate');
    });

    /**
     * The bound is on the *leading segment*, so a key that can climb out of one
     * would defeat it — the segment it is checked under and the object rclone
     * resolves would be different objects. `bucketKeySegments` refuses instead,
     * and this asserts the refusal is not the 403 above: it is a shape problem,
     * and answering 403 would make it an oracle for prefixes that do exist.
     */
    it('refuses a key carrying a .. segment as a bad request, not a forbidden', async () => {
      const { service } = serviceFor(memberRole, {
        entitled: ['pg-1'],
        prefixOwners: [foreignOwner],
      });

      const refusal = await service
        .restore(ctx, {
          ...restoreDto,
          backupFile: 'main-db/../ledger-db/daily/2026-07-23.sql.gz',
        })
        .then(
          () => null,
          (error: Error) => error,
        );

      expect(refusal).not.toBeInstanceOf(ForbiddenException);
      expect(refusal?.message).toContain('".." segment');
    });
  });
});
