import { byCloud, cloudOrLegacy } from '../../cloud-accounts/cloud-provider';
import type { PerCloud } from '../../cloud-accounts/cloud-provider';
import { parameterFamilyOf } from '../../native/aws-native';
import type { AwsMadeFacts } from '../../native/aws-locks';
import type { DescribedEntry } from './fields';
import type { PlanInput, SavedService } from './plan.types';

/** What only a Service's place knows about what it makes on AWS. */
type PlacedFacts = Pick<AwsMadeFacts, 'existing' | 'browserOrigins'>;

/**
 * What an Environment's Deploy target says about a Service's AWS
 * resources: on AWS, what its saved Service holds; on Google Cloud nothing,
 * since none of what it makes there is an AWS resource.
 */
const PLACED_ON: PerCloud<
  (
    name: string,
    entry: DescribedEntry,
    found: SavedService | undefined,
    input: PlanInput,
  ) => PlacedFacts
> = {
  aws: placedOnAws,
  gcp: () => ({}),
};

/**
 * What an entry's Service makes on AWS **right now**, as far as this
 * plan knows, for `nativeAwsCheck`'s "an address it does not make right
 * now" (`aws_iam_role_policy.buckets` with no bucket linked).
 *
 * Its links are the config's, so they are known on every target, as are the
 * parameter group family a written redis version runs and a static site's
 * `spa`, which owns its custom error responses while set. Whether it is an
 * Existing database or existing bucket, and whether its bucket's page
 * trusts a browser origin, only a Service saved on AWS can say; on any
 * other target those facts are left out, and a fact left out never
 * refuses: the deploy names whatever is wrong.
 */
export function nativeAwsFacts(
  name: string,
  entry: DescribedEntry,
  found: SavedService | undefined,
  input: PlanInput,
): AwsMadeFacts {
  const linkedKinds = Object.values(entry.links ?? {}).flatMap((link) => {
    const source = input.config.services[link.source];
    return source ? [source.kind] : [];
  });
  const parameterFamily =
    entry.kind === 'redis' ? parameterFamilyOf(entry.dockerImage) : undefined;
  return {
    linkedKinds,
    ...(parameterFamily === undefined ? {} : { parameterFamily }),
    // A static site's `spa` is the config's on every target.
    ...(entry.kind === 'static'
      ? { spa: entry.build?.isStaticSpa ?? false }
      : {}),
    ...(input.deployTarget.kind === 'cloud'
      ? byCloud(cloudOrLegacy(input.cloud), PLACED_ON)(
          name,
          entry,
          found,
          input,
        )
      : {}),
  };
}

/**
 * On an AWS Environment: a Service the plan creates starts Cloudgate-made
 * (unless a switch to an existing database waits for it) and trusts no
 * browser origin yet; a saved one says so itself. One still on a Server
 * (ADR-0035) has nothing on AWS to know about.
 */
function placedOnAws(
  name: string,
  entry: DescribedEntry,
  found: SavedService | undefined,
  input: PlanInput,
): PlacedFacts {
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
    return {
      existing: pending === true,
      ...(entry.kind === 'bucket' ? { browserOrigins: false } : {}),
    };
  }
  if ('existing' in found && found.existing !== undefined) {
    return { existing: true };
  }
  if (found.cloud === undefined) return {};
  return {
    existing: false,
    ...(found.serviceType === 'bucket'
      ? { browserOrigins: (found.cors?.origins.length ?? 0) > 0 }
      : {}),
  };
}
