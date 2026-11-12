import type {
  AwsDrift,
  CloudRead,
  Plan,
  PlanStep,
} from "@/lib/api/endpoints/project-config";

/**
 * What a cloud plan's AWS reads add up to:
 * the totals strip, and what Apply waits on.
 */

type NetworkStep = Extract<
  PlanStep,
  { action: "network-create" | "network-change" }
>;

/** Whether the step is the Environment network's: its create, or its read for Drift. */
export function isNetworkStep(step: PlanStep): step is NetworkStep {
  return step.action === "network-create" || step.action === "network-change";
}

/**
 * A step's AWS read, when it has one: a cloud `web` create's, the network's,
 * or a cloud Service's change.
 */
export function cloudReadOf(step: PlanStep): CloudRead | null {
  if (isNetworkStep(step)) return step.cloudRead;
  if (step.action === "create" || step.action === "change") {
    return step.cloudRead ?? null;
  }
  return null;
}

/** How a step is named where a person reads it. */
export function stepName(step: PlanStep): string {
  return isNetworkStep(step) || step.action === "network-remove"
    ? `the Environment network (${step.region})`
    : step.configName;
}

/**
 * A step a plan made only to read AWS for Drift: a cloud Service
 * whose config is unchanged, or the made network on Check for changes.
 */
export function isDriftCheck(step: PlanStep): boolean {
  return (
    step.action === "network-change" ||
    (step.action === "change" &&
      step.fields.length === 0 &&
      // A postgres on RDS's change, a redis on ElastiCache's,
      // and a bucket's CORS change, is planned, not a Drift check.
      !step.database &&
      !step.cache &&
      !step.cors)
  );
}

/** A Drift check whose read found AWS as Cloudgate made it: nothing to show or apply. */
export function isQuiet(step: PlanStep): boolean {
  const aws = cloudReadOf(step);
  return isDriftCheck(step) && aws?.status === "read" && aws.raw.length === 0;
}

/** A Drift check whose read found only Drift: shown in the Drift section alone. */
export function isDriftOnly(step: PlanStep): boolean {
  const aws = cloudReadOf(step);
  if (!isDriftCheck(step) || aws?.status !== "read") return false;
  const { create, change, destroy, replace, adopt, drift } = aws.counts;
  return drift > 0 && create + change + destroy + replace + adopt === 0;
}

/** Each step's Drift, named by its step, in plan order. */
export function driftOf(
  plan: Plan,
): { name: string; key: string; entry: AwsDrift }[] {
  return plan.steps.flatMap((step) => {
    const aws = cloudReadOf(step);
    if (aws?.status !== "read") return [];
    const name =
      isNetworkStep(step) || step.action === "network-remove"
        ? `Environment network (${step.region})`
        : step.configName;
    return aws.drift.map((entry) => ({
      name,
      key: `${name}-${entry.address}`,
      entry,
    }));
  });
}

/** "Found in AWS, in no state": each find once, a note that changes nothing. */
export function noStateLines(plan: Plan): string[] {
  const lines = plan.steps.flatMap((step) => {
    const aws = cloudReadOf(step);
    return aws?.status === "read" ? aws.noState.map((note) => note.line) : [];
  });
  return [...new Set(lines)];
}

/**
 * Whether all a plan does is put AWS back: only Drift checks, at
 * least one of which found Drift. Its Apply is "Apply: put AWS back".
 */
export function putsBackOnly(plan: Plan): boolean {
  return (
    plan.steps.every((step) => isQuiet(step) || isDriftOnly(step)) &&
    plan.steps.some(isDriftOnly)
  );
}

/** Whether any step of the plan reads AWS: only then is there a totals strip. */
export function readsAws(plan: Plan): boolean {
  return plan.steps.some((step) => cloudReadOf(step) !== null);
}

export interface PlanTotals {
  create: number;
  change: number;
  destroy: number;
  drift: number;
  briefDowntime: number;
}

/**
 * "N create · N change · N destroy · N drift · N brief downtime": each read
 * step's AWS resources, a replace counted as a change, and each step with
 * no AWS lines (a Service on a Server, a step still reading) as itself.
 */
export function planTotals(plan: Plan): PlanTotals {
  const totals: PlanTotals = {
    create: 0,
    change: 0,
    destroy: 0,
    drift: 0,
    briefDowntime: 0,
  };
  for (const step of plan.steps) {
    const aws = cloudReadOf(step);
    if (aws?.status === "read") {
      totals.create += aws.counts.create + aws.counts.adopt;
      totals.change += aws.counts.change + aws.counts.replace;
      totals.destroy += aws.counts.destroy;
      totals.drift += aws.counts.drift;
      totals.briefDowntime += aws.counts.briefDowntime;
      continue;
    }
    // A Drift check still reading may find nothing at all.
    if (isDriftCheck(step)) continue;
    if (step.action === "destroy") totals.destroy += 1;
    else if (step.action === "change") totals.change += 1;
    else totals.create += 1;
  }
  return totals;
}

export function totalsLine(totals: PlanTotals): string {
  return [
    `${totals.create} create`,
    `${totals.change} change`,
    `${totals.destroy} destroy`,
    `${totals.drift} drift`,
    `${totals.briefDowntime} brief downtime`,
  ].join(" · ");
}

/**
 * Why Apply is greyed out, or `null` when no read holds it back: the steps
 * still reading AWS, and those whose read failed. There is no partial Apply.
 */
export function awsWaitLine(plan: Plan, cloud = "AWS"): string | null {
  const reading: string[] = [];
  const failed: string[] = [];
  for (const step of plan.steps) {
    const aws = cloudReadOf(step);
    if (aws?.status === "reading") reading.push(stepName(step));
    if (aws?.status === "failed") failed.push(stepName(step));
  }
  if (failed.length > 0) {
    return `Apply is refused until ${cloud} can be read for ${failed.join(", ")}. Check for changes to read it again.`;
  }
  if (reading.length > 0) {
    return `Waiting for ${cloud} to be read for ${reading.join(", ")}.`;
  }
  return null;
}
