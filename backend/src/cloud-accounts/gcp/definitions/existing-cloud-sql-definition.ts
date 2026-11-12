import { literal, ref } from '../../definitions/tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';
import { markDescription, stateLabels } from './mark';
import { networkName, serviceName } from './names';
import { frame } from './tofu-json';

export interface ExistingCloudSqlDefinitionInput {
  /** The postgres Service's id, which names what Cloudgate makes (S4). */
  readonly serviceId: string;
  /** Cloudgate's id of the Cloud account, for the mark. */
  readonly cloudAccountId: string;
  /** The Environment's Google Cloud project: where the endpoint and zone are made. */
  readonly projectId: string;
  readonly region: string;
  readonly environmentId: string;
  /** The Service's Infrastructure state. */
  readonly stateId: string;
  /** The instance's `pscServiceAttachmentLink`, as its lookup read it. */
  readonly serviceAttachment: string;
  /**
   * The instance's `recordManager: CUSTOMER` name, exactly as Google
   * reports it, trailing dot included: the zone's name and the
   * record's.
   */
  readonly dnsName: string;
}

/** The addresses of what the definition makes. */
export const EXISTING_CLOUD_SQL_ADDRESSES = {
  address: 'google_compute_address.endpoint',
  forwardingRule: 'google_compute_forwarding_rule.endpoint',
  zone: 'google_dns_managed_zone.instance',
  record: 'google_dns_record_set.instance',
} as const;

/** The outputs a run reads of what it made. */
export const EXISTING_CLOUD_SQL_OUTPUTS = {
  /** The endpoint's address on the private link subnet. */
  endpointAddress: 'endpoint_address',
  /** The forwarding rule's name, which the endpoint's status is read by. */
  endpointName: 'endpoint_name',
} as const;

/** The TTL of the instance's A record: the walk's. */
const RECORD_TTL_SECONDS = 300;

/** The forwarding rule's name: the Service's own, as {@link existingCloudSqlDefinition} writes it. */
export function existingEndpointName(serviceId: string): string {
  return `${serviceName(serviceId)}-psc`;
}

/**
 * The OpenTofu definition of what Cloudgate makes for an **Existing
 * database** that is a Cloud SQL `postgres` (ADR-0033 as amended; checked on
 * live walks). Pure: no Google call, no
 * `tofu`, no database. It sits in the postgres Service's own
 * Infrastructure state and goes with its Delete; the instance itself is
 * never in it, and nothing here changes it.
 *
 * - **One manual Private Service Connect endpoint**: an internal address on
 *   the Environment network's private link subnet, and a forwarding rule
 *   from the Environment network to the instance's service attachment.
 *   Google's automatic connections (`psc_auto_connections`) were rejected:
 *   they are set on the instance.
 * - **One private DNS zone named for exactly the instance's own
 *   `….sql.goog.` name**, bound to the Environment network, holding one A
 *   record to the endpoint, so the name the instance's certificate carries
 *   resolves inside the network and a full certificate check passes. The
 *   endpoint's IP is never handed out.
 *
 * The network and its subnet are named by the Environment's id (S4), never
 * read from its state, so a plan whose network the same Apply makes or
 * links writes the names it will have. The address and the zone carry the
 * mark as labels and description; the forwarding rule too, which the
 * provider sets after creating a Private Service Connect rule. The labels
 * on the rule and the role's DNS permissions were taken from Google's docs;
 * the walk by hand checks them.
 */
export function existingCloudSqlDefinition(
  input: ExistingCloudSqlDefinitionInput,
): TofuDefinition {
  const mark = {
    cloudAccountId: input.cloudAccountId,
    environmentId: input.environmentId,
    stateId: input.stateId,
  };
  const labels = stateLabels(mark);
  const description = markDescription(mark);
  const network = `projects/${input.projectId}/global/networks/${networkName(input.environmentId, 'net')}`;
  const subnet = `projects/${input.projectId}/regions/${input.region}/subnetworks/${networkName(input.environmentId, 'psc')}`;
  const name = serviceName(input.serviceId);
  const { address, zone } = EXISTING_CLOUD_SQL_ADDRESSES;
  // Cloud DNS takes a zone's and a record's name only fully qualified.
  const qualified = input.dnsName.endsWith('.')
    ? input.dnsName
    : `${input.dnsName}.`;
  return {
    ...frame(input.projectId, input.region),
    resource: {
      google_compute_address: {
        endpoint: {
          name: existingEndpointName(input.serviceId),
          region: input.region,
          subnetwork: subnet,
          address_type: 'INTERNAL',
          description,
          labels,
        },
      },
      google_compute_forwarding_rule: {
        endpoint: {
          name: existingEndpointName(input.serviceId),
          region: input.region,
          network,
          ip_address: ref(address, 'id'),
          target: literal(input.serviceAttachment),
          // A Private Service Connect endpoint takes no scheme.
          load_balancing_scheme: '',
          description,
          labels,
        },
      },
      google_dns_managed_zone: {
        instance: {
          name: `${name}-sql`,
          dns_name: literal(qualified),
          visibility: 'private',
          description,
          labels,
          private_visibility_config: {
            networks: [{ network_url: network }],
          },
        },
      },
      google_dns_record_set: {
        instance: {
          name: literal(qualified),
          managed_zone: ref(zone, 'name'),
          type: 'A',
          ttl: RECORD_TTL_SECONDS,
          rrdatas: [ref(address, 'address')],
        },
      },
    },
    output: {
      [EXISTING_CLOUD_SQL_OUTPUTS.endpointAddress]: {
        value: ref(address, 'address'),
      },
      [EXISTING_CLOUD_SQL_OUTPUTS.endpointName]: {
        value: ref(EXISTING_CLOUD_SQL_ADDRESSES.forwardingRule, 'name'),
      },
    },
  };
}
