import { Picker } from "@/components/console/picker";
import { Segmented } from "@/components/console/segmented";
import {
  TimeRange,
  rangeLabel,
  type TimeRangeValue,
} from "@/components/console/time-range";
import { Toolbar, ToolbarGap } from "@/components/console/toolbar";
import type { DeploymentStatus } from "@/lib/api/endpoints/deployments";

const STATUSES: { value: DeploymentStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "done", label: "Done" },
  { value: "error", label: "Error" },
];

/** Whether the feed is narrowed to the services this session has opened. */
export type FeedScope = "all" | "recents";

/**
 * The four controls, and **the counts that travel with the words.**
 *
 * That is the reference's best idea on this screen: the tally says how many of each
 * there are *before* the status filter is applied, so an empty "Error" is visibly
 * empty rather than indistinguishable from a filter that found nothing. The caller
 * computes them after the range, the Project and the scope, and before the status,
 * because a count that changed when you clicked it would be useless.
 *
 * **The scope control is where Recents ended up** — and it is the point of
 * the feed. "Only the services I have open" is a reasonable thing to ask a
 * complete list for, and was never a reasonable definition of the list. It
 * appears only when this session has opened something, because a filter that
 * can only empty the table is furniture.
 */
export function DeploymentsFilters({
  range,
  onRange,
  status,
  onStatus,
  projectId,
  onProjectId,
  scope,
  onScope,
  recentCount,
  counts,
  projects,
}: {
  range: TimeRangeValue;
  onRange: (range: TimeRangeValue) => void;
  status: DeploymentStatus | "all";
  onStatus: (status: DeploymentStatus | "all") => void;
  projectId: string;
  onProjectId: (projectId: string) => void;
  scope: FeedScope;
  onScope: (scope: FeedScope) => void;
  /** How many services this session has opened — none hides the control. */
  recentCount: number;
  counts: Record<string, number>;
  projects: readonly { id: string; name: string }[];
}) {
  return (
    <Toolbar>
      <TimeRange value={range} onChange={onRange} />
      <Segmented
        label="Filter by status"
        options={STATUSES.map((option) => ({
          value: option.value,
          label: `${option.label} ${counts[option.value] ?? 0}`,
        }))}
        value={status}
        onChange={(next) => onStatus(next as DeploymentStatus | "all")}
      />
      {projects.length > 1 ? (
        <Picker
          aria-label="Filter by Project"
          options={[
            { value: "all", label: "Every Project" },
            ...projects.map((project) => ({
              value: project.id,
              label: project.name,
            })),
          ]}
          value={projectId}
          onValueChange={onProjectId}
        />
      ) : null}
      {recentCount > 0 ? (
        <Picker
          aria-label="Filter by what you have opened"
          options={[
            { value: "all", label: "Every service" },
            {
              value: "recents",
              label: `Services you have opened (${recentCount})`,
            },
          ]}
          value={scope}
          onValueChange={(next) => onScope(next as FeedScope)}
        />
      ) : null}
      <ToolbarGap />
      <p className="text-meta text-tx-3">
        Queued in the last {rangeLabel(range)}.
      </p>
    </Toolbar>
  );
}
