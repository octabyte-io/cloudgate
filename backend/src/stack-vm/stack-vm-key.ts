import { utils as sshUtils } from 'ssh2';
import type { ParsedKey } from 'ssh2';

import { generateEd25519KeyPair } from '../ssh-keys/ed25519-key-pair';

/**
 * A stack's own Stack VM SSH key (ADR-0070): an ed25519 pair, made once with
 * the stack. Only the private half is kept (`stack_vm_key`); the public half
 * is read back from it whenever the Stack VM's definition is written.
 */
export function makeStackVmKey(configName: string): string {
  return generateEd25519KeyPair(`cloudgate-stack-vm-${configName}`).privateKey;
}

/** The public half of a Stack VM key, as an `authorized_keys` line. */
export function stackVmPublicKey(privateKey: string): string {
  const parsed = sshUtils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const key: ParsedKey = Array.isArray(parsed)
    ? (parsed[0] as ParsedKey)
    : parsed;
  return `${key.type} ${key.getPublicSSH().toString('base64')}`;
}
