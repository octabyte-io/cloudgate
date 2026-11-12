import { and, eq, isNotNull } from 'drizzle-orm';

import { DEPLOYMENTS_PREFIX } from '../../cloud-accounts/aws/definitions/static-definition';
import type { DrizzleDB } from '../../db/drizzle.module';
import { deployment, rollback } from '../../db/schema';
import type { FoldersInUse, StaticFolders } from './static-place';

// A static site's Deployment folders once it is live: what its
// Deployment's clean-up keeps and removes from the site's bucket, on every
// cloud.

/**
 * Deletes every Deployment folder in the bucket but the live one, if
 * visitors are served one, every rollback point's and the previous one the
 * cloud's half says is still served for a while (on AWS, while CloudFront
 * spreads). So with rollbacks off, a Deployment's own folder goes once it is
 * no longer served. A point's folder stays until the point is removed, which
 * deletes it: points are taken only with rollbacks on, and turning them
 * off keeps the ones already taken, as on a Server. A folder not deleted
 * is named, and the next Deployment tries again; it never fails this one.
 */
export async function cleanUpFolders(
  db: DrizzleDB,
  folders: StaticFolders,
  keep: FoldersInUse & { applicationId: string },
  log: (line: string) => Promise<void>,
): Promise<void> {
  const listed = await folders.list(DEPLOYMENTS_PREFIX);
  if (!listed.ok) {
    await log(
      `⚠️ [Files] The bucket's older folders could not be listed (${listed.message}); the next Deployment removes them`,
    );
    return;
  }
  const kept = new Set<string>();
  if (keep.live) kept.add(keep.live);
  if (keep.previous) kept.add(keep.previous.folder);
  for (const point of await rollbackPoints(db, keep.applicationId)) {
    kept.add(point);
  }
  const doomed = listed.folders.filter((folder) => !kept.has(folder));
  let removed = 0;
  for (const folder of doomed) {
    const gone = await folders.delete(`${DEPLOYMENTS_PREFIX}${folder}/`);
    if (gone.ok) removed += 1;
    else {
      await log(
        `⚠️ [Files] Folder ${folder} was not removed (${gone.message}); the next Deployment tries again`,
      );
    }
  }
  if (removed > 0) {
    await log(
      `🧹 [Files] Removed ${removed} older folder${removed === 1 ? '' : 's'} from the bucket`,
    );
  }
  if (keep.previous) {
    await log(
      `📁 [Files] The previous version's folder ${keep.previous.folder} is kept ${keep.previous.while}; the next Deployment removes it`,
    );
  }
}

/** The folders of the rollback points this Service keeps. */
async function rollbackPoints(
  db: DrizzleDB,
  applicationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ folder: rollback.folder })
    .from(rollback)
    .innerJoin(deployment, eq(deployment.deploymentId, rollback.deploymentId))
    .where(
      and(
        eq(deployment.applicationId, applicationId),
        isNotNull(rollback.folder),
      ),
    );
  return rows.flatMap((one) => (one.folder ? [one.folder] : []));
}
