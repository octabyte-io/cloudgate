import { ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import type { DrizzleDB } from '../../db/drizzle.module';
import { organizationNameOf } from '../../organizations/organization-name';
import type { NamedOrganization } from '../../organizations/organization-name';
import { organization } from '../../organizations/organizations.schema';
import { organizationsAttachedTo, payer } from './paying-organization';

/**
 * The two Hosted refusals a "paid by" link brings (ADR-0059), each
 * with its one code and its reason (the PRD's "Refusals and their codes").
 * Both are 409: the request is fine, the Organization's link is in the way.
 *
 * Plain functions over the tables, like `paying-organization.ts`, so the
 * Organization delete, Billing and the Operator ask the same thing without
 * one service injecting another.
 */

/** Deleting, or moving to Starter, a Paying Organization that pays for others. */
export const ORGANIZATIONS_ATTACHED = 'ORGANIZATIONS_ATTACHED';

/**
 * Checkout, a plan change or Add-ons on an Attached Organization, or an
 * Operator turning Enterprise on for one.
 */
export const PAID_BY_ANOTHER_ORGANIZATION = 'PAID_BY_ANOTHER_ORGANIZATION';

/**
 * What the Paying Organization was asked to do: be deleted, or move to
 * Starter (the trial switch or a scheduled downgrade).
 */
export type AttachedBlocks = 'delete' | 'starter';

/**
 * `ORGANIZATIONS_ATTACHED`, naming each Organization `paying` pays for, in
 * the order given. The console's "Before <Paying> can move to Starter"
 * checklist branches on the code and reads the list itself
 * (`organizationsAttachedTo`).
 */
export function organizationsAttached(
  paying: NamedOrganization,
  attached: readonly NamedOrganization[],
  blocks: AttachedBlocks,
): ConflictException {
  const them = attached.length === 1 ? 'it' : 'them';
  const before =
    blocks === 'delete'
      ? `deleting ${paying.name}`
      : `moving ${paying.name} to Starter`;
  return new ConflictException({
    code: ORGANIZATIONS_ATTACHED,
    message:
      `${paying.name} pays for ${listOf(attached.map((one) => one.name))}. ` +
      `Delete ${them}, or stop paying for ${them}, before ${before}`,
  });
}

/**
 * Refuses with `ORGANIZATIONS_ATTACHED` while any Organization is attached
 * to this one, whatever its own state: a frozen Paying Organization is
 * refused too, since deleting it would take its customers' Organizations
 * with it (the database's `RESTRICT` refuses it anyway; this says why).
 */
export async function assertNothingAttached(
  db: DrizzleDB,
  organizationId: string,
  blocks: AttachedBlocks,
): Promise<void> {
  const attached = await organizationsAttachedTo(db, organizationId);
  if (attached.length === 0) return;
  throw organizationsAttached(
    { id: organizationId, name: await organizationNameOf(db, organizationId) },
    attached,
    blocks,
  );
}

/**
 * Who is refused: a customer's owner or admin at Checkout, a plan change or
 * Add-ons, or an Operator turning Enterprise on.
 */
export type PaidByAnotherBlocks = 'billing' | 'enterprise';

/** `PAID_BY_ANOTHER_ORGANIZATION`, naming who pays for `attached`. */
export function paidByAnotherOrganization(
  attached: NamedOrganization,
  paying: NamedOrganization,
  blocks: PaidByAnotherBlocks,
): ConflictException {
  const paidBy = `${attached.name} is paid by ${paying.name}`;
  return new ConflictException({
    code: PAID_BY_ANOTHER_ORGANIZATION,
    message:
      blocks === 'enterprise'
        ? `${paidBy}. Turn Enterprise on for ${paying.name}, or ${attached.name}'s owner first pays for it themselves`
        : `${paidBy}. Only the owners and admins of ${paying.name} change its plan or Add-ons`,
  });
}

/**
 * Refuses with `PAID_BY_ANOTHER_ORGANIZATION` when this Organization is
 * attached: its plan, Add-ons and Enterprise counts are its Paying
 * Organization's, so nothing is bought, changed or switched on for it alone.
 * One query, for its name and its payer's.
 */
export async function assertNotPaidByAnother(
  db: DrizzleDB,
  organizationId: string,
  blocks: PaidByAnotherBlocks,
): Promise<void> {
  const [row] = await db
    .select({
      name: organization.name,
      payingId: payer.id,
      payingName: payer.name,
    })
    .from(organization)
    .innerJoin(payer, eq(payer.id, organization.paidByOrganizationId))
    .where(eq(organization.id, organizationId))
    .limit(1);
  if (!row) return;
  throw paidByAnotherOrganization(
    { id: organizationId, name: row.name },
    { id: row.payingId, name: row.payingName },
    blocks,
  );
}

/** "A", "A and B", "A, B and C". */
function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
