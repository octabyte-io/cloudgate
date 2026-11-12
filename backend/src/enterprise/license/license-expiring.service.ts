import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import { user } from '../../auth/auth.schema';
import { canSendMail } from '../../auth/mail-configured';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import { MailService } from '../../mail/mail.service';
import { renderLicenseExpiringEmail } from '../../mail/templates';
import { NotificationDispatcherService } from '../../notifications/dispatcher.service';
import { formatEventTime } from '../../notifications/events/event-time';
import type { LicenseExpiringEvent } from '../../notifications/events/notification-event';
import { member, organization } from '../../organizations/organizations.schema';
import { InstanceUrlService } from '../../settings/instance-url.service';
import { dueExpiryWarning } from './license-expiry';
import type { ExpiryWarning } from './license-expiry';
import { licenseKey } from './license.schema';
import { STOPPED_BY_LAPSE } from './paid-features';

/** One warning a pass sent. */
export interface LicenseExpiringWarning {
  organizationId: string;
  organizationName: string;
  validUntil: Date;
  daysLeft: ExpiryWarning;
}

/**
 * What the warning says beyond its facts: what stops on the date, and that a
 * renewal needs nothing pasted. Shared by every channel through the event.
 */
export const EXPIRING_GUIDANCE =
  `When it expires, these stop until it is renewed: ${STOPPED_BY_LAPSE.join('; ')}. ` +
  `Everything is kept as it was. Renew it with Octabyte: the instance ` +
  `re-checks its key daily, so a renewal reaches it without the key being ` +
  `pasted again.`;

export function toExpiringEvent(
  warning: LicenseExpiringWarning,
): LicenseExpiringEvent {
  return {
    type: 'license-expiring',
    organizationId: warning.organizationId,
    organizationName: warning.organizationName,
    validUntil: warning.validUntil.toISOString(),
    daysLeft: warning.daysLeft,
    message: EXPIRING_GUIDANCE,
  };
}

/**
 * Warns a Self-hosted organization 14 and 3 days before its license's
 * `validUntil` (ADR-0054): the `license-expiring` event to the channels
 * that ticked it, and a direct email to every owner when the instance can send
 * mail — that one not opt-in, because the owner is who renews.
 *
 * It runs inside the daily re-check (`LicenseRecheckService.tick`), after the
 * re-activations, so a renewal the license server already knows about moves
 * `validUntil` out of the window first and nobody is warned about a date that
 * no longer stands.
 *
 * **Once per point.** The `validUntil` each warning went out for is stored on
 * the `license_key` row (`expiryWarned14For`, `expiryWarned3For`), the way
 * `lapseReportedFor` marks a lapse, so a renewal re-arms both. When both are
 * owed at once (a license activated with days to go, or an instance that was
 * down), only the 3-day one goes, and both are marked.
 *
 * Delivery failures are logged and swallowed and the marks are written all the
 * same: an unmarked warning would repeat on every pass.
 */
@Injectable()
export class LicenseExpiringService {
  private readonly logger = new Logger(LicenseExpiringService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly instanceMode: InstanceMode,
    private readonly dispatcher: NotificationDispatcherService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly instanceUrl: InstanceUrlService,
  ) {}

  /** Sends every warning owed as of `now`, and returns them. */
  async tick(now: Date = new Date()): Promise<LicenseExpiringWarning[]> {
    if (this.instanceMode.isHosted) return [];

    // `isValid`'s four conditions, with `validUntil` still ahead: a lapse is
    // `license-lapse`'s, and an opted-out or refused key is not expiring.
    const rows = await this.db
      .select({
        organizationId: licenseKey.organizationId,
        organizationName: organization.name,
        validUntil: licenseKey.validUntil,
        warned14For: licenseKey.expiryWarned14For,
        warned3For: licenseKey.expiryWarned3For,
      })
      .from(licenseKey)
      .innerJoin(organization, eq(organization.id, licenseKey.organizationId))
      .where(
        and(
          eq(licenseKey.enableEnterpriseFeatures, true),
          eq(licenseKey.status, 'active'),
          isNotNull(licenseKey.key),
          gt(licenseKey.validUntil, now),
        ),
      );

    const sent: LicenseExpiringWarning[] = [];
    for (const row of rows) {
      const daysLeft = dueExpiryWarning(row.validUntil, row, now);
      if (daysLeft === null || row.validUntil === null) continue;

      const warning: LicenseExpiringWarning = {
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        validUntil: row.validUntil,
        daysLeft,
      };
      await this.notifyChannels(warning);
      await this.emailOwners(warning);

      await this.db
        .update(licenseKey)
        .set(
          daysLeft === 3
            ? {
                expiryWarned14For: row.validUntil,
                expiryWarned3For: row.validUntil,
              }
            : { expiryWarned14For: row.validUntil },
        )
        .where(eq(licenseKey.organizationId, row.organizationId));

      sent.push(warning);
    }
    return sent;
  }

  private async notifyChannels(warning: LicenseExpiringWarning): Promise<void> {
    try {
      await this.dispatcher.dispatch(
        warning.organizationId,
        toExpiringEvent(warning),
      );
    } catch (error) {
      this.logger.error(
        `Could not notify the channels of organization ${warning.organizationId} about its expiring license`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** Every owner, by email, when the instance can send mail at all. */
  private async emailOwners(warning: LicenseExpiringWarning): Promise<void> {
    if (!canSendMail(this.config)) return;

    const base = await this.instanceUrl.getInstanceUrl();
    const licenseUrl = base ? `${base}/settings/license` : null;
    for (const owner of await this.ownersOf(warning.organizationId)) {
      try {
        await this.mail.send(
          owner.email,
          await renderLicenseExpiringEmail({
            userName: owner.name,
            organizationName: warning.organizationName,
            expiresOn: formatEventTime(warning.validUntil),
            stopped: STOPPED_BY_LAPSE,
            licenseUrl,
          }),
        );
      } catch (error) {
        this.logger.warn(
          `Failed to send the license-expiring email to ${owner.email}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * The organization's owners — people only, an Agent has no inbox: the
   * `ownerId` owner and every `owner` member, once each.
   */
  private async ownersOf(
    organizationId: string,
  ): Promise<{ email: string; name: string }[]> {
    const members = await this.db
      .select({ email: user.email, name: user.firstName })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.role, 'owner'),
          eq(user.kind, 'human'),
        ),
      );
    const recorded = await this.db
      .select({ email: user.email, name: user.firstName })
      .from(organization)
      .innerJoin(user, eq(user.id, organization.ownerId))
      .where(and(eq(organization.id, organizationId), eq(user.kind, 'human')));

    const byEmail = new Map<string, { email: string; name: string }>();
    for (const person of [...recorded, ...members]) {
      byEmail.set(person.email, person);
    }
    return [...byEmail.values()];
  }
}
