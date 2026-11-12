/**
 * The Google Cloud regions a cloud Deploy target may name (the Google Cloud spec,
 * "Region check"): Google's public regions, so a typo (`europe-west-1`) is
 * refused when the target is chosen, before Google is called. Whether Cloud
 * Run and Artifact Registry are really offered in one is the region check's
 * to ask the project, so a region here that either lacks is still refused,
 * naming it. A region Google adds later is one more line here.
 */
export const GOOGLE_REGIONS = [
  'africa-south1',
  'asia-east1',
  'asia-east2',
  'asia-northeast1',
  'asia-northeast2',
  'asia-northeast3',
  'asia-south1',
  'asia-south2',
  'asia-southeast1',
  'asia-southeast2',
  'asia-southeast3',
  'australia-southeast1',
  'australia-southeast2',
  'europe-central2',
  'europe-north1',
  'europe-north2',
  'europe-southwest1',
  'europe-west1',
  'europe-west2',
  'europe-west3',
  'europe-west4',
  'europe-west6',
  'europe-west8',
  'europe-west9',
  'europe-west10',
  'europe-west12',
  'me-central1',
  'me-central2',
  'me-west1',
  'northamerica-northeast1',
  'northamerica-northeast2',
  'northamerica-south1',
  'southamerica-east1',
  'southamerica-west1',
  'us-central1',
  'us-east1',
  'us-east4',
  'us-east5',
  'us-south1',
  'us-west1',
  'us-west2',
  'us-west3',
  'us-west4',
] as const;

/** Google's default quota of VPC networks per project. */
export const NETWORKS_PER_PROJECT = 15;

/**
 * How many networks a project may already have before the region check warns
 * (the Google Cloud spec S7): 13 of 15, so the warning comes while there is still room for
 * the Environment network and one more.
 */
export const NETWORKS_WARNING_AT = 13;
