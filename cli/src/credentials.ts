import { CliError } from './errors.js';
import { EXIT } from './exit-codes.js';
import type { InstanceChoice } from './instance.js';
import type { LoginStore } from './logins.js';

/**
 * Which Personal key a command acts with, and where it came from.
 *
 * `CLOUDGATE_KEY` wins over any saved login and is never written anywhere
 * (CLI spec) — this module only reads it. Otherwise the saved login for the
 * chosen Instance (`cloudgate login`), through {@link savedLoginFor}.
 */
export interface Credential {
  key: string;
  /**
   * Printed as `keyFrom` by `whoami --json`: `env` for `CLOUDGATE_KEY`,
   * `login` for a saved login.
   */
  from: 'env' | 'login';
}

export function keyFromEnvironment(
  env: Record<string, string | undefined>,
): Credential | undefined {
  const key = env.CLOUDGATE_KEY?.trim();
  return key ? { key, from: 'env' } : undefined;
}

/** The saved login's key for an Instance, if this computer holds one. */
async function savedLoginFor(
  instance: string,
  logins: LoginStore,
): Promise<Credential | undefined> {
  const key = await logins.keyFor(instance);
  return key ? { key, from: 'login' } : undefined;
}

/**
 * The key to use with the chosen Instance, or the refusal that says how to get
 * one (exit 3), naming the exact `cloudgate login --instance …` to run: the
 * person may not know which Instance the folder, or the current Instance,
 * points at.
 */
export async function credentialFor(
  choice: InstanceChoice,
  env: Record<string, string | undefined>,
  logins: LoginStore,
): Promise<Credential> {
  const credential =
    keyFromEnvironment(env) ?? (await savedLoginFor(choice.url, logins));
  if (credential) return credential;
  if (choice.from === 'link') {
    throw new CliError(
      `no login for ${choice.url}, the Instance this folder is linked to`,
      EXIT.notLoggedIn,
      `Run: cloudgate login --instance ${choice.url}`,
    );
  }
  throw new CliError(
    `not logged in to ${choice.url}`,
    EXIT.notLoggedIn,
    `Run: cloudgate login --instance ${choice.url} (in CI, set CLOUDGATE_KEY to a Personal key made in the console)`,
  );
}

/**
 * The refusal for a saved key the Instance no longer accepts (CLI spec): the
 * login has ended (it ran out, or the key was deleted in the console). The
 * caller forgets the login first; the CLI never starts a new one by itself.
 */
export function endedLogin(instance: string): CliError {
  return new CliError(
    `your login to ${instance} has ended`,
    EXIT.notLoggedIn,
    `Run: cloudgate login --instance ${instance}`,
  );
}
