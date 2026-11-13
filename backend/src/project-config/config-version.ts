import { eq, sql } from 'drizzle-orm';

import type { DrizzleDB } from '../db/drizzle.module';
import type { DrizzleTx } from '../environments/config-name';
import { projectConfigLocation } from './project-config.schema';

/**
 * Moves the config's version (ADR-0080), recording who and when, and writes
 * `set` with it. Every write of the text and every Apply goes through here,
 * so a whole-YAML edit naming an older version is refused.
 */
export async function moveVersion(
  db: DrizzleDB | DrizzleTx,
  projectId: string,
  changedBy: string | null,
  set: { readonly text?: string } = {},
): Promise<void> {
  await db
    .update(projectConfigLocation)
    .set({
      ...set,
      version: sql`${projectConfigLocation.version} + 1`,
      changedBy,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projectConfigLocation.projectId, projectId));
}
