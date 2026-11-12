import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loginStore } from '../src/logins.js';
import type { Keychain } from '../src/logins.js';

/**
 * The saved logins: one per Instance, its key in the OS keychain, or
 * in a 0600 `credentials.json` where there is none, and the current Instance.
 * Driven through the store's own interface against a real temporary config
 * folder; the keychain is the one double, since a test must never touch the
 * developer's own.
 */
function folder(): string {
  return mkdtempSync(join(tmpdir(), 'cloudgate-logins-'));
}

/** A keychain that works, and what it holds. */
function workingKeychain() {
  const secrets = new Map<string, string>();
  const keychain: Keychain = {
    get: (account) => Promise.resolve(secrets.get(account)),
    set: (account, secret) => {
      secrets.set(account, secret);
      return Promise.resolve();
    },
    delete: (account) => {
      secrets.delete(account);
      return Promise.resolve();
    },
  };
  return { secrets, load: () => Promise.resolve(keychain) };
}

/** A machine with a keychain library but no keychain behind it (a server over SSH). */
function lockedKeychain() {
  const refuse = () =>
    Promise.reject(new Error("Couldn't access platform storage"));
  return {
    load: () =>
      Promise.resolve<Keychain>({ get: refuse, set: refuse, delete: refuse }),
  };
}

const acme = {
  instance: 'https://cloud.acme.dev',
  email: 'sam@acme.dev',
  keyId: 'key_1',
  keyEndsAt: '2027-02-01T12:00:00.000Z',
};

const other = {
  instance: 'https://cloud.other.io',
  email: 'sam@other.io',
  keyId: 'key_2',
  keyEndsAt: '2027-02-02T12:00:00.000Z',
};

/** Every file the store wrote, read whole: where a key must (not) appear. */
function everythingWritten(dir: string): string {
  return readdirSync(dir)
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
}

describe('loginStore', () => {
  it('keeps the key in the keychain and nowhere on disk, where there is one', async () => {
    const dir = folder();
    const keychain = workingKeychain();
    const store = loginStore({
      configDir: dir,
      env: {},
      keychain: keychain.load,
    });

    const saved = await store.save(acme, 'cg_acme_secret');

    expect(saved).toEqual({ keyIn: 'keychain' });
    expect([...keychain.secrets.values()]).toEqual(['cg_acme_secret']);
    expect(everythingWritten(dir)).not.toContain('cg_acme_secret');
    expect(await store.keyFor(acme.instance)).toBe('cg_acme_secret');
  });

  it('puts the key in a 0600 credentials.json, with a one-line notice, where there is no keychain', async () => {
    const dir = folder();
    const store = loginStore({
      configDir: dir,
      env: {},
      keychain: lockedKeychain().load,
    });

    const saved = await store.save(acme, 'cg_acme_secret');

    const file = join(dir, 'credentials.json');
    expect(saved.keyIn).toBe('file');
    expect(saved.notice).toBe(
      `No system keychain here, so the key is in ${file}, readable only by you.`,
    );
    expect(saved.notice).not.toContain('\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('cg_acme_secret');
    expect(await store.keyFor(acme.instance)).toBe('cg_acme_secret');
  });

  it('uses the file when the keychain library cannot load at all', async () => {
    const dir = folder();
    const store = loginStore({
      configDir: dir,
      env: {},
      keychain: () => Promise.resolve(undefined),
    });
    expect((await store.save(acme, 'cg_acme_secret')).keyIn).toBe('file');
    expect(await store.keyFor(acme.instance)).toBe('cg_acme_secret');
  });

  it('uses the file with CLOUDGATE_NO_KEYCHAIN set, even where there is a keychain', async () => {
    const dir = folder();
    const keychain = workingKeychain();
    const store = loginStore({
      configDir: dir,
      env: { CLOUDGATE_NO_KEYCHAIN: '1' },
      keychain: keychain.load,
    });
    expect((await store.save(acme, 'cg_acme_secret')).keyIn).toBe('file');
    expect(keychain.secrets.size).toBe(0);
  });

  it('holds a login to each of several Instances, the last saved being current', async () => {
    const dir = folder();
    const store = loginStore({
      configDir: dir,
      env: {},
      keychain: workingKeychain().load,
    });
    await store.save(acme, 'cg_acme_secret');
    await store.save(other, 'cg_other_secret');

    expect(await store.list()).toEqual({
      current: other.instance,
      logins: [acme, other],
    });
    expect(await store.keyFor(acme.instance)).toBe('cg_acme_secret');
    expect(await store.keyFor(other.instance)).toBe('cg_other_secret');
  });

  it('switches the current Instance only to one it holds a login for', async () => {
    const dir = folder();
    const store = loginStore({
      configDir: dir,
      env: {},
      keychain: workingKeychain().load,
    });
    await store.save(acme, 'cg_acme_secret');
    await store.save(other, 'cg_other_secret');

    expect(await store.use(acme.instance)).toBe(true);
    expect(await store.current()).toBe(acme.instance);
    expect(await store.use('https://cloud.nowhere.io')).toBe(false);
    expect(await store.current()).toBe(acme.instance);
  });

  it('replaces the login to an Instance when it is saved again, answering the one it replaced', async () => {
    const dir = folder();
    const store = loginStore({
      configDir: dir,
      env: {},
      keychain: lockedKeychain().load,
    });
    await store.save(acme, 'cg_old');
    expect(await store.loginFor(acme.instance)).toEqual(acme);

    await store.save({ ...acme, keyId: 'key_9' }, 'cg_new');

    expect((await store.list()).logins).toEqual([{ ...acme, keyId: 'key_9' }]);
    expect(await store.keyFor(acme.instance)).toBe('cg_new');
    expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).not.toContain(
      'cg_old',
    );
  });

  it('forgets a login and its key, and the current Instance with it', async () => {
    const dir = folder();
    const keychain = workingKeychain();
    const store = loginStore({
      configDir: dir,
      env: {},
      keychain: keychain.load,
    });
    await store.save(acme, 'cg_acme_secret');

    await store.forget(acme.instance);

    expect(await store.list()).toEqual({ current: null, logins: [] });
    expect(await store.keyFor(acme.instance)).toBeUndefined();
    expect(keychain.secrets.size).toBe(0);
  });

  it('answers no logins from a config folder that does not exist yet, and writes nothing', async () => {
    const dir = join(folder(), 'not-yet');
    const store = loginStore({
      configDir: dir,
      env: {},
      keychain: workingKeychain().load,
    });
    expect(await store.list()).toEqual({ current: null, logins: [] });
    expect(await store.keyFor(acme.instance)).toBeUndefined();
    expect(() => readdirSync(dir)).toThrow();
  });
});
