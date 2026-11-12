import type { CloudKind } from '../cloud-account.schema';
import { byCloud } from '../cloud-provider';
import {
  AWS_PROVIDER_VERSION,
  GOOGLE_PROVIDER_VERSION,
  OPENTOFU_VERSION,
} from '../tofu/tofu-environment';

/**
 * The provider a state is written with (the Google Cloud spec, S18): `hashicorp/aws`, or
 * `hashicorp/google`.
 */
export type StateProvider = 'aws' | 'google';

/** The provider a state owned in a Cloud account of `cloud` is written with. */
export function stateProviderOf(cloud: CloudKind): StateProvider {
  return byCloud(cloud, { aws: 'aws', gcp: 'google' });
}

/** The cloud each provider's states are in: the way back from {@link stateProviderOf}. */
export const PROVIDER_CLOUDS: Record<StateProvider, CloudKind> = {
  aws: 'aws',
  google: 'gcp',
};

/** What finds a provider's resources when its state is rebuilt (ADR-0036 item 6): AWS's tags, Google's names. */
export const PROVIDER_FINDS_BY: Record<StateProvider, string> = {
  aws: 'tags',
  google: 'names',
};

/** Each provider's pin in this checkout. */
const PROVIDER_VERSIONS: Record<StateProvider, string> = {
  aws: AWS_PROVIDER_VERSION,
  google: GOOGLE_PROVIDER_VERSION,
};

/** How a refusal names each provider. */
const PROVIDER_NAMES: Record<StateProvider, string> = {
  aws: 'AWS provider',
  google: 'Google provider',
};

/** The OpenTofu and provider pair that wrote, or is about to write, a state. */
export interface StateVersions {
  readonly tofuVersion: string;
  readonly providerVersion: string;
}

/** What this checkout installs, and so writes a state of `provider` with. */
export function installedVersions(provider: StateProvider): StateVersions {
  return {
    tofuVersion: OPENTOFU_VERSION,
    providerVersion: PROVIDER_VERSIONS[provider],
  };
}

/**
 * Versions move forward only: a state last written by a newer
 * OpenTofu or provider than the install's is refused, because an older
 * one may misread it and write it back damaged. The provider's version is
 * compared with that provider's own pin. The sentence names both pairs
 * and what to do. An older state is fine — the run brings it forward — and so
 * is one never written (`null` versions, a state not yet applied).
 */
export function newerStateRefusal(
  stateId: string,
  recorded: {
    provider: StateProvider;
    tofuVersion: string | null;
    providerVersion: string | null;
  },
  installed: StateVersions = installedVersions(recorded.provider),
): string | null {
  const newerTofu =
    recorded.tofuVersion !== null &&
    compareVersions(recorded.tofuVersion, installed.tofuVersion) > 0;
  const newerProvider =
    recorded.providerVersion !== null &&
    compareVersions(recorded.providerVersion, installed.providerVersion) > 0;
  if (!newerTofu && !newerProvider) return null;
  const provider = PROVIDER_NAMES[recorded.provider];
  return (
    `Infrastructure state ${stateId} was last written by OpenTofu ${recorded.tofuVersion} ` +
    `with ${provider} ${recorded.providerVersion}, newer than this install's ` +
    `OpenTofu ${installed.tofuVersion} with ${provider} ${installed.providerVersion}. ` +
    'Upgrade Cloudgate to run it.'
  );
}

/** Dotted numeric versions, compared part by part (`1.10.0` > `1.9.4`). */
export function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}
