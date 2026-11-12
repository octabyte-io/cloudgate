import { literal, ref } from '../../definitions/tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';
import { markDescription, stateLabels } from './mark';
import { networkName, serviceName } from './names';
import { frame } from './tofu-json';

/** The two manual endpoints an existing Valkey is reached through: its primary's, then its reader's. */
export const VALKEY_ENDPOINTS = ['primary', 'reader'] as const;

export type ValkeyEndpoint = (typeof VALKEY_ENDPOINTS)[number];

export interface ExistingValkeyDefinitionInput {
  /** The redis Service's id, which names what Cloudgate makes (S4). */
  readonly serviceId: string;
  /** Cloudgate's id of the Cloud account, for the mark. */
  readonly cloudAccountId: string;
  /** The Environment's Google Cloud project: where the endpoints are made. */
  readonly projectId: string;
  readonly region: string;
  readonly environmentId: string;
  /** The Service's Infrastructure state. */
  readonly stateId: string;
  /**
   * The instance's two service attachments, as its lookup read them
   * (`pscAttachmentDetails[].serviceAttachment`): its primary's, then its
   * reader's.
   */
  readonly serviceAttachments: {
    readonly [endpoint in ValkeyEndpoint]: string;
  };
}

/** The outputs a run reads of what it made, per endpoint. */
export const EXISTING_VALKEY_OUTPUTS: {
  readonly [endpoint in ValkeyEndpoint]: {
    /** The endpoint's address on the private link subnet. */
    readonly address: string;
    /** Its forwarding rule's name, which `--add-endpoints` names. */
    readonly name: string;
    /** The rule's `pscConnectionId`, which `--add-endpoints` names too. */
    readonly pscConnectionId: string;
  };
} = {
  primary: {
    address: 'primary_address',
    name: 'primary_name',
    pscConnectionId: 'primary_psc_connection_id',
  },
  reader: {
    address: 'reader_address',
    name: 'reader_name',
    pscConnectionId: 'reader_psc_connection_id',
  },
};

/**
 * Each endpoint's address and forwarding rule's name: the Service's own,
 * as {@link existingValkeyDefinition} writes them.
 */
export function existingValkeyEndpointName(
  serviceId: string,
  endpoint: ValkeyEndpoint,
): string {
  return `${serviceName(serviceId)}-psc-${VALKEY_ENDPOINTS.indexOf(endpoint)}`;
}

/**
 * The OpenTofu definition of what Cloudgate makes for an **Existing
 * database** that is a Memorystore for Valkey `redis` (ADR-0033 as
 * amended; checked on a live walk). Pure: no Google call, no `tofu`, no
 * database. It sits in the redis Service's own Infrastructure state and
 * goes with its Delete; the instance itself is never in it, and nothing
 * here changes it.
 *
 * **Two manual Private Service Connect endpoints**, one to each of the
 * instance's service attachments (its primary's and its reader's): each an
 * internal address on the Environment network's private link subnet and a
 * forwarding rule from the Environment network. Google's automatic
 * connections were rejected: they are set on the instance. Until the
 * operator registers both on the instance (`--add-endpoints`, the one step
 * only they can take), the rules read `PENDING`.
 *
 * The network and its subnet are named by the Environment's id (S4), never
 * read from its state. Each address and rule carries the mark, as an
 * existing Cloud SQL's endpoint does.
 */
export function existingValkeyDefinition(
  input: ExistingValkeyDefinitionInput,
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
  const addresses: Record<string, object> = {};
  const rules: Record<string, object> = {};
  const output: Record<string, { value: string }> = {};
  for (const endpoint of VALKEY_ENDPOINTS) {
    const name = existingValkeyEndpointName(input.serviceId, endpoint);
    const address = `google_compute_address.${endpoint}`;
    const rule = `google_compute_forwarding_rule.${endpoint}`;
    addresses[endpoint] = {
      name,
      region: input.region,
      subnetwork: subnet,
      address_type: 'INTERNAL',
      description,
      labels,
    };
    rules[endpoint] = {
      name,
      region: input.region,
      network,
      ip_address: ref(address, 'id'),
      target: literal(input.serviceAttachments[endpoint]),
      // A Private Service Connect endpoint takes no scheme.
      load_balancing_scheme: '',
      description,
      labels,
    };
    const outputs = EXISTING_VALKEY_OUTPUTS[endpoint];
    output[outputs.address] = { value: ref(address, 'address') };
    output[outputs.name] = { value: ref(rule, 'name') };
    output[outputs.pscConnectionId] = { value: ref(rule, 'psc_connection_id') };
  }
  return {
    ...frame(input.projectId, input.region),
    resource: {
      google_compute_address: addresses,
      google_compute_forwarding_rule: rules,
    },
    output,
  };
}
