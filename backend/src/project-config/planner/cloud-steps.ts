import type { ProjectConfig } from '../project-config.types';
import type { CloudRead, NetworkStep, PlanStep } from './plan.types';

/**
 * Whether a step is an Environment network's: its create, its read for
 * Drift, or its removal.
 */
export function isNetworkStep(step: PlanStep): step is NetworkStep {
  return (
    step.action === 'network-create' ||
    step.action === 'network-change' ||
    step.action === 'network-remove'
  );
}

/**
 * Whether a step only makes or moves a console-managed stack's Stack VM
 * (#1372, #1368): the create of one the console wrote with none made yet,
 * or a resize, grow or "replace VM" from its console setting and
 * Cloudgate's pins. No config field asked for either, so describing the
 * stack as `managed: console` is still right, and a Save applies neither:
 * they wait for the Environment's next plan. Without this, a console Save
 * in an Environment holding such a stack read the step as the config
 * failing to describe a console-managed entry, and refused the Save.
 */
export function movesConsoleStackVm(
  step: PlanStep,
  config: ProjectConfig,
): boolean {
  return (
    (step.action === 'create' || step.action === 'change') &&
    step.kind === 'compose' &&
    step.stackVm !== undefined &&
    step.fields.length === 0 &&
    config.services[step.configName]?.managed === 'console'
  );
}

/**
 * A create in a Cloud account that sits in the Environment network: a `web`
 * a `postgres` or a `redis`, on Google Cloud too, or a Compose stack's
 * Stack VM, in a private subnet of it.
 * A bucket on S3
 * needs no network, so it is not one: no network is made for it, nor its
 * read made again.
 */
export function isCloudCreate(
  step: PlanStep,
): step is Extract<PlanStep, { action: 'create' }> {
  return (
    step.action === 'create' &&
    (step.cloud !== undefined ||
      step.database !== undefined ||
      step.cache !== undefined ||
      step.cloudSql !== undefined ||
      step.memorystore !== undefined ||
      step.stackVm !== undefined)
  );
}

/**
 * A step's read of its cloud, when it has one: a cloud `web`
 * create's, the network's, or a cloud Service's change.
 */
export function cloudReadOf(step: PlanStep): CloudRead | null {
  if (step.action === 'network-create' || step.action === 'network-change') {
    return step.cloudRead;
  }
  if (step.action === 'create' || step.action === 'change') {
    return step.cloudRead ?? null;
  }
  return null;
}

/** How a step is named where a person reads it: its Config name, or the network's. */
export function cloudStepName(step: PlanStep): string {
  return isNetworkStep(step)
    ? `the Environment network (${step.region})`
    : step.configName;
}

/**
 * A step that, once read, has nothing to do: a cloud Service read
 * for Drift whose config is unchanged, or a made network, where AWS does not
 * differ either. A plan of only these is "unchanged".
 */
export function isQuietRead(step: PlanStep): boolean {
  const read =
    step.action === 'network-change' ||
    (step.action === 'change' &&
      step.fields.length === 0 &&
      // A postgres on RDS's change, or a redis on ElastiCache's
      // is planned, not a Drift read, and a bucket's CORS change
      // is recorded by its Apply even when AWS already holds it.
      !step.database &&
      !step.cache &&
      !step.cloudSql &&
      !step.memorystore &&
      !step.cors &&
      // A Stack VM's change records what it moves to even when its
      // cloud already holds it (#1368); its read for Drift alone is quiet.
      !step.stackVm?.lines.length)
      ? step.cloudRead
      : undefined;
  // An Existing database found at a new address has that to apply.
  return read?.status === 'read' && read.raw.length === 0 && !read.addressMoved;
}

/**
 * A cloud Service's step whose config is unchanged and which a plan read on
 * its live image: what it shows is AWS differing, which its Apply
 * puts back with a Deployment on that image rather than a build. A step a
 * stopped deploy left its own read on is not one: its Apply builds.
 */
export function isDriftRead(
  step: PlanStep,
): step is Extract<PlanStep, { action: 'change' }> {
  return (
    step.action === 'change' &&
    step.fields.length === 0 &&
    !step.database &&
    !step.cache &&
    !step.cloudSql &&
    !step.memorystore &&
    step.serviceType === 'application' &&
    step.cloudRead?.status === 'read' &&
    step.cloudRead.liveImage !== undefined
  );
}
