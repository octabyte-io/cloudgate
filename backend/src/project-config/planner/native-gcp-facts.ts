import { byCloud, cloudOrLegacy } from '../../cloud-accounts/cloud-provider';
import type { PerCloud } from '../../cloud-accounts/cloud-provider';
import type { GcpMadeFacts } from '../../native/google-locks';
import type { DescribedEntry } from './fields';
import type { PlanInput, SavedService } from './plan.types';

/**
 * What an Environment's Deploy target says about a Service's Google Cloud
 * resources: on Google Cloud, what its saved Service holds; on AWS nothing,
 * since none of what it makes there is a Google resource.
 */
const PLACED_ON: PerCloud<
  (
    name: string,
    entry: DescribedEntry,
    found: SavedService | undefined,
    input: PlanInput,
  ) => GcpMadeFacts
> = {
  aws: () => ({}),
  gcp: placedOnGcp,
};

/**
 * What an entry's Service makes on Google Cloud **right now**, as
 * far as this plan knows, for `nativeGcpCheck`'s "an address it does not
 * make right now": whether it is an Existing database, used as given, which
 * only a Google Environment knows. On any other target the fact is left
 * out, and a fact left out never refuses. The twin of `nativeAwsFacts`.
 */
export function nativeGcpFacts(
  name: string,
  entry: DescribedEntry,
  found: SavedService | undefined,
  input: PlanInput,
): GcpMadeFacts {
  return input.deployTarget.kind === 'cloud'
    ? byCloud(cloudOrLegacy(input.cloud), PLACED_ON)(name, entry, found, input)
    : {};
}

/**
 * On a Google Environment: a Service the plan creates is Cloudgate-made
 * unless a switch to an existing database waits for it; a saved one of the
 * same kind says so itself.
 */
function placedOnGcp(
  name: string,
  entry: DescribedEntry,
  found: SavedService | undefined,
  input: PlanInput,
): GcpMadeFacts {
  const savedKind =
    found === undefined
      ? undefined
      : found.serviceType === 'application'
        ? found.settings.configKind
        : found.serviceType;
  if (found === undefined || savedKind !== entry.kind) {
    const pending = input.existingCreates?.some(
      (one) => one.configName === name && one.kind === entry.kind,
    );
    return { existing: pending === true };
  }
  return { existing: 'existing' in found && found.existing !== undefined };
}
