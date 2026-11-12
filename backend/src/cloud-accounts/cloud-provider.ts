import type { CloudAccount } from '../db/schema';
import type { CloudKind } from './cloud-account.schema';
import type { AwsCredential } from './cloud.port';

/**
 * **The cloud seam (ADR-0043).** The one place a Cloud account's
 * cloud is told apart. Everything that behaves differently on AWS and on
 * Google Cloud chooses its half here, by `cloud`, through a table that names
 * **every** cloud — {@link onCloud} for a Cloud account, {@link byCloud} for a
 * bare `cloud` — so a cloud added to `cloud_kind` is a type error at every
 * site that has not said what it does there, never a silent fall-through to
 * another cloud's half. A comparison with a cloud's name (`cloud === 'gcp'`)
 * outside this file and the clouds' own folders (`aws/**`, `gcp/**`) is
 * refused by `test/coding-standards/cloud-comparisons.spec.ts`.
 */

/** A table with an entry for every cloud a Cloud account can be at. */
export type PerCloud<T> = { readonly [cloud in CloudKind]: T };

/** `table`'s entry for `cloud`. */
export function byCloud<T>(cloud: CloudKind, table: PerCloud<T>): T {
  return table[cloud];
}

/**
 * **The one rule for a cloud that is not known**: it is read as AWS.
 * AWS was the only cloud a Cloud account could be at before Google Cloud
 * joined (slice 6, the Google Cloud spec), so every shape written then — a plan's
 * Deploy target, a saved Service's cloud place, an Output's stand-ins —
 * carries no `cloud`, and its absence means AWS; slice 6 kept it that way
 * so their fingerprints did not move. A row whose Cloud account is gone, or
 * was not read, is named and refused by the same rule, as it was before
 * Google Cloud existed.
 *
 * Every default to a cloud goes through {@link cloudOrLegacy}; a bare
 * `?? 'aws'` is refused by `test/coding-standards/cloud-comparisons.spec.ts`.
 */
export const LEGACY_CLOUD = 'aws' satisfies CloudKind;

/** `cloud`, or {@link LEGACY_CLOUD} when it is absent or its Cloud account is gone. */
export function cloudOrLegacy(cloud: CloudKind | null | undefined): CloudKind {
  return cloud ?? LEGACY_CLOUD;
}

/**
 * A Cloud account at AWS, with every AWS column set — which
 * `cloud_account_aws_whole` holds an `aws` row to. Only {@link onCloud} and
 * {@link awsAccountOf} make one, so a use that needs AWS's credential cannot
 * be handed a Google row by accident.
 */
export type AwsCloudAccount = CloudAccount & {
  cloud: 'aws';
  accessKeyId: string;
  secretAccessKey: string;
  deployRoleArn: string;
  taskExecutionRoleArn: string;
  externalId: string;
};

/** A Cloud account at Google Cloud, with every Google column but the pending key set (`cloud_account_gcp_whole`). */
export type GcpCloudAccount = CloudAccount & {
  cloud: 'gcp';
  projectNumber: string;
  workloadIdentityProvider: string;
  deployServiceAccount: string;
  signingKey: string;
  signingKeyId: string;
  signingPublicKey: string;
  tokenIssuer: string;
};

/** A Cloud account on each cloud, with that cloud's columns set. */
interface AccountOn {
  aws: AwsCloudAccount;
  gcp: GcpCloudAccount;
}

/** Each cloud's half of one behaviour, handed the Cloud account as that cloud's. */
export type CloudHalves<R> = {
  readonly [cloud in CloudKind]: (account: AccountOn[cloud]) => R;
};

/**
 * The half of `halves` for `row`'s cloud, handed the row as a Cloud account
 * on that cloud — which `cloud_account_aws_whole` and
 * `cloud_account_gcp_whole` hold every row to, so no half ever sees another
 * cloud's row or a row missing its own cloud's columns.
 */
export function onCloud<R>(row: CloudAccount, halves: CloudHalves<R>): R {
  // Called with the row whose cloud chose it, so the narrowing holds.
  const byItsCloud = halves as PerCloud<(account: CloudAccount) => R>;
  return byItsCloud[row.cloud](row);
}

/**
 * The half of `halves` for a value tagged with its own `cloud` (a union with
 * one arm per cloud), handed the value narrowed to that cloud's arm: the
 * {@link onCloud} of a shape that is not a Cloud account row.
 */
export function onCloudOf<Tagged extends { readonly cloud: CloudKind }, R>(
  value: Tagged,
  halves: {
    readonly [cloud in CloudKind]: (
      value: Extract<Tagged, { readonly cloud: cloud }>,
    ) => R;
  },
): R {
  // Called with the value whose cloud chose it, so the narrowing holds.
  const byItsCloud = halves as PerCloud<(value: Tagged) => R>;
  return byItsCloud[value.cloud](value);
}

/** A cloud as the operator reads its name. */
export const CLOUD_NAMES = {
  aws: 'AWS',
  gcp: 'Google Cloud',
} as const satisfies PerCloud<string>;

/**
 * The Cloud account as an AWS one, or a refusal naming it and Google Cloud
 * (slice 6, S12): for a use that has an AWS half only, so a Google row is
 * refused rather than read as an AWS one with no key. A use with both halves
 * chooses by {@link onCloud} instead.
 */
export function awsAccountOf(
  account: CloudAccount,
): { ok: true; account: AwsCloudAccount } | { ok: false; refusal: string } {
  if (account.cloud === 'aws') {
    // `cloud_account_aws_whole` holds an `aws` row to every AWS column.
    return { ok: true, account: account as AwsCloudAccount };
  }
  return {
    ok: false,
    refusal: `Cloud account ${account.name} is a Google Cloud project, and this is not available on Google Cloud yet`,
  };
}

/**
 * A `gcp` row as a Google Cloud account: `cloud_account_gcp_whole` holds it
 * to every Google column but the pending key. An AWS row is refused, naming
 * the Cloud account, as {@link awsAccountOf} refuses a Google one: never a
 * row with no Google key to sign with. Every caller has already chosen Google
 * by the row's cloud, so a refusal here is a bug, thrown.
 */
export function googleAccountOf(row: CloudAccount): GcpCloudAccount {
  if (row.cloud !== 'gcp') {
    throw new Error(
      `Cloud account ${row.name} is an AWS account, not a Google Cloud project`,
    );
  }
  return row as GcpCloudAccount;
}

/** The Cloud account's own key, as the cloud port takes it. */
export function credentialOf(account: AwsCloudAccount): AwsCredential {
  return {
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
  };
}
