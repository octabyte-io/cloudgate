import { execOnServerStdout } from '../remote/exec-dispatch';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { garageConfigSecretName } from './garage';

/**
 * Takes a bucket's Garage off its run Server: its Swarm service, then the
 * secret its config was handed over in, which only that service used. Each
 * best-effort, as every teardown is: what is left is the presence read's to
 * say (`common/workload-presence.ts`), and a secret left behind holds only
 * this bucket's own admin credential. The volume is not touched here — what
 * happens to a bucket's files is `BucketDeletes`': its volume goes
 * only when the bucket was empty.
 */
export async function removeBucketService(
  remoteExec: RemoteExecService,
  serverId: string | null,
  appName: string,
): Promise<void> {
  try {
    await execOnServerStdout(remoteExec, serverId, [
      'docker',
      'service',
      'rm',
      appName,
    ]);
  } finally {
    await execOnServerStdout(remoteExec, serverId, [
      'docker',
      'secret',
      'rm',
      garageConfigSecretName(appName),
    ]).catch(() => undefined);
  }
}
