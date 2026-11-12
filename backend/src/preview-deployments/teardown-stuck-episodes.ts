/**
 * When the platform tells an operator its own sweep is stuck
 * (ADR-0026): once per Server per **episode**, never once per
 * preview or per pass.
 *
 * - An episode **opens** when a Server's oldest pending teardown has been
 *   retried for {@link TEARDOWN_STUCK_AFTER_MS}, and that is the one moment
 *   the "Preview teardown stuck" Notification fires.
 * - It **closes** on the first pass with no pending teardown on that Server,
 *   so a Server that recovers and fails again opens a fresh one. There is no
 *   acknowledgement step and no repeat within an episode.
 *
 * **The mark lives in memory, and a restart re-arms rather than fires.** The
 * pending rows are the durable record — an expired row stays until its copy
 * is gone — so a new process re-derives the state by seeing them on its first
 * pass and starts the fifteen minutes from there. That is a deliberate
 * difference from `LicenseLapseService`'s stored mark, which exists only
 * because a licence's expiry leaves nothing behind to read. It means a
 * restart inside an episode can tell the operator a second time, fifteen
 * minutes later, and never sooner.
 *
 * **The clock is the pass's own now**, `PreviewExpiryService.sweep(now)`'s,
 * so the unit seam injects it and nothing here reads `Date.now`.
 *
 * **A Server here is where the copy runs** — the Application's `serverId`,
 * which is what the presence read asks. The platform host has no Server row
 * and no Organization of its own, so its leftovers are kept apart per
 * Organization: an operator never hears about another Organization's
 * Applications.
 */

/** How long a Server's oldest pending teardown is retried before anyone is told. */
export const TEARDOWN_STUCK_AFTER_MS = 15 * 60_000;

/** An expired Requested preview whose copy was not confirmed gone this pass. */
export interface PendingTeardown {
  previewDeploymentId: string;
  /** The Server the copy runs on; null for the platform host. */
  serverId: string | null;
  /** The preview's Organization, the recipient on the platform host. */
  organizationId: string;
  applicationId: string;
  /** The parent Application's display name, which holds the slot. */
  applicationName: string;
}

/** A Server whose episode opened on this pass: the one event to send. */
export interface StuckServer {
  serverId: string | null;
  organizationId: string;
  /** Every pending teardown on it this pass, in the order the pass saw them. */
  previews: PendingTeardown[];
  /** When this process first saw the oldest of them pending. */
  stuckSince: Date;
}

/** Tells the operator a Server's episode opened. Never awaited by the sweep. */
export interface PreviewTeardownStuckNotifier {
  previewTeardownStuck(stuck: StuckServer): Promise<void>;
}

/** The injection token for the notifier, which a test replaces. */
export const PREVIEW_TEARDOWN_STUCK_NOTIFIER =
  'PREVIEW_TEARDOWN_STUCK_NOTIFIER';

const episodeKey = (row: PendingTeardown): string =>
  row.serverId ?? `platform-host:${row.organizationId}`;

export class TeardownStuckEpisodes {
  /** When this process first saw each still-pending preview pending. */
  private readonly firstSeen = new Map<string, number>();
  /** The episodes that have fired and not closed, by {@link episodeKey}. */
  private readonly told = new Set<string>();

  /**
   * One pass's pending teardowns, judged at `now`. Answers the Servers whose
   * episode opened on this pass; every other Server answers nothing.
   *
   * A preview absent from `pending` is done being stuck — its copy is gone,
   * or it is waiting on a build rather than a Server — so its clock is
   * dropped, and one that comes back starts again.
   */
  observe(pending: readonly PendingTeardown[], now: Date): StuckServer[] {
    const at = now.getTime();
    const ids = new Set(pending.map((row) => row.previewDeploymentId));
    for (const id of [...this.firstSeen.keys()]) {
      if (!ids.has(id)) this.firstSeen.delete(id);
    }

    const servers = new Map<string, PendingTeardown[]>();
    for (const row of pending) {
      if (!this.firstSeen.has(row.previewDeploymentId)) {
        this.firstSeen.set(row.previewDeploymentId, at);
      }
      const key = episodeKey(row);
      servers.set(key, [...(servers.get(key) ?? []), row]);
    }

    for (const key of [...this.told]) {
      if (!servers.has(key)) this.told.delete(key);
    }

    const opened: StuckServer[] = [];
    for (const [key, rows] of servers) {
      if (this.told.has(key)) continue;
      const oldest = Math.min(
        ...rows.map((row) => this.firstSeen.get(row.previewDeploymentId)!),
      );
      if (at - oldest < TEARDOWN_STUCK_AFTER_MS) continue;
      this.told.add(key);
      opened.push({
        serverId: rows[0].serverId,
        organizationId: rows[0].organizationId,
        previews: rows,
        stuckSince: new Date(oldest),
      });
    }
    return opened;
  }
}
