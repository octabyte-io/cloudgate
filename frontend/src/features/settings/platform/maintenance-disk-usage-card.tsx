import { Card } from "@/components/console/card";
import { DataTable } from "@/components/console/data-table";
import type { DockerDiskUsageItem } from "@/lib/api/endpoints/settings";

import { SectionFailed, SectionPending } from "../section-states";
import { useDockerDiskUsage } from "./use-platform";
import { useArrival } from "@/components/console/use-arrival";

/** `docker system df`, which is the only figure on this screen. */
export function DiskUsageCard() {
  const usage = useDockerDiskUsage();

  const arrival = useArrival(usage.isPending);
  if (usage.isPending) return <SectionPending title="Disk usage" rows={3} />;
  if (usage.error) {
    return (
      <SectionFailed
        title="Disk usage"
        error={usage.error}
        onRetry={() => void usage.refetch()}
      >
        This one reads the platform host&rsquo;s Docker daemon directly and is
        owner-or-admin. It takes no Server, unlike the cleanups below it.
      </SectionFailed>
    );
  }

  const rows = usage.data ?? [];

  return (
    <Card className={arrival}>
      <Card.Header
        title="Disk usage"
        sub="What Docker is holding on this host, and how much of it is reclaimable."
        headingLevel={2}
      />
      <Card.Body flush>
        <DataTable<DockerDiskUsageItem>
          label="Docker disk usage on this host"
          rows={rows}
          getRowId={(row) => row.type}
          columns={[
            { id: "type", head: "Kind", tone: "key", cell: (row) => row.type },
            {
              id: "count",
              head: "Total",
              tone: "num",
              cell: (row) => row.totalCount,
            },
            {
              id: "active",
              head: "In use",
              tone: "num",
              cell: (row) => row.active,
            },
            { id: "size", head: "Size", tone: "num", cell: (row) => row.size },
            {
              id: "reclaimable",
              head: "Reclaimable",
              tone: "num",
              cell: (row) => row.reclaimable,
            },
          ]}
        />
      </Card.Body>
      <Card.Footer>
        Docker&rsquo;s own figures, from{" "}
        <code className="font-mono">docker system df</code>.
        &ldquo;Reclaimable&rdquo; is what a prune of that kind would free.
      </Card.Footer>
    </Card>
  );
}
