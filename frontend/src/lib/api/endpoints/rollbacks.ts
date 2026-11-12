import { api } from "../client";

import type { Deployment } from "./deployments";

/**
 * `rollbacks.controller.ts` — the snapshots a previous Deployment left behind,
 * and the two things you can do with one.
 *
 * A rollback point is **an image tag plus the context that built it**. The
 * engine tags every successful build `{appName}:v{version}` and records the
 * spec it deployed with, so going back is a re-deploy of that tag rather than a
 * rebuild of an old commit — which is why it is fast and why it cannot fail the
 * way a build can.
 *
 * `fullContext` deliberately **excludes every secret** (`rollback.schema.ts`):
 * `env`, `buildArgs`, `buildSecrets`, `previewEnv`, `previewBuildArgs`, the
 * provider and registry credentials **and the id columns those load through**
 * live in encrypted columns and would land in this JSON as plaintext, so a
 * rollback re-reads them from the live Application row. The ids joined the list
 * later — a snapshot that stored `registryId` overrode the live row with it on
 * the way back out — and a snapshot written before that is stripped on read as
 * well, so a `fullContext` the console receives matches this type whatever
 * version of `capture` wrote it. The consequence is
 * worth saying on the screen: rolling back restores the **image and its spec**,
 * not the variables that were set at the time.
 */

export interface RollbackContext {
  appName?: string;
  name?: string;
  buildType?: string;
  sourceType?: string;
  branch?: string;
  repository?: string;
  owner?: string;
  dockerImage?: string;
  replicas?: number;
  cpuLimit?: string | null;
  memoryLimit?: string | null;
  [column: string]: unknown;
}

export interface Rollback {
  rollbackId: string;
  deploymentId: string;
  /** The global sequence the snapshot image is tagged with. */
  version: number;
  /** `{appName}:v{version}` — null if the build never produced one. */
  image: string | null;
  fullContext: RollbackContext | null;
  /**
   * A `static` site on AWS's point: the folder of its bucket that
   * holds that Deployment's files, `deployments/<folder>/`. Such a point has
   * no image and no context. `null` on a Server's point; absent from an
   * older API.
   */
  folder?: string | null;
  createdAt: string;
  deployment?: Deployment;
}

export const rollbacksApi = {
  listByApplication: (applicationId: string) =>
    api.get<Rollback[]>(`/applications/${applicationId}/rollbacks`),

  /**
   * Answers 202 either way. On a Server, redeploys the snapshot's image,
   * its `deploymentId` null. For a `static` site on AWS, queues a
   * Deployment of the Service that switches back to the point's files,
   * answering its id.
   */
  rollback: (rollbackId: string) =>
    api.post<{ deploymentId: string | null }>(
      `/rollbacks/${rollbackId}/rollback`,
    ),

  /** Drops the snapshot. The Deployment it points at is untouched. */
  remove: (rollbackId: string) =>
    api.delete<Rollback>(`/rollbacks/${rollbackId}`),
};
