import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The saved logins (CLI spec, Instance choice and credentials): at
 * most one per Instance, keyed by its address as `instanceAddress` spells it,
 * and which one is current.
 *
 * Two files in the config folder (`config-dir.ts`):
 * - `instances.json`: each login's facts (email, key id, when the key ends,
 *   where the key is) and the current Instance. Never a key.
 * - `credentials.json`, mode 0600: the keys, only on a machine with no
 *   keychain to put them in (a server over SSH, a container), or with
 *   `CLOUDGATE_NO_KEYCHAIN` set.
 *
 * Everywhere else a key is in the OS keychain, under the service `cloudgate`
 * and the Instance address as the account. A key from `CLOUDGATE_KEY` never
 * comes here: only `cloudgate login` saves.
 */

/** A login's facts, as `instance list` and `whoami` print them. */
export interface SavedLogin {
  instance: string;
  email: string;
  /** The key's id on the Instance, which the next login there replaces. */
  keyId: string;
  /** ISO-8601, or null for a key that does not end. */
  keyEndsAt: string | null;
}

export type KeyPlace = 'keychain' | 'file';

/** The slice of an OS keychain the store uses: one secret per account. */
export interface Keychain {
  get(account: string): Promise<string | undefined>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

/** Loads the keychain, or answers undefined where its library cannot load. */
export type KeychainLoader = () => Promise<Keychain | undefined>;

export interface LoginStore {
  list(): Promise<{ current: string | null; logins: SavedLogin[] }>;
  current(): Promise<string | undefined>;
  loginFor(instance: string): Promise<SavedLogin | undefined>;
  keyFor(instance: string): Promise<string | undefined>;
  /**
   * Saves a login, replacing any to the same Instance, and makes it current.
   * `notice` is the one line to print when the key went to the file.
   */
  save(
    login: SavedLogin,
    key: string,
  ): Promise<{ keyIn: KeyPlace; notice?: string }>;
  /** Makes a saved login's Instance current; false when there is none. */
  use(instance: string): Promise<boolean>;
  /** Forgets a login and deletes its key from wherever it is. */
  forget(instance: string): Promise<void>;
}

interface InstancesFile {
  current: string | null;
  logins: Array<SavedLogin & { keyIn: KeyPlace }>;
}

const INSTANCES_FILE = 'instances.json';
const CREDENTIALS_FILE = 'credentials.json';

/** The keychain's service name; the account is the Instance address. */
export const KEYCHAIN_SERVICE = 'cloudgate';

export function loginStore(options: {
  configDir: string;
  env: Record<string, string | undefined>;
  keychain: KeychainLoader;
}): LoginStore {
  const { configDir } = options;
  const instancesPath = join(configDir, INSTANCES_FILE);
  const credentialsPath = join(configDir, CREDENTIALS_FILE);
  const keychainOff = Boolean(options.env.CLOUDGATE_NO_KEYCHAIN);

  async function readInstances(): Promise<InstancesFile> {
    const parsed = await readJson(instancesPath);
    const file = parsed as Partial<InstancesFile> | undefined;
    return {
      current: typeof file?.current === 'string' ? file.current : null,
      logins: Array.isArray(file?.logins) ? file.logins : [],
    };
  }

  async function readCredentials(): Promise<Record<string, string>> {
    const parsed = await readJson(credentialsPath);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, string>)
      : {};
  }

  async function writeCredentials(keys: Record<string, string>) {
    await writePrivately(configDir, credentialsPath, keys);
  }

  async function keychain(): Promise<Keychain | undefined> {
    if (keychainOff) return undefined;
    try {
      return await options.keychain();
    } catch {
      return undefined;
    }
  }

  /** Puts the key in the keychain if one takes it, or in the file. */
  async function storeKey(instance: string, key: string): Promise<KeyPlace> {
    const chain = await keychain();
    if (chain) {
      try {
        await chain.set(instance, key);
        await dropFromFile(instance);
        return 'keychain';
      } catch {
        // No keychain behind the library: fall through to the file.
      }
    }
    const keys = await readCredentials();
    keys[instance] = key;
    await writeCredentials(keys);
    return 'file';
  }

  async function dropFromFile(instance: string) {
    const keys = await readCredentials();
    if (!(instance in keys)) return;
    delete keys[instance];
    await writeCredentials(keys);
  }

  async function dropKey(instance: string, keyIn: KeyPlace | undefined) {
    if (keyIn !== 'file') {
      const chain = await keychain();
      await chain?.delete(instance).catch(() => undefined);
    }
    await dropFromFile(instance);
  }

  const facts = ({ instance, email, keyId, keyEndsAt }: SavedLogin) => ({
    instance,
    email,
    keyId,
    keyEndsAt,
  });

  return {
    async list() {
      const file = await readInstances();
      return { current: file.current, logins: file.logins.map(facts) };
    },

    async current() {
      return (await readInstances()).current ?? undefined;
    },

    async loginFor(instance) {
      const found = (await readInstances()).logins.find(
        (login) => login.instance === instance,
      );
      return found && facts(found);
    },

    async keyFor(instance) {
      const login = (await readInstances()).logins.find(
        (entry) => entry.instance === instance,
      );
      if (!login) return undefined;
      if (login.keyIn === 'file') return (await readCredentials())[instance];
      const chain = await keychain();
      try {
        return (await chain?.get(instance)) ?? undefined;
      } catch {
        return undefined;
      }
    },

    async save(login, key) {
      const file = await readInstances();
      const before = file.logins.find(
        (entry) => entry.instance === login.instance,
      );
      const keyIn = await storeKey(login.instance, key);
      if (before?.keyIn === 'keychain' && keyIn === 'file') {
        await dropKey(login.instance, 'keychain');
      }
      file.logins = [
        ...file.logins.filter((entry) => entry.instance !== login.instance),
        { ...facts(login), keyIn },
      ];
      file.current = login.instance;
      await writePrivately(configDir, instancesPath, file);
      return keyIn === 'file'
        ? {
            keyIn,
            notice: `No system keychain here, so the key is in ${credentialsPath}, readable only by you.`,
          }
        : { keyIn };
    },

    async use(instance) {
      const file = await readInstances();
      if (!file.logins.some((entry) => entry.instance === instance))
        return false;
      file.current = instance;
      await writePrivately(configDir, instancesPath, file);
      return true;
    },

    async forget(instance) {
      const file = await readInstances();
      const login = file.logins.find((entry) => entry.instance === instance);
      if (!login) return;
      await dropKey(instance, login.keyIn);
      file.logins = file.logins.filter((entry) => entry.instance !== instance);
      if (file.current === instance) file.current = null;
      await writePrivately(configDir, instancesPath, file);
    },
  };
}

/** A store for a run with no config folder: no logins, and none can be saved. */
export function noLoginStore(): LoginStore {
  return {
    list: () => Promise.resolve({ current: null, logins: [] }),
    current: () => Promise.resolve(undefined),
    loginFor: () => Promise.resolve(undefined),
    keyFor: () => Promise.resolve(undefined),
    save: () =>
      Promise.reject(
        new Error('this run has no config folder to save a login in'),
      ),
    use: () => Promise.resolve(false),
    forget: () => Promise.resolve(),
  };
}

/**
 * The OS keychain through `@napi-rs/keyring`, loaded only when a login is
 * read or saved. It is a native module (a prebuilt binary per platform,
 * through its own optional dependencies), kept out of the bundle
 * (`build.mjs`), and an optional dependency of the CLI: where it did not
 * install, or its binary cannot load, this answers undefined and the key goes
 * to `credentials.json`.
 */
export const osKeychain: KeychainLoader = async () => {
  let module: typeof import('@napi-rs/keyring');
  try {
    module = await import('@napi-rs/keyring');
  } catch {
    return undefined;
  }
  const entry = (account: string) =>
    new module.AsyncEntry(KEYCHAIN_SERVICE, account);
  return {
    get: async (account) => (await entry(account).getPassword()) ?? undefined,
    set: (account, secret) => entry(account).setPassword(secret),
    delete: async (account) => {
      await entry(account).deletePassword();
    },
  };
};

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Writes `value` as JSON at mode 0600, through a temporary file renamed over
 * the old one so a crash never leaves half a file; the folder is made 0700.
 * The chmod covers a file an older run made with a wider mode.
 */
async function writePrivately(dir: string, path: string, value: unknown) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
