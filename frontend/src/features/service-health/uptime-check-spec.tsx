import type { ResourceSpec } from "@/components/console/resource-spec";
import { RowTime } from "@/components/console/rows/cells";
import { StatusPill } from "@/components/console/status-pill";
import type { ServiceType } from "@/lib/api/endpoints/applications";
import type { Domain } from "@/lib/api/endpoints/domains";
import type {
  CreateUptimeCheckInput,
  PublishedPorts,
  UpdateUptimeCheckInput,
  UptimeCheckHealth,
} from "@/lib/api/endpoints/service-health";
import { Icon } from "@/lib/design/icons";

import {
  checkMark,
  checkTargetLabel,
  expectedStatusesLabel,
  parseExpectedStatuses,
  probeErrorWords,
  secondsLabel,
  VANTAGE_HINT,
  VANTAGE_LINE,
} from "./health-words";
import { UptimeStrip } from "./uptime-strip";
import {
  domainOption,
  HEADER_ACTION_OPTIONS,
  headerValueChange,
  KIND_OPTIONS,
  uptimeCheckSchema,
  type UptimeCheckValues,
} from "./uptime-check-values";

/**
 * **An Uptime check, as a `ResourceSpec`**: the Health tab's
 * checks table and the modal that adds and edits one.
 *
 * The form's values, their bounds and the write-only header value's rule are
 * `uptime-check-values.ts`.
 *
 * **The target is picked, never typed**: an HTTP check's options are
 * this Service's own Domains, a TCP check's its published TCP ports, so
 * a check cannot be aimed at anything the Service does not serve. A database
 * has no Domain, so its checks are TCP and the kind is not asked. The kind is
 * fixed for a check's life, so an edit does not ask it either.
 *
 * **The header value is write-only**. The API never answers it, so the
 * box is always empty: on an add, or an edit of a check with no stored value,
 * typing one sets it; on an edit of a check that has one, **Keep**, **Replace**
 * or **Remove** is chosen first, and only Replace shows the box.
 */

export function uptimeCheckSpec({
  serviceType,
  serviceId,
  domains,
  domainsPending,
  publishedPorts,
  publishedPortsPending,
  create,
  update,
  remove,
  rowExtras,
}: {
  serviceType: ServiceType;
  serviceId: string;
  domains: readonly Domain[];
  domainsPending: boolean;
  /** The TCP picker's options; `undefined` while they load. */
  publishedPorts?: PublishedPorts;
  publishedPortsPending: boolean;
  create: (input: CreateUptimeCheckInput) => Promise<unknown>;
  update: (uptimeCheckId: string, input: UpdateUptimeCheckInput) => Promise<unknown>;
  remove: (uptimeCheckId: string) => Promise<unknown>;
  rowExtras?: (row: UptimeCheckHealth) => React.ReactNode;
}): ResourceSpec<UptimeCheckHealth, UptimeCheckValues> {
  /** A database has no Domain: its checks are TCP, and the kind is not asked. */
  const tcpOnly = serviceType !== "application" && serviceType !== "compose";
  const isHttp = (values: UptimeCheckValues) => values.kind === "http";
  const ports = publishedPorts?.ports ?? [];
  const noPorts = !publishedPortsPending && ports.length === 0;

  const schedule = (values: UptimeCheckValues) => ({
    intervalSeconds: values.intervalSeconds,
    timeoutSeconds: values.timeoutSeconds,
    downAfter: values.downAfter,
    enabled: values.enabled,
  });
  const httpRule = (values: UptimeCheckValues) => ({
    ...schedule(values),
    domainId: values.domainId,
    expectedStatuses: parseExpectedStatuses(values.expectedStatuses),
    keyword: values.keyword === "" ? null : values.keyword,
    headerName: values.headerName.trim() === "" ? null : values.headerName.trim(),
  });

  return {
    noun: "Uptime check",
    plural: "Uptime checks",
    title: "Uptime checks",
    lede: tcpOnly
      ? "Connections to this database's published port. A run of downs opens an Incident and the first up closes it."
      : "Probes of this Service's own Domains and published ports. A run of downs opens an Incident and the first up closes it.",
    icon: "activity",
    addLabel: "Add an Uptime check",
    emptyTitle: "Nothing is checked",
    emptyBody: tcpOnly
      ? noPorts
        ? (publishedPorts?.unavailableReason ??
          "A database's Uptime check dials its external port, and it has none yet.")
        : "An Uptime check dials this database's external port on an interval, and tells your notification channels once when it stops answering and once when it comes back."
      : domains.length === 0 && !domainsPending && noPorts
        ? "An Uptime check probes one of this Service's Domains or dials one of its published ports, and it has neither yet. Add a Domain on the Domains tab first."
        : "An Uptime check probes one of this Service's Domains, or dials one of its published ports, on an interval, and tells your notification channels once when it goes down and once when it comes back.",
    tableLabel: "Uptime checks of this Service",
    getRowId: (row) => row.uptimeCheckId,
    rowName: (row) => checkTargetLabel(row),
    defaultSort: { id: "target", dir: "asc" },
    rowExtras,

    columns: [
      {
        id: "target",
        head: "Target",
        tone: "wrap",
        compare: (a, b) => checkTargetLabel(a).localeCompare(checkTargetLabel(b)),
        cell: (row) => (
          <span className="grid justify-items-start gap-0.5">
            <span className="font-mono text-meta wrap-anywhere text-tx">
              {checkTargetLabel(row)}
            </span>
            <span
              className="inline-flex items-center gap-1 text-meta text-tx-3"
              title={VANTAGE_HINT}
            >
              {VANTAGE_LINE}
              <Icon name="info" size={12} />
              <span className="sr-only">. {VANTAGE_HINT}</span>
            </span>
          </span>
        ),
      },
      {
        id: "verdict",
        head: "Last verdict",
        // A floor, so the sub-line below wraps at its spaces rather than a
        // word to a line when the other columns squeeze this one.
        className: "min-w-36",
        cell: (row) => (
          <span className="grid justify-items-start gap-0.5">
            <StatusPill mark={checkMark(row)} />
            {/* Cloudgate's own reason for turning it off, so a check
                that lost its port does not read as one the operator silenced.
                Wraps like the probe line below, for the same reason. */}
            {row.disabledReason ? (
              <span className="text-meta whitespace-normal text-tx-3">
                {row.disabledReason}
              </span>
            ) : null}
            {row.lastProbe ? (
              // Wraps inside its cell, where `RowSub`'s `truncate` clipped
              // nothing: a `truncate` grid item in an auto-layout cell is as
              // wide as its text, so a down verdict's words ran past the cell
              // and over the strip's caption. Wrapped rather than
              // truncated, since the error words are what the line is for.
              <span className="text-meta whitespace-normal text-tx-3">
                <RowTime iso={row.lastProbe.probedAt} />
                {row.lastProbe.verdict === "down"
                  ? ` · ${probeErrorWords(row.lastProbe.errorClass) ?? "Down"}`
                  : row.lastProbe.latencyMs !== null
                    ? ` · ${row.lastProbe.latencyMs} ms`
                    : null}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "strip",
        head: "Last 24 hours",
        className: "min-w-44",
        cell: (row) => <UptimeStrip strip={row.strip} upShare={row.upShare24h} />,
      },
      {
        id: "rule",
        head: "Rule",
        tone: "wrap",
        cell: (row) =>
          row.kind === "tcp" ? (
            <span className="text-meta text-tx-2">
              Every {secondsLabel(row.intervalSeconds)}, connects, down after{" "}
              {row.downAfter}
            </span>
          ) : (
            <span className="text-meta text-tx-2">
              Every {secondsLabel(row.intervalSeconds)}, expects{" "}
              <span className="font-mono">
                {expectedStatusesLabel(row.expectedStatuses)}
              </span>
              {row.keyword ? (
                <>
                  {" "}
                  containing <span className="font-mono">{row.keyword}</span>
                </>
              ) : null}
              , down after {row.downAfter}
              {row.headerName ? (
                <>
                  {" "}
                  · sends <span className="font-mono">{row.headerName}</span>
                  {row.hasHeaderValue ? " (value saved)" : " (no value, not sent)"}
                </>
              ) : null}
            </span>
          ),
      },
    ],

    schema: uptimeCheckSchema,
    fields: [
      {
        kind: "select",
        name: "kind",
        label: "Kind",
        options: KIND_OPTIONS,
        when: (values) => !tcpOnly && !values.editing,
        hint: "Fixed once the check is added. HTTP reads a Domain's status line; TCP only asks whether the port accepts a connection.",
      },
      {
        kind: "select",
        name: "domainId",
        label: "Domain",
        when: isHttp,
        options: domains.map(domainOption),
        pending: domainsPending,
        placeholder: domains.length === 0 ? "This Service has no Domains" : "Choose a Domain",
        hint:
          domains.length === 0 && !domainsPending
            ? "Only this Service's own Domains can be checked, and it has none yet. Add one on the Domains tab first."
            : "Only this Service's own Domains. The check follows the Domain if it is edited, and is deleted with it.",
      },
      {
        kind: "select",
        name: "port",
        label: "Published port",
        when: (values) => values.kind === "tcp",
        options: ports.map((entry) => ({
          value: String(entry.port),
          label: `${entry.port} — ${entry.label}`,
        })),
        pending: publishedPortsPending,
        placeholder: noPorts ? "Nothing is published" : "Choose a port",
        hint: noPorts
          ? (publishedPorts?.unavailableReason ?? "This Service publishes no TCP port.")
          : `Only this Service's published TCP ports, dialled on ${publishedPorts?.host ?? "its Server's address"} as a client would.`,
      },
      {
        kind: "number",
        name: "intervalSeconds",
        label: "Interval (seconds)",
        min: 30,
        max: 3600,
        hint: "How often the platform host probes it: every 30 seconds at the fastest, every hour at the slowest.",
      },
      {
        kind: "number",
        name: "timeoutSeconds",
        label: "Timeout (seconds)",
        min: 1,
        max: 60,
        hint: "A Probe with no answer by then is down, as a refused connection or a failed DNS lookup is. No longer than the interval.",
      },
      {
        kind: "text",
        name: "expectedStatuses",
        label: "Expected statuses",
        mono: true,
        placeholder: "2xx",
        when: isHttp,
        hint: "Classes such as 2xx or codes such as 301 or 401, separated by commas. Any other status is down. Redirects are not followed.",
      },
      {
        kind: "text",
        name: "keyword",
        label: "Required keyword",
        optional: true,
        mono: true,
        when: isHttp,
        hint: "A body without it is down with “keyword missing”, so a 200 error page counts. Looked for in the first 256 KB, and never put in a notification.",
      },
      {
        kind: "text",
        name: "headerName",
        label: "Header name",
        optional: true,
        mono: true,
        placeholder: "Authorization",
        when: isHttp,
        hint: "One header sent with every Probe, for a protected health endpoint. Clearing the name removes the header and its value.",
      },
      {
        kind: "select",
        name: "headerValueAction",
        label: "Header value",
        options: HEADER_ACTION_OPTIONS,
        when: (values) => isHttp(values) && values.hasStoredValue,
        hint: "A value is saved. It is never shown again; replace it to rotate the credential.",
      },
      {
        kind: "password",
        name: "headerValue",
        label: "New header value",
        optional: true,
        when: (values) =>
          isHttp(values) &&
          (!values.hasStoredValue || values.headerValueAction === "replace"),
        hint: "Encrypted at rest and never shown again, here or anywhere else, once saved. Never put in a notification.",
      },
      {
        kind: "number",
        name: "downAfter",
        label: "Downs in a row before an Incident opens",
        min: 1,
        max: 20,
        hint: "One dropped Probe should not page anyone; 3 is the usual answer. The first up closes the Incident.",
      },
      {
        kind: "switch",
        name: "enabled",
        label: "Enabled",
        hint: "Turning it off stops the Probes and keeps its history. An open Incident closes as turned off.",
      },
    ],

    toDefaults: (row) => ({
      kind: row?.kind ?? (tcpOnly ? "tcp" : "http"),
      domainId:
        row?.target?.domainId ??
        (domains.length === 1 ? domains[0].domainId : ""),
      port: row?.tcpTarget
        ? String(row.tcpTarget.port)
        : ports.length === 1
          ? String(ports[0].port)
          : "",
      intervalSeconds: row?.intervalSeconds ?? 60,
      timeoutSeconds: row?.timeoutSeconds ?? 10,
      expectedStatuses: expectedStatusesLabel(row?.expectedStatuses ?? ["2xx"]),
      downAfter: row?.downAfter ?? 3,
      enabled: row?.enabled ?? true,
      keyword: row?.keyword ?? "",
      headerName: row?.headerName ?? "",
      headerValueAction: "keep",
      // Always empty: the value is write-only and never comes back.
      headerValue: "",
      hasStoredValue: row?.hasHeaderValue ?? false,
      editing: row != null,
    }),

    // Every write is `service: ['update']` on the Service, turning a
    // check off or on included.
    permissions: {
      create: { service: ["update"] },
      update: { service: ["update"] },
      remove: { service: ["update"] },
    },
    create: (values) => {
      if (values.kind === "tcp") {
        return create({
          serviceType,
          serviceId,
          kind: "tcp",
          port: Number(values.port),
          ...schedule(values),
        });
      }
      const headerValue = headerValueChange(values);
      return create({
        serviceType,
        serviceId,
        kind: "http",
        ...httpRule(values),
        ...(headerValue && { headerValue }),
      });
    },
    update: (row, values) => {
      if (row.kind === "tcp") {
        return update(row.uptimeCheckId, {
          port: Number(values.port),
          ...schedule(values),
        });
      }
      const headerValue = headerValueChange(values);
      return update(row.uptimeCheckId, {
        ...httpRule(values),
        ...(headerValue !== undefined && { headerValue }),
      });
    },
    remove: (row) => remove(row.uptimeCheckId),

    deleteDescription:
      "This removes the Uptime check with its Probes and its Incident history. It cannot be put back.",
    deleteNote: (row) => (
      <>
        The check on{" "}
        <strong className="font-medium text-tx">{checkTargetLabel(row)}</strong>{" "}
        stops, and its Probes and Incidents are deleted with it.{" "}
        <strong className="font-medium text-tx">Nothing is announced</strong>:
        an Incident open now is not closed on your notification channels. Turn
        the check off instead to close it and keep the history.
      </>
    ),
  };
}
