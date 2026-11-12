import { execByServer } from '../docker-ops/server-access';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { readRuntimeConfigured } from './gpu-runtime';
import { gpuSetupOf, isGpu, qualifiesAsGpuServer } from './gpu-setup-state';
import type {
  GenericResource,
  GpuAdvertisement,
  GpuSetupState,
} from './gpu-setup-state';

/**
 * The counts-only GPU read: how many cards a machine advertises by ID
 * and how many of them no running task holds. Separate from the full
 * driver/CUDA check (`GpuService.checkGpuStatus`) so it can be open to anyone
 * who may create a Service on the machine, and live every time — never cached
 * — because the deploy-time free-card check has to be live anyway.
 *
 * Only the machine itself counts (`self`): a GPU on a Swarm worker joined to a
 * Server's Swarm is a documented gap.
 */
export interface GpuCounts {
  /** Which way the machine advertises its GPUs, so a caller can say why. */
  gpuSetup: GpuSetupState;
  /** Cards a reservation can use: those advertised by ID, else none. */
  cards: number;
  /** Of those, the ones no running task on this machine holds. */
  free: number;
}

/** What one running task on the machine holds. */
export interface HeldGpus {
  serviceId: string;
  gpus: number;
}

/** The GPU generic resources the machine advertises to Swarm. */
export const NODE_GPU_RESOURCES_COMMAND =
  "docker node inspect self --format '{{json .Description.Resources.GenericResources}}'";

/**
 * One line per task Swarm wants running on this machine: its service ID, then
 * the generic resources Swarm assigned it. `xargs -r` so a machine running
 * nothing inspects nothing.
 *
 * Docker's task JSON names the field `GenericResources` (swarmkit's
 * `AssignedGenericResources` is not in it) and omits it on a task that
 * reserves nothing, so it is read with `index`, which prints `null` there
 * where a bare `.GenericResources` can fail the whole template.
 */
export const RUNNING_TASK_GPUS_COMMAND =
  'docker node ps self --filter desired-state=running --no-trunc -q | xargs -r docker inspect --type task --format \'{{.ServiceID}} {{json (index . "GenericResources")}}\'';

function gpusIn(json: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed)) return 0;
  return (parsed as GenericResource[]).reduce((sum, resource) => {
    if (isGpu(resource.NamedResourceSpec?.Kind)) return sum + 1;
    if (isGpu(resource.DiscreteResourceSpec?.Kind)) {
      return sum + (resource.DiscreteResourceSpec?.Value ?? 0);
    }
    return sum;
  }, 0);
}

/** {@link RUNNING_TASK_GPUS_COMMAND}'s answer, a task per line. */
export function heldGpusOf(stdout: string): HeldGpus[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(' ');
      if (space === -1) return { serviceId: line, gpus: 0 };
      return {
        serviceId: line.slice(0, space),
        gpus: gpusIn(line.slice(space + 1)),
      };
    });
}

/**
 * Cards advertised less cards held. A caller that counts some tasks as free —
 * a redeploy's own current tasks — filters them out of `held` first.
 */
export function gpuCountsOf(
  advertisement: GpuAdvertisement,
  held: readonly HeldGpus[],
): GpuCounts {
  if (!qualifiesAsGpuServer(advertisement.gpuSetup)) {
    return { gpuSetup: advertisement.gpuSetup, cards: 0, free: 0 };
  }
  const cards = advertisement.gpuResources;
  const taken = held.reduce((sum, task) => sum + task.gpus, 0);
  return {
    gpuSetup: advertisement.gpuSetup,
    cards,
    free: Math.max(0, cards - taken),
  };
}

/**
 * The live read, on the platform host (`serverId` null) or a Server. A machine
 * whose node inspect fails — not in a Swarm — reads as not set up, as the GPU
 * check reads it; its running tasks are listed only once it qualifies.
 */
export async function readGpuCounts(
  remoteExec: RemoteExecService,
  serverId: string | null | undefined,
): Promise<{ counts: GpuCounts; held: HeldGpus[] }> {
  let advertisement = gpuSetupOf('null');
  try {
    const { stdout } = await execByServer(
      remoteExec,
      serverId,
      NODE_GPU_RESOURCES_COMMAND,
    );
    advertisement = gpuSetupOf(stdout);
  } catch {
    // Not in a Swarm, or no GPU resource: not set up.
  }
  if (!qualifiesAsGpuServer(advertisement.gpuSetup)) {
    return { counts: gpuCountsOf(advertisement, []), held: [] };
  }
  const { stdout } = await execByServer(
    remoteExec,
    serverId,
    RUNNING_TASK_GPUS_COMMAND,
  );
  const held = heldGpusOf(stdout);
  return { counts: gpuCountsOf(advertisement, held), held };
}

/**
 * The counts, and whether the machine's NVIDIA runtime hands a task the card
 * Swarm assigns it: what a GPU reservation is admitted against, on
 * save and before a release.
 */
export interface GpuAdmission extends GpuCounts {
  runtimeConfigured: boolean;
}

/**
 * {@link readGpuCounts} plus the runtime read the GPU card makes
 * (`gpu-runtime.ts`), for a save or deploy with a reservation to admit. Kept
 * off the counts-only read, which the picker makes on every open. Its three
 * commands go out alongside the counts' reads, so it adds no round trip in
 * sequence to a save or a deploy.
 */
export async function readGpuAdmission(
  remoteExec: RemoteExecService,
  serverId: string | null | undefined,
): Promise<{ admission: GpuAdmission; held: HeldGpus[] }> {
  const [{ counts, held }, runtimeConfigured] = await Promise.all([
    readGpuCounts(remoteExec, serverId),
    readRuntimeConfigured(remoteExec, serverId),
  ]);
  return { admission: { ...counts, runtimeConfigured }, held };
}

const gpuWord = (n: number) => (n === 1 ? 'GPU' : 'GPUs');

/**
 * Why `gpus` per copy can never run on this machine, or `null` when it can.
 * Only the card count decides on save; whether enough are free is the
 * deploy's question. A machine whose cards are advertised by ID but
 * whose runtime would not hand a task its card — set up by an older version —
 * is refused too: Swarm would assign the card and the container would never see
 * it (ADR-0039). `where` names the machine: a Server's name, or "the platform
 * host".
 */
export function gpuReservationRefusal(
  admission: GpuAdmission,
  gpus: number,
  where: string,
): string | null {
  if (gpus <= 0) return null;
  if (admission.gpuSetup === 'none') {
    return `${where} is not set up for GPUs; run GPU setup on it first`;
  }
  if (admission.gpuSetup === 'count') {
    return `${where} was set up for GPUs the old way, which cannot reserve a card; run GPU setup on it again`;
  }
  if (!admission.runtimeConfigured) {
    return `${where} is not set up to hand a reserved card to its container; run GPU setup on it again`;
  }
  if (gpus > admission.cards) {
    return `${where} has ${admission.cards} ${gpuWord(admission.cards)}, so it cannot hold ${gpus} per copy`;
  }
  return null;
}
