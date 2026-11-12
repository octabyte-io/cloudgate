import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import {
  HOST_KEY_CHANGED_CODE,
  hostKeyFingerprint,
  isHostKeyChanged,
  sshConnectConfig,
  sshFailure,
  trustOnFirstUse,
  unverifiedHostKey,
} from '../../src/remote/host-key';
import type { HostKeyStore } from '../../src/remote/host-key';
import type { ServerConnection } from '../../src/remote/server-key.provider';

const KEY_A = Buffer.from('the host key a Server presented first');
const KEY_B = Buffer.from('the host key a reinstalled Server presents');

/** A store standing in for the Server row's column. */
function memoryStore(initial: string | null) {
  let stored = initial;
  // The conditional write: only an empty column takes a value.
  const writes = jest.fn((fingerprint: string) => {
    if (stored === null) stored = fingerprint;
    return Promise.resolve(stored);
  });
  const store: HostKeyStore & {
    stored: () => string | null;
    writes: typeof writes;
  } = { recordFirst: writes, writes, stored: () => stored };
  return store;
}

/** What ssh2's `verify` callback is handed, once the check has decided. */
function verifyWith(
  check: ReturnType<typeof trustOnFirstUse>,
  key: Buffer,
): Promise<boolean> {
  return new Promise((resolve) => {
    const answered: unknown = check.verifier(key, resolve);
    // Asynchronous: ssh2 waits for the callback when nothing is returned.
    expect(answered).toBeUndefined();
  });
}

describe('hostKeyFingerprint', () => {
  it('writes the fingerprint in OpenSSH form, as ssh-keygen -lf prints it', () => {
    const expected = createHash('sha256')
      .update(KEY_A)
      .digest('base64')
      .replace(/=+$/, '');
    expect(hostKeyFingerprint(KEY_A)).toBe(`SHA256:${expected}`);
    expect(hostKeyFingerprint(KEY_A)).not.toContain('=');
  });
});

describe('trustOnFirstUse', () => {
  it('records the key on first use and accepts it', async () => {
    const store = memoryStore(null);
    const check = trustOnFirstUse('web-1', null, store);

    await expect(verifyWith(check, KEY_A)).resolves.toBe(true);

    expect(store.writes).toHaveBeenCalledWith(hostKeyFingerprint(KEY_A));
    expect(store.stored()).toBe(hostKeyFingerprint(KEY_A));
    expect(check.refusal()).toBeUndefined();
  });

  it('accepts the recorded key without writing again', async () => {
    const store = memoryStore(hostKeyFingerprint(KEY_A));
    const check = trustOnFirstUse('web-1', hostKeyFingerprint(KEY_A), store);

    await expect(verifyWith(check, KEY_A)).resolves.toBe(true);
    expect(store.writes).not.toHaveBeenCalled();
  });

  it('refuses a key that differs from the recorded one, naming both fingerprints', async () => {
    const store = memoryStore(hostKeyFingerprint(KEY_A));
    const check = trustOnFirstUse('web-1', hostKeyFingerprint(KEY_A), store);

    await expect(verifyWith(check, KEY_B)).resolves.toBe(false);

    expect(store.writes).not.toHaveBeenCalled();
    expect(store.stored()).toBe(hostKeyFingerprint(KEY_A));
    const refusal = check.refusal();
    expect(refusal).toBeInstanceOf(ConflictException);
    expect(isHostKeyChanged(refusal)).toBe(true);
    expect((refusal as ConflictException).getResponse()).toMatchObject({
      code: HOST_KEY_CHANGED_CODE,
    });
    expect(refusal?.message).toContain('web-1');
    expect(refusal?.message).toContain(hostKeyFingerprint(KEY_A));
    expect(refusal?.message).toContain(hostKeyFingerprint(KEY_B));
  });

  it('refuses when a concurrent first connect recorded a different key', async () => {
    // Read empty, but another connect's write won the race with another key.
    const store = memoryStore(hostKeyFingerprint(KEY_B));
    const check = trustOnFirstUse('web-1', null, store);

    await expect(verifyWith(check, KEY_A)).resolves.toBe(false);
    expect(isHostKeyChanged(check.refusal())).toBe(true);
  });

  it('accepts when a concurrent first connect recorded the same key', async () => {
    const store = memoryStore(hostKeyFingerprint(KEY_A));
    const check = trustOnFirstUse('web-1', null, store);

    await expect(verifyWith(check, KEY_A)).resolves.toBe(true);
    expect(check.refusal()).toBeUndefined();
  });

  it('checks a later connection on the same details against what the first one recorded', async () => {
    const store = memoryStore(null);
    const check = trustOnFirstUse('web-1', null, store);

    await expect(verifyWith(check, KEY_A)).resolves.toBe(true);
    await expect(verifyWith(check, KEY_B)).resolves.toBe(false);
    expect(store.writes).toHaveBeenCalledTimes(1);
  });

  it('refuses, and keeps the cause, when the first-use write fails', async () => {
    const store: HostKeyStore = {
      recordFirst: () => Promise.reject(new Error('database is down')),
    };
    const check = trustOnFirstUse('web-1', null, store);

    await expect(verifyWith(check, KEY_A)).resolves.toBe(false);
    expect(check.refusal()?.message).toMatch(/database is down/);
  });
});

describe('sshConnectConfig / sshFailure', () => {
  const base: Omit<ServerConnection, 'hostKey'> = {
    host: '203.0.113.9',
    port: 22,
    username: 'root',
    privateKey: 'key-material',
  };

  it('hands ssh2 the check as its hostVerifier', () => {
    const hostKey = trustOnFirstUse('web-1', null, memoryStore(null));
    const config = sshConnectConfig({ ...base, hostKey });
    expect(config).toEqual({
      host: '203.0.113.9',
      port: 22,
      username: 'root',
      privateKey: 'key-material',
      hostVerifier: hostKey.verifier,
    });
    expect(config).not.toHaveProperty('hostHash');
  });

  it("answers ssh2's error with the refusal when the host key was refused", async () => {
    const hostKey = trustOnFirstUse(
      'web-1',
      hostKeyFingerprint(KEY_A),
      memoryStore(hostKeyFingerprint(KEY_A)),
    );
    await verifyWith(hostKey, KEY_B);
    const sshError = new Error('Host denied (verification failed)');
    expect(isHostKeyChanged(sshFailure({ ...base, hostKey }, sshError))).toBe(
      true,
    );
  });

  it("passes ssh2's own error through otherwise", () => {
    const hostKey = unverifiedHostKey();
    const sshError = new Error('connect ECONNREFUSED');
    expect(sshFailure({ ...base, hostKey }, sshError)).toBe(sshError);
  });

  it('an unverified check accepts any key', async () => {
    await expect(verifyWith(unverifiedHostKey(), KEY_A)).resolves.toBe(true);
  });
});
