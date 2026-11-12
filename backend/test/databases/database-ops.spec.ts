import {
  databaseServicePresence,
  databaseVolumeLeftBehind,
} from '../../src/databases/common/database-ops';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  expectValueIsInert,
  INERT_VALUE,
  SEPARATOR_PAYLOAD,
} from '../utils/shell-safety';
import { runProbe } from '../utils/docker-daemon-stub';
import {
  servicePresenceProbe,
  volumePresenceProbe,
} from '../utils/workload-presence-probe';

/**
 * H-92 and H-95. `databaseServicePresence` is the managed-database twin of
 * `applications/application-ops.ts`'s `applicationServicePresence` — the same
 * `docker service inspect` probe, kept apart rather than shared so an
 * Application does not depend on the databases module to be startable.
 *
 * The twin had the same defect and needs its own test for the same reason it
 * needs its own copy of the command: nothing in the tree makes the two strings
 * move together, so a spec on one says nothing about the other. That the two
 * were byte-identical is what the register noticed; that they can drift is why
 * this file exists.
 *
 * `appName` reaches this through `APP_NAME_REGEX` at its mint and is writable
 * only at create, so there was no reachable payload — the quoting is the
 * defence-in-depth §2.9 asks of a shell *program*, which is what this probe is
 * (a redirect and an `if`/`elif`) as against the argv the file's three other
 * commands pass. The executed-shell arm of this proof lives in
 * `test/applications/application-ops.spec.ts`, on the identical string; what is
 * asserted here is that this builder emits an inert word of its own.
 *
 * H-95 is why the pinned string is an `if`/`elif`/`else` rather than
 * `&& echo present || echo absent`: `||` swallowed `Cannot connect to the Docker
 * daemon`, so a stopped or wedged daemon read as `absent` and the database's row
 * was dropped while its containers kept running. The probe asks the daemon
 * whether it is there first, and the arms are executed under a real shell in
 * `test/common/workload-presence.spec.ts`. The `unknown` mapping is pinned here
 * too, because nothing in the tree makes these two files move together — which
 * is the same argument that gave this file its own existence.
 */
describe('databaseServicePresence', () => {
  const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });

  const execDouble = () => {
    const execAsync = jest.fn().mockResolvedValue(ok('absent\n'));
    const execAsyncRemote = jest.fn().mockResolvedValue(ok('absent\n'));
    return {
      execAsync,
      execAsyncRemote,
      service: { execAsync, execAsyncRemote } as unknown as RemoteExecService,
    };
  };

  const probeFor = async (appName: string, serverId: string | null = null) => {
    const exec = execDouble();
    await databaseServicePresence(exec.service, serverId, appName);
    if (exec.execAsync.mock.calls.length > 0) {
      const [[local]] = exec.execAsync.mock.calls as [[string]];
      return local;
    }
    const [[, remote]] = exec.execAsyncRemote.mock.calls as [[string, string]];
    return remote;
  };

  it('asks the daemon with one zero-exit command that answers on stdout', async () => {
    expect(await probeFor('postgres-abc123')).toBe(
      servicePresenceProbe('postgres-abc123'),
    );
  });

  it('reads the daemon on the database’s own server when it has one', async () => {
    expect(await probeFor('postgres-abc123', 'srv-1')).toBe(
      servicePresenceProbe('postgres-abc123'),
    );
  });

  it('reads the probe’s unknown as unknown rather than as absent (H-95)', async () => {
    const exec = execDouble();
    exec.execAsync.mockResolvedValue({
      stdout: 'unknown\n',
      stderr: '',
      exitCode: 0,
    });

    expect(await databaseServicePresence(exec.service, null, 'pg-1')).toBe(
      'unknown',
    );
  });

  it('introduces no syntax for a name carrying a separator and a substitution', async () => {
    expectValueIsInert(
      await probeFor(SEPARATOR_PAYLOAD),
      await probeFor(INERT_VALUE),
    );
  });
});

/**
 * A database's data volume is created by its first deploy and survives
 * Delete, so whether one was left behind is a question for the Server, and
 * the Delete answers it: `true` when the volume is there, `false` only when the
 * Server positively says it is not, `null` whenever that cannot be known. The
 * console states a left-behind volume, or that nothing is left, only on the
 * first two.
 */
describe('databaseVolumeLeftBehind', () => {
  const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });

  const probeFor = async (volumeName: string) => {
    const execAsync = jest.fn().mockResolvedValue(ok('absent\n'));
    await databaseVolumeLeftBehind(
      { execAsync } as unknown as RemoteExecService,
      null,
      volumeName,
    );
    const [[command]] = execAsync.mock.calls as [[string]];
    return command;
  };

  it('asks with one zero-exit presence probe', async () => {
    expect(await probeFor('postgres-abc123-data')).toBe(
      volumePresenceProbe('postgres-abc123-data'),
    );
  });

  it.each([
    ['present\n', true],
    ['absent\n', false],
    ['unknown\n', null],
    ['', null],
  ])('reads %j as %p', async (stdout, expected) => {
    const execAsync = jest.fn().mockResolvedValue(ok(stdout));
    expect(
      await databaseVolumeLeftBehind(
        { execAsync } as unknown as RemoteExecService,
        null,
        'pg-1-data',
      ),
    ).toBe(expected);
  });

  it('reads an unreachable Server as unknown', async () => {
    const execAsyncRemote = jest
      .fn()
      .mockRejectedValue(new Error('ssh: connect refused'));
    expect(
      await databaseVolumeLeftBehind(
        { execAsyncRemote } as unknown as RemoteExecService,
        'srv-1',
        'pg-1-data',
      ),
    ).toBeNull();
  });

  describe('executed under a real shell', () => {
    const run = (stub: Parameters<typeof runProbe>[1]) =>
      runProbe(volumePresenceProbe('pg-1-data'), stub).said;

    it('answers present when a one-node swarm has the volume', () => {
      expect(
        run({ reachable: true, volumes: ['pg-1-data'], swarmNodes: 1 }),
      ).toBe('present');
    });

    it('answers absent when a one-node swarm has no such volume', () => {
      expect(run({ reachable: true, volumes: [], swarmNodes: 1 })).toBe(
        'absent',
      );
    });

    it('answers unknown on a multi-node swarm, where the volume may be on another node', () => {
      expect(run({ reachable: true, volumes: [], swarmNodes: 3 })).toBe(
        'unknown',
      );
    });

    it('answers unknown when the daemon does not answer', () => {
      expect(run({ reachable: false, volumes: ['pg-1-data'] })).toBe('unknown');
    });
  });

  it('introduces no syntax for a name carrying a separator and a substitution', async () => {
    expectValueIsInert(
      await probeFor(SEPARATOR_PAYLOAD),
      await probeFor(INERT_VALUE),
    );
  });
});
