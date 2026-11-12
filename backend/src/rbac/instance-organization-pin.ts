import { ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import { organization } from '../organizations/organizations.schema';
import {
  INSTANCE_ORGANIZATION_ROW_ID,
  instanceOrganization,
} from './instance-organization.schema';

/**
 * The reads and writes of the pinned **Instance organization** (ADR-0077).
 *
 * The pin is the whole definition: there is no fallback to "the earliest owner
 * `member` row", which is what ADR-0013 used to say. That derivation moved
 * whenever the row it named went — an operator's mistake, a lapse sweep, a
 * deleted owner — and handed instance authority to the next-earliest owner,
 * on the Hosted instance a paying customer. A pin that names an Organization
 * that no longer exists names nobody.
 */

/** What the pin says: the id it records, and whether that Organization still exists. */
export interface InstanceOrganizationPinRead {
  organizationId: string;
  exists: boolean;
}

/**
 * The pinned Instance organization, or `null` when nothing is pinned — an
 * instance nobody has claimed yet.
 */
export async function readInstanceOrganizationPin(
  db: Pick<DrizzleDB, 'select'>,
): Promise<InstanceOrganizationPinRead | null> {
  const [pin] = await db
    .select({
      organizationId: instanceOrganization.organizationId,
      found: organization.id,
    })
    .from(instanceOrganization)
    .leftJoin(
      organization,
      eq(organization.id, instanceOrganization.organizationId),
    )
    .where(eq(instanceOrganization.id, INSTANCE_ORGANIZATION_ROW_ID))
    .limit(1);
  if (!pin) return null;
  return { organizationId: pin.organizationId, exists: pin.found !== null };
}

/**
 * Pins `organizationId` as the Instance organization, unless one is pinned
 * already: the first pin stands and is never moved by the app. Returns
 * whether this call pinned it.
 *
 * Called inside the transaction that creates the Organization, so the
 * Organization and its pin commit together.
 */
export async function pinInstanceOrganization(
  db: Pick<DrizzleDB, 'insert'>,
  organizationId: string,
): Promise<boolean> {
  const pinned = await db
    .insert(instanceOrganization)
    .values({ id: INSTANCE_ORGANIZATION_ROW_ID, organizationId })
    .onConflictDoNothing()
    .returning({ organizationId: instanceOrganization.organizationId });
  return pinned.length > 0;
}

/** The refusal of deleting the Instance organization, through any path. */
export const INSTANCE_ORGANIZATION_UNDELETABLE_CODE =
  'INSTANCE_ORGANIZATION_UNDELETABLE';
export const INSTANCE_ORGANIZATION_UNDELETABLE_MESSAGE =
  'The Instance organization cannot be deleted: it holds the authority over the platform host.';

/**
 * Whether any of `organizationIds` is the pinned Instance organization.
 */
export async function includesInstanceOrganization(
  db: Pick<DrizzleDB, 'select'>,
  organizationIds: readonly string[],
): Promise<boolean> {
  if (organizationIds.length === 0) return false;
  const pin = await readInstanceOrganizationPin(db);
  return pin !== null && organizationIds.includes(pin.organizationId);
}

/**
 * Throws 403 `INSTANCE_ORGANIZATION_UNDELETABLE` when any of
 * `organizationIds` is the pinned Instance organization. Every app path that
 * deletes an Organization asks this first; the `restrict` key on the pin is
 * what holds if a path ever does not.
 */
export async function refuseDeletingInstanceOrganization(
  db: Pick<DrizzleDB, 'select'>,
  organizationIds: readonly string[],
): Promise<void> {
  if (await includesInstanceOrganization(db, organizationIds)) {
    throw new ForbiddenException({
      message: INSTANCE_ORGANIZATION_UNDELETABLE_MESSAGE,
      code: INSTANCE_ORGANIZATION_UNDELETABLE_CODE,
    });
  }
}
