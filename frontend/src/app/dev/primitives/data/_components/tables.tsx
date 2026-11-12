"use client";

import * as React from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { DataTable, type Column } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Pager } from "@/components/console/pager";
import { StatusPill } from "@/components/console/status-pill";
import { Button } from "@/components/ui/button";
import { DEPLOYMENTS, type DeploymentRow } from "../_lib/fixtures";
import { Row } from "../../_components/shell";

const PAGE = 25;

const COLUMNS: Column<DeploymentRow>[] = [
  {
    id: "application",
    head: "Application",
    tone: "key",
    compare: (a, b) => a.application.localeCompare(b.application),
    cell: (row) => row.application,
  },
  {
    id: "environment",
    head: "Environment",
    compare: (a, b) => a.environment.localeCompare(b.environment),
    cell: (row) => row.environment,
  },
  {
    id: "status",
    head: "Status",
    compare: (a, b) => a.status.localeCompare(b.status),
    cell: (row) => <StatusPill status={row.status} />,
  },
  {
    id: "commit",
    head: "Commit",
    cell: (row) => <Chip variant="mono">{row.commit}</Chip>,
  },
  {
    id: "subject",
    head: "Message",
    tone: "wrap",
    cell: (row) => row.subject,
  },
  {
    id: "image",
    head: "Image",
    tone: "muted",
    className: "max-w-72 truncate",
    cell: (row) => <span title={row.image}>{row.image}</span>,
  },
  {
    id: "seconds",
    head: "Duration",
    tone: "num",
    compare: (a, b) => a.seconds - b.seconds,
    cell: (row) =>
      row.seconds === 0
        ? "—"
        : `${Math.floor(row.seconds / 60)}m ${String(row.seconds % 60).padStart(2, "0")}s`,
  },
  {
    id: "started",
    head: "Started",
    tone: "muted",
    className: "num",
    compare: (a, b) => a.started.localeCompare(b.started),
    cell: (row) => row.started,
  },
];

export function TablesGallery() {
  const [from, setFrom] = React.useState(1);
  const [selection, setSelection] = React.useState<string[]>([]);
  const page = DEPLOYMENTS.slice(from - 1, from - 1 + PAGE);

  return (
    <>
      <Row
        label="DataTable + MetaStrip + Pager"
        note="54 Deployments, 25 to a page. Sortable heads, row selection, one column of 71-character image references — the table scrolls sideways inside its own container and the page never does."
        className="block"
      >
        <Card tone="plain" className="w-full">
          <MetaStrip>
            <strong>{DEPLOYMENTS.length}</strong> Deployments in the last 3 days,{" "}
            <strong>7</strong> failed
            {selection.length > 0 ? (
              <>
                {" — "}
                <strong>{selection.length}</strong> selected
              </>
            ) : null}
          </MetaStrip>
          <Card.Body flush>
            <DataTable
              label="Deployments"
              columns={COLUMNS}
              rows={page}
              getRowId={(row) => row.id}
              rowName={(row) => `${row.application} ${row.commit}`}
              defaultSort={{ id: "started", dir: "desc" }}
              selectable
              onSelectionChange={setSelection}
            />
          </Card.Body>
          <Pager
            className="border-t-0"
            shown={page.length}
            total={DEPLOYMENTS.length}
            noun="Deployments"
            from={from}
            onPrevious={() => setFrom((current) => Math.max(1, current - PAGE))}
            onNext={() =>
              setFrom((current) =>
                current + PAGE > DEPLOYMENTS.length ? current : current + PAGE,
              )
            }
          />
        </Card>
      </Row>

      <Row
        label="DataTable, empty"
        note="A table with no rows keeps its head — the columns are the promise of what will be here — and hands the middle of itself to an EmptyState."
        className="block"
      >
        <Card tone="plain" className="w-full">
          <Card.Body flush>
            <DataTable
              label="Deployments in preview-1290"
              columns={COLUMNS.slice(0, 4)}
              rows={[]}
              getRowId={(row) => row.id}
              empty={
                <EmptyState
                  icon="rocket"
                  title="No Deployments yet"
                  action={<Button variant="pri">Deploy storefront</Button>}
                >
                  Every Deployment of this Application to this Environment shows
                  up here, with its build log and the commit it came from.
                </EmptyState>
              }
            />
          </Card.Body>
        </Card>
      </Row>
    </>
  );
}
