import { stackVmRemoteId } from '../remote/stack-vm-remote';

/**
 * What a stack's paths are rooted on (`composeDirectoryOn`), the same answer
 * its run target gives (`RunTarget.remoteId`): its Stack VM's id when it is
 * in a Cloud account (ADR-0070), else its Server's, else `null` for the
 * platform host. A Stack VM's tree is rooted as a Server's is, under
 * `/etc/cloudgate`, never at the platform host's own root.
 *
 * `composeId` and `cloudAccountId` are optional only so a builder's narrow
 * test slice still types; every row passes both.
 */
export function stackRootId(stack: {
  readonly serverId: string | null;
  readonly composeId?: string;
  readonly cloudAccountId?: string | null;
}): string | null {
  return stack.cloudAccountId && stack.composeId
    ? stackVmRemoteId(stack.composeId)
    : stack.serverId || null;
}
