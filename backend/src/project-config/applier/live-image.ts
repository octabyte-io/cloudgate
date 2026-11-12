import { and, desc, eq, isNotNull } from 'drizzle-orm';

import type { ImageHealthCheck } from '../../cloud-accounts/aws/definitions/container-health-check';
import type { ImageArchitecture } from '../../cloud-accounts/aws/definitions/web-definition';
import type { DrizzleDB } from '../../db/drizzle.module';
import { deployment } from '../../db/schema';

/** The image a cloud Service runs: its ECR tag, its CPU and its check. */
export interface LiveImage {
  readonly tag: string;
  readonly architecture: ImageArchitecture;
  /** Its `HEALTHCHECK` on ECS; `null` for none. */
  readonly healthCheck: ImageHealthCheck | null;
}

/**
 * A cloud Service's live image: the one its last finished
 * deploy ran — that deploy's own id as the tag, or, for a put-back, the live
 * image it ran on — or `null` before any deploy finished. Every image but it
 * is removed from ECR once a deploy is steady, so it is always there to run.
 * A deploy from before its CPU was recorded ran on x86, and one from before
 * its `HEALTHCHECK` was recorded ran none, so a plan or a drift read
 * writes the task definition that deploy did.
 */
export async function liveImageOf(
  db: DrizzleDB,
  applicationId: string,
): Promise<LiveImage | null> {
  const runs = await db
    .select({ id: deployment.deploymentId, cloudRun: deployment.cloudRun })
    .from(deployment)
    .where(
      and(
        eq(deployment.applicationId, applicationId),
        eq(deployment.status, 'done'),
        isNotNull(deployment.cloudRun),
      ),
    )
    .orderBy(desc(deployment.createdAt));
  const last = runs.find((run) => run.cloudRun?.kind === 'deploy');
  if (!last) return null;
  return {
    tag: last.cloudRun?.liveImage ?? last.id,
    architecture: last.cloudRun?.architecture ?? 'amd64',
    healthCheck: last.cloudRun?.healthCheck ?? null,
  };
}

/**
 * Which of `serviceIds` run a live image with a `HEALTHCHECK`, as
 * {@link liveImageOf} reads it: what a plan notes on a cloud that cannot
 * run one.
 */
export async function imageHealthChecksOf(
  db: DrizzleDB,
  serviceIds: readonly string[],
): Promise<string[]> {
  const live = await Promise.all(
    serviceIds.map(async (id) => ({
      id,
      image: await liveImageOf(db, id),
    })),
  );
  return live.flatMap(({ id, image }) => (image?.healthCheck ? [id] : []));
}
