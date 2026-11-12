"use client";

import { Card } from "@/components/console/card";
import { Chart } from "@/components/console/chart";
import { DataTable, type Column } from "@/components/console/data-table";
import { Plot } from "@/components/console/plot";
import { Sparkline } from "@/components/console/sparkline";
import { StatusPill } from "@/components/console/status-pill";
import { Separator } from "@/components/ui/separator";
import {
  CPU_SERIES,
  FLAT_SERIES,
  HOT_SERIES,
  MEMORY_SERIES,
  halfHourly,
} from "../_lib/fixtures";
import { Row } from "../../_components/shell";

const percent = (value: number) => `${value}%`;

type ServerRow = {
  id: string;
  name: string;
  status: "active" | "inactive";
  cpu: number;
  series: number[];
  tone: "brand" | "hot" | "mute" | "dead";
};

const SERVERS: ServerRow[] = [
  { id: "1", name: "manager-1", status: "active", cpu: 62, series: CPU_SERIES, tone: "brand" },
  { id: "2", name: "worker-1", status: "active", cpu: 61, series: MEMORY_SERIES, tone: "brand" },
  { id: "3", name: "worker-2", status: "active", cpu: 91, series: HOT_SERIES, tone: "hot" },
  { id: "4", name: "worker-3", status: "inactive", cpu: 6, series: FLAT_SERIES, tone: "mute" },
  { id: "5", name: "worker-4", status: "inactive", cpu: 0, series: FLAT_SERIES, tone: "dead" },
];

const SERVER_COLUMNS: Column<ServerRow>[] = [
  { id: "name", head: "Server", tone: "key", cell: (row) => row.name },
  {
    id: "status",
    head: "Status",
    cell: (row) => <StatusPill status={row.status} />,
  },
  {
    id: "cpu",
    head: "CPU",
    tone: "num",
    compare: (a, b) => a.cpu - b.cpu,
    cell: (row) => (row.status === "inactive" ? "—" : `${row.cpu}%`),
  },
  {
    id: "trend",
    head: "Last 24 hours",
    className: "w-40",
    cell: (row) => (
      <Sparkline
        label={`${row.name} CPU, last 24 hours`}
        values={row.series}
        tone={row.tone}
        format={percent}
      />
    ),
  },
];

export function TelemetryGallery() {
  return (
    <>
      <Row
        label="Chart"
        note="A number and its history. Move the pointer across the plot, or focus it and press the arrow keys — the readout is the same either way, and every value is also in a table for a screen reader."
        className="block"
      >
        <Card tone="plain" className="w-full">
          <Card.Body className="flex flex-col gap-5">
            <Chart
              label="CPU across the fleet"
              value="62"
              unit="%"
              detail="mean of 7 Servers"
              values={CPU_SERIES}
              tickCount={6}
              format={percent}
              labelAt={halfHourly}
            />
            <Separator />
            <Chart
              label="Memory on worker-2"
              value="91"
              unit="%"
              detail="15.6 of 16 GB — over its limit"
              tone="hot"
              values={HOT_SERIES}
              tickCount={6}
              format={percent}
              labelAt={halfHourly}
            />
          </Card.Body>
        </Card>
      </Row>

      <Row
        label="Plot, four tones"
        note="brand at rest, hot in trouble, mute when nothing is reporting, dead when the series has stopped — dashed as well as red, so it survives greyscale. Each one is labelled; none of them relies on its hue."
        className="grid w-full grid-cols-1 gap-5 cols:grid-cols-2"
      >
        {(
          [
            ["brand", "storefront, healthy", CPU_SERIES],
            ["hot", "worker-2, over its limit", HOT_SERIES],
            ["mute", "worker-3, no stats since 14:02", FLAT_SERIES],
            ["dead", "worker-4, stopped reporting", FLAT_SERIES],
          ] as const
        ).map(([tone, label, values]) => (
          <div key={tone}>
            <p className="mb-2 text-ui text-tx-2">{label}</p>
            <Plot
              label={label}
              tone={tone}
              values={values}
              tickCount={6}
              format={percent}
              labelAt={halfHourly}
            />
          </div>
        ))}
      </Row>

      <Row
        label="Sparkline, in a table cell"
        note="Thirty pixels tall, no axes: what has been happening, beside the number that says what is happening now."
        className="block"
      >
        <Card tone="plain" className="w-full">
          <Card.Body flush>
            <DataTable
              label="Servers and their CPU"
              columns={SERVER_COLUMNS}
              rows={SERVERS}
              getRowId={(row) => row.id}
            />
          </Card.Body>
        </Card>
      </Row>
    </>
  );
}
