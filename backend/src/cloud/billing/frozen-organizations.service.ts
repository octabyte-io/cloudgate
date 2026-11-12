import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { organizationOfPlace } from '../../common/work-place';
import type { WorkPlace } from '../../common/work-place';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import { organization } from '../../organizations/organizations.schema';
import { subscription } from './billing.schema';
import { frozenCausesOf, frozenRefusal, standingOf, UNFROZEN } from './frozen';
import { payer } from './paying-organization';
import type { FrozenCause, FrozenStanding, StandingView } from './frozen';

/**
 * "Is this Organization frozen" — the one question (ADR-0052). Every
 * refused write asks it through `FrozenGuard` or the MCP dispatcher, and every
 * path that starts work asks it too (deploys, Cron runs, backups,
 * Uptime checks, Server thresholds, Docker cleanup, cloud runs).
 *
 * Depends only on the database and the instance mode, so any module can
 * inject it without a cycle (it is exported by the global BillingModule). On a
 * Self-hosted instance nothing is ever frozen and nothing is read.
 */
@Injectable()
export class FrozenOrganizations {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly instanceMode: InstanceMode,
  ) {}

  /** The causes the Organization's billing state records; none self-hosted. */
  async causesOf(organizationId: string): Promise<FrozenCause[]> {
    if (!this.instanceMode.isHosted) return [];
    return frozenCausesOf(await this.standingRow(organizationId));
  }

  /** Whether either cause is recorded. Always false self-hosted. */
  async isFrozen(organizationId: string): Promise<boolean> {
    return (await this.causesOf(organizationId)).length > 0;
  }

  /**
   * Refuses with 403 `ORGANIZATION_FROZEN` naming each cause ("Pay to
   * continue", "Suspended. Contact Octabyte") when the Organization is
   * frozen; a no-op otherwise and on a Self-hosted instance.
   */
  async assertNotFrozen(organizationId: string): Promise<void> {
    if (!this.instanceMode.isHosted) return;
    const refusal = frozenRefusal(await this.standingRow(organizationId));
    if (refusal) throw new ForbiddenException(refusal);
  }

  /**
   * {@link isFrozen} of the Organization that owns `place`: the
   * question every path that starts work without a session asks, and skips
   * its work on. Something no Organization owns (the platform host, a row
   * deleted meanwhile) is never frozen. No read at all self-hosted.
   */
  async isFrozenAt(place: WorkPlace): Promise<boolean> {
    if (!this.instanceMode.isHosted) return false;
    const organizationId = await this.organizationOf(place);
    return organizationId !== null && this.isFrozen(organizationId);
  }

  /**
   * {@link assertNotFrozen} of the Organization that owns `place`: for a
   * start that answers someone, so the refusal is what they read.
   */
  async assertNotFrozenAt(place: WorkPlace): Promise<void> {
    if (!this.instanceMode.isHosted) return;
    const organizationId = await this.organizationOf(place);
    if (organizationId !== null) await this.assertNotFrozen(organizationId);
  }

  /**
   * The refusal sentence when the Organization owning `place` is frozen, or
   * `null`: for a start that records its refusal on a row rather than
   * throwing (a queued build, a cloud run).
   */
  async refusalAt(place: WorkPlace): Promise<string | null> {
    if (!this.instanceMode.isHosted) return null;
    const organizationId = await this.organizationOf(place);
    if (organizationId === null) return null;
    return (
      frozenRefusal(await this.standingRow(organizationId))?.message ?? null
    );
  }

  /** What the banner reads (GET /billing/standing); empty self-hosted. */
  async standingOf(organizationId: string): Promise<StandingView> {
    if (!this.instanceMode.isHosted) return UNFROZEN;
    return standingOf(await this.standingRow(organizationId));
  }

  private organizationOf(place: WorkPlace): Promise<string | null> {
    return organizationOfPlace(this.db, place);
  }

  /**
   * The Organization's own row, and, when it is an Attached Organization,
   * its Paying Organization's name, status and lapse — one query through the
   * "paid by" link (ADR-0059). The payer's suspension is not selected:
   * it never reaches an Attached Organization.
   */
  private async standingRow(
    organizationId: string,
  ): Promise<FrozenStanding | null> {
    const own = alias(subscription, 'own_subscription');
    const payerSubscription = alias(subscription, 'paying_subscription');
    const [row] = await this.db
      .select({
        status: own.status,
        lapsedAt: own.lapsedAt,
        suspendedAt: own.suspendedAt,
        suspendedReason: own.suspendedReason,
        payerName: payer.name,
        payerStatus: payerSubscription.status,
        payerLapsedAt: payerSubscription.lapsedAt,
      })
      .from(organization)
      .leftJoin(own, eq(own.organizationId, organization.id))
      .leftJoin(payer, eq(payer.id, organization.paidByOrganizationId))
      .leftJoin(
        payerSubscription,
        eq(payerSubscription.organizationId, payer.id),
      )
      .where(eq(organization.id, organizationId))
      .limit(1);
    if (!row) return null;
    return {
      status: row.status,
      lapsedAt: row.lapsedAt,
      suspendedAt: row.suspendedAt,
      suspendedReason: row.suspendedReason,
      payingOrganization:
        row.payerName === null
          ? null
          : {
              name: row.payerName,
              status: row.payerStatus,
              lapsedAt: row.payerLapsedAt,
            },
    };
  }
}
