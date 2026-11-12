import {
  awaitImageRelease,
  groupByBuildHost,
  IMAGE_RELEASE_BUDGET_MS,
  IMAGE_RELEASE_POLL_MS,
  isLogOwnerName,
  reclaimDeploymentLogs,
  reclaimFileMounts,
  removeImagesOn,
  withUnreclaimedArtifacts,
} from '../../src/common/teardown-steps';
import type { BuildHostArtifactOwner } from '../../src/common/teardown-steps';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import { ExecError } from '../../src/remote/exec-error';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';

/**
 * The grouping the build-host reclamations share, and the half of it that is
 * deliberately absent.
 *
 * **Two copies of six lines, and the second cited the first instead of sharing
 * it.** `applications/built-image.ts`' `reclaimBuiltImages` and
 * `applications/build-leftovers.ts`' `reclaimBuildLeftovers` each built
 * the same `Map<string | null, string[]>` in the same commit range, the second's
 * docblock naming the first's grouping as its precedent — which recorded the
 * duplication rather than removing it. The three decisions inside it are
 * asserted here so neither caller's spec is their only witness: the key is the
 * **build host** and never the run Server, one machine is one turn in
 * first-seen order, and an owner with no artifact to name contributes no word.
 *
 * **What is not here is the per-machine turn, and that is the point.** The two
 * callers have two failure contracts and two reporting contracts —
 * `reclaimBuiltImages` stops asking a machine at its first real failure and
 * answers in `UnreclaimedImages`, `reclaimBuildLeftovers` goes on asking the
 * next machine and answers `void` — and both differences live *after* the
 * grouping, in a loop each file still owns. A shared helper that also performed
 * the turn would have to take the stop rule and the report as parameters, which
 * is how one reclamation acquires the other's semantics silently. So this
 * subject takes no `RemoteExecService`, does no I/O, and is not `async`; the
 * last of those is asserted rather than merely described, because folding the
 * turn back in is exactly the change that would begin by making it so.
 *
 * Their own specs keep the contracts themselves: `built-image.spec.ts`' *stops
 * asking a build host that failed and reports the rest of its tags* against
 * `build-leftovers.spec.ts`' *swallows an unreachable build host rather than
 * failing the delete*, which asserts the second machine was still asked. Those
 * two are the pair that goes red if the extraction ever hands one the other's
 * rule.
 */
const owner = (
  over: Partial<BuildHostArtifactOwner> = {},
): BuildHostArtifactOwner => ({
  appName: 'web-app',
  serverId: null,
  buildServerId: null,
  ...over,
});

/** The word this grouping is asked for, so a name is traceable to its owner. */
const nameOf = (subject: BuildHostArtifactOwner) =>
  `artifact-${subject.appName}`;

describe('groupByBuildHost', () => {
  it('groups by the build host and not the run Server', () => {
    const grouped = groupByBuildHost(
      [owner({ serverId: 'srv-run', buildServerId: 'srv-build' })],
      nameOf,
    );

    // The machine is the whole assertion: a reclamation grouping by
    // `owner.serverId` issues a byte-identical command to the wrong host, which
    // is the mechanism ADR-0018 is about and is green on every single-Server
    // install.
    expect([...grouped]).toEqual([['srv-build', ['artifact-web-app']]]);
  });

  it('falls through to the run Server when there is no dedicated build Server', () => {
    const grouped = groupByBuildHost(
      [owner({ serverId: 'srv-run', buildServerId: null })],
      nameOf,
    );

    expect([...grouped.keys()]).toEqual(['srv-run']);
  });

  // `||` and not `??`, which is `buildHostServerId`'s stated semantics rather
  // than a defence against nullish: an empty string is not a `server` row's id
  // either, so it means *no dedicated build Server* the same way `null` does.
  it('falls through to the run Server for an empty build Server id too', () => {
    const grouped = groupByBuildHost(
      [owner({ serverId: 'srv-run', buildServerId: '' })],
      nameOf,
    );

    expect([...grouped.keys()]).toEqual(['srv-run']);
  });

  it('groups under the platform host when the owner names no Server at all', () => {
    const grouped = groupByBuildHost([owner()], nameOf);

    // `null` is the platform host (ADR-0008), not "unknown".
    expect([...grouped.keys()]).toEqual([null]);
  });

  /**
   * One machine is one turn, so a Project delete costs one round trip per build
   * host rather than one per Application — and the machines come back in
   * first-seen order, which for a cascade is `listCascadeChildren`' order, so a
   * delete's report reads the same way twice.
   */
  it('holds one entry per machine, in first-seen order, with the words in the caller’s', () => {
    const grouped = groupByBuildHost(
      [
        owner({ appName: 'web-app', buildServerId: 'srv-build' }),
        owner({ appName: 'worker', buildServerId: 'srv-other' }),
        owner({ appName: 'api', buildServerId: 'srv-build' }),
      ],
      nameOf,
    );

    expect([...grouped]).toEqual([
      ['srv-build', ['artifact-web-app', 'artifact-api']],
      ['srv-other', ['artifact-worker']],
    ]);
  });

  /**
   * A `null` word means *this owner has no such artifact*, not *name nothing on
   * that machine*. `builtImageTag` answers `null` for a docker-sourced
   * Application because that arm's image is the operator's own pulled
   * `dockerImage` column, and naming it would `docker image rm` an image the
   * platform never built.
   */
  it('drops an owner that names no artifact and keeps the rest of its machine', () => {
    const grouped = groupByBuildHost(
      [
        owner({ appName: 'pulled', buildServerId: 'srv-build' }),
        owner({ appName: 'api', buildServerId: 'srv-build' }),
      ],
      (subject) => (subject.appName === 'pulled' ? null : nameOf(subject)),
    );

    expect([...grouped]).toEqual([['srv-build', ['artifact-api']]]);
  });

  // And the machine goes with it when it was the only owner on it: an entry
  // with no words would be a turn that names nothing, which is a round trip
  // spent to say nothing.
  it('holds no entry for a machine whose only owner names no artifact', () => {
    const grouped = groupByBuildHost(
      [owner({ appName: 'pulled', buildServerId: 'srv-build' })],
      () => null,
    );

    expect([...grouped]).toEqual([]);
  });

  it('holds no machines when the delete holds no owners', () => {
    expect([...groupByBuildHost([], nameOf)]).toEqual([]);
  });

  /**
   * Not dead weight: this is the assertion that the per-machine turn is *not*
   * in here. A helper that also performed the turn would be `async` and would
   * answer something awaited, and it would then have to take the stop rule and
   * the report as parameters — which is how `reclaimBuildLeftovers` would
   * silently acquire `removeImagesOn`' stop-at-the-first-real-failure rule, or
   * `reclaimBuiltImages` lose it. A plain `Map` is what says the two contracts
   * are still their own files'.
   */
  it('answers a plain Map, so it carries no failure or reporting semantics', () => {
    const grouped = groupByBuildHost([owner()], nameOf);

    expect(grouped).toBeInstanceOf(Map);
    expect(grouped).not.toBeInstanceOf(Promise);
  });

  // The mapper is asked once per owner, not once per owner per machine: the
  // word is derived on the way in, so a caller whose derivation is a shell
  // program does not compose it twice.
  it('asks for each owner’s word exactly once', () => {
    const wordFor = jest.fn(nameOf);

    groupByBuildHost(
      [
        owner({ appName: 'web-app', buildServerId: 'srv-build' }),
        owner({ appName: 'api', buildServerId: 'srv-build' }),
      ],
      wordFor,
    );

    expect(wordFor).toHaveBeenCalledTimes(2);
  });
});

/**
 * The `files` half of `{root}/applications/{appName}`, reclaimed on the machine
 * that runs the workload.
 *
 * **What this subject exists to hold is *which machine*.** An earlier fix put the file
 * mounts on the **run** Server — a bind source is a path in the mounting host's
 * filesystem — while all three of the product's `rm -rf`s name the *build host*
 * and the `code` half. The two ids coincide on every install with no dedicated
 * build Server and `rm -rf` reads the same whichever host is asked, so a
 * reclamation aimed at `buildHostServerId`'s answer would be green everywhere
 * it was tried. Hence the transport itself is the assertion: which method was
 * called, and with which id.
 *
 * The whole-delete behaviour — the post-refusal slot, and that a preview gets
 * none — is `test/applications/application-delete-machines.e2e-spec.ts`; the
 * root half, with `CLOUDGATE_DIRECTORY` set and the expectation taken from the
 * write's own dispatch, is `test/mounts/file-mount-source-roots.e2e-spec.ts`.
 */
describe('reclaimFileMounts', () => {
  const ok = { stdout: '', stderr: '', exitCode: 0 };

  /** Only the two argv arms are stubbed: this subject sends one program and
   * its arguments and never a shell program, which the string arms going
   * unstubbed asserts by throwing if it ever does. */
  const execDouble = () => ({
    execRemote: jest.fn().mockResolvedValue(ok),
    execFileAsync: jest.fn().mockResolvedValue(ok),
  });

  it('removes the tree on the run Server and reports nothing when it comes away', async () => {
    const remoteExec = execDouble();

    const left = await reclaimFileMounts(
      remoteExec as unknown as RemoteExecService,
      [{ appName: 'web-app', serverId: 'srv-run' }],
    );

    expect(remoteExec.execRemote).toHaveBeenCalledWith('srv-run', [
      'rm',
      '-rf',
      `${REMOTE_CLOUDGATE_DIRECTORY}/applications/web-app/files`,
    ]);
    // `rm -rf` exits 0 for a path that is not there, so a healthy delete needs
    // no second question asked of the machine and reports nothing.
    expect(left).toEqual([]);
  });

  // `null` is the platform host (ADR-0008), and there the removal is genuinely
  // shell-free: `execFileAsync` spawns the program and no `/bin/sh -c` sees the
  // words.
  it('runs on the platform host through the local argv arm', async () => {
    const remoteExec = execDouble();

    await reclaimFileMounts(remoteExec as unknown as RemoteExecService, [
      { appName: 'web-app', serverId: null },
    ]);

    expect(remoteExec.execFileAsync).toHaveBeenCalledWith('rm', [
      '-rf',
      expect.stringMatching(/\/applications\/web-app\/files$/) as unknown,
    ]);
    expect(remoteExec.execRemote).not.toHaveBeenCalled();
  });

  it('names the tree, the machine and the path when the removal fails', async () => {
    const remoteExec = execDouble();
    remoteExec.execRemote.mockRejectedValue(new Error('no route to host'));

    const left = await reclaimFileMounts(
      remoteExec as unknown as RemoteExecService,
      [{ appName: 'web-app', serverId: 'srv-run' }],
    );

    // The row is about to cascade away, so the response is the last place the
    // triple exists — and the `kind` is what stops an operator reading this as
    // the source tree beside it, which is a clone and this is not.
    expect(left).toEqual([
      {
        kind: 'file-mounts',
        appName: 'web-app',
        serverId: 'srv-run',
        path: `${REMOTE_CLOUDGATE_DIRECTORY}/applications/web-app/files`,
      },
    ]);
  });

  /**
   * The reported path is the one that was attempted, not a second spelling of
   * it: both come from the same `fileMountsDirectoryOnRunServer` call, so a
   * report claiming a tree the removal never named cannot be written here.
   */
  it('reports the path it asked for', async () => {
    const remoteExec = execDouble();
    remoteExec.execRemote.mockRejectedValue(new Error('permission denied'));

    const [left] = await reclaimFileMounts(
      remoteExec as unknown as RemoteExecService,
      [{ appName: 'web-app', serverId: 'srv-run' }],
    );

    const [, argv] = remoteExec.execRemote.mock.calls[0] as [string, string[]];
    expect(argv).toEqual(['rm', '-rf', left.path]);
  });

  /**
   * Best-effort per Service, and never short-circuiting: one unreachable run
   * Server must not strand the trees of every other Service in a Project
   * delete. `runTeardownSteps` owns that rule, and this is the assertion that
   * this reclamation takes it rather than a `try`/`catch` of its own.
   */
  it('goes on to the next Service after one machine has failed', async () => {
    const remoteExec = execDouble();
    remoteExec.execRemote.mockImplementation((serverId: string) =>
      serverId === 'srv-down'
        ? Promise.reject(new Error('no route to host'))
        : Promise.resolve(ok),
    );

    const left = await reclaimFileMounts(
      remoteExec as unknown as RemoteExecService,
      [
        { appName: 'web-app', serverId: 'srv-down' },
        { appName: 'worker', serverId: 'srv-run' },
      ],
    );

    expect(remoteExec.execRemote).toHaveBeenCalledTimes(2);
    expect(left.map(({ appName }) => appName)).toEqual(['web-app']);
  });

  it('asks no machine anything when the delete holds no Services', async () => {
    const remoteExec = execDouble();

    expect(
      await reclaimFileMounts(remoteExec as unknown as RemoteExecService, []),
    ).toEqual([]);
    expect(remoteExec.execRemote).not.toHaveBeenCalled();
    expect(remoteExec.execFileAsync).not.toHaveBeenCalled();
  });
});

/**
 * The deployment-log directory of a Service, an Application schedule, a
 * database backup or a volume backup, reclaimed by the delete that destroys the
 * row naming it.
 *
 * The five deletes and the cascade call this one helper with the machine each
 * of their writers chose, so what is held here is the shape every one of them
 * shares: argv on the named machine, a `'deployment-logs'` entry naming that
 * machine when it fails, and no short-circuit. Which machine each delete
 * passes is its own e2e spec's assertion.
 */
describe('reclaimDeploymentLogs', () => {
  const ok = { stdout: '', stderr: '', exitCode: 0 };

  const execDouble = () => ({
    execRemote: jest.fn().mockResolvedValue(ok),
    execFileAsync: jest.fn().mockResolvedValue(ok),
  });

  it('removes {logs}/{appName} on the named machine and reports nothing when it comes away', async () => {
    const remoteExec = execDouble();

    const left = await reclaimDeploymentLogs(
      remoteExec as unknown as RemoteExecService,
      [{ appName: 'web-app', serverId: 'srv-build' }],
    );

    expect(remoteExec.execRemote).toHaveBeenCalledWith('srv-build', [
      'rm',
      '-rf',
      `${REMOTE_CLOUDGATE_DIRECTORY}/logs/web-app`,
    ]);
    expect(left).toEqual([]);
  });

  it('runs on the platform host through the local argv arm', async () => {
    const remoteExec = execDouble();

    await reclaimDeploymentLogs(remoteExec as unknown as RemoteExecService, [
      { appName: 'schedule-abc123', serverId: null },
    ]);

    expect(remoteExec.execFileAsync).toHaveBeenCalledWith('rm', [
      '-rf',
      expect.stringMatching(/\/logs\/schedule-abc123$/) as unknown,
    ]);
    expect(remoteExec.execRemote).not.toHaveBeenCalled();
  });

  it('names the directory, the machine and the path when the removal fails', async () => {
    const remoteExec = execDouble();
    remoteExec.execRemote.mockRejectedValue(new Error('no route to host'));

    const left = await reclaimDeploymentLogs(
      remoteExec as unknown as RemoteExecService,
      [{ appName: 'backup-x1y2z3', serverId: 'srv-run' }],
    );

    expect(left).toEqual([
      {
        kind: 'deployment-logs',
        appName: 'backup-x1y2z3',
        serverId: 'srv-run',
        path: `${REMOTE_CLOUDGATE_DIRECTORY}/logs/backup-x1y2z3`,
      },
    ]);
  });

  it('goes on to the next owner after one machine has failed', async () => {
    const remoteExec = execDouble();
    remoteExec.execRemote.mockImplementation((serverId: string) =>
      serverId === 'srv-down'
        ? Promise.reject(new Error('no route to host'))
        : Promise.resolve(ok),
    );

    const left = await reclaimDeploymentLogs(
      remoteExec as unknown as RemoteExecService,
      [
        { appName: 'web-app', serverId: 'srv-down' },
        { appName: 'worker', serverId: 'srv-run' },
      ],
    );

    expect(remoteExec.execRemote).toHaveBeenCalledTimes(2);
    expect(left.map(({ appName }) => appName)).toEqual(['web-app']);
  });

  /**
   * `rm -rf {logs}/{appName}` with a name that is empty, `.`, `..` or carries
   * a `/` is the whole logs tree or somewhere outside it, so the helper refuses
   * it where the `rm` is rather than trusting the mint — and says so, since the
   * directory was not removed.
   */
  it.each(['', '.', '..', 'a/b', '../etc', '/', '-rf', 'web app'])(
    'refuses to remove anything for the appName %j, and names it as left behind',
    async (appName) => {
      const remoteExec = execDouble();

      const left = await reclaimDeploymentLogs(
        remoteExec as unknown as RemoteExecService,
        [
          { appName, serverId: 'srv-run' },
          { appName: 'worker', serverId: 'srv-run' },
        ],
      );

      // The good owner beside it is still removed: a refusal is one step.
      expect(remoteExec.execRemote).toHaveBeenCalledTimes(1);
      expect(remoteExec.execRemote).toHaveBeenCalledWith('srv-run', [
        'rm',
        '-rf',
        `${REMOTE_CLOUDGATE_DIRECTORY}/logs/worker`,
      ]);
      expect(left.map((entry) => entry.appName)).toEqual([appName]);
    },
  );
});

describe('isLogOwnerName', () => {
  it.each(['web-app', 'schedule-47rn16', 'backup-1as7cq', 'a', 'v1.2_x'])(
    'admits %j',
    (appName) => {
      expect(isLogOwnerName(appName)).toBe(true);
    },
  );

  it.each(['', '.', '..', '.hidden', 'a/b', '-rf', 'web app', 'x\ny'])(
    'refuses %j',
    (appName) => {
      expect(isLogOwnerName(appName)).toBe(false);
    },
  );
});

describe('withUnreclaimedArtifacts', () => {
  const row = { scheduleId: 's1' };

  it('answers the row itself when nothing was left behind', () => {
    expect(withUnreclaimedArtifacts(row, [])).toBe(row);
  });

  it('spreads the report on when something was', () => {
    const entry = {
      kind: 'deployment-logs' as const,
      appName: 'schedule-x',
      serverId: null,
      path: '/etc/cloudgate/logs/schedule-x',
    };
    expect(withUnreclaimedArtifacts(row, [entry])).toEqual({
      scheduleId: 's1',
      unreclaimedArtifacts: [entry],
    });
  });
});

/**
 * The image behind a tag, and not only the tag (#1415).
 *
 * `docker service rm` returns while the service's task container is still
 * stopping, and `docker image rm <tag> --force` on an image that container
 * runs only untags it: the image stays, dangling, until the nightly prune.
 * The daemon double answers in Docker's own shape for each command — an id for
 * `inspect --format {{.Id}}`, a tag count for `{{len .RepoTags}}`,
 * `Untagged:`/`Deleted:` lines for a removal, and the `being used by running
 * container` refusal for an id a container still holds — so each test states
 * the daemon's situation and the commands the loop answers it with.
 */
describe('removeImagesOn', () => {
  const imageId = 'sha256:9f2c1e5ab7d3';

  /** A clock that only moves when the subject sleeps. */
  const fakeClock = () => {
    let now = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      clock: {
        now: () => now,
        sleep: (ms: number) => {
          sleeps.push(ms);
          now += ms;
          return Promise.resolve();
        },
      },
    };
  };

  const answer = (stdout: string) =>
    Promise.resolve({ stdout, stderr: '', exitCode: 0 });

  const inUse = () =>
    Promise.reject(
      Object.assign(new Error('Command failed'), {
        stderr: `Error response from daemon: conflict: unable to delete ${imageId} (cannot be forced) - image is being used by running container 4b1c2d`,
        exitCode: 1,
      }),
    );

  /**
   * A daemon holding `web-app:latest` as `imageId`, which `otherTags` more
   * tags share, and which a stopping task's container holds for `heldFor` more
   * attempts at removing it by id.
   */
  const daemon = (
    options: {
      otherTags?: number;
      heldFor?: number;
      deletedByUntag?: boolean;
    } = {},
  ) => {
    let heldFor = options.heldFor ?? 0;
    const execRemote = jest.fn((_serverId: string, argv: string[]) => {
      const words = argv.join(' ');
      if (words === 'docker image inspect --format {{.Id}} web-app:latest') {
        return answer(`${imageId}\n`);
      }
      if (words === 'docker image rm web-app:latest --force') {
        return answer(
          options.deletedByUntag
            ? `Untagged: web-app:latest\nDeleted: ${imageId}\n`
            : 'Untagged: web-app:latest\n',
        );
      }
      if (
        words === `docker image inspect --format {{len .RepoTags}} ${imageId}`
      ) {
        return answer(`${options.otherTags ?? 0}\n`);
      }
      if (words === `docker image rm ${imageId}`) {
        if (heldFor > 0) {
          heldFor -= 1;
          return inUse();
        }
        return answer(`Deleted: ${imageId}\n`);
      }
      return Promise.reject(new Error(`unexpected command: ${words}`));
    });
    return {
      remoteExec: { execRemote } as unknown as RemoteExecService,
      issued: () => execRemote.mock.calls.map(([, argv]) => argv),
    };
  };

  const readId = [
    'docker',
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    'web-app:latest',
  ];
  const untag = ['docker', 'image', 'rm', 'web-app:latest', '--force'];
  const countTags = [
    'docker',
    'image',
    'inspect',
    '--format',
    '{{len .RepoTags}}',
    imageId,
  ];
  const removeById = ['docker', 'image', 'rm', imageId];

  it('removes the image by id once the stopping task that held it has gone', async () => {
    const machine = daemon({ heldFor: 2 });
    const { clock, sleeps } = fakeClock();

    const left = await removeImagesOn(
      machine.remoteExec,
      'srv-build',
      ['web-app:latest'],
      awaitImageRelease(clock),
    );

    expect(left).toEqual([]);
    expect(machine.issued()).toEqual([
      readId,
      untag,
      countTags,
      removeById,
      countTags,
      removeById,
      countTags,
      removeById,
    ]);
    expect(sleeps).toEqual([IMAGE_RELEASE_POLL_MS, IMAGE_RELEASE_POLL_MS]);
  });

  it('leaves an image that another tag still names', async () => {
    const machine = daemon({ otherTags: 1 });

    const left = await removeImagesOn(
      machine.remoteExec,
      'srv-build',
      ['web-app:latest'],
      awaitImageRelease(),
    );

    expect(left).toEqual([]);
    expect(machine.issued()).toEqual([readId, untag, countTags]);
  });

  it('asks nothing more when the untag already deleted the image', async () => {
    const machine = daemon({ deletedByUntag: true });

    await removeImagesOn(
      machine.remoteExec,
      'srv-build',
      ['web-app:latest'],
      awaitImageRelease(),
    );

    expect(machine.issued()).toEqual([readId, untag]);
  });

  it('names the image by id when its container outlasts the budget', async () => {
    const machine = daemon({ heldFor: Number.POSITIVE_INFINITY });
    const { clock, sleeps } = fakeClock();

    const left = await removeImagesOn(
      machine.remoteExec,
      'srv-build',
      ['web-app:latest'],
      awaitImageRelease(clock),
    );

    expect(left).toEqual([{ serverId: 'srv-build', images: [imageId] }]);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(
      IMAGE_RELEASE_BUDGET_MS,
    );
  });
  it('only untags, and waits for nothing, when the caller did not confirm the service gone', async () => {
    // A forced delete past a `'present'` presence read: the service's running
    // container holds the image, so a removal by id could only be refused.
    const machine = daemon({ heldFor: Number.POSITIVE_INFINITY });

    const left = await removeImagesOn(
      machine.remoteExec,
      'srv-build',
      ['web-app:latest'],
      'untag-only',
    );

    expect(left).toEqual([]);
    expect(machine.issued()).toEqual([untag]);
  });

  /**
   * Two tags on one machine, each its own image, so a test can tell the
   * second tag's commands from the first's. `removeById` answers for the
   * first image's removal by id; the second's is held for ever.
   */
  const twoImages = (removeById: () => Promise<unknown>) => {
    const ids: Record<string, string> = {
      'web-app:v2': 'sha256:aaaa',
      'web-app:latest': 'sha256:bbbb',
    };
    const execRemote = jest.fn((_serverId: string, argv: string[]) => {
      const words = argv.join(' ');
      const tag = argv[argv.length - 1];
      if (words.startsWith('docker image inspect --format {{.Id}} ')) {
        return answer(`${ids[tag]}\n`);
      }
      if (words.endsWith(' --force')) return answer(`Untagged: ${argv[3]}\n`);
      if (words.startsWith('docker image inspect --format {{len .RepoTags}}')) {
        return answer('0\n');
      }
      if (words === 'docker image rm sha256:aaaa') return removeById();
      if (words === 'docker image rm sha256:bbbb') return inUse();
      return Promise.reject(new Error(`unexpected command: ${words}`));
    });
    return {
      remoteExec: { execRemote } as unknown as RemoteExecService,
      issued: () => execRemote.mock.calls.map(([, argv]) => argv.join(' ')),
    };
  };

  it('names an image the daemon refuses by id and goes on to the next tag', async () => {
    const machine = twoImages(() =>
      Promise.reject(
        Object.assign(new Error('Command failed'), {
          stderr:
            'Error response from daemon: conflict: unable to delete sha256:aaaa (cannot be forced) - image has dependent child images',
          exitCode: 1,
        }),
      ),
    );
    const { clock } = fakeClock();

    const left = await removeImagesOn(
      machine.remoteExec,
      'srv-build',
      ['web-app:v2', 'web-app:latest'],
      awaitImageRelease(clock),
    );

    expect(left).toEqual([
      { serverId: 'srv-build', images: ['sha256:aaaa', 'sha256:bbbb'] },
    ]);
    // Refused once, and not re-asked: only `being used by` settles.
    expect(
      machine
        .issued()
        .filter((words) => words === 'docker image rm sha256:aaaa'),
    ).toHaveLength(1);
    expect(machine.issued()).toContain(
      'docker image rm web-app:latest --force',
    );
  });

  it('stops asking a machine that did not answer the removal by id', async () => {
    const machine = twoImages(() =>
      Promise.reject(
        new ExecError('SSH connection error: connect ECONNREFUSED', {
          command: 'docker image rm sha256:aaaa',
          serverId: 'srv-build',
          connectionFailed: true,
        }),
      ),
    );

    const left = await removeImagesOn(
      machine.remoteExec,
      'srv-build',
      ['web-app:v2', 'web-app:latest'],
      awaitImageRelease(fakeClock().clock),
    );

    expect(left).toEqual([
      { serverId: 'srv-build', images: ['sha256:aaaa', 'web-app:latest'] },
    ]);
    expect(machine.issued()).not.toContain(
      'docker image inspect --format {{.Id}} web-app:latest',
    );
  });

  it('waits one budget per machine across the calls one delete makes', async () => {
    // The preserved tags, then the built tag, as `ApplicationsService.remove`
    // reclaims them: both held by a container that outlasts the budget.
    const machine = twoImages(inUse);
    const { clock, sleeps } = fakeClock();
    const release = awaitImageRelease(clock);

    const preserved = await removeImagesOn(
      machine.remoteExec,
      'srv-build',
      ['web-app:v2'],
      release,
    );
    const built = await removeImagesOn(
      machine.remoteExec,
      'srv-build',
      ['web-app:latest'],
      release,
    );

    expect([...preserved, ...built]).toEqual([
      { serverId: 'srv-build', images: ['sha256:aaaa'] },
      { serverId: 'srv-build', images: ['sha256:bbbb'] },
    ]);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(
      IMAGE_RELEASE_BUDGET_MS,
    );
  });

  it('gives another machine a budget of its own', async () => {
    const machine = twoImages(inUse);
    const { clock, sleeps } = fakeClock();
    const release = awaitImageRelease(clock);

    await removeImagesOn(machine.remoteExec, 'srv-a', ['web-app:v2'], release);
    await removeImagesOn(
      machine.remoteExec,
      'srv-b',
      ['web-app:latest'],
      release,
    );

    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(
      2 * IMAGE_RELEASE_BUDGET_MS,
    );
  });
});
