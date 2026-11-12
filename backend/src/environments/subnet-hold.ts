import { subnetHoldSentence } from '../cloud-accounts/gcp/delete-check';
import type { GoogleLeftover } from '../cloud-accounts/gcp/delete-check';
import type {
  EnvironmentNetwork,
  NetworkLeftover,
} from './environment-network.schema';

/**
 * What a Google network's removal says while Google holds its subnet
 * (the spec's "The subnet hold"): the subnet and the
 * network named, with when Cloudgate tries again by itself, read off the
 * row so the network card, the Environment's Delete and the run's log say
 * the same. `null` when Google holds nothing of it.
 */
export function subnetHoldOf(
  network: Pick<
    EnvironmentNetwork,
    'leftovers' | 'holdNextTryAt' | 'holdTriesLeft'
  >,
): string | null {
  if (network.holdTriesLeft === null) return null;
  return subnetHoldSentence(
    network.leftovers.filter(isGoogleLeftover),
    network.holdNextTryAt,
  );
}

function isGoogleLeftover(one: NetworkLeftover): one is GoogleLeftover {
  return 'googleName' in one;
}
