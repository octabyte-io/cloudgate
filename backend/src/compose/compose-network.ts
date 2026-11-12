import { quote } from 'shell-quote';
import { stackRootId } from './stack-root';
import { runTeardownSteps } from '../common/teardown-steps';
import type { UnreclaimedArtifact } from '../common/teardown-steps';
import type { Compose } from '../db/schema';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { runTargetOn } from '../remote/run-target';

/**
 * The shell that removes a Compose stack's own isolated network if it is still
 * there, exiting non-zero only when it is there and could not be removed.
 *
 * An `if` rather than `inspect || rm`, so that the network's absence — every
 * stack that was never isolated, and every docker-compose stack whose teardown
 * already removed it — is exit 0 with nothing run, and only a removal that was
 * attempted and refused reads as a failure.
 */
export function composeNetworkReclaimCommand(appName: string): string {
  const network = quote([appName]);
  return `if docker network inspect ${network} >/dev/null 2>&1; then docker network disconnect ${network} cloudgate-traefik >/dev/null 2>&1; docker network rm ${network} >/dev/null; fi`;
}

/**
 * Removes the network **Network isolation** gave a Compose stack, on the
 * stack's Server, and answers with it if it is still there.
 *
 * **What was leaking.** `getBuildComposeCommand` creates an attachable network
 * named `appName` for an isolated stack and declares it `external: true` in
 * the rewritten file, so `docker compose down` — which removes only the
 * project's `<appName>_default` — never touched it, and nothing else did:
 * every stack ever deployed isolated left one network per stack behind its
 * delete.
 *
 * `composeTeardownCommand` now removes it, which covers a
 * docker-compose project, whose `down` has returned with every container gone.
 * It cannot cover a **Swarm stack**: `docker stack rm` returns on acceptance
 * and its tasks hold the overlay until they drain, which is exactly the wait
 * `awaitComposeWorkloadAbsent` makes before the presence answer. So this runs
 * again after that answer, in ADR-0016's post-refusal slot beside the images
 * and the logs, and is where a removal that still failed gets reported rather
 * than dropped. On the common path the teardown already removed it, the
 * `inspect` answers no, and this is one read.
 */
export async function reclaimComposeNetwork(
  remoteExec: RemoteExecService,
  row: Pick<Compose, 'appName' | 'serverId'> &
    Partial<Pick<Compose, 'composeId' | 'cloudAccountId'>>,
): Promise<UnreclaimedArtifact[]> {
  return runTeardownSteps([
    {
      run: () =>
        runTargetOn(stackRootId(row), { remoteExec }).exec(
          composeNetworkReclaimCommand(row.appName),
        ),
      leftBehindOnFailure: {
        kind: 'network',
        appName: row.appName,
        serverId: row.serverId,
        path: row.appName,
      },
    },
  ]);
}
