import { request as httpRequest } from 'node:http';
import type {
  IncomingHttpHeaders,
  OutgoingHttpHeaders,
  RequestOptions,
} from 'node:http';
import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from 'node:zlib';
import type { Request, Response } from 'express';
import { RemoteExecService } from '../remote/remote-exec.service';
import { SshForwardService } from '../remote/ssh-forward.service';
import type { ForwardedConnection } from '../remote/ssh-forward.service';
import {
  basicAuthorization,
  parseTraceStoreUiAddress,
  TRACE_QUERY_USER,
  traceStoreUiAddress,
  traceStoreUiAddressCommand,
} from './trace-store';
import type { TraceStoreOwner, TraceStoreUiAddress } from './trace-store';
import {
  inlineScriptHashes,
  traceStoreContentSecurityPolicy,
} from './trace-store-csp';

/**
 * How one proxied request reaches a store: the `http.request` options that
 * dial it, and what to close once the request is over. On the platform host
 * that is a loopback host and port and nothing to close; on a remote Server it
 * is an SSH `forwardOut` channel as a `createConnection`, and the
 * channel and its connection to end.
 */
export interface TraceStoreConnection {
  options: Pick<RequestOptions, 'host' | 'port' | 'createConnection'>;
  close(): void;
}

/** Why a remote store could not be reached, as the 502 says it. */
export const REMOTE_TRACE_STORE_UNREACHABLE =
  "The Trace store's Server could not be reached over SSH";

/**
 * Why a store was not reached, as the 502 says it: its UI port was published
 * somewhere other than loopback, or the store did not answer. Generic on
 * purpose: the detail names the addresses the port is on, which is the
 * operator's to read in the log and not every entitled Member's
 * (CODING_STANDARDS §2.5).
 */
export const TRACE_STORE_UNREACHABLE = 'The Trace store could not be reached';

/**
 * The one way the backend opens a connection to a Trace store's UI port
 * (ADR-0028). The store publishes that port on its Server's
 * **loopback only**, on an ephemeral port read with `docker port` for each
 * request — a restart can move it — so nothing is on any Server's edge.
 *
 * - **Platform host:** the backend, on the same host, reads the port through
 *   `RemoteExecService` and dials `127.0.0.1:<port>`.
 * - **Remote Server:** both the `docker port` read and the `forwardOut`
 *   channel to `127.0.0.1:<port>` as that Server sees it go over the Server's
 *   one pooled SSH connection (`SshForwardService`), so the burst of requests
 *   a UI page makes costs one handshake, not two per request. A Server that
 *   cannot be reached is a 502 whose detail is logged, not answered: it names
 *   a machine and an SSH failure, which is the operator's to read and not
 *   every entitled Member's.
 * - **A port published off loopback** is refused rather than dialled, on
 *   either kind of machine, with a 502 that names no address.
 */
@Injectable()
export class TraceStoreTransport {
  private readonly logger = new Logger(TraceStoreTransport.name);

  constructor(
    private readonly remoteExec: RemoteExecService,
    private readonly forward: SshForwardService,
  ) {}

  /** A connection to the store's UI, or null when the store is not running. */
  async open(
    owner: Pick<TraceStoreOwner, 'serviceType' | 'appName' | 'serverId'>,
  ): Promise<TraceStoreConnection | null> {
    const serverId = owner.serverId;
    if (!serverId) {
      const address = await this.loopback(() =>
        traceStoreUiAddress(this.remoteExec, owner),
      );
      return (
        address && {
          options: { host: address.host, port: address.port },
          close: () => undefined,
        }
      );
    }

    const port = await this.overSsh(owner, () =>
      this.forward.exec(serverId, traceStoreUiAddressCommand(owner)),
    );
    // A store that is absent or stopped: `docker port` fails or prints nothing.
    const address =
      port.code === 0
        ? await this.loopback(() =>
            Promise.resolve(parseTraceStoreUiAddress(owner, port.stdout)),
          )
        : null;
    if (!address) return null;
    const forwarded: ForwardedConnection = await this.overSsh(owner, () =>
      this.forward.open(serverId, address),
    );
    return {
      options: { createConnection: forwarded.createConnection },
      close: forwarded.close,
    };
  }

  /** The store's address, or the address-free 502 for one off loopback. */
  private async loopback(
    read: () => Promise<TraceStoreUiAddress | null>,
  ): Promise<TraceStoreUiAddress | null> {
    try {
      return await read();
    } catch (error) {
      // Published off loopback: refused rather than dialled, and the
      // addresses it is on are logged rather than answered.
      this.logger.warn(error instanceof Error ? error.message : String(error));
      throw new BadGatewayException(TRACE_STORE_UNREACHABLE);
    }
  }

  /** One step over the Server's SSH connection, its failure a 502. */
  private async overSsh<T>(
    owner: Pick<TraceStoreOwner, 'appName' | 'serverId'>,
    step: () => Promise<T>,
  ): Promise<T> {
    try {
      return await step();
    } catch (error) {
      this.logger.warn(
        `Trace store of ${owner.appName} on Server ${owner.serverId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new BadGatewayException(REMOTE_TRACE_STORE_UNREACHABLE);
    }
  }
}

/**
 * Headers that describe one hop and are never forwarded (RFC 9110 §7.6.1),
 * plus what is the console's and not the store's: the session `cookie`, and
 * the caller's own `authorization` and `x-api-key`. The store is sent the
 * backend's credential instead.
 */
const NOT_FORWARDED_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'cookie',
  'authorization',
  'x-api-key',
]);

/**
 * Response headers not passed back: the hop-by-hop ones, a `set-cookie` the
 * store has no business setting on the console's origin, and a
 * `www-authenticate`, which would open the browser's own password prompt for
 * a credential only the backend holds.
 */
const NOT_RETURNED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
  'www-authenticate',
]);

/**
 * The store's own policy, framing and cross-origin headers, not passed back:
 * the proxy sets the policy every answer is served under and the CORS answer
 * the sandboxed frame needs, and the store's would conflict with them or widen
 * them. A `clear-site-data` would act on the console's own origin, and a
 * `service-worker-allowed` would widen a worker's scope there; neither is the
 * store's to send (ADR-0075).
 */
const STORE_POLICY_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'clear-site-data',
  'service-worker-allowed',
]);

const isStoreCorsHeader = (name: string): boolean =>
  name.startsWith('access-control-');

/**
 * Headers a rewritten page is not sent with: its length and encoding change
 * with the rewrite, and its validator names bytes no longer served.
 */
const REWRITTEN_PAGE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'etag',
]);

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `text` with every use of the store's base path moved under the frame's
 * token: the store writes its configured `base_path` into its page's
 * `<base href>` and into redirects, and the UI builds every asset and API URL
 * from that `<base>`, so this is what keeps the token on all of them. Only a
 * whole path is moved, so a longer path that happens to start with it is not.
 */
export function underFrameBase(
  text: string,
  storeBasePath: string,
  frameBasePath: string,
): string {
  return text.replace(
    new RegExp(`${escapeRegExp(storeBasePath)}(?![\\w-])`, 'g'),
    () => frameBasePath,
  );
}

function isHtml(headers: IncomingHttpHeaders): boolean {
  return /^\s*text\/html\b/i.test(headers['content-type'] ?? '');
}

/**
 * A page's text, under the encoding the store sent it with. An encoding the
 * proxy cannot read throws: a page that cannot be moved under the frame's
 * token is refused, not served with URLs that would not carry it.
 */
function decoded(body: Buffer, encoding: string | undefined): string {
  switch ((encoding ?? 'identity').trim().toLowerCase()) {
    case 'identity':
    case '':
      return body.toString('utf8');
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(body).toString('utf8');
    case 'deflate':
      return inflateSync(body).toString('utf8');
    case 'br':
      return brotliDecompressSync(body).toString('utf8');
    case 'zstd':
      return zstdDecompressSync(body).toString('utf8');
    default:
      throw new Error(`unreadable content-encoding: ${encoding}`);
  }
}

/** Also every header a `Connection` header names as this hop's. */
function namedByConnection(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection;
  return new Set(
    (value ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

function forwardedRequestHeaders(
  headers: IncomingHttpHeaders,
  authorization: string,
): OutgoingHttpHeaders {
  const hopOnly = namedByConnection(headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (NOT_FORWARDED_REQUEST_HEADERS.has(name) || hopOnly.has(name)) continue;
    out[name] = value;
  }
  out.authorization = authorization;
  return out;
}

/** How long the store may stay silent on one request before the proxy gives up. */
const STORE_IDLE_TIMEOUT_MS = 60_000;

/**
 * A proxy failure. While nothing has been sent yet it is the Nest exception,
 * which the caller throws and `AllExceptionsFilter` renders in the one error
 * shape (ADR-0005); once the store's answer has started, the response is cut,
 * which is all HTTP allows, and nothing is thrown.
 */
function failure(
  res: Response,
  exception: HttpException,
): HttpException | undefined {
  if (res.headersSent) {
    res.destroy();
    return undefined;
  }
  return exception;
}

export interface ForwardToTraceStore {
  req: Request;
  res: Response;
  connection: TraceStoreConnection;
  /** The path and query the store is asked for, its base path included. */
  path: string;
  queryCredential: string;
  /**
   * The base path the store was configured with, and the frame token's base
   * path the browser is to use instead (`traceStoreFrameBasePath`).
   */
  storeBasePath: string;
  frameBasePath: string;
}

/**
 * Forwards one request to a Trace store and streams its answer back.
 *
 * - **The path is the store's**: the caller passes the base path the store
 *   was configured with (`traceStoreBasePath`) and the rest of the request's
 *   path and query, unchanged.
 * - **The body is intact**: a JSON or form body Nest's parsers have already
 *   read is resent from `req.rawBody`, the exact bytes; any other body is
 *   still unread and is piped.
 * - **The store sees the backend's credential and never the caller's**, and
 *   the browser never sees the store's. A 401 from the store means the
 *   backend's credential was refused, which is the platform's fault and not
 *   the caller's, so it is answered as a 502 rather than passed back as a
 *   sign-in challenge.
 * - **Every answer is served under `traceStoreContentSecurityPolicy`**, whose
 *   `sandbox` puts it in an opaque origin, and `nosniff`, in place of the
 *   store's own policy, framing and CORS headers (ADR-0075). Every answer is
 *   readable from that opaque origin (`access-control-allow-origin: *`, never
 *   with credentials, which the token in the path makes unneeded) and sends no
 *   referrer, which would carry the token.
 * - **A page is moved under the frame's token** (`underFrameBase`), and so is
 *   a redirect into the store's base path: a page is buffered, decoded,
 *   rewritten and sent uncompressed, so the policy can also carry the hashes of
 *   the inline scripts in the head it serves; everything else streams.
 * - An upstream failure before the answer starts rejects with a 502 (a 504
 *   on silence), which the filter renders like any other error; after it has
 *   started, the response is cut, which is all HTTP allows.
 */
export function forwardToTraceStore({
  req,
  res,
  connection,
  path,
  queryCredential,
  storeBasePath,
  frameBasePath,
}: ForwardToTraceStore): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (error?: HttpException) => {
      if (settled) return;
      settled = true;
      connection.close();
      if (error) reject(error);
      else resolve();
    };

    const upstream = httpRequest({
      ...connection.options,
      method: req.method,
      path,
      headers: forwardedRequestHeaders(
        req.headers,
        basicAuthorization(TRACE_QUERY_USER, queryCredential),
      ),
      timeout: STORE_IDLE_TIMEOUT_MS,
    });

    upstream.on('response', (answer) => {
      if (answer.statusCode === 401) {
        answer.resume();
        done(
          failure(
            res,
            new BadGatewayException(
              "The Trace store refused the backend's credential",
            ),
          ),
        );
        return;
      }
      const hopOnly = namedByConnection(answer.headers);
      const page = isHtml(answer.headers);
      res.status(answer.statusCode ?? 502);
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value === undefined) continue;
        if (
          NOT_RETURNED_RESPONSE_HEADERS.has(name) ||
          STORE_POLICY_HEADERS.has(name) ||
          isStoreCorsHeader(name) ||
          hopOnly.has(name) ||
          (page && REWRITTEN_PAGE_HEADERS.has(name))
        ) {
          continue;
        }
        res.setHeader(
          name,
          name === 'location' && typeof value === 'string'
            ? underFrameBase(value, storeBasePath, frameBasePath)
            : value,
        );
      }
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      // The frame is an opaque origin, so its module scripts, fonts and
      // fetches are all cross-origin; the token in the path is their
      // credential, so the answer is readable without one. The global CORS
      // policy's `allow-credentials` is for the console's own origins.
      res.removeHeader('access-control-allow-credentials');
      res.setHeader('access-control-allow-origin', '*');
      answer.on('error', () => {
        res.destroy();
        done();
      });
      if (!page) {
        res.setHeader(
          'content-security-policy',
          traceStoreContentSecurityPolicy([]),
        );
        answer.pipe(res);
        return;
      }
      // A page is read whole, so it can be moved under the token and its
      // inline scripts hashed as served.
      const chunks: Buffer[] = [];
      answer.on('data', (chunk: Buffer) => chunks.push(chunk));
      answer.on('end', () => {
        let html: string;
        try {
          html = underFrameBase(
            decoded(Buffer.concat(chunks), answer.headers['content-encoding']),
            storeBasePath,
            frameBasePath,
          );
        } catch {
          done(
            failure(
              res,
              new BadGatewayException(
                "The Trace store's page could not be read",
              ),
            ),
          );
          return;
        }
        res.setHeader(
          'content-security-policy',
          traceStoreContentSecurityPolicy(inlineScriptHashes(html)),
        );
        // The page names this viewer's token, so no cache keeps it.
        res.setHeader('cache-control', 'no-store');
        res.end(html);
      });
    });
    upstream.on('timeout', () => {
      upstream.destroy(new Error('timeout'));
      done(
        failure(
          res,
          new GatewayTimeoutException('The Trace store did not answer in time'),
        ),
      );
    });
    upstream.on('error', () => {
      done(failure(res, new BadGatewayException(TRACE_STORE_UNREACHABLE)));
    });
    // The caller went away, or the answer is fully written: either way the
    // request to the store is over.
    res.on('close', () => {
      if (!upstream.destroyed) upstream.destroy();
      done();
    });

    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (raw !== undefined) {
      upstream.end(raw);
    } else if (req.readableEnded) {
      upstream.end();
    } else {
      req.pipe(upstream);
    }
  });
}
