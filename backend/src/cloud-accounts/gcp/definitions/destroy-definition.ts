import { frame } from './tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';

/**
 * The definition a destroy-only Cloud run is given on Google
 * (ADR-0038, as on AWS): the `pg` backend and the Google provider, and no
 * resource at all. `tofu destroy` destroys everything the state holds, so a
 * Delete never needs what a deploy's definition is built from, and a Retry
 * destroys from the kept state alone.
 */
export function destroyDefinition(
  projectId: string,
  region: string,
): TofuDefinition {
  return frame(projectId, region);
}
