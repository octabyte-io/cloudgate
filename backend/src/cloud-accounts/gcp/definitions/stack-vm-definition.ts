import { ref } from '../../definitions/tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';
import { stackVmCloudInit } from '../../definitions/stack-vm-cloud-init';
import type { StackVmPins } from '../../definitions/stack-vm-pins';
import { layNativeGcp } from '../../../native/gcp-lay';
import type { NativeGcpBlock } from '../../../native/gcp-native';
import { markDescription, stateLabels } from './mark';
import { serviceName } from './names';
import type { GcpNetworkNames } from './stand-ins';
import { frame, LOAD_BALANCING_SCHEME } from './tofu-json';

/**
 * Canonical's Google Cloud project, which publishes Ubuntu's images: the
 * pinned Ubuntu 24.04 build is looked up by its name there when a Stack VM
 * is made or replaced, and never again once its stack records the image.
 */
export const UBUNTU_IMAGE_PROJECT = 'ubuntu-os-cloud';

/**
 * The range IAP's TCP forwarding reaches a VM from, as Google documents
 * it: the one way in to a Stack VM, on SSH only.
 */
export const IAP_TUNNEL_RANGE = '35.235.240.0/20';

/**
 * The ranges Google's global external Application Load Balancer, and its
 * health checks, reach a backend from, as Google documents them: the one way
 * in to a Stack VM's Domain ports.
 */
export const LOAD_BALANCER_RANGES: readonly string[] = [
  '35.191.0.0/16',
  '130.211.0.0/22',
];

/**
 * What a Stack VM's Domain run applies on the stack's own state (#1371),
 * before and after the network's run writes the URL map: the instance group
 * that is the load balancer's backend, a health check and backend service
 * per published port, and the firewall rule from the load balancer.
 */
export const GOOGLE_STACK_VM_DOMAIN_ADDRESSES: readonly string[] = [
  'google_compute_instance_group.stack_vm',
  'google_compute_health_check.stack_vm',
  'google_compute_backend_service.stack_vm',
  'google_compute_firewall.load_balancer',
];

/**
 * The backend service a Domain of a Stack VM's stack on `port` is routed
 * to, by the name the network's URL map gives it: in the stack's state,
 * not the network's, as a Cloud Run Service's is.
 */
export function stackVmBackendName(serviceId: string, port: number): string {
  return `${serviceName(serviceId)}-p${port}`;
}

/** The address of the Stack VM itself, which `native.gcp` names. */
export const GOOGLE_STACK_VM_INSTANCE_ADDRESS =
  'google_compute_instance.stack_vm';

/** The name the data disk is attached under; cloud-init finds it whatever its name. */
export const DATA_DISK_DEVICE_NAME = 'cloudgate-data';

/** The hour (UTC) the daily snapshot is taken. */
const SNAPSHOT_START = '03:00';

/** The outputs an Apply records of a Stack VM on Google Cloud. */
export const GOOGLE_STACK_VM_OUTPUTS = {
  /** Its name, the id the tunnel and Stop/Start name it by. */
  instanceName: 'instance_name',
  privateIp: 'private_ip',
  /** The image it was made from, which the stack's settings record. */
  imageId: 'image_id',
  /** The zone it and its data disk are in, which the stack's settings record. */
  zone: 'zone',
  dataDiskName: 'data_disk_name',
} as const;

/**
 * The zone a Stack VM is made in: its region's zone `b`, which every
 * Google Cloud region has (some have no `a`). Recorded once made, so the
 * definition never moves it.
 */
export function stackVmZone(region: string): string {
  return `${region}-b`;
}

export interface GoogleStackVmDefinitionInput {
  readonly configName: string;
  /** The stack's id, which names everything it makes (S4). */
  readonly serviceId: string;
  /** Cloudgate's id of the Cloud account, for the mark. */
  readonly cloudAccountId: string;
  /** The Google Cloud project the Cloud account connects. */
  readonly projectId: string;
  readonly region: string;
  readonly environmentId: string;
  /** The stack's own Infrastructure state (ADR-0036). */
  readonly stateId: string;
  /** The network's saved names, or `gcpNetworkStandIns()` before it is made. */
  readonly network: GcpNetworkNames;
  /** `e2-small`: the size's, or its `native.gcp`'s. */
  readonly machineType: string;
  readonly dataDiskGb: number;
  readonly snapshotDays: number;
  /**
   * The image the stack's settings record, or `null` before it is made
   * and on a "replace VM" (#1368): the pinned Ubuntu 24.04 build
   * ({@link GoogleStackVmDefinitionInput.pins}) is looked up then.
   */
  readonly imageId: string | null;
  /**
   * What its first boot installs and, with no `imageId`, the image it is
   * made from: the pins it was made with once made, Cloudgate's own on a
   * create or an approved replace.
   */
  readonly pins: StackVmPins;
  /** The zone the stack's settings record, or `null`: {@link stackVmZone}. */
  readonly zone: string | null;
  /** Its `native.gcp`, already checked, laid last. Absent: Cloudgate's alone. */
  readonly native?: NativeGcpBlock | null;
  /**
   * The public half of the stack's own SSH key, which its first boot
   * authorizes (`stack-vm-cloud-init.ts`) and IAP's tunnel (#1365) reaches
   * it with; `null` for a plan read before the Apply that makes the stack
   * and its key.
   */
  readonly sshPublicKey: string | null;
  /**
   * The ports the stack's Domains reach (#1371), each published on the
   * Stack VM at its own number. Left out by a plan read of a new stack and
   * by its create's run; given by every Domain run, whose targets reach
   * what its state holds, so a port no Domain reaches any more is closed.
   */
  readonly ports?: readonly number[];
}

export interface GoogleStackVmDefinition {
  readonly definition: TofuDefinition;
  /** The Docker and compose pins its first boot installs, which the Apply records. */
  readonly pins: StackVmPins;
}

/**
 * The OpenTofu definition of a Compose stack's **Stack VM** on Google
 * Cloud, in the stack's own Infrastructure state (ADR-0070, ADR-0036).
 * Pure: no Google call, no `tofu`, no database. The twin of AWS's
 * `stackVmDefinition`.
 *
 * - **The Stack VM**: one Compute Engine instance on the Environment
 *   network's subnet, with **no external IP** (no access config), from
 *   the pinned Ubuntu 24.04 build (or the image its stack records),
 *   restarted by Google when it dies and live-migrated on maintenance, its
 *   first boot the shared cloud-init (`stack-vm-cloud-init.ts`) as its
 *   `user-data`, at the pins it is given. Its user data is never changed
 *   in place, since it never reads it again: only an approved "replace VM"
 *   line, applied with `-replace`, makes it anew at new pins (#1368).
 * - **Its identity**: a service account of its own, holding no role.
 * - **Its way in**: one firewall rule letting IAP's TCP forwarding range
 *   reach SSH on it alone (by its service account), and, once the stack
 *   has Domains, one letting the load balancer's ranges reach the ports
 *   they are on. Its way out is the network's Cloud NAT (`cloud-nat.ts`).
 * - **Its Domains** (#1371): an unmanaged instance group holding the Stack
 *   VM, naming each port, and per port a health check and a backend service
 *   on the global load balancer, which the network's URL map names
 *   ({@link stackVmBackendName}). The host rules and certificates are the
 *   network's, as every Domain's on Google Cloud.
 * - **Its data disk**: a balanced persistent disk in its zone, attached
 *   to it, kept apart from the boot disk so a replaced VM keeps the stack's
 *   volumes.
 * - **Its daily snapshots**: a snapshot schedule keeping
 *   {@link GoogleStackVmDefinitionInput.snapshotDays} days, attached to the
 *   data disk. Snapshots carry no label, so no search by Cloudgate's mark
 *   lists them as strays.
 *
 * Every resource is named from the stack's id (`cloudgate-<key>…`) and
 * carries Cloudgate's mark in its description, with the state's labels
 * where it takes them; the attachment, which takes neither, is the disk's
 * and the schedule's.
 */
export function googleStackVmDefinition(
  input: GoogleStackVmDefinitionInput,
): GoogleStackVmDefinition {
  const mark = {
    cloudAccountId: input.cloudAccountId,
    environmentId: input.environmentId,
    stateId: input.stateId,
  };
  const description = markDescription(mark);
  const labels = stateLabels(mark);
  const name = serviceName(input.serviceId);
  const zone = input.zone ?? stackVmZone(input.region);
  const network = `projects/${input.projectId}/global/networks/${input.network.networkName}`;
  const subnetwork = `projects/${input.projectId}/regions/${input.region}/subnetworks/${input.network.subnetName}`;

  const account = 'google_service_account.stack_vm';
  const disk = 'google_compute_disk.data';
  const policy = 'google_compute_resource_policy.snapshots';
  const instance = GOOGLE_STACK_VM_INSTANCE_ADDRESS;

  if (input.imageId === null && !input.pins.image) {
    throw new Error(
      `${input.configName}'s Stack VM has no recorded image and no pinned one`,
    );
  }
  const resource = {
    google_service_account: {
      stack_vm: {
        account_id: name,
        display_name: `Cloudgate Stack VM ${input.configName}`,
        description,
      },
    },
    google_compute_firewall: {
      iap: {
        name: `${name}-iap`,
        description,
        network,
        direction: 'INGRESS',
        priority: 1000,
        source_ranges: [IAP_TUNNEL_RANGE],
        allow: [{ protocol: 'tcp', ports: ['22'] }],
        target_service_accounts: [ref(account, 'email')],
      },
    },
    google_compute_disk: {
      data: {
        name: `${name}-data`,
        description,
        zone,
        size: input.dataDiskGb,
        type: 'pd-balanced',
        labels,
      },
    },
    google_compute_resource_policy: {
      snapshots: {
        name: `${name}-snapshots`,
        description,
        region: input.region,
        snapshot_schedule_policy: {
          schedule: {
            daily_schedule: { days_in_cycle: 1, start_time: SNAPSHOT_START },
          },
          retention_policy: {
            max_retention_days: input.snapshotDays,
            on_source_disk_delete: 'APPLY_RETENTION_POLICY',
          },
          snapshot_properties: { storage_locations: [input.region] },
        },
      },
    },
    google_compute_disk_resource_policy_attachment: {
      snapshots: {
        name: ref(policy, 'name'),
        disk: ref(disk, 'name'),
        zone,
      },
    },
    google_compute_instance: {
      stack_vm: {
        name,
        description,
        zone,
        machine_type: input.machineType,
        labels,
        boot_disk: {
          auto_delete: true,
          initialize_params: {
            image:
              input.imageId ?? '${data.google_compute_image.ubuntu.self_link}',
            size: 10,
            type: 'pd-balanced',
            labels,
          },
        },
        attached_disk: [
          {
            source: ref(disk, 'self_link'),
            device_name: DATA_DISK_DEVICE_NAME,
            mode: 'READ_WRITE',
          },
        ],
        // No access config: no external IP.
        network_interface: [{ network, subnetwork }],
        service_account: {
          email: ref(account, 'email'),
          scopes: ['cloud-platform'],
        },
        metadata: {
          'user-data': stackVmCloudInit(input.pins, input.sshPublicKey),
        },
        scheduling: {
          automatic_restart: true,
          on_host_maintenance: 'MIGRATE',
        },
        can_ip_forward: false,
        deletion_protection: false,
        allow_stopping_for_update: true,
        // Read on its first boot only: a new Cloudgate's first boot is for
        // the next Stack VM, or an approved replace (`-replace`), never an
        // edit of this one.
        lifecycle: { ignore_changes: ['metadata["user-data"]'] },
      },
    },
  };

  const routed =
    input.ports === undefined
      ? {}
      : loadBalancerResources({
          ports: input.ports,
          name,
          zone,
          network,
          description,
          instance,
          account,
        });

  const output = (value: string) => ({ value });
  return {
    pins: input.pins,
    definition: {
      ...frame(input.projectId, input.region),
      ...(input.imageId === null
        ? {
            data: {
              google_compute_image: {
                ubuntu: {
                  project: UBUNTU_IMAGE_PROJECT,
                  name: input.pins.image,
                },
              },
            },
          }
        : {}),
      // Native last, over everything Cloudgate wrote.
      resource: layNativeGcp(mergeBlocks(resource, routed), input.native),
      output: {
        [GOOGLE_STACK_VM_OUTPUTS.instanceName]: output(ref(instance, 'name')),
        [GOOGLE_STACK_VM_OUTPUTS.privateIp]: output(
          `\${${instance}.network_interface[0].network_ip}`,
        ),
        [GOOGLE_STACK_VM_OUTPUTS.imageId]: output(
          `\${${instance}.boot_disk[0].initialize_params[0].image}`,
        ),
        [GOOGLE_STACK_VM_OUTPUTS.zone]: output(ref(instance, 'zone')),
        [GOOGLE_STACK_VM_OUTPUTS.dataDiskName]: output(ref(disk, 'name')),
      },
    },
  };
}

type Blocks = Record<string, Record<string, unknown>>;

function mergeBlocks(base: Blocks, more: Blocks): Blocks {
  const merged: Blocks = { ...base };
  for (const [type, byName] of Object.entries(more)) {
    merged[type] = { ...(merged[type] ?? {}), ...byName };
  }
  return merged;
}

/**
 * A Stack VM's load balancer pieces on Google Cloud. With no port, none is
 * written: the run that removes the last Domain targets them by address, so
 * what its state still holds is destroyed (a firewall rule with no port
 * would open every one).
 */
function loadBalancerResources(on: {
  ports: readonly number[];
  name: string;
  zone: string;
  network: string;
  description: string;
  instance: string;
  account: string;
}): Blocks {
  const ports = [...new Set(on.ports)].sort((a, b) => a - b);
  const byPort = Object.fromEntries(ports.map((port) => [String(port), port]));
  const group = 'google_compute_instance_group.stack_vm';
  if (ports.length === 0) return {};
  return {
    google_compute_health_check: {
      stack_vm: {
        for_each: byPort,
        name: `${on.name}-p\${each.key}`,
        description: on.description,
        tcp_health_check: { port: '${each.value}' },
      },
    },
    google_compute_backend_service: {
      stack_vm: {
        for_each: byPort,
        name: `${on.name}-p\${each.key}`,
        description: on.description,
        load_balancing_scheme: LOAD_BALANCING_SCHEME,
        protocol: 'HTTP',
        port_name: 'p${each.key}',
        backend: [{ group: ref(group, 'self_link') }],
        health_checks: ['${google_compute_health_check.stack_vm[each.key].id}'],
      },
    },
    google_compute_instance_group: {
      stack_vm: {
        name: `${on.name}-group`,
        description: on.description,
        zone: on.zone,
        network: on.network,
        instances: [ref(on.instance, 'self_link')],
        named_port: ports.map((port) => ({ name: `p${port}`, port })),
      },
    },
    google_compute_firewall: {
      load_balancer: {
        name: `${on.name}-lb`,
        description: on.description,
        network: on.network,
        direction: 'INGRESS',
        priority: 1000,
        source_ranges: LOAD_BALANCER_RANGES,
        allow: [{ protocol: 'tcp', ports: ports.map(String) }],
        target_service_accounts: [ref(on.account, 'email')],
      },
    },
  };
}
