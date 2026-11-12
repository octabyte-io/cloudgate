import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { and, eq, inArray, lte, ne } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { member, organization, user } from '../db/schema';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { includesInstanceOrganization } from '../rbac/instance-organization-pin';
import { SchedulingService } from '../scheduling/scheduling.service';

/** The job id the sweep runs under, so a test can run it as its timer would. */
export const UNCONFIRMED_ACCOUNTS_JOB_ID = 'unconfirmed-accounts-sweep';

/** Daily, at 04:41 host time — an hour nothing else on the box is scheduled for. */
export const UNCONFIRMED_ACCOUNTS_CRON = '41 4 * * *';

/** How long a Hosted sign-up has to confirm its email before it is deleted. */
export const UNCONFIRMED_ACCOUNT_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What one sweep deleted. */
export interface UnconfirmedAccountsSwept {
  userIds: string[];
  organizationIds: string[];
}

/**
 * Deletes Hosted sign-ups whose email was never confirmed (ADR-0051).
 *
 * A Hosted sign-up makes an account and an Organization at once
 * (`bootstrapDefaultOrganization`) and the account cannot sign in until its
 * address is confirmed. One still unconfirmed after
 * {@link UNCONFIRMED_ACCOUNT_DAYS} days is abandoned — a typo, a bot, somebody
 * who changed their mind — and is deleted together with its Organization, so
 * those never pile up.
 *
 * **Only an empty Organization goes with it**: one whose members, and whose
 * `ownerId`, are this account alone. An unconfirmed account that belongs to an
 * Organization anyone else is in is left alone entirely — deleting the user
 * would cascade through `organization.owner_id` into an Organization that is
 * somebody else's too, and an account that is part of a team is not an
 * abandoned sign-up. An Agent is never one: it has no email to confirm.
 *
 * **Hosted only.** A Self-hosted instance never confirms an address, so every
 * account it has reads as unconfirmed; the job is not even registered there,
 * and {@link sweep} refuses to run on it as a second guard.
 */
@Injectable()
export class UnconfirmedAccountsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(UnconfirmedAccountsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly scheduling: SchedulingService,
    private readonly instanceMode: InstanceMode,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.instanceMode.isHosted) return;
    this.scheduling.register(
      UNCONFIRMED_ACCOUNTS_JOB_ID,
      UNCONFIRMED_ACCOUNTS_CRON,
      null,
      async () => {
        await this.sweep();
      },
    );
  }

  /** Deletes every account unconfirmed for the whole window as of `now`. */
  async sweep(now: Date = new Date()): Promise<UnconfirmedAccountsSwept> {
    const swept: UnconfirmedAccountsSwept = {
      userIds: [],
      organizationIds: [],
    };
    if (!this.instanceMode.isHosted) return swept;

    const cutoff = new Date(now.getTime() - UNCONFIRMED_ACCOUNT_DAYS * DAY_MS);
    const candidates = await this.db
      .select({ id: user.id })
      .from(user)
      .where(
        and(
          eq(user.emailVerified, false),
          eq(user.kind, 'human'),
          lte(user.createdAt, cutoff),
        ),
      );

    for (const { id } of candidates) {
      const organizationIds = await this.db.transaction(async (tx) => {
        const owned = await tx
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.ownerId, id));
        const joined = await tx
          .select({ id: member.organizationId })
          .from(member)
          .where(eq(member.userId, id));
        const theirs = [...new Set([...owned, ...joined].map((o) => o.id))];

        if (theirs.length > 0) {
          const [someoneElse] = await tx
            .select({ id: member.id })
            .from(member)
            .where(
              and(
                inArray(member.organizationId, theirs),
                ne(member.userId, id),
              ),
            )
            .limit(1);
          if (someoneElse) return null;
          // The Instance organization is never swept (ADR-0077), whatever
          // its owner's confirmation says.
          if (await includesInstanceOrganization(tx, theirs)) {
            this.logger.error(
              `Not deleting unconfirmed account ${id}: it owns the Instance organization (ADR-0077).`,
            );
            return null;
          }
          await tx.delete(organization).where(inArray(organization.id, theirs));
        }
        await tx.delete(user).where(eq(user.id, id));
        return theirs;
      });
      if (organizationIds === null) continue;
      swept.userIds.push(id);
      swept.organizationIds.push(...organizationIds);
    }

    if (swept.userIds.length > 0) {
      this.logger.log(
        `Deleted ${swept.userIds.length} account(s) unconfirmed for ${UNCONFIRMED_ACCOUNT_DAYS} days, ` +
          `with ${swept.organizationIds.length} empty Organization(s)`,
      );
    }
    return swept;
  }
}
