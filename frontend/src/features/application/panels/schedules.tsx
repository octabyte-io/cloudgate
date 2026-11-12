"use client";

import { useState } from "react";

import { MetaStrip } from "@/components/console/meta-strip";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { TabPending } from "@/components/console/tab-pending";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ResourceList } from "@/components/console/resource-list";
import { RunHistoryCard } from "../advanced/run-history-card";
import { schedulesSpec } from "../advanced/schedules-spec";
import {
  useScheduleMutations,
  useScheduleRuns,
  useSchedules,
} from "../advanced/use-advanced";
import { useApplication } from "../use-application";

/**
 * Cron entries against this Application.
 *
 * The list, the form and the four calls are one `ResourceList` configuration
 * (`schedules-spec.tsx`); what this file adds is **Run now** as a row control and
 * the run history below it.
 *
 * **A run's outcome reads back now, and it took two fixes.** `POST /:id/run`
 * records a `deployment` row carrying `scheduleId`, the schedule row has no
 * `lastRunAt`, and for a long time the only Deployment list routes were keyed by
 * `applicationId` and `composeId` — so a run was recorded and unreadable, and this
 * tab said so where `RunHistoryCard` now sits.
 * The first added `GET /schedules/:id/deployments`; the second made those runs'
 * logs readable, which is what makes the history worth opening rather than just
 * counting.
 *
 * **There is still no Last run column on the list**, and that stays deliberate.
 * The history is per schedule and fetched only when one is picked, so filling a
 * column would mean one request per row on every open — and the point of the
 * column was to be a summary, not a fan-out. `RunHistoryCard` explains that
 * choice from its own side.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const application = useApplication(id);
  const schedules = useSchedules(id);
  const mutations = useScheduleMutations(id);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const runs = useScheduleRuns(historyOf);

  if (!application.data) return <TabPending />;

  const spec = schedulesSpec({
    applicationId: id,
    create: (input) => mutations.create.mutateAsync(input as never),
    update: (scheduleId, input) =>
      mutations.update.mutateAsync({ scheduleId, input: input as never }),
    remove: (scheduleId) => mutations.remove.mutateAsync(scheduleId),
  });

  return (
    <Page className="grid gap-3">
      <PageHeader
        title={label}
        icon={icon}
        lede="Commands this Application runs on a cron, and a way to run one now."
      />

      <ResourceList
        spec={{
          ...spec,
          rowExtras: (row) => (
            <Button
              size="xs"
              disabled={mutations.run.isPending}
              onClick={async () => {
                try {
                  await mutations.run.mutateAsync(row.scheduleId);
                  // Selecting it is the useful half of the confirmation: the
                  // run is now readable, so the toast points at where, and the
                  // history below is already showing this schedule.
                  setHistoryOf(row.scheduleId);
                  toast.done(`Running ${row.name} now.`, {
                    description:
                      "The command was handed to the container. Its result lands in the run history below.",
                  });
                } catch (error) {
                  toast.error(error);
                }
              }}
            >
              Run now
            </Button>
          ),
        }}
        query={schedules}
        note={
          <MetaStrip>
            A schedule runs <strong>inside the running container</strong>. If this
            Application is stopped when the cron fires, there is nothing to run the
            command in and the firing is lost.
          </MetaStrip>
        }
      />

      <RunHistoryCard
        noun="schedule"
        entries={(schedules.data ?? []).map((row) => ({
          id: row.scheduleId,
          label: row.name,
          detail: row.cronExpression,
        }))}
        selectedId={historyOf}
        onSelect={setHistoryOf}
        runs={runs}
      />
    </Page>
  );
}
