import { BadRequestException } from '@nestjs/common';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { Mount } from '../../src/mounts/mount.schema';
import { MountsService } from '../../src/mounts/mounts.service';
import type { UpdateMountDto } from '../../src/mounts/dto/mount.dto';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { PermissionService } from '../../src/rbac/permission.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';

/**
 * The half `createMountSchema` cannot decide.
 *
 * A Compose stack consumes exactly one kind of Mount row: a **file** mount,
 * which `MountsService` writes under `{composeDirectory}/{appName}/files` and
 * the operator's own `volumes:` key mounts. A bind or a volume mount attached
 * to a stack is read by nothing — `ComposeService.findDeployable` loads no
 * mounts, `DeployableCompose` declares no field for them, and `mechanize`
 * builds a swarm service's `Mounts` for an application. So `createMountSchema`
 * now refuses those two kinds on a stack.
 *
 * `updateMountSchema` cannot: `serviceType` is deliberately not in it, because
 * a mount cannot be re-pointed at another service — so the schema does not know
 * whether the row it is patching belongs to a stack. `type` *is* in it, and
 * `.partial()`, so a `PATCH` was the way round the create rule, which is the
 * create-then-patch shape that file already argues about for `filePath`. The
 * refusal therefore lives where the stored row is: in the service, after the
 * gates, so a caller with no access to the Service still gets 403 rather than
 * a 400 that says what kind of row it is.
 */
describe('MountsService', () => {
  const ctx: PermissionCtx = {
    user: { id: 'usr-1' },
    session: { activeOrganizationId: 'org-1' },
  };

  const parent = { appName: 'main-stack', serverId: null };

  const composeFileMount = {
    mountId: 'mnt-1',
    type: 'file',
    serviceType: 'compose',
    composeId: 'cmp-1',
    filePath: './conf/app.ini',
    content: 'password = hunter2',
    mountPath: '',
    hostPath: null,
    volumeName: null,
  } as unknown as Mount;

  const applicationBindMount = {
    mountId: 'mnt-2',
    type: 'bind',
    serviceType: 'application',
    applicationId: 'app-1',
    hostPath: '/srv/blog',
    mountPath: '/srv/data',
    filePath: null,
    content: null,
    volumeName: null,
  } as unknown as Mount;

  /** What the patch wrote, so a refusal can also assert nothing happened. */
  interface Written {
    values?: Record<string, unknown>;
  }

  const makeService = (row: Mount) => {
    const written: Written = {};
    const remoteExec = {
      execAsync: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      execAsyncRemote: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    } as unknown as RemoteExecService;
    const db = {
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
    } as unknown as DrizzleDB;

    const service = new MountsService(
      db,
      {
        checkPermission: jest.fn().mockResolvedValue(undefined),
        checkServiceAccess: jest.fn().mockResolvedValue(undefined),
      } as unknown as PermissionService,
      remoteExec,
    );
    // The row read and the parent lookup are Postgres and run before the
    // decision under test — `service-access-level.spec.ts`' reason for spying
    // the same two out.
    jest.spyOn(service as never, 'findRow').mockResolvedValue(row as never);
    jest
      .spyOn(service as never, 'findParentService')
      .mockResolvedValue(parent as never);
    return { service, written, remoteExec };
  };

  const patch = (data: Partial<UpdateMountDto>) => data as UpdateMountDto;

  describe('a PATCH that would make a compose stack take a bind or a volume', () => {
    it.each(['bind', 'volume'] as const)(
      'refuses type %s on a mount of a Compose stack, and writes nothing',
      async (type) => {
        const { service, written } = makeService(composeFileMount);

        await expect(
          service.update(ctx, 'mnt-1', patch({ type })),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(written.values).toBeUndefined();
      },
    );

    it('leaves a patch of the compose file mount itself alone', async () => {
      const { service, written } = makeService(composeFileMount);

      await service.update(ctx, 'mnt-1', patch({ content: 'password = new' }));

      expect(written.values).toEqual({ content: 'password = new' });
    });

    it('leaves the same patch on an application mount alone', async () => {
      // The refusal is about the stack and not about the kind. The three nulls
      // beside the new type are the change of kind clearing the bind's source
      // which is what the write looks like once it is not refused.
      const { service, written } = makeService(applicationBindMount);

      await service.update(ctx, 'mnt-2', patch({ type: 'volume' }));

      expect(written.values).toEqual({
        type: 'volume',
        hostPath: null,
        filePath: null,
        content: null,
      });
    });
  });
});
