import { createHmac } from 'node:crypto';
import * as path from 'path';

/**
 * The OpenTofu release this checkout runs (ADR-0030). `deploy/install.sh`
 * installs exactly this one, checked against its pinned sha256, and writes it
 * to `/etc/default/cloudgate-backend` as `OPENTOFU_VERSION`. Versions move
 * forward only: a state recorded by a newer release is one this
 * checkout refuses. `opentofu-pins.spec.ts` holds it equal to install.sh's.
 */
export const OPENTOFU_VERSION = '1.13.1';

/**
 * The one `hashicorp/aws` provider every AWS Cloud run uses, from the OpenTofu
 * registry. Its checksums are in `deploy/opentofu/.terraform.lock.hcl`, which
 * `opentofu-pins.spec.ts` holds this equal to.
 */
export const AWS_PROVIDER_VERSION = '6.69.1';

/**
 * The one `hashicorp/google` provider every Google Cloud run uses (the Google Cloud spec,
 * S14b), and the only Google one: it makes every Google resource Cloudgate
 * writes, the Memorystore instance included (ADR-0030, as amended).
 * Held equal to the lock file, install.sh and `versions.tf.json` like the
 * AWS pin.
 */
export const GOOGLE_PROVIDER_VERSION = '8.8.0';

/** Each provider `deploy/opentofu/` pins, by its `hashicorp/` type. */
export const PINNED_PROVIDERS = {
  aws: AWS_PROVIDER_VERSION,
  google: GOOGLE_PROVIDER_VERSION,
} as const;

export type PinnedProvider = keyof typeof PINNED_PROVIDERS;

/** `deploy/opentofu/`'s two pin files, as text. */
export interface PinFiles {
  /** `versions.tf.json`: each provider's `required_providers` entry. */
  readonly versions: string;
  /** `.terraform.lock.hcl`: each provider's version and checksums. */
  readonly lock: string;
}

/**
 * The pin files narrowed to the providers one run uses (the Google Cloud spec). `tofu
 * init` installs every provider `versions.tf.json` requires, and a plan names
 * each in its configuration, so an AWS run is handed the AWS pin alone — its
 * lock block byte for byte — and a Google run the Google ones. The lock is
 * narrowed with it, since `-lockfile=readonly` refuses a lock that names a
 * provider nothing requires.
 */
export function pinsFor(
  pins: PinFiles,
  providers: readonly PinnedProvider[],
): PinFiles {
  const versions = JSON.parse(pins.versions) as {
    terraform: { required_providers: Record<string, unknown> };
  };
  const required = versions.terraform.required_providers;
  const blocks = [...pins.lock.matchAll(LOCK_BLOCK)];
  const header = pins.lock.slice(0, blocks[0]?.index ?? pins.lock.length);
  for (const provider of providers) {
    if (!(provider in required) || !blocks.some((b) => b[1] === provider)) {
      throw new Error(
        `deploy/opentofu/ does not pin hashicorp/${provider} in both versions.tf.json and .terraform.lock.hcl`,
      );
    }
  }
  return {
    versions:
      JSON.stringify(
        {
          ...versions,
          terraform: {
            ...versions.terraform,
            required_providers: Object.fromEntries(
              Object.entries(required).filter(([name]) =>
                providers.includes(name as PinnedProvider),
              ),
            ),
          },
        },
        null,
        2,
      ) + '\n',
    lock:
      header +
      blocks
        .filter((b) => providers.includes(b[1] as PinnedProvider))
        .map((b) => b[0])
        .join('\n'),
  };
}

/** One provider's block of a lock file `tofu` wrote, its type captured. */
const LOCK_BLOCK =
  /^provider "registry\.opentofu\.org\/hashicorp\/([^"]+)" \{\n[\s\S]*?\n\}\n/gm;

/**
 * The CLI configuration a Cloud run hands `tofu` (via `TF_CLI_CONFIG_FILE`):
 * providers come from the mirror `deploy/install.sh` filled and checked, and
 * from nowhere else. There is no `direct {}` block, so a provider missing from
 * the mirror fails `tofu init` rather than being downloaded mid-run.
 */
export function opentofuCliConfig(providerMirror: string): string {
  if (!path.isAbsolute(providerMirror)) {
    throw new Error(
      `The OpenTofu provider mirror must be an absolute path, not "${providerMirror}"`,
    );
  }
  return [
    'provider_installation {',
    '  filesystem_mirror {',
    `    path = ${hclString(providerMirror)}`,
    '  }',
    '}',
    '',
  ].join('\n');
}

/**
 * A quoted string in the CLI config, which OpenTofu reads as HCL 1 — not the
 * HCL 2 of a definition, so `${` and `%{` are plain text there and must not be
 * doubled. JSON's escapes (`\"`, `\\`, `\uXXXX`) are ones HCL 1 reads too.
 */
function hclString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The label the state key is derived from `APP_ENCRYPTION_SECRET` under
 * (ADR-0036): a key of its own, so the states' encryption and the `enc:v1:`
 * columns' never share one.
 */
export const STATE_ENCRYPTION_LABEL = 'cloudgate:infrastructure-state:v1';

/**
 * OpenTofu's whole-state and plan encryption for every Cloud run (ADR-0036,
 * the AWS spec "Infrastructure state"), as the `TF_ENCRYPTION` value: `aes_gcm`
 * with `enforced = true` on both, so an unencrypted state or plan is refused,
 * and **no `fallback` block**, so no second key can read a state.
 *
 * The key is `HMAC-SHA256(APP_ENCRYPTION_SECRET, label)`, derived the way
 * `common/encryption/encryption.ts` derives the column key. It reaches
 * OpenTofu as the `pbkdf2` key provider's passphrase — OpenTofu 1.13 has no
 * key provider that takes a raw key — which stretches it once more under a
 * salt kept in each state's header.
 *
 * Passed only through the environment: never a file in the working folder,
 * never an argument.
 */
export function stateEncryption(appEncryptionSecret: string): string {
  if (!appEncryptionSecret) {
    throw new Error(
      'APP_ENCRYPTION_SECRET is not set; an Infrastructure state cannot be encrypted without it.',
    );
  }
  const passphrase = createHmac('sha256', appEncryptionSecret)
    .update(STATE_ENCRYPTION_LABEL)
    .digest('hex');
  return [
    'key_provider "pbkdf2" "cloudgate" {',
    `  passphrase = "${passphrase}"`,
    '}',
    'method "aes_gcm" "cloudgate" {',
    '  keys = key_provider.pbkdf2.cloudgate',
    '}',
    'state {',
    '  method   = method.aes_gcm.cloudgate',
    '  enforced = true',
    '}',
    'plan {',
    '  method   = method.aes_gcm.cloudgate',
    '  enforced = true',
    '}',
    '',
  ].join('\n');
}

/**
 * Where `install.sh` unpacks a pinned provider inside the mirror, in the
 * layout `filesystem_mirror` reads.
 */
export function providerDirectory(
  providerMirror: string,
  provider: PinnedProvider,
): string {
  return path.join(
    providerMirror,
    'registry.opentofu.org',
    'hashicorp',
    provider,
    PINNED_PROVIDERS[provider],
    'linux_amd64',
  );
}
