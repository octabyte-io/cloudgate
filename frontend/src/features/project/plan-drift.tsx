import { use } from "react";

import type { AwsDrift } from "@/lib/api/endpoints/project-config";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import { PlanCloudName } from "./plan-aws-lines";

/**
 * **Drift**: what someone changed by hand in the AWS console or in Google
 * Cloud, listed apart in amber, which Apply always puts back. Each entry names its Service (or the
 * Environment network) and says, field by field, the hand value → Cloudgate's; a sensitive value is
 * never shown, only `(sensitive)`. A resource deleted by hand "will be made again". One only a
 * replace puts back is red, with "brief downtime", and needs no typing: typed confirmation is for
 * removing a Service, not for a step.
 */
export function DriftSection({
  entries,
}: {
  entries: readonly { name: string; key: string; entry: AwsDrift }[];
}) {
  const cloud = use(PlanCloudName);
  return (
    <section
      aria-label="Drift"
      className="grid gap-2.5 rounded-lg border border-warn-line bg-warn-tint p-3 text-warn"
    >
      <h4 className="text-meta font-semibold tracking-wide uppercase">Drift</h4>
      <p className="text-meta">
        {`Changed by hand ${cloud === "AWS" ? "in the AWS console" : `in ${cloud}`}. Apply puts back Cloudgate's version.`}
      </p>
      {entries.map(({ name, key, entry }) => (
        <div
          key={key}
          aria-label={`Drift of ${name}`}
          className={cn(
            "grid gap-1",
            entry.replaceForcing &&
              "rounded-md border border-bad-line bg-bad-tint px-2.5 py-1.5 text-bad",
          )}
        >
          <p className="flex flex-wrap items-center gap-x-2 text-body">
            <Icon name="alert" size={14} className="flex-none" />
            <span className="font-mono font-medium">{name}</span>
            <span>{entry.line}</span>
          </p>
          {entry.fields.length > 0 ? (
            <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1 border-l border-warn-line pl-3 text-meta">
              {entry.fields.map((field) => (
                <div key={field.field} className="contents">
                  <dt className="font-mono">{field.field}</dt>
                  <dd className="min-w-0 font-mono wrap-anywhere text-tx">
                    <span className="text-tx-3">{field.hand}</span>
                    <span className="px-1.5 text-tx-3" aria-label="becomes">
                      →
                    </span>
                    <span>{field.cloudgate}</span>
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ))}
    </section>
  );
}
