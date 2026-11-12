import { eq } from 'drizzle-orm';

import type { DrizzleDB } from '../db/drizzle.module';
import { organization } from './organizations.schema';

/**
 * An Organization as a sentence or a row names it: its id and its name. The
 * one shape for "which Organization" across the refusals, the Billing views
 * and the Operator page (ADR-0059).
 */
export interface NamedOrganization {
  id: string;
  name: string;
}

/**
 * What a sentence says when the Organization it names has no row. Every
 * caller asks about an Organization a foreign key or the caller's own
 * membership keeps in place, so this is the one answer to "it was deleted
 * in between", not a wording anyone is meant to read twice.
 */
export const UNKNOWN_ORGANIZATION_NAME = 'An Organization';

/**
 * The name of the Organization with this id, or
 * {@link UNKNOWN_ORGANIZATION_NAME} without a row. One query, by primary key.
 */
export async function organizationNameOf(
  db: DrizzleDB,
  organizationId: string,
): Promise<string> {
  const [row] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  return row?.name ?? UNKNOWN_ORGANIZATION_NAME;
}
