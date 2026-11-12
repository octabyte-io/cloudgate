import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What the one CLI e2e suite needs to run the built `cloudgate` against the
 * harness backend (Testing Decisions). Every later CLI ticket adds
 * its walk to `cli.e2e-spec.ts` and reaches for these, rather than adding a
 * suite.
 */

const CLI_DIR = join(__dirname, '..', '..', '..', 'cli');
const CLI_BIN = join(CLI_DIR, 'bin', 'cloudgate.js');

/**
 * Bundles the CLI exactly as it is published (`cli/build.mjs`), so the suite
 * runs what npm would ship rather than the TypeScript. About a second with
 * esbuild, and done here rather than by the workflow so running this one file
 * alone, as `docs/testing.md` asks, needs nothing first.
 */
export function buildCli(): void {
  execFileSync(process.execPath, ['build.mjs'], {
    cwd: CLI_DIR,
    stdio: 'pipe',
  });
}

/**
 * A stand-in for the console in front of the harness backend.
 *
 * The CLI takes the **console's** address as the Instance and reaches REST at
 * `<instance>/backend/*` (`instanceEndpoints` in `cli/src/instance.ts`), which
 * is the rewrite `frontend/next.config.ts` makes. The harness serves Nest at
 * its root, so this forwards `/backend/*` there with the prefix stripped, as
 * that rewrite does — and answers anything else 404, as a console page would
 * not be JSON. So the suite drives the CLI with the address a person types,
 * and the CLI needs no test-only flag to find the API.
 */
export async function startConsoleStandIn(
  apiPort: number,
  options: { tls?: TestCertificate } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '/';
    if (!path.startsWith('/backend/')) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html>console page</html>');
      return;
    }
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: apiPort,
        method: req.method,
        path: path.slice('/backend'.length),
        headers: req.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  };
  const server: Server = options.tls
    ? createHttpsServer(
        { key: options.tls.key, cert: options.tls.cert },
        handler,
      )
    : createServer(handler);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * A port nothing listens on right now, for a backend whose own address has to
 * be in its config before it boots (`CLOUDGATE_API_URL`, which the public
 * answer advertises). Taken by listening on 0 and closing again.
 */
export async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) =>
    probe.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** A self-signed certificate for 127.0.0.1 and localhost, and the file it is in. */
export interface TestCertificate {
  key: Buffer;
  cert: Buffer;
  /** The certificate's file, for the CLI's `NODE_EXTRA_CA_CERTS`. */
  certFile: string;
}

/**
 * Mints a one-day certificate with `openssl` into `folder`, so a stand-in can
 * serve https:// and the CLI's own rule (an address without a scheme gets
 * `https://`) can be walked against it. The CLI trusts it through Node's
 * `NODE_EXTRA_CA_CERTS`, which is how a person trusts a private CA too.
 */
export function testCertificate(folder: string): TestCertificate {
  const keyFile = join(folder, 'key.pem');
  const certFile = join(folder, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { stdio: 'pipe' },
  );
  return {
    key: readFileSync(keyFile),
    cert: readFileSync(certFile),
    certFile,
  };
}

/** A request a {@link startOtherSite} received, as far as a walk cares. */
export interface ReceivedRequest {
  path: string;
  /** The `x-api-key` it carried, if any. */
  apiKey?: string;
}

/**
 * Something at an address that is not the harness Instance — someone else's
 * site, or a Cloudgate of another version — answering every request with
 * `answer`, and keeping what it was sent. A walk reads `received` to prove
 * what such a site would have seen, which is the point of the check: a key
 * never reaches it.
 */
export async function startOtherSite(
  answer: (path: string) => { status: number; type: string; body: string },
): Promise<{
  url: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
}> {
  const received: ReceivedRequest[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    const apiKey = req.headers['x-api-key'];
    received.push({
      path,
      ...(typeof apiKey === 'string' ? { apiKey } : {}),
    });
    const { status, type, body } = answer(path);
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A fresh, empty folder, removed with {@link removeFolder}. */
export function emptyFolder(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cloudgate-cli-${prefix}-`));
}

export function removeFolder(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** Every entry under `path`, recursively — what a run wrote there. */
export function filesUnder(path: string): string[] {
  return readdirSync(path, { recursive: true }) as string[];
}

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the built `cloudgate` the way CI does: stdin, stdout and stderr are
 * pipes, so it is not in a terminal. The environment is only what is passed
 * plus `PATH` — never the developer's own `CLOUDGATE_*`, `CI` or `NO_COLOR` —
 * and the config folder, `HOME` and `XDG_CONFIG_HOME` all point at `home`, so a
 * walk can prove what was (not) written there.
 */
export function runCli(
  args: string[],
  options: {
    home: string;
    cwd?: string;
    env?: Record<string, string>;
    /** What is piped into stdin; nothing, by default. */
    stdin?: string;
  },
): Promise<CliRun> {
  return startCli(args, options).done;
}

/** The config folder {@link runCli} points the CLI at, under `home`. */
export function configFolderOf(home: string): string {
  return join(home, 'cloudgate-config');
}

/** A {@link startCli} run still going: what it has printed so far, and its end. */
export interface RunningCli {
  /** Resolves with the first match of `pattern` in stderr, once printed. */
  stderrMatch(pattern: RegExp): Promise<RegExpMatchArray>;
  /** The same, in stdout (a followed log's lines). */
  stdoutMatch(pattern: RegExp): Promise<RegExpMatchArray>;
  /** Ctrl-C, as a terminal sends it: SIGINT to the process. */
  interrupt(): void;
  done: Promise<CliRun>;
}

/**
 * {@link runCli} without waiting for the end, for a walk that has to act while
 * the CLI runs — approving the code `cloudgate login` printed.
 *
 * `CLOUDGATE_NO_KEYCHAIN` is always set: a walk must never write into the
 * developer's own keychain, so a saved key goes to `credentials.json` in
 * `home`, where the walk can see it.
 */
export function startCli(
  args: string[],
  options: {
    home: string;
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
  },
): RunningCli {
  const child = spawn(process.execPath, [CLI_BIN, ...args], {
    cwd: options.cwd ?? options.home,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: options.home,
      XDG_CONFIG_HOME: join(options.home, '.config'),
      CLOUDGATE_CONFIG_DIR: configFolderOf(options.home),
      CLOUDGATE_NO_UPDATE_NOTIFIER: '1',
      CLOUDGATE_NO_KEYCHAIN: '1',
      ...options.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const waiting: Array<() => void> = [];
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    for (const check of [...waiting]) check();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    for (const check of [...waiting]) check();
  });
  child.stdin.end(options.stdin ?? '');
  let ended = false;
  const done = new Promise<CliRun>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      ended = true;
      resolve({ code, stdout, stderr });
      for (const check of [...waiting]) check();
    });
  });
  const match =
    (stream: 'stdout' | 'stderr') =>
    (pattern: RegExp): Promise<RegExpMatchArray> =>
      new Promise((resolve, reject) => {
        const check = () => {
          const printed = stream === 'stdout' ? stdout : stderr;
          const found = printed.match(pattern);
          if (found) {
            waiting.splice(waiting.indexOf(check), 1);
            resolve(found);
          } else if (ended) {
            waiting.splice(waiting.indexOf(check), 1);
            reject(
              new Error(
                `the CLI ended without printing ${pattern} on ${stream}:\n${printed}\n${stderr}`,
              ),
            );
          }
        };
        waiting.push(check);
        check();
      });
  return {
    done,
    stderrMatch: match('stderr'),
    stdoutMatch: match('stdout'),
    interrupt: () => child.kill('SIGINT'),
  };
}
