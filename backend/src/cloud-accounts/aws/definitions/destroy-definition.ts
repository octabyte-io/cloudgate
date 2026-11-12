import { frame } from './tofu-json';
import type { StateMark } from './tags';
import type { AwsAccountAccess } from './tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';

/**
 * The definition a destroy-only Cloud run is given (ADR-0038): the
 * `pg` backend and the `aws` provider, and no resource at all.
 *
 * `tofu destroy` destroys everything the state holds, whatever the
 * definition says, so it needs only the provider to reach AWS with. Writing
 * no resource means a Delete never needs what a deploy's definition is built
 * from (the image, its CPU, the Environment network's ids), which may be gone
 * or unreadable by the time a Service is deleted, and a Retry destroys from
 * the kept state alone.
 */
export function destroyDefinition(
  account: AwsAccountAccess,
  region: string,
  mark: StateMark,
): TofuDefinition {
  return frame(account, region, mark);
}
