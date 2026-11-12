import { join } from 'node:path';

import { stackRootId } from './stack-root';
import { runTeardownSteps } from '../common/teardown-steps';
import type { UnreclaimedArtifact } from '../common/teardown-steps';
import type { Compose } from '../db/schema';
import { composeDirectoryOn } from '../deployment-engine/deployment-engine.paths';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { runTargetOn } from '../remote/run-target';

/**
 * Drops a Compose stack's project directory, `{composeDirectoryOn(serverId)}/
 * {appName}`, and answers with it if it could not.
 *
 * **Why it is not in the teardown program any more.** It was the last
 * statement of `composeTeardownCommand`, so it ran ahead of the presence
 * refusal — and the tree holds the stack's file mounts (`files/`) and its
 * Trace store's data (`traces/`) beside its clone, neither of which anything
 * regenerates. A Delete that answered *"the Compose was kept"* had already
 * erased both. So `ComposeService.remove` and the Project/Environment cascade
 * run this in ADR-0016's post-refusal slot, after the Trace store reclamation
 * that stops the container writing into `traces/`.
 *
 * `serverId` is the stack's own Server and roots the path as well as receiving
 * the command: a destroyer that resolves a different root from the clone that
 * wrote the tree is ADR-0018's whole subject, and it moved in one change with
 * `deployCompose`'s clone. Argv, because `rm -rf` is exactly
 * where a word split deletes something else.
 *
 * A failure is reported as a `'compose-directory'`, not the Application's
 * `'source-tree'`: the tree holds the stack's file mounts and traces, not only
 * its checkout. It has to be reported at all because the presence read asks
 * the daemon about a workload and can say nothing about a directory, and
 * a failure here used to be the teardown program's exit status, swallowed
 * by a `catch` that deferred to that same read.
 */
export async function reclaimComposeDirectory(
  remoteExec: RemoteExecService,
  row: Pick<Compose, 'appName' | 'serverId'> &
    Partial<Pick<Compose, 'composeId' | 'cloudAccountId'>>,
): Promise<UnreclaimedArtifact[]> {
  const directory = join(composeDirectoryOn(stackRootId(row)), row.appName);
  return runTeardownSteps([
    {
      run: () =>
        runTargetOn(stackRootId(row), { remoteExec }).exec([
          'rm',
          '-rf',
          directory,
        ]),
      leftBehindOnFailure: {
        kind: 'compose-directory',
        appName: row.appName,
        serverId: row.serverId,
        path: directory,
      },
    },
  ]);
}
