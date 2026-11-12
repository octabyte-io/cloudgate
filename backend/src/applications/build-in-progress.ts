import { ConflictException } from '@nestjs/common';
import {
  DEPLOYMENT_IN_PROGRESS_CODE,
  STUCK_DEPLOYMENT_MINUTES,
} from 'api-schemas';
import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';

import type { DrizzleDB } from '../db/drizzle.module';
import { deployment } from '../db/schema';

/**
 * Refuses an upload while a build of the Application is pending or running
 * (spec "No upload during a build"): the upload's program starts
 * with `rm -rf` of the code directory, the very tree that build reads, and
 * the console or a second terminal could otherwise pull it from under it.
 *
 * Only the Application's own builds count: a preview's builds and a Cron
 * service's runs do not read that tree. A build pending or running for more
 * than {@link STUCK_DEPLOYMENT_MINUTES} is taken as stuck and holds nothing,
 * which is what lets `cloudgate deploy` go ahead past it with a warning; a
 * held one waits on a plan and builds from whatever tree is there when it is
 * released.
 */
export async function refuseWhileBuilding(
  db: DrizzleDB,
  applicationId: string,
  now: Date = new Date(),
): Promise<void> {
  const since = new Date(
    now.getTime() - STUCK_DEPLOYMENT_MINUTES * 60_000,
  ).toISOString();
  const [building] = await db
    .select({
      deploymentId: deployment.deploymentId,
      status: deployment.status,
    })
    .from(deployment)
    .where(
      and(
        eq(deployment.applicationId, applicationId),
        inArray(deployment.status, ['pending', 'running']),
        isNull(deployment.previewDeploymentId),
        isNull(deployment.cronRun),
        gt(deployment.createdAt, since),
      ),
    )
    .orderBy(desc(deployment.createdAt))
    .limit(1);
  if (!building) return;
  throw new ConflictException({
    message: `Deployment ${building.deploymentId} is ${building.status}, and an upload would replace the files it builds from; upload again once it has finished`,
    code: DEPLOYMENT_IN_PROGRESS_CODE,
  });
}
