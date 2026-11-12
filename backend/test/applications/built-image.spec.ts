import {
  builtImageTag,
  reclaimBuiltImages,
} from '../../src/applications/built-image';
import type { BuiltImageOwner } from '../../src/applications/built-image';
import { awaitImageRelease } from '../../src/common/teardown-steps';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';

/**
 * The image a build leaves on the build host, and the delete that reclaims it
 * (ADR-0016's third non-goal).
 *
 * `docker image rm`/`docker rmi` appears in exactly one place in `src` —
 * `RollbacksService.remove` — so until now the only sweep for `${appName}:latest`
 * was a machine-wide `docker image prune --all` an operator has to think to run
 * from Settings → Maintenance. Unlike the preserved rollback tag ADR-0016 is
 * about, this image has no naming row at all, which is what makes reclaiming it
 * at the delete both possible and necessary: the tag is derivable from `appName`
 * only while the Application still exists.
 *
 * **The interesting half is which tag exists.** For a `sourceType: 'docker'`
 * Application no build happens at all: `DeploymentEngineService.builtImageName`
 * answers the operator's own `dockerImage` column verbatim, and that image was
 * pulled rather than produced — it may be `postgres:17`, it may be shared with
 * every other Application on the host, and it is not this platform's to delete.
 * So the docker arm reclaims nothing, and that is the assertion this file exists
 * for.
 */
const ok = { stdout: '', stderr: '', exitCode: 0 };

const owner = (over: Partial<BuiltImageOwner> = {}): BuiltImageOwner => ({
  appName: 'web-app',
  sourceType: 'git',
  serverId: null,
  buildServerId: null,
  ...over,
});

/**
 * The exec layer, recorded as **argv on a machine**.
 *
 * Asserted off `execRemote`/`execFileAsync` rather than off the string mocks
 * `withArgvExec` forwards to, because the words are the subject's and the
 * quoting is the transport's: `quote()` escapes the tag's `:` to `web-app\:latest`,
 * and a spec spelling that out would be asserting `shell-quote` (which
 * `test/remote/remote-exec.service.spec.ts` owns) instead of asserting which
 * image was named to which host.
 */
const execDouble = (
  answer: (command: string) => Promise<typeof ok> = () => Promise.resolve(ok),
) => {
  const execAsync = jest.fn((command: string) => answer(command));
  const execAsyncRemote = jest.fn((_serverId: string, command: string) =>
    answer(command),
  );
  const remoteExec = withArgvExec({ execAsync, execAsyncRemote });
  return {
    execAsync,
    execAsyncRemote,
    /** Every removal issued, with the machine it was issued to. */
    issued: () => [
      ...remoteExec.execFileAsync.mock.calls.map(
        ([program, args]: [string, string[]]) => ({
          serverId: null as string | null,
          argv: [program, ...args],
        }),
      ),
      ...remoteExec.execRemote.mock.calls.map(
        ([serverId, argv]: [string, string[]]) => ({ serverId, argv }),
      ),
    ],
    remoteExec: remoteExec as unknown as RemoteExecService,
  };
};

/** The argv every one of these removals is: four words plus the tag. */
const removal = (image: string) => ['docker', 'image', 'rm', image, '--force'];

/** The read of a tag's image id that comes before its removal, so the image
 * can be followed once no tag is left on it (#1415). This file's doubles
 * answer no id, so nothing is followed here; `teardown-steps.spec.ts`'
 * `removeImagesOn` block is where the image itself is. */
const idRead = (image: string) => [
  'docker',
  'image',
  'inspect',
  '--format',
  '{{.Id}}',
  image,
];

/** Both commands one tag costs, in order. */
const tagTurn = (serverId: string, image: string) => [
  { serverId, argv: idRead(image) },
  { serverId, argv: removal(image) },
];

/** The daemon's answer for a tag it does not have — `docker image rm` exits
 * non-zero for it, and the message is the only thing that says why. */
const noSuchImage = () =>
  Promise.reject(
    Object.assign(new Error('Command failed'), {
      stderr: 'Error response from daemon: No such image: web-app:latest',
      exitCode: 1,
    }),
  );

const stuck = (command: string) =>
  command.startsWith('docker image rm ')
    ? Promise.reject(
        Object.assign(new Error('Command failed'), {
          stderr:
            'Error response from daemon: conflict: unable to delete web-app:latest (must be forced)',
          exitCode: 1,
        }),
      )
    : Promise.resolve(ok);

describe('builtImageTag', () => {
  it('names the tag every builder produces for a built source', () => {
    expect(builtImageTag(owner({ sourceType: 'git' }))).toBe('web-app:latest');
    expect(builtImageTag(owner({ sourceType: 'github' }))).toBe(
      'web-app:latest',
    );
    expect(builtImageTag(owner({ sourceType: 'drop' }))).toBe('web-app:latest');
  });

  // The assertion this whole arm exists for: reclaiming `dockerImage` would
  // delete an image Cloudgate never built and may not own.
  it('names nothing for a docker-sourced Application, which builds no image', () => {
    expect(builtImageTag(owner({ sourceType: 'docker' }))).toBeNull();
  });
});

describe('reclaimBuiltImages', () => {
  it('drops the built tag on the build host and reports nothing', async () => {
    const doubles = execDouble();

    expect(
      await reclaimBuiltImages(
        doubles.remoteExec,
        [owner({ serverId: 'srv-run', buildServerId: 'srv-build' })],
        awaitImageRelease(),
      ),
    ).toEqual([]);
    // The build host, not the run Server — `buildHostServerId`'s answer. A
    // wrong-machine call issues a byte-identical command, so the machine is the
    // assertion (ADR-0018).
    expect(doubles.issued()).toEqual(tagTurn('srv-build', 'web-app:latest'));
  });

  it('falls through to the run Server when there is no dedicated build Server', async () => {
    const doubles = execDouble();

    await reclaimBuiltImages(
      doubles.remoteExec,
      [owner({ serverId: 'srv-run', buildServerId: null })],
      awaitImageRelease(),
    );

    expect(doubles.issued()).toEqual(tagTurn('srv-run', 'web-app:latest'));
  });

  it('asks no machine anything about a docker-sourced Application', async () => {
    const doubles = execDouble();

    expect(
      await reclaimBuiltImages(
        doubles.remoteExec,
        [owner({ sourceType: 'docker', serverId: 'srv-run' })],
        awaitImageRelease(),
      ),
    ).toEqual([]);
    expect(doubles.issued()).toEqual([]);
  });

  // A healthy delete reports nothing, and an Application that never deployed is
  // healthy: `docker image rm` exits non-zero for a tag the daemon does not
  // have, so without this every never-built Application would be reported as a
  // leak on every delete.
  it('treats an image the daemon does not have as reclaimed', async () => {
    const doubles = execDouble(noSuchImage);

    expect(
      await reclaimBuiltImages(
        doubles.remoteExec,
        [owner()],
        awaitImageRelease(),
      ),
    ).toEqual([]);
  });

  it('names the tag it could not remove, on the machine that still holds it', async () => {
    const doubles = execDouble(stuck);

    expect(
      await reclaimBuiltImages(
        doubles.remoteExec,
        [owner({ buildServerId: 'srv-build' })],
        awaitImageRelease(),
      ),
    ).toEqual([{ serverId: 'srv-build', images: ['web-app:latest'] }]);
  });

  /**
   * One report entry per machine, and a machine that failed is not asked
   * again — `removeImagesOn`'s rule, and for its reason: an
   * unreachable build host must not multiply an SSH connect timeout by the
   * Application count of a Project delete.
   */
  it('stops asking a build host that failed and reports the rest of its tags', async () => {
    const doubles = execDouble(stuck);

    expect(
      await reclaimBuiltImages(
        doubles.remoteExec,
        [
          owner({ appName: 'web-app', buildServerId: 'srv-build' }),
          owner({ appName: 'api', buildServerId: 'srv-build' }),
          owner({ appName: 'worker', buildServerId: 'srv-other' }),
        ],
        awaitImageRelease(),
      ),
    ).toEqual([
      { serverId: 'srv-build', images: ['web-app:latest', 'api:latest'] },
      { serverId: 'srv-other', images: ['worker:latest'] },
    ]);
    // Two machines, one attempt each: `srv-build` was not asked about `api`.
    expect(doubles.issued()).toEqual([
      ...tagTurn('srv-build', 'web-app:latest'),
      ...tagTurn('srv-other', 'worker:latest'),
    ]);
  });

  it('groups the Applications of one build host into a single turn', async () => {
    const doubles = execDouble();

    await reclaimBuiltImages(
      doubles.remoteExec,
      [
        owner({ appName: 'web-app', buildServerId: 'srv-build' }),
        owner({ appName: 'api', buildServerId: 'srv-build' }),
      ],
      awaitImageRelease(),
    );

    expect(doubles.issued()).toEqual([
      ...tagTurn('srv-build', 'web-app:latest'),
      ...tagTurn('srv-build', 'api:latest'),
    ]);
  });
});
