import * as path from 'node:path';
import { ConflictException } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { quote } from 'shell-quote';
import { application } from '../applications/application.schema';
import type { ServiceType } from '../applications/application.schema';
import {
  VOLUME_RELEASE_TIMEOUT_MS,
  removeVolumeOn,
} from '../applications/application-volumes';
import type { UnreclaimedArtifact } from '../common/teardown-steps';
import type { DrizzleDB } from '../db/drizzle.module';
import type { DeployableAiModel } from '../deployment-engine/deployment-engine.types';
import type { DockerMountSpec } from '../docker/docker.types';
import type { DrizzleTx } from '../environments/config-name';
import { execOnServer } from '../remote/exec-dispatch';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { aiModelFacet } from './ai-model.schema';
import type { InferenceRuntime } from './ai-model.schema';
import { INFERENCE_RUNTIMES } from './inference-runtime';
import { findRunningTask } from './model-readiness';

type Db = DrizzleDB | DrizzleTx;

/**
 * An AI model's **weights volume**: one named volume per AI
 * model that the platform mounts, prunes and reclaims, and that no operator
 * write can name.
 *
 * - **Named `<appName>-weights`**, so it is never shared: `appName` is the AI
 *   model's own, and no other AI model, on that Server or any, has it.
 * - **Mounted by the deploy, not by a `mount` row** (`mechanize.ts`), at the
 *   runtime's weights path, which its env names too. No row means nothing to
 *   edit or remove, and an operator mount naming the volume or its path is
 *   refused ({@link refuseWeightsVolumeMount}). It also keeps it out of
 *   `generateConfigContainer`'s mounts, which would pin the AI model to a
 *   manager.
 * - **Pruned after a successful swap** to the one model served
 *   ({@link pruneWeightsVolume}); a failed deploy never reaches it.
 * - **Reclaimed by every Delete** on the AI model's Server, whatever
 *   `deleteVolumes` says: it is a cache of what can be downloaded again, not
 *   the operator's data (ADR-0018). A failure is a line in the Delete's
 *   left-behind report ({@link reclaimWeightsVolumes}).
 * - **Never backed up**: a VolumeBackup naming it is refused
 *   ({@link refuseWeightsVolumeBackup}).
 */
export function weightsVolumeName(appName: string): string {
  return `${appName}${WEIGHTS_SUFFIX}`;
}

const WEIGHTS_SUFFIX = '-weights';

/** The Swarm mount an AI model's spec carries for its weights volume. */
export function weightsVolumeMount(
  appName: string,
  runtime: InferenceRuntime,
): DockerMountSpec {
  return {
    Type: 'volume',
    Source: weightsVolumeName(appName),
    Target: INFERENCE_RUNTIMES[runtime].weightsPath,
  };
}

/**
 * Whether `volumeName` is an AI model's weights volume: `<appName>-weights`
 * for an `appName` that has a facet. Any AI model's, not only the caller's
 * Service's, so no other Service can mount or back up one.
 */
async function isWeightsVolume(db: Db, volumeName: string): Promise<boolean> {
  if (!volumeName.endsWith(WEIGHTS_SUFFIX)) return false;
  const appName = volumeName.slice(0, -WEIGHTS_SUFFIX.length);
  const [owner] = await db
    .select({ applicationId: aiModelFacet.applicationId })
    .from(aiModelFacet)
    .innerJoin(
      application,
      eq(application.applicationId, aiModelFacet.applicationId),
    )
    .where(eq(application.appName, appName))
    .limit(1);
  return owner !== undefined;
}

/**
 * Refuses a mount write, create or update, that would name an AI model's
 * weights volume or mount over its weights path. `mount` is the row as
 * it would stand after the write.
 */
export async function refuseWeightsVolumeMount(
  db: Db,
  owner: { serviceType: ServiceType; serviceId: string },
  mount: {
    type: string;
    volumeName?: string | null;
    mountPath?: string | null;
  },
): Promise<void> {
  if (
    mount.type === 'volume' &&
    mount.volumeName &&
    (await isWeightsVolume(db, mount.volumeName))
  ) {
    throw new ConflictException(
      `${mount.volumeName} is an AI model's weights volume, which the platform mounts; no other mount can name it`,
    );
  }
  if (owner.serviceType !== 'application' || !mount.mountPath) return;
  const [facet] = await db
    .select({ runtime: aiModelFacet.runtime })
    .from(aiModelFacet)
    .where(eq(aiModelFacet.applicationId, owner.serviceId))
    .limit(1);
  if (!facet) return;
  const weightsPath = INFERENCE_RUNTIMES[facet.runtime].weightsPath;
  if (path.posix.normalize(`${mount.mountPath}/`) === `${weightsPath}/`) {
    throw new ConflictException(
      `${weightsPath} is where the platform mounts this AI model's weights volume; mount at another path`,
    );
  }
}

/** Refuses a VolumeBackup of an AI model's weights volume. */
export async function refuseWeightsVolumeBackup(
  db: Db,
  volumeName: string,
): Promise<void> {
  if (await isWeightsVolume(db, volumeName)) {
    throw new ConflictException(
      `${volumeName} is an AI model's weights volume, which is not backed up: its models are downloaded again on the next deploy`,
    );
  }
}

/**
 * The program that lists the models a running task of `appName` holds, its
 * stdout the runtime's own listing.
 */
export function listModelsProgram(
  appName: string,
  runtime: InferenceRuntime,
): string {
  return [
    ...findRunningTask(appName, 'list models in'),
    `docker exec "$CONTAINER_ID" ${quote([...INFERENCE_RUNTIMES[runtime].listModelsCommand])}`,
  ].join('\n');
}

/** The program that deletes `models` in a running task of `appName`. */
export function removeModelsProgram(
  appName: string,
  runtime: InferenceRuntime,
  models: readonly string[],
): string {
  return [
    ...findRunningTask(appName, 'prune'),
    `docker exec "$CONTAINER_ID" ${quote(INFERENCE_RUNTIMES[runtime].removeModelsCommand(models))}`,
  ].join('\n');
}

/**
 * Prunes the weights volume back to the one model served, after a deploy
 * whose model is pulled: every other model the runtime lists is
 * deleted. Answers with the models it deleted; throws when either step fails,
 * which the deploy logs without failing a Deployment whose model is served.
 *
 * Only ever called on the success path: a deploy that failed, its pull
 * included, never reaches it, so the old model is still there for the version
 * that keeps running.
 */
export async function pruneWeightsVolume(
  remoteExec: RemoteExecService,
  serverId: string | null,
  appName: string,
  facet: DeployableAiModel,
): Promise<string[]> {
  const runtime = INFERENCE_RUNTIMES[facet.runtime];
  const { stdout } = await execOnServer(
    remoteExec,
    serverId,
    listModelsProgram(appName, facet.runtime),
  );
  const others = runtime
    .listedModels(stdout)
    .filter((listed) => !runtime.isServedModel(listed, facet.model));
  if (others.length === 0) return [];
  await execOnServer(
    remoteExec,
    serverId,
    removeModelsProgram(appName, facet.runtime, others),
  );
  return others;
}

/** An AI model whose weights volume a Delete reclaims. */
export interface WeightsVolumeOwner {
  appName: string;
  /** The run Server, where Swarm created the volume (ADR-0018). */
  serverId: string | null;
  /** Whether its Swarm service was confirmed gone; a forced Delete's may
   * not be, and then the volume is kept and said so. */
  serviceGone: boolean;
}

/**
 * Removes each AI model's weights volume on its Server, whatever
 * `deleteVolumes` says, and answers with the ones it could not. Never
 * throws: a volume left behind is a line in the Delete's report and the
 * Delete goes ahead. One release deadline for the whole call, as
 * `reclaimApplicationVolumes` has.
 */
export async function reclaimWeightsVolumes(
  remoteExec: RemoteExecService,
  owners: readonly WeightsVolumeOwner[],
): Promise<UnreclaimedArtifact[]> {
  const deadline = Date.now() + VOLUME_RELEASE_TIMEOUT_MS;
  const report: UnreclaimedArtifact[] = [];
  for (const owner of owners) {
    const volumeName = weightsVolumeName(owner.appName);
    const why = owner.serviceGone
      ? await removeVolumeOn(remoteExec, owner.serverId, volumeName, deadline)
      : "Kept: the AI model's Swarm service could not be confirmed gone, so its weights volume was not touched";
    if (why) {
      report.push({
        kind: 'volume',
        appName: owner.appName,
        serverId: owner.serverId,
        path: volumeName,
        reason: why,
      });
    }
  }
  return report;
}

/**
 * The AI models among these Applications, by id: what a cascade reads with
 * its children, before the rows (and their facets) go.
 */
export async function aiModelIdsAmong(
  db: Db,
  applicationIds: readonly string[],
): Promise<Set<string>> {
  if (applicationIds.length === 0) return new Set();
  const rows = await db
    .select({ applicationId: aiModelFacet.applicationId })
    .from(aiModelFacet)
    .where(inArray(aiModelFacet.applicationId, [...applicationIds]));
  return new Set(rows.map((row) => row.applicationId));
}
