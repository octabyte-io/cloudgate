import { createHash } from 'node:crypto';
import { ConflictException, HttpException } from '@nestjs/common';
import type { ConnectConfig } from 'ssh2';
import type { ServerConnection } from './server-key.provider';

/**
 * **Which machine answered: the host key every SSH connect checks (ADR-0074).**
 *
 * ssh2 accepts any host key when it is given no `hostVerifier`, and every
 * client in the remote-execution layer was given none, so whoever sat between
 * Cloudgate and a Server read every command and the credentials in its
 * environment. This module is the one place that decides whether a host key
 * is the right one; each SSH client takes its connect config from
 * {@link sshConnectConfig} and its failure from {@link sshFailure}, and none
 * holds any logic of its own about keys.
 *
 * The rule is trust on first use, as OpenSSH's `known_hosts` does it: a Server
 * with no recorded fingerprint has the one it presents recorded and accepted;
 * a Server with one is accepted only on a match, and otherwise refused with
 * {@link HOST_KEY_CHANGED_CODE} naming both fingerprints. Forgetting the
 * recorded fingerprint (`POST /servers/:id/forget-host-key`) is the operator's
 * deliberate "this Server was reinstalled", after which the next connect
 * records again.
 */

/** The `code` a refused, changed host key carries on the wire (ADR-0005). */
export const HOST_KEY_CHANGED_CODE = 'SERVER_HOST_KEY_CHANGED';

/**
 * A host key's fingerprint in OpenSSH's own form, `SHA256:` and the unpadded
 * base64 of the SHA-256 of the raw key blob — what `ssh-keygen -lf` prints
 * for `/etc/ssh/ssh_host_*_key.pub` on the Server, so an operator can compare
 * the two by eye.
 */
export function hostKeyFingerprint(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/** ssh2's asynchronous `hostVerifier`: answered through `verify`. */
export type HostKeyVerifier = (
  key: Buffer,
  verify: (valid: boolean) => void,
) => void;

/**
 * One connection's host key check: the verifier ssh2 calls during the
 * handshake, and why it said no, if it did.
 */
export interface HostKeyCheck {
  readonly verifier: HostKeyVerifier;
  /**
   * The refusal behind a handshake the verifier failed — a changed host key,
   * or a first-use fingerprint that could not be recorded — and `undefined`
   * while the verifier has refused nothing. ssh2 reports a refused host key
   * only as `Host denied (verification failed)`, so {@link sshFailure} asks
   * this instead.
   */
  refusal(): Error | undefined;
}

/** Where a Server's recorded fingerprint lives: its row's column. */
export interface HostKeyStore {
  /**
   * Records `fingerprint` **only if none is recorded** and answers the one
   * recorded afterwards: this one, or the one a concurrent first connect
   * recorded first. Two first connects that see the same key write the same
   * value, so the race is harmless; two that see different keys are told
   * apart here, and the loser is refused.
   */
  recordFirst(fingerprint: string): Promise<string | null>;
}

/** Whether `error` is the refusal of a Server whose host key changed. */
export function isHostKeyChanged(error: unknown): error is ConflictException {
  if (!(error instanceof HttpException)) return false;
  const body = error.getResponse();
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === HOST_KEY_CHANGED_CODE
  );
}

/** The refusal for a Server whose host key is not the one recorded. */
export function hostKeyChangedError(
  serverName: string,
  expected: string,
  received: string,
): ConflictException {
  return new ConflictException({
    code: HOST_KEY_CHANGED_CODE,
    message:
      `The host key of Server "${serverName}" changed, so Cloudgate did not connect: ` +
      `expected ${expected}, received ${received}. ` +
      `If the Server was reinstalled, forget its host key on the Access tab and connect again; ` +
      `if not, something may be intercepting the connection`,
  });
}

/**
 * Trust on first use for one Server: `recorded` is the fingerprint its row
 * held when the connection details were read, `store` its column.
 *
 * The recorded value is kept in the closure and updated after a first-use
 * write, so a client that dials again on the same details (dockerode dials
 * once per request) checks against what the first dial recorded.
 *
 * **A first-use write that fails refuses the connection.** Accepting it
 * unrecorded would be exactly the unverified connect this exists to end, and
 * a database that cannot take one `update` is failing everything else too.
 */
export function trustOnFirstUse(
  serverName: string,
  recorded: string | null,
  store: HostKeyStore,
): HostKeyCheck {
  let known = recorded;
  let refused: Error | undefined;

  const decide = async (received: string): Promise<boolean> => {
    if (known === null) {
      known = await store.recordFirst(received);
    }
    if (known === received) return true;
    refused = hostKeyChangedError(serverName, known ?? '(none)', received);
    return false;
  };

  return {
    verifier: (key, verify) => {
      decide(hostKeyFingerprint(key)).then(verify, (error: unknown) => {
        const cause = error instanceof Error ? error.message : String(error);
        refused = new Error(
          `The host key of Server "${serverName}" could not be recorded, so Cloudgate did not connect: ${cause}`,
        );
        verify(false);
      });
    },
    refusal: () => refused,
  };
}

/**
 * A connection whose host key is **not** checked here, because something
 * else already says which machine is on the other end. Two callers, each with
 * its reason at the call site, and nothing else may take it:
 *
 * - a Stack VM, reached only through its cloud's own tunnel to one instance
 *   id (ADR-0070): the cloud's session service authenticates the endpoint,
 *   and a Stack VM has no Server row to record a fingerprint on;
 * - the platform host's own terminal, dialled from the backend's container to
 *   the Docker host it runs on, which has no Server row either.
 */
export function unverifiedHostKey(): HostKeyCheck {
  return {
    verifier: (_key, verify) => verify(true),
    refusal: () => undefined,
  };
}

/**
 * The ssh2 connect config for a connection — **the one way an SSH client in
 * this codebase builds one**, so none can leave the host key unchecked.
 * Options a client adds of its own (keepalives) are spread over it.
 */
export function sshConnectConfig(connection: ServerConnection): ConnectConfig {
  return {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    privateKey: connection.privateKey,
    ...(connection.sock ? { sock: connection.sock } : {}),
    hostVerifier: connection.hostKey.verifier,
  };
}

/**
 * What an ssh2 `error` on `connection` means: the host key refusal when the
 * verifier refused the handshake, and ssh2's own error otherwise.
 */
export function sshFailure(connection: ServerConnection, error: Error): Error {
  return connection.hostKey.refusal() ?? error;
}
