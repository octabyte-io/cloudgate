import { and, eq } from 'drizzle-orm';

import type { DrizzleDB } from '../db/drizzle.module';
import { deployment } from '../db/schema';
import {
  NOT_DEPLOYED_VOLUMES_REASON,
  NOT_RECORDED_VOLUMES_REASON,
} from './compose-file';

/**
 * Why a stack with no `compose.deployedServiceVolumes` record has none
 * (#171): no deploy has succeeded yet, or the last one ran on a Cloudgate
 * older than the record (0.3.13), and the stack is running. The two read
 * the same column and need different words: the second has deployed, and
 * its way out is a redeploy. One answer for `GET /compose/:id/volumes` and a
 * Stack backup's run.
 */
export async function unrecordedVolumesReason(
  db: DrizzleDB,
  composeId: string,
): Promise<string> {
  const [succeeded] = await db
    .select({ deploymentId: deployment.deploymentId })
    .from(deployment)
    .where(
      and(eq(deployment.composeId, composeId), eq(deployment.status, 'done')),
    )
    .limit(1);
  return succeeded ? NOT_RECORDED_VOLUMES_REASON : NOT_DEPLOYED_VOLUMES_REASON;
}
