import { customAlphabet } from 'nanoid';

import { serviceName } from '../cloud-accounts/gcp/definitions/names';

/**
 * A bucket's real name: Cloudgate's, never written in the
 * config, minted once by the plan that creates it so that the plan can show
 * it and the Apply makes exactly that one.
 *
 * Its Config name cut to fit, a hyphen, and {@link BUCKET_NAME_RANDOM_LENGTH}
 * random lowercase letters and digits — so two Environments, or a bucket
 * made again after a Delete, never ask for one name twice. The result keeps
 * S3's rules, which Garage holds too: 3 to 63 characters of lowercase
 * letters, digits and hyphens, starting and ending with a letter or digit. A
 * Config name already starts with a letter and holds nothing else, so only
 * its length and a trailing hyphen are the cut's to mend.
 *
 * On AWS the name is made in S3's account regional namespace and
 * ends with that namespace's suffix: {@link awsBucketName}. On Google Cloud
 * it starts with the bucket Service's own key instead:
 * {@link googleBucketName}.
 */
export const BUCKET_NAME_RANDOM_LENGTH = 8;

/** S3's, and Garage's, longest bucket name. */
export const BUCKET_NAME_MAX_LENGTH = 63;

const BUCKET_NAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const randomPart = customAlphabet(
  BUCKET_NAME_ALPHABET,
  BUCKET_NAME_RANDOM_LENGTH,
);

/** The name from its two parts; pure, so the rule is tested without chance. */
export function bucketName(
  configName: string,
  random: string,
  maxLength = BUCKET_NAME_MAX_LENGTH,
): string {
  if (!new RegExp(`^[a-z0-9]{${BUCKET_NAME_RANDOM_LENGTH}}$`).test(random)) {
    throw new Error(
      `a bucket name's random part is ${BUCKET_NAME_RANDOM_LENGTH} lowercase letters or digits`,
    );
  }
  const room = maxLength - BUCKET_NAME_RANDOM_LENGTH - 1;
  const cut = configName.slice(0, room).replace(/-+$/, '');
  return `${cut}-${random}`;
}

/** A new real name for the bucket written under `configName`. */
export function mintBucketName(configName: string): string {
  return bucketName(configName, randomPart());
}

/** An AWS account id: the twelve digits a namespace suffix carries. */
const AWS_ACCOUNT_ID = /^[0-9]{12}$/;

/**
 * A bucket's real name on AWS (spec "Bucket naming"): made in
 * S3's **account regional namespace**, so no other AWS account can ever take
 * it. {@link bucketName}'s name cut to leave room, then the namespace's
 * suffix `-<account-id>-<region>-an` S3 requires of a name in it
 * (`uploads-k3f9a2qd-123456789012-eu-west-1-an`). Pure.
 */
export function awsBucketName(
  configName: string,
  random: string,
  awsAccountId: string,
  region: string,
): string {
  if (!AWS_ACCOUNT_ID.test(awsAccountId)) {
    throw new Error('an AWS account id is twelve digits');
  }
  const suffix = `-${awsAccountId}-${region}-an`;
  return `${bucketName(configName, random, BUCKET_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

/** A new real name in the account regional namespace of `awsAccountId` and `region`. */
export function mintAwsBucketName(
  configName: string,
  awsAccountId: string,
  region: string,
): string {
  return awsBucketName(configName, randomPart(), awsAccountId, region);
}

/**
 * A bucket's real name on Google Cloud (ADR-0032 as amended):
 * `cloudgate-<service key>-<8 random>`, 31 characters. Cloud Storage names
 * are one world-wide namespace that anyone may take once a bucket is gone,
 * so the random part keeps another project from taking it first; the
 * `cloudgate-<service key>` start is the Service's own name on Google, its
 * mark, so a search by name in the project still finds it. Pure.
 */
export function googleBucketName(serviceId: string, random: string): string {
  if (!new RegExp(`^[a-z0-9]{${BUCKET_NAME_RANDOM_LENGTH}}$`).test(random)) {
    throw new Error(
      `a bucket name's random part is ${BUCKET_NAME_RANDOM_LENGTH} lowercase letters or digits`,
    );
  }
  return `${serviceName(serviceId)}-${random}`;
}

/** A new real name on Google Cloud for the bucket Service `serviceId`. */
export function mintGoogleBucketName(serviceId: string): string {
  return googleBucketName(serviceId, randomPart());
}
