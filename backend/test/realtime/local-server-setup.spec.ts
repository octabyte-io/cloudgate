import fs from 'node:fs';
import {
  LocalServerSetupService,
  localSshKeyPath,
  sshDirectory,
} from '../../src/realtime/local-server-setup.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';

/**
 * Where the "local" terminal dials.
 *
 * `getDockerHost()` used to branch on `NODE_ENV === 'production'`, and answered
 * a production Linux host with the default route — commented as "the container's
 * default gateway is the Docker bridge to the host". That holds only when the
 * backend is itself in a container. Installed natively on a VPS the default
 * route is the datacentre router, so the terminal SSHed to somebody else's
 * machine and timed out on the handshake; the workaround was `NODE_ENV`, which
 * also moves the logger transport and server-IP resolution.
 *
 * So what these pin is that the question asked is *"am I in a container"* and
 * not *"is this production"*, and that a native install dials its own loopback.
 */

/** The evidence of containerisation, as the filesystem carries it. */
const DOCKER_ENV = '/.dockerenv';
const PODMAN_ENV = '/run/.containerenv';
const INIT_CGROUP = '/proc/1/cgroup';

describe('LocalServerSetupService.getDockerHost', () => {
  let present: Set<string>;
  let files: Map<string, string>;
  let execAsync: jest.Mock;
  let service: LocalServerSetupService;
  let platform: PropertyDescriptor;
  let nodeEnv: string | undefined;

  const setPlatform = (value: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value, configurable: true });

  beforeEach(() => {
    present = new Set<string>();
    files = new Map<string, string>();
    nodeEnv = process.env.NODE_ENV;
    platform = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    ) as PropertyDescriptor;
    setPlatform('linux');

    jest
      .spyOn(fs, 'existsSync')
      .mockImplementation((target) => present.has(String(target)));
    jest.spyOn(fs, 'readFileSync').mockImplementation((target) => {
      const contents = files.get(String(target));
      if (contents === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return contents;
    });

    execAsync = jest.fn((command: string) =>
      Promise.resolve(
        command.startsWith('uname')
          ? { stdout: '6.8.0-31-generic\n', stderr: '', exitCode: 0 }
          : { stdout: '172.31.1.1\n', stderr: '', exitCode: 0 },
      ),
    );

    // `withArgvExec`: the `ssh-keygen` is argv, and the fake words it
    // into the same command string this spec has always read out of `calls`.
    service = new LocalServerSetupService(
      withArgvExec({ execAsync }) as unknown as RemoteExecService,
    );
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    jest.restoreAllMocks();
  });

  describe('installed natively on the host', () => {
    it('dials loopback rather than the default route', async () => {
      // The VPS this was found on: production, Linux, no container anywhere.
      process.env.NODE_ENV = 'production';

      await expect(service.getDockerHost()).resolves.toBe('127.0.0.1');
    });

    it('never asks the routing table at all', async () => {
      process.env.NODE_ENV = 'production';

      await service.getDockerHost();

      expect(execAsync).not.toHaveBeenCalledWith(
        expect.stringContaining('ip route'),
      );
    });

    it('answers the same on a Mac, where the platform is not Linux', async () => {
      setPlatform('darwin');

      await expect(service.getDockerHost()).resolves.toBe('127.0.0.1');
    });
  });

  describe('running inside a container', () => {
    it("takes the bridge gateway from the container's default route", async () => {
      present.add(DOCKER_ENV);

      await expect(service.getDockerHost()).resolves.toBe('172.31.1.1');
    });

    it('falls back to the default bridge address when the route is empty', async () => {
      present.add(DOCKER_ENV);
      execAsync.mockImplementation((command: string) =>
        Promise.resolve(
          command.startsWith('uname')
            ? { stdout: '6.8.0-31-generic\n', stderr: '', exitCode: 0 }
            : { stdout: '\n', stderr: '', exitCode: 0 },
        ),
      );

      await expect(service.getDockerHost()).resolves.toBe('172.17.0.1');
    });

    it('reaches the Windows host by name under WSL', async () => {
      present.add(DOCKER_ENV);
      execAsync.mockImplementation((command: string) =>
        Promise.resolve(
          command.startsWith('uname')
            ? {
                stdout: '5.15.0-microsoft-standard-WSL2\n',
                stderr: '',
                exitCode: 0,
              }
            : { stdout: '172.31.1.1\n', stderr: '', exitCode: 0 },
        ),
      );

      await expect(service.getDockerHost()).resolves.toBe(
        'host.docker.internal',
      );
    });

    it('counts a Podman container too', async () => {
      present.add(PODMAN_ENV);

      await expect(service.getDockerHost()).resolves.toBe('172.31.1.1');
    });

    it('counts an init cgroup that names its container runtime', async () => {
      files.set(
        INIT_CGROUP,
        '12:pids:/docker/2f9a1c\n11:memory:/docker/2f9a1c\n',
      );

      await expect(service.getDockerHost()).resolves.toBe('172.31.1.1');
    });

    it('counts Kubernetes, which injects its own service host', async () => {
      process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1';

      try {
        await expect(service.getDockerHost()).resolves.toBe('172.31.1.1');
      } finally {
        delete process.env.KUBERNETES_SERVICE_HOST;
      }
    });
  });

  it('does not read containerisation out of NODE_ENV', async () => {
    // The regression: an unset NODE_ENV masked the fault in development
    // and setting it to production created it, on a host whose containerisation
    // never changed.
    delete process.env.NODE_ENV;
    const development = await service.getDockerHost();
    process.env.NODE_ENV = 'production';
    const production = await service.getDockerHost();

    expect(production).toBe(development);
  });

  it('reads a cgroup v2 container, whose init cgroup says nothing, off /.dockerenv', async () => {
    // cgroup v2 in a container is `0::/`, which names no runtime — the file is
    // not enough on its own, and Docker's own marker file is what settles it.
    files.set(INIT_CGROUP, '0::/\n');
    present.add(DOCKER_ENV);

    await expect(service.getDockerHost()).resolves.toBe('172.31.1.1');
  });
});

/**
 * `ssh-keygen` does not create a parent for an explicit `-f` path, and
 * nothing anywhere created `$CLOUDGATE_DIRECTORY/ssh` — `deploy/install.sh` made
 * only `traefik/dynamic`, and `setupMainDirectory` makes the same two on a
 * *remote* Server. So the first request the fleet card can make, a shell on the
 * platform host, closed 4502 on every stock install.
 */
describe('LocalServerSetupService.setupSshKey', () => {
  let calls: string[];
  let execAsync: jest.Mock;
  let mkdirSync: jest.SpyInstance;
  let service: LocalServerSetupService;

  beforeEach(() => {
    calls = [];

    mkdirSync = jest
      .spyOn(fs, 'mkdirSync')
      .mockImplementation((target, options) => {
        calls.push(`mkdir ${String(target)} ${JSON.stringify(options)}`);
        return undefined;
      });
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('PRIVATE KEY');

    execAsync = jest.fn((command: string) => {
      calls.push(command);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    // `withArgvExec`: the `ssh-keygen` is argv, and the fake words it
    // into the same command string this spec has always read out of `calls`.
    service = new LocalServerSetupService(
      withArgvExec({ execAsync }) as unknown as RemoteExecService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates the key directory before generating into it', async () => {
    await service.setupSshKey();

    expect(mkdirSync).toHaveBeenCalledWith(sshDirectory(), {
      recursive: true,
      mode: 0o700,
    });
    // Order, not just presence: after the ssh-keygen it would fix nothing.
    expect(calls[0]).toContain(`mkdir ${sshDirectory()}`);
    expect(calls[1]).toContain(`ssh-keygen`);
  });

  // 0700 because the private key lives there and F-04 means anything readable
  // under /etc/cloudgate is readable by any authenticated caller.
  it('makes it reachable by nobody but its owner', async () => {
    await service.setupSshKey();

    const [, options] = mkdirSync.mock.calls[0] as [string, { mode: number }];
    expect(options.mode).toBe(0o700);
  });

  it('generates nothing when the key is already there', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);

    await expect(service.setupSshKey()).resolves.toBe('PRIVATE KEY');

    expect(execAsync).not.toHaveBeenCalled();
  });

  it('writes the key into the directory it just created', async () => {
    await service.setupSshKey();

    expect(localSshKeyPath().startsWith(`${sshDirectory()}/`)).toBe(true);
    expect(execAsync).toHaveBeenCalledWith(
      expect.stringContaining(`-f ${localSshKeyPath()} `),
    );
  });
});
