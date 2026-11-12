import { utils as sshUtils } from 'ssh2';

import {
  makeStackVmKey,
  stackVmPublicKey,
} from '../../src/stack-vm/stack-vm-key';

/**
 * A stack's own Stack VM key (ADR-0070): only its private half is kept, and
 * the `authorized_keys` line its first boot installs is read back from it.
 */
describe('makeStackVmKey', () => {
  it('makes an ed25519 private key SSH can use, a new one for each stack', () => {
    const first = makeStackVmKey('analytics');
    const second = makeStackVmKey('analytics');

    expect(sshUtils.parseKey(first)).not.toBeInstanceOf(Error);
    expect(first).not.toBe(second);
  });
});

describe('stackVmPublicKey', () => {
  it('reads the authorized_keys line back from the private half', () => {
    const pair = sshUtils.generateKeyPairSync('ed25519');

    expect(stackVmPublicKey(pair.private)).toBe(
      pair.public.split(' ').slice(0, 2).join(' '),
    );
  });
});
