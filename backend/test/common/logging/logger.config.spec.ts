import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import pino from 'pino';
import pinoHttp from 'pino-http';
import type { Options } from 'pino-http';

import { loggerConfig } from '../../../src/common/logging/logger.config';

/**
 * The credentials that used to reach the journal. Each is distinctive
 * enough that a substring search over the whole written line is a real
 * assertion — if any fragment of key or token material survives serialization
 * anywhere in the line, `toContain` finds it.
 */
const apiKey = 'cgk_live_2f9d41c7e8b04a6f';
const sessionCookie = 'cloudgate.session_token=stk_7b1e05a3c64d29f8';
const authorization = 'Bearer jwt_5c8a2e71d0b34f96';
const responseSetCookie =
  'cloudgate.session_token=stk_e4a90d2b1f6c8375; Path=/; HttpOnly';
const userAgent = 'cloudgate-cli/1.0';

type LoggedHeaders = Record<string, unknown>;

interface LoggedRequest {
  raw: string;
  reqHeaders: LoggedHeaders;
  resHeaders: LoggedHeaders;
}

/**
 * Drives the real pino-http with the real `loggerConfig` over a real HTTP
 * round-trip, and captures what was written. A hand-built fake req/res was
 * rejected: the whole question is what pino-http's *default* serializer does
 * with a genuine `IncomingMessage`, and a fake would have encoded the answer
 * being tested.
 */
async function logOneRequest(): Promise<LoggedRequest> {
  const written: string[] = [];
  let lineWritten!: () => void;
  const firstLine = new Promise<void>((resolve) => {
    lineWritten = resolve;
  });
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      written.push(String(chunk));
      lineWritten();
      callback();
    },
  });

  // Two overrides, and only these two. The dev-console transport goes because
  // pino refuses a transport and a destination stream together and pino-pretty
  // writes from a worker thread this test cannot read; the level is pinned so a
  // LOG_LEVEL in the environment cannot silence the line under test. Everything
  // else — the redact declaration this spec exists for — is the shipped
  // configuration verbatim.
  const shipped = loggerConfig.pinoHttp as Options;
  const httpLogger = pinoHttp(
    { ...shipped, transport: undefined, level: 'info' },
    sink,
  );

  const server = http.createServer((req, res) => {
    httpLogger(req, res);
    res.setHeader('set-cookie', responseSetCookie);
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await new Promise<void>((resolve, reject) => {
      const request = http.get(
        {
          host: '127.0.0.1',
          port,
          path: '/api/applications',
          headers: {
            'x-api-key': apiKey,
            cookie: sessionCookie,
            authorization,
            'user-agent': userAgent,
          },
        },
        (response) => {
          response.resume();
          response.on('end', resolve);
        },
      );
      request.on('error', reject);
    });
    await firstLine;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const raw = written.join('');
  const entry = JSON.parse(raw) as {
    req: { headers: LoggedHeaders };
    res: { headers: LoggedHeaders };
  };
  return { raw, reqHeaders: entry.req.headers, resHeaders: entry.res.headers };
}

describe('loggerConfig', () => {
  let logged: LoggedRequest;

  beforeAll(async () => {
    logged = await logOneRequest();
  });

  it('redacts the API key header of a request that carried one', () => {
    expect(logged.raw).not.toContain(apiKey);
    expect(logged.reqHeaders['x-api-key']).not.toBe(apiKey);
  });

  it('keeps the API key header itself visible, so a reader still sees that a credential was sent', () => {
    expect(Object.keys(logged.reqHeaders)).toContain('x-api-key');
  });

  it('redacts the cookie header of a request that carried a session token', () => {
    expect(logged.raw).not.toContain('stk_7b1e05a3c64d29f8');
    expect(logged.reqHeaders.cookie).not.toBe(sessionCookie);
    expect(Object.keys(logged.reqHeaders)).toContain('cookie');
  });

  it('redacts the authorization header of a request that carried a bearer token', () => {
    expect(logged.raw).not.toContain('jwt_5c8a2e71d0b34f96');
    expect(logged.reqHeaders.authorization).not.toBe(authorization);
    expect(Object.keys(logged.reqHeaders)).toContain('authorization');
  });

  it('redacts the set-cookie header of a response that set a session token', () => {
    expect(logged.raw).not.toContain('stk_e4a90d2b1f6c8375');
    expect(logged.resHeaders['set-cookie']).not.toBe(responseSetCookie);
    expect(Object.keys(logged.resHeaders)).toContain('set-cookie');
  });

  // The redaction is narrow on purpose: the rest of the header set is what
  // makes a request line worth reading at all.
  it('still logs the headers that carry no credential', () => {
    expect(logged.reqHeaders['user-agent']).toBe(userAgent);
    expect(logged.raw).toContain(userAgent);
  });
});

/**
 * The `err` serializer, driven by the case it exists for.
 *
 * An earlier fix put the real fix in `ExecError`'s constructor and this declaration under
 * it as a backstop, and nothing tested the declaration: every journal test in
 * the tree drives an `ExecError`, whose strings are already elided before pino
 * sees them, so deleting `serializers: { err: elidingErrorSerializer }` from
 * `logger.config.ts` failed no test in the repo. The line would have survived
 * its own deletion, which for a defence-in-depth layer is the same as not
 * having it.
 *
 * So what is logged here is an error that is **not** an `ExecError` and carries
 * a payload anyway — a plain `Error` whose message and `command` were built from
 * a command string that never went through the constructor. pino's *default*
 * `err` serializer writes the message and every own property verbatim, so
 * without the declaration each line below carries the payload twice.
 *
 * **Both of the shipped logger's paths are driven, because the serializer is
 * handed a different kind of argument on each.** `nestjs-pino`'s root logger —
 * `app.useLogger`'s, the one `AllExceptionsFilter` writes through — passes the
 * raw `Error`; `pino-http`'s request logger pre-wraps any `err` serializer in
 * `pino-std-serializers`' `wrapErrorSerializer` and so passes an
 * already-serialized object. A serializer that is right on one and wrong on the
 * other loses either `message` and `stack` (on the first) or the error's `type`
 * (on the second), and one path being green said nothing about the other:
 * `test/remote/exec-error-payloads.spec.ts` drives only the first.
 */
describe("loggerConfig's error serializer", () => {
  const secret = 'STRIPE_SECRET_KEY=sk_live_91b3d0c6f2a84e57';
  const encoded = Buffer.from(secret, 'utf-8').toString('base64');
  const command = `mkdir -p "/srv/files";\necho "${encoded}" | base64 -d > "/srv/files/.env";\n`;

  const capture = (): { written: string[]; sink: Writable } => {
    const written: string[] = [];
    return {
      written,
      sink: new Writable({
        write(chunk, _encoding, callback) {
          written.push(String(chunk));
          callback();
        },
      }),
    };
  };

  // The same two overrides as `logOneRequest`, for the same two reasons; the
  // `serializers` declaration under test is the shipped configuration.
  const shippedOptions = (): Options => ({
    ...(loggerConfig.pinoHttp as Options),
    transport: undefined,
    level: 'error',
  });

  /** The request logger's path: `pino-http` builds it, so the serializer is wrapped. */
  const logThroughPinoHttp = (error: Error): string => {
    const { written, sink } = capture();
    pinoHttp(shippedOptions(), sink).logger.error(
      { err: error },
      'Failed to materialize file',
    );
    return written.join('');
  };

  /** The root logger's path: `nestjs-pino` builds this one, unwrapped. */
  const logThroughRootLogger = (error: Error): string => {
    const { written, sink } = capture();
    pino(shippedOptions() as pino.LoggerOptions, sink).error(
      { err: error },
      'Failed to materialize file',
    );
    return written.join('');
  };

  const paths = [
    [
      'the request logger, whose serializer pino-http wraps',
      logThroughPinoHttp,
    ],
    ['the root logger, which hands over the raw error', logThroughRootLogger],
  ] as const;

  /** Every base64-alphabet run in the line, decoded — the reader's own check. */
  const expectNoDecodablePayload = (line: string): void => {
    expect(line).not.toContain(secret);
    expect(line).not.toContain(encoded);
    for (const match of line.matchAll(/[A-Za-z0-9+/]{8,}={0,2}/g)) {
      expect(Buffer.from(match[0], 'base64').toString('utf8')).not.toContain(
        secret,
      );
    }
  };

  it.each(paths)(
    'elides the payload of an error that never passed through ExecError — %s',
    (_name, logError) => {
      const line = logError(
        Object.assign(new Error(`Command failed: ${command}`), { command }),
      );

      expectNoDecodablePayload(line);
      // And the diagnosis survives, which is the whole reason this is an
      // elision rather than a redaction of the field.
      const entry = JSON.parse(line) as { err: Record<string, string> };
      expect(entry.err.command).toContain('base64 -d > "/srv/files/.env"');
      expect(entry.err.command).toContain('mkdir -p "/srv/files"');
      expect(entry.err.message).toContain('Command failed');
      expect(entry.err.stack).toContain('Error: Command failed');
      // The class, which is what a reader greps for. Re-serializing an
      // already-serialized error reads this off `Object`, which is the defect
      // this arm caught on the wrapped path.
      expect(entry.err.type).toBe('Error');
    },
  );

  it.each(paths)(
    'elides the payload one level down, where pino folds in a cause — %s',
    (_name, logError) => {
      const line = logError(
        Object.assign(new Error('Failed to upload file to container'), {
          cause: Object.assign(new Error(`Command failed: ${command}`), {
            cmd: command,
          }),
        }),
      );

      expectNoDecodablePayload(line);
    },
  );

  /**
   * The field the serializer cannot reach, asserted rather than described: pino
   * copies `msg` from the raw error's `message` before consulting any
   * serializer, so a payload survives there on this layer alone. That is the
   * strongest single argument for eliding at `ExecError`'s constructor, where
   * `message` is already clean by the time pino sees it — and it is only
   * reachable at all by logging the error as the whole first argument, which is
   * exactly what `AllExceptionsFilter` does.
   *
   * Asserted as a *known limit* rather than left in prose: if a later pino sends
   * `msg` through the serializer too, this fails and the paragraph above it in
   * `logger.config.ts` is the thing to delete.
   */
  it('cannot reach `msg`, which is why the constructor is the fix and this is the backstop', () => {
    const { written, sink } = capture();
    pinoHttp(shippedOptions(), sink).logger.error(
      Object.assign(new Error(`Command failed: ${command}`), { command }),
    );

    const entry = JSON.parse(written.join('')) as {
      msg: string;
      err?: Record<string, string>;
    };
    expect(entry.msg).toContain(encoded);
    // The serialized error beside it is elided all the same.
    expect(entry.err?.command).not.toContain(encoded);
  });
});
