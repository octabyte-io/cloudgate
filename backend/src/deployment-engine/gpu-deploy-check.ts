import type Docker from 'dockerode';
import { eq } from 'drizzle-orm';
import type { ServiceModeSwarm } from '../applications/swarm.types';
import type { DrizzleDB } from '../db/drizzle.module';
import { server } from '../db/schema';
import type { RemoteExecService } from '../remote/remote-exec.service';
import {
  gpuReservationRefusal,
  readGpuAdmission,
} from '../settings/gpu-counts';
import { generateConfigContainer, serviceModeKind } from './mechanize';
import type { DeployableApplication } from './deployment-engine.types';

const gpuWord = (n: number) => (n === 1 ? 'GPU' : 'GPUs');

/**
 * How many copies of the service the run Server has to hold at once. Only the
 * machine itself is counted, so a global service is one copy there.
 */
function copiesOf(mode: ServiceModeSwarm | undefined): number {
  switch (serviceModeKind(mode)) {
    case 'Replicated':
      return mode?.Replicated?.Replicas ?? 1;
    case 'ReplicatedJob':
      return mode?.ReplicatedJob?.MaxConcurrent ?? 1;
    default:
      return 1;
  }
}

/**
 * The Swarm service ID the Application runs as now through the Docker API, or
 * none before its first release.
 */
export async function dockerServiceId(
  docker: Docker,
  appName: string,
): Promise<string | null> {
  try {
    const info = (await docker.getService(appName).inspect()) as {
      ID?: string;
    };
    return info.ID ?? null;
  } catch {
    return null;
  }
}

/** The run Server's name, or the platform host's own words for itself. */
async function runServerName(
  db: DrizzleDB,
  serverId: string | null,
): Promise<string> {
  if (!serverId) return 'the platform host';
  const rows = await db
    .select({ serverId: server.serverId, name: server.name })
    .from(server)
    .where(eq(server.serverId, serverId));
  return rows.find((row) => row.serverId === serverId)?.name ?? serverId;
}

/**
 * What starting an Application's tasks asks of its run Server: `gpus` per
 * copy, `copies` at once, on the platform host (`serverId` null) or a Server.
 * `ownServiceId` reads the Swarm service it runs as now, whose tasks' cards
 * count as free; a caller reads it the way it already reaches the daemon.
 */
export interface GpuRelease {
  serverId: string | null;
  gpus: number;
  copies: number;
  ownServiceId: () => Promise<string | null>;
}

/**
 * Why the run Server cannot hand every new task its cards now, or `null` when
 * it can (ADR-0039): the save's refusal, read again in case the
 * machine was set up again or lost cards since, then "N GPUs needed, F of M
 * free on <Server>". Swarm would accept the spec and leave the new tasks
 * pending until cards came free, or — on a runtime that is not configured —
 * place them on a card their container never sees.
 *
 * The one admission before anything starts a GPU task: a deploy's release
 * ({@link assertGpusFree}), a Rollback, and a Start or Restart, so all of them
 * refuse in the same words. Read live from the machine, never cached.
 *
 * The Application's own running tasks count as free: a stop-first update gives
 * their cards to the new ones, and a Restart scales them away first, so a
 * redeploy, a Rollback or a Restart on a Server it alone fills passes.
 * Cloudgate keeps no card ledger; Swarm frees the cards when Stop or Delete
 * removes the tasks.
 */
export async function gpuReleaseRefusal(
  remoteExec: RemoteExecService,
  db: DrizzleDB,
  release: GpuRelease,
): Promise<string | null> {
  const { serverId, gpus: perCopy, copies } = release;
  if (perCopy < 1 || copies < 1) return null;
  const [{ admission, held }, own, where] = await Promise.all([
    readGpuAdmission(remoteExec, serverId),
    release.ownServiceId(),
    runServerName(db, serverId),
  ]);
  // A Server set up again the old way, or with fewer cards, since the save —
  // or saved before this check on one whose runtime would never hand the task its
  // card, which Swarm would place and report running all the same.
  const refusal = gpuReservationRefusal(
    admission,
    perCopy,
    serverId ? where : 'The platform host',
  );
  if (refusal) return refusal;

  const takenByOthers = held
    .filter((task) => task.serviceId !== own)
    .reduce((sum, task) => sum + task.gpus, 0);
  const free = Math.max(0, admission.cards - takenByOthers);
  const needed = perCopy * copies;
  if (free < needed) {
    return `${needed} ${gpuWord(needed)} needed, ${free} of ${admission.cards} free on ${where}`;
  }
  return null;
}

/**
 * {@link GpuRelease} for converging `application`'s Swarm service onto its
 * spec: every copy its mode runs on the machine, read through `docker`.
 */
export function releaseOf(
  docker: Docker,
  application: DeployableApplication,
): GpuRelease {
  return {
    serverId: application.serverId ?? null,
    gpus: application.gpus ?? 0,
    copies: copiesOf(generateConfigContainer(application).Mode),
    ownServiceId: () => dockerServiceId(docker, application.appName),
  };
}

/**
 * Refuses a release whose GPU reservation the run Server cannot meet now
 * (ADR-0039), so the Deployment fails here, before anything is
 * released — with `stop-first` the old version would otherwise already be
 * gone — saying {@link gpuReleaseRefusal}'s words.
 */
export async function assertGpusFree(
  remoteExec: RemoteExecService,
  docker: Docker,
  db: DrizzleDB,
  application: DeployableApplication,
): Promise<void> {
  if (!application.gpus) return;
  const refusal = await gpuReleaseRefusal(
    remoteExec,
    db,
    releaseOf(docker, application),
  );
  if (refusal) throw new Error(refusal);
}
