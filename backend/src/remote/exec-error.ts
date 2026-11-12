import {
  elideEncodedPayloads,
  elidePayloadsInError,
} from '../common/logging/error-payloads';

export interface ExecErrorDetails {
  command: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  serverId?: string | null;
  originalError?: Error;
  /**
   * Set where the SSH connection itself failed — the client's `error` event
   * (refused, timed out, unreachable, handshake or key not accepted) or a
   * channel the Server would not open — and nowhere else. See
   * {@link isConnectionFailure}.
   */
  connectionFailed?: boolean;
}

/**
 * A failed exec, carrying enough of the failure to diagnose it.
 *
 * **The command it carries has its payloads elided, and that happens here
 * rather than at any call site**. Every field below outlives
 * the failure: `common/filters/all-exceptions.filter.ts` hands the whole
 * exception to the logger, the logger is pino, and pino's error serializer
 * writes the stack and *every own property*. Measured on one line, the command
 * appeared six times — `message`, `stack`, `command`, `originalError.message`,
 * `originalError.stack` and Node's own `originalError.cmd` — plus a seventh as
 * pino's `msg`, which pino copies from `message` before any serializer runs.
 *
 * So a failed file materialization used to print `base64(schedule.script)` to
 * the journal, and a failed mount write `base64(mount.content)`. Both columns
 * are `encryptedText` (ADR 0015): the code classifies them as secrets at rest
 * and then printed them on an error path. Nothing leaked on the wire — the
 * filter answers a bare 500 — the leak was into the journal, and into the
 * deployment log, since `DeploymentEngineService.appendErrorToLog` writes a
 * non-`ExecError`'s `message` there and `docker-ops` rewraps this `message`
 * into a plain `Error`.
 *
 * **Why the constructor and not the logging boundary.** Three reasons.
 * `command` has no behavioural reader anywhere in `src/` — nothing re-runs it,
 * nothing parses it — so eliding it costs nothing that is not diagnosis.
 * Second, pino is not the only consumer: the same strings reach a deployment
 * log, an HTTP failure message (`rcloneFailureMessage`) and a WebSocket close
 * reason, and a fix at the pino serializer would leave all three leaking. And
 * third, a mask that each `new ExecError(…)` had to remember to apply is the
 * answer that rots — there are ten construction sites in two files today, and
 * this class is the only carrier, so doing it here is the property rather than
 * a convention. {@link loggerConfig}'s `err` serializer applies the same
 * elision a second time, as a backstop for an error that is *not* an
 * `ExecError` and carries a command anyway.
 *
 * **What a reader can still learn** is on {@link elideEncodedPayloads}: every
 * verb, every path, every flag, the exit code, the `serverId`, both output
 * streams, and the payload's decoded size. What is gone is the bytes.
 *
 * `stack` needs no separate pass: V8 formats it from `this.message`, which is
 * already elided by the time `super()` returns.
 */
export class ExecError extends Error {
  readonly command: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly serverId?: string | null;
  readonly originalError?: Error;
  readonly connectionFailed: boolean;

  constructor(message: string, details: ExecErrorDetails) {
    super(elideEncodedPayloads(message));
    this.name = 'ExecError';
    this.command = details.command;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
    this.exitCode = details.exitCode;
    this.serverId = details.serverId;
    this.originalError = details.originalError;
    this.connectionFailed = details.connectionFailed ?? false;
    elideEveryString(this);
    // In place, on the raw child_process / ssh2 error this instance has just
    // taken ownership of. Every construction site in the tree passes an error
    // it caught and then discards, and pino follows the reference and writes
    // its `message`, `stack` and `cmd`, so a copy would have to be a faithful
    // Error rather than an object — see `redactS3CredentialsInError`, which
    // mutates the same objects for the same reason. This one goes through
    // `REDACTED_ERROR_FIELDS` rather than by shape, because the object is
    // Node's or ssh2's and its field names are theirs.
    if (this.originalError) elidePayloadsInError(this.originalError);
    Error.captureStackTrace(this, ExecError);
  }
}

/**
 * Whether an exec failed because the Server could not be connected to.
 *
 * A typed marker set at the point of failure rather than inferred from a
 * missing exit code: a remote program that outgrew `maxBuffer`, or was killed
 * by a signal (ssh2's channel `close` reports a `null` code), carries no exit
 * code either, and both ran on a Server that answered. `isTransportFailure`
 * still reads the missing code for its own question — *did a process report a
 * status* — which is a different one from *could the Server be reached*.
 */
export function isConnectionFailure(error: unknown): error is ExecError {
  return error instanceof ExecError && error.connectionFailed;
}

/**
 * Every string this instance carries, whatever it happens to be called — and
 * that totality is the point.
 *
 * The alternative was eliding the four fields by name, which works exactly
 * until someone adds a fifth to {@link ExecErrorDetails}: a `script`, an `env`,
 * a `stdin` — each a place a file body would sit — and it ships unelided and
 * green, because a new field has no test asserting it is masked. `Object.keys`
 * has no such gap: the next field is covered the moment it is assigned above.
 * `message` is not in it (V8 makes it non-enumerable) and needs no pass, having
 * gone through `super()` already; `stack` is formatted from that message.
 *
 * Nothing here is lossy for a field that is not a payload. `name` and
 * `serverId` contain no `echo … | base64 -d` and no URL userinfo, so both
 * patterns leave them exactly as they were —
 * `test/remote/exec-error-payloads.spec.ts` asserts the `serverId` survives.
 */
const elideEveryString = (target: object): void => {
  const fields = target as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (typeof value === 'string') {
      fields[key] = elideEncodedPayloads(value);
    }
  }
};
