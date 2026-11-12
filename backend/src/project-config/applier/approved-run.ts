import { sql } from 'drizzle-orm';

import type { PlanReading } from '../../cloud-accounts/aws/plan-reader/read-plan';
import type { TofuFailure, TofuShow } from '../../cloud-accounts/cloud.port';
import { readGooglePlan } from '../../cloud-accounts/gcp/plan-reader/read-plan';
import type { DrizzleDB } from '../../db/drizzle.module';
import { plan } from '../../db/schema';
import type { CloudRunControl } from '../../deployment-queue/cloud-run-job.types';
import type { PlanStep } from '../planner/plan.types';
import { checkBeforeApply, readNow, staleApproval } from './cloud-deploy-steps';
import { changesDiffer } from './same-changes';

// What one Cloud run of a Service's create or change holds to: the read its
// plan's Apply approved, and the check that AWS
// still matches it before anything is applied. One copy for the bucket,
// static site, postgres and redis runs, which each wrote it out.

/** What an Apply approved for one run: the plan's read, and whether it is a change. */
export interface ApprovedRun {
  readonly reading: PlanReading;
  readonly change: boolean;
}

type CreateOrChange = Extract<PlanStep, { action: 'create' | 'change' }>;

/**
 * The step the plan whose Apply recorded this run approved, read back after
 * a restart, with its read; `null` when no applied plan names the run or its
 * read did not land.
 */
export async function approvedOnPlan(
  db: DrizzleDB,
  deploymentId: string,
  configName: string,
): Promise<(ApprovedRun & { readonly step: CreateOrChange }) | null> {
  const [found] = await db
    .select({ steps: plan.steps })
    .from(plan)
    .where(
      sql`jsonb_contains(${plan.results}, ${JSON.stringify([{ deploy: { deploymentId } }])}::jsonb)`,
    )
    .limit(1);
  const step = found?.steps.find(
    (one): one is CreateOrChange =>
      (one.action === 'create' || one.action === 'change') &&
      one.configName === configName,
  );
  if (step?.cloudRead?.status !== 'read') return null;
  return { reading: step.cloudRead, change: step.action === 'change', step };
}

/**
 * {@link beforeApplyingApproved} for a run in a Google Cloud project:
 * the plan read again by the Google reader, and a refusal naming Google
 * Cloud.
 */
export function beforeApplyingApprovedOnGoogle(
  approved: ApprovedRun,
  log: (line: string) => Promise<void>,
  control: CloudRunControl,
): (show: TofuShow) => TofuFailure | null {
  return (show) => {
    const now = readGooglePlan({ show, nameSearch: [], context: {} });
    for (const line of now.summary) void log(`📋 [Cloud run] ${line}`);
    const differs = changesDiffer(approved.reading, now);
    if (differs) {
      return {
        ok: false,
        reason: 'failed',
        message: `Google Cloud no longer matches the plan that was applied: ${differs}. Nothing was applied; Check for changes, then apply the new plan`,
      };
    }
    if (!control.beginApply()) {
      return {
        ok: false,
        reason: 'interrupted',
        message: 'The run was ended before it changed anything',
      };
    }
    return null;
  };
}

/**
 * A run's `beforeApply`: the plan read again is logged line by line, then
 * refused when it no longer matches the approved read, or the apply begins.
 */
export function beforeApplyingApproved(
  approved: ApprovedRun,
  log: (line: string) => Promise<void>,
  control: CloudRunControl,
): (show: TofuShow) => TofuFailure | null {
  return (show) => {
    for (const line of readNow(show).summary) {
      void log(`📋 [Cloud run] ${line}`);
    }
    return checkBeforeApply(
      show,
      (now) => {
        const differs = changesDiffer(approved.reading, now);
        return differs ? staleApproval(differs) : null;
      },
      () => control.beginApply(),
    );
  };
}
