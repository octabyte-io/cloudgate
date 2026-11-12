import { hostname } from 'node:os';

import {
  DEVICE_TOKEN_CODES,
  deviceCodeSchema,
  deviceTokenSchema,
  whoamiSchema,
} from 'api-schemas';
import type { DeviceCode, DeviceToken } from 'api-schemas';

import { ApiClient, postWithoutKey } from '../api-client.js';
import type { Command, CommandContext } from '../command.js';
import { CliError, refusalFromResponse } from '../errors.js';
import { EXIT } from '../exit-codes.js';
import { notUnderstood } from '../http.js';
import { chooseInstance, instanceAddress } from '../instance.js';
import { checkInstance } from '../instance-check.js';

/**
 * `cloudgate login [--instance <url>]`: the device flow. It prints a
 * link and a code, the person approves the code in the console on any device
 * (so it works over SSH), and the Instance hands this computer a Personal key
 * ending in 90 days, which is saved and its Instance made current.
 *
 * The Instance is `--instance`, then `CLOUDGATE_INSTANCE`, then the hosted
 * one: not a Folder link's, and not the current one, since logging in is how
 * the current one is chosen. It is checked (`checkInstance`) before anything
 * else, so a key is never saved from something that is not a Cloudgate.
 *
 * Logging in again on the same Instance replaces that login: the poll names
 * the old key (`replaces`), which the Instance deletes once it has minted the
 * new one, and the new key overwrites the old one here.
 */
export const login: Command = {
  name: 'login',
  group: 'LOG IN',
  summary: 'Log in to an Instance through your browser',
  help: `Log in to an Instance through your browser, and make it the current one.

USAGE
  cloudgate login [--instance <url>]

  Prints a link and a code. Open the link on any device, check the code
  and approve. This computer then gets a Personal key that ends in 90 days.
  Without --instance, logs in to https://cloudgate.octabyte.app.
  An address without https:// gets it added. Plain http:// is refused
  except for localhost, or with --allow-http.

  The key goes in the system keychain; where there is none, in
  credentials.json in the settings folder, readable only by you.

FLAGS
  --instance <url>   The Instance to log in to
  --allow-http       Allow a plain http:// address
`,
  options: {},
  maxPositionals: 0,
  async run(context) {
    const { out, env, logins, fetch } = context;
    const instance = instanceAddress(
      chooseInstance({ flag: context.instanceFlag, env }).url,
      { allowHttp: context.allowHttp },
    );
    out.note(out.noteStyle.dim(`Using instance ${instance}`));
    await out.withSpinner(`Checking ${instance}…`, () =>
      checkInstance({ address: instance, fetch }),
    );

    const started = await startLogin(instance, fetch);
    out.note(
      `Open ${instance}/device and enter the code  ${spaced(started.userCode)}`,
    );
    out.note('Waiting for you to approve…');

    const previous = await logins.loginFor(instance);
    const token = await pollForKey(context, instance, started, previous?.keyId);

    const facts = await new ApiClient({
      instance,
      key: token.key,
      fetch,
    }).get('/users/me/whoami', whoamiSchema);
    const saved = await logins.save(
      {
        instance,
        email: facts.email,
        keyId: token.keyId,
        keyEndsAt: token.expiresAt,
      },
      token.key,
    );

    const ends = token.expiresAt.slice(0, 10);
    if (saved.notice) out.note(saved.notice);
    out.note(`✓ Logged in to ${instance} as ${facts.email}`);
    out.note(
      saved.keyIn === 'keychain'
        ? `  Your key is in the system keychain and ends on ${ends}.`
        : `  Your key ends on ${ends}.`,
    );
    return EXIT.ok;
  },
};

async function startLogin(
  instance: string,
  fetch: typeof globalThis.fetch,
): Promise<DeviceCode> {
  const answer = await postWithoutKey({
    instance,
    path: '/auth/device/code',
    body: {},
    fetch,
  });
  const parsed =
    answer.status === 200 ? deviceCodeSchema.safeParse(answer.body) : undefined;
  if (!parsed?.success) {
    if (answer.status !== 200)
      throw refusalFromResponse(answer.status, answer.body);
    throw notUnderstood(instance, 'the login');
  }
  return parsed.data;
}

/** How much longer to wait after a `SLOW_DOWN` (RFC 8628, section 3.5). */
const SLOW_DOWN_STEP_MS = 5000;

/**
 * Polls until the code is approved, waiting the Instance's interval before
 * each poll. A denied or expired code ends the run with exit 3: nobody is
 * logged in. Ctrl-C stops it like any run (exit 130); the code then expires
 * on its own.
 */
async function pollForKey(
  context: Pick<CommandContext, 'fetch' | 'sleep'>,
  instance: string,
  started: DeviceCode,
  replaces: string | undefined,
): Promise<DeviceToken> {
  let interval = started.interval * 1000;
  const again = `Run: cloudgate login --instance ${instance}`;
  for (;;) {
    await context.sleep(interval);
    const answer = await postWithoutKey({
      instance,
      path: '/auth/device/token',
      body: {
        deviceCode: started.deviceCode,
        name: keyName(),
        ...(replaces ? { replaces } : {}),
      },
      fetch: context.fetch,
    });
    if (answer.status === 200) {
      const parsed = deviceTokenSchema.safeParse(answer.body);
      if (parsed.success) return parsed.data;
      throw notUnderstood(instance, 'the login');
    }
    const code = (answer.body as { code?: unknown } | undefined)?.code;
    switch (code) {
      case DEVICE_TOKEN_CODES.pending:
        continue;
      case DEVICE_TOKEN_CODES.slowDown:
        interval += SLOW_DOWN_STEP_MS;
        continue;
      case DEVICE_TOKEN_CODES.expired:
        throw new CliError(
          'the code expired before it was approved',
          EXIT.notLoggedIn,
          again,
        );
      case DEVICE_TOKEN_CODES.denied:
        throw new CliError(
          `the login to ${instance} was denied`,
          EXIT.notLoggedIn,
        );
      default:
        throw refusalFromResponse(answer.status, answer.body);
    }
  }
}

/** The key's name in the person's Personal keys: which computer holds it. */
function keyName(): string {
  return `cloudgate on ${hostname()}`.slice(0, 100);
}

/** `WDJBMJHT` as `WDJB-MJHT`, easier to read aloud and to check. */
function spaced(userCode: string): string {
  return userCode.length === 8
    ? `${userCode.slice(0, 4)}-${userCode.slice(4)}`
    : userCode;
}
