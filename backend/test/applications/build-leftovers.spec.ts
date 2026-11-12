import { reclaimBuildLeftovers } from '../../src/applications/build-leftovers';
import { buildLeftoverReclamation } from '../../src/builders/build-leftovers';
import { runTeardownSteps } from '../../src/common/teardown-steps';
import type { BuildHostArtifactOwner } from '../../src/common/teardown-steps';
import { previewTeardownSteps } from '../../src/preview-deployments/preview-teardown';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';

/**
 * The delete-time half of build-leftover reclamation (ADR-0016's post-refusal
 * slot).
 *
 * `09cbf5f` **bounded** railpack's leak rather than closing it, and the follow-up's item
 * 1 does the same for the nixpacks copy-out container: reclamation happens in
 * the *next* build of the same Application, so an Application that never builds
 * again keeps its leftover — a buildkit container plus its state volume, and a
 * `Created` container holding a writable layer — until it is deleted. This is
 * the delete.
 *
 * **Why it reports nothing, which is the decision the follow-up asked for.** The two
 * criteria `UnreclaimedArtifact` states about itself are *is it a path* and
 * *does something break differently from the entries already there*. Neither a
 * buildx builder name nor a container name is a path, so a `kind` here would
 * put that type's `path` field back in the state it was renamed out of — which
 * is the first reason for keeping `${appName}:latest` in `unreclaimedImages`
 * rather than taking a fourth arm, and it applies verbatim. And this
 * reclamation has **no artifact identity to report even in principle**: it is a
 * *sweep* whose predicate is the name pattern, so a failed exec means "the
 * sweep did not run", not "this artifact was left" — unlike the `rm -rf` whose
 * non-zero exit already means *may still exist* and unlike a per-tag `docker
 * image rm`. An entry naming no artifact is exactly the field-named-for-nothing
 * the rename declined to write.
 *
 * What keeps that from being a hole: the sweep goes to the build host, and
 * every other build-host reclamation the same delete runs — the source-tree
 * `rm -rf`, the patch-repo clone, and `${appName}:latest` — reports on that
 * same machine when it is unreachable. So the response already says *this build
 * host could not be reached and things were left on it*; a fourth entry with no
 * name adds nothing an operator could act on.
 */
const ok = { stdout: '', stderr: '', exitCode: 0 };

const owner = (
  over: Partial<BuildHostArtifactOwner> = {},
): BuildHostArtifactOwner => ({
  appName: 'web-app',
  serverId: null,
  buildServerId: null,
  ...over,
});

/**
 * The exec layer, recorded as **a program on a machine** — the `string` arm of
 * `execOnServer`, because a `for`/`case` loop has no argv (§2.9).
 */
const execDouble = (
  answer: (command: string) => Promise<typeof ok> = () => Promise.resolve(ok),
) => {
  const execAsync = jest.fn((command: string) => answer(command));
  const execAsyncRemote = jest.fn((_serverId: string, command: string) =>
    answer(command),
  );
  return {
    /** Every program issued, with the machine it was issued to. */
    issued: () => [
      ...execAsync.mock.calls.map(([command]) => ({
        serverId: null as string | null,
        command,
      })),
      ...execAsyncRemote.mock.calls.map(([serverId, command]) => ({
        serverId,
        command,
      })),
    ],
    remoteExec: { execAsync, execAsyncRemote } as unknown as RemoteExecService,
  };
};

describe('reclaimBuildLeftovers', () => {
  it('sweeps the build host, not the run Server, and reports nothing', async () => {
    const doubles = execDouble();

    expect(
      await reclaimBuildLeftovers(doubles.remoteExec, [
        owner({ serverId: 'srv-run', buildServerId: 'srv-build' }),
      ]),
    ).toBeUndefined();

    // The machine is the assertion, not the words: a wrong-machine call issues
    // a byte-identical program, which is the whole mechanism ADR-0018 is about.
    const issued = doubles.issued();
    expect(issued).toHaveLength(1);
    expect(issued[0].serverId).toBe('srv-build');
    expect(issued[0].command).toContain('railpack-web-app-');
    expect(issued[0].command).toContain("docker ps -a --format '{{.Names}}'");
  });

  it('falls through to the run Server when there is no dedicated build Server', async () => {
    const doubles = execDouble();

    await reclaimBuildLeftovers(doubles.remoteExec, [
      owner({ serverId: 'srv-run', buildServerId: null }),
    ]);

    expect(doubles.issued().map(({ serverId }) => serverId)).toEqual([
      'srv-run',
    ]);
  });

  it('sweeps the platform host when the Application names no Server at all', async () => {
    const doubles = execDouble();

    await reclaimBuildLeftovers(doubles.remoteExec, [owner()]);

    // `null` is the platform host (ADR-0008), which is the `execAsync` arm.
    expect(doubles.issued().map(({ serverId }) => serverId)).toEqual([null]);
  });

  it('asks one build host once for every Application it holds', async () => {
    const doubles = execDouble();

    await reclaimBuildLeftovers(doubles.remoteExec, [
      owner({ appName: 'web-app', buildServerId: 'srv-build' }),
      owner({ appName: 'api', buildServerId: 'srv-build' }),
      owner({ appName: 'worker', buildServerId: 'srv-other' }),
    ]);

    const issued = doubles.issued();
    expect(issued.map(({ serverId }) => serverId)).toEqual([
      'srv-build',
      'srv-other',
    ]);
    // One program per machine carrying every appName on it, so a Project delete
    // costs one round trip per build host rather than one per Application —
    // `reclaimBuiltImages`' grouping, for its stated reason.
    expect(issued[0].command).toContain('railpack-web-app-');
    expect(issued[0].command).toContain('railpack-api-');
    expect(issued[0].command).not.toContain('railpack-worker-');
    expect(issued[1].command).toContain('railpack-worker-');
  });

  /**
   * The sweep is unconditional across `sourceType` and `buildType`, and that is
   * a decision rather than an oversight.
   *
   * `builtImageTag` forks on `sourceType: 'docker'` for a *safety* reason — the
   * image there is the operator's own pulled `dockerImage`. No such reason
   * exists here: both names are platform-made. And all three of `sourceType`,
   * `buildType` and `publishDirectory` are `PATCH /applications/:id` columns, so
   * an Application that built with railpack yesterday and is `docker`-sourced
   * today still has yesterday's leftover — conditioning the sweep on the
   * current row is how the delete would miss exactly the leftovers only the
   * delete can reach.
   */
  it('sweeps a docker-sourced Application too, because the columns are PATCH columns', async () => {
    const doubles = execDouble();

    await reclaimBuildLeftovers(doubles.remoteExec, [
      owner({ buildServerId: 'srv-build' }),
    ]);

    expect(doubles.issued()).toHaveLength(1);
  });

  /**
   * Never throws and never refuses, on `reclaimPreservedImages`' two reasons: a
   * leftover is disk rather than ADR-0008's unmanaged container, and *forget
   * this Application* must stay completable while a machine is down.
   */
  it('swallows an unreachable build host rather than failing the delete', async () => {
    const doubles = execDouble(() =>
      Promise.reject(
        Object.assign(new Error('Command failed'), {
          stderr: 'ssh: connect to host srv-build port 22: Connection refused',
          exitCode: 255,
        }),
      ),
    );

    await expect(
      reclaimBuildLeftovers(doubles.remoteExec, [
        owner({ appName: 'web-app', buildServerId: 'srv-build' }),
        owner({ appName: 'worker', buildServerId: 'srv-other' }),
      ]),
    ).resolves.toBeUndefined();

    // And a machine that failed does not stop the next one being asked: unlike
    // `removeImagesOn`, one failure here is one round trip rather than one per
    // tag, so there is no SSH-timeout multiplication to bound.
    expect(doubles.issued().map(({ serverId }) => serverId)).toEqual([
      'srv-build',
      'srv-other',
    ]);
  });

  it('asks no machine anything when the delete holds no Applications', async () => {
    const doubles = execDouble();

    await reclaimBuildLeftovers(doubles.remoteExec, []);

    expect(doubles.issued()).toEqual([]);
  });
});

/**
 * The preview lane's own delete, and the appName the earlier sweep never reached.
 *
 * **What was wrong, and it is not the predicate the ticket names.** The ticket reads
 * the leak off `service-cascade.ts` scoping `reclaimBuildLeftovers` to
 * `serviceType === 'application'`, but widening that filter would not have
 * reached a preview: a preview is **not a `CascadeChild` at all** — it has no
 * `service_type`, no row in the eight service tables and no `checkServiceAccess`
 * of its own (ADR-0018) — so `buildHostArtifactOwnersOf` maps *parent
 * Applications*, and every sweep the deletes send names the parent's `appName`.
 * `ApplicationsService.remove` sweeps `current.appName` the same way. Meanwhile
 * `deployPreview` spreads the parent's row over `{ appName: preview.appName }`,
 * so a preview build's builder is `railpack-preview-web-ab12cd-<nonce>` and
 * nothing on any delete path ever named it.
 *
 * **So it belongs to the preview lane's teardown, not to the cascade**, and the
 * decisive evidence is which paths each one reaches. `previewTeardownSteps` is
 * shared by all four: `tearDownApplicationPreviews` (the Application delete and
 * both cascades) *and* `PreviewDeploymentsService.teardown`, which is the
 * closed-pull-request webhook and `DELETE /preview-deployments/:id` — the two
 * commonest ways a preview goes away, and the two the cascade never sees. A
 * fifth sweep in `service-cascade.ts` would have fixed one path of four and
 * left the leak live on the other three.
 *
 * It is asserted here rather than in the preview module's own spec because the
 * claim under test is this file's: *which appNames a delete sweeps for build
 * leftovers*. That claim being answered in two places, one per lane, is what
 * made a whole lane's answer *none*.
 */
describe('previewTeardownSteps', () => {
  const target = {
    appName: 'preview-web-ab12cd',
    serverId: 'run-1',
    buildHostId: 'build-1',
    cloudAccountId: null,
  };

  /**
   * The exec layer with **all four arms**, unlike {@link execDouble} above: a
   * preview teardown sends its two removals as argv (`execFileAsync` locally,
   * `execRemote` remotely) and the sweep as a program, which is the one call in
   * the three that has no argv to go as. Every call is recorded in issue order,
   * because the order is one of the assertions.
   */
  const previewDouble = (
    answer: (command: string) => Promise<typeof ok> = () => Promise.resolve(ok),
  ) => {
    const calls: { serverId: string | null; command: string | string[] }[] = [];
    const remoteExec = {
      execAsync: jest.fn((command: string) => {
        calls.push({ serverId: null, command });
        return answer(command);
      }),
      execAsyncRemote: jest.fn((serverId: string, command: string) => {
        calls.push({ serverId, command });
        return answer(command);
      }),
      execFileAsync: jest.fn((file: string, args: string[]) => {
        calls.push({ serverId: null, command: [file, ...args] });
        return Promise.resolve(ok);
      }),
      execRemote: jest.fn((serverId: string, argv: string[]) => {
        calls.push({ serverId, command: argv });
        return Promise.resolve(ok);
      }),
    } as unknown as RemoteExecService;
    return {
      calls: () => calls,
      /** Only the shell programs, which is where a sweep can be. */
      programs: () =>
        calls.filter(
          (call): call is { serverId: string | null; command: string } =>
            typeof call.command === 'string',
        ),
      remoteExec,
    };
  };

  const runSteps = async (doubles: ReturnType<typeof previewDouble>) =>
    runTeardownSteps(previewTeardownSteps(doubles.remoteExec, target));

  it('sweeps the preview\u2019s own appName, which no delete had ever named', async () => {
    const doubles = previewDouble();

    await runSteps(doubles);

    // The program the builders own, not a second statement of the pattern — the
    // length-not-prefix rule is the load-bearing half of the reclamation and has been
    // wrong once already.
    expect(doubles.programs()).toContainEqual({
      serverId: 'build-1',
      command: buildLeftoverReclamation(target.appName),
    });
    // And not the parent's: the parent Application's own delete sweeps that,
    // and `railpack-web-` followed by a nonce's width can never match
    // `railpack-preview-web-ab12cd-<nonce>` anyway.
    expect(doubles.programs()).not.toContainEqual(
      expect.objectContaining({ command: buildLeftoverReclamation('web') }),
    );
  });

  /**
   * The build host, because that is the machine that ran the build — the same
   * id the source-tree `rm -rf` beside it already uses, resolved once by
   * `buildHostServerId` before either step is built (ADR-0018). A sweep sent to
   * the run Server of a dedicated-build-Server install matches nothing and says
   * so at exit 0, which is a leak that looks exactly like a clean delete.
   */
  it('sweeps the build host and not the run Server', async () => {
    const doubles = previewDouble();

    await runSteps(doubles);

    const sweeps = doubles
      .programs()
      .filter(({ command }) => command.includes('railpack-'));
    expect(sweeps.map(({ serverId }) => serverId)).toEqual(['build-1']);
  });

  /**
   * Reports nothing, on this file's own argument: a sweep exits 0 whether it
   * matched nothing or everything, so a failed exec means *the sweep did not
   * run* rather than *this artifact was left behind*, and neither a buildx
   * builder name nor a container name is an `UnreclaimedArtifact` `path`. The
   * step therefore carries no `leftBehindOnFailure` — unlike the `rm -rf` above
   * it, whose non-zero exit already means *may still exist*.
   */
  it('reports nothing and refuses nothing when the sweep cannot be sent', async () => {
    const doubles = previewDouble((command) =>
      command.includes('railpack-')
        ? Promise.reject(new Error('ssh: connect to host build-1: refused'))
        : Promise.resolve(ok),
    );

    const left = await runSteps(doubles);

    expect(left).toEqual([]);
  });

  // Last of the five, after the tree the build was reading is gone: the sweep
  // matches by *pattern*, so it is the one step that could touch a build in
  // flight, and a delete that has already removed the source tree, the image
  // and the Swarm service is a delete no live build survives anyway.
  //
  // The length is what says nothing else was sent — the second call is the
  // `rm -f` of the router for the preview's host, on the run Server beside the
  // service, and the fourth and fifth are the image's id read and its
  // `docker image rm`, which go to the build host beside the tree rather than
  // to the run Server.
  it('sweeps after the four removals, not before them', async () => {
    const doubles = previewDouble();

    await runSteps(doubles);

    expect(doubles.calls().at(-1)).toEqual({
      serverId: 'build-1',
      command: buildLeftoverReclamation(target.appName),
    });
    expect(doubles.calls()).toHaveLength(6);
  });
});
