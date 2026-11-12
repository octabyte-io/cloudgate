/**
 * The AWS regions a cloud Deploy target may name: the commercial
 * partition's, since the setup template's ARNs are `arn:aws:` ones and a
 * GovCloud or China account is a different partition with its own IAM.
 *
 * A list rather than a pattern so a typo (`eu-west1`) is refused when the
 * target is chosen, not at the first Cloud run. A region AWS adds later is one
 * more line here. Regions an account must opt into are listed too: the region
 * check refuses one the account has not enabled, naming it.
 */
export const AWS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'af-south-1',
  'ap-east-1',
  'ap-south-1',
  'ap-south-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
  'ap-southeast-5',
  'ap-southeast-7',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ca-central-1',
  'ca-west-1',
  'eu-central-1',
  'eu-central-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-south-1',
  'eu-south-2',
  'eu-north-1',
  'il-central-1',
  'me-south-1',
  'me-central-1',
  'mx-central-1',
  'sa-east-1',
] as const;

export type AwsRegion = (typeof AWS_REGIONS)[number];

/** AWS's per-region VPC quota a new account starts with. */
export const VPCS_PER_REGION = 5;
