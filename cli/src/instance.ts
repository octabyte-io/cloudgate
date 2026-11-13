/**
 * Which Instance a command talks to, and where on it the API answers.
 *
 * The Instance choice (CLI spec): `--instance`, then `CLOUDGATE_INSTANCE`,
 * then the nearest Folder link's Instance, then the current Instance
 * (the last logged in to, or picked with `instance use`), then the
 * hosted Instance.
 * Whatever was chosen goes through {@link instanceAddress} before anything is
 * dialled, and through the "this is a Cloudgate" check in `instance-check.ts`
 * before any key is sent.
 */

import { usageError } from './errors.js';

export const DEFAULT_INSTANCE = 'https://cloudgate.octabyte.app';

/** Where the chosen address came from — printed nowhere yet, read by tests and later rules. */
export type InstanceSource = 'flag' | 'env' | 'link' | 'current' | 'default';

export interface InstanceChoice {
  url: string;
  from: InstanceSource;
}

/** Reads a value that counts only when it holds something other than spaces. */
function given(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The nearest Folder link's Instance, and the file that names it. */
export interface LinkedInstance {
  instance: string;
  file: string;
}

/**
 * Picks the Instance. A flag or variable that names a different Instance from
 * the nearest Folder link is refused (exit 2), naming both, rather than either
 * one winning: the folder was linked to a Service on one Cloudgate, and
 * deploying it to another by a stale `CLOUDGATE_INSTANCE` is the mistake this
 * exists to stop. `cloudgate link` passes no link here, since it is the
 * command that replaces one.
 */
export function chooseInstance(input: {
  flag?: string;
  env: Record<string, string | undefined>;
  link?: LinkedInstance;
  /**
   * The current Instance: the last one logged in to, or picked with
   * `instance use`. Ignored when `CLOUDGATE_KEY` is set: that key was
   * made for whatever Instance the run names, not for the one this computer
   * last logged in to (CLI spec).
   */
  current?: string;
}): InstanceChoice {
  const flag = given(input.flag);
  if (flag) return agreeingWithLink({ url: flag, from: 'flag' }, input.link);
  const env = given(input.env.CLOUDGATE_INSTANCE);
  if (env) return agreeingWithLink({ url: env, from: 'env' }, input.link);
  if (input.link) return { url: input.link.instance, from: 'link' };
  const current = given(input.current);
  if (current && !given(input.env.CLOUDGATE_KEY)) {
    return { url: current, from: 'current' };
  }
  return { url: DEFAULT_INSTANCE, from: 'default' };
}

/** The hosts plain `http://` is allowed to without `--allow-http` (CLI spec). */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * An Instance address as the CLI keeps and prints it: an origin and nothing
 * else (CLI spec, Address rules).
 *
 * - No scheme gets `https://`, so `cloud.acme.dev` works as typed.
 * - Only the origin is kept, so a console URL pasted from the address bar
 *   (`https://cloud.acme.dev/projects/p_1?tab=logs`) names its Instance. The
 *   host is lower-cased and a default port dropped, by `URL`, so one Instance
 *   has one spelling for a saved login or a Folder link to be keyed by.
 * - Plain `http://` is refused, exit 2, before anything is dialled: the key
 *   would cross the network readable. `localhost` and `127.0.0.1` are the
 *   exceptions, since that traffic never leaves the machine, and
 *   `allowHttp` (`--allow-http`) lifts the rule for a LAN install.
 *
 * Exit 2, not 1, because each refusal here is the address the person gave and
 * is fixed by giving another; nothing was asked of an Instance yet.
 */
export function instanceAddress(
  address: string,
  options: { allowHttp?: boolean } = {},
): string {
  const trimmed = address.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw notAnAddress(address);
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    !url.hostname
  ) {
    throw notAnAddress(address);
  }
  if (
    url.protocol === 'http:' &&
    !options.allowHttp &&
    !LOCAL_HOSTS.has(url.hostname)
  ) {
    throw usageError(
      `${url.origin} is plain http://, which sends your key unencrypted`,
      `Use https://${url.host}, or pass --allow-http to use it anyway.`,
    );
  }
  return url.origin;
}

function notAnAddress(address: string) {
  return usageError(
    `"${address}" is not an Instance address`,
    'Give the address you open the console at, such as https://cloud.acme.dev.',
  );
}

function agreeingWithLink(
  choice: InstanceChoice,
  link: LinkedInstance | undefined,
): InstanceChoice {
  if (!link || sameInstance(choice.url, link.instance)) return choice;
  const named = choice.from === 'flag' ? '--instance' : 'CLOUDGATE_INSTANCE';
  throw usageError(
    `${named} ${choice.url} is not the Instance this folder is linked to, ${link.instance} (${link.file})`,
    `Leave out ${named} here, or run cloudgate link --instance ${choice.url} to link the folder to that Instance instead.`,
  );
}

/**
 * Whether two addresses name one Instance: the same origin once
 * {@link instanceAddress} has given each its one spelling (`cloud.acme.dev`,
 * `https://CLOUD.acme.dev/` and a pasted console URL are one Instance).
 */
export function sameInstance(a: string, b: string): boolean {
  const key = (address: string) => {
    try {
      return instanceAddress(address, { allowHttp: true });
    } catch {
      return address.trim().toLowerCase();
    }
  };
  return key(a) === key(b);
}

export interface InstanceEndpoints {
  /** The base every REST path is appended to, e.g. `/users/me/whoami`. */
  rest: string;
  /**
   * The base a WebSocket path is appended to (`/listen-deployment?…`): the
   * API's own origin as `ws:`/`wss:`, or null when the Instance advertises
   * none (`CLOUDGATE_API_URL` unset) or the public answer was not passed.
   */
  websocket: string | null;
}

/**
 * The one place an Instance address becomes the bases the client dials.
 *
 * **The Instance address is the console's**, because that is what a person
 * types and pastes: the console and the API are different origins on a stock
 * install (`deploy/install.sh` puts them on two ports), and the console
 * proxies the whole REST surface at `/backend/*` (`frontend/next.config.ts`'s
 * rewrites). So REST goes to `<instance>/backend`, the public "this is a
 * Cloudgate" answer included (`GET /backend/settings/about`).
 *
 * **WebSockets go to the API's own origin**, which that answer advertises as
 * `apiUrl`: the console proxies none (`frontend/server.mjs`), and the
 * browser dials them at the same origin (`CLOUDGATE_API_URL`). A streaming
 * command passes the answer `checkInstance` returned; no caller assembles a
 * URL of its own.
 *
 * Rejected: asking for the API origin as the Instance address. Nobody knows
 * it, the console never shows it, and a Folder link or a saved login keyed by
 * it would break the day an operator moved the API behind the console.
 */
export function instanceEndpoints(
  instance: string,
  about?: { apiUrl: string | null },
): InstanceEndpoints {
  return {
    rest: `${instance.replace(/\/+$/, '')}/backend`,
    websocket: about?.apiUrl
      ? new URL(about.apiUrl).origin.replace(/^http/, 'ws')
      : null,
  };
}
