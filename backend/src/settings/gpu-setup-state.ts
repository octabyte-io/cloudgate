/**
 * Which way a machine's GPUs are advertised to Swarm, read from
 * `docker node inspect self --format '{{json .Description.Resources.GenericResources}}'`.
 *
 * - `none`: no GPU generic resource — GPU setup has not run.
 * - `count`: `node-generic-resources: ["GPU=<n>"]`, a `DiscreteResourceSpec`.
 *   Set up the old way: Swarm hands a task a number, not the cards, so it
 *   cannot reserve a particular card. Running setup again fixes it.
 * - `card-id`: one `GPU=<uuid>` per card, a `NamedResourceSpec` each. With
 *   `swarm-resource = "DOCKER_RESOURCE_GPU"` each task sees exactly the
 *   UUIDs Swarm assigned it. Only this state qualifies a GPU Server.
 *
 * Pure so the GPU check and every later reader of a machine's cards
 * answer the same question the same way.
 */
export type GpuSetupState = 'none' | 'count' | 'card-id';

export interface GpuAdvertisement {
  gpuSetup: GpuSetupState;
  /** The card IDs advertised, in `card-id` state; empty otherwise. */
  gpuCardIds: string[];
  /** How many GPUs are advertised, either way. */
  gpuResources: number;
}

export interface GenericResource {
  DiscreteResourceSpec?: { Kind: string; Value: number };
  NamedResourceSpec?: { Kind: string; Value: string };
}

export const isGpu = (kind: string | undefined) =>
  kind?.toUpperCase() === 'GPU';

const NOT_SET_UP: GpuAdvertisement = {
  gpuSetup: 'none',
  gpuCardIds: [],
  gpuResources: 0,
};

export function gpuSetupOf(genericResources: string): GpuAdvertisement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(genericResources.trim());
  } catch {
    return NOT_SET_UP;
  }
  if (!Array.isArray(parsed)) return NOT_SET_UP;
  const resources = parsed as GenericResource[];

  const gpuCardIds = resources
    .map((r) => r.NamedResourceSpec)
    .filter((spec) => isGpu(spec?.Kind))
    .map((spec) => spec!.Value);
  if (gpuCardIds.length > 0) {
    return {
      gpuSetup: 'card-id',
      gpuCardIds,
      gpuResources: gpuCardIds.length,
    };
  }

  const count = resources.find((r) => isGpu(r.DiscreteResourceSpec?.Kind));
  if (count) {
    return {
      gpuSetup: 'count',
      gpuCardIds: [],
      gpuResources: count.DiscreteResourceSpec!.Value,
    };
  }
  return NOT_SET_UP;
}

/** Only a machine whose cards are advertised one by one is a GPU Server. */
export const qualifiesAsGpuServer = (state: GpuSetupState): boolean =>
  state === 'card-id';

/** What `nvidia-smi --query-gpu=uuid --format=csv,noheader` prints per card. */
const CARD_ID = /^GPU-[0-9A-Za-z-]+$/;

/**
 * The card IDs in `nvidia-smi --query-gpu=uuid --format=csv,noheader`'s
 * answer. Each one ends up inside the single-quoted daemon config the setup
 * command echoes, so anything that is not a plain card ID is refused rather
 * than passed on.
 */
export function cardIdsFromNvidiaSmi(stdout: string): string[] {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!CARD_ID.test(line)) {
      throw new Error(
        `nvidia-smi answered a card ID Cloudgate does not recognise: ${line}`,
      );
    }
  }
  if (lines.length === 0) {
    throw new Error('nvidia-smi lists no GPU on this machine');
  }
  return lines;
}

/** `node-generic-resources` for these cards: one named unit per card. */
export const nodeGenericResources = (cardIds: string[]): string[] =>
  cardIds.map((id) => `GPU=${id}`);
