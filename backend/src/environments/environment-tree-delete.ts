import { and, eq, inArray, isNotNull } from 'drizzle-orm';

import { application } from '../applications/application.schema';
import type { BucketDeletes } from '../buckets/bucket-deletes.service';
import {
  applicationIdsOf,
  cascadeDelete,
  listCascadeChildren,
} from '../common/service-cascade';
import type { CascadeDeleted } from '../common/service-cascade';
import type { DrizzleDB } from '../db/drizzle.module';
import { tearDownApplicationPreviews } from '../preview-deployments/preview-teardown';
import type {
  PermissionCtx,
  PermissionService,
} from '../rbac/permission.service';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { reclaimPreservedImages } from '../rollbacks/preserved-images';
import type { TraefikWriterService } from '../traefik/traefik-writer.service';
import type { FinishEnvironmentDelete } from './environment-cloud-deletes.port';
import { environment } from './environment.schema';

export interface EnvironmentTreeDeps {
  readonly db: DrizzleDB;
  readonly permissions: PermissionService;
  readonly remoteExec: RemoteExecService;
  readonly traefikWriter: TraefikWriterService;
  /** Whether each bucket holds files, read before the teardown. */
  readonly bucketDeletes: Pick<BucketDeletes, 'cascadeFiles'>;
}

/**
 * An Environment's Delete in `common/service-cascade.ts`'s sense:
 * every Service in it torn down, then its row — **except its cloud
 * Services**, whose Delete is a destroy-only Cloud run of their own and which a
 * Docker teardown would only misread. By the time this
 * runs on an Environment that had any, they are gone, or are being dropped
 * by `beforeRow` (Forget), which runs just before the row.
 *
 * Shared by the Environment's own Delete and a Project's, so the two roots
 * cannot disagree about what deleting an Environment means.
 */
export async function deleteEnvironmentTree(
  deps: EnvironmentTreeDeps,
  ctx: PermissionCtx,
  current: { environmentId: string; name: string },
  force: boolean,
  beforeRow: () => Promise<void> = () => Promise.resolve(),
): Promise<CascadeDeleted<typeof environment.$inferSelect>> {
  const { db } = deps;
  const inCloud = new Set(await cloudServiceIdsIn(db, [current.environmentId]));
  const children = (
    await listCascadeChildren(db, [current.environmentId])
  ).filter((child) => !inCloud.has(child.serviceId));

  return cascadeDelete({
    deps: { remoteExec: deps.remoteExec, traefikWriter: deps.traefikWriter },
    children,
    parent: { kind: 'Environment', name: current.name },
    force,
    authorizeChild: (child) =>
      deps.permissions.checkServiceAccess(ctx, child.serviceId, 'delete'),
    // The preserved `${appName}:v${version}` tags of every Application under
    // it, dropped before the cascade destroys the only rows that name them.
    reclaimPreserved: (remoteExec, release) =>
      reclaimPreservedImages(
        db,
        remoteExec,
        ctx,
        applicationIdsOf(children),
        release,
      ),
    // The Swarm service and source tree of every preview deployment under it,
    // dropped before the cascade destroys the only rows that name them.
    // A preview row has no `service_type` and so is not a
    // `CascadeChild`; it is reached through its parent Application's id.
    tearDownPreviews: (remoteExec) =>
      tearDownApplicationPreviews(db, remoteExec, applicationIdsOf(children)),
    // Every bucket that holds files is kept and named; an empty one goes
    // whole. Never asked to delete files.
    bucketFiles: (bucketIds) => deps.bucketDeletes.cascadeFiles(bucketIds),
    deleteRow: async () => {
      await beforeRow();
      const [removed] = await db
        .delete(environment)
        .where(eq(environment.environmentId, current.environmentId))
        .returning();
      return removed;
    },
  });
}

/** The cloud Services (ADR-0035) of these Environments. */
export async function cloudServiceIdsIn(
  db: DrizzleDB,
  environmentIds: readonly string[],
): Promise<string[]> {
  if (environmentIds.length === 0) return [];
  const rows = await db
    .select({ applicationId: application.applicationId })
    .from(application)
    .where(
      and(
        inArray(application.environmentId, [...environmentIds]),
        isNotNull(application.cloudAccountId),
      ),
    );
  return rows.map((row) => row.applicationId);
}

/**
 * {@link deleteEnvironmentTree} as the rest of a cloud Delete: what
 * it could not reclaim, without the row.
 */
export function finishEnvironmentTree(
  deps: EnvironmentTreeDeps,
  ctx: PermissionCtx,
  current: { environmentId: string; name: string },
  force: boolean,
): FinishEnvironmentDelete {
  return async (beforeRow) => {
    const {
      orphaned,
      unreclaimedImages,
      orphanedPreviews,
      unreclaimedArtifacts,
      bucketsLeftBehind,
    } = await deleteEnvironmentTree(deps, ctx, current, force, beforeRow);
    return {
      ...(orphaned ? { orphaned } : {}),
      ...(unreclaimedImages ? { unreclaimedImages } : {}),
      ...(orphanedPreviews ? { orphanedPreviews } : {}),
      ...(unreclaimedArtifacts ? { unreclaimedArtifacts } : {}),
      ...(bucketsLeftBehind ? { bucketsLeftBehind } : {}),
    };
  };
}
