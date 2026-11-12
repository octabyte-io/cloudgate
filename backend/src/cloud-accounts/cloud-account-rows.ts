import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { decryptValue, isEncrypted } from '../common/encryption/encryption';
import { mapUniqueViolation } from '../common/unique-violation';
import type { DrizzleDB } from '../db/drizzle.module';
import { cloudAccount } from '../db/schema';
import type { CloudAccount } from '../db/schema';
import type { CloudKind } from './cloud-account.schema';

/**
 * What every cloud's Cloud account does alike: the sequences of
 * connecting ({@link connectChecked}: duplicate, check, insert) and of an
 * edit ({@link editChecked}: merge, re-check on a credential change, the
 * pass as the last check), opening a sealed setup token, the 502 for a cloud
 * that never answered, and the row's last-check columns. Each cloud's
 * `CloudProvider` fills them in with its own check and columns, so the AWS
 * and Google halves differ only in what is their own.
 */

const UNIQUE_INDEX = 'cloud_account_organization_cloud_id_unique';
const ALREADY_CONNECTED =
  'This setup template already connected a Cloud account; get a new one to connect another';

/** The columns only an `aws` row sets. */
export type AwsColumns =
  | 'accessKeyId'
  | 'secretAccessKey'
  | 'deployRoleArn'
  | 'taskExecutionRoleArn'
  | 'externalId';

/** The columns only a `gcp` row sets. */
export type GcpColumns =
  | 'projectNumber'
  | 'workloadIdentityProvider'
  | 'deployServiceAccount'
  | 'signingKey'
  | 'signingKeyId'
  | 'signingPublicKey'
  | 'pendingSigningKey'
  | 'tokenIssuer';

/** The columns only an `aws` row sets, which a Google one's view leaves out. */
export const AWS_COLUMNS: readonly AwsColumns[] = [
  'accessKeyId',
  'secretAccessKey',
  'deployRoleArn',
  'taskExecutionRoleArn',
  'externalId',
];

/** The columns only a `gcp` row sets, which an AWS one's view leaves out. */
export const GCP_COLUMNS: readonly GcpColumns[] = [
  'projectNumber',
  'workloadIdentityProvider',
  'deployServiceAccount',
  'signingKey',
  'signingKeyId',
  'signingPublicKey',
  'pendingSigningKey',
  'tokenIssuer',
];

/** `row` without `keys`. */
export function without<T extends object, K extends keyof T>(
  row: T,
  keys: readonly K[],
): Omit<T, K> {
  const copy = { ...row };
  for (const key of keys) delete copy[key];
  return copy;
}

/** The last-check columns of a check that just passed. */
export function passed(policyVersion: number) {
  return {
    policyVersion,
    lastCheckedAt: new Date().toISOString(),
    lastCheckResult: 'passed' as const,
    lastCheckReason: null,
  };
}

/**
 * Records a failure a use of the Cloud account found as its last check
 * (the AWS spec, "When the credential stops working"); see
 * `CloudAccountsService.recordUseFailure`.
 */
export async function recordUseFailure(
  db: DrizzleDB,
  cloudAccountId: string,
  reason: string,
): Promise<void> {
  await db
    .update(cloudAccount)
    .set({
      lastCheckedAt: new Date().toISOString(),
      lastCheckResult: 'failed',
      lastCheckReason: reason,
    })
    .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
}

/**
 * A 409 naming `duplicate` when the Organization already has a Cloud
 * account for this cloud's id: looked for before the connect check, so
 * connecting one twice costs no cloud calls.
 */
export async function refuseConnected(
  db: DrizzleDB,
  organizationId: string,
  cloud: CloudKind,
  cloudId: string,
  duplicate: string,
): Promise<void> {
  const [existing] = await db
    .select({ cloudAccountId: cloudAccount.cloudAccountId })
    .from(cloudAccount)
    .where(
      and(
        eq(cloudAccount.organizationId, organizationId),
        eq(cloudAccount.cloud, cloud),
        eq(cloudAccount.cloudId, cloudId),
      ),
    );
  if (existing) throw new ConflictException(duplicate);
}

/** The columns a check writes as the last check. */
type LastCheckColumns = keyof ReturnType<typeof passed>;

/** A connect check's pass, with what the cloud's check read (Google's project number). */
type Passed<Result> = Extract<Result, { ok: true }>;

/**
 * **Connecting, every cloud alike**: the duplicate refused
 * before any cloud call, then the cloud's connect check — a refusal is a
 * 400 that writes nothing — then the row saved with the check's pass as its
 * last check. What differs per cloud is the check and the columns.
 */
export async function connectChecked<
  Result extends
    { ok: true; policyVersion: number } | { ok: false; message: string },
>(
  db: DrizzleDB,
  place: {
    organizationId: string;
    cloud: CloudKind;
    cloudId: string;
    duplicate: string;
  },
  check: () => Promise<Result>,
  columns: (
    pass: Passed<Result>,
  ) => Omit<typeof cloudAccount.$inferInsert, LastCheckColumns>,
): Promise<CloudAccount> {
  await refuseConnected(
    db,
    place.organizationId,
    place.cloud,
    place.cloudId,
    place.duplicate,
  );
  const result = await check();
  if (!result.ok) throw new BadRequestException(result.message);
  const pass = result as Passed<Result>;
  return insertCloudAccount(
    db,
    { ...columns(pass), ...passed(pass.policyVersion) },
    place.duplicate,
  );
}

/**
 * **An edit, every cloud alike**, so that an edit can
 * never break one that works (the AWS spec): `merged` is the
 * stored values with the given ones over them, and a change to any of
 * `credentialFields` reruns the cloud's connect check with them. **A
 * failed re-check writes nothing, not even the last check**: it tested
 * values that were never saved, so it says nothing about the ones that
 * are. The operator sees its refusal as the 400. A pass is written as the
 * last check, since it is now a check of the saved values.
 */
export async function editChecked<
  Merged extends Partial<CloudAccount>,
  Field extends keyof Merged & keyof CloudAccount,
>(
  stored: CloudAccount,
  merged: Merged,
  credentialFields: readonly Field[],
  recheck: () => Promise<
    { ok: true; policyVersion: number } | { ok: false; message: string }
  >,
): Promise<Partial<CloudAccount>> {
  if (!credentialFields.some((field) => merged[field] !== stored[field])) {
    return merged;
  }
  const result = await recheck();
  if (!result.ok) throw new BadRequestException(result.message);
  return { ...merged, ...passed(result.policyVersion) };
}

/**
 * The ids a sealed setup token carries (ADR-0006's `enc:v1:`), if it is one
 * this instance made for this Organization and `read` finds its cloud's ids
 * in it; a 400 saying `invalid` otherwise.
 */
export function openSetupToken<Ids>(
  organizationId: string,
  token: string,
  invalid: string,
  read: (ids: Record<string, unknown>) => Ids | null,
): Ids {
  const refused = new BadRequestException(invalid);
  if (!isEncrypted(token)) throw refused;
  let ids: unknown;
  try {
    ids = JSON.parse(decryptValue(token));
  } catch {
    throw refused;
  }
  if (typeof ids !== 'object' || ids === null) throw refused;
  const fields = ids as Record<string, unknown>;
  if (fields.organizationId !== organizationId) throw refused;
  const found = read(fields);
  if (found === null) throw refused;
  return found;
}

/**
 * A call to the cloud, or a 502 naming it: a call that got no answer at all
 * says nothing about the Cloud account, so it is no refusal of it. A cloud's
 * own refusals come back as the call's result.
 */
export async function reachingCloud<T>(
  cloudName: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new BadGatewayException(
      `${cloudName} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The checked Cloud account saved; the unique index still decides a race, as `duplicate`. */
export async function insertCloudAccount(
  db: DrizzleDB,
  values: typeof cloudAccount.$inferInsert,
  duplicate: string,
): Promise<CloudAccount> {
  try {
    const [created] = await db.insert(cloudAccount).values(values).returning();
    return created;
  } catch (error) {
    throw mapUniqueViolation(
      mapUniqueViolation(error, UNIQUE_INDEX, duplicate),
      'cloud_account_pkey',
      ALREADY_CONNECTED,
    );
  }
}
