import { type Column } from "@/components/console/data-table";
import { RowTime } from "@/components/console/rows/cells";
import {
  serviceColumns,
  type ServiceRow,
} from "@/components/console/rows/service-row";
import {
  HEALTH_STATE_RANK,
  HealthCell,
} from "@/components/console/service-health-state";
import { serviceHref } from "@/components/shell/service-href";
import type { EnvironmentService } from "@/lib/api/endpoints/environments";
import type { ServiceHealthRow } from "@/lib/api/endpoints/service-health";
import type {
  EnvironmentTokenSpend,
  SpendFigures,
} from "@/lib/api/endpoints/token-spend";
import { spendFact } from "@/lib/format/token-spend";

/**
 * The Environment's Services table (`panels/services.tsx`): its columns and
 * the row each Service maps to. The reasons for what is and is not a column
 * are on the panel.
 */

/**
 * The four `serviceColumns()` the Environment read can honestly fill, plus when
 * the service was created.
 *
 * See the note at the top for why source, domain, replicas and last-deployment
 * are dropped rather than dashed: the projection is uniform across eight kinds,
 * so it has none of them, and a permanently empty column is a statement.
 */
const KEPT = new Set(["name", "kind", "status", "open"]);

/**
 * `ServiceRow` plus the one field the Environment read has and the shared shape
 * does not. Widening the shared type instead would put a column on the Servers
 * and Project tables that neither of their mappers can fill.
 */
export type EnvironmentServiceRow = ServiceRow & {
  createdAt: string;
  /** This row's entry in the one health batch; absent while it loads. */
  health: ServiceHealthRow | undefined;
  healthPending: boolean;
  /** This AI model's 30-day spend; absent for anything else. */
  spend: SpendFigures | undefined;
};

export const ENVIRONMENT_SERVICE_COLUMNS: Column<EnvironmentServiceRow>[] = (() => {
  const kept: Column<EnvironmentServiceRow>[] = serviceColumns().filter(
    (column) => KEPT.has(column.id),
  );
  const created: Column<EnvironmentServiceRow> = {
    id: "created",
    head: "Created",
    compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
    cell: (row) => <RowTime iso={row.createdAt} />,
  };
  // Worst first when sorted ascending; a row the batch does not name last.
  const health: Column<EnvironmentServiceRow> = {
    id: "health",
    head: "Health",
    compare: (a, b) =>
      (a.health ? HEALTH_STATE_RANK[a.health.state] : 99) -
      (b.health ? HEALTH_STATE_RANK[b.health.state] : 99),
    cell: (row) => <HealthCell row={row.health} pending={row.healthPending} />,
  };
  // Health beside Status; Created before "open", which is the actions cell
  // and stays last.
  const status = kept.findIndex((column) => column.id === "status");
  return [
    ...kept.slice(0, status + 1),
    health,
    ...kept.slice(status + 1, -1),
    created,
    ...kept.slice(-1),
  ];
})();

/** Tokens, prompt and completion, reported and estimated together. */
const tokensOf = (figures: SpendFigures | undefined) =>
  figures
    ? figures.promptTokens.reported +
      figures.promptTokens.estimated +
      figures.completionTokens.reported +
      figures.completionTokens.estimated
    : -1;

/**
 * {@link ENVIRONMENT_SERVICE_COLUMNS} with each AI model's 30-day Token spend
 * before Created; a row that is not an AI model the reader can read
 * reads as a dash, and sorts below every figure.
 */
export const ENVIRONMENT_SERVICE_COLUMNS_WITH_SPEND: Column<EnvironmentServiceRow>[] =
  (() => {
    const spend: Column<EnvironmentServiceRow> = {
      id: "token-spend",
      head: "Token spend, 30 days",
      compare: (a, b) => tokensOf(a.spend) - tokensOf(b.spend),
      cell: (row) => {
        if (!row.spend) return <span className="text-tx-3">—</span>;
        const fact = spendFact(row.spend);
        return <span title={fact.title}>{fact.value}</span>;
      },
    };
    const created = ENVIRONMENT_SERVICE_COLUMNS.findIndex(
      (column) => column.id === "created",
    );
    return [
      ...ENVIRONMENT_SERVICE_COLUMNS.slice(0, created),
      spend,
      ...ENVIRONMENT_SERVICE_COLUMNS.slice(created),
    ];
  })();

/**
 * One summary row as the shared table wants it.
 *
 * The href is the only part a mapper has to know, because only it knows the kind
 * — and `serviceHref` (`components/shell/service-href.ts`) is that knowledge in
 * one place, shared with the Deployments and Domains tabs, which list the same
 * mixed set, and the Overview's health fact line.
 */
export function toServiceRow(
  service: EnvironmentService,
  health: Map<string, ServiceHealthRow> | undefined,
  healthPending: boolean,
  spend: EnvironmentTokenSpend | undefined,
): EnvironmentServiceRow {
  return {
    id: service.serviceId,
    kind: service.serviceType,
    name: service.name,
    appName: service.appName,
    status: service.status,
    href: serviceHref(service),
    createdAt: service.createdAt,
    health: health?.get(`${service.serviceType}:${service.serviceId}`),
    healthPending,
    spend:
      service.serviceType === "application"
        ? spend?.aiModels.find(
            (model) => model.applicationId === service.serviceId,
          )?.total
        : undefined,
  };
}
