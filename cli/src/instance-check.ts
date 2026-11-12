import { aboutSchema } from 'api-schemas';
import type { About } from 'api-schemas';

import { CliError } from './errors.js';
import { EXIT } from './exit-codes.js';
import { parseJson, reach, USER_AGENT } from './http.js';
import { instanceEndpoints } from './instance.js';
import type { InstanceEndpoints } from './instance.js';
import {
  MINIMUM_SERVER_VERSION,
  serverVersionAgainst,
} from './server-version.js';
import { VERSION } from './version.js';

/** An Instance that answered the check: its version, and where to dial it. */
export interface CheckedInstance {
  /** The address, as `instanceAddress` gave it. */
  address: string;
  /** The server version the Instance reports. */
  version: string;
  endpoints: InstanceEndpoints;
}

/** The path of the public answer, under the REST base. */
const ABOUT_PATH = '/settings/about';

/**
 * "Is this a Cloudgate this CLI works with?", asked before any key leaves the
 * machine (CLI spec, Address rules and Version compatibility).
 *
 * Every command that talks to an Instance calls this first, after
 * `instanceAddress` and before its first request carrying a key — and, from
 * `login` on, before saving one. It sends no credential: the public answer
 * (`GET /backend/settings/about`) is what tells a Cloudgate apart from any
 * other site, so anything else at the address — a console page, someone
 * else's shop, a typo that resolves — is refused and never sees the key.
 *
 * Refusals, all exit 1 (the address was well formed; what answered it is the
 * failure, as with an unreachable Instance):
 * - unreachable: `could not reach <address>`;
 * - anything but the answer: `<address> is not a Cloudgate`;
 * - older than {@link MINIMUM_SERVER_VERSION}, unless `allowOlder`: names the
 *   Instance's version, this CLI's and the minimum. `logout` alone passes
 *   `allowOlder`, so a login to an old Instance can still be forgotten.
 *
 * Redirects are not followed, here or by `ApiClient`: a key request that
 * followed one would carry `x-api-key` to wherever it pointed, and a check
 * that followed one would vouch for an address other than the one checked.
 */
export async function checkInstance(input: {
  address: string;
  fetch: typeof fetch;
  allowOlder?: boolean;
}): Promise<CheckedInstance> {
  const { address } = input;
  const about = await askAbout(address, input.fetch);

  if (!input.allowOlder) {
    const verdict = serverVersionAgainst(about.version, MINIMUM_SERVER_VERSION);
    if (verdict === 'older') {
      throw new CliError(
        `${address} runs Cloudgate ${about.version}, and this CLI needs ${MINIMUM_SERVER_VERSION} or newer`,
        EXIT.failed,
        `Ask its operator to upgrade it; this is @octabyte-io/cloudgate ${VERSION}.`,
      );
    }
    if (verdict === 'unreadable') {
      throw new CliError(
        `${address} reports a version this CLI cannot read ("${about.version}")`,
        EXIT.failed,
      );
    }
  }

  return {
    address,
    version: about.version,
    endpoints: instanceEndpoints(address, about),
  };
}

async function askAbout(
  address: string,
  fetcher: typeof fetch,
): Promise<About> {
  const response = await reach(
    address,
    fetcher,
    `${instanceEndpoints(address).rest}${ABOUT_PATH}`,
    {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    },
  );
  const parsed = response.ok
    ? aboutSchema.safeParse(parseJson(await response.text()))
    : undefined;
  if (!parsed?.success) {
    throw new CliError(
      `${address} is not a Cloudgate`,
      EXIT.failed,
      `It does not answer GET /backend${ABOUT_PATH}. Give the address you open the console at; a Cloudgate older than ${MINIMUM_SERVER_VERSION} does not answer it either.`,
    );
  }
  return parsed.data;
}
