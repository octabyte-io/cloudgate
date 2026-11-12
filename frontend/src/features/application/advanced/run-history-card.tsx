// No `"use client"` — see the note in `lifecycle/application-actions.tsx`. This
// takes a `UseQueryResult` and a callback, neither of which is serializable, and
// its two importers (`panels/schedules.tsx`, `panels/volume-backups.tsx`) are
// already client entry points.

import { useState } from "react";

import { Card } from "@/components/console/card";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Picker } from "@/components/console/picker";
import { DeploymentTable } from "@/components/console/rows/deployment-row";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import type { Deployment } from "@/lib/api/endpoints/deployments";
import { errorMessage } from "@/lib/api/error-message";
import type { UseQueryResult } from "@tanstack/react-query";

import { DeploymentModal } from "../deploy/deployment-modal";

/**
 * What a cron entry actually did, run by run.
 *
 * One card for schedules and volume backups both, because a run of either is a
 * `deployment` row and `DeploymentTable` already renders those — the only
 * difference between the two tabs is which id the history hangs off and what a run
 * is called.
 *
 * **Three things about this card are the design, and the first is the one that
 * shaped it.**
 *
 * 1. **It shows one entry's runs, chosen from a picker, not every entry's merged.**
 *    The route is keyed by a single `scheduleId` / `volumeBackupId`, so "all runs
 *    on this Application" would be one request per row on every open — and the
 *    merged table could not say which entry a run came from, because a
 *    `deployment` row carries an id and no name. A picker asks the question the
 *    route can answer.
 * 2. **Nothing is requested until an entry is picked.** The query is disabled on a
 *    `null` id, so a tab with eight schedules opens with zero run-history requests
 *    rather than eight. `useScheduleRuns` says the same thing from its side.
 * 3. **The log link goes through the deployment id, never `logPath`**
 * Each row carries
 *    both, and `logPath` is an absolute path on a Server's filesystem that nothing
 *    in a browser can read. `GET /deployments/:deploymentId/logs` is the route —
 *    and it refused every schedule and volume-backup run until it was fixed,
 *    because it resolved a Deployment's owner as `applicationId ?? composeId`,
 *    which is null on both. It was once claimed to "work on any deployment id";
 *    that was wrong. `DeploymentModal` and `DeploymentLog` already read logs
 *    that way, so this reuses them rather than restating it.
 */
export function RunHistoryCard({
  noun,
  entries,
  selectedId,
  onSelect,
  runs,
}: {
  /** "schedule" / "volume backup" — what one of these entries is called. */
  noun: string;
  /** The entries to choose between: an id and what to call it. */
  entries: { id: string; label: string; detail?: string }[];
  /** Which one is picked, `null` for none — and `null` fetches nothing. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  runs: UseQueryResult<Deployment[]>;
}) {
  const [openedId, setOpenedId] = useState<string | null>(null);
  // Distinct per noun, because both tabs mount this card and an id reused across
  // two rendered pickers points the wrong label at the wrong control.
  const pickerId = `run-history-${noun.replace(/\s+/g, "-")}`;
  const rows = runs.data ?? [];
  const opened = rows.find((row) => row.deploymentId === openedId) ?? null;
  const live = rows.some(
    (row) => row.status === "pending" || row.status === "running",
  );

  return (
    <Card>
      <Card.Header
        title="Run history"
        sub={`Every time one of these ran, and what came out of it.`}
        headingLevel={2}
        actions={
          entries.length > 0 ? (
            // `Picker` has no `aria-label` of its own — it is a button, so it
            // takes a real `<label htmlFor>` like every other one in the console.
            <span className="flex min-w-0 items-center gap-2">
              <label
                htmlFor={pickerId}
                className="flex-none text-meta font-medium text-tx-3"
              >
                Which {noun}
              </label>
              <span className="min-w-52">
                <Picker
                  id={pickerId}
                  value={selectedId ?? ""}
                  onValueChange={(next) => {
                    onSelect(next === "" ? null : next);
                    setOpenedId(null);
                  }}
                  placeholder={`Choose a ${noun}`}
                  options={entries.map((entry) => ({
                    value: entry.id,
                    label: entry.label,
                    detail: entry.detail,
                  }))}
                />
              </span>
            </span>
          ) : null
        }
      />

      {entries.length === 0 ? (
        <Card.Body>
          <p className="text-body text-tx-2">
            Nothing is scheduled yet, so there is no history. Add one above and its
            runs show up here — including the ones the cron fires while nobody is
            looking, which is the point.
          </p>
        </Card.Body>
      ) : selectedId === null ? (
        <Card.Body>
          <p className="max-w-copy text-body text-tx-2">
            Pick one to see its runs. Each run is recorded as a Deployment against
            it, with its own output — so a{" "}
            <strong className="font-medium text-tx">3am failure</strong> is
            readable in the morning.
          </p>
        </Card.Body>
      ) : runs.error ? (
        <Card.Body>
          {/* A refusal is answered before an empty list: "no runs" is a claim
              that this has never fired, and a failed read must not make it. */}
          <p className="text-body text-tx-2">
            {errorMessage(runs.error)} Nothing is listed until the runs can be
            read.
          </p>
        </Card.Body>
      ) : runs.isPending ? (
        <Card.Body>
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        </Card.Body>
      ) : (
        <>
          {live ? (
            <MetaStrip>
              A run is <strong>going right now</strong>. This table updates as it
              finishes, and its output is readable while it goes.
            </MetaStrip>
          ) : null}
          <Card.Body flush>
            <DeploymentTable
              deployments={rows}
              label={`Runs of this ${noun}`}
              action={(row) => (
                <Button size="xs" onClick={() => setOpenedId(row.deploymentId)}>
                  Output
                </Button>
              )}
              empty={
                <EmptyState icon="activity" title="This has not run yet">
                  &ldquo;Run now&rdquo; on its row records a run here. Until
                  then, the cron has not come round or the entry is switched
                  off.
                </EmptyState>
              }
            />
          </Card.Body>
        </>
      )}

      <DeploymentModal
        deployment={opened}
        noun={noun}
        open={opened !== null}
        onOpenChange={(next) => {
          if (!next) setOpenedId(null);
        }}
      />
    </Card>
  );
}
