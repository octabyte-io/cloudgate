import type { Params } from 'nestjs-pino';
import { stdSerializers } from 'pino';
import { elidePayloadsInError } from './error-payloads';

/**
 * The header values pino replaces before a request line is written.
 *
 * pino-http's default serializer logs the whole header set, so every
 * request wrote a working credential to the journal — the API key on a CLI
 * call, the session cookie on a console call, and `set-cookie` on the way back
 * out. Anyone who could read the logs, or a support bundle, held a credential
 * for the whole instance.
 *
 * The paths are pino's, not ours, and they have to match what the serializer
 * actually emits: `req.headers.*` and `res.headers.*`, with bracket notation
 * for the hyphenated names, which `test/common/logging/logger.config.spec.ts`
 * pins by driving a real HTTP round-trip rather than a fake req/res. Node
 * lower-cases header names in both directions, so the paths are lower-case and
 * an `X-Api-Key` on the wire is still caught.
 *
 * Only the value goes. Removing the key was rejected: "was there a credential
 * on this request" is worth reading, and the value is not. Every other header
 * keeps being logged, because the rest of the set is what makes the line useful.
 *
 * Declared here rather than at a call site so that the next credential-bearing
 * header is one line, in one place.
 */
export const redactedHeaderPaths = [
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
];

/**
 * The backstop under `ExecError`'s own elision.
 *
 * `redact` cannot do this job: it replaces a value at a fixed path, and what has
 * to go here is a *substring* — the base64 payload inside a command, with the
 * command's verbs and paths kept. So it is a serializer, and it runs
 * `pino.stdSerializers.err` first so the shape of every logged error is exactly
 * the shape it was, then elides over the object that produced. Mutating that
 * object touches nothing the thrower still holds: `errSerializer` builds a fresh
 * one and converts each nested error-like property into a fresh one of its own.
 * A `cause` is the exception — it is not copied as a field at all, its message
 * and stack are folded into the serialized `message` and `stack`, and both of
 * those are on `REDACTED_ERROR_FIELDS`.
 *
 * **This function is called with two different kinds of argument, and one line
 * of it exists for the second.** `nestjs-pino`'s root logger — the one
 * `app.useLogger` installs and therefore the one `AllExceptionsFilter` writes
 * through — hands a serializer the **raw `Error`**, so the `stdSerializers.err`
 * call is what puts `type`, `message` and `stack` in the line at all; without it
 * only the error's own *enumerable* properties survive, and V8 makes `message`
 * and `stack` non-enumerable. `pino-http`, which logs the request line, instead
 * pre-wraps whatever `err` serializer it is given in `pino-std-serializers`'
 * `wrapErrorSerializer` — literally `custom(errSerializer(err))`
 * (`pino-http/logger.js:35`) — so on *that* path the argument is an
 * already-serialized object and this runs `errSerializer` over its own output.
 * That second pass is not harmless: `errSerializer` reads `type` off
 * `err.constructor.name`, and its output is a `pinoErrProto` object whose
 * constructor is `Object`, so every error logged on the request path came out as
 * `"type":"Object"` — `ExecError` included, which is the word a reader greps the
 * journal for. Hence the two lines below: serialize unconditionally, because the
 * important path needs it, and put back the `type` the redundant pass on the
 * other path destroys. Both are measured and both are pinned by
 * `logger.config.spec.ts`, which drives the serializer once per path.
 *
 * A discriminator (`error instanceof Error`) was rejected in favour of
 * repairing the one damaged field: `instanceof` is exactly the check
 * `RemoteExecService` documents as unreliable here, because a `child_process`
 * error comes from another realm and fails it, and getting that test wrong
 * silently drops `message` and `stack` from the journal rather than failing
 * loudly.
 *
 * **This is the second layer, not the fix.** The fix is in `ExecError`'s
 * constructor, and it has to be: the same strings reach a deployment log, an
 * HTTP message and a WebSocket close reason, none of which come through here.
 * What this catches is the error that is *not* an `ExecError` and carries a
 * payload anyway. No site in `src/` builds one today —
 * `DockerOpsService.uploadFileToContainer` rewraps a failure into a plain
 * `Error`, but what it rewraps is an `ExecError`'s `message`, which is already
 * elided, so that one is clean by inheritance rather than by this layer. Which
 * is precisely why this layer needs a unit test and cannot have an end-to-end
 * one: before the unit test it would have survived its own deletion.
 *
 * **The one field it cannot reach is `msg`.** `pino`'s `write` copies `msg` from
 * the raw error's `message` before `asJson` consults any serializer
 * (`pino/lib/proto.js:218`), measured and pinned. So on this layer alone a
 * payload would survive in `msg` — which is the strongest single argument for
 * eliding at construction, where `message` itself is already clean by the time
 * pino sees it.
 */
const elidingErrorSerializer = (error: Error): Record<string, unknown> => {
  const serialized = stdSerializers.err(error) as unknown as Record<
    string,
    unknown
  >;
  const alreadySerialized = (error as unknown as Record<string, unknown>).type;
  if (typeof alreadySerialized === 'string') {
    serialized.type = alreadySerialized;
  }
  return elidePayloadsInError(serialized);
};

export const loggerConfig: Params = {
  pinoHttp: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: redactedHeaderPaths,
    // `err` only. pino-http forces its own `req`/`res` serializers over
    // whatever this object holds, so naming those here would be a no-op that
    // reads like a policy.
    serializers: { err: elidingErrorSerializer },
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true } },
  },
};
