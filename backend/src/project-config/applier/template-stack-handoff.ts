import { eq, sql } from 'drizzle-orm';

import { describeError } from '../../common/describe-error';
import type { DrizzleDB } from '../../db/drizzle.module';
import { compose, environment, plan, project } from '../../db/schema';
import type { DomainsService } from '../../domains/domains.service';
import type { MountsService } from '../../mounts/mounts.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import {
  stackDomainsWaiting,
  takePart,
} from '../../templates/setup/pending-setups';

/**
 * **What a fresh Stack VM takes before its stack's first Deployment**
 * (ADR-0070, #1379), once the Cloud run that made it sees it answer:
 *
 * - **Its config files.** A file mount made while the Stack VM did not
 *   exist yet is a row only (`MountsService`), so every file mount of the
 *   stack is written onto it, as a Server's is when it is made.
 * - **A Template's Domains.** A Template stack set up in a Cloud
 *   Environment keeps its Domains in its Pending setup until now (ADR-0065
 *   as amended by #1379): a Domain's load balancer rule reaches the Stack
 *   VM, so the cloud Domain path refuses one until it is made. Each is
 *   added through that path, as the console adds one, on behalf of the
 *   member who applied the plan, whose `domain: create` that Apply asked;
 *   each queues its own Domain run. Before the first Deployment, which
 *   publishes their ports. The part then leaves the Pending setup; a Domain
 *   the path refuses (its host taken since, a quota) is named in the run's
 *   log, to be added on the stack's page.
 */
export async function handFreshStackVmOn(
  deps: {
    readonly db: DrizzleDB;
    readonly mounts: MountsService;
    readonly domains: DomainsService;
  },
  run: { readonly deploymentId: string; readonly composeId: string },
  log: (line: string) => Promise<void>,
): Promise<void> {
  const { db, mounts, domains } = deps;
  const files = await mounts.writeStackVmFiles(run.composeId);
  if (files > 0) {
    await log(`Wrote the stack's ${files} config file(s) onto its Stack VM`);
  }

  const waiting = await stackDomainsWaiting(db, run.composeId);
  if (!waiting) return;
  const ctx = await applierOf(db, run);
  for (const domain of waiting.domains) {
    if (!ctx) {
      await log(
        `Domain ${domain.host} was not added: no applied plan names this run. Add it on the stack's Domains`,
      );
      continue;
    }
    try {
      await domains.createForNewService(ctx, {
        host: domain.host,
        path: domain.path,
        port: domain.port,
        serviceName: domain.service,
        composeId: run.composeId,
        domainType: 'compose',
        https: true,
      });
      await log(
        `Added Domain ${domain.host} for ${domain.service} on port ${domain.port}, from the template's setup`,
      );
    } catch (error) {
      await log(
        `Domain ${domain.host} was not added: ${describeError(error)}. Add it on the stack's Domains`,
      );
    }
  }
  await takePart(db, waiting.pendingSetupId, waiting.configName);
}

/**
 * The member who applied the plan that recorded this run, in the stack's
 * Organization: the Domains are theirs, as the rest of that Apply was.
 */
async function applierOf(
  db: DrizzleDB,
  run: { readonly deploymentId: string; readonly composeId: string },
): Promise<PermissionCtx | null> {
  const [applied] = await db
    .select({ appliedBy: plan.appliedBy })
    .from(plan)
    .where(
      sql`jsonb_contains(${plan.results}, ${JSON.stringify([{ deploy: { deploymentId: run.deploymentId } }])}::jsonb)`,
    )
    .limit(1);
  const [stack] = await db
    .select({ organizationId: project.organizationId })
    .from(compose)
    .innerJoin(
      environment,
      eq(compose.environmentId, environment.environmentId),
    )
    .innerJoin(project, eq(environment.projectId, project.projectId))
    .where(eq(compose.composeId, run.composeId));
  if (!applied?.appliedBy || !stack) return null;
  return {
    user: { id: applied.appliedBy },
    session: { activeOrganizationId: stack.organizationId },
  };
}
