/**
 * Whether a Service's workload is still running — the read that decides whether
 * a refused teardown may drop the row.
 *
 * Three-valued on purpose. A daemon or a Server that cannot be reached at all
 * is not the same answer as "gone"; treating it as gone is exactly the shortcut
 * that manufactures an orphan, so it is `'unknown'` and the
 * caller refuses unless the operator forced it.
 */
export type WorkloadPresence = 'present' | 'absent' | 'unknown';

/**
 * What a `?force=true` delete admits it left behind. Returned beside the
 * deleted row rather than swallowed, so the answer stops being a bare 200 that
 * says the workload is gone when nobody established that.
 */
export interface OrphanedWorkload {
  appName: string;
  serverId: string | null;
  reason: Exclude<WorkloadPresence, 'absent'>;
}

/**
 * The one place the three-valued answer is decided, for all three kinds of
 * Service.
 *
 * It lives here rather than beside any one of them because Application,
 * database and Compose each ask a *different* question — `docker service
 * inspect`, and for Compose `docker stack ps` *and* `docker compose ps`, both,
 * because the stored compose type is `PATCH`-able and keying the probe off it
 * was H-87 — but every one of them must turn the answer into a verdict the same
 * way. Three copies of that rule was the shape this replaced, and the failure
 * mode if one drifts is silent and severe: a wrong `'absent'` drops the
 * Cloudgate record while the containers keep running, which per ADR-0008 hands
 * them to every organization on the host as unmanaged.
 * `CODING_STANDARDS` §1.4 puts a rule two modules share in `common/`.
 *
 * `RemoteExecService` rejects on a non-zero exit, so a plain try/catch cannot
 * separate "no such service" from "cannot reach the daemon" — both arrive as a
 * rejection. All three answers are therefore decided **in the shell**, by
 * {@link presenceProbeCommand}, so one exec answers all of them: the probe exits
 * 0 whatever happened and names the answer on stdout. That is why this takes a
 * thunk rather than a string — a rejection is still part of the answer (the
 * transport can fail before any shell runs), so the call has to happen inside.
 *
 * Do not add `|| true` anywhere in a probe, and do not collapse
 * {@link presenceProbeCommand}'s three branches into two: the point is that
 * every zero-exit outcome is one of the three the product can act on, and that
 * the branch which drops a row is reached only by a positive answer.
 */
export const readWorkloadPresence = async (
  probe: () => Promise<string>,
): Promise<WorkloadPresence> => {
  let answer: string;
  try {
    answer = await probe();
  } catch {
    // The transport itself failed — SSH refused, no route to the Server. A
    // *daemon* that is down no longer arrives here: it exits 0 saying `unknown`,
    // because a rejection could not be told apart from "no such service" (H-95).
    return 'unknown';
  }
  const said = answer.trim();
  // `unknown` is a token the probe emits on purpose, not a fallthrough: it is
  // what {@link presenceProbeCommand}'s first branch prints when the daemon
  // cannot be reached (H-95). It is matched here so that the arm below keeps the
  // narrow meaning it documents, and so nobody "cleans up" the reliance on it.
  if (said === 'present' || said === 'absent' || said === 'unknown') {
    return said;
  }
  // Anything else is a shell that never ran the command — a banner, a login
  // failure, an empty answer — and is no more "gone" than a rejection is.
  return 'unknown';
};

/**
 * The probe every presence read runs, as a shell *program* — the other half of
 * the contract {@link readWorkloadPresence} reads (H-95).
 *
 * **Why the daemon is asked separately, and why this shape rather than
 * `<question> && echo present || echo absent`.** That was the shape of all four
 * probes, and the docblock above it claimed *"only a genuinely unreachable
 * daemon can make the exec itself reject"*. It was false. `||` swallows every
 * non-zero exit, and `Cannot connect to the Docker daemon` is a non-zero exit
 * like any other, so a daemon that was stopped, wedged or mid-restart on a
 * perfectly reachable Server made the probe print `absent` at exit 0 — the row
 * was dropped, the workload kept running, and per ADR-0008 the containers were
 * handed to every organization on the host as unmanaged. Measured on the host,
 * docker 29.7.2, against services that were `1/1` at that second, with
 * `DOCKER_HOST` pointed at a closed port:
 *
 * ```
 * docker service inspect w02-shared-app >/dev/null 2>&1 && echo present || echo absent  → absent, exit 0
 * docker stack ps w02-shared-compose --quiet …          && echo present || echo absent  → absent, exit 0
 * ```
 *
 * No `PATCH`, no force flag, no attacker: a `systemctl restart docker` during a
 * delete was enough. `'unknown'` was reachable only when the *transport* failed,
 * so the three-valued type had never been exercised on the arm that matters —
 * every `unknown` anyone had seen came from an unreachable Server.
 *
 * **`docker version` is the reachability question**, and it has to be a separate
 * question: the CLI exits 1 for both `no such service` *and* `Cannot connect to
 * the Docker daemon`, so no exit code distinguishes them, and matching the
 * message would pin a verdict to a wording. `docker version` over `docker info`
 * because it is the cheaper round trip — measured on the host, 43 ms against
 * 142 ms, next to 32 ms for the `service inspect` it guards — and it touches the
 * daemon, unlike the client-only `docker compose version`.
 *
 * **The check goes first, as a precondition.** Asking it only on the way to
 * `absent` would save a round trip on the `present` path, but it inverts which
 * instant the answer is sound at: a daemon coming *back* between the two
 * commands would then read as `absent`, and coming back is precisely what a
 * restart does. Guarding first means an outage of any duration answers
 * `unknown`, and the residual race needs the daemon to die inside the gap
 * between two consecutive commands of one shell.
 *
 * `env` lets the caller run both commands under the same environment as the
 * question — the compose project probe needs it, because its `env -i` strips
 * `DOCKER_HOST` and an unguarded `docker version` would then answer for a
 * different daemon than `docker compose ps` does.
 *
 * Both arguments are complete shell *tests*, exit status only: the caller
 * redirects its own output and quotes its own interpolations (§2.9).
 */
export const presenceProbeCommand = ({
  daemonReachable = 'docker version >/dev/null 2>&1',
  workloadPresent,
}: {
  daemonReachable?: string;
  workloadPresent: string;
}): string =>
  `if ! ${daemonReachable}; then echo unknown; elif ${workloadPresent}; then echo present; else echo absent; fi`;
