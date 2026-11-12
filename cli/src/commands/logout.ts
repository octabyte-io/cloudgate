import { z } from 'zod';

import { ApiClient } from '../api-client.js';
import type { Command, CommandContext } from '../command.js';
import { CliError, usageError } from '../errors.js';
import { EXIT } from '../exit-codes.js';
import type { ExitCode } from '../exit-codes.js';
import { findNearestLink } from '../folder-link.js';
import { chooseInstance, instanceAddress } from '../instance.js';
import { checkInstance } from '../instance-check.js';
import type { SavedLogin } from '../logins.js';

/**
 * `cloudgate logout [--instance <url> | --all]`: deletes the saved
 * login's key on its Instance, then forgets the login here.
 *
 * **The login is forgotten whatever the Instance answers** (CLI spec): an
 * Instance that cannot be reached, is not a Cloudgate any more, or refuses the
 * delete still leaves this computer clean, and the run says the key was not
 * deleted there and exits 1, since that key still works until it ends. A key
 * the Instance already refuses (401) had ended or was revoked: nothing is left
 * to delete, so that is a clean logout.
 *
 * The Instance is the usual choice (`chooseInstance`), except that
 * `--instance` is taken over a Folder link rather than refused for disagreeing
 * with it: "log out of this Instance instead" is what the flag means here, and
 * nothing is deployed anywhere. `--all` is every saved login.
 *
 * It checks the Instance with `allowOlder`, so a login to an Instance
 * older than this CLI supports can still be ended there.
 *
 * **`CLOUDGATE_KEY` is refused (exit 2).** That key is never saved, so there
 * is no login to forget, and deleting it on the Instance would break whatever
 * else uses it (a CI secret, most likely) — the console is where it is
 * revoked. Logging out of a saved login while the variable is set would act
 * on a login the run otherwise ignores, so that is refused too, rather than
 * guessed at.
 */
export const logout: Command = {
  name: 'logout',
  group: 'LOG IN',
  summary: "Log out and delete this computer's key",
  help: `Log out, and delete this computer's key on the Instance.

USAGE
  cloudgate logout [--instance <url> | --all]

  Logs out of the Instance this folder would use. If the Instance can't
  be reached, the login is still forgotten here, and the CLI says so.
  A key in CLOUDGATE_KEY is never saved, so there is nothing to log out
  of; delete it in the console instead.

FLAGS
  --instance <url>   Log out of this Instance instead
  --all              Log out of every Instance
`,
  options: { all: { type: 'boolean' } },
  maxPositionals: 0,
  async run(context) {
    const { out, env, logins } = context;
    if (context.values.all && context.instanceFlag !== undefined) {
      throw usageError('use --instance or --all, not both');
    }
    if (env.CLOUDGATE_KEY?.trim()) {
      throw usageError(
        'logout forgets a saved login, and CLOUDGATE_KEY is set',
        'The key in CLOUDGATE_KEY is never saved; delete it in the console under Personal keys, or unset CLOUDGATE_KEY to log out of a saved login.',
      );
    }

    if (context.values.all) {
      const { logins: saved } = await logins.list();
      if (saved.length === 0) {
        out.note('You are not logged in to any Instance; nothing to do.');
        return EXIT.ok;
      }
      let code: ExitCode = EXIT.ok;
      for (const login of saved) {
        if ((await logOutOf(context, login)) !== EXIT.ok) code = EXIT.failed;
      }
      return code;
    }

    const flag = context.instanceFlag;
    const link = flag === undefined ? findNearestLink(context.cwd) : undefined;
    const instance = instanceAddress(
      chooseInstance({
        flag,
        env,
        link: link && { instance: link.link.instance, file: link.file },
        current: await logins.current(),
      }).url,
      { allowHttp: context.allowHttp },
    );
    const login = await logins.loginFor(instance);
    if (!login) {
      out.note(`You are not logged in to ${instance}; nothing to do.`);
      return EXIT.ok;
    }
    return logOutOf(context, login);
  },
};

/** One Instance's logout: the key deleted there if it can be, then forgotten here. */
async function logOutOf(
  context: Pick<CommandContext, 'out' | 'fetch' | 'logins'>,
  login: SavedLogin,
): Promise<ExitCode> {
  const { out, logins } = context;
  const { instance } = login;
  out.note(out.noteStyle.dim(`Using instance ${instance}`));

  let outcome: 'deleted' | 'ended' | CliError;
  try {
    outcome = await deleteKeyThere(context, login);
  } catch (error) {
    outcome =
      error instanceof CliError
        ? error
        : new CliError(String(error), EXIT.failed);
  } finally {
    await logins.forget(instance);
  }

  if (outcome === 'deleted') {
    out.note(`✓ Logged out of ${instance}`);
    return EXIT.ok;
  }
  if (outcome === 'ended') {
    out.note(`✓ Logged out of ${instance}; its key had already ended there`);
    return EXIT.ok;
  }
  out.note(`✓ Logged out of ${instance} on this computer`);
  const ends = login.keyEndsAt?.slice(0, 10);
  out.note(`Error: its key was not deleted on ${instance}: ${outcome.message}`);
  out.note(
    `Delete it in the console under Personal keys${ends ? `; until then it works until ${ends}` : ''}.`,
  );
  return EXIT.failed;
}

/** Deletes the login's key with that same key, the one delete a key may make. */
async function deleteKeyThere(
  context: Pick<CommandContext, 'out' | 'fetch' | 'logins'>,
  login: SavedLogin,
): Promise<'deleted' | 'ended'> {
  const { out, fetch, logins } = context;
  const { instance } = login;
  const key = await logins.keyFor(instance);
  if (!key) {
    throw new CliError('this computer no longer holds the key', EXIT.failed);
  }
  await out.withSpinner(`Checking ${instance}…`, () =>
    checkInstance({ address: instance, fetch, allowOlder: true }),
  );
  const keyRefused = new CliError('refused', EXIT.notLoggedIn);
  const client = new ApiClient({
    instance,
    key,
    fetch,
    onKeyRefused: () => Promise.resolve(keyRefused),
  });
  try {
    await out.withSpinner(`Deleting the key on ${instance}…`, () =>
      client.delete(
        `/users/me/api-keys/${encodeURIComponent(login.keyId)}`,
        z.unknown(),
      ),
    );
  } catch (error) {
    if (error === keyRefused) return 'ended';
    throw error;
  }
  return 'deleted';
}
