import { readImage } from '../../src/project-config/applier/cloud-deploy-steps';
import { execOnServerStdout } from '../../src/remote/exec-dispatch';
import { ExecError } from '../../src/remote/exec-error';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';

/**
 * A Docker engine on Cloudgate's host, answering `docker image inspect` as
 * the engine the case names does. Each answer is written out here, as a
 * containerd image store on Docker 29.9.2 (arm64) printed it for
 * `nginxdemos/hello:0.4` pulled with `--platform linux/amd64`, not built
 * from `IMAGE_INSPECT_FORMAT`.
 */
function engine(answer: (args: string[]) => string | ExecError) {
  const asked: string[][] = [];
  const execFileAsync = jest.fn((program: string, args: string[]) => {
    asked.push([program, ...args]);
    const said = answer(args);
    return said instanceof ExecError
      ? Promise.reject(said)
      : Promise.resolve({ stdout: said, stderr: '' });
  });
  const remoteExec = { execFileAsync } as unknown as RemoteExecService;
  return {
    asked,
    inspect: (argv: string[]) => execOnServerStdout(remoteExec, null, argv),
  };
}

const LOCAL = 'nginxdemos/hello:0.4';

/** Docker 29 with a containerd store: no `Architecture` unless a platform is named. */
const containerdStore = (args: string[]) =>
  args.includes('--platform') ? 'amd64 null\n' : ' null\n';

/** A Docker CLI before 28.1, which has no `image inspect --platform`. */
const docker27 = (args: string[]) =>
  args.includes('--platform')
    ? new ExecError('Command failed', {
        command: ['docker', ...args].join(' '),
        stderr:
          "unknown flag: --platform\nSee 'docker image inspect --help'.\n",
        exitCode: 125,
      })
    : 'amd64 null\n';

describe('readImage', () => {
  it('reads an image a containerd store names no CPU for again as linux/amd64', async () => {
    const { asked, inspect } = engine(containerdStore);

    await expect(readImage(inspect, LOCAL, null)).resolves.toBe('amd64 null\n');
    expect(asked).toEqual([
      ['docker', 'image', 'inspect', '--format', expect.any(String), LOCAL],
      [
        'docker',
        'image',
        'inspect',
        '--platform',
        'linux/amd64',
        '--format',
        expect.any(String),
        LOCAL,
      ],
    ]);
  });

  it('reads the platform the image was pulled for first, and nothing else when it names a CPU', async () => {
    const { asked, inspect } = engine(containerdStore);

    await expect(readImage(inspect, LOCAL, 'linux/amd64')).resolves.toBe(
      'amd64 null\n',
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('--platform');
  });

  it('reads an image that names its CPU once, with no platform', async () => {
    const { asked, inspect } = engine(() => 'arm64 null\n');

    await expect(readImage(inspect, LOCAL, null)).resolves.toBe('arm64 null\n');
    expect(asked).toHaveLength(1);
    // The host's own variant was not second-guessed as amd64.
    expect(asked[0]).not.toContain('--platform');
  });

  it("answers an engine without inspect --platform with the plain read's answer", async () => {
    const pulledFor = engine(docker27);
    await expect(
      readImage(pulledFor.inspect, LOCAL, 'linux/amd64'),
    ).resolves.toBe('amd64 null\n');
    expect(pulledFor.asked.map((argv) => argv.includes('--platform'))).toEqual([
      true,
      false,
    ]);

    // An old engine whose plain read names no CPU keeps that answer, which
    // the deploy refuses as it did before.
    const unnamed = engine((args) =>
      args.includes('--platform') ? docker27(args) : ' null\n',
    );
    await expect(readImage(unnamed.inspect, LOCAL, null)).resolves.toBe(
      ' null\n',
    );
  });

  it('fails as the plain read fails, whatever the platform read said', async () => {
    const missing = new ExecError('Command failed', {
      command: 'docker image inspect',
      stderr: `Error response from daemon: No such image: ${LOCAL}\n`,
      exitCode: 1,
    });
    const { inspect } = engine(() => missing);

    await expect(readImage(inspect, LOCAL, 'linux/amd64')).rejects.toBe(
      missing,
    );
    await expect(readImage(inspect, LOCAL, null)).rejects.toBe(missing);
  });
});
