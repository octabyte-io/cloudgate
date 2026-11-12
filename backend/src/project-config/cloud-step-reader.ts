import type { CloudRunControl } from '../deployment-queue/cloud-run-job.types';
import type { CloudRead, PlanStep } from './planner/plan.types';

export type Create = Extract<PlanStep, { action: 'create' }>;
export type Change = Extract<PlanStep, { action: 'change' }>;

export type PostgresCreate = Create & {
  readonly database: NonNullable<Create['database']>;
};

/** A bucket created on AWS, its real name minted as the plan was stored. */
export type BucketCreate = Create & {
  readonly bucket: NonNullable<Create['bucket']>;
};

export type RedisCreate = Create & {
  readonly cache: NonNullable<Create['cache']>;
};

/** A Compose stack created in a Cloud account: its Stack VM (ADR-0070). */
export type StackVmCreate = Create & {
  readonly stackVm: NonNullable<Create['stackVm']>;
};

/**
 * A step that reads a cloud: a cloud `web`, `postgres` or `redis`
 * create, a cloud Service's change or read for Drift, or the
 * network's create or read for Drift.
 */
export type CloudStep =
  | (Create & { readonly cloud: NonNullable<Create['cloud']> })
  | PostgresCreate
  | BucketCreate
  | RedisCreate
  | StackVmCreate
  | Change
  | Extract<PlanStep, { action: 'network-create' | 'network-change' }>;

/** The ids a read made again keeps from the plan's own read. */
export interface KeptIds {
  readonly stateId?: string;
  readonly serviceId?: string;
}

/** What the plan knows of a step beyond the step itself. */
export interface StepReadOptions {
  /** Whether the strays of the search for what Cloudgate made are this step's to note. */
  readonly notesStrays: boolean;
  /** The ids a read made again by its Apply keeps from the plan's own. */
  readonly kept?: KeptIds;
  /** The kind of each Service the same plan creates, by Config name: a wired variable's stand-in reads it. */
  readonly creates?: Readonly<Record<string, string>>;
  /** The real name of each bucket on AWS the same plan creates, by Config name. */
  readonly plannedBuckets: ReadonlyMap<string, string>;
  /** For a network create: the state a create that did not finish left, which its Apply finishes. */
  readonly unfinishedNetworkState: string | null;
}

/**
 * **One cloud's plan reads** (S7b): what a plan step reads from that
 * cloud, as `CloudPlanReads` hands it a step in a Cloud account there.
 * `AwsPlanReads` and `GooglePlanReads` are the two; `CloudPlanReads` picks
 * one by the Cloud account's cloud (ADR-0043) and runs it in the Cloud run
 * pool. Every refusal is the read's `failed` reason; only a fault of
 * Cloudgate's own throws.
 */
export interface CloudStepReader<Account> {
  read(
    account: Account,
    place: { readonly environmentId: string; readonly region: string },
    step: CloudStep,
    control: CloudRunControl,
    options: StepReadOptions,
  ): Promise<CloudRead>;
}

export function failed(reason: string): CloudRead {
  return { status: 'failed', reason };
}
