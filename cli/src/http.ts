import { CliError, reasonOf } from './errors.js';
import { EXIT } from './exit-codes.js';
import { VERSION } from './version.js';

/** How this CLI names itself to an Instance. */
export const USER_AGENT = `cloudgate/${VERSION} node/${process.versions.node}`;

/**
 * One request to `instance`, or the run's "could not reach" failure (exit 1)
 * when it never landed. A redirect is never followed, so a key never goes
 * wherever one points (`checkInstance`).
 */
export async function reach(
  instance: string,
  fetcher: typeof fetch,
  url: string,
  init: Omit<RequestInit, 'redirect'>,
): Promise<Response> {
  try {
    return await fetcher(url, { ...init, redirect: 'error' });
  } catch (error) {
    throw new CliError(
      `could not reach ${instance}${reasonOf(error)}`,
      EXIT.failed,
    );
  }
}

/** An answer's JSON, or its text when it is not JSON (a proxy's HTML page). */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** An answer that is not the shape this CLI expects, `what` naming the request. */
export function notUnderstood(
  instance: string,
  what: string,
  hint?: string,
): CliError {
  return new CliError(
    `${instance} answered ${what} with something this CLI does not understand`,
    EXIT.failed,
    hint,
  );
}
