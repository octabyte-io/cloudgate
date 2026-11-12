import type { Duplex } from 'node:stream';

import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../cloud-accounts/cloud-provider';
import { ExecError } from './exec-error';
import type {
  ServerConnection,
  ServerKeyProvider,
} from './server-key.provider';

/**
 * **How the remote-execution layer reaches a Stack VM** (ADR-0070): through
 * the cloud's own tunnel, with SSH inside it, so everything above the SSH
 * client — `RemoteExecService`, its cancellation, a Delete's
 * `ReachabilityMemo`, the SSH channels a socket forwards over — is the one
 * a Server uses, unchanged.
 *
 * The layer addresses what it dials by one string. A Stack VM is never a
 * Server row, so it gets an id of its own shape, {@link stackVmRemoteId}:
 * `stack-vm:<composeId>`. No Server id can take that shape (a Server's is
 * a nanoid, which has no colon), so the two never meet, and the one place
 * that turns either into a connection, {@link withStackVms}, answers a
 * Stack VM's only through its tunnel. Nothing else hands a Stack VM's id
 * to the layer but the run target (`run-target.ts`) and the paths rooted
 * on it.
 */

const STACK_VM_PREFIX = 'stack-vm:';

/** The id the remote-execution layer reaches a stack's Stack VM by. */
export function stackVmRemoteId(composeId: string): string {
  return `${STACK_VM_PREFIX}${composeId}`;
}

/** The stack whose Stack VM `remoteId` names, or `null` for any other id. */
export function stackOfRemoteId(
  remoteId: string | null | undefined,
): string | null {
  return remoteId?.startsWith(STACK_VM_PREFIX)
    ? remoteId.slice(STACK_VM_PREFIX.length)
    : null;
}

/**
 * Where one Stack VM is, as its cloud's tunnel opens a session to it. One
 * arm per cloud: AWS Session Manager, and Google IAP's TCP forwarding.
 */
export type StackVmEndpoint =
  | {
      readonly cloud: 'aws';
      readonly account: AwsCloudAccount;
      readonly region: string;
      /** The EC2 instance the stack's Apply recorded. */
      readonly instanceId: string;
    }
  | {
      readonly cloud: 'gcp';
      readonly account: GcpCloudAccount;
      /** The zone the stack's Apply made it in. */
      readonly zone: string;
      /** The Compute Engine name the stack's Apply recorded. */
      readonly instanceName: string;
    };

/** {@link StackVmEndpoint}'s arm for one cloud. */
export type StackVmEndpointOn<Cloud extends StackVmEndpoint['cloud']> = Extract<
  StackVmEndpoint,
  { readonly cloud: Cloud }
>;

/**
 * **The tunnel**: a byte stream to port 22 of one Stack VM, opened through
 * the cloud's session service. SSH runs inside it; the tunnel itself knows
 * nothing of SSH. Ending or destroying the stream ends the session.
 *
 * The seam every e2e replaces: a fake hands back a socket to a local
 * stand-in SSH server, and everything above runs as it does for real.
 */
export interface StackVmTunnel {
  open(endpoint: StackVmEndpoint): Promise<Duplex>;
}

export const STACK_VM_TUNNEL = Symbol('STACK_VM_TUNNEL');

/**
 * A Stack VM's SSH connection: its stack's own key (ADR-0006, ADR-0015),
 * over a tunnel already open. `sock` is always set: there is no address to
 * dial instead.
 */
export type StackVmConnection = ServerConnection & { readonly sock: Duplex };

/** Opens a stack's Stack VM's SSH connection, through its tunnel. */
export interface StackVmConnector {
  connect(composeId: string): Promise<StackVmConnection>;
}

export const STACK_VM_CONNECTOR = Symbol('STACK_VM_CONNECTOR');

/**
 * The connection provider every SSH client in the layer asks: a Stack VM's
 * id goes to its tunnel, and every other id to the Servers' own provider.
 * Without a connector a Stack VM's id is refused, never dialled.
 *
 * A tunnel that will not open is the Stack VM not answering, so it fails
 * as an SSH connection that will not open does (`connectionFailed`): a
 * Delete's `ReachabilityMemo` dials it once, as it would a Server.
 */
export function withStackVms(
  servers: ServerKeyProvider,
  stackVms: StackVmConnector | null | undefined,
): ServerKeyProvider {
  return {
    getConnection(remoteId: string): Promise<ServerConnection> {
      const composeId = stackOfRemoteId(remoteId);
      if (composeId === null) return servers.getConnection(remoteId);
      if (!stackVms) {
        return Promise.reject(
          new Error(
            'No Stack VM tunnel is configured, so a Stack VM cannot be reached',
          ),
        );
      }
      return stackVms.connect(composeId).catch((error: unknown) => {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new ExecError(`Could not reach the Stack VM: ${cause.message}`, {
          command: '',
          serverId: remoteId,
          originalError: cause,
          connectionFailed: true,
        });
      });
    },
  };
}
