import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { BillingService } from '../../src/cloud/billing/billing.service';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { ExecError } from '../../src/remote/exec-error';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { ServersService } from '../../src/servers/servers.service';
import type { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';

/**
 * A Server's last reach-check and setup outcome are stored, so every
 * tab reads one answer instead of each holding its own request's result until
 * the operator navigates away.
 *
 * The database is a double that records what was written, and the exec layer
 * one that answers with the shapes `RemoteExecService` really raises: a
 * transport failure carries no exit code, a script that ran and failed does.
 */

const SERVER_ID = 'srv-1';

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

const row = {
  serverId: SERVER_ID,
  organizationId: 'org-1',
  username: 'root',
  sshKeyId: 'key-1',
  command: '',
};

const sshRefused = () =>
  new ExecError('SSH connection error: connect ECONNREFUSED 127.0.0.1:1', {
    command: 'echo ok',
    serverId: SERVER_ID,
  });

const scriptFailed = () =>
  new ExecError('Remote command failed with exit code 1', {
    command: 'sh setup',
    serverId: SERVER_ID,
    exitCode: 1,
  });

function makeService(exec: jest.Mock) {
  const writes: Record<string, unknown>[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([row]) }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        writes.push(values);
        return { where: () => Promise.resolve() };
      },
    }),
  } as unknown as DrizzleDB;
  const remoteExec = {
    execAsyncRemote: exec,
    execRemote: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  } as unknown as RemoteExecService;
  const service = new ServersService(
    db,
    remoteExec,
    {} as BillingService,
    {
      findOne: jest.fn().mockResolvedValue({ name: 'deploy key' }),
    } as unknown as SshKeysService,
    {} as never,
    {} as never,
  );
  return { service, writes };
}

const reachWrites = (writes: Record<string, unknown>[]) =>
  writes.filter((w) => 'reachCheckedAt' in w);
const setupWrites = (writes: Record<string, unknown>[]) =>
  writes.filter((w) => 'setupRanAt' in w);

describe('ServersService stored outcomes', () => {
  describe('Check now', () => {
    it('stores a reach with no message when the Server answered', async () => {
      const { service, writes } = makeService(
        jest.fn().mockResolvedValue({ stdout: 'ok', stderr: '' }),
      );
      await service.validate(ctx, SERVER_ID);

      expect(reachWrites(writes)).toEqual([
        {
          reachCheckedAt: expect.any(String) as string,
          reachOk: true,
          reachMessage: null,
        },
      ]);
    });

    it('stores the failure in SSH’s own words, and still refuses', async () => {
      const { service, writes } = makeService(
        jest.fn().mockRejectedValue(sshRefused()),
      );
      await expect(service.validate(ctx, SERVER_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      const [stored] = reachWrites(writes);
      expect(stored.reachOk).toBe(false);
      expect(stored.reachMessage).toContain('ECONNREFUSED');
    });
  });

  describe('the readiness audit every tab shows', () => {
    it('stores the same "could not be reached" the audit cards are shown', async () => {
      const { service, writes } = makeService(
        jest.fn().mockRejectedValue(sshRefused()),
      );
      await expect(service.audit(ctx, SERVER_ID)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      expect(reachWrites(writes)).toEqual([
        expect.objectContaining({
          reachOk: false,
          reachMessage: 'This Server could not be reached',
        }),
      ]);
    });

    it('stores a reach when the audit ran', async () => {
      const { service, writes } = makeService(
        jest.fn().mockResolvedValue({ stdout: '{}', stderr: '' }),
      );
      await service.audit(ctx, SERVER_ID);

      expect(reachWrites(writes)).toEqual([
        expect.objectContaining({ reachOk: true, reachMessage: null }),
      ]);
    });
  });

  describe('Run setup', () => {
    it('stores a finished run, and that the Server was reached', async () => {
      const { service, writes } = makeService(
        jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      );
      await service.setup(ctx, SERVER_ID);

      expect(setupWrites(writes)).toEqual([
        {
          setupRanAt: expect.any(String) as string,
          setupOk: true,
          setupMessage: null,
        },
      ]);
      expect(reachWrites(writes)).toEqual([
        expect.objectContaining({ reachOk: true }),
      ]);
    });

    it('stores a script that ran and failed, and leaves the reach answer alone', async () => {
      const { service, writes } = makeService(
        jest.fn().mockRejectedValue(scriptFailed()),
      );
      await expect(service.setup(ctx, SERVER_ID)).rejects.toBeInstanceOf(
        ExecError,
      );

      expect(setupWrites(writes)).toEqual([
        expect.objectContaining({
          setupOk: false,
          setupMessage: expect.stringContaining('exit code 1') as string,
        }),
      ]);
      // It ran: the Server was reached, and nothing here says otherwise.
      expect(reachWrites(writes)).toEqual([]);
    });

    it('stores a run that never reached the Server as a failed reach too', async () => {
      const { service, writes } = makeService(
        jest.fn().mockRejectedValue(sshRefused()),
      );
      await expect(service.setup(ctx, SERVER_ID)).rejects.toBeInstanceOf(
        ExecError,
      );

      expect(setupWrites(writes)).toEqual([
        expect.objectContaining({ setupOk: false }),
      ]);
      expect(reachWrites(writes)).toEqual([
        expect.objectContaining({ reachOk: false }),
      ]);
    });
  });

  it('answers the caller even when the outcome cannot be stored', async () => {
    const { service } = makeService(
      jest.fn().mockResolvedValue({ stdout: 'ok', stderr: '' }),
    );
    // A database that refuses the bookkeeping write.
    (service as unknown as { db: { update: () => never } }).db.update = () => {
      throw new Error('connection terminated');
    };
    await expect(service.validate(ctx, SERVER_ID)).resolves.toEqual({
      status: 'ok',
    });
  });
});
