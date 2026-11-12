import type { PlanReading } from '../../cloud-accounts/aws/plan-reader/read-plan';

/** One resource change as a plan made it, without the values it carries. */
function changeKey(line: PlanReading['raw'][number]): string {
  const fields = [...line.fields].sort().join(', ');
  return fields === ''
    ? `${line.action} ${line.address}`
    : `${line.action} ${line.address} (${fields})`;
}

function counted(reading: PlanReading): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of reading.raw) {
    const key = changeKey(line);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether a plan made again makes exactly what the shown one did (the AWS spec
 * "Ordering inside an Apply"), or what differs.
 *
 * Compared by **what changes**, not by the words shown: each resource's
 * address, its action (create, change, replace, destroy, adopt) and the
 * fields a change or replace touches. The values are left out on purpose.
 * A Service's plan before its network existed held stand-ins where the
 * network's ids go, which the plan reader showed as "made by this plan
 * (Environment network)"; made again with the real ids, every such value
 * reads differently while the plan makes the same things. A field newly
 * changed, a resource added or one gone is a different plan.
 *
 * Answers `null` when they agree, else one sentence naming each change
 * only one of them makes.
 */
export function changesDiffer(
  shown: PlanReading,
  now: PlanReading,
): string | null {
  const before = counted(shown);
  const after = counted(now);
  const gone: string[] = [];
  const added: string[] = [];
  for (const [key, count] of before) {
    for (let i = after.get(key) ?? 0; i < count; i++) gone.push(key);
  }
  for (const [key, count] of after) {
    for (let i = before.get(key) ?? 0; i < count; i++) added.push(key);
  }
  if (gone.length === 0 && added.length === 0) return null;
  const parts = [
    added.length > 0 ? `it now would ${added.sort().join('; ')}` : null,
    gone.length > 0 ? `it no longer would ${gone.sort().join('; ')}` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(', and ');
}

/**
 * The changes `now` makes that `listed` does not, each as one key, or
 * `null` when every one of them is listed. The deploy half of the
 * auto-apply rule (the AWS spec): a deploy no Apply queued goes on with "what
 * an approved plan already listed", so a deploy that finishes what its
 * Apply's first deploy left undone needs no new plan. Compared like
 * {@link changesDiffer}, by what changes and never by value.
 */
export function unlisted(listed: PlanReading, now: PlanReading): string | null {
  const allowed = counted(listed);
  const extra: string[] = [];
  for (const [key, count] of counted(now)) {
    for (let i = allowed.get(key) ?? 0; i < count; i++) extra.push(key);
  }
  return extra.length === 0 ? null : `it would ${extra.sort().join('; ')}`;
}

/**
 * A reading without the lines of these addresses: what a plan still makes
 * once a targeted apply made them (a Service's ECR repository before its first
 * push).
 */
export function withoutAddresses(
  reading: PlanReading,
  addresses: ReadonlySet<string>,
): PlanReading {
  return {
    ...reading,
    raw: reading.raw.filter((line) => !addresses.has(line.address)),
  };
}

/** The service fields a new image moves: its task definition, and its variables' digest. */
const IMAGE_SERVICE_FIELDS = new Set(['task_definition', 'triggers']);

/**
 * A reading without the lines a new image brings: the task
 * definition's new revision, the SSM parameters of the deploy's variables
 * and the service update to use them — the image-only shape. What a deploy that
 * builds may add to a read made on the live image.
 */
export function withoutImageLines(reading: PlanReading): PlanReading {
  return {
    ...reading,
    raw: reading.raw.flatMap((line) => {
      if (line.resourceType === 'aws_ssm_parameter') return [];
      if (
        line.resourceType === 'aws_ecs_task_definition' &&
        line.action === 'replace'
      ) {
        return [];
      }
      if (line.resourceType === 'aws_ecs_service' && line.action === 'change') {
        const fields = line.fields.filter(
          (field) => !IMAGE_SERVICE_FIELDS.has(field),
        );
        return fields.length === 0 ? [] : [{ ...line, fields }];
      }
      return [line];
    }),
  };
}
