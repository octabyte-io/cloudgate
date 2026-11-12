import { AWS_REGIONS } from './aws/regions';
import { GOOGLE_REGIONS } from './gcp/regions';
import type { CloudKind } from './cloud-account.schema';

/**
 * The regions a cloud Deploy target may name, by its Cloud account's cloud
 * (the Google Cloud spec S17), and how one it may not is refused. A list per cloud rather
 * than a pattern, so a typo is refused when the target is chosen, not at the
 * first Cloud run. A cloud with no list takes no region yet.
 */
const REGIONS: {
  readonly [cloud in CloudKind]?: {
    readonly regions: readonly string[];
    readonly refusal: (region: string) => string;
  };
} = {
  aws: {
    regions: AWS_REGIONS,
    refusal: (region) => `${region} is not an AWS region Cloudgate deploys to`,
  },
  gcp: {
    regions: GOOGLE_REGIONS,
    refusal: (region) =>
      `${region} is not a Google Cloud region Cloudgate deploys to`,
  },
};

/**
 * Why `region` cannot be a Deploy target's on a Cloud account on `cloud`, or
 * `null` when it can. The Deploy target check asks this once it has the
 * Cloud account, before it calls the cloud.
 */
export function regionRefusal(cloud: CloudKind, region: string): string | null {
  const known = REGIONS[cloud];
  if (!known) return `Cloudgate deploys to no ${cloud} region yet`;
  return known.regions.includes(region) ? null : known.refusal(region);
}
