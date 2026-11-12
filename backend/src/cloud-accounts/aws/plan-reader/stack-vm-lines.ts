import { formatMachine } from '../definitions/database-class';
import { AWS_STACK_VMS } from '../definitions/stack-vm-machines';
import type { Outage } from './database-lines';
import type { StepAction, SummaryContext } from './plan-lines';
import type { TofuResourceChange } from './tofu-show.types';

type Values = Record<string, unknown>;

function valuesOf(value: unknown): Values {
  return value && typeof value === 'object' ? (value as Values) : {};
}

/** `t3.small (2 vCPU, 2 GB)`, or the type alone when the list does not know it. */
function machineText(type: unknown): string | null {
  if (typeof type !== 'string' || type === '') return null;
  const known = AWS_STACK_VMS.known.find((one) => one.name === type);
  return known ? `${type} (${formatMachine(known)})` : type;
}

const days = (count: number) => `${count} ${count === 1 ? 'day' : 'days'}`;

/** The first of a set-of-blocks field (`condition`, `host_header`). */
function first(value: unknown): Values {
  return Array.isArray(value) ? valuesOf(value[0]) : valuesOf(value);
}

/** `app.example.com/panel`: a Domain rule's host, and its path when not the whole host. */
function ruleHost(after: Values): string | null {
  const conditions = Array.isArray(after.condition) ? after.condition : [];
  let host: string | null = null;
  let path: string | null = null;
  for (const condition of conditions) {
    const one = valuesOf(condition);
    const hosts = first(one.host_header).values;
    if (Array.isArray(hosts) && typeof hosts[0] === 'string') host = hosts[0];
    const paths = first(one.path_pattern).values;
    if (Array.isArray(paths) && typeof paths[0] === 'string') path = paths[0];
  }
  if (!host) return null;
  return path && path !== '/*' ? `${host}${path}` : host;
}

/** `3000, 8080`: the ports a Stack VM's security group lets the load balancer in on. */
function ingressPorts(after: Values): number[] {
  const rules = Array.isArray(after.ingress) ? after.ingress : [];
  return rules
    .map((rule) => valuesOf(rule).from_port)
    .filter((port): port is number => typeof port === 'number')
    .sort((a, b) => a - b);
}

/**
 * The plain words for a Stack VM's Domains on the Environment network's
 * load balancer (#1371): each port's target group with the Stack VM in it,
 * each Domain's rule and certificate, and the ports its security group opens
 * to the load balancer. Each target's attachment and listener certificate
 * is folded into those lines. `undefined` for any other change.
 */
function stackVmDomainLines(
  change: TofuResourceChange,
  action: StepAction,
  name: string,
): string[] | undefined {
  const after = valuesOf(change.change.after ?? change.change.before);
  switch (`${change.type}.${change.name}`) {
    case 'aws_lb_target_group.stack_vm': {
      const label = `${name} Stack VM on port ${typeof after.port === 'number' ? after.port : '?'}`;
      return [
        action === 'destroy'
          ? `${label}: destroy, off the Environment network's load balancer`
          : `${label}: ${action}, a target of the Environment network's load balancer`,
      ];
    }
    case 'aws_lb_listener_rule.domain': {
      const host = ruleHost(after);
      const label = host ? `Domain \`${host}\`` : 'Domain rule';
      return [
        action === 'destroy'
          ? `${label}: destroy, its rule off the load balancer`
          : `${label}: ${action}, a rule on the load balancer`,
      ];
    }
    case 'aws_acm_certificate.domain': {
      const host =
        typeof after.domain_name === 'string' ? after.domain_name : null;
      const label = host
        ? `Domain \`${host}\` certificate`
        : 'Domain certificate';
      return [
        action === 'create'
          ? `${label}: request from ACM, issued once its DNS record is found`
          : `${label}: ${action}`,
      ];
    }
    case 'aws_security_group.stack_vm': {
      if (action !== 'change') return undefined;
      const ports = ingressPorts(valuesOf(change.change.after));
      return [
        ports.length > 0
          ? `${name} Stack VM security group: lets the load balancer in on TCP ${ports.join(', ')} only`
          : `${name} Stack VM security group: closes every port, no Domain left`,
      ];
    }
    case 'aws_lb_target_group_attachment.stack_vm':
    case 'aws_lb_listener_certificate.domain':
      return [];
    default:
      return undefined;
  }
}

/**
 * The plain words for a Stack VM's planned change (ADR-0070, #1359): the
 * machine type with its real CPU and memory, its data disk and its daily
 * snapshots, read from the plan so a line never claims what the definition
 * did not ask for. A new machine type restarts the Stack VM, and its line
 * says so (`stackVmOutages`). The identity, security group and attachments
 * are the raw lines' job.
 */
export function stackVmLines(
  change: TofuResourceChange,
  action: StepAction,
  context: SummaryContext,
): string[] {
  const name = context.serviceName ?? change.name;
  const domainLines = stackVmDomainLines(change, action, name);
  if (domainLines) return domainLines;
  const after = valuesOf(change.change.after ?? change.change.before);
  switch (change.type) {
    case 'aws_instance': {
      const label = `${name} Stack VM`;
      if (action === 'destroy') return [`${label}: destroy`];
      const machine = machineText(after.instance_type);
      if (action === 'change') {
        const before = valuesOf(change.change.before);
        if (before.instance_type !== after.instance_type) {
          return [
            `${label}: ${machineText(before.instance_type)} → ${machine}, restarts the Stack VM`,
          ];
        }
        return [`${label}: change`];
      }
      const parts: string[] = [action];
      if (action === 'replace')
        parts.push('brief downtime, its data disk kept');
      if (machine) parts.push(machine);
      if (action === 'create') {
        parts.push('no public address, reached through Session Manager');
      }
      return [`${label}: ${parts.join(', ')}`];
    }
    case 'aws_ebs_volume': {
      const label = `${name} Stack VM data disk`;
      if (action === 'destroy') return [`${label}: destroy, its volumes go`];
      const resized = diskResize(change);
      if (action === 'change' && resized) return [`${label}: ${resized}`];
      const size = typeof after.size === 'number' ? `${after.size} GB` : null;
      const type = typeof after.type === 'string' ? ` ${after.type}` : '';
      return [
        `${label}: ${action}${size ? `, ${size}${type}` : ''}${after.encrypted === true ? ', encrypted' : ''}`,
      ];
    }
    case 'aws_dlm_lifecycle_policy': {
      const label = `${name} Stack VM snapshots`;
      if (action === 'destroy') return [`${label}: no longer taken`];
      const details = valuesOf(
        (after.policy_details as unknown[] | undefined)?.[0],
      );
      const schedule = valuesOf(
        (details.schedule as unknown[] | undefined)?.[0],
      );
      const retain = valuesOf(
        (schedule.retain_rule as unknown[] | undefined)?.[0],
      );
      return typeof retain.count === 'number'
        ? [`${label}: ${action}, daily, each kept ${days(retain.count)}`]
        : [`${label}: ${action}`];
    }
    default:
      return [];
  }
}

/**
 * A data disk's new size in words (#1368): `20 GB → 40 GB, grown in place
 * with no restart`, or a shrink, which a read refuses before it is shown;
 * `null` when its size does not move.
 */
export function diskResize(change: TofuResourceChange): string | null {
  const before = valuesOf(change.change.before).size;
  const after = valuesOf(change.change.after).size;
  if (typeof before !== 'number' || typeof after !== 'number') return null;
  if (before === after) return null;
  return after > before
    ? `${before} GB → ${after} GB, grown in place with no restart`
    : `${before} GB → ${after} GB, a shrink, which a data disk never takes`;
}

/**
 * What takes a Stack VM's stack offline, kept beside its line: a new
 * machine type, which EC2 makes by stopping and starting it, and a
 * "replace VM", which makes it anew beside its data disk (#1368).
 */
export function stackVmOutages(
  change: TofuResourceChange,
  action: StepAction,
  context: SummaryContext,
): Outage[] {
  if (change.type !== 'aws_instance') return [];
  if (action === 'replace') {
    const [line] = stackVmLines(change, action, context);
    return [
      {
        kind: 'restart',
        serviceName: context.serviceName ?? change.name,
        line,
      },
    ];
  }
  if (action !== 'change') return [];
  const before = valuesOf(change.change.before).instance_type;
  const after = valuesOf(change.change.after).instance_type;
  if (before === after) return [];
  const [line] = stackVmLines(change, action, context);
  return [
    {
      kind: 'restart',
      serviceName: context.serviceName ?? change.name,
      line,
    },
  ];
}
