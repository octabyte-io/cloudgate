import { ConflictException, ServiceUnavailableException } from '@nestjs/common';

import { LibsqlService } from '../../src/databases/libsql/libsql.service';
import { ExecError } from '../../src/remote/exec-error';

/**
 * A Start or Stop that Docker failed reached the console as a bare 500,
 * "Internal server error", which it could not tell from a proxy timeout, so it
 * said "this may still be running" and the reason was shown nowhere. Docker's
 * own words now come back as a 409, and a Server that was not reached as the
 * 503 every Docker read answers, with its code.
 */
describe('BaseDatabaseService', () => {
  const owned = { id: 'db-1', serverId: 'srv-1', appName: 'libsql-abc' };

  type Lifecycle = Record<
    'start' | 'stop',
    (ctx: never, databaseId: string) => Promise<unknown>
  >;

  function serviceFailingWith(error: Error): Lifecycle {
    const permissions = { checkPermission: () => Promise.resolve() };
    const remoteExec = { execRemote: () => Promise.reject(error) };
    // The one read before Docker: no Server in maintenance.
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([]) }),
        }),
      }),
    };
    const service = new LibsqlService(
      ...([db, permissions, null, remoteExec, null] as unknown as [
        never,
        never,
        never,
        never,
        never,
      ]),
    ) as unknown as Lifecycle & {
      findOwned: () => Promise<typeof owned>;
    };
    service.findOwned = () => Promise.resolve(owned);
    return service;
  }

  const dockerRefused = () =>
    new ExecError('Command failed: docker service scale libsql-abc=1', {
      command: 'docker service scale libsql-abc=1',
      stderr: 'Error response from daemon: service libsql-abc not found',
      exitCode: 1,
      serverId: 'srv-1',
    });

  it.each(['start', 'stop'] as const)(
    'answers a %s Docker refused with what Docker said',
    async (action) => {
      const service = serviceFailingWith(dockerRefused());
      const failed = service[action]({} as never, 'db-1');

      await expect(failed).rejects.toBeInstanceOf(ConflictException);
      await expect(failed).rejects.toThrow(
        `The LibSQL ${action} of libsql-abc failed. Docker said: Error response from daemon: service libsql-abc not found`,
      );
    },
  );

  it('answers a Server that was not reached with the unreachable 503, not a bare 500', async () => {
    const unreached = new ExecError('connect ECONNREFUSED', {
      command: 'docker service scale libsql-abc=1',
      serverId: 'srv-1',
      connectionFailed: true,
    });
    const failed = serviceFailingWith(unreached).start({} as never, 'db-1');

    await expect(failed).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
