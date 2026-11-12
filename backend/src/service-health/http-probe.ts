import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { performance } from 'node:perf_hooks';

/** What one Probe found: up or down, and never a third state. */
export interface ProbeOutcome {
  verdict: 'up' | 'down';
  /** Until the status line arrived; null when nothing did. */
  latencyMs: number | null;
  /** Null on an up Probe; a short class on a down one (see {@link classifyProbeError}). */
  errorClass: string | null;
}

/** What an HTTP Probe is judged against, and the one header it sends. */
export interface HttpProbeOptions {
  timeoutMs: number;
  /** `2xx`-style classes and exact codes (`301`). */
  expectedStatuses: readonly string[];
  /** A string the body must contain; none reads no body at all. */
  keyword?: string | null;
  /** The check's one header, sent after the defaults so it wins. */
  header?: { name: string; value: string } | null;
  /**
   * The address to connect to instead of resolving the URL's host: the one
   * `OutboundAddressGuard` checked, so the Probe dials what was checked and
   * makes no lookup of its own. The URL still names the Domain, so the
   * `Host` header, SNI and the certificate check are against it.
   */
  address?: string;
}

/**
 * How much of a body a keyword is looked for in: the first 256 KiB. A
 * health page is far smaller; a keyword past this is missing, and the bound is
 * what keeps a Probe of a large download from buffering it.
 */
export const KEYWORD_READ_LIMIT_BYTES = 256 * 1024;

/** A body that ended, or reached the limit, without the keyword. */
export const KEYWORD_MISSING = 'keyword missing';

/**
 * Whether `status` is one the check expects: a class (`2xx`) matches its whole
 * hundred, an exact code matches itself. `2xx` is the default a check is
 * created with, so a redirect or a 401 is down unless an operator said
 * otherwise.
 */
export function statusIsExpected(
  status: number,
  expected: readonly string[],
): boolean {
  return expected.some((entry) =>
    /^[1-5]xx$/.test(entry)
      ? Math.floor(status / 100) === Number(entry[0])
      : Number(entry) === status,
  );
}

/** Error codes that name each class, as Node's `net`, `dns` and `tls` spell them. */
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT']);

/**
 * The short class a failed request is recorded as: `dns`, `refused`,
 * `timeout`, `tls` or, for anything else that ended the connection (a reset,
 * an unreachable network), `connection`. Every one of them is down.
 *
 * Read by shape, not `instanceof Error`: an error raised inside Node's own
 * realm is not an instance of the `Error` a jest sandbox gives this module.
 */
export function classifyProbeError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return 'connection';
  if (DNS_CODES.has(code)) return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (TIMEOUT_CODES.has(code)) return 'timeout';
  if (
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_') ||
    code.includes('CERT') ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  ) {
    return 'tls';
  }
  return 'connection';
}

/**
 * A `lookup` that answers every name with `address`. Both shapes of the
 * callback, because Node asks for `all` when it races the address families.
 */
function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
}

/**
 * One HTTP Probe: a `GET` of `url`, judged on its status line — and, when the
 * check requires a keyword, on whether the body contains it.
 *
 * - **The timeout covers the whole wait**, from the connect to the status
 *   line (and through the body when a keyword is looked for), so a server that
 *   accepts and then hangs is down with `timeout` rather than holding the
 *   Probe open.
 * - **The body is read only for a keyword, and never kept.** Without one the
 *   response is destroyed as soon as its status is known. With one, at most
 *   {@link KEYWORD_READ_LIMIT_BYTES} are searched and the response destroyed
 *   at the first match; either way the outcome carries a verdict and an error
 *   class and never a byte of the body, so nothing an app returns is stored or
 *   announced. A status the check does not expect is down with
 *   that status before any body is read.
 * - **No redirect is followed**: a `301` is a status like any other, which is
 *   why an operator can list it as expected.
 * - **No keep-alive**, so one check's socket is never another Probe's.
 * - Latency is until the status line either way, so a keyword does not change
 *   what the number means.
 *
 * Node's own `http`/`https` rather than `fetch`: the Probe must not share
 * `FETCH_CLIENT`, which is the notification channels' transport and what a
 * suite replaces to catch a Slack webhook.
 */
export function probeHttp(
  url: URL,
  options: HttpProbeOptions,
): Promise<ProbeOutcome> {
  const started = performance.now();
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(outcome);
    };

    const request = transport.request(
      url,
      {
        method: 'GET',
        agent: false,
        ...(options.address && { lookup: pinnedLookup(options.address) }),
        headers: {
          'user-agent': 'Cloudgate-Uptime-Check',
          accept: '*/*',
          ...(options.header && {
            [options.header.name]: options.header.value,
          }),
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const latencyMs = Math.round(performance.now() - started);
        if (!statusIsExpected(status, options.expectedStatuses)) {
          response.destroy();
          finish({
            verdict: 'down',
            latencyMs,
            errorClass: `status ${status}`,
          });
          return;
        }
        if (!options.keyword) {
          response.destroy();
          finish({ verdict: 'up', latencyMs, errorClass: null });
          return;
        }
        const keyword = Buffer.from(options.keyword, 'utf8');
        const missing = () =>
          finish({ verdict: 'down', latencyMs, errorClass: KEYWORD_MISSING });
        let body = Buffer.alloc(0);
        response.on('data', (chunk: Buffer) => {
          // Searched from just before the new bytes, so a keyword split
          // across two chunks is found and nothing is searched twice.
          const from = Math.max(0, body.length - keyword.length + 1);
          body = Buffer.concat([body, chunk]).subarray(
            0,
            KEYWORD_READ_LIMIT_BYTES,
          );
          if (body.indexOf(keyword, from) !== -1) {
            finish({ verdict: 'up', latencyMs, errorClass: null });
          } else if (body.length >= KEYWORD_READ_LIMIT_BYTES) {
            missing();
          }
        });
        response.on('end', missing);
        response.on('error', (error) =>
          finish({
            verdict: 'down',
            latencyMs,
            errorClass: classifyProbeError(error),
          }),
        );
      },
    );
    const timer = setTimeout(
      () => finish({ verdict: 'down', latencyMs: null, errorClass: 'timeout' }),
      options.timeoutMs,
    );
    request.on('error', (error) =>
      finish({
        verdict: 'down',
        latencyMs: null,
        errorClass: classifyProbeError(error),
      }),
    );
    request.end();
  });
}
