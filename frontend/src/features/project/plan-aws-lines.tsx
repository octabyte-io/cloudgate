import { createContext, use } from "react";

import type { AwsRawLine, CloudRead } from "@/lib/api/endpoints/project-config";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

/**
 * The cloud a plan reads, as its lines name it: "AWS", "Google Cloud"
 * or "the cloud" where the viewer cannot see which.
 */
export const PlanCloudName = createContext("AWS");

/**
 * A cloud step's lines (following the `prototype/cloud-plan-view`
 * branch): "reading AWS…" (or "reading Google Cloud…") while its read
 * runs, the reason when it failed, and otherwise the plain summary, always
 * open, with the raw lines folded under "Show N AWS resources". A line that
 * takes a database offline is marked: a restart in amber, a major
 * upgrade in red.
 */
export function AwsLines({ aws }: { aws: CloudRead }) {
  const cloud = use(PlanCloudName);
  if (aws.status === "reading") {
    return (
      <p className="text-meta text-tx-3 italic" role="status">
        reading {cloud}…
      </p>
    );
  }
  if (aws.status === "failed") {
    return (
      <p className="text-meta text-bad">
        Could not read {cloud}: {aws.reason}
      </p>
    );
  }
  const outages = new Map(
    (aws.outages ?? []).map((outage) => [outage.line, outage.kind]),
  );
  return (
    <div className="grid gap-1.5">
      {aws.summary.length > 0 ? (
        <ul className="grid gap-0.5 border-l-2 border-line-2 pl-2.5 text-meta text-tx-2">
          {aws.summary.map((line) => {
            const outage = outages.get(line);
            return (
              <li
                key={line}
                aria-label={outage ? `Outage: ${line}` : undefined}
                className={cn(
                  outage && "flex items-start gap-1.5 font-medium",
                  outage === "restart" && "text-warn",
                  outage === "major-upgrade" && "text-bad",
                )}
              >
                {outage ? (
                  <Icon name="alert" size={14} className="mt-0.5 flex-none" />
                ) : null}
                <span>{line}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {aws.raw.length > 0 ? (
        <details className="group">
          <summary className="w-fit cursor-pointer text-meta text-brand-tx">
            {`Show ${aws.raw.length} ${cloud} resource${aws.raw.length === 1 ? "" : "s"}`}
          </summary>
          <RawTable lines={aws.raw} />
        </details>
      ) : null}
    </div>
  );
}

const ACTION_TONE: Record<AwsRawLine["action"], string> = {
  create: "text-ok",
  change: "text-brand-tx",
  replace: "text-bad",
  destroy: "text-bad",
  adopt: "text-warn",
};

function RawTable({ lines }: { lines: AwsRawLine[] }) {
  return (
    <div className="mt-1.5 overflow-x-auto rounded-md border border-line bg-panel-2">
      <table className="w-full border-collapse font-mono text-meta">
        <tbody>
          {lines.map((line) => (
            <tr
              key={line.address}
              className="border-b border-line last:border-b-0"
            >
              <td className="px-2 py-0.5 whitespace-nowrap text-tx-2">
                {line.address}
              </td>
              <td
                className={cn(
                  "px-2 py-0.5 whitespace-nowrap",
                  ACTION_TONE[line.action],
                )}
              >
                {line.action}
                {line.briefDowntime ? ", brief downtime" : ""}
              </td>
              <td className="px-2 py-0.5 text-tx-3">
                {line.fields.join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
