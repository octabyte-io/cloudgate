import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { type Column, DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { Segmented } from "@/components/console/segmented";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import { Icon } from "@/lib/design/icons";
import { readCount } from "@/lib/format/token-spend";
import { cn } from "@/lib/utils";

import { SPEND_PARTS, SpendColumns, SpendSwatch } from "./spend-columns";
import {
  breakdownRows,
  DEFAULT_SPEND_RANGE,
  SPEND_RANGES,
  type SpendRange,
  type SpendRow,
  spendDays,
  totalCalls,
} from "./token-spend-view";
import { useTokenSpend } from "./use-token-spend";

/** The four outcomes of a call through the Gateway, in the route's words. */
const OUTCOMES = [
  { key: "ok" as const, head: "ok" },
  { key: "runtimeError" as const, head: "runtime-error" },
  { key: "clientAborted" as const, head: "client-aborted" },
  { key: "refused" as const, head: "refused" },
];

const COLUMNS: Column<SpendRow>[] = [
  {
    id: "agent",
    head: "Agent",
    tone: "key",
    compare: (a, b) => a.agentName.localeCompare(b.agentName),
    cell: (row) => (
      <span className="inline-flex items-center gap-1.5">
        {row.agentName}
        {row.removed ? <Chip>Removed</Chip> : null}
      </span>
    ),
  },
  {
    id: "model",
    head: "Model served",
    compare: (a, b) => a.model.localeCompare(b.model),
    cell: (row) => <span className="font-mono">{row.model}</span>,
  },
  {
    id: "tokens",
    head: "Tokens",
    tone: "num",
    compare: (a, b) => a.reported + a.estimated - (b.reported + b.estimated),
    cell: (row) => readCount(row.reported + row.estimated),
  },
  {
    id: "estimated",
    head: "Of which estimated",
    tone: "num",
    compare: (a, b) => a.estimated - b.estimated,
    cell: (row) => readCount(row.estimated),
  },
  ...OUTCOMES.map(
    (outcome): Column<SpendRow> => ({
      id: outcome.key,
      head: <span className="font-mono">{outcome.head}</span>,
      tone: "num",
      compare: (a, b) => a.calls[outcome.key] - b.calls[outcome.key],
      cell: (row) => readCount(row.calls[outcome.key]),
    }),
  ),
];

/**
 * **Token spend** on an AI model's Model tab: who spent
 * what on it, over 7, 30 or 90 UTC days or since it was created.
 *
 * Read from `GET /applications/:id/token-spend`, which asks for read
 * access to the AI model and nothing else, so everyone who can open the tab
 * sees the section. A refusal or a failure is said in the card, never drawn
 * as a window with no spend.
 *
 * **Estimated tokens are marked apart from reported ones** everywhere they
 * appear: a striped segment of their own in each day's column, a legend
 * that says what each is, the headline's "of which estimated", and a column
 * of the breakdown. A runtime that streams without usage leaves the Gateway
 * to count, and an operator reading a bill needs to know which part was
 * counted by whom.
 *
 * **The breakdown is Agent × model served**, with every call counted by its
 * outcome. A removed Agent keeps its row under the name it had, marked
 * removed: its spend happened and stays in the totals above.
 */
export function TokenSpendCard({ applicationId }: { applicationId: string }) {
  const [range, setRange] = useState<SpendRange>(DEFAULT_SPEND_RANGE);
  const spend = useTokenSpend(applicationId, range);
  const rangeLabel =
    SPEND_RANGES.find((each) => each.value === range)?.label ?? "";

  return (
    <Card>
      <Card.Header
        title="Token spend"
        sub="Tokens and calls through the Gateway, by UTC day and by Agent."
        actions={
          <Segmented
            label="Token spend window"
            options={SPEND_RANGES.map(({ value, label }) => ({ value, label }))}
            value={range}
            onChange={setRange}
          />
        }
      />
      <Card.Body>
        {spend.error ? (
          <p
            role="alert"
            className="flex gap-2 wrap-anywhere text-body text-tx"
          >
            <Icon name="alert" className="mt-0.5 flex-none text-bad" />
            {errorMessage(spend.error)}
          </p>
        ) : spend.isPending ? (
          <div className="grid gap-3" aria-busy="true">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-plot w-full" />
          </div>
        ) : (
          <SpendBody
            data={spend.data}
            stale={spend.isPlaceholderData}
            rangeLabel={rangeLabel}
          />
        )}
      </Card.Body>
    </Card>
  );
}

function SpendBody({
  data,
  stale,
  rangeLabel,
}: {
  data: NonNullable<ReturnType<typeof useTokenSpend>["data"]>;
  stale: boolean;
  rangeLabel: string;
}) {
  const days = spendDays(data.days);
  const rows = breakdownRows(data.breakdown);
  const reported =
    data.total.promptTokens.reported + data.total.completionTokens.reported;
  const estimated =
    data.total.promptTokens.estimated + data.total.completionTokens.estimated;
  const calls = totalCalls(data.total.calls);
  const window =
    rangeLabel === "All"
      ? "since this AI model was created"
      : `in the last ${rangeLabel}`;

  if (reported + estimated === 0 && calls === 0) {
    return (
      <EmptyState icon="activity" title={`No calls ${window}`}>
        Calls an Agent makes to this AI model through the Gateway are counted
        here, by day, with the tokens each one spent.
      </EmptyState>
    );
  }

  return (
    <div
      className={cn("grid gap-4 transition-opacity", stale && "opacity-60")}
      aria-busy={stale}
    >
      <div className="flex flex-col gap-4 hd:flex-row hd:gap-4.5">
        <div className="flex-none pt-0.5 hd:w-chart-side">
          <p className="text-ui text-tx-2">Tokens {window}</p>
          <p className="mt-1.25 text-hero text-tx num">
            {readCount(reported + estimated)}
          </p>
          <p className="mt-1 text-meta text-tx-3">
            of which <span className="num">{readCount(estimated)}</span>{" "}
            estimated, over <span className="num">{readCount(calls)}</span>{" "}
            {calls === 1 ? "call" : "calls"}
          </p>
        </div>
        <SpendColumns
          className="flex-1"
          label={`Tokens by UTC day ${window}`}
          days={days}
        />
      </div>

      <dl
        aria-label="Legend"
        className="flex flex-wrap gap-x-4 gap-y-1 text-meta"
      >
        {SPEND_PARTS.map((part) => (
          <div key={part.key} className="flex items-center gap-1.5">
            <SpendSwatch part={part} />
            <dt className="font-medium text-tx">{part.label}</dt>
            <dd className="text-tx-3">{part.sub}</dd>
          </div>
        ))}
      </dl>

      <DataTable
        label={`Token spend by Agent and model served, ${window}`}
        columns={COLUMNS}
        rows={rows}
        getRowId={(row) => row.id}
        empty={
          <p className="px-3 py-4 text-body text-tx-3">
            No Agent called this AI model {window}.
          </p>
        }
      />
    </div>
  );
}
