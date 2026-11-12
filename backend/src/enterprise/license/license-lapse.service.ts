import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { and, eq, isNotNull, lte, notInArray } from 'drizzle-orm';
import { user } from '../../auth/auth.schema';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { NotificationDispatcherService } from '../../notifications/dispatcher.service';
import type { LicenseLapseEvent } from '../../notifications/events/notification-event';
import { member, organization } from '../../organizations/organizations.schema';
import { SchedulingService } from '../../scheduling/scheduling.service';
import { STATIC_ROLES } from '../custom-roles/custom-roles.service';
import { licenseKey } from './license.schema';
import { STOPPED_BY_LAPSE } from './paid-features';

/** The cron job id the check runs under, so a test can prove it is registered. */
export const LICENSE_LAPSE_JOB_ID = 'license-lapse-check';

/**
 * Hourly, seven minutes in. Hourly rather than daily because the whole point is
 * to shorten the gap between "five sections stopped working" and somebody being
 * told why; and it costs one indexed read per hour, because once-per-lapse is
 * enforced by the stored mark rather than by checking rarely.
 */
export const LICENSE_LAPSE_CRON = '7 * * * *';

/** A member a lapsed license has locked out, as the report names them. */
export interface StrandedMember {
  /** The member row id. */
  id: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  /** The custom role they hold, which no longer resolves. */
  role: string;
}

/**
 * One organization whose license has lapsed: what stopped, and who it locked
 * out — `strandedMembers` is empty when nobody holds a custom role, and the
 * lapse is reported all the same.
 */
export interface LicenseLapseReport {
  organizationId: string;
  organizationName: string;
  /** The expiry that passed. */
  validUntil: Date;
  strandedMembers: StrandedMember[];
}

/**
 * The members a lapse strands: everyone in the organization whose role is not
 * one of the three static ones.
 *
 * That is the set `resolveRole` refuses, which is the set that matters — it
 * checks the license *before* looking the role name up, so a member is locked
 * out by holding any non-static role, whether or not an `organization_role`
 * row still defines it. The Roles screen counts the same people by summing
 * each role's `memberCount`; the two answers can only differ for a role name
 * no row defines, which nothing in the product can produce (a role cannot be
 * deleted while anyone holds it).
 *
 * A plain function, not a method: the Self-hosted lapse report here and the
 * Hosted "custom roles have stopped" email (`LapseNotifications`) ask
 * the same question, and the billing module cannot inject this one's service.
 */
export async function strandedMembersOf(
  db: DrizzleDB,
  organizationId: string,
): Promise<StrandedMember[]> {
  return db
    .select({
      id: member.id,
      userId: member.userId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: member.role,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(
      and(
        eq(member.organizationId, organizationId),
        notInArray(member.role, STATIC_ROLES),
      ),
    );
}

/** The account's name, or its email when better-auth recorded no name. */
export function displayName(person: StrandedMember): string {
  return `${person.firstName} ${person.lastName}`.trim() || person.email;
}

/** `Ida Rhodes <ida@example.com> (read-only)`, for a warning a human reads. */
function describeMember(person: StrandedMember): string {
  return `${displayName(person)} <${person.email}> (${person.role})`;
}

/** What the lapse costs the people it stranded. */
function lapseConsequence(count: number): string {
  return (
    `${count} ${count === 1 ? 'member holds' : 'members hold'} a custom role, ` +
    `which cannot resolve without a valid license, so they are refused every ` +
    `permission-checked action — including the ones their role grants`
  );
}

/**
 * Why nobody was moved, and what to do instead.
 *
 * The question "why not just put them on `member`?" is the first one an operator
 * asks, and it was already answered — the static member role grants backups,
 * volumes and environment variables outright, so migrating a deliberately narrow
 * custom role onto it *widens* what its holder can do. Shared by the log warning
 * and the notification body so the answer travels with either one; a test asserts
 * both still carry it.
 */
export const LAPSE_GUIDANCE =
  `Activate a license, or move them to the admin or member role. Nobody was ` +
  `moved automatically: the static member role grants backups, volumes and ` +
  `environment variables outright, so migrating a custom-role holder onto it ` +
  `would silently widen their access.`;

/**
 * What to do about a lapse nobody is locked out by: everything in
 * `STOPPED_BY_LAPSE` is kept and comes back with a license, so there is
 * nothing to move and nobody to tell but whoever can renew it.
 */
export const LAPSE_RENEWAL =
  `Nobody holds a custom role, so nobody is locked out. Everything that ` +
  `stopped is kept as it was and works again once a license is activated.`;

/**
 * The prose after the list of what stopped: the consequence and the guidance
 * when people are locked out, and the renewal line when nobody is.
 */
function lapseAdvice(count: number): string {
  return count === 0
    ? LAPSE_RENEWAL
    : `${lapseConsequence(count)}. ${LAPSE_GUIDANCE}`;
}

/**
 * The warning a lapse produces. It says what stopped, and — only when anybody
 * holds a custom role — who is locked out and why nobody was moved.
 */
export function formatLapseWarning(report: LicenseLapseReport): string {
  const count = report.strandedMembers.length;
  const who = report.strandedMembers.map(describeMember).join(', ');
  const consequence =
    count === 0
      ? LAPSE_RENEWAL
      : `${lapseConsequence(count)}: ${who}. ${LAPSE_GUIDANCE}`;
  return (
    `The enterprise license for organization "${report.organizationName}" ` +
    `(${report.organizationId}) lapsed on ${report.validUntil.toISOString()}. ` +
    `Stopped: ${STOPPED_BY_LAPSE.join('; ')}. ${consequence}`
  );
}

/**
 * The same lapse as a notification event, for the organization's channels.
 *
 * The members stay structured rather than pre-rendered into the log's
 * `Name <email> (role)` line: each channel formats them its own way, and one of
 * them (telegram) parses its body as HTML and would reject the whole message on
 * the angle brackets. `stopped` is structured for the same reason a list is
 * (each channel lays it out its own way), and because folding it into
 * `message` would push that past telegram's per-field bound. `message` carries
 * the consequence and the guidance, because the reason nobody was migrated has
 * to reach whoever is paged and not only whoever later reads the log.
 */
export function toLapseEvent(report: LicenseLapseReport): LicenseLapseEvent {
  return {
    type: 'license-lapse',
    organizationId: report.organizationId,
    organizationName: report.organizationName,
    validUntil: report.validUntil.toISOString(),
    stopped: STOPPED_BY_LAPSE,
    strandedMembers: report.strandedMembers.map((person) => ({
      name: displayName(person),
      email: person.email,
      role: person.role,
    })),
    message: lapseAdvice(report.strandedMembers.length),
  };
}

/**
 * Notices a license lapsing and says so once.
 *
 * **There is no lapse event to hang this off.** Expiry is derived, not stored:
 * `isValid` compares `validUntil` at read time, so a license stops licensing
 * anything without a single write happening — `status` still reads 'active' in
 * the row. Nothing fires, no cron rewrites it, and the state just quietly
 * becomes true. From that moment everything in `STOPPED_BY_LAPSE` stops —
 * SSO sign-in, SCIM adds, forward-auth changes, white-labelling edits, the
 * parallel pools — and, the consequence that answer left standing, every member
 * holding a custom role is refused every `@RequirePermission` route
 * (`PermissionService.resolveRole`). On the Tuesday it happens nobody is looking
 * at the Roles-screen banner or the License page.
 *
 * **Every lapse is reported, not only one that strands somebody.** An
 * organization on the static roles still loses SSO sign-in and the rest, and
 * the people who would be told about that were the ones the old "strands
 * nobody, say nothing" rule kept in the dark. The members are named only when
 * there are any.
 *
 * So the transition is *found* rather than announced, by an hourly check that
 * compares the derived state against what has already been reported.
 *
 * **Once per lapse, not once per check.** A warning that repeats every hour for
 * a license that went last month trains operators to ignore it, so the check
 * cannot be stateless — and in-memory would forget across a restart, which is
 * exactly when this runs. The "already reported" mark therefore lives on the
 * `license_key` row that is already this feature's settings row
 * (`lapseReportedFor`), rather than in a table of its own. It stores the
 * *expiry* it reported, not a flag, so `activate` writing a new `validUntil`
 * re-arms the check without anything having to remember to clear it.
 *
 * **Where it says it.** Two places, and both are load-bearing: the
 * organization's notification channels (`license-lapse`, opted into per channel
 * — the point is that somebody is told on the Tuesday it happens rather
 * than whenever they next open the Roles screen), and `logger.warn`, which is
 * what still says it when no channel was configured or a webhook has since been
 * revoked. One event per lapse covers both, inside the once-per-lapse mark.
 *
 * **What is deliberately not here: a migration off the role.** See
 * `LAPSE_GUIDANCE` — falling back to the static `member` role would widen
 * access, which is worse than refusing it. If you are here to add that
 * fallback, that is why it is not.
 */
@Injectable()
export class LicenseLapseService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LicenseLapseService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly scheduling: SchedulingService,
    private readonly dispatcher: NotificationDispatcherService,
  ) {}

  /**
   * Register the recurring check and run it once, because an instance that was
   * down while a license lapsed should say so as soon as it is up rather than
   * up to an hour later.
   *
   * The whole hook is try/caught and only logs, which is not defensive
   * decoration: `test/app.e2e-spec.ts` boots the full AppModule against an
   * un-migrated database, and so does a real instance between a deploy and its
   * migration — a boot-time query that throws would take the process down over
   * a warning.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      this.scheduling.register(
        LICENSE_LAPSE_JOB_ID,
        LICENSE_LAPSE_CRON,
        null,
        async () => {
          await this.reportNewLapses();
        },
      );
      await this.reportNewLapses();
    } catch (error) {
      this.logger.error('License lapse check failed to start', error);
    }
  }

  /**
   * Find every license that has lapsed since it was last reported on, say what
   * stopped and who it stranded (if anybody), and mark the lapse reported.
   *
   * Returns what it reported this run — one report per lapse, whether or not
   * it stranded anybody; empty when nothing lapsed, and empty on every
   * subsequent run for the same lapse.
   */
  async reportNewLapses(): Promise<LicenseLapseReport[]> {
    const lapsed = await this.findUnreportedLapses();
    const reports: LicenseLapseReport[] = [];

    for (const row of lapsed) {
      const strandedMembers = await strandedMembersOf(
        this.db,
        row.organizationId,
      );

      const report: LicenseLapseReport = {
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        validUntil: row.validUntil,
        strandedMembers,
      };

      // Both, deliberately. The notification is what reaches somebody on the
      // Tuesday this happens; the log line is what survives a channel that was
      // never configured, or was configured wrongly, or whose webhook has since
      // been revoked — and it costs nothing to keep.
      this.logger.warn(formatLapseWarning(report));
      await this.notifyChannels(report);

      await this.db
        .update(licenseKey)
        .set({ lapseReportedFor: row.validUntil })
        .where(eq(licenseKey.organizationId, row.organizationId));

      reports.push(report);
    }

    return reports;
  }

  /**
   * Fan the lapse out to the organization's notification channels — the channels
   * that ticked "An enterprise licence lapsed", and only those.
   *
   * Swallowed on failure, and on purpose. The mark that makes this once-per-lapse
   * is written by the caller straight after, so letting a delivery error escape
   * would leave the lapse unmarked and re-report it — turning the log warning
   * into the hourly noise the stored mark exists to prevent. The dispatcher
   * already isolates per-channel failures; what is caught here is the rarer kind,
   * such as the notification table not being there yet.
   */
  private async notifyChannels(report: LicenseLapseReport): Promise<void> {
    try {
      await this.dispatcher.dispatch(
        report.organizationId,
        toLapseEvent(report),
      );
    } catch (error) {
      this.logger.error(
        `Could not notify the channels of organization ${report.organizationId} about its lapsed license`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Licenses whose `validUntil` has passed and whose lapse has not been
   * reported. The four conditions are `isValid`'s, inverted on the date only:
   * an organization that never opted in, never stored a key, or had its key
   * *refused* (`status: 'invalid'`, which `validate` writes) is not a lapse —
   * those are different states wanting different words, and only expiry
   * happens with nobody doing anything.
   */
  private async findUnreportedLapses() {
    const rows = await this.db
      .select({
        organizationId: licenseKey.organizationId,
        organizationName: organization.name,
        validUntil: licenseKey.validUntil,
        lapseReportedFor: licenseKey.lapseReportedFor,
      })
      .from(licenseKey)
      .innerJoin(organization, eq(organization.id, licenseKey.organizationId))
      .where(
        and(
          eq(licenseKey.enableEnterpriseFeatures, true),
          eq(licenseKey.status, 'active'),
          isNotNull(licenseKey.key),
          isNotNull(licenseKey.validUntil),
          lte(licenseKey.validUntil, new Date()),
        ),
      );

    return rows.filter(
      (row): row is typeof row & { validUntil: Date } =>
        row.validUntil !== null &&
        row.lapseReportedFor?.getTime() !== row.validUntil.getTime(),
    );
  }
}
