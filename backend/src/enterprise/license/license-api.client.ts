import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { FETCH_CLIENT } from '../../git-providers/fetch.provider';
import type { FetchClient } from '../../git-providers/fetch.provider';
import type { LicenseActivation, LicenseApi } from './license-api';

const LICENSE_SERVER_UNREACHABLE =
  'Could not reach the license server. Check your connection or try again later.';

/**
 * How many bytes of a body we could not read reach the log.
 *
 * Enough to tell an nginx error page from a Cloudflare challenge from a captive
 * portal's login form — which is the whole diagnostic question — and short
 * enough that a retry loop does not fill a journal with HTML.
 */
const BODY_LOG_LIMIT = 200;

function isNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    // undici wraps every transport failure in `TypeError: fetch failed` and
    // hangs the real reason off `cause`, so this message is what catches most
    // of them; the codes below are the ones that also arrive bare.
    if (error.message === 'fetch failed') return true;
    const cause = (error as Error & { cause?: { code?: string } }).cause;
    const code = cause?.code;
    return (
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'ETIMEDOUT' ||
      code === 'EAI_AGAIN' ||
      code === 'ECONNRESET' ||
      code === 'EHOSTUNREACH' ||
      code === 'ENETUNREACH'
    );
  }
  return false;
}

/**
 * A JSON object, or null when the body is not one.
 *
 * Null is the interesting answer: an nginx 404 page, a gateway's error HTML, a
 * captive portal's login form and an empty body all land here, and none of them
 * is the license server deciding anything about a key.
 */
function asJsonObject(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The `message` the license server sends with a refusal; '' when it sends none. */
function refusalMessage(data: Record<string, unknown> | null): string {
  const message = data?.message;
  return typeof message === 'string' ? message.trim() : '';
}

/** The first bytes of a body, on one line, for the log. */
function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '<empty body>';
  return oneLine.length > BODY_LOG_LIMIT
    ? `${oneLine.slice(0, BODY_LOG_LIMIT)}…`
    : oneLine;
}

/** The license server considered the key and said no, in its own words. */
function refusedSentence(message: string): string {
  return `The license server refused this license key: ${message}`;
}

/**
 * The license server was reached and answered something that is not a decision
 * about the key.
 */
function serverErrorSentence(status: number, detail: string): string {
  return (
    `The license server answered HTTP ${status}, which is not a decision about ` +
    `this key${detail ? ` (${detail})` : ''}. As far as Cloudgate can tell there ` +
    `is nothing wrong with the key — try again later, and check the backend log ` +
    `for what the server sent.`
  );
}

/** A 2xx whose body is not the JSON the caller has to read. */
function unreadableAnswerSentence(status: number): string {
  return (
    `The license server answered HTTP ${status} with a body Cloudgate could not ` +
    `read, so this key's state is unknown. Try again later, and check the ` +
    `backend log for what the server sent.`
  );
}

/**
 * The three `POST /licenses/{activate,validate,deactivate}` calls, each sending
 * `{ licenseKey, ip }`.
 *
 * ## A failure is one of three things, and they were one sentence
 *
 * Every HTTP-level failure used to collapse into `` `Failed to ${action}
 * license key` ``, which an operator reads as "my key is wrong".
 * On the build that filed it, that sentence is what a *correct* key got: the
 * activation path answered **404** from nginx with an HTML body, `result.json()`
 * could not parse it, and the fallback was all that was left. A path-level 404, a
 * 502, a gateway error page and a captive portal were all reported as a refused key,
 * and the status reached neither the screen nor the log.
 *
 * So a failure now names its class, because the operator's next move differs for
 * each:
 *
 * | Class | What it is | Next move |
 * |---|---|---|
 * | refused | a JSON body carrying a `message` — the server decided | check the key |
 * | server error | any other non-ok answer, named with its status | retry, contact support |
 * | unreachable | the request never landed (`isNetworkError`) | check the network |
 *
 * **The discriminator is the body, not the status**, and that is deliberate. The
 * license server's refusals are JSON with a `message`; nothing that cannot
 * produce one has considered the key at all. Keying off the status family
 * instead would call the ticket's own 404 a refused key, which is the defect.
 * A 5xx that *does* carry a message stays in the server-error class and quotes
 * the message after the status — a fault report is not a decision.
 *
 * ## The body is read as text first
 *
 * `result.json()` was both the parse and the only look at the body, so an
 * unparseable one left nothing to log. It is read with `text()` once instead,
 * and every failure path logs the status and `snippet()` of what came back —
 * which is what makes this diagnosable from `journalctl` without a packet
 * capture.
 *
 * ## The ip
 *
 * The instance's address as recorded in web-server settings, which is where the
 * ai module reads it from too — no extra dependency and no third-party lookup on
 * the activation path.
 *
 * ## Which server
 *
 * `LICENSE_SERVER_URL`, read per call through `ConfigService` rather than as a
 * module constant — §2.8's trap, since a constant computed at import time would
 * miss a `.env` entry. It was the literal `https://licenses-api.cloudgate.dev`
 * with no override at first, which left an operator running their own license
 * service with nowhere to point it, and left a license server's nginx 404 with no
 * workaround. The key defaults to that same literal, so a hosted install is
 * unaffected.
 */
@Injectable()
export class LicenseApiClient implements LicenseApi {
  private readonly logger = new Logger(LicenseApiClient.name);

  constructor(
    @Inject(FETCH_CLIENT) private readonly fetchClient: FetchClient,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly config: ConfigService,
  ) {}

  async activate(licenseKey: string): Promise<LicenseActivation> {
    return (await this.post('activate', licenseKey)) as LicenseActivation;
  }

  async validate(licenseKey: string): Promise<boolean> {
    const data = (await this.post('validate', licenseKey)) as {
      valid?: boolean;
    };
    return !!data.valid;
  }

  async deactivate(licenseKey: string): Promise<void> {
    await this.post('deactivate', licenseKey);
  }

  /**
   * One call, and a rejection whose message names which of the three classes
   * happened. See the class docblock for why there are three.
   *
   * The send and the answer are two try blocks rather than one: only a failure
   * of the *send* can be a transport failure, and wrapping the answer in the
   * same `catch` is how a JSON parse error used to be inspected by
   * `isNetworkError` and then rethrown verbatim.
   */
  private async post(
    action: 'activate' | 'validate' | 'deactivate',
    licenseKey: string,
  ): Promise<unknown> {
    const url = `${this.config.getOrThrow<string>('LICENSE_SERVER_URL')}/licenses/${action}`;
    let result: Response;

    try {
      const ip = await this.serverIp();
      result = await this.fetchClient(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey, ip }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`POST ${url} did not complete: ${detail}`);
      if (isNetworkError(error)) {
        throw new Error(LICENSE_SERVER_UNREACHABLE);
      }
      throw error;
    }

    // Once, and as text: a body can only be consumed one way, and the raw text
    // is what an unparseable answer leaves to log.
    const text = await result.text().catch(() => '');
    const data = asJsonObject(text);

    if (!result.ok) {
      const message = refusalMessage(data);
      const refused = !!message && result.status < 500;
      this.logger.error(
        `POST ${url} answered ${result.status}, read as ` +
          `${refused ? 'a refusal' : 'a license-server error'}: ${snippet(text)}`,
      );
      throw new Error(
        refused
          ? refusedSentence(message)
          : serverErrorSentence(result.status, message),
      );
    }

    if (data === null) {
      this.logger.error(
        `POST ${url} answered ${result.status} with a body that is not JSON: ${snippet(text)}`,
      );
      throw new Error(unreadableAnswerSentence(result.status));
    }

    return data;
  }

  /** The web-server settings' `serverIp`; null when nothing is configured. */
  private async serverIp(): Promise<string | null> {
    const settings = await this.db.query.webServerSettings.findFirst({
      columns: { serverIp: true },
    });
    return settings?.serverIp || null;
  }
}
