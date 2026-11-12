import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { AuditLogService } from '../../enterprise/audit-logs/audit-log.service';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import { organizationNameOf } from '../../organizations/organization-name';
import { organization } from '../../organizations/organizations.schema';
import { PermissionService } from '../../rbac/permission.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { subscription } from './billing.schema';
import { BoughtServerClockSteps } from './bought-server-clock-steps';
import { deletionDueAt } from './lapse-clock';
import { LapseNotifications } from './lapse-notifications.service';

/** What "Stop paying for it" answers: when the detached Organization lapsed, and when it is deleted unless its owner pays. */
export interface StoppedPaying {
  organizationId: string;
  /** ISO 8601. */
  lapsedAt: string;
  /** ISO 8601: day 30 of its own lapse. */
  deletesOn: string;
}

/**
 * **"Stop paying for it"** (ADR-0059): the Paying Organization's
 * owners and admins detach an Attached Organization.
 *
 * In one transaction it clears `paid_by_organization_id` and sets `lapsedAt`
 * on the Attached Organization's **own** `subscription` row. From then on it
 * is an ordinary lapsed Organization that pays for itself: frozen at once
 * (`frozen.ts` reads its own lapse), out of the pool (`poolOf` follows the
 * link), on its own 30-day clock (`LapseClockService` reads its own row),
 * and lifted by its own Checkout — never with a Free trial, since its
 * `firstAttachedAt` is never cleared. Its owner counts it as an Organization
 * they pay for themselves (`organizationsPayingForThemselvesOwnedBy`).
 *
 * After the commit, `stoppedPaying` goes into both logs as the caller, who is
 * usually no member of the Attached Organization (`recordLinkEvent` names
 * the Organization they acted from), and its owner is emailed. Its
 * **Bought Servers** are deleted at once, as any lapse deletes them
 * (ADR-0071, #1398), their lines taken off this plan's subscription.
 *
 * The one seam both callers use: the "Organizations on this plan" table and
 * the "Before <Paying> can move to Starter" checklist's Detach.
 */
@Injectable()
export class StopPaying {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly instanceMode: InstanceMode,
    private readonly auditLogs: AuditLogService,
    private readonly notifications: LapseNotifications,
    private readonly boughtServerSteps: BoughtServerClockSteps,
  ) {}

  /**
   * Detaches `attachedOrganizationId` from the caller's active Organization.
   * The caller's role there is asked first, so nobody else learns what it
   * pays for: 403 "Only owners and admins can stop paying for an
   * Organization". 404 when the Organization is not attached to it — never
   * was, already detached, or its owner's own subscription ended the link.
   */
  async stopPaying(
    ctx: PermissionCtx,
    attachedOrganizationId: string,
    ip?: string,
  ): Promise<StoppedPaying> {
    if (!this.instanceMode.isHosted) {
      throw new BadRequestException(
        'This feature is only available in Cloudgate Cloud',
      );
    }
    const caller = await this.permissions.findMember(ctx);
    if (caller.role !== 'owner' && caller.role !== 'admin') {
      throw new ForbiddenException(
        'Only owners and admins can stop paying for an Organization',
      );
    }
    const payingOrganizationId = ctx.session.activeOrganizationId;
    const lapsedAt = new Date();

    const detached = await this.db.transaction(async (tx) => {
      // Conditional on the link still pointing here: a second click, the
      // owner's own subscription ending the link, or the payer's day-30
      // deletion (which holds these rows `for no key update`) finds nothing.
      const [row] = await tx
        .update(organization)
        .set({ paidByOrganizationId: null })
        .where(
          and(
            eq(organization.id, attachedOrganizationId),
            eq(organization.paidByOrganizationId, payingOrganizationId),
          ),
        )
        .returning({ id: organization.id });
      if (!row) return false;

      // Its own row exists from the attach; the upsert keeps a hand-made
      // link from failing here. A suspension on it stays: only an Operator
      // lifts that, and it holds the clock while it lasts.
      const lapse = {
        lapsedAt,
        paymentFailedAt: null,
        lapseWarnedAt: null,
        deletionWarnedAt: null,
      };
      await tx
        .insert(subscription)
        .values({
          organizationId: attachedOrganizationId,
          firstAttachedAt: lapsedAt,
          ...lapse,
        })
        .onConflictDoUpdate({
          target: subscription.organizationId,
          set: lapse,
        });
      return true;
    });
    if (!detached) {
      throw new NotFoundException('This Organization is not on this plan');
    }

    await this.auditLogs.recordLinkEvent(
      {
        userId: ctx.user.id,
        actedFromOrganizationId: payingOrganizationId,
        ip,
      },
      {
        event: 'stoppedPaying',
        attachedOrganizationId,
        payingOrganizationId,
      },
    );

    const deletesOn = deletionDueAt({
      status: null,
      paymentFailedAt: null,
      lapseWarnedAt: null,
      lapsedAt,
      deletionWarnedAt: null,
      suspendedAt: null,
    })!;
    // A failed send is logged and skipped inside, never failing the detach.
    await this.notifications.sendStoppedPaying(
      attachedOrganizationId,
      await organizationNameOf(this.db, payingOrganizationId),
      deletesOn,
    );
    // Its Bought Servers go now, their lines off this plan's subscription
    // (ADR-0071): the confirm said so first.
    await this.boughtServerSteps.lapsed(
      attachedOrganizationId,
      lapsedAt,
      payingOrganizationId,
    );

    return {
      organizationId: attachedOrganizationId,
      lapsedAt: lapsedAt.toISOString(),
      deletesOn: deletesOn.toISOString(),
    };
  }
}
