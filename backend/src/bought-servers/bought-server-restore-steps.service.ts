import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { formatAmount } from '../cloud/billing/billing-notifications.service';
import { BillingConfig } from '../cloud/billing/billing.config';
import { LapseNotifications } from '../cloud/billing/lapse-notifications.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { MailService } from '../mail/mail.service';
import { renderBoughtServerRestoreFailedEmail } from '../mail/templates';
import type { RestoreGivenUp } from '../mail/templates';
import { renderServerChangedEmail } from '../mail/templates/server-changed';
import { ServerSetupRuns } from '../servers/server-setup-runs';
import type { SetupRunOutcome } from '../servers/server-setup-runs';
import { boughtServer, boughtServerLine, server } from '../db/schema';
import type {
  BoughtServer,
  BoughtServerRestore,
  BoughtServerRestoreRedeploys,
  RestoreRedeploy,
} from '../db/schema';
import { HETZNER_MACHINES } from './hetzner/hetzner-cloud.port';
import type { HetznerCloudPort } from './hetzner/hetzner-cloud.port';
import { backupDateOf, safetyCopyPushesOut } from './restore';
import { RestoreRedeploys } from './restore-redeploys.service';
import type { NextStep } from './stages';

/** What the Server setup run after a Restore cut off by a restart each time it was started is stored as. */
export const RESTORE_SETUP_CUT_OFF_MESSAGE =
  'The setup run after a restore was cut off before it ended. Run setup to try again.';

/**
 * What a Server's setup is stored as when its Restore was given up once its
 * disk was, or may have been, put back: no setup ran on the restored disk,
 * so the console offers Run setup, as for any failed setup (#180).
 */
export const RESTORE_GAVE_UP_SETUP_MESSAGE =
  'The restore stopped after its disk was restored, before Server setup ran. Run setup to set it up again.';

/** What the provider reports a machine as while it rebuilds its disk. */
const REBUILDING = 'rebuilding';

/**
 * Whether the disk is, or may be, the backup's: rebuilt, a rebuild the
 * provider accepted (even one that then ended in an error), or one asked for
 * whose answer a restart cut off. While the rebuild step runs, its tries
 * count the asks, so any ask beyond the answers stored was never answered.
 */
export function diskMayBeRestored(
  restore: BoughtServerRestore,
  tries: number,
): boolean {
  if (restore.rebuilt || restore.rebuildAccepted) return true;
  const copy = restore.safetyCopy;
  const rebuilding = !copy || copy.available;
  return rebuilding && tries > (restore.rebuildAnswers ?? 0);
}

/** The steps of a Restore that `nextStep` names. */
export type RestoreStep = Extract<
  NextStep,
  {
    kind:
      | 'take-safety-copy'
      | 'wait-for-safety-copy'
      | 'rebuild'
      | 'wait-for-rebuild'
      | 'start-machine'
      | 'restore-setup'
      | 'restore-setup-cut-off'
      | 'after-restore-setup'
      | 'start-restore-redeploys';
  }
>;

/**
 * **A Restore's steps** (#180, ADR-0093): the Changing stage's steps for a
 * Restore, which `BoughtServerStages` runs from the stored row through
 * `BoughtServerChangeSteps`, so a restart resumes at whichever step it cut
 * off. `nextStep` (`stages.ts`, pure) decides which from the progress stored
 * in `changeTarget.restore`; each step here does one thing and writes how
 * far it came.
 *
 * - *Safety copy*: a Server backup of the disk as it is, described "Before
 *   restore, <date>". A try is claimed before the provider is asked, and a
 *   later try first looks for it by that description, so a copy a restart
 *   cut off is found rather than taken twice. It is waited on until whole:
 *   the rebuild never starts before the way back exists.
 * - *Rebuild* from the chosen backup: claimed, asked, its action stored and
 *   waited on. A rebuild a restart cut off before its action was stored is
 *   asked again, which only puts back the same disk.
 * - *Start*: powered on if it is off, until it runs.
 * - *Server setup run*, which waits for SSH and mounts the extra storage
 *   again (`ServersService.setup`); once more if a restart cut it off, then
 *   stored as failed.
 * - *After the setup run* ({@link afterSetup}): Ready, with the redeploy
 *   of every Service deployed after the backup stored as still to start;
 *   each is then started once ({@link startRedeploys}), and the owners and
 *   admins told once, naming them, after the last.
 *
 * Every write is conditional on the row's stored target and tries, so two
 * callers (a press's follow and the hourly resume) never both take a step,
 * and a stale one never writes progress back over a later one. Nothing is
 * charged at any step. A provider refusal leaves the next step to decide:
 * once more, or give up ({@link giveUp}), back to Ready with the owners told.
 */
@Injectable()
export class BoughtServerRestoreSteps {
  private readonly logger = new Logger(BoughtServerRestoreSteps.name);
  /** The Bought Servers whose stored redeploys a caller on this backend is starting now. */
  private readonly carrying = new Set<string>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(HETZNER_MACHINES) private readonly machines: HetznerCloudPort,
    // Forward, as in `BoughtServerStages`: ServerSetupRuns provisions through
    // ServersService, which reaches back into this module.
    @Inject(forwardRef(() => ServerSetupRuns))
    private readonly setupRuns: ServerSetupRuns,
    private readonly notifications: LapseNotifications,
    private readonly mail: MailService,
    private readonly billingConfig: BillingConfig,
    private readonly redeploys: RestoreRedeploys,
  ) {}

  /** One step of a Restore; false once there is nothing more to do now. */
  run(row: BoughtServer, step: RestoreStep): Promise<boolean> {
    switch (step.kind) {
      case 'take-safety-copy':
        return this.takeSafetyCopy(row, step.findFirst);
      case 'wait-for-safety-copy':
        return this.waitForSafetyCopy(row);
      case 'rebuild':
        return this.rebuild(row);
      case 'wait-for-rebuild':
        return this.waitForRebuild(row);
      case 'start-machine':
        return this.startMachine(row);
      case 'restore-setup':
        return this.startSetup(row);
      case 'restore-setup-cut-off':
        return this.setupCutOff(row);
      case 'after-restore-setup':
        return this.afterSetup(row);
      case 'start-restore-redeploys':
        return this.startRedeploys(row.id);
    }
  }

  /**
   * Refused every try: back to Ready, with nothing charged, and the owners
   * told. Before any rebuild was asked for, the Server is as it was. Once
   * its disk was, or may have been, put back ({@link diskMayBeRestored}),
   * no setup ran on it, so its setup is stored as failed and the console
   * offers Run setup; the email says what is left, never "as it was".
   */
  async giveUp(row: BoughtServer): Promise<boolean> {
    const restore = restoreOf(row);
    const outcome: RestoreGivenUp = restore.rebuilt
      ? 'not-started'
      : diskMayBeRestored(restore, row.changeTries)
        ? 'may-be-rebuilt'
        : 'refused';
    return this.leave(row, outcome);
  }

  /** Back to Ready with nothing charged, the setup marked failed if the disk may be the backup's, and the owners told how. */
  private async leave(
    row: BoughtServer,
    outcome: RestoreGivenUp,
  ): Promise<boolean> {
    const restore = restoreOf(row);
    const [kept] = await this.db
      .update(boughtServer)
      .set({ stage: 'ready', changeTarget: null, changeTries: 0 })
      .where(this.unchanged(row))
      .returning({ id: boughtServer.id });
    if (!kept) return false;
    const touched = outcome === 'not-started' || outcome === 'may-be-rebuilt';
    if (touched && row.serverId) {
      await this.db
        .update(server)
        .set({
          setupRanAt: new Date().toISOString(),
          setupOk: false,
          setupMessage: RESTORE_GAVE_UP_SETUP_MESSAGE,
        })
        .where(eq(server.serverId, row.serverId));
    }
    this.logger.warn(
      `Bought Server ${row.id}: its restore of backup ${restore.backupId} was given up (${outcome}); it is Ready`,
    );
    await this.sendFailed(row, restore, outcome);
    return false;
  }

  private async takeSafetyCopy(
    row: BoughtServer,
    findFirst: boolean,
  ): Promise<boolean> {
    const restore = restoreOf(row);
    const copy = restore.safetyCopy!;
    const machineId = row.providerServerId;
    if (machineId === null) return false;
    if (findFirst) {
      const listed = await this.machines.listBackups(machineId);
      if (!listed.ok) {
        this.logger.warn(
          `Bought Server ${row.id}: looking for its safety copy was refused: ${listed.code}: ${listed.message}`,
        );
        return false;
      }
      const found = listed.value.find(
        (backup) => backup.description === copy.description,
      );
      if (found) {
        return this.progress(row, { safetyCopy: { ...copy, id: found.id } });
      }
    }
    // Asked again just before the copy: a daily backup made since the press
    // can make the chosen one the oldest of 7, and the copy would push it
    // out. The go-ahead without a copy was not given (or there would be no
    // copy to take), so it is given up with the disk untouched.
    const now = await this.machines.listBackups(machineId);
    if (!now.ok) {
      this.logger.warn(
        `Bought Server ${row.id}: reading its backups before the safety copy was refused: ${now.code}: ${now.message}`,
      );
      return false;
    }
    if (safetyCopyPushesOut(now.value, restore.backupId)) {
      return this.leave(row, 'safety-copy-would-remove');
    }
    if (!(await this.claim(row))) return false;
    const taken = await this.machines.createBackup(machineId, copy.description);
    if (!taken.ok) {
      this.logger.warn(
        `Bought Server ${row.id}: safety copy ${row.changeTries + 1} was refused: ${taken.code}: ${taken.message}`,
      );
      return true;
    }
    return this.progress(
      { ...row, changeTries: row.changeTries + 1 },
      { safetyCopy: { ...copy, id: taken.value.backup.id } },
    );
  }

  /**
   * Whole: the rebuild may go. Still being made: waited on. Gone (the
   * provider failed it): taken again, counted as a refused try.
   */
  private async waitForSafetyCopy(row: BoughtServer): Promise<boolean> {
    const restore = restoreOf(row);
    const copy = restore.safetyCopy!;
    const listed = await this.machines.listBackups(row.providerServerId!);
    if (!listed.ok) {
      this.logger.warn(
        `Bought Server ${row.id}: reading its safety copy was refused: ${listed.code}: ${listed.message}`,
      );
      return false;
    }
    const found = listed.value.find((backup) => backup.id === copy.id);
    if (found?.status === 'creating') return false;
    if (found) {
      return this.progress(
        row,
        { safetyCopy: { ...copy, available: true } },
        0,
      );
    }
    this.logger.warn(
      `Bought Server ${row.id}: its safety copy ${copy.id} is gone before it was made; taking it again`,
    );
    return this.progress(row, { safetyCopy: { ...copy, id: null } });
  }

  /**
   * The rebuild asked for, a try claimed first. Before asking again, the
   * machine is read: a rebuild a restart cut off before its answer was
   * stored may be going on, and the provider shows it as `rebuilding`; that
   * is waited on rather than asked a second time, which it would refuse,
   * and a refusal would then read as the Server kept as it was. Each answer
   * is counted ({@link diskMayBeRestored}).
   */
  private async rebuild(row: BoughtServer): Promise<boolean> {
    const restore = restoreOf(row);
    if (row.changeTries > 0) {
      const machine = await this.machines.getServer(row.providerServerId!);
      if (!machine.ok) {
        this.logger.warn(
          `Bought Server ${row.id}: reading its machine before rebuilding again was refused: ${machine.code}: ${machine.message}`,
        );
        return false;
      }
      if (machine.value.status === REBUILDING) return false;
    }
    if (!(await this.claim(row))) return false;
    const asked = await this.machines.rebuild(
      row.providerServerId!,
      restore.backupId,
    );
    const tries = row.changeTries + 1;
    const answers = (restore.rebuildAnswers ?? 0) + 1;
    if (!asked.ok) {
      this.logger.warn(
        `Bought Server ${row.id}: rebuild ${tries} was refused: ${asked.code}: ${asked.message}`,
      );
      await this.progress(
        { ...row, changeTries: tries },
        { rebuildAnswers: answers },
      );
      return true;
    }
    return this.progress(
      { ...row, changeTries: tries },
      {
        rebuildActionId: asked.value.id,
        rebuildAnswers: answers,
        rebuildAccepted: true,
      },
    );
  }

  /** The rebuild ended well: rebuilt. Ended in an error: a refused try. */
  private async waitForRebuild(row: BoughtServer): Promise<boolean> {
    const restore = restoreOf(row);
    const action = await this.machines.getAction(restore.rebuildActionId!);
    if (!action.ok) {
      this.logger.warn(
        `Bought Server ${row.id}: reading its rebuild was refused: ${action.code}: ${action.message}`,
      );
      return false;
    }
    if (action.value.status === 'running') return false;
    if (action.value.status === 'success') {
      return this.progress(
        row,
        { rebuildActionId: undefined, rebuilt: true },
        0,
      );
    }
    this.logger.warn(
      `Bought Server ${row.id}: rebuild ${row.changeTries} failed: ${action.value.error?.code}: ${action.value.error?.message}`,
    );
    return this.progress(row, { rebuildActionId: undefined });
  }

  /** Running: on to setup. Off: powered on, a claimed try. Anything else: still starting. */
  private async startMachine(row: BoughtServer): Promise<boolean> {
    const machine = await this.machines.getServer(row.providerServerId!);
    if (!machine.ok) {
      this.logger.warn(
        `Bought Server ${row.id}: reading its machine was refused: ${machine.code}: ${machine.message}`,
      );
      return false;
    }
    if (machine.value.status === 'running') {
      return this.progress(row, { running: true }, 0);
    }
    if (machine.value.status !== 'off') return false;
    if (!(await this.claim(row))) return false;
    const on = await this.machines.powerOn(machine.value.id);
    if (!on.ok) {
      this.logger.warn(
        `Bought Server ${row.id}: powering it on after the rebuild was refused: ${on.code}: ${on.message}`,
      );
    }
    return true;
  }

  /**
   * The Server setup run, as the person who pressed Restore would start it:
   * claimed on the row first, so a restart reads it as started. A run
   * already going on this backend (a *Run setup* pressed meanwhile) may have
   * begun before the rebuild, so it is not taken as this one: its end is
   * waited on (`ServerSetupRuns.start` answers with it), and this one starts
   * then, rather than at the next hourly resume. Its end is stored, and what
   * follows it runs then.
   */
  private async startSetup(row: BoughtServer): Promise<boolean> {
    const restore = restoreOf(row);
    if (!row.serverId) return false;
    if (this.setupRuns.inFlight(row.serverId)) {
      const { ended } = this.setupRuns.start(row.serverId, {
        user: { id: restore.requestedBy },
        session: { activeOrganizationId: row.organizationId },
      });
      void ended.then(() => this.startSetupAfter(row.id));
      return false;
    }
    const claimed = await this.progress(row, {
      setupStarts: (restore.setupStarts ?? 0) + 1,
    });
    if (!claimed) return false;
    const { ended } = this.setupRuns.start(
      row.serverId,
      {
        user: { id: restore.requestedBy },
        session: { activeOrganizationId: row.organizationId },
      },
      { waitForSsh: true },
    );
    void ended.then((outcome) => this.setupEnded(row.id, outcome));
    return false;
  }

  /** The run that was going on ended: this Restore's own starts, unless a later step or caller moved on. */
  private async startSetupAfter(id: string): Promise<void> {
    try {
      const row = await this.find(id);
      const restore = row?.changeTarget?.restore;
      if (!row || row.stage !== 'changing' || !restore || restore.setup) {
        return;
      }
      if (!restore.running) return;
      await this.startSetup(row);
    } catch (error) {
      this.logger.error(
        `Bought Server ${id}: could not start the setup run after its restore: ${(error as Error).message}`,
      );
    }
  }

  /** The run ended, either way: stored, then what follows it. */
  private async setupEnded(
    id: string,
    outcome: SetupRunOutcome,
  ): Promise<void> {
    try {
      const row = await this.find(id);
      const restore = row?.changeTarget?.restore;
      if (!row || row.stage !== 'changing' || !restore || restore.setup) {
        return;
      }
      const stored = await this.progress(row, {
        setup: { ok: outcome.ok, message: outcome.message },
      });
      if (!stored) return;
      const after = await this.find(id);
      if (after) await this.afterSetup(after);
    } catch (error) {
      this.logger.error(
        `Bought Server ${id}: could not record how the setup run after its restore ended: ${(error as Error).message}`,
      );
    }
  }

  /** Started twice and cut off by a restart both times: stored as a failed run, as the first setup's is. */
  private async setupCutOff(row: BoughtServer): Promise<boolean> {
    if (row.serverId) {
      await this.db
        .update(server)
        .set({
          setupRanAt: new Date().toISOString(),
          setupOk: false,
          setupMessage: RESTORE_SETUP_CUT_OFF_MESSAGE,
        })
        .where(eq(server.serverId, row.serverId));
    }
    return this.progress(row, {
      setup: { ok: false, message: RESTORE_SETUP_CUT_OFF_MESSAGE },
    });
  }

  /**
   * **What follows the Server setup run after a Restore**, the one place it
   * happens: whether the run ended here, or a restart read it ended. The
   * Services deployed after the backup (#181, ADR-0093) are read while it
   * is still Changing, then {@link finish}.
   */
  private async afterSetup(row: BoughtServer): Promise<boolean> {
    const restore = restoreOf(row);
    const redeploys = row.serverId
      ? await this.redeploys.newerThan(row.serverId, restore.backupTakenAt)
      : [];
    return this.finish(row, redeploys);
  }

  /**
   * Ready again, and only then the redeploys: the readiness rule refuses
   * any deploy to a Bought Server that is not Ready, the queued ones at
   * their claim too. The same write stores them as still to start, so a
   * restart between the two starts them rather than losing them; it is the
   * claim on the Restore's end, so a second caller reaching this again finds
   * the Server Ready and writes nothing.
   */
  private async finish(
    row: BoughtServer,
    redeploys: readonly RestoreRedeploy[],
  ): Promise<boolean> {
    const restore = restoreOf(row);
    const left: BoughtServerRestoreRedeploys = {
      backupTakenAt: restore.backupTakenAt,
      setupOk: restore.setup?.ok ?? false,
      toStart: [...redeploys],
      starting: null,
      started: [],
      notStarted: [],
    };
    const [done] = await this.db
      .update(boughtServer)
      .set({
        stage: 'ready',
        changeTarget: null,
        changeTries: 0,
        restoreRedeploys: left,
      })
      .where(this.unchanged(row))
      .returning({ id: boughtServer.id });
    if (!done) return false;
    return this.startRedeploys(row.id);
  }

  /**
   * **The redeploys a finished Restore stored** (#181), each started once,
   * then the one email. Each is claimed (moved to `starting`) before it is
   * started and recorded after, every write conditional on the stored list
   * as read, so two callers never start the same one; one caller here at a
   * time ({@link carrying}), so a press's follow and the hourly resume do
   * not both pick up a claimed one. A restart that finds one claimed and not
   * recorded starts it again, a harmless redeploy, rather than lose it.
   * Whoever clears the list once none is left sends the email.
   */
  private async startRedeploys(id: string): Promise<boolean> {
    if (this.carrying.has(id)) return false;
    this.carrying.add(id);
    try {
      for (;;) {
        const row = await this.find(id);
        const left = row?.restoreRedeploys;
        if (!row || !left) return false;
        const next = left.starting ?? left.toStart[0] ?? null;
        if (next === null) {
          const [cleared] = await this.db
            .update(boughtServer)
            .set({ restoreRedeploys: null })
            .where(this.redeploysUnchanged(id, left))
            .returning({ id: boughtServer.id });
          if (cleared) await this.sendRestored(row, left);
          return false;
        }
        const claimed: BoughtServerRestoreRedeploys = left.starting
          ? left
          : { ...left, toStart: left.toStart.slice(1), starting: next };
        if (
          claimed !== left &&
          !(await this.writeRedeploys(id, left, claimed))
        ) {
          continue;
        }
        const outcome = await this.redeploys.start(
          row.organizationId,
          row.name,
          left.backupTakenAt,
          next,
        );
        await this.writeRedeploys(id, claimed, {
          ...claimed,
          starting: null,
          started: outcome.started
            ? [...claimed.started, { name: next.name }]
            : claimed.started,
          notStarted: outcome.started
            ? claimed.notStarted
            : [
                ...claimed.notStarted,
                { name: next.name, reason: outcome.reason },
              ],
        });
      }
    } finally {
      this.carrying.delete(id);
    }
  }

  /** The stored redeploys moved from `from` to `to`, unless another caller moved them first. */
  private async writeRedeploys(
    id: string,
    from: BoughtServerRestoreRedeploys,
    to: BoughtServerRestoreRedeploys,
  ): Promise<boolean> {
    const [written] = await this.db
      .update(boughtServer)
      .set({ restoreRedeploys: to })
      .where(this.redeploysUnchanged(id, from))
      .returning({ id: boughtServer.id });
    return written !== undefined;
  }

  private redeploysUnchanged(id: string, left: BoughtServerRestoreRedeploys) {
    return and(
      eq(boughtServer.id, id),
      sql`${boughtServer.restoreRedeploys} = ${JSON.stringify(left)}::jsonb`,
    );
  }

  /** To every owner and admin, as any finished change is: which backup, how setup ended, what was redeployed and what could not be. */
  private async sendRestored(
    row: BoughtServer,
    done: BoughtServerRestoreRedeploys,
  ): Promise<void> {
    try {
      const lines = await this.db
        .select({ monthlyCents: boughtServerLine.monthlyCents })
        .from(boughtServerLine)
        .where(eq(boughtServerLine.boughtServerId, row.id));
      const monthlyPrice = formatAmount(
        lines.reduce((sum, line) => sum + line.monthlyCents, 0),
        'usd',
      );
      await this.notifications.sendToOwnersAndAdmins(
        row.organizationId,
        'Bought Server restored',
        (recipient, organizationName) =>
          renderServerChangedEmail({
            userName: recipient.name,
            organizationName,
            serverName: row.name,
            change: {
              kind: 'restore',
              backupTakenAt: backupDateOf(done.backupTakenAt),
              setupOk: done.setupOk,
              redeployed: done.started.map((one) => one.name),
              notRedeployed: done.notStarted,
            },
            monthlyPrice,
            serverUrl: this.serverUrl(row),
          }),
      );
    } catch (error) {
      this.logger.error(
        `Bought Server ${row.id}: could not email that its restore finished: ${(error as Error).message}`,
      );
    }
  }

  /** To the owners, as a refused change is told. */
  private async sendFailed(
    row: BoughtServer,
    restore: BoughtServerRestore,
    outcome: RestoreGivenUp,
  ): Promise<void> {
    const { recipients } = await this.notifications.audienceOf(
      row.organizationId,
      ['owner'],
    );
    for (const recipient of recipients) {
      try {
        await this.mail.send(
          recipient.email,
          await renderBoughtServerRestoreFailedEmail({
            userName: recipient.name,
            serverName: row.name,
            backupTakenAt: backupDateOf(restore.backupTakenAt),
            outcome,
            serverUrl: this.serverUrl(row),
          }),
        );
      } catch (error) {
        this.logger.error(
          `Failed to send the restore-failed email to ${recipient.email}: ${(error as Error).message}`,
        );
      }
    }
  }

  /** One try of the step, claimed before the provider is asked. */
  private async claim(row: BoughtServer): Promise<boolean> {
    const [claimed] = await this.db
      .update(boughtServer)
      .set({ changeTries: row.changeTries + 1 })
      .where(this.unchanged(row))
      .returning({ id: boughtServer.id });
    // Someone else took this try.
    return claimed !== undefined;
  }

  /**
   * How far the Restore came, written over the row as it is stored now (a
   * claim just made counts). The step's tries are kept for progress inside
   * a step, so a copy or a rebuild lost after it was asked for still counts
   * as a try, and `tries: 0` once a step is done.
   */
  private async progress(
    row: BoughtServer,
    patch: Partial<BoughtServerRestore>,
    tries = row.changeTries,
  ): Promise<boolean> {
    const target = row.changeTarget!;
    const [written] = await this.db
      .update(boughtServer)
      .set({
        changeTarget: {
          ...target,
          restore: { ...target.restore!, ...patch },
        },
        changeTries: tries,
      })
      .where(this.unchanged(row))
      .returning({ id: boughtServer.id });
    return written !== undefined;
  }

  /** The row still as it was read: Changing, with the same target and tries. */
  private unchanged(row: BoughtServer) {
    return and(
      eq(boughtServer.id, row.id),
      eq(boughtServer.stage, 'changing'),
      eq(boughtServer.changeTries, row.changeTries),
      sql`${boughtServer.changeTarget} = ${JSON.stringify(row.changeTarget)}::jsonb`,
    );
  }

  private serverUrl(row: BoughtServer): string {
    return `${this.billingConfig.siteUrl}/servers/${row.id}/settings`;
  }

  private async find(id: string): Promise<BoughtServer | null> {
    const [row] = await this.db
      .select()
      .from(boughtServer)
      .where(eq(boughtServer.id, id))
      .limit(1);
    return row ?? null;
  }
}

function restoreOf(row: BoughtServer): BoughtServerRestore {
  return row.changeTarget!.restore!;
}
