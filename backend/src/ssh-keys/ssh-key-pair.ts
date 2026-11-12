import { utils as sshUtils } from 'ssh2';
import type { ParsedKey } from 'ssh2';

/** One refusal of a pasted keypair, on the field that is wrong. */
export type KeyPairIssue = {
  path: 'publicKey' | 'privateKey';
  message: string;
};

const ONE_LINE = 'the one line that starts ssh-ed25519 or ssh-rsa' as const;

/**
 * Why a pasted keypair cannot be used, field by field — or nothing when it can.
 *
 * The import path stored whatever it was handed, so text that is not a key was
 * listed as one and offered in every Server's key picker. Nothing noticed until
 * a Server was pointed at it and its reachability check read `Cannot parse
 * privateKey: Malformed OpenSSH private key`, followed by advice about the
 * address, the user and `authorized_keys` — a screen later, on another object,
 * pointing everywhere but at the key. `ssh2` parses a key the same way here as
 * it does when it dials, so refusing what it cannot read *here* is the same
 * judgement made at the moment the operator is holding the key.
 *
 * Three questions, in the order an operator would fix them:
 *
 * - **Is the public half one OpenSSH line?** It is what the key list offers as
 *   the line to add to `authorized_keys`, so a PEM block or an RFC 4716 box —
 *   which `parseKey` may read — is still refused: installing it would not work.
 * - **Is the private half a private key Cloudgate can use?** A
 *   passphrase-protected one parses only with the passphrase, and nothing
 *   stores one: the dial would fail on every Server, so it gets its own
 *   sentence rather than "not a key".
 * - **Are they one pair?** Asked only when both halves parse, by comparing the
 *   public blob the private key derives with the pasted one — what `sshd`
 *   compares against `authorized_keys`, and blind to the trailing comment.
 *
 * A body with only one half is refused too. `SshKeysService.create` reads
 * `publicKey && privateKey`, so one half used to generate a fresh pair and
 * discard the paste without a word.
 *
 * Nothing here is stored or echoed: the private half is parsed and dropped, and
 * a refusal quotes `ssh2`'s own reason, never the bytes.
 */
export function keyPairIssues(
  publicKey: string | undefined,
  privateKey: string | undefined,
): KeyPairIssue[] {
  if (publicKey === undefined && privateKey === undefined) return [];
  if (publicKey === undefined || privateKey === undefined) {
    return [
      {
        path: publicKey === undefined ? 'publicKey' : 'privateKey',
        message:
          'A pasted key needs both halves. Send neither to have Cloudgate generate a pair',
      },
    ];
  }

  const issues: KeyPairIssue[] = [];
  const pub = parsePublicHalf(publicKey.trim());
  if (typeof pub === 'string') issues.push({ path: 'publicKey', message: pub });
  const priv = parsePrivateHalf(privateKey.trim());
  if (typeof priv === 'string') {
    issues.push({ path: 'privateKey', message: priv });
  }

  if (
    typeof pub !== 'string' &&
    typeof priv !== 'string' &&
    !priv.getPublicSSH().equals(pub.getPublicSSH())
  ) {
    issues.push({
      path: 'privateKey',
      message: 'This private key does not belong to that public key',
    });
  }
  return issues;
}

/** The parsed key, or the sentence saying why the public half is refused. */
function parsePublicHalf(text: string): ParsedKey | string {
  const parsed = sshUtils.parseKey(text);
  if (!(parsed instanceof Error) && parsed.isPrivateKey()) {
    return `This is a private key. The public key is ${ONE_LINE}`;
  }
  if (parsed instanceof Error || text.includes('\n')) {
    return `This is not an SSH public key. Paste ${ONE_LINE}`;
  }
  return parsed;
}

/** The parsed key, or the sentence saying why the private half is refused. */
function parsePrivateHalf(text: string): ParsedKey | string {
  const parsed = sshUtils.parseKey(text);
  if (parsed instanceof Error) {
    return /passphrase/i.test(parsed.message)
      ? 'This private key is protected by a passphrase, which Cloudgate cannot enter when it dials a Server. Remove it (ssh-keygen -p -N "" -f <file>) and paste the key again'
      : `This is not a private key Cloudgate can read (${parsed.message})`;
  }
  if (!parsed.isPrivateKey()) {
    return 'This is a public key. The private key is the block that starts -----BEGIN';
  }
  return parsed;
}
