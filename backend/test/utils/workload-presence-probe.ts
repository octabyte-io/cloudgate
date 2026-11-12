/**
 * The workload-presence probe of the cascade fix as the test tree writes it — **one**
 * hand-written copy, deliberately independent of `src` (closing H-108 and
 * H-161).
 *
 * **Why this is hand-written and must stay that way.** Every suite that touches
 * a Delete needs either to write the probe out or to recognise one, and the
 * obvious move is to import `presenceProbeCommand` from
 * `src/common/workload-presence.ts`. That import is what this file exists to
 * refuse: a test that imported the builder would agree with whatever the builder
 * said, and the shell trick the whole three-valued read depends on — exit 0
 * whatever happened, the answer named on stdout, the daemon asked *before* the
 * workload — is exactly what a "simplification" would quietly drop while every
 * such test stayed green. So the shape is stated here a second time, by hand,
 * and the two statements are compared rather than shared. One independent copy,
 * not zero.
 *
 * **Why one copy rather than ten.** There used to be ten. H-95 changed the
 * shape — `<question> >/dev/null 2>&1 && echo present || echo absent` became
 * `if ! <daemon>; then echo unknown; elif <question>; …`, because `||` swallows
 * `Cannot connect to the Docker daemon` like any other non-zero exit, so a
 * stopped or wedged daemon on a reachable Server printed `absent` at exit 0 and
 * the row was dropped while the workload kept running — and updated the four
 * builders and their unit specs but not the ten copies. Nine of those copies
 * were *discriminators* inside an e2e suite's default exec mock
 * (`command.startsWith('docker service inspect ')`,
 * `command.endsWith('&& echo present || echo absent')`); once one stopped
 * matching, the probe fell through to the mock's default, answered `''`,
 * `readWorkloadPresence` read that as `'unknown'`, and **every delete in that
 * suite 409'd** — 21 tests across 9 suites, deterministically red on `main` from
 * `84a1dcb` (H-104). The property being preserved is independence from `src`,
 * which one copy preserves exactly; ten copies bought nothing but nine ways to
 * go stale. The next shape change is now one file's edit.
 *
 * **What enforces the independence, and the distinction to keep.** The
 * set-level guard at the foot of `test/common/workload-presence.spec.ts` (its
 * `describe('backend/test')` block) scans every `.ts` under `backend/test`,
 * derives the expected shape from `presenceProbeCommand` itself rather than
 * restating it, and fails if a hand-written probe has drifted, if a
 * hand-written discriminator recognises no probe the product can issue, or if an
 * eleventh copy appears anywhere in the tree. It is what makes this copy safe to
 * keep — and it is a *set-level* guard on purpose:
 *
 * > **A set-level guard catches drift; a substring pin does not catch
 * > rewriting.**
 *
 * Do not replace that guard with a `toBe` on this file's output. A `toBe` here
 * would be a pin on a copy that agrees with itself, which H-104 already showed
 * to be worthless: `toBe('… && echo present || echo absent')` **passed on the
 * H-95 bug**, in three spec files, and so did every unit test of
 * `readWorkloadPresence`, because the mapping was never the broken half — the
 * shell was. The executed proof, run through a real `/bin/sh` against the
 * `docker` stub in `docker-daemon-stub.ts`, is the other half of that answer and
 * lives in the same spec file.
 *
 * When the probe's shape changes: change {@link presenceProbe} here, and the
 * guard tells you if anything else in the tree still disagrees.
 */

/**
 * The reachability question every probe asks first, and the reason it is a
 * separate question: the docker CLI exits 1 for both `no such service` *and*
 * `Cannot connect to the Docker daemon`, so no exit code distinguishes them.
 */
const DAEMON_REACHABLE = 'docker version >/dev/null 2>&1';

/**
 * The compose project half's reachability question. It has to run under the same
 * `env -i` as the question it guards: `env -i` strips `DOCKER_HOST`, so a bare
 * `docker version` there would answer for a different daemon than
 * `docker compose ps` does.
 */
const COMPOSE_DAEMON_REACHABLE =
  'env -i PATH="$PATH" docker version >/dev/null 2>&1';

/**
 * The probe as a shell *program*, both questions supplied by the caller — the
 * hand-written twin of `presenceProbeCommand`.
 *
 * Three branches, three tokens on stdout, exit 0 for all of them, and the token
 * that lets a row be dropped (`absent`) reachable only after the daemon has
 * positively answered. Both arguments are complete shell tests, exit status
 * only.
 */
export const presenceProbe = ({
  daemonReachable = DAEMON_REACHABLE,
  workloadPresent,
}: {
  daemonReachable?: string;
  workloadPresent: string;
}): string =>
  `if ! ${daemonReachable}; then echo unknown; elif ${workloadPresent}; then echo present; else echo absent; fi`;

/**
 * The swarm-service question — what an Application's Delete and all six
 * database engines' Deletes issue, via `applicationServicePresence` and
 * `databaseServicePresence`.
 */
export const servicePresenceProbe = (appName: string): string =>
  presenceProbe({
    workloadPresent: `docker service inspect ${appName} >/dev/null 2>&1`,
  });

/**
 * Whether a deleted database left its data volume behind — issued by
 * `databaseVolumeLeftBehind` after `BaseDatabaseService.remove`'s teardown.
 *
 * A volume is node-local, so `docker volume inspect` on the addressed Server
 * answers for the whole swarm only when the swarm is that one node. That is
 * folded into the reachability question: on a multi-node swarm the probe says
 * `unknown`, never `absent`, because the volume may be on another node.
 */
export const volumePresenceProbe = (volumeName: string): string =>
  presenceProbe({
    daemonReachable: `{ ${DAEMON_REACHABLE} && [ "$(docker info --format '{{.Swarm.Nodes}}' 2>/dev/null)" = 1 ]; }`,
    workloadPresent: `docker volume inspect ${volumeName} >/dev/null 2>&1`,
  });

/**
 * The swarm-stack half of a Compose Delete. A stack has no compose project to
 * `ps`, which is why it is a different question from
 * {@link composeProjectPresenceProbe} — and Delete issues **both**, because the
 * stored `composeType` is `PATCH`-able and keying the probe off it was H-87.
 */
export const stackPresenceProbe = (appName: string): string =>
  presenceProbe({
    workloadPresent: `docker stack ps ${appName} --quiet >/dev/null 2>&1`,
  });

/**
 * The docker-compose-project half of a Compose Delete: a project with no
 * running containers `ps`es to an empty list at exit 0, so the answer is the
 * emptiness of the id list rather than the exit status.
 */
export const composeProjectPresenceProbe = (appName: string): string =>
  presenceProbe({
    daemonReachable: COMPOSE_DAEMON_REACHABLE,
    workloadPresent: `[ -n "$(env -i PATH="$PATH" docker compose -p ${appName} ps --quiet 2>/dev/null)" ]`,
  });

/**
 * Whether `command` is a presence probe — for the default exec mock of a suite
 * whose Delete reaches the exec layer, which has to answer that one command
 * differently from every other.
 *
 * Matched by its three-branch shell shape rather than by the question inside it,
 * so one predicate covers all three questions. **Both ends are checked**, and
 * that is the load-bearing part: `startsWith('if ! ')` alone would also match a
 * future two-branch probe that had dropped the `unknown` arm, which is the
 * regression H-95 fixed, and a `startsWith('docker service inspect ')`
 * discriminator — pinning the *question* rather than the program — is exactly
 * what H-104 was.
 *
 * A discriminator that matches nothing does not fail loudly: the command falls
 * through to the mock's default, the probe answers `''`, the product reads that
 * as `'unknown'`, and the delete refuses — so the failure looks like a product
 * bug rather than a stale test. The set-level guard asserts that this predicate
 * still recognises a probe the product can issue.
 */
export const isPresenceProbe = (command: string): boolean =>
  command.startsWith('if ! ') && command.endsWith('else echo absent; fi');
