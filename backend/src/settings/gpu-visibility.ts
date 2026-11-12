/**
 * The variable the nvidia container runtime reads to choose which cards a
 * container sees, and the value that shows it none.
 */
export const GPU_VISIBILITY_ENV = 'NVIDIA_VISIBLE_DEVICES';
export const NO_GPUS = 'void';

/**
 * The env names the platform owns on a container that reserves no GPU: the
 * nvidia runtime's own and CUDA's filter over it. Exported for the AI model's
 * locked env names, which are the same two.
 */
export const GPU_VISIBILITY_ENV_NAMES: readonly string[] = [
  GPU_VISIBILITY_ENV,
  'CUDA_VISIBLE_DEVICES',
];

/**
 * A container's resolved `Env` with every card hidden from it: the
 * operator's own entries of {@link GPU_VISIBILITY_ENV_NAMES} dropped and
 * `NVIDIA_VISIBLE_DEVICES=void` appended.
 *
 * **Why every unreserved container needs it.** GPU setup makes the nvidia
 * runtime Docker's default (`gpu.service.ts`), and with no Swarm assignment it
 * reads `NVIDIA_VISIBLE_DEVICES`, which the image may set itself — CUDA base
 * images ship `=all` — so an Application or database that reserved nothing could run on a card
 * Swarm handed to someone else. `void` keeps the runtime's driver libraries out
 * too, which is what makes it "no card" rather than "card zero".
 *
 * **A filter and not an ordering**, for `withEngineEnv`'s reason: the
 * platform's value has to win over an operator assignment from the row, the
 * Environment or the Project, and dropping the colliding entry is the form no
 * dotenv shape can arrange around. Dropping is safe here where it is not for
 * `CG_` (see `RESERVED_ENV_PREFIX`), because the set is two closed names that
 * mean nothing on a container that holds no card.
 *
 * A container that reserves cards is left alone: Swarm's `DOCKER_RESOURCE_GPU`
 * names the cards it assigned, and the runtime reads that before this name.
 * Compose is not covered — it has no reservation and is not refused on a GPU
 * Server, a documented gap.
 */
export function withGpusHidden(env: readonly string[]): string[] {
  return [
    ...env.filter(
      (pair) =>
        !GPU_VISIBILITY_ENV_NAMES.includes(pair.slice(0, pair.indexOf('='))),
    ),
    `${GPU_VISIBILITY_ENV}=${NO_GPUS}`,
  ];
}
