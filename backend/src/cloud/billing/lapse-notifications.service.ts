import { Inject, Injectable, Logger } from '@nestjs/common';
import { format } from 'date-fns';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type Stripe from 'stripe';
import { user } from '../../auth/auth.schema';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { MailService } from '../../mail/mail.service';
import {
  renderBoughtServerSetupFailedEmail,
  renderCustomRolesStoppedEmail,
  renderLapseEmail,
  renderStoppedPayingEmail,
  renderSuspensionEmail,
  renderTrialEndingEmail,
  renderTrialStartedEmail,
} from '../../mail/templates';
import type {
  BusinessEndedCause,
  PlanEndedCause,
  RenderedEmail,
  SuspensionEmail,
} from '../../mail/templates';
import {
  displayName,
  strandedMembersOf,
} from '../../enterprise/license/license-lapse.service';
import { member, organization } from '../../organizations/organizations.schema';
import {
  BillingNotificationsService,
  formatAmount,
} from './billing-notifications.service';
import { BillingConfig } from './billing.config';
import { PLAN_LABELS } from './billing.plans';
import type { PlanName } from './billing.plans';
import type { MonthlyAmount } from './free-trial';

/** One owner or admin a lapse email goes to. */
export interface LapseRecipient {
  email: string;
  name: string;
}

/** Who a lapse email names and goes to, read before anything is deleted. */
export interface LapseAudience {
  organizationName: string;
  recipients: LapseRecipient[];
}

/**
 * Everyone a Paying Organization's lapse emails go to (ADR-0059): its
 * own owners and admins, and each Attached Organization's, oldest first.
 * An Organization with nothing attached has an empty `attached`.
 */
export interface LapseAudiences {
  paying: LapseAudience;
  attached: LapseAudience[];
}

/**
 * A lapse email, with its dates still dates: the payment failed (once per
 * failing stretch), 3 days before the lapse, the lapse itself — "lapsed" or
 * "your plan has ended", after a cancel or the end of an Enterprise agreement
 * —, 7 days before deletion, and deleted.
 */
export type LapseNoticeInput =
  | { kind: 'lapse-warning'; lapsesOn: Date }
  | { kind: 'lapsed' | 'deletion-warning'; deletesOn: Date }
  | { kind: 'plan-ended'; deletesOn: Date; cause?: PlanEndedCause }
  | { kind: 'deleted' };

/**
 * A free-trial email: the trial started, or ends in 7 days. Both name
 * the end date, and the plan, Add-ons and monthly amount held when sent;
 * `monthly` is null when Stripe's prices could not be totalled.
 */
export interface TrialNoticeInput {
  kind: 'trial-started' | 'trial-ending';
  endsOn: Date;
  plan: PlanName;
  addOns: number;
  monthly: MonthlyAmount | null;
}

/**
 * Cloudgate's own Frozen Organization emails (ADR-0052): to the owner
 * and every admin, always, never opt-in — unlike the paid-invoice email, which
 * stays the opt-in `sendInvoiceNotifications`. Stripe's own payment-failure
 * emails are turned off in Stripe's settings (docs/deploy), so these are the
 * only ones.
 *
 * A send that fails is logged and the next recipient still gets theirs: the
 * webhook must answer 200 and the daily tick must reach every Organization.
 */
@Injectable()
export class LapseNotifications {
  private readonly logger = new Logger(LapseNotifications.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly mail: MailService,
    private readonly config: BillingConfig,
    private readonly invoices: BillingNotificationsService,
  ) {}

  /**
   * The Organization's name and its owner and admins — people only, an
   * Agent has no inbox. The `ownerId` owner is included even without an owner
   * `member` row. `roles` narrows it: the suspension emails go to owners only.
   */
  async audienceOf(
    organizationId: string,
    roles: readonly string[] = ['owner', 'admin'],
  ): Promise<LapseAudience> {
    const [org] = await this.db
      .select({ name: organization.name, ownerId: organization.ownerId })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    if (!org) return { organizationName: '', recipients: [] };

    const admins = await this.db
      .select({ id: user.id, email: user.email, name: user.firstName })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(
        and(
          eq(member.organizationId, organizationId),
          inArray(member.role, [...roles]),
          eq(user.kind, 'human'),
        ),
      );
    const owner = await this.db
      .select({ id: user.id, email: user.email, name: user.firstName })
      .from(user)
      .where(and(eq(user.id, org.ownerId), eq(user.kind, 'human')))
      .limit(1);

    const byEmail = new Map<string, LapseRecipient>();
    for (const person of [...owner, ...admins]) {
      byEmail.set(person.email, { email: person.email, name: person.name });
    }
    return { organizationName: org.name, recipients: [...byEmail.values()] };
  }

  /**
   * The Organization's own audience and every Attached Organization's,
   * read now — before a deletion, so the deleted email still has them.
   */
  async lapseAudiencesOf(organizationId: string): Promise<LapseAudiences> {
    const attachedIds = await this.db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.paidByOrganizationId, organizationId))
      .orderBy(asc(organization.createdAt), asc(organization.id));
    const [paying, ...attached] = await Promise.all(
      [organizationId, ...attachedIds.map((row) => row.id)].map((id) =>
        this.audienceOf(id),
      ),
    );
    return { paying, attached };
  }

  /**
   * The payment-failed email, with the invoice that failed: to the
   * Organization's own owners and admins only. An Attached Organization's
   * people are never asked to fix a card that is not theirs (ADR-0059);
   * their Billing page says the payment is failing instead.
   */
  async sendPaymentFailed(
    organizationId: string,
    invoice: Stripe.Invoice,
  ): Promise<void> {
    const { recipients } = await this.audienceOf(organizationId);
    for (const recipient of recipients) {
      await this.invoices.sendPaymentFailed(invoice, recipient);
    }
  }

  /**
   * One of the other four, to the Organization's owners and admins and to
   * every Attached Organization's (ADR-0059), theirs worded "the plan
   * <Paying Organization> pays for this Organization with…". Every path that
   * writes a lapse writes it on the Paying Organization's row only, and sends
   * from here, so none of them has to know who is attached. `audiences` is
   * passed when it was read earlier — the deleted email's, before the
   * Organizations' rows went.
   */
  async send(
    organizationId: string,
    notice: LapseNoticeInput,
    audiences?: LapseAudiences,
  ): Promise<void> {
    const { paying, attached } =
      audiences ?? (await this.lapseAudiencesOf(organizationId));
    const billingUrl = `${this.config.siteUrl}/settings/billing`;
    const formatted =
      notice.kind === 'deleted'
        ? notice
        : notice.kind === 'lapse-warning'
          ? { kind: notice.kind, lapsesOn: formatDate(notice.lapsesOn) }
          : { ...notice, deletesOn: formatDate(notice.deletesOn) };

    await this.deliver(notice.kind, paying.recipients, (recipient) =>
      renderLapseEmail({
        userName: recipient.name,
        organizationName: paying.organizationName,
        billingUrl,
        notice: formatted,
      }),
    );
    for (const one of attached) {
      await this.deliver(notice.kind, one.recipients, (recipient) =>
        renderLapseEmail({
          userName: recipient.name,
          organizationName: one.organizationName,
          payingOrganizationName: paying.organizationName,
          billingUrl,
          notice: formatted,
        }),
      );
    }
  }

  /**
   * "Stop paying for it" (ADR-0059): the detached Organization's
   * owner is told it is frozen, has left the plan, and is deleted on
   * `deletesOn` unless they pay. Its owner only — the one who can pay for it;
   * its admins and the Paying Organization's people get nothing (the PRD's
   * "Notices").
   */
  async sendStoppedPaying(
    organizationId: string,
    payingOrganizationName: string,
    deletesOn: Date,
  ): Promise<void> {
    const [org] = await this.db
      .select({
        name: organization.name,
        email: user.email,
        userName: user.firstName,
      })
      .from(organization)
      .innerJoin(user, eq(user.id, organization.ownerId))
      .where(and(eq(organization.id, organizationId), eq(user.kind, 'human')))
      .limit(1);
    if (!org) return;
    const billingUrl = `${this.config.siteUrl}/settings/billing`;
    await this.deliver(
      'stopped-paying',
      [{ email: org.email, name: org.userName }],
      () =>
        renderStoppedPayingEmail({
          userName: org.userName,
          organizationName: org.name,
          payingOrganizationName,
          billingUrl,
          deletesOn: formatDate(deletesOn),
        }),
    );
  }

  /**
   * An Operator suspended the Organization, or lifted its suspension
   * (ADR-0050): to every owner.
   */
  async sendSuspension(
    organizationId: string,
    notice: SuspensionEmail,
  ): Promise<void> {
    const { organizationName, recipients } = await this.audienceOf(
      organizationId,
      ['owner'],
    );
    const billingUrl = `${this.config.siteUrl}/settings/billing`;
    await this.deliver(notice.kind, recipients, (recipient) =>
      renderSuspensionEmail({
        userName: recipient.name,
        organizationName,
        billingUrl,
        notice,
      }),
    );
  }

  /**
   * The Organization stopped having the Business features (ADR-0054):
   * every owner and admin is told, once, who is left on a custom role, which
   * grants nothing below Business. Nothing is sent when nobody holds one.
   *
   * The one call for every way an Organization leaves Business: a downgrade
   * to Starter taking effect, a lapse of a Business plan, and an Operator
   * switching Enterprise off. Each caller sends it once, beside the write
   * that ended Business.
   */
  async sendCustomRolesStopped(
    organizationId: string,
    cause: BusinessEndedCause,
  ): Promise<void> {
    const stranded = await strandedMembersOf(this.db, organizationId);
    if (stranded.length === 0) return;
    const holders = stranded.map((person) => ({
      name: displayName(person),
      email: person.email,
      role: person.role,
    }));
    const { organizationName, recipients } =
      await this.audienceOf(organizationId);
    const membersUrl = `${this.config.siteUrl}/settings/members`;
    await this.deliver('custom-roles-stopped', recipients, (recipient) =>
      renderCustomRolesStoppedEmail({
        userName: recipient.name,
        organizationName,
        cause,
        holders,
        membersUrl,
      }),
    );
  }

  /**
   * A free-trial email (ADR-0052 amended): "your trial has started"
   * or "your trial ends in 7 days", to the owner and every admin, never
   * opt-in. The caller claims its sent mark first, so each goes out once.
   */
  async sendTrial(
    organizationId: string,
    notice: TrialNoticeInput,
  ): Promise<void> {
    const { organizationName, recipients } =
      await this.audienceOf(organizationId);
    const billingUrl = `${this.config.siteUrl}/settings/billing`;
    const render =
      notice.kind === 'trial-started'
        ? renderTrialStartedEmail
        : renderTrialEndingEmail;
    await this.deliver(notice.kind, recipients, (recipient) =>
      render({
        userName: recipient.name,
        organizationName,
        planLabel: PLAN_LABELS[notice.plan],
        addOns: notice.addOns,
        monthly: notice.monthly
          ? formatAmount(notice.monthly.amount, notice.monthly.currency)
          : null,
        endsOn: formatDate(notice.endsOn),
        billingUrl,
      }),
    );
  }

  /**
   * A Bought Server's first Setup run failed (spec #1387): to every
   * Operator, the owners and admins of the Instance organization, so
   * Octabyte can help before the customer leaves. Nothing is sent where
   * there is no Instance organization.
   */
  async sendBoughtServerSetupFailed(
    operatorsOrganizationId: string | null,
    facts: {
      organizationId: string;
      serverName: string;
      serverId: string;
      failure: string;
    },
  ): Promise<void> {
    if (!operatorsOrganizationId) return;
    const { recipients } = await this.audienceOf(operatorsOrganizationId);
    const [customer] = await this.db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, facts.organizationId))
      .limit(1);
    const operatorUrl = `${this.config.siteUrl}/settings/operator`;
    await this.deliver('bought-server-setup-failed', recipients, (recipient) =>
      renderBoughtServerSetupFailedEmail({
        userName: recipient.name,
        organizationName: customer?.name ?? facts.organizationId,
        serverName: facts.serverName,
        serverId: facts.serverId,
        failure: facts.failure,
        operatorUrl,
      }),
    );
  }

  /** Renders and sends one email per recipient; a failure is logged and skipped. */
  private async deliver(
    kind: string,
    recipients: LapseRecipient[],
    render: (recipient: LapseRecipient) => Promise<RenderedEmail>,
  ): Promise<void> {
    for (const recipient of recipients) {
      try {
        await this.mail.send(recipient.email, await render(recipient));
      } catch (error) {
        this.logger.error(
          `Failed to send the ${kind} email to ${recipient.email}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

/** A clock date as the emails print it. */
function formatDate(at: Date): string {
  return format(at, 'MMM dd, yyyy');
}
