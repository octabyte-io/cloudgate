import type { Plan, PlanStep } from "@/lib/api/endpoints/project-config";

import { AwsLines } from "./plan-aws-lines";

type Lookup = Extract<PlanStep, { action: "change" }> & {
  existing: NonNullable<Extract<PlanStep, { action: "change" }>["existing"]>;
};

/** A step that is only an Existing database's lookup: no field changes. */
export function isLookupOnly(step: PlanStep): boolean {
  return (
    step.action === "change" && !!step.existing && step.fields.length === 0
  );
}

/**
 * Each Existing database's lookup (ADR-0033), and each existing
 * bucket's: what every plan found of
 * the database the Environment uses as given — its address and notes (a
 * VPC Cloudgate cannot check, a major the config does not say) — or why the
 * plan is refused (missing, another engine, Cloudgate's tags, another VPC
 * without the tick). Shown even when it found the database as given, which
 * otherwise leaves nothing to change, so a plan never hides what it read.
 */
export function ExistingLookups({ plan }: { plan: Plan }) {
  const lookups = plan.steps.filter(
    (step): step is Lookup => step.action === "change" && !!step.existing,
  );
  if (lookups.length === 0) return null;
  // An existing bucket's lookup is the same step.
  const buckets = lookups.some((step) => step.kind === "bucket");
  const databases = lookups.some((step) => step.kind !== "bucket");
  const title =
    buckets && databases
      ? "Existing databases and buckets"
      : buckets
        ? "Existing buckets"
        : "Existing databases";
  return (
    <section aria-label={title} className="grid gap-2.5">
      <h4 className="text-meta font-semibold tracking-wide uppercase">
        {title}
      </h4>
      {lookups.map((step) => (
        <div key={step.configName} className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-body font-medium">
              {step.configName}
            </span>
            <span className="text-meta text-tx-3">
              uses <span className="font-mono">{step.existing.identifier}</span>
              , looked up and never changed
            </span>
          </div>
          {step.cloudRead ? <AwsLines aws={step.cloudRead} /> : null}
        </div>
      ))}
    </section>
  );
}
