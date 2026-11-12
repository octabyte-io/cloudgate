import type { PreviewExpiryCause } from './preview-deployment.schema';
import { requestedPreviewDescription } from './requested-preview';

/**
 * The expiry sweep's decisions that need no database or Server
 * (ADR-0026, ADR-0020's shape): which Requested previews a pass marks expired
 * and which it tries to tear down, judged against an **injected now** so a
 * test drives the clock rather than waiting on it.
 * `PreviewExpiryService.sweep(now)` is the pass that applies them.
 */

/** A Requested preview as the sweep reads it. */
export interface ExpiryCandidate {
  previewDeploymentId: string;
  /** ISO instant; a requested row always has one (the trigger check). */
  expiresAt: string;
  /** ISO instant the row was marked expired, or null while it lives. */
  expiredAt: string | null;
}

/** One pass's plan, both lists in the order the rows were read. */
export interface ExpiryPlan {
  /** Rows whose expiry has passed at `now` and that no pass has marked yet. */
  mark: string[];
  /**
   * Every row that is expired once `mark` is written — the rows marked on an
   * earlier pass (or by a `DELETE`) and the ones this pass marks. A row stays
   * here, pass after pass, until its copy is gone and it is deleted,
   * which is what makes an unreachable Server a retry rather
   * than a leak.
   */
  tearDown: string[];
}

/**
 * **A row is expired from the instant its expiry is reached, inclusive.** A
 * row marked already is never marked again — the mark is set once and its
 * instant and cause are what the platform's audit row reports — and a marked
 * row is torn down whatever its `expiresAt` says, since a `DELETE` stamps its
 * own now there and a pass's clock may be a moment behind it.
 *
 * Compared as instants, not as strings: the column is ISO text, and two
 * spellings of one instant must not disagree.
 */
export function planExpiry(
  rows: readonly ExpiryCandidate[],
  now: Date,
): ExpiryPlan {
  const mark: string[] = [];
  const tearDown: string[] = [];
  for (const row of rows) {
    if (row.expiredAt !== null) {
      tearDown.push(row.previewDeploymentId);
      continue;
    }
    if (new Date(row.expiresAt).getTime() <= now.getTime()) {
      mark.push(row.previewDeploymentId);
      tearDown.push(row.previewDeploymentId);
    }
  }
  return { mark, tearDown };
}

/**
 * Runs `work` over `rows`, **Servers at once and each Server's rows in
 * turn**: "each attempt is bounded by the connect timeout so other rows
 * go ahead". A pass that took every row in turn held every other Server's
 * teardowns behind an unreachable one's, each of whose rows costs several
 * connect timeouts. One Server's rows stay in turn, in the order they were
 * read, so a pass never opens several connections to one machine at once.
 * `serverOf` answers `null` for the platform host, which is one Server here.
 *
 * `work` journals its own failures; one that throws anyway is dropped here so
 * its Server's next row still goes ahead. Answers once every Server is done.
 */
export async function tearDownPerServer<Row>(
  rows: readonly Row[],
  serverOf: (row: Row) => string | null,
  work: (row: Row) => Promise<void>,
): Promise<void> {
  const byServer = new Map<string | null, Row[]>();
  for (const row of rows) {
    const key = serverOf(row);
    byServer.set(key, [...(byServer.get(key) ?? []), row]);
  }
  await Promise.all(
    [...byServer.values()].map(async (serverRows) => {
      for (const row of serverRows) {
        await work(row).catch(() => undefined);
      }
    }),
  );
}

/**
 * What a build cancelled by its preview's expiry reads in the parent's
 * Deployment history: `cancelled`, with this description
 * saying why. It replaces the build's own description, so the history names
 * the branch and the reason in one line, and it is also how the platform's
 * audit row finds the builds the expiry cancelled — a build a person
 * cancelled earlier keeps its own words and is not counted.
 */
export const expiredBuildDescription = (
  branch: string,
  cause: PreviewExpiryCause,
): string =>
  `${requestedPreviewDescription(branch)}, cancelled: the preview expired${
    cause === 'delete' ? ' when it was deleted' : ''
  }`;
