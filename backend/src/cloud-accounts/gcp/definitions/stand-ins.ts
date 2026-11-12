import { STAND_IN_MARKER } from '../../aws/definitions/stand-ins';

/**
 * What a `web` Service's definition on Google needs from its Environment
 * network: the names the network's own Apply saves, or stand-ins for
 * them while the network is not made yet.
 */
export interface GcpNetworkNames {
  readonly networkName: string;
  /** The one subnet Direct VPC egress puts the Service's copies on. */
  readonly subnetName: string;
}

/**
 * Stand-ins for a network the same plan makes (the Google Cloud spec, "Plan
 * behaviour"), as on AWS: a Service's plan never opens the network's state,
 * so before the network exists its names are placeholders shaped like the
 * real `cloudgate-<key>-<part>` names and carrying {@link STAND_IN_MARKER},
 * which the plan reader shows as "made by this plan (Environment network)".
 * Nothing is ever applied with them: the Apply makes the network first,
 * saves its names and plans the Service again with those.
 */
export function gcpNetworkStandIns(): GcpNetworkNames {
  return {
    networkName: `${STAND_IN_MARKER}-net`,
    subnetName: `${STAND_IN_MARKER}-subnet`,
  };
}
