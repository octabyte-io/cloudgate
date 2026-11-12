import { BadRequestException, ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import type { CloudKind } from '../cloud-accounts/cloud-account.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import { application, cloudAccount, registry, server } from '../db/schema';
import { cloudOrLegacy } from '../cloud-accounts/cloud-provider';
import { consoleRefusalSentence } from '../native/native-shared';
import { AWS_CONTAINER_ADDRESS } from '../native/aws-locks';
import { AWS_SIZE_BEARING } from '../native/aws-size';
import { GCP_SIZE_BEARING } from '../native/gcp-size';
import { GCP_CONTAINER_ADDRESS } from '../native/google-locks';
import { nativeSizeOf } from '../native/size-override';

/**
 * Where a cloud Service runs, as reading the Service shows it: its
 * Cloud account by id and name, and its region. Part of the Service's own
 * read, so `service: read` is enough — no `cloudAccount: read` is asked, and
 * nothing of the Cloud account but its name leaves (no key, no role).
 * `null` for a Service on a Server or the platform host.
 */
export interface CloudPlace {
  readonly cloudAccountId: string;
  readonly cloudAccountName: string;
  /** Which cloud it is: what the console names its pieces after. */
  readonly cloud: CloudKind;
  readonly region: string;
}

export async function cloudPlaceOf(
  db: DrizzleDB,
  row: { cloudAccountId: string | null; region: string | null },
): Promise<CloudPlace | null> {
  if (!row.cloudAccountId || !row.region) return null;
  const [found] = await db
    .select({ name: cloudAccount.name, cloud: cloudAccount.cloud })
    .from(cloudAccount)
    .where(eq(cloudAccount.cloudAccountId, row.cloudAccountId));
  return {
    cloudAccountId: row.cloudAccountId,
    cloudAccountName: found?.name ?? row.cloudAccountId,
    cloud: cloudOrLegacy(found?.cloud),
    region: row.region,
  };
}

/**
 * What a Service in a Cloud account refuses to be given ("Image
 * and ECR"): a linked Registry or build Registry, named, since its
 * image always goes to the Service's own repository in its Cloud account
 * (ECR, or Artifact Registry); and a build Server, named,
 * since its build always runs on the platform host and no cloud credential
 * ever reaches a Server. Clearing one (`null`) is allowed.
 */
export async function refuseOnCloudService(
  db: DrizzleDB,
  current: { cloudAccountId: string | null },
  data: {
    registryId?: string | null;
    buildRegistryId?: string | null;
    buildServerId?: string | null;
  },
): Promise<void> {
  if (current.cloudAccountId === null) return;
  for (const [field, label] of [
    ['registryId', 'Registry'],
    ['buildRegistryId', 'build Registry'],
  ] as const) {
    const id = data[field];
    if (!id) continue;
    const [found] = await db
      .select({ name: registry.name })
      .from(registry)
      .where(eq(registry.registryId, id));
    throw new BadRequestException(
      `Registry ${found?.name ?? id} cannot be linked as the ${label} of a Service in a Cloud account: its image always goes to the Service's own repository in its Cloud account`,
    );
  }
  if (data.buildServerId) {
    const [found] = await db
      .select({ name: server.name })
      .from(server)
      .where(eq(server.serverId, data.buildServerId));
    throw new BadRequestException(
      `Server ${found?.name ?? data.buildServerId} cannot build a Service in a Cloud account: its build always runs on the platform host, so no cloud credential reaches a Server`,
    );
  }
}

/**
 * A console edit of a Service's CPU or memory cap while its applied native
 * block sets that half of the pair it runs at: refused with 409, naming the native path, as the
 * Database page refuses a class or tier native sets. Native wins at
 * deploy, so the edit would be saved and then silently not run: the
 * Fargate task's `cpu` and `memory` on ECS, the Cloud Run container's
 * `resources.limits` on Google Cloud. Each column holds only the block its
 * own cloud applied, so reading both chooses no cloud. A value equal to the
 * one saved is no edit, so a form that sends both caps still saves the
 * rest.
 */
export async function refuseNativeSetCaps(
  db: DrizzleDB,
  applicationId: string,
  data: {
    readonly cpuLimit?: string | null;
    readonly memoryLimit?: string | null;
  },
): Promise<void> {
  if (data.cpuLimit === undefined && data.memoryLimit === undefined) return;
  const [current] = await db
    .select({
      name: application.name,
      configName: application.configName,
      cpuLimit: application.cpuLimit,
      memoryLimit: application.memoryLimit,
      nativeAws: application.nativeAws,
      nativeGcp: application.nativeGcp,
    })
    .from(application)
    .where(eq(application.applicationId, applicationId));
  if (!current) return;
  const pathOf = (part: 'cpu' | 'memory') =>
    nativeSizeOf(
      AWS_SIZE_BEARING,
      current.nativeAws,
      AWS_CONTAINER_ADDRESS,
      part,
    )?.path ??
    nativeSizeOf(
      GCP_SIZE_BEARING,
      current.nativeGcp,
      GCP_CONTAINER_ADDRESS,
      part,
    )?.path ??
    null;
  const edited = (field: 'cpuLimit' | 'memoryLimit') =>
    data[field] !== undefined && data[field] !== current[field];
  const refusal = consoleRefusalSentence(current.configName ?? current.name, [
    ['cpuLimit', edited('cpuLimit') ? pathOf('cpu') : null],
    ['memoryLimit', edited('memoryLimit') ? pathOf('memory') : null],
  ]);
  if (refusal) throw new ConflictException(refusal);
}
