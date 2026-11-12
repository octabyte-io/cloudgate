import { utils as sshUtils } from 'ssh2';
import type { ParsedKey } from 'ssh2';

/**
 * A stack's own Stack VM SSH key (ADR-0070): an ed25519 pair, made once with
 * the stack. Only the private half is kept (`stack_vm_key`); the public half
 * is read back from it whenever the Stack VM's definition is written.
 */
export function makeStackVmKey(configName: string): string {
  // ssh2 now and then writes an OpenSSH private key its own parser refuses
  // ("Malformed OpenSSH private key"); a key SSH could never use is made
  // again rather than kept.
  for (;;) {
    const made = sshUtils.generateKeyPairSync('ed25519', {
      comment: `cloudgate-stack-vm-${configName}`,
    }).private;
    if (!(sshUtils.parseKey(made) instanceof Error)) return made;
  }
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
