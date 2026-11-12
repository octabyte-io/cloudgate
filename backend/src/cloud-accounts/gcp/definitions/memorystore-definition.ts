import type { TofuDefinition } from '../../definitions/tofu-json';
import { stateLabels } from './mark';
import { serviceName } from './names';
import { frame } from './tofu-json';
import type { GcpNetworkNames } from './stand-ins';
import { layNativeGcp } from '../../../native/gcp-lay';
import type { NativeGcpBlock } from '../../../native/gcp-native';

export interface MemorystoreDefinitionInput {
  /** The Service's id, which names the instance (S4). */
  readonly serviceId: string;
  /** Cloudgate's id of the Cloud account, for the mark. */
  readonly cloudAccountId: string;
  /** The Google Cloud project the Cloud account connects. */
  readonly projectId: string;
  readonly region: string;
  readonly environmentId: string;
  /** The Service's Infrastructure state. */
  readonly stateId: string;
  /** The network's saved names, or `gcpNetworkStandIns()` before it is made. */
  readonly network: Pick<GcpNetworkNames, 'networkName'>;
  /** The node type (`CUSTOM_PICO`): the planner's, or the row's. */
  readonly nodeType: string;
  /** `VALKEY_9_1`: the shared Valkey version rule's reading. */
  readonly engineVersion: string;
  /**
   * High availability, the console's setting: one replica in
   * another zone. Off on a create.
   */
  readonly highAvailability: boolean;
  /**
   * How many days each daily automated backup is kept, the Service's own
   * setting (0–365): 0 is off. `null` for an instance made before
   * backups, which is written without them.
   */
  readonly backupRetentionDays: number | null;
  /**
   * Its `native.gcp` (ADR-0044 rule 3), already checked: laid over
   * what this builder writes, field by field, `engine_configs` key by key,
   * so a native `maxmemory-policy` keeps Cloudgate's other keys. A plan's
   * read lays the entry's, a Cloud run the one its row holds. Absent or
   * `null`: exactly Cloudgate's definition.
   */
  readonly native?: NativeGcpBlock | null;
}

/**
 * A Google `redis`'s backup retention: 1 day by default, 0
 * (off) to 365.
 */
export const MEMORYSTORE_BACKUP_RETENTION = {
  default: 1,
  min: 0,
  max: 365,
} as const;

/** The hour (UTC) Memorystore starts its daily automated backup. */
const BACKUP_HOUR = 3;

const SECONDS_A_DAY = 86_400;

/** The address of the instance in a Memorystore definition. */
export const MEMORYSTORE_INSTANCE_ADDRESS = 'google_memorystore_instance.cache';

/** The outputs a run saves of the instance. */
export const MEMORYSTORE_OUTPUTS = {
  /** Its primary endpoint's address on the private link: the `host` Output. */
  address: 'address',
  /** The port that endpoint answers on. */
  port: 'port',
  /** Its own CA, PEM: the `ca` Output. */
  ca: 'ca',
} as const;

/** The port a Memorystore instance with cluster mode off answers on. */
export const MEMORYSTORE_PORT = 6379;

/** Cluster mode off, so ioredis, node-redis and BullMQ connect unchanged. */
export const MEMORYSTORE_MODE = 'CLUSTER_DISABLED';

/**
 * No password (ADR-0042): Cloudgate's role cannot read a token-auth
 * instance's token, since Google offers no grantable permission for
 * `memorystore.authTokens.list`, and IAM auth has no plain URL. The
 * instance is reached only from its Environment's own private network,
 * over TLS.
 */
export const MEMORYSTORE_AUTHORIZATION_MODE = 'AUTH_DISABLED';

/** TLS always on, checked against the instance's CA. */
export const MEMORYSTORE_TRANSIT_ENCRYPTION = 'SERVER_AUTHENTICATION';

/** Google's default: a CA of the instance's own. */
export const MEMORYSTORE_CA_MODE = 'GOOGLE_MANAGED_PER_INSTANCE_CA';

/**
 * The eviction policy Cloudgate always sets: Google's default
 * `volatile-lru` can drop BullMQ jobs. A pure cache sets another through
 * `native`.
 */
export const MEMORYSTORE_EVICTION = 'noeviction';

/** The endpoint a client with cluster mode off connects to. */
const PRIMARY_CONNECTION = 'CONNECTION_TYPE_PRIMARY';

/**
 * The OpenTofu definition of a `redis` on Memorystore for Valkey, its own
 * Infrastructure state (the Google Cloud databases spec "Redis on Memorystore"). Pure: no
 * Google call, no `tofu`, no database.
 *
 * One instance, named `cloudgate-<service key>` by the Service's id as
 * every Google name is, with **cluster mode off** (one shard) and **one
 * node**, or with **high availability** one replica in another zone
 * which Memorystore adds or removes in place, on the planner's node
 * type and Valkey version. Every setting Cloudgate overrides is the spec's:
 * `maxmemory-policy` is **`noeviction`**, and **deletion protection is off**
 * so a Delete reclaims it (ADR-0018). **Automated backups**, one a day,
 * are kept for the Service's retention, or are off at 0. **No password** (`AUTH_DISABLED`,
 * ADR-0042) and **TLS** with Google's **per-instance CA** are set at
 * create and never changed, nor is cluster mode (`ignore_changes`): an
 * app's `REDIS_URL` and `ca` depend on them. Its address comes from the
 * Environment network's private link, through Memorystore's service
 * connection policy, by an automatically created endpoint in the network,
 * which only that Environment's network reaches.
 */
export function memorystoreDefinition(
  input: MemorystoreDefinitionInput,
): TofuDefinition {
  const instance = MEMORYSTORE_INSTANCE_ADDRESS;
  const resource = {
    google_memorystore_instance: {
      cache: {
        instance_id: serviceName(input.serviceId),
        location: input.region,
        mode: MEMORYSTORE_MODE,
        shard_count: 1,
        replica_count: input.highAvailability ? 1 : 0,
        node_type: input.nodeType,
        engine_version: input.engineVersion,
        engine_configs: { 'maxmemory-policy': MEMORYSTORE_EVICTION },
        authorization_mode: MEMORYSTORE_AUTHORIZATION_MODE,
        transit_encryption_mode: MEMORYSTORE_TRANSIT_ENCRYPTION,
        server_ca_mode: MEMORYSTORE_CA_MODE,
        deletion_protection_enabled: false,
        ...(input.backupRetentionDays
          ? {
              automated_backup_config: {
                fixed_frequency_schedule: {
                  start_time: { hours: BACKUP_HOUR },
                },
                retention: `${input.backupRetentionDays * SECONDS_A_DAY}s`,
              },
            }
          : {}),
        labels: stateLabels({
          cloudAccountId: input.cloudAccountId,
          environmentId: input.environmentId,
          stateId: input.stateId,
        }),
        desired_auto_created_endpoints: [
          {
            network: `projects/${input.projectId}/global/networks/${input.network.networkName}`,
            project_id: input.projectId,
          },
        ],
        // Set at create, never changed by Cloudgate.
        lifecycle: {
          ignore_changes: [
            'mode',
            'authorization_mode',
            'transit_encryption_mode',
            'server_ca_mode',
          ],
        },
      },
    },
  };
  const primary = (field: string) =>
    `\${try(one(flatten([for endpoint in ${instance}.endpoints : [for connection in endpoint.connections : [for auto in connection.psc_auto_connection : auto.${field} if auto.connection_type == "${PRIMARY_CONNECTION}"]]])), "")}`;

  return {
    ...frame(input.projectId, input.region),
    // Native last, over everything Cloudgate wrote.
    resource: layNativeGcp(resource, input.native),
    output: {
      [MEMORYSTORE_OUTPUTS.address]: { value: primary('ip_address') },
      [MEMORYSTORE_OUTPUTS.port]: { value: primary('port') },
      [MEMORYSTORE_OUTPUTS.ca]: {
        value: `\${join("", flatten([for ca in ${instance}.managed_server_ca : [for chain in ca.ca_certs : chain.certificates]]))}`,
        sensitive: true,
      },
    },
  };
}
