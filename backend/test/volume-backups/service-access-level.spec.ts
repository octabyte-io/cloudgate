import { ForbiddenException } from '@nestjs/common';
import type { ServiceParent } from '../../src/common/service-parent';
import type { DestinationsService } from '../../src/destinations/destinations.service';
import type {
  PermissionCtx,
  Permissions,
} from '../../src/rbac/permission.service';
import { PermissionService } from '../../src/rbac/permission.service';
import { ac, memberRole, ownerRole } from '../../src/rbac/access-control';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { SchedulingService } from '../../src/scheduling/scheduling.service';
import type { VolumeBackup } from '../../src/volume-backups/volume-backup.schema';
import { VolumeBackupsService } from '../../src/volume-backups/volume-backups.service';
import { SELF_HOSTED } from '../utils/instance-mode-double';

/**
 * The permission level and the prefix bound, which are two halves of the same
 * reach.
 *
 * **The level.** Registering a volume backup, re-pointing one and running a
 * restore all reached `PermissionService.checkServiceAccess` with no `action`,
 * so all three were authorized by `service: ['read']` on the owning Service —
 * while `volumeName` is caller-supplied and charset-checked only, which is what
 * made "may read this Service" mean "may tar, or destroy and replace, any
 * volume on its host". The three now claim `'update'`;
 * `VolumeBackupsService.create` carries the argument and what it costs whom.
 *
 * **The prefix.** A Destination's bucket is organization-wide, so raising
 * the level alone left a caller entitled to Service A able to name **Service B's**
 * tarball as `backupFileName`, untar it into a volume of A, and read B's data
 * through A. `VolumeBackupsService.checkTarballAccess` binds the key to the
 * Service whose `appName` it sits under and `assertPrefixOwnersEntitled` carries
 * the rule; that half is asserted here through the entitlement column rather
 * than the level. The `..` block at the bottom records why its guard is *not*
 * the finding it was filed as.
 *
 * **What this spec is, and why it is not a call-shape assertion.** The gate is
 * driven through the **real role definitions**: the stub `PermissionService`
 * below implements the two things the real one does — `role.authorize` on the
 * requested statement, and `role.authorize({ service: [action] })` for the
 * row-level level — and the roles are `ownerRole` and `memberRole` imported
 * from `access-control.ts` plus an `ac.newRole` custom role, the same way
 * `test/rbac/access-control.spec.ts` builds one. So the expectation comes from
 * the statement tables rather than from restating the literal in the service
 * (§1.7): if `memberRole` ever loses `service: ['update']`, the three
 * capability assertions here go red rather than silently agreeing.
 *
 * **`'past the gate'` is proved by a sentinel, not by success.** Every write
 * under test reaches the Destination lookup immediately after both permission
 * checks — `findOne` from the two write seams, still
 * `findOneWithCredentials` from a run and a restore — so a stub that throws a
 * distinctive error from both says "both gates passed" without this spec
 * having to stand up a Destination, a run recorder and a shell. The
 * parent-service lookup and the row read are spied out for the same reason —
 * they run *before* the gate and are Postgres,
 * and what is under test is the decision between them.
 */
describe('VolumeBackupsService, the level its writes claim and the prefix its restore accepts', () => {
  /** Thrown by the collaborator that sits immediately behind both gates. */
  const PAST_THE_GATE = new Error('reached the destination lookup');

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

  type Role = ReturnType<typeof ac.newRole>;

  /**
   * A Service that claims a bucket prefix, as `servicesOwningPrefixes` reads
   * one back.
   */
  interface PrefixOwner {
    serviceId: string;
    appName: string;
    organizationId: string;
  }

  /**
   * A `PermissionService` that decides exactly what the real one decides — the
   * requested statement, then `service: [action]` for the level, then the
   * row-level `accessedServices` membership.
   *
   * The entitlement half was not modelled before the prefix bound, because the
   * level fix's variable was the level alone. It is modelled now: the prefix
   * bound is a decision about a Service the caller is *not* entitled to, and
   * entitlement is the only thing that separates it from the target.
   *
   * `entitled: null` stands for a privileged role, which `checkServiceAccess`
   * waves past the row-level branch entirely.
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
    // `findOneWithCredentials` for the row rclone authenticates with. Both sit
    // immediately behind the gates under test, so either one firing means the
    // gates passed.
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

    const service = new VolumeBackupsService(
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

    // All three are Postgres reads that run before the decision under test.
    // `tarballPrefixOwners` is the eight-table union `serviceScope` builds, and
    // it is a method for exactly this reason — what is in question is what
    // `checkTarballAccess` does with the answer, not the SQL that gets it.
    jest
      .spyOn(service as never, 'findParentService')
      .mockResolvedValue(parent as never);
    jest.spyOn(service as never, 'findRow').mockResolvedValue(row as never);
    jest
      .spyOn(service as never, 'tarballPrefixOwners')
      .mockResolvedValue(prefixOwners as never);

    return { service, effects };
  };

  /**
   * `'refused'` when the gate answered 403, `'past the gate'` when the call
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
    name: 'nightly uploads',
    volumeName: 'shop-data',
    prefix: 'daily',
    schedule: '0 3 * * *',
    serviceType: 'application' as const,
    serviceId: 'app-1',
    turnOff: false,
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
        repoint.service.update(ctx, 'vb-1', {
          volumeName: 'someone-elses-data',
          destinationId: 'dst-2',
        }),
      ),
      restore: await outcomeOf(
        restore.service.restore(ctx, {
          serviceId: 'app-1',
          serviceType: 'application',
          volumeName: 'someone-elses-data',
          backupFileName: 'main-app/daily/someone-elses-data-2026-01-01.tar',
          destinationId: 'dst-1',
        }),
      ),
      runManual: await outcomeOf(run.service.runManual(ctx, 'vb-1')),
      findOne: await outcomeOf(read.service.findOne(ctx, 'vb-1')),
      listByService: await outcomeOf(
        list.service.listByService(ctx, {
          serviceId: 'app-1',
          serviceType: 'application',
        }),
      ),
      remove: await outcomeOf(remove.service.remove(ctx, 'vb-1')),
    };
  };

  /**
   * The role the level is about: a licensed custom role granted every
   * `volumeBackup` action and `service: ['read']` — "may see and operate this
   * Service" — which is precisely what `checkServiceAccess`'s defaulted
   * `'read'` used to accept for all three writes.
   */
  const readOnlyOnTheService = ac.newRole({
    service: ['read'],
    volumeBackup: ['read', 'create', 'update', 'delete', 'restore'],
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

    // Nothing was inserted, nothing was scheduled, and no script went to a run
    // host on the way to being refused.
    expect(effects).toEqual({ writes: [], executed: [], scheduled: [] });
  });

  it('writes nothing and reaches no host when it refuses the restore', async () => {
    const { service, effects } = serviceFor(readOnlyOnTheService);

    await expect(
      service.restore(ctx, {
        serviceId: 'app-1',
        serviceType: 'application',
        volumeName: 'someone-elses-data',
        backupFileName: 'main-app/daily/someone-elses-data-2026-01-01.tar',
        destinationId: 'dst-1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(effects).toEqual({ writes: [], executed: [], scheduled: [] });
  });

  /**
   * The other half, and the one that says raising the level is not a feature
   * removal: the reads and the operate verb are untouched, so a role built to
   * see its Service and run the backups somebody else registered keeps working.
   * This is the operate-verb carve-out — `runManual` executes a stored row and
   * claims `volumeBackup: ['create']`, not a definition write.
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
   * on the service call so the reason is legible: this is the fact that makes
   * `'update'` the available level.
   */
  it('records that the base member holds the update it now needs and no delete', () => {
    expect({
      read: memberRole.authorize({ service: ['read'] }).success,
      update: memberRole.authorize({ service: ['update'] }).success,
      delete: memberRole.authorize({ service: ['delete'] }).success,
    }).toEqual({ read: true, update: true, delete: false });
  });

  /**
   * The prefix bound's second half, and the one the level cannot reach:
   * `memberRole` holds `service: ['read', 'update']`, so a base member passes
   * the raised gate on the Service they are entitled to — and the bucket is
   * shared, so the key is where the reach was.
   * `VolumeBackupsService.checkTarballAccess` binds it and
   * `assertPrefixOwnersEntitled` carries the rule.
   */
  describe('the prefix a restore key sits under', () => {
    const restoreOf = (backupFileName: string) => ({
      serviceId: 'app-1',
      serviceType: 'application' as const,
      volumeName: 'storefront-data',
      backupFileName,
      destinationId: 'dst-1',
    });

    /** Application B, which this caller is not entitled to. */
    const foreignOwner: PrefixOwner = {
      serviceId: 'app-2',
      appName: 'ledger',
      organizationId: 'org-1',
    };

    it('refuses a key under another service’s prefix', async () => {
      const { service, effects } = serviceFor(memberRole, {
        entitled: ['app-1'],
        prefixOwners: [foreignOwner],
      });

      await expect(
        service.restore(ctx, restoreOf('ledger/daily/ledger-data-2026.tar')),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(effects).toEqual({ writes: [], executed: [], scheduled: [] });
    });

    it('accepts the caller’s own prefix', async () => {
      const { service } = serviceFor(memberRole, {
        entitled: ['app-1'],
        prefixOwners: [
          { serviceId: 'app-1', appName: 'main-app', organizationId: 'org-1' },
        ],
      });

      expect(
        await outcomeOf(
          service.restore(
            ctx,
            restoreOf('main-app/daily/storefront-data-2026.tar'),
          ),
        ),
      ).toBe('past the gate');
    });

    /**
     * An `application` prefix, which is the case the old six-table resolver could
     * not see at all — its own docblock said so, and named a volume tarball
     * parked under one as the gap. Both owners here are Applications, so this is
     * red unless the resolver covers all eight service tables.
     */
    it('refuses a key under another application’s prefix, not only an engine’s', async () => {
      const { service } = serviceFor(memberRole, {
        entitled: ['app-1'],
        prefixOwners: [foreignOwner],
      });

      expect(
        await outcomeOf(
          service.restore(ctx, restoreOf('ledger/daily/anything.tar')),
        ),
      ).toBe('refused');
    });

    /**
     * A compose backup's tarballs live under `{appName}_{serviceName}`, so the
     * leading segment is not an `appName` and has to be trimmed back to one —
     * `bucketPrefixCandidates`. Without the trim this key would read as unowned
     * and every compose stack's tarballs would stay reachable.
     */
    it('refuses a compose stack’s {appName}_{serviceName} prefix through the trim', async () => {
      const { service } = serviceFor(memberRole, {
        entitled: ['app-1'],
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
          service.restore(ctx, restoreOf('shop-stack_db/daily/vol-2026.tar')),
        ),
      ).toBe('refused');
    });

    /**
     * The shadowing attack `assertPrefixOwnersEntitled` requires *every*
     * resolved owner to be entitled for: `appName` is unique per table, so a
     * caller who may create Services can mint one carrying a victim's name in
     * another table. A rule satisfied by any one entitled owner would let their
     * own row vouch for the victim's prefix.
     */
    it('refuses a prefix a caller’s own service shares a name with', async () => {
      const { service } = serviceFor(memberRole, {
        entitled: ['app-1'],
        prefixOwners: [
          { serviceId: 'app-1', appName: 'ledger', organizationId: 'org-1' },
          foreignOwner,
        ],
      });

      expect(
        await outcomeOf(
          service.restore(ctx, restoreOf('ledger/daily/anything.tar')),
        ),
      ).toBe('refused');
    });

    /**
     * The decision rather than a gap: a prefix no Service claims is a tarball of
     * a Service that was destroyed and recreated, or one uploaded by hand, and
     * refusing those is refusing disaster recovery at the moment it is needed.
     * It is not a way back to a live Service's data, because a live Service's
     * prefix always resolves.
     */
    it('accepts a prefix no service claims', async () => {
      const { service } = serviceFor(memberRole, {
        entitled: ['app-1'],
        prefixOwners: [],
      });

      expect(
        await outcomeOf(
          service.restore(ctx, restoreOf('main-app-before-the-rebuild/x.tar')),
        ),
      ).toBe('past the gate');
    });

    /**
     * A prefix another organization's Service claims is refused rather than read
     * as unowned — nothing stops two Organizations pointing Destinations at the
     * same bucket, which is why `servicesOwningPrefixes` is deliberately not
     * org-scoped. `entitled: null` here is a privileged role, so the row-level
     * branch cannot be what refuses this.
     */
    it('refuses a prefix another organization’s service claims', async () => {
      const { service } = serviceFor(ownerRole, {
        entitled: null,
        prefixOwners: [
          { serviceId: 'app-9', appName: 'ledger', organizationId: 'org-2' },
        ],
      });

      expect(
        await outcomeOf(
          service.restore(ctx, restoreOf('ledger/daily/anything.tar')),
        ),
      ).toBe('refused');
    });

    /**
     * The `..` segment, whose live sink is the run host's filesystem rather than
     * the bucket: `buildVolumeRestoreScript` stages the download at
     * `{volumeBackupsDirectory}/{volumeName}/{backupFileName}` and the cleanup
     * `trap … EXIT` runs `rm -f` on it. It also keeps the bound above
     * well-posed. A bad request rather than the 403 above, deliberately —
     * answering 403 would make it an oracle for prefixes that do exist.
     */
    it('refuses a key carrying a .. segment as a bad request, not a forbidden', async () => {
      const { service, effects } = serviceFor(memberRole, {
        entitled: ['app-1'],
        prefixOwners: [foreignOwner],
      });

      const refusal = await service
        .restore(ctx, restoreOf('main-app/../../../../etc/cron.d/pwn.tar'))
        .then(
          () => null,
          (error: Error) => error,
        );

      expect(refusal).not.toBeInstanceOf(ForbiddenException);
      expect(refusal?.message).toContain('".." segment');
      expect(effects).toEqual({ writes: [], executed: [], scheduled: [] });
    });
  });

  /**
   * The prefix bound's first half, and it is **not** the finding it was filed
   * as — which is worth pinning here so nobody re-derives the wrong reason for
   * this guard.
   *
   * It was reported as a live write across the boundary: `normalizeS3Path`
   * strips slashes only, so `prefix` could climb out of the Service's own
   * directory and put its tarballs, and `pruneOldBackups`' `rclone delete`,
   * under a sibling's. Measured against a local S3 endpoint with this
   * application's own invocation form, that does not happen: rclone's
   * `--s3-encoding` defaults to `Slash,InvalidUtf8,Dot` for every provider, so a
   * `.` or `..` *segment* is rewritten to fullwidth stops before it reaches the
   * wire — and an S3 key is an opaque byte string even with `Dot` dropped, so
   * nothing resolves. The objects land inside the Service's own prefix, at an
   * ugly `．．` sub-directory.
   *
   * The guard stays for two reasons that are true: `backupFileName`'s `..` *is*
   * live one function over (see the block above), and refusing the segment on
   * the write is what stops a stored `prefix` from making the key's leading
   * segment mean one thing to `checkTarballAccess` and another to rclone if that
   * encoder default ever changes. Consistency with `BackupsService`, which has
   * refused the same segment on the same column, is the third.
   */
  describe('a stored prefix that carries a .. segment', () => {
    const traversing = 'daily/../ledger';

    it('refuses the register, and writes nothing', async () => {
      const { service, effects } = serviceFor(ownerRole);

      const refusal = await service
        .create(ctx, { ...createDto, prefix: traversing })
        .then(
          () => null,
          (error: Error) => error,
        );

      expect(refusal?.message).toContain('".." segment');
      // Ahead of the insert *and* of `syncJob`, so a refused register leaves no
      // cron job behind either.
      expect(effects).toEqual({ writes: [], executed: [], scheduled: [] });
    });

    it('refuses the re-point, and writes nothing', async () => {
      const { service, effects } = serviceFor(ownerRole);

      const refusal = await service
        .update(ctx, 'vb-1', { prefix: traversing })
        .then(
          () => null,
          (error: Error) => error,
        );

      expect(refusal?.message).toContain('".." segment');
      expect(effects).toEqual({ writes: [], executed: [], scheduled: [] });
    });

    it('leaves a patch that does not touch the prefix alone', async () => {
      const { service } = serviceFor(ownerRole);

      expect(
        await outcomeOf(service.update(ctx, 'vb-1', { turnOff: true })),
      ).toBe('past the gate');
    });
  });
});
