import {
  builtImageOwnersOf,
  cascadeRefusalMessage,
  fileMountOwnersOf,
  reclaimServiceDirectories,
  tearDownCascadeChildren,
} from '../../src/common/service-cascade';
import type { CascadeChild } from '../../src/common/service-cascade';
import {
  COMPOSE_SETTLE_BUDGET_MS,
  COMPOSE_SETTLE_POLL_MS,
} from '../../src/compose/compose.utils';
import type { SettleClock } from '../../src/compose/compose.utils';
import {
  applicationsDirectoryOn,
  composeDirectoryOn,
} from '../../src/deployment-engine/deployment-engine.paths';
import { ReachabilityMemo } from '../../src/remote/reachability-memo';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { dynamicTraefikConfigPath } from '../../src/traefik/traefik-writer.service';
import type { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import {
  composeProjectPresenceProbe,
  isPresenceProbe,
  servicePresenceProbe,
  stackPresenceProbe,
} from '../utils/workload-presence-probe';

/**
 * A Project delete used to be one `db.delete` over an `onDelete:
 * 'cascade'` chain, so every Application, compose stack and database beneath it
 * lost its row while its workload kept running — and per ADR-0008 a container
 * that resolves to no Service is *unmanaged*, reached through machine-level
 * `docker:read`, i.e. by every organization on the host.
 *
 * This is the collaborator that closes it: the per-Service teardowns of the cascade fix,
 * driven one child at a time, answering with the workloads it could not confirm
 * gone. The commands are pinned here for `application-ops.spec.ts`'s reason —
 * they are the difference between a workload that is gone and one that is
 * merely unaddressable, and none of them is obvious from the call site.
 */
const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });

const child = (over: Partial<CascadeChild> = {}): CascadeChild => ({
  serviceType: 'application',
  serviceId: 'app-1',
  appName: 'web-app',
  serverId: null,
  // No dedicated build Server, so the build ran where the service runs — the
  // single-Server default, and the case in which the two machines coincide
  // *"aims the source-tree removal at the build Server"* below is the
  // one test that overrides it, and it is the only assertion in this file that
  // can tell the two machines apart.
  buildServerId: null,
  // A built source, so the built-image reclamation has a tag to name — the
  // `'docker'` arm is `built-image.spec.ts`', where the rule lives.
  sourceType: 'git',
  runLogs: [],
  traced: false,
  aiModel: false,
  ...over,
});

/**
 * The exec layer as the cascade's happy path sees it: every workload gone.
 *
 * `presence` may be a function of the command instead of one word, which is how
 * a daemon that answers differently per compose subsystem is expressed — the
 * H-87 fixture, where the swarm has the stack and the compose project of that
 * name does not exist.
 */
const depsDouble = (
  presence:
    | 'present'
    | 'absent'
    | ((command: string) => 'present' | 'absent') = 'absent',
) => {
  const said = (command: string) =>
    typeof presence === 'function' ? presence(command) : presence;
  const answer = (command: string) =>
    Promise.resolve(isPresenceProbe(command) ? ok(said(command)) : ok());
  const execAsync = jest.fn((command: string) => answer(command));
  const execAsyncRemote = jest.fn((_serverId: string, command: string) =>
    answer(command),
  );
  const removeConfig = jest.fn().mockResolvedValue(undefined);
  /**
   * The cascade's settle clock (H-105), as the seam it exists to be: it advances
   * only by its own sleeps, so a test can exhaust the whole fifteen-second
   * deadline in microseconds. Without it the two tests below that leave a
   * compose child `present` would each sleep for fifteen real seconds, which is
   * the arrangement that produces suites people stop running.
   */
  const slept: number[] = [];
  let elapsedMs = 0;
  const settleClock: SettleClock = {
    now: () => elapsedMs,
    sleep: (ms) => {
      slept.push(ms);
      elapsedMs += ms;
      return Promise.resolve();
    },
  };
  return {
    execAsync,
    execAsyncRemote,
    removeConfig,
    slept,
    elapsed: () => elapsedMs,
    /** Every command the cascade issued, local and remote, in order. */
    commands: () => [
      ...execAsync.mock.calls.map((call) => call[0]),
      ...execAsyncRemote.mock.calls.map((call) => call[1]),
    ],
    deps: {
      // `withArgvExec` because an earlier change moved this cascade's teardown commands to
      // argv: the fake words them exactly as `execRemote` does and forwards them
      // to the two mocks above, so `commands()` still reads the ordered list of
      // commands the cascade issued — which is what every assertion here is
      // about — and the presence probes, which stay strings, are unaffected.
      // Inside the per-Delete memo `cascadeDelete` builds, which these
      // plain `Error` rejections never trip: it marks only a failure to
      // connect.
      remoteExec: new ReachabilityMemo(
        withArgvExec({
          execAsync,
          execAsyncRemote,
        }) as unknown as RemoteExecService,
      ),
      traefikWriter: { removeConfig } as unknown as TraefikWriterService,
      settleClock,
    },
  };
};

describe('tearDownCascadeChildren', () => {
  it('reports nothing when every child is confirmed gone', async () => {
    const doubles = depsDouble('absent');

    // Both halves empty, and the directory half matters: `rm -rf` exits 0 for a
    // path that is not there, so a healthy delete has nothing to report about a
    // tree it never had — which is what keeps the field meaning "these were
    // left behind" rather than "this route can leak directories".
    expect(
      await tearDownCascadeChildren(doubles.deps, [
        child(),
        child({ serviceType: 'postgres', serviceId: 'pg-1', appName: 'pg-db' }),
      ]),
    ).toEqual({ orphaned: [], unreclaimedArtifacts: [] });
  });

  it('tears an Application down as its swarm service and its Traefik config, and leaves its directory to the reclamation', async () => {
    const doubles = depsDouble();

    await tearDownCascadeChildren(doubles.deps, [child()]);

    // The Traefik config cascades nowhere: `domain.applicationId` takes the
    // domain rows with the Application, but the dynamic-config file they
    // generated is only removed by an explicit call, and without it the cascade
    // leaves a public hostname routed at nothing (the cascade fix's second correction).
    expect(doubles.removeConfig).toHaveBeenCalledWith('web-app', null);
    // No `rm -rf` ahead of the presence read: on this single-Server
    // shape the directory is the parent of the file mounts and the Trace
    // store, so a refused cascade has to keep it — see
    // `reclaimServiceDirectories` below.
    expect(doubles.commands()).toEqual([
      'docker service rm web-app',
      servicePresenceProbe('web-app'),
    ]);
  });

  it('tears a database down as its swarm service and nothing else', async () => {
    const doubles = depsDouble();

    await tearDownCascadeChildren(doubles.deps, [
      child({ serviceType: 'redis', serviceId: 'redis-1', appName: 'cache' }),
    ]);

    // No volume flag: volumes survive a Delete unless asked for, and a cascade
    // never asks — `CONTEXT.md`'s **Delete**.
    expect(doubles.commands()).toEqual([
      'docker service rm cache',
      servicePresenceProbe('cache'),
    ]);
    expect(doubles.removeConfig).not.toHaveBeenCalled();
  });

  it('tears a compose child down through both subsystems and probes both', async () => {
    const doubles = depsDouble();

    await tearDownCascadeChildren(doubles.deps, [
      child({
        serviceType: 'compose',
        serviceId: 'compose-1',
        appName: 'wordpress',
      }),
    ]);

    const [teardown, ...probes] = doubles.commands();
    expect(teardown).toContain('docker stack rm wordpress');
    // And not the project directory, for the Application's reason.
    expect(teardown).not.toContain('rm -rf');
    expect(teardown).toContain(
      'env -i PATH="$PATH" docker compose -p wordpress down',
    );
    expect(teardown).toContain('docker network disconnect wordpress');
    // `--volumes` is the flag the per-Compose route takes from its caller; the
    // cascade never passes it.
    expect(teardown).not.toContain('--volumes');
    // Both questions, because a stack is a swarm stack and a docker-compose
    // project is a set of containers, and the cascade is not entitled to guess
    // which one this row really is (H-87).
    expect(probes).toEqual([
      composeProjectPresenceProbe('wordpress'),
      stackPresenceProbe('wordpress'),
    ]);
  });

  /**
   * H-87 at the cascade. The bulk delete shares the per-Service call site, so the
   * same defect was here: a compose row's `composeType` is `PATCH`-able, this
   * file chose the probe by it, and `docker compose ps` at a project that is really a swarm
   * stack answers nothing — which `readWorkloadPresence` reads as `'absent'` and
   * the cascade answers by dropping the whole tree while the stack keeps
   * running. Every row under a Project, on one click.
   */
  it('reports a compose child whose swarm stack is running even though no compose project of that name exists', async () => {
    const doubles = depsDouble((command) =>
      command.includes('docker stack ps') ? 'present' : 'absent',
    );

    const { orphaned } = await tearDownCascadeChildren(doubles.deps, [
      child({
        serviceType: 'compose',
        serviceId: 'compose-1',
        appName: 'wordpress',
      }),
    ]);

    // Pre-fix, with the row saying `docker-compose`, this was `[]` — the
    // cascade's caller then answered 200 and deleted the tree.
    expect(orphaned).toEqual([
      { appName: 'wordpress', serverId: null, reason: 'present' },
    ]);
  });

  it('reports a compose child as unknown rather than absent when one subsystem cannot be reached', async () => {
    const doubles = depsDouble();
    doubles.execAsync.mockImplementation((command: string) =>
      command.includes('docker stack ps')
        ? Promise.reject(new Error('daemon down'))
        : Promise.resolve(ok('absent')),
    );

    const { orphaned } = await tearDownCascadeChildren(doubles.deps, [
      child({
        serviceType: 'compose',
        serviceId: 'compose-1',
        appName: 'wordpress',
      }),
    ]);

    // The half that answered said "not mine"; the half that would have said
    // otherwise never answered. That is not "gone".
    expect(orphaned).toEqual([
      { appName: 'wordpress', serverId: null, reason: 'unknown' },
    ]);
  });

  it('reports a child whose workload is still running', async () => {
    const doubles = depsDouble('present');

    expect(
      (
        await tearDownCascadeChildren(doubles.deps, [
          child(),
          child({ serviceType: 'mysql', serviceId: 'my-1', appName: 'my-db' }),
        ])
      ).orphaned,
    ).toEqual([
      { appName: 'web-app', serverId: null, reason: 'present' },
      { appName: 'my-db', serverId: null, reason: 'present' },
    ]);
  });

  it('reports a child whose server cannot be reached as unknown rather than absent', async () => {
    const doubles = depsDouble();
    doubles.execAsyncRemote.mockRejectedValue(
      new Error('ssh: connect refused'),
    );

    // The distinction the three-valued answer exists for: treating an
    // unreachable daemon as "gone" is the shortcut that manufactures the
    // orphan this issue is about.
    expect(
      (
        await tearDownCascadeChildren(doubles.deps, [
          child({ serverId: 'srv-1' }),
        ])
      ).orphaned,
    ).toEqual([{ appName: 'web-app', serverId: 'srv-1', reason: 'unknown' }]);
  });

  /**
   * The engine clones into `{applicationsDirectory()}/{appName}/code` on
   * `buildServerId || serverId`, and this file's `rm -rf` went to
   * `child.serverId` — so on a dedicated-build-Server install the removal was
   * issued to a machine that had never held the directory: non-zero exit,
   * swallowed by the best-effort `catch`, and the build tree survived every
   * cascade.
   *
   * **The assertion names the host, and that is the only kind that can catch
   * this.** Both the broken and the fixed code issue
   * `rm -rf /etc/cloudgate/applications/web-app`; they differ only in who is
   * asked, which is why every other test in this file — all of them on the
   * single-Server default where the two ids coincide — stayed green through the
   * whole life of the defect. The calls are read off `execAsyncRemote` rather
   * than `commands()`, because `commands()` deliberately drops the machine.
   */
  it('aims the source-tree removal at the build Server and everything else at the run Server', async () => {
    const doubles = depsDouble();
    const children = [child({ serverId: 'run-1', buildServerId: 'build-1' })];

    await tearDownCascadeChildren(doubles.deps, children);
    await reclaimServiceDirectories(doubles.deps.remoteExec, children);

    expect(doubles.execAsyncRemote.mock.calls).toEqual([
      ['run-1', 'docker service rm web-app'],
      ['run-1', servicePresenceProbe('web-app')],
      ['build-1', `rm -rf ${applicationsDirectoryOn('build-1')}/web-app`],
    ]);
    // The Traefik dynamic config is the run Server's file, not the builder's.
    expect(doubles.removeConfig).toHaveBeenCalledWith('web-app', 'run-1');
    expect(doubles.execAsync).not.toHaveBeenCalled();
  });

  /**
   * The other half: the `rm -rf` is the one teardown step no presence read
   * can see, and until now a failure of it was caught, discarded and reported
   * nowhere — so the delete answered a clean 200 having leaked a directory it
   * knew it had not removed.
   *
   * The presence read asks the **run** Server about a Swarm service. It cannot
   * be asked about a tree on the builder, and on the commonest failure — the
   * build Server being unreachable — it answers `'absent'` about the workload
   * perfectly correctly, so the delete proceeds and there is nothing in the
   * response to tell an operator which machine still holds what.
   */
  it('names the source tree it could not remove, and the build host it could not remove it from', async () => {
    const doubles = depsDouble();
    doubles.execAsyncRemote.mockImplementation(
      (_serverId: string, command: string) =>
        command.startsWith('rm -rf ')
          ? Promise.reject(new Error('ssh: no route to host'))
          : Promise.resolve(isPresenceProbe(command) ? ok('absent') : ok()),
    );

    const children = [child({ serverId: 'run-1', buildServerId: 'build-1' })];
    const { orphaned } = await tearDownCascadeChildren(doubles.deps, children);

    // The workload is gone, so nothing refuses and nothing is forced — this is
    // the healthy-looking delete that used to say nothing at all.
    expect(orphaned).toEqual([]);
    expect(
      await reclaimServiceDirectories(doubles.deps.remoteExec, children),
    ).toEqual([
      {
        kind: 'source-tree',
        appName: 'web-app',
        serverId: 'build-1',
        path: `${applicationsDirectoryOn('build-1')}/web-app`,
      },
    ]);
  });

  /**
   * The earlier finding at the artifact that was deliberately filed
   * rather than folded in.
   *
   * The Traefik dynamic config is the third of an Application's three machine
   * teardown steps and the only thing that removes it. The presence read below
   * asks the **run** Server — the very Server whose file this is — about a
   * *Swarm service*, so it answers `'absent'` about the workload perfectly
   * correctly while saying nothing at all about the file, and a failed `rm -f`
   * went into the best-effort `catch` and appeared in no field of the response.
   *
   * That failure is the one here that is not merely disk: `domain.applicationId`
   * cascades, so every domain row goes with the Application while the router
   * fragment they generated stays — and Traefik keeps advertising a public
   * hostname at a backend that no longer exists. On a Project delete that is
   * every hostname in the tree at once.
   *
   * The path is read off `dynamicTraefikConfigPath` rather than spelled out
   * here, because a report naming a path the removal never attempted is worse
   * than no report: an operator acts on it. The expectation therefore comes
   * from the writer that owns the file, not from this file's opinion of it.
   */
  /**
   * A Compose stack's project directory is its own reclamation too, on
   * its one Server and under that Server's root, and a database has no
   * directory to remove.
   */
  it('removes a Compose stack’s project directory on its own Server, and nothing for a database', async () => {
    const doubles = depsDouble();

    await reclaimServiceDirectories(doubles.deps.remoteExec, [
      child({
        serviceType: 'compose',
        serviceId: 'compose-1',
        appName: 'wordpress',
        serverId: 'srv-1',
      }),
      child({ serviceType: 'postgres', serviceId: 'pg-1', appName: 'pg-db' }),
    ]);

    expect(doubles.execAsyncRemote.mock.calls).toEqual([
      ['srv-1', `rm -rf ${composeDirectoryOn('srv-1')}/wordpress`],
    ]);
    expect(doubles.execAsync).not.toHaveBeenCalled();
  });

  /**
   * The stack's project directory holds its file mounts and its Trace
   * store's data beside the clone, so it is not a `'source-tree'` — whose
   * console copy calls it the build's checkout and safe to remove.
   */
  it('names a Compose stack’s project directory it could not remove as its own kind', async () => {
    const doubles = depsDouble();
    doubles.execAsyncRemote.mockRejectedValue(
      new Error('ssh: connect: no route to host'),
    );

    await expect(
      reclaimServiceDirectories(doubles.deps.remoteExec, [
        child({
          serviceType: 'compose',
          serviceId: 'compose-1',
          appName: 'wordpress',
          serverId: 'srv-1',
        }),
      ]),
    ).resolves.toEqual([
      {
        kind: 'compose-directory',
        appName: 'wordpress',
        serverId: 'srv-1',
        path: `${composeDirectoryOn('srv-1')}/wordpress`,
      },
    ]);
  });

  it('names the Traefik dynamic config it could not remove, on the run Server that still serves it', async () => {
    const doubles = depsDouble();
    doubles.removeConfig.mockRejectedValue(
      new Error('ssh: connect: no route to host'),
    );

    const { orphaned, unreclaimedArtifacts } = await tearDownCascadeChildren(
      doubles.deps,
      [child({ serverId: 'run-1', buildServerId: 'build-1' })],
    );

    // Nothing refuses: the workload really did go, which is exactly the
    // healthy-looking 200 this used to answer while leaving a hostname routed
    // at nothing.
    expect(orphaned).toEqual([]);
    expect(unreclaimedArtifacts).toEqual([
      {
        kind: 'traefik-config',
        appName: 'web-app',
        serverId: 'run-1',
        path: dynamicTraefikConfigPath('web-app', 'run-1'),
      },
    ]);
    // The machine is named by `serverId` and not by the path, which is why
    // that field is asserted above and why it says `run-1`: on this install
    // `localCloudgateDirectory()` and `REMOTE_CLOUDGATE_DIRECTORY` are the same
    // string, so the two hosts' config paths are byte-identical and only the
    // id tells an operator which box to go to. Same property as the source
    // tree's, one artifact along.
    expect(doubles.removeConfig).toHaveBeenCalledWith('web-app', 'run-1');
    // One failing step reports one artifact; the `kind` is what says which.
    expect(unreclaimedArtifacts).toHaveLength(1);
  });

  it('names every artifact of one child that failed, in the order they were attempted', async () => {
    const doubles = depsDouble();
    doubles.removeConfig.mockRejectedValue(new Error('permission denied'));
    doubles.execAsyncRemote.mockImplementation(
      (_serverId: string, command: string) =>
        command.startsWith('rm -rf ')
          ? Promise.reject(new Error('ssh: no route to host'))
          : Promise.resolve(isPresenceProbe(command) ? ok('absent') : ok()),
    );

    const children = [child({ serverId: 'run-1', buildServerId: 'build-1' })];
    const { unreclaimedArtifacts } = await tearDownCascadeChildren(
      doubles.deps,
      children,
    );

    // Two artifacts on two machines out of one child's delete, which is the
    // whole reason the report carries a `kind` and a `path` rather than one
    // field per filesystem shape — the second now from the reclamation
    // after the refusal, which `cascadeDelete` appends in that order.
    expect([
      ...unreclaimedArtifacts,
      ...(await reclaimServiceDirectories(doubles.deps.remoteExec, children)),
    ]).toEqual([
      {
        kind: 'traefik-config',
        appName: 'web-app',
        serverId: 'run-1',
        path: dynamicTraefikConfigPath('web-app', 'run-1'),
      },
      {
        kind: 'source-tree',
        appName: 'web-app',
        serverId: 'build-1',
        path: `${applicationsDirectoryOn('build-1')}/web-app`,
      },
    ]);
  });

  it('runs every command for a child on that child’s own server', async () => {
    const doubles = depsDouble();

    await tearDownCascadeChildren(doubles.deps, [
      child({ serverId: 'srv-1' }),
      child({
        serviceType: 'mongo',
        serviceId: 'mongo-1',
        appName: 'mongo-db',
        serverId: null,
      }),
    ]);

    // ADR-0008's "labels are read on the machine being addressed": a cascade
    // spanning two servers is the easiest place to read one machine's daemon
    // to authorize a delete on another.
    for (const call of doubles.execAsyncRemote.mock.calls) {
      expect(call[0]).toBe('srv-1');
      expect(call[1]).toContain('web-app');
    }
    for (const call of doubles.execAsync.mock.calls) {
      expect(call[0]).toContain('mongo-db');
    }
    expect(doubles.removeConfig).toHaveBeenCalledWith('web-app', 'srv-1');
  });

  it('carries on to the next child when one teardown step throws', async () => {
    const doubles = depsDouble();
    doubles.execAsync.mockImplementation((command: string) => {
      if (command === 'docker service rm web-app') {
        return Promise.reject(new Error('service removal failed'));
      }
      return Promise.resolve(isPresenceProbe(command) ? ok('absent') : ok());
    });

    const { orphaned } = await tearDownCascadeChildren(doubles.deps, [
      child(),
      child({ serviceType: 'redis', serviceId: 'redis-1', appName: 'cache' }),
    ]);

    // Best-effort per step, in preview-deployments.service.ts's shape and for
    // its stated reason: a missing service can't strand the others. What is
    // left is decided by the presence read, not by which step threw.
    expect(orphaned).toEqual([]);
    expect(doubles.commands()).toContain('docker service rm cache');
  });

  /**
   * H-105 at the cascade. The bulk delete shares the per-Service call site, so it
   * shared its read-then-act shape too: this file read compose presence *immediately* after
   * `composeTeardownCommand`, exactly as `ComposeService.remove` did before
   * H-99. `docker stack rm` returns as soon as the daemon accepts the removal
   * and `docker stack ps --quiet` keeps naming tasks in `Shutdown` for 6–7 s
   * after it — measured on the X-run host, 3 trials of 3 — so a Project or
   * Environment with a `stack` child 409'd on the first attempt every time, and
   * under `?force=true` named that child as `orphaned` when it was merely still
   * draining. `remove()` waited and the cascade did not, about a property the
   * per-Service delete owns.
   *
   * **The deadline is shared, and that is the whole design.** The settle is per
   * child, so a naive fix multiplies the ceiling by the child count — five
   * stacks would hold one `DELETE` for 75 s. One deadline for the cascade keeps
   * the worst case exactly where it already was.
   */
  describe('the settle window (H-105)', () => {
    const composeChild = (appName: string): CascadeChild =>
      child({
        serviceType: 'compose',
        serviceId: `compose-${appName}`,
        appName,
      });

    /**
     * A compose stack that is still draining and then is not — the wire shape
     * the host produced: `present` at t+0, `absent` a poll later.
     */
    const drainsAfter = (rounds: number) => {
      let seen = 0;
      return (command: string) => {
        if (!isPresenceProbe(command)) return ok();
        // Both questions per round (H-87), so a round is two probes.
        const said = seen >= rounds * 2 ? 'absent' : 'present';
        seen += 1;
        return ok(said);
      };
    };

    it('waits for a draining compose child rather than refusing the teardown it just issued', async () => {
      const doubles = depsDouble();
      const answer = drainsAfter(1);
      doubles.execAsync.mockImplementation((command: string) =>
        Promise.resolve(answer(command)),
      );

      const { orphaned } = await tearDownCascadeChildren(doubles.deps, [
        composeChild('wordpress'),
      ]);

      // Pre-fix this was `[{ appName: 'wordpress', reason: 'present' }]`, and
      // the caller answered 409 about a removal the same request had issued.
      expect(orphaned).toEqual([]);
      expect(doubles.slept).toEqual([COMPOSE_SETTLE_POLL_MS]);
    });

    it('spends one deadline across every child rather than one budget each', async () => {
      const doubles = depsDouble('present');

      const { orphaned } = await tearDownCascadeChildren(doubles.deps, [
        composeChild('wp-1'),
        composeChild('wp-2'),
        composeChild('wp-3'),
        composeChild('wp-4'),
        composeChild('wp-5'),
      ]);

      // Five children that never drain. A budget per child would hold the
      // request for five times this, and the operator has no way to tell a
      // request that is polite from one that is hung.
      expect(doubles.elapsed()).toBe(COMPOSE_SETTLE_BUDGET_MS);
      // And it still refuses all five: a spent deadline returns the probe's own
      // last answer, it does not synthesize `absent`.
      expect(orphaned).toEqual([
        { appName: 'wp-1', serverId: null, reason: 'present' },
        { appName: 'wp-2', serverId: null, reason: 'present' },
        { appName: 'wp-3', serverId: null, reason: 'present' },
        { appName: 'wp-4', serverId: null, reason: 'present' },
        { appName: 'wp-5', serverId: null, reason: 'present' },
      ]);
    });

    it('asks a child whose turn comes after the deadline exactly once', async () => {
      const doubles = depsDouble('present');

      await tearDownCascadeChildren(doubles.deps, [
        composeChild('wp-first'),
        composeChild('wp-second'),
      ]);

      const probesFor = (appName: string) =>
        doubles.commands().filter((command) => command.includes(appName))
          .length;
      // The first child burns the deadline: sixteen rounds of two questions,
      // fifteen sleeps between them, plus its own teardown command.
      expect(doubles.slept).toHaveLength(
        COMPOSE_SETTLE_BUDGET_MS / COMPOSE_SETTLE_POLL_MS,
      );
      // The second gets the immediate single read it got before this existed —
      // both questions, no poll — and refuses on it. That is the trade: the
      // worst case is unchanged, the common case is fixed.
      expect(probesFor('wp-second')).toBe(3);
    });

    it('does not re-ask a compose child whose Server cannot be reached', async () => {
      const doubles = depsDouble();
      doubles.execAsyncRemote.mockRejectedValue(
        new Error('ssh: connect ECONNREFUSED'),
      );

      const { orphaned } = await tearDownCascadeChildren(doubles.deps, [
        child({
          serviceType: 'compose',
          serviceId: 'compose-1',
          appName: 'wordpress',
          serverId: 'srv-1',
        }),
      ]);

      // `'unknown'` is not a draining stack, and re-asking it would multiply an
      // SSH connect timeout by the poll count — a delete against a Server that
      // is gone would become a minutes-long request buying nothing (H-99).
      expect(orphaned).toEqual([
        { appName: 'wordpress', serverId: 'srv-1', reason: 'unknown' },
      ]);
      expect(doubles.slept).toEqual([]);
    });

    it('never polls a child that is not compose', async () => {
      const doubles = depsDouble('present');

      const { orphaned } = await tearDownCascadeChildren(doubles.deps, [
        child(),
        child({ serviceType: 'postgres', serviceId: 'pg-1', appName: 'pg-db' }),
      ]);

      // `docker service rm` takes the service object with it, so `docker
      // service inspect` answers about the removal at once — there is no drain
      // window here, and inventing one would slow every refused delete down for
      // nothing.
      expect(doubles.slept).toEqual([]);
      expect(orphaned).toHaveLength(2);
    });
  });
});

describe('cascadeRefusalMessage', () => {
  const orphaned = [
    { appName: 'web-app', serverId: null, reason: 'present' as const },
    { appName: 'pg-db', serverId: 'srv-1', reason: 'unknown' as const },
  ];

  /**
   * Exact-wording assertions, applied to this refusal (X12-4). Both arms used to
   * be pinned by substring alone — `'2 of the 5 Services'`, `'Project cloudgate'`,
   * `'web-app, pg-db'`, `'?force=true'` — which is the assertion style that change was
   * filed to replace, and replaced for `servers.service.ts`'s refusal in this
   * same wave. Its docblock (`test/servers/servers.e2e-spec.ts:557`) gives the
   * reason: an earlier change rewrote the whole second half of that message with every
   * existing test still green, because a regex only reads back the words
   * somebody thought to name. *A regex is what let it drift.*
   *
   * The same hole was open here, and it is not hypothetical: deleting the
   * clause that states **why** the delete was refused —
   * `could not be confirmed gone, so the ${parent.kind} was kept` → `were
   * kept` — left all five substrings intact and this file green at 17/17, along
   * with `test/projects/service-cascade-delete.e2e-spec.ts` at 12/12. The
   * operator would have read "2 of the 5 Services under Project cloudgate were
   * kept: …" and never been told the reason, which is the only part of the
   * sentence that tells them whether to look at a Service or at a Server.
   *
   * So every arm below is whole-string equality — both `parent.kind`s, and
   * both singular shapes X12-4a added — and the shared halves are constants for
   * the reason servers' are: a failure then names the clause that moved rather
   * than re-printing 260 characters four times.
   *
   * The dash before the action clause is U+2014 in `service-cascade.ts`, so
   * `consequence()` spells it `—`: an editor that normalises it to `--` or a
   * hyphen would otherwise fail these on a one-character diff jest cannot show
   * — the same trap the `Cloudgate’s` apostrophe sets in servers' constants.
   */
  describe('the exact wording of the refusal (X12-4)', () => {
    /**
     * Why the delete was refused. Shared verbatim by every arm except for the
     * one word naming the parent, which is what makes it the clause worth
     * isolating: it is the half that change rewrote next door, and the half the
     * reproduction above deleted here.
     */
    const cause = (kind: 'Project' | 'Environment') =>
      `could not be confirmed gone, so the ${kind} was kept`;
    /** Varies with the fixture: the consequence names the orphans. */
    const consequence = (names: string) =>
      `deleting it would leave ${names} unreachable through Cloudgate —`;
    /**
     * The action agrees with the **orphan** count, and the noun in the count
     * clause agrees with the **total** — two different numbers, which is why
     * they are two separate branches in `src` and four fixtures here rather
     * than one `plural(n)` helper (X12-4a).
     */
    const ACTION_ONE = 'stop it, then delete again, or delete with ?force=true';
    const ACTION_MANY =
      'stop them, then delete again, or delete with ?force=true';

    it('states the count, the Project, the cause, every workload and the force escape', () => {
      expect(
        cascadeRefusalMessage(
          { kind: 'Project', name: 'cloudgate' },
          orphaned,
          5,
        ),
      ).toBe(
        `2 of the 5 Services under Project cloudgate ${cause('Project')}: ` +
          `${consequence('web-app, pg-db')} ${ACTION_MANY}`,
      );
    });

    it('names the Environment, not the Project, when an Environment is what was kept', () => {
      expect(
        cascadeRefusalMessage(
          { kind: 'Environment', name: 'production' },
          orphaned,
          2,
        ),
      ).toBe(
        `2 of the 2 Services under Environment production ${cause('Environment')}: ` +
          `${consequence('web-app, pg-db')} ${ACTION_MANY}`,
      );
    });

    /**
     * X12-4a, and the reason there are four fixtures rather than two.
     *
     * The message carries two numbers that agree independently: the noun in the
     * count clause agrees with `total`, and the *action* agrees with
     * `orphaned.length`. Before this, neither branched — a Project holding one
     * Service that survived read **"1 of the 1 Services … stop them"**, which
     * is wrong twice in one sentence, on the commonest cascade shape there is.
     *
     * The docblock on `cascadeRefusalMessage` claims it is "shaped like the
     * per-Service refusals in `applications.service.ts` and
     * `compose.service.ts` so the three read as one contract", and both of
     * those say **"stop it"** (`applications.service.ts:375`,
     * `databases/common/database-service.ts:376`) — while
     * `servers.service.ts:72` already pluralizes explicitly with
     * `found.length === 1 ? one : many`. So the file stated a contract it did
     * not meet; this is not a taste call.
     *
     * **Three of the four number combinations are reachable, and these fixtures
     * are one each.** `orphaned` is built by
     * {@link tearDownCascadeChildren}, which pushes at most one entry per
     * child, and `cascadeDelete` passes that same array's `children.length` as
     * `total` — so `orphaned.length <= total` structurally, and the fourth
     * combination (*plural of the singular*, "2 of the 1") cannot occur. The
     * wording never has to survive it, and nothing here pretends to test it.
     *
     * The `total === 1` arm restructures rather than just fixing the noun:
     * `1 of the 1 Service` agrees correctly and is still a tautology no
     * operator would write. When there is one Service and it is the one that
     * survived, "the only Service" is what the sentence means. The `X of the Y`
     * frame is kept everywhere else — including `2 of the 2`, which is real and
     * was observed on the box at `3 of the 3` — so this is not a general
     * collapse of the X === Y case.
     */
    it('says the only Service, not 1 of the 1 Services, when the parent held one', () => {
      expect(
        cascadeRefusalMessage(
          { kind: 'Project', name: 'cloudgate' },
          [orphaned[0]],
          1,
        ),
      ).toBe(
        `The only Service under Project cloudgate ${cause('Project')}: ` +
          `${consequence('web-app')} ${ACTION_ONE}`,
      );
    });

    it('says stop it for a single orphan while still naming the plural total', () => {
      expect(
        cascadeRefusalMessage(
          { kind: 'Environment', name: 'production' },
          [orphaned[0]],
          5,
        ),
      ).toBe(
        `1 of the 5 Services under Environment production ${cause('Environment')}: ` +
          `${consequence('web-app')} ${ACTION_ONE}`,
      );
    });

    /**
     * Kept as its own arm rather than left to the equality above, for the
     * reason servers' trailing-period test is kept alongside its three: §2.5 is
     * a *rule* about every refusal, and an equality test is regenerated from
     * the new output by whoever next rewrites the message — which is exactly
     * when a period comes back. This one fails instead of being updated.
     *
     * The old substring test is gone: its four `toContain`s are claims the
     * equality arms above now make in full, and a substring that passes on a
     * sentence with its reason removed is not evidence. Only its fifth
     * assertion — this one — states something equality cannot.
     */
    it('carries no trailing period, which §2.5 forbids', () => {
      const message = cascadeRefusalMessage(
        { kind: 'Project', name: 'cloudgate' },
        orphaned,
        5,
      );

      expect(message.endsWith('.')).toBe(false);
      expect(message).toMatch(/\?force=true$/);
    });
  });
});

/**
 * Which children the built-image reclamation is even asked about.
 *
 * The predicate is the safety property rather than a scope: `${appName}:latest`
 * is a tag *this platform produced*, and only the Application arm produces one.
 * A Compose stack's images are named by its own compose file and a managed
 * database runs an upstream image it pulled, so a wider filter would aim
 * `docker image rm` at a tag nothing here created.
 */
describe('builtImageOwnersOf', () => {
  it('names every Application in the cascade with the machine that built it', () => {
    expect(
      builtImageOwnersOf([
        child({ appName: 'web-app', buildServerId: 'srv-build' }),
        child({
          serviceType: 'compose',
          serviceId: 'c-1',
          appName: 'wordpress',
        }),
        child({ serviceType: 'postgres', serviceId: 'pg-1', appName: 'pg-db' }),
        child({ appName: 'api', serverId: 'srv-run' }),
      ]),
    ).toEqual([
      {
        appName: 'web-app',
        sourceType: 'git',
        serverId: null,
        buildServerId: 'srv-build',
      },
      {
        appName: 'api',
        sourceType: 'git',
        serverId: 'srv-run',
        buildServerId: null,
      },
    ]);
  });

  // Nothing was scaled on the way to being refused: a stack and a database are
  // in the list and neither reaches the reclamation.
  it('names no Compose stack and no database, which build no such tag', () => {
    expect(
      builtImageOwnersOf([
        child({
          serviceType: 'compose',
          serviceId: 'c-1',
          appName: 'wordpress',
        }),
        child({ serviceType: 'redis', serviceId: 'r-1', appName: 'cache' }),
      ]),
    ).toEqual([]);
  });

  // A `Map` miss in `listCascadeChildren` — the Application row went between
  // the two selects — is dropped rather than defaulted, because a guessed
  // source is a removal aimed at an operator's own image.
  it('drops an Application whose source it does not know', () => {
    expect(builtImageOwnersOf([child({ sourceType: null })])).toEqual([]);
  });
});

/**
 * The projection the run-Server reclamation takes.
 *
 * A second projection beside `buildHostArtifactOwnersOf`, which already carries
 * both of these columns — and that is deliberate rather than a duplicate. On
 * that type `serverId` is one of the two **inputs** `buildHostServerId`
 * resolves, and every reclamation taking it asks that question; a file-mounts
 * tree is a bind source, so the machine that holds it is the one whose daemon
 * resolves it and the build host must never be asked. The two projections are
 * named for the two questions, and this one's assertion is that the id it hands
 * over is the runner's even when the two differ.
 */
describe('fileMountOwnersOf', () => {
  it('names each Application with the Server that runs it, never the one that built it', () => {
    expect(
      fileMountOwnersOf([
        child({
          appName: 'web-app',
          serverId: 'srv-run',
          buildServerId: 'srv-build',
        }),
      ]),
    ).toEqual([{ appName: 'web-app', serverId: 'srv-run' }]);
  });

  it('names the platform host as the platform host', () => {
    // `null` is ADR-0008's platform host rather than "unknown", and the
    // reclamation dispatches locally for it.
    expect(fileMountOwnersOf([child({ appName: 'local-app' })])).toEqual([
      { appName: 'local-app', serverId: null },
    ]);
  });

  /**
   * **Every managed database too,**, and the assertion is the whole
   * set rather than one engine. `MountsService.baseFilesPath` forks on exactly
   * one `serviceType` — `'compose'` — so its other arm answers
   * `fileMountsDirectoryOnRunServer` for an Application *and* for all six
   * database types alike. A tree written by a default arm has to be reclaimed
   * by the complement of that same fork, or the two disagree the moment a ninth
   * engine is registered: an engine added to `serviceTypeEnum` writes file
   * mounts on the day it is added and would have to be remembered here
   * separately.
   *
   * An earlier fix reclaimed the Application arm only and recorded the rest as a known
   * gap; this closes it in the same change as `BaseDatabaseService.remove`,
   * because a rule that reclaims a database's file mounts on a **Project**
   * delete and not on the **database's own** is ADR-0018's drift rather than a
   * partial fix.
   */
  it('names every managed database beside the Applications, on the Server that runs each', () => {
    const engines = [
      'postgres',
      'mysql',
      'mariadb',
      'mongo',
      'redis',
      'libsql',
    ] as const;

    expect(
      fileMountOwnersOf(
        engines.map((serviceType, index) =>
          child({
            serviceType,
            serviceId: `db-${index}`,
            appName: `${serviceType}-db`,
            serverId: 'srv-run',
          }),
        ),
      ),
    ).toEqual(
      engines.map((serviceType) => ({
        appName: `${serviceType}-db`,
        serverId: 'srv-run',
      })),
    );
  });

  /**
   * A Compose stack needs nothing and must not be given one: its file mounts
   * sit at `{composeDirectoryOn(serverId)}/{appName}/files`, *inside* the
   * project tree `composeTeardownCommand` ends by `rm -rf`ing, on the one
   * machine a stack has (`findCompose` hard-codes `buildServerId: null`). An
   * entry here would be a second removal of a tree already gone — and, on a
   * failure, an `UnreclaimedArtifact` naming a directory the teardown step
   * above it had already reported.
   */
  it('names no Compose stack', () => {
    expect(
      fileMountOwnersOf([
        child({
          serviceType: 'compose',
          serviceId: 'c-1',
          appName: 'wordpress',
        }),
      ]),
    ).toEqual([]);
  });
});
