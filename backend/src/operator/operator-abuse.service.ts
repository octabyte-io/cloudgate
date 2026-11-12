import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { addHours } from 'date-fns';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { user } from '../auth/auth.schema';
import {
  ABUSE_REPORT_DEADLINE_HOURS,
  abuseReport,
} from '../bought-servers/abuse-report.schema';
import { boughtServer } from '../bought-servers/bought-server.schema';
import type { BoughtServerStage } from '../bought-servers/bought-server.schema';
import { HETZNER_MACHINES } from '../bought-servers/hetzner/hetzner-cloud.port';
import type { HetznerCloudPort } from '../bought-servers/hetzner/hetzner-cloud.port';
import { LapseNotifications } from '../cloud/billing/lapse-notifications.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { MailService } from '../mail/mail.service';
import { renderAbuseReportEmail } from '../mail/templates/bought-server-abuse';
import type { NamedOrganization } from '../organizations/organization-name';
import { organization } from '../organizations/organizations.schema';
import { OperatorService } from './operator.service';
import type { OperatorCtx } from './operator.service';

/** An open abuse report as the Operator page lists it. */
export interface AbuseReportView {
  id: string;
  organization: NamedOrganization;
  report: string;
  forwardedAt: Date;
  /** 24 hours after it was forwarded; past it, the Operator decides on a suspension. */
  deadlineAt: Date;
  /** The Operator who forwarded it, by sign-in address; null once the account is gone. */
  forwardedBy: string | null;
}

/** A Bought Server's power-off for abuse, as both sides see it. */
export interface PowerOffView {
  poweredOffAt: Date;
  reason: string;
}

/**
 * The stages in which a Bought Server has a machine an Operator may power
 * off or on. A change running powers the machine off and on by itself, and
 * Deleting is already taking it away, so neither is offered.
 */
const POWERED_STAGES: BoughtServerStage[] = ['setting_up', 'ready'];

/** Said when the Server has no machine to power off or on in its stage. */
const NOT_POWERABLE =
  'This Bought Server has no running machine to power off or on in its stage';

/**
 * The Operator's abuse actions on the Hosted instance (ADR-0071, spec #1387,
 * #1401), all through the Operator write path, so each is in the target
 * Organization's audit log and the Instance organization's:
 *
 * - **Forward abuse report**: the report text goes to the Organization's
 *   owners and admins with a 24-hour deadline, and stays open on the
 *   Operator page until an Operator closes it. Suspending stays the
 *   Operator's own, separate action.
 * - **Power off** a Bought Server at once, with a reason the customer sees,
 *   for an attack still going on. Only an Operator powers it back on.
 *
 * Neither gives anybody access to the machine (ADR-0050): power off and on
 * are the provider's own buttons, and nothing here reads the machine, its
 * address or its key.
 */
@Injectable()
export class OperatorAbuse {
  private readonly logger = new Logger(OperatorAbuse.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(HETZNER_MACHINES) private readonly machines: HetznerCloudPort,
    private readonly operator: OperatorService,
    private readonly audiences: LapseNotifications,
    private readonly mail: MailService,
  ) {}

  /**
   * Forwards the report to the Organization's owners and admins with a
   * deadline 24 hours from now, stores it open, and audits it with the
   * report and the deadline.
   */
  async forward(
    ctx: OperatorCtx,
    organizationId: string,
    report: string,
  ): Promise<AbuseReportView> {
    await this.operator.assertOperator(ctx);
    const target = await this.operator.targetOf(organizationId);

    const forwardedAt = new Date();
    const deadlineAt = addHours(forwardedAt, ABUSE_REPORT_DEADLINE_HOURS);
    const [row] = await this.db
      .insert(abuseReport)
      .values({
        organizationId,
        report,
        forwardedAt,
        deadlineAt,
        forwardedBy: ctx.user.id,
      })
      .returning();

    await this.operator.recordWrite(ctx, target, {
      type: 'forwardAbuseReport',
      abuseReportId: row.id,
      deadlineAt: deadlineAt.toISOString(),
      report,
    });
    await this.sendReport(organizationId, report, deadlineAt);

    const [forwarder] = await this.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, ctx.user.id))
      .limit(1);
    return {
      id: row.id,
      organization: target,
      report,
      forwardedAt,
      deadlineAt,
      forwardedBy: forwarder?.email ?? null,
    };
  }

  /** Every open abuse report, the nearest deadline first. */
  async listOpen(ctx: OperatorCtx): Promise<AbuseReportView[]> {
    await this.operator.assertOperator(ctx);
    const rows = await this.db
      .select({
        id: abuseReport.id,
        organizationId: organization.id,
        organizationName: organization.name,
        report: abuseReport.report,
        forwardedAt: abuseReport.forwardedAt,
        deadlineAt: abuseReport.deadlineAt,
        forwardedBy: user.email,
      })
      .from(abuseReport)
      .innerJoin(organization, eq(organization.id, abuseReport.organizationId))
      .leftJoin(user, eq(user.id, abuseReport.forwardedBy))
      .where(isNull(abuseReport.closedAt))
      .orderBy(asc(abuseReport.deadlineAt), asc(abuseReport.id));
    return rows.map((row) => ({
      id: row.id,
      organization: { id: row.organizationId, name: row.organizationName },
      report: row.report,
      forwardedAt: row.forwardedAt,
      deadlineAt: row.deadlineAt,
      forwardedBy: row.forwardedBy,
    }));
  }

  /** Closes an open report, answered or acted on; audited on both sides. */
  async close(ctx: OperatorCtx, abuseReportId: string): Promise<void> {
    await this.operator.assertOperator(ctx);
    const [found] = await this.db
      .select({ organizationId: abuseReport.organizationId })
      .from(abuseReport)
      .where(eq(abuseReport.id, abuseReportId))
      .limit(1);
    if (!found) throw new NotFoundException('Abuse report not found');
    const target = await this.operator.targetOf(found.organizationId);

    const [closed] = await this.db
      .update(abuseReport)
      .set({ closedAt: new Date(), closedBy: ctx.user.id })
      .where(
        and(eq(abuseReport.id, abuseReportId), isNull(abuseReport.closedAt)),
      )
      .returning({ id: abuseReport.id });
    if (!closed) {
      throw new ConflictException('This abuse report is already closed');
    }
    await this.operator.recordWrite(ctx, target, {
      type: 'closeAbuseReport',
      abuseReportId,
    });
  }

  /**
   * Powers the machine off at once and marks the Bought Server powered off
   * with the reason its Server page shows. The mark is claimed first, so a
   * second press is refused, and given back if the provider refuses.
   */
  async powerOff(
    ctx: OperatorCtx,
    boughtServerId: string,
    reason: string,
  ): Promise<PowerOffView> {
    await this.operator.assertOperator(ctx);
    const row = await this.find(boughtServerId);
    const target = await this.operator.targetOf(row.organizationId);

    const poweredOffAt = new Date();
    const [claimed] = await this.db
      .update(boughtServer)
      .set({ poweredOffAt, poweredOffReason: reason })
      .where(
        and(
          eq(boughtServer.id, row.id),
          isNull(boughtServer.poweredOffAt),
          inArray(boughtServer.stage, POWERED_STAGES),
          isNotNull(boughtServer.providerServerId),
        ),
      )
      .returning({ providerServerId: boughtServer.providerServerId });
    if (!claimed) {
      throw new ConflictException(
        row.poweredOffAt ? `${row.name} is already powered off` : NOT_POWERABLE,
      );
    }

    const failure = await this.ask('power off', () =>
      this.machines.powerOff(claimed.providerServerId!),
    );
    if (failure) {
      await this.db
        .update(boughtServer)
        .set({ poweredOffAt: null, poweredOffReason: null })
        .where(eq(boughtServer.id, row.id));
      throw new BadGatewayException(failure);
    }

    await this.operator.recordWrite(ctx, target, {
      type: 'powerOffBoughtServer',
      serverId: row.id,
      serverName: row.name,
      reason,
    });
    return { poweredOffAt, reason };
  }

  /** Powers the machine back on and clears the mark; only an Operator can. */
  async powerOn(ctx: OperatorCtx, boughtServerId: string): Promise<void> {
    await this.operator.assertOperator(ctx);
    const row = await this.find(boughtServerId);
    const target = await this.operator.targetOf(row.organizationId);
    if (!row.poweredOffAt) {
      throw new ConflictException(`${row.name} is not powered off`);
    }
    if (!POWERED_STAGES.includes(row.stage) || !row.providerServerId) {
      throw new ConflictException(NOT_POWERABLE);
    }

    const failure = await this.ask('power on', () =>
      this.machines.powerOn(row.providerServerId!),
    );
    if (failure) throw new BadGatewayException(failure);

    const [cleared] = await this.db
      .update(boughtServer)
      .set({ poweredOffAt: null, poweredOffReason: null })
      .where(
        and(eq(boughtServer.id, row.id), isNotNull(boughtServer.poweredOffAt)),
      )
      .returning({ id: boughtServer.id });
    if (!cleared) {
      throw new ConflictException(`${row.name} is not powered off`);
    }
    await this.operator.recordWrite(ctx, target, {
      type: 'powerOnBoughtServer',
      serverId: row.id,
      serverName: row.name,
    });
  }

  private async find(id: string) {
    const [row] = await this.db
      .select()
      .from(boughtServer)
      .where(eq(boughtServer.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Bought Server not found');
    return row;
  }

  /**
   * Asks the provider; null when it did it, else the refusal for the
   * Operator, who may see the provider's words.
   */
  private async ask(
    what: string,
    call: () => Promise<
      { ok: true } | { ok: false; code: string; message: string }
    >,
  ): Promise<string | null> {
    try {
      const answer = await call();
      if (answer.ok) return null;
      return `The provider refused to ${what} the machine: ${answer.code}: ${answer.message}`;
    } catch (error) {
      this.logger.error(
        `The provider could not be asked to ${what} a machine: ${(error as Error).message}`,
      );
      return `The provider could not be reached to ${what} the machine. Try again`;
    }
  }

  /** The report to every owner and admin; a failed send is logged and skipped. */
  private async sendReport(
    organizationId: string,
    report: string,
    deadline: Date,
  ): Promise<void> {
    const { organizationName, recipients } =
      await this.audiences.audienceOf(organizationId);
    for (const recipient of recipients) {
      try {
        await this.mail.send(
          recipient.email,
          await renderAbuseReportEmail({
            userName: recipient.name,
            organizationName,
            report,
            deadline,
          }),
        );
      } catch (error) {
        this.logger.error(
          `Failed to send the abuse report email to ${recipient.email}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
