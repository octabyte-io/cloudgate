import { formatMachine } from '../../aws/definitions/database-class';
import { valueAt } from '../../aws/plan-reader/plan-values';
import type { Outage } from '../../aws/plan-reader/database-lines';
import type { StepAction } from '../../aws/plan-reader/plan-lines';
import type { TofuResourceChange } from '../../aws/plan-reader/tofu-show.types';
import { diskResize } from '../../aws/plan-reader/stack-vm-lines';
import { CLOUD_NAT_COST } from '../definitions/cloud-nat';
import {
  IAP_TUNNEL_RANGE,
  LOAD_BALANCER_RANGES,
} from '../definitions/stack-vm-definition';
import { GOOGLE_STACK_VMS } from '../definitions/stack-vm-machines';

/**
 * **A Stack VM's plan lines on Google Cloud** (ADR-0070, #1362), the twin
 * of AWS's `stack-vm-lines.ts`: the machine type with its real CPU and
 * memory, its data disk, its way in and its daily snapshots, read from the
 * plan so a line never claims what the definition did not ask for. A new
 * machine type restarts the Stack VM, and its line says so
 * ({@link googleStackVmOutages}). And the Environment network's Cloud NAT
 * its Stack VMs go out through, priced.
 */

type Values = Record<string, unknown>;

/** The resource types only a Stack VM's state holds. */
const STACK_VM_TYPES: ReadonlySet<string> = new Set([
  'google_compute_instance',
  'google_compute_disk',
  'google_compute_resource_policy',
  'google_compute_disk_resource_policy_attachment',
  // Its Domains' backend (#1371).
  'google_compute_instance_group',
  'google_compute_health_check',
]);

function valuesOf(change: TofuResourceChange): Values {
  const pick = change.change.after ?? change.change.before;
  return pick && typeof pick === 'object' ? (pick as Values) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The Stack VM's own firewall rule: IAP's tunnel range, and nothing else. */
export function isStackVmFirewall(change: TofuResourceChange): boolean {
  const ranges = valuesOf(change).source_ranges;
  return (
    change.type === 'google_compute_firewall' &&
    Array.isArray(ranges) &&
    ranges.includes(IAP_TUNNEL_RANGE)
  );
}

/** The Stack VM's rule letting the load balancer in on its Domains' ports. */
export function isStackVmLoadBalancerFirewall(
  change: TofuResourceChange,
): boolean {
  const ranges = valuesOf(change).source_ranges;
  return (
    change.type === 'google_compute_firewall' &&
    Array.isArray(ranges) &&
    LOAD_BALANCER_RANGES.every((range) => ranges.includes(range))
  );
}

/**
 * A Stack VM's backend service for one port: the only backend service
 * with a named port, which an instance group answers (a Cloud Run
 * Service's serverless NEG has none).
 */
function isStackVmBackend(change: TofuResourceChange): boolean {
  return (
    change.type === 'google_compute_backend_service' &&
    /^p\d+$/.test(text(valuesOf(change).port_name) ?? '')
  );
}

/** The ports a firewall rule lets through, or an instance group names. */
function portList(change: TofuResourceChange): string {
  const v = valuesOf(change);
  if (change.type === 'google_compute_instance_group') {
    const named = Array.isArray(v.named_port) ? v.named_port : [];
    return named
      .map((one) => valueAt(one, ['port']))
      .filter((port) => typeof port === 'number')
      .join(', ');
  }
  const ports = valueAt(v, ['allow', '0', 'ports']);
  return Array.isArray(ports)
    ? ports.filter((one) => text(one)).join(', ')
    : '';
}

/** `e2-small (2 vCPU, 2 GB)`, or the type alone when the list does not know it. */
function machineText(type: unknown): string | null {
  const name = text(type);
  if (!name) return null;
  const known = GOOGLE_STACK_VMS.known.find((one) => one.name === name);
  return known ? `${name} (${formatMachine(known)})` : name;
}

/** The last part of a zone's or a type's URL: `europe-west1-b`. */
function lastPart(value: unknown): string | undefined {
  return text(value)?.split('/').pop();
}

const days = (count: number) => `${count} ${count === 1 ? 'day' : 'days'}`;

/**
 * How a Stack VM's resource, or the network's Cloud NAT, is named in a
 * line; `undefined` for any other.
 */
export function stackVmLabel(
  change: TofuResourceChange,
  name: string,
  serviceName: string | undefined,
): string | undefined {
  const stack = serviceName ?? name;
  switch (change.type) {
    case 'google_compute_instance':
      return `${stack} Stack VM`;
    case 'google_compute_disk':
      return `${stack} Stack VM data disk`;
    case 'google_compute_resource_policy':
      return `${stack} Stack VM snapshots`;
    case 'google_compute_disk_resource_policy_attachment':
      return `${stack} Stack VM snapshots of its data disk`;
    case 'google_compute_firewall':
      return isStackVmFirewall(change) || isStackVmLoadBalancerFirewall(change)
        ? `${stack} Stack VM firewall rule \`${name}\``
        : undefined;
    case 'google_compute_instance_group':
      return `${stack} Stack VM load balancer group`;
    case 'google_compute_health_check':
      return `${stack} Stack VM health check \`${name}\``;
    case 'google_compute_backend_service': {
      if (!isStackVmBackend(change)) return undefined;
      const port = text(valuesOf(change).port_name)?.slice(1);
      return `${stack} Stack VM on port ${port}`;
    }
    case 'google_compute_router':
      return `Cloud Router \`${name}\``;
    case 'google_compute_router_nat':
      return `Cloud NAT \`${name}\``;
    default:
      return undefined;
  }
}

/**
 * The summary line of a Stack VM's resource or the network's Cloud NAT;
 * `null` when the change is folded into another's line, `undefined` when
 * it is none of theirs.
 */
export function stackVmSummaryLine(
  change: TofuResourceChange,
  action: StepAction,
  label: string,
): string | null | undefined {
  if (isStackVmBackend(change)) {
    return action === 'destroy'
      ? `${label}: destroy, off the Environment network's load balancer`
      : `${label}: ${action}, a backend of the Environment network's load balancer`;
  }
  if (isStackVmLoadBalancerFirewall(change)) {
    return action === 'destroy'
      ? `${label}: destroy, the load balancer no longer let in`
      : `${label}: ${action}, lets the load balancer (${LOAD_BALANCER_RANGES.join(', ')}) in on TCP ${portList(change)} only`;
  }
  if (!STACK_VM_TYPES.has(change.type) && !isStackVmFirewall(change)) {
    return natLine(change, action);
  }
  const v = valuesOf(change);
  switch (change.type) {
    case 'google_compute_instance_group':
      return action === 'destroy'
        ? `${label}: destroy`
        : `${label}: ${action}, ports ${portList(change)}`;
    // Each port's backend service says it; its health check is how it holds.
    case 'google_compute_health_check':
      return action === 'create' || action === 'destroy'
        ? null
        : `${label}: ${action}`;
    case 'google_compute_instance': {
      if (action === 'destroy') return `${label}: destroy`;
      const machine = machineText(v.machine_type);
      if (action === 'change') {
        const before = valueAt(change.change.before, ['machine_type']);
        return before !== v.machine_type
          ? `${label}: ${machineText(before)} → ${machine}, restarts the Stack VM`
          : `${label}: change`;
      }
      const parts: string[] = [action];
      if (action === 'replace')
        parts.push('brief downtime, its data disk kept');
      if (machine) parts.push(machine);
      const zone = lastPart(v.zone);
      if (zone) parts.push(`in ${zone}`);
      const access = valueAt(v, ['network_interface', '0', 'access_config']);
      if (Array.isArray(access) && access.length === 0) {
        parts.push("no external IP, reached through IAP's tunnel");
      }
      return `${label}: ${parts.join(', ')}`;
    }
    case 'google_compute_disk': {
      if (action === 'destroy') return `${label}: destroy, its volumes go`;
      const resized = diskResize(change);
      if (action === 'change' && resized) return `${label}: ${resized}`;
      const size = typeof v.size === 'number' ? `${v.size} GB` : null;
      const type = lastPart(v.type);
      const zone = lastPart(v.zone);
      return [
        `${label}: ${action}`,
        ...(size ? [`${size}${type ? ` ${type}` : ''}`] : []),
        ...(zone ? [`in ${zone}`] : []),
      ].join(', ');
    }
    case 'google_compute_resource_policy': {
      if (action === 'destroy') return `${label}: no longer taken`;
      const kept = valueAt(v, [
        'snapshot_schedule_policy',
        '0',
        'retention_policy',
        '0',
        'max_retention_days',
      ]);
      return typeof kept === 'number'
        ? `${label}: ${action}, daily, each kept ${days(kept)}`
        : `${label}: ${action}`;
    }
    // The schedule's line says it; the attachment is how it holds.
    case 'google_compute_disk_resource_policy_attachment':
      return action === 'create' || action === 'destroy'
        ? null
        : `${label}: ${action}`;
    default:
      // Its firewall rule.
      return action === 'create' || action === 'replace'
        ? `${label}: ${action}, lets IAP's tunnel (${IAP_TUNNEL_RANGE}) in on TCP 22 only`
        : `${label}: ${action}`;
  }
}

/** Cloud NAT, priced on its create; its router folded into its line. */
function natLine(
  change: TofuResourceChange,
  action: StepAction,
): string | null | undefined {
  if (change.type === 'google_compute_router') {
    return action === 'create' || action === 'destroy'
      ? null
      : `Cloud Router: ${action}`;
  }
  if (change.type !== 'google_compute_router_nat') return undefined;
  if (action === 'create') {
    return `Cloud NAT: create, the Stack VMs' way out to the internet, ${CLOUD_NAT_COST}`;
  }
  return action === 'destroy' ? 'Cloud NAT: remove' : `Cloud NAT: ${action}`;
}

/**
 * What takes a Stack VM's stack offline, kept beside its line: a new
 * machine type, which Compute Engine applies by stopping and starting it.
 */
export function googleStackVmOutages(
  change: TofuResourceChange,
  action: StepAction,
  label: string,
  serviceName: string | undefined,
): Outage[] {
  if (change.type !== 'google_compute_instance') return [];
  // A "replace VM" makes it anew beside its data disk (#1368).
  if (action === 'replace') {
    const line = stackVmSummaryLine(change, action, label);
    return line
      ? [{ kind: 'restart', serviceName: serviceName ?? change.name, line }]
      : [];
  }
  if (action !== 'change') return [];
  const before = valueAt(change.change.before, ['machine_type']);
  const after = valueAt(change.change.after, ['machine_type']);
  if (before === after) return [];
  const line = stackVmSummaryLine(change, action, label);
  return line
    ? [{ kind: 'restart', serviceName: serviceName ?? change.name, line }]
    : [];
}

/**
 * The import id of a Stack VM's snapshot attachment, when both the data
 * disk and the schedule it joins are taken back: Google lists no
 * attachment of its own, and making one that is there fails.
 * `{project}/{zone}/{disk}/{policy}`, from the disk's full name.
 */
export function joinedAttachmentId(
  diskId: string,
  policyName: string,
): string | null {
  const parts = /^projects\/([^/]+)\/zones\/([^/]+)\/disks\/([^/]+)$/.exec(
    diskId,
  );
  return parts ? `${parts[1]}/${parts[2]}/${parts[3]}/${policyName}` : null;
}
