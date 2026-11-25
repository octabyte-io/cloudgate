import { Logger } from '@nestjs/common';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import type { SameMachine } from '../../src/servers/same-machine';
import { SameMachineRecheck } from '../../src/servers/same-machine-recheck';

/**
 * The boot-time recheck of every Server's `sameMachine` (spec #146): a Server
 * saved before the column existed, or whose address has since become (or
 * stopped being) one of the box's own, gets its flag worked out again at
 * start. Run against a fake table, so what is asserted is which rows are
 * written and that nothing it meets stops the boot.
 */
describe('SameMachineRecheck', () => {
  type Row = { serverId: string; ipAddress: string; sameMachine: boolean };

  const tableWith = (rows: Row[], { failRead = false } = {}) => {
    const written: { values: unknown; where: unknown }[] = [];
    const db = {
      select: () => ({
        from: () =>
          failRead
            ? Promise.reject(new Error('relation "server" does not exist'))
            : Promise.resolve(rows),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: (where: unknown) => {
            written.push({ values, where });
            return Promise.resolve();
          },
        }),
      }),
    } as unknown as DrizzleDB;
    return { db, written };
  };

  /** The box is 127.0.0.1 and 203.0.113.10; `broken.example.com` throws. */
  const sameMachine = {
    isSameMachine: (host: string) =>
      host === 'broken.example.com'
        ? Promise.reject(new Error('resolver crashed'))
        : Promise.resolve(host === '127.0.0.1' || host === '203.0.113.10'),
  } as SameMachine;

  const recheckWith = (db: DrizzleDB, isHosted = false) =>
    new SameMachineRecheck(db, { isHosted } as InstanceMode, sameMachine);

  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('updates only the Servers whose answer changed', async () => {
    const { db, written } = tableWith([
      // Saved before the column existed: false, but it is the box.
      { serverId: 'old-local', ipAddress: '127.0.0.1', sameMachine: false },
      // Was the box's public address; the box has moved since.
      { serverId: 'moved', ipAddress: '198.51.100.7', sameMachine: true },
      { serverId: 'still-local', ipAddress: '203.0.113.10', sameMachine: true },
      { serverId: 'elsewhere', ipAddress: '192.168.1.5', sameMachine: false },
    ]);

    await expect(recheckWith(db).run()).resolves.toBe(2);

    expect(written.map((write) => write.values)).toEqual([
      { sameMachine: true },
      { sameMachine: false },
    ]);
  });

  it('logs and skips a Server whose check throws, and still checks the rest', async () => {
    const { db, written } = tableWith([
      {
        serverId: 'broken',
        ipAddress: 'broken.example.com',
        sameMachine: true,
      },
      { serverId: 'old-local', ipAddress: '127.0.0.1', sameMachine: false },
    ]);

    await expect(recheckWith(db).run()).resolves.toBe(1);

    expect(written.map((write) => write.values)).toEqual([
      { sameMachine: true },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does nothing on the Hosted instance, where the flag is always false', async () => {
    const { db, written } = tableWith([
      { serverId: 'old-local', ipAddress: '127.0.0.1', sameMachine: false },
    ]);

    await expect(recheckWith(db, true).run()).resolves.toBe(0);

    expect(written).toEqual([]);
  });

  it('starts the recheck at boot without waiting for it, and a failure there never throws', async () => {
    const { db } = tableWith([], { failRead: true });
    const recheck = recheckWith(db);

    expect(recheck.onApplicationBootstrap()).toBeUndefined();
    // Let the background read fail and be logged.
    await new Promise((resolve) => setImmediate(resolve));

    expect(error).toHaveBeenCalledTimes(1);
  });
});
