import { AWS_PRIVATE_LINK_KINDS } from '../aws/definitions/private-dns';
import type { AwsPrivateLinkKind } from '../aws/definitions/private-dns';
import { PRIVATE_LINK_KINDS } from '../gcp/definitions/private-link';
import type { PrivateLinkKind } from '../gcp/definitions/private-link';
import { GOOGLE_RUN_APP_LINK_KINDS } from '../gcp/definitions/run-app-zone';
import type { GoogleRunAppLinkKind } from '../gcp/definitions/run-app-zone';
import { GOOGLE_NAT_LINK_KINDS } from '../gcp/definitions/cloud-nat';
import type { GoogleNatLinkKind } from '../gcp/definitions/cloud-nat';

/**
 * A part an Environment network gains only once a Service it holds needs
 * it, and keeps until the network goes: on Google Cloud the
 * private link its databases attach through, a kind per database product
 * and the private `run.app` zone its Private web services
 * are reached through, and the Cloud NAT its Stack VMs go out through;
 * on AWS the private DNS namespace its Private web services are listed
 * in, and the NAT gateway its Stack VMs go out through. Each cloud's network writes its own kinds and
 * none of another's.
 */
export type NetworkLinkKind =
  | PrivateLinkKind
  | GoogleRunAppLinkKind
  | GoogleNatLinkKind
  | AwsPrivateLinkKind;

/** Every kind, in the order a network's row and plan steps hold them. */
const NETWORK_LINK_KINDS: readonly NetworkLinkKind[] = [
  ...PRIVATE_LINK_KINDS,
  ...GOOGLE_RUN_APP_LINK_KINDS,
  ...GOOGLE_NAT_LINK_KINDS,
  ...AWS_PRIVATE_LINK_KINDS,
];

/**
 * The kinds of `wanted` a network holding `held` lacks, in order: what a
 * plan adds to it.
 */
export function missingLinks(
  held: readonly NetworkLinkKind[],
  wanted: readonly NetworkLinkKind[],
): NetworkLinkKind[] {
  return NETWORK_LINK_KINDS.filter(
    (kind) => wanted.includes(kind) && !held.includes(kind),
  );
}

/**
 * The kinds a network holds once a step has run: those it held, with the
 * step's added and without the ones it takes off (a NAT once its
 * Environment has no Stack VM left, #1367), in order.
 */
export function linksAfter(
  held: readonly NetworkLinkKind[],
  step: {
    readonly privateLinks?: readonly NetworkLinkKind[];
    readonly removedLinks?: readonly NetworkLinkKind[];
  },
): NetworkLinkKind[] {
  const removed = step.removedLinks ?? [];
  return joinedLinks(held, step.privateLinks ?? []).filter(
    (kind) => !removed.includes(kind),
  );
}

/** Both lists' kinds, each once, in order. */
export function joinedLinks(
  ...lists: readonly (readonly NetworkLinkKind[])[]
): NetworkLinkKind[] {
  return NETWORK_LINK_KINDS.filter((kind) =>
    lists.some((list) => list.includes(kind)),
  );
}
