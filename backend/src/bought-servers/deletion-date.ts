import { ConflictException } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { subscription } from '../cloud/billing/billing.schema';
import {
  deletionCausesOf,
  deletionDueOf,
  shownDeletionDateOf,
} from '../cloud/billing/bought-server-clock';
import type { DeletionStepMarks } from '../cloud/billing/bought-server-clock';
import { payingOrganizationIdSql } from '../cloud/billing/paying-organization';
import type { DrizzleDB } from '../db/drizzle.module';
import { organization } from '../organizations/organizations.schema';
import {
  PAY_OPEN_INVOICE_FIRST,
  PAY_OPEN_INVOICE_FIRST_CODE,
} from './buy-plan-state';

/**
 * **The deletion date** of an Organization's Bought Servers, read from the
 * marks (ADR-0071, #1397): never stored, always worked out by
 * `bought-server-clock.ts` from the causes in force. A failed payment, a
 * lapse and a coming cancel are read from the Paying Organization's row,
 * since an Attached Organization's Bought Servers are charged on its
 * payer's invoice; a suspension (#1398) is read from the Organization's own
 * row alone, so the payer's never reaches it. The reminder, deletion and
 * cancel-warning marks are the Organization's own.
 *
 * Plain functions over the tables, like `server-readiness.ts`: the Servers
 * list, the changes, Buy and the daily steps all ask.
 */

/** One Organization's clock: its date and the marks a step reads. */
export interface DeletionClock extends DeletionStepMarks {
  organizationId: string;
  /** When its plan ends by a cancel (the Paying Organization's `cancelAt`). */
  cancelAt: Date | null;
  /** Whether it has lapsed, itself or through its Paying Organization. */
  lapsed: boolean;
  /** `boughtServersLapseWarnedAt` on its own row. */
  lapseWarnedAt: Date | null;
  /**
   * The date shown on its Bought Servers and enforced against costlier
   * changes: `deletesOn`, or a coming cancel's date when that is first.
   */
  shownOn: Date | null;
}

const payingRow = alias(subscription, 'paying_subscription');
const ownRow = alias(subscription, 'own_subscription');

/** The clock of each of these Organizations; one absent from the map does not exist. */
export async function boughtServerClocksOf(
  db: DrizzleDB,
  organizationIds: readonly string[],
): Promise<Map<string, DeletionClock>> {
  const ids = [...new Set(organizationIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      organizationId: organization.id,
      payingPaymentFailedAt: payingRow.boughtServersPaymentFailedAt,
      payingLapsedAt: payingRow.lapsedAt,
      payingCancelAt: payingRow.cancelAt,
      ownSuspendedAt: ownRow.suspendedAt,
      ownLapsedAt: ownRow.lapsedAt,
      dayBeforeSentAt: ownRow.boughtServersDayBeforeSentAt,
      deletedSentAt: ownRow.boughtServersDeletedSentAt,
      lapseWarnedAt: ownRow.boughtServersLapseWarnedAt,
    })
    .from(organization)
    .leftJoin(payingRow, eq(payingRow.organizationId, payingOrganizationIdSql))
    .leftJoin(ownRow, eq(ownRow.organizationId, organization.id))
    .where(inArray(organization.id, ids));
  return new Map(
    rows.map((row) => {
      const due = deletionDueOf(deletionCausesOf(row));
      const clock: DeletionClock = {
        organizationId: row.organizationId,
        deletesOn: due?.deletesOn ?? null,
        dueTo: due?.dueTo ?? null,
        dayBeforeSentAt: row.dayBeforeSentAt,
        deletedSentAt: row.deletedSentAt,
        cancelAt: row.payingCancelAt,
        lapsed: row.ownLapsedAt !== null || row.payingLapsedAt !== null,
        lapseWarnedAt: row.lapseWarnedAt,
        shownOn: null,
      };
      clock.shownOn = shownDeletionDateOf(clock.deletesOn, clock);
      return [row.organizationId, clock];
    }),
  );
}

/**
 * The date this Organization's Bought Servers are due for deletion on, a
 * coming cancel's included, or null.
 */
export async function deletionDateOfOrganization(
  db: DrizzleDB,
  organizationId: string,
): Promise<Date | null> {
  const clocks = await boughtServerClocksOf(db, [organizationId]);
  return clocks.get(organizationId)?.shownOn ?? null;
}

/**
 * Refuses anything that costs more while a deletion date is set (story
 * 54): buying, backups on, more storage, a bigger size. Deleting, backups
 * off and a smaller size stay allowed: they only lower what is owed.
 */
export async function assertNoDeletionDate(
  db: DrizzleDB,
  organizationId: string,
): Promise<void> {
  const clock = (await boughtServerClocksOf(db, [organizationId])).get(
    organizationId,
  );
  if (!clock?.shownOn) return;
  // Only a coming cancel sets it: there is no invoice to pay.
  const cancelOnly =
    !clock.deletesOn || clock.deletesOn.getTime() > clock.shownOn.getTime();
  throw new ConflictException({
    code: PAY_OPEN_INVOICE_FIRST_CODE,
    message: cancelOnly ? PLAN_CANCEL_COMING : PAY_OPEN_INVOICE_FIRST,
  });
}

/** Said when the deletion date is a coming cancel's. */
export const PLAN_CANCEL_COMING =
  'The plan is cancelled, so its Servers will be deleted when it ends. Undo the cancel first';
