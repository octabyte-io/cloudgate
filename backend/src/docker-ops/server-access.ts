import { execOnServer } from '../remote/exec-dispatch';
import type {
  ExecResult,
  RemoteExecService,
} from '../remote/remote-exec.service';

// `checkServerAccess` used to live here and now lives in
// `common/owned-server.ts`: seven modules ask that question, and this one
// is about Docker. What is left is the dispatch half, which really is docker-ops
// vocabulary — and is deliberately not re-exporting the other half, so a reader
// grepping for the organization check lands where it actually is.

/**
 * Local or remote dispatch by serverId — now `remote/exec-dispatch.ts`'s, which
 * also takes argv. Kept as the docker-ops-facing name because seven
 * modules call it by it; a `string[]` is one program and its arguments and
 * needs no quoting, a `string` is a shell program and every interpolation in it
 * is still the caller's to `quote()`.
 */
export function execByServer(
  remoteExec: RemoteExecService,
  serverId: string | null | undefined,
  command: string | string[],
): Promise<ExecResult> {
  return execOnServer(remoteExec, serverId, command);
}
