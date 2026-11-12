import { ref } from '../../definitions/tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';
import { stackVmCloudInit } from '../../definitions/stack-vm-cloud-init';
import type { StackVmPins } from '../../definitions/stack-vm-pins';
import { layNativeAws } from '../../../native/aws-lay';
import type { NativeAwsBlock } from '../../../native/aws-native';
import type { DatabaseNetworkIds } from './postgres-definition';
import { addressTag } from './tags';
import { TAG_KEYS } from './tags';
import { frame, Resources, rule } from './tofu-json';
import type { AwsAccountAccess } from './tofu-json';
import { DOMAIN_ADDRESSES, domainResources } from './web-definition';
import type { WebDomain } from './web-definition';

/**
 * Canonical's AWS account, which publishes Ubuntu's AMIs: the pinned
 * Ubuntu 24.04 build is looked up by its name there when a Stack VM is
 * made or replaced, and never again once its stack records the image.
 */
export const CANONICAL_ACCOUNT = '099720109477';

/** The address of the Stack VM itself, which `native.aws` names. */
export const STACK_VM_INSTANCE_ADDRESS = 'aws_instance.stack_vm';

/**
 * The tag Data Lifecycle Manager finds the data disk by: the state's id,
 * so the policy snapshots this stack's disk and no other.
 */
export const STACK_VM_DATA_TAG = 'cloudgate:stack-vm-data';

/**
 * The IAM path of a Stack VM's roles and instance profile: apart from
 * the task roles' `/cloudgate/`, so the deploy role's grants for one never
 * reach the other (`setup-template.ts`, version 4 on). A Stack VM's role
 * holds only the two AWS policies below, and no inline policy.
 */
export const STACK_VM_IAM_PATH = '/cloudgate/stack-vm/';

/** The AWS managed policy that lets Session Manager reach the Stack VM. */
export const SESSION_MANAGER_POLICY =
  'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore';

/** The AWS managed policy Data Lifecycle Manager snapshots volumes with. */
export const SNAPSHOT_POLICY =
  'arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole';

/** The device the data disk is attached as; cloud-init finds it whatever its name. */
export const DATA_DISK_DEVICE = '/dev/sdf';

/** The outputs an Apply records of a Stack VM. */
export const STACK_VM_OUTPUTS = {
  instanceId: 'instance_id',
  privateIp: 'private_ip',
  /** The image it was made from, which the stack's settings record. */
  imageId: 'image_id',
  dataVolumeId: 'data_volume_id',
  /** Its zone, which its data disk is in and a replaced Stack VM keeps. */
  zone: 'zone',
} as const;

/**
 * One Domain of a compose service on a Stack VM: its host rule and
 * certificate, as a `web`'s, and the port the load balancer reaches the
 * service on. The deploy publishes the Domain's port on the Stack VM at the
 * same number (`stack-vm-ports.ts`), so the port is both the container's
 * and the Stack VM's.
 */
export interface StackVmDomain extends WebDomain {
  readonly port: number;
}

/** The Environment network's load balancer, as a Stack VM's Domains reach it. */
export interface StackVmLoadBalancer {
  readonly httpsListenerArn: string;
  readonly albSecurityGroupId: string;
}

/**
 * What a Stack VM's Domain run applies (`-target`): the three Domain blocks,
 * the target group of each published port and the Stack VM as its target,
 * and the security group whose rules let the load balancer in on those ports.
 * Each block is one resource over every port or Domain, so one left out is
 * destroyed by the same run.
 */
export const STACK_VM_DOMAIN_ADDRESSES: readonly string[] = [
  ...DOMAIN_ADDRESSES,
  'aws_lb_target_group.stack_vm',
  'aws_lb_target_group_attachment.stack_vm',
  'aws_security_group.stack_vm',
];

/**
 * The health check of a Stack VM's target group: any answer below 500 is
 * up, since a compose service's `/` may well ask for a sign-in or answer 404,
 * and Cloudgate has no health path of its own for it.
 */
const STACK_VM_HEALTH_CHECK = {
  enabled: true,
  protocol: 'HTTP',
  port: 'traffic-port',
  path: '/',
  matcher: '200-499',
} as const;

export interface StackVmDefinitionInput {
  readonly configName: string;
  /** The stack's id, which names its role and instance profile. */
  readonly serviceId: string;
  readonly account: AwsAccountAccess & { readonly cloudAccountId: string };
  readonly region: string;
  readonly environmentId: string;
  /** The stack's own Infrastructure state (ADR-0036). */
  readonly stateId: string;
  /** The Environment network's private subnets; the Stack VM sits in the first. */
  readonly network: DatabaseNetworkIds;
  /** `t3.small`: the size's, or its `native.aws`'s. */
  readonly machineType: string;
  readonly dataDiskGb: number;
  readonly snapshotDays: number;
  /**
   * The image the stack's settings record, or `null` before it is made
   * and on a "replace VM" (#1368): the pinned Ubuntu 24.04 build
   * ({@link StackVmDefinitionInput.pins}) is looked up then.
   */
  readonly imageId: string | null;
  /**
   * The zone the stack's settings record, or `null` before it is made:
   * the Stack VM's subnet's then. A made Stack VM's data disk stays in it,
   * so a replaced Stack VM never moves the disk (#1368).
   */
  readonly zone: string | null;
  /**
   * What its first boot installs and, with no `imageId`, the image it is
   * made from: the pins it was made with once made, Cloudgate's own on a
   * create or an approved replace.
   */
  readonly pins: StackVmPins;
  /** Its `native.aws`, already checked, laid last. Absent: Cloudgate's alone. */
  readonly native?: NativeAwsBlock | null;
  /**
   * The public half of the stack's own SSH key, which its first boot
   * authorizes (`stack-vm-cloud-init.ts`); `null` for a plan read before
   * the Apply that makes the stack and its key.
   */
  readonly sshPublicKey: string | null;
  /**
   * The stack's Domains (#1371). Left out by a plan read of a new stack,
   * which has none, and by its create's run; given (if empty) by every
   * Domain run, so a Domain removed is one its run destroys.
   */
  readonly domains?: readonly StackVmDomain[];
  /** The network's load balancer; needed once {@link domains} are given. */
  readonly loadBalancer?: StackVmLoadBalancer | null;
}

export interface StackVmDefinition {
  readonly definition: TofuDefinition;
  /** The Docker and compose pins its first boot installs, which the Apply records. */
  readonly pins: StackVmPins;
}

/** An IAM name from the stack's id: lower case, letters and digits. */
function idPart(serviceId: string): string {
  return serviceId.toLowerCase().replace(/[^a-z0-9]/g, 'x');
}

const assumedBy = (service: string) =>
  JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: service },
        Action: 'sts:AssumeRole',
      },
    ],
  });

/**
 * The OpenTofu definition of a Compose stack's **Stack VM** on AWS, in
 * the stack's own Infrastructure state (ADR-0070, ADR-0036). Pure: no AWS
 * call, no `tofu`, no database.
 *
 * - **The Stack VM**: one EC2 instance in the Environment network's first
 *   private subnet, from the pinned Ubuntu 24.04 build (or the image its
 *   stack records), with no public IP, IMDSv2 only and EC2's automatic
 *   recovery, its first boot the shared cloud-init (`stack-vm-cloud-init.ts`)
 *   at the pins it is given. Its user data is never changed in place, since
 *   it never reads it again: only an approved "replace VM" line, applied
 *   with `-replace`, makes it anew at new pins (#1368).
 * - **Its identity**: a role only EC2 assumes, holding the Session Manager
 *   policy and nothing else, and its instance profile. Both are named by
 *   the stack's id, so a lost state finds them by name and takes them back.
 * - **Its security group**: no way in but from the Environment network's
 *   load balancer, on each port a Domain of the stack reaches. Its way out
 *   is open, for the tunnel, apt and image pulls.
 * - **Its data disk**: an encrypted gp3 EBS volume in the Stack VM's own
 *   zone (its recorded one once made), attached to it, kept apart from the
 *   boot disk so a replaced VM keeps the stack's volumes. The Stack VM is
 *   stopped before the disk is detached from it, so the disk is let go
 *   cleanly. It only grows: a smaller size is refused before any plan.
 * - **Its daily snapshots**: a Data Lifecycle Manager policy, with its own
 *   role, keeping {@link StackVmDefinitionInput.snapshotDays}. Snapshots
 *   copy none of the disk's tags, so a tag search never lists them as
 *   strays; they carry the policy's own.
 * - **Its Domains** (#1371): a target group per published port with the
 *   Stack VM as its one target, and per Domain an ACM certificate and a
 *   host rule on the network's HTTPS listener, as a `web`'s.
 *
 * Every taggable resource carries Cloudgate's mark (`frame`'s default tags
 * and each one's address tag).
 */
export function stackVmDefinition(
  input: StackVmDefinitionInput,
): StackVmDefinition {
  const { account, network } = input;
  const mark = {
    cloudAccountId: account.cloudAccountId,
    environmentId: input.environmentId,
    stateId: input.stateId,
  };
  const label = (part: string) => `cloudgate/${input.configName}/${part}`;
  const id = idPart(input.serviceId);
  const r = new Resources();

  const role = r.tagged('aws_iam_role', 'stack_vm', label('stack-vm'), {
    name: `cloudgate-stack-vm-${id}`,
    path: STACK_VM_IAM_PATH,
    description: 'Cloudgate: a Stack VM, reached through Session Manager',
    assume_role_policy: assumedBy('ec2.amazonaws.com'),
  });
  r.untagged('aws_iam_role_policy_attachment', 'session_manager', {
    role: ref(role, 'name'),
    policy_arn: SESSION_MANAGER_POLICY,
  });
  const profile = r.tagged(
    'aws_iam_instance_profile',
    'stack_vm',
    label('stack-vm'),
    {
      name: `cloudgate-stack-vm-${id}`,
      path: STACK_VM_IAM_PATH,
      role: ref(role, 'name'),
    },
  );

  const domains = input.domains;
  const loadBalancer = input.loadBalancer ?? null;
  if (domains && domains.length > 0 && !loadBalancer) {
    throw new Error(
      "A Stack VM's Domains need the Environment network's load balancer",
    );
  }
  const ports = [...new Set((domains ?? []).map((one) => one.port))].sort(
    (a, b) => a - b,
  );

  const group = r.tagged('aws_security_group', 'stack_vm', label('stack-vm'), {
    name: `cloudgate-stack-vm-${input.serviceId}`,
    // Fixed, and true whatever its ingress: a changed description replaces
    // the group, so it says what the group is for, never what is open (a
    // Domain opens a port to the load balancer, #1371).
    description:
      'Cloudgate: the Stack VM of a Compose stack, reached through Session Manager',
    vpc_id: network.vpcId,
    ingress: ports.map((port) =>
      rule({
        port,
        protocol: 'tcp',
        securityGroupId: loadBalancer!.albSecurityGroupId,
        description: 'The load balancer, to a Domain of the stack',
      }),
    ),
    egress: [rule({ port: 0, protocol: '-1', cidr: '0.0.0.0/0' })],
  });

  if (input.imageId === null && !input.pins.image) {
    throw new Error(
      `${input.configName}'s Stack VM has no recorded image and no pinned one`,
    );
  }
  const instance = r.tagged('aws_instance', 'stack_vm', label('stack-vm'), {
    ami: input.imageId ?? '${data.aws_ami.ubuntu.id}',
    instance_type: input.machineType,
    subnet_id: network.privateSubnetIds[0],
    ...(input.zone ? { availability_zone: input.zone } : {}),
    associate_public_ip_address: false,
    vpc_security_group_ids: [ref(group, 'id')],
    iam_instance_profile: ref(profile, 'name'),
    user_data: stackVmCloudInit(input.pins, input.sshPublicKey),
    user_data_replace_on_change: false,
    metadata_options: { http_tokens: 'required', http_endpoint: 'enabled' },
    maintenance_options: { auto_recovery: 'default' },
    root_block_device: { volume_type: 'gp3', volume_size: 8, encrypted: true },
    // Read on its first boot only: a new Cloudgate's first boot is for
    // the next Stack VM, or an approved replace (`-replace`), never an
    // edit of this one.
    lifecycle: { ignore_changes: ['user_data'] },
  });

  // Tagged for its snapshot policy too, beside its mark.
  const disk = r.tagged(
    'aws_ebs_volume',
    'data',
    label('data'),
    {
      availability_zone: input.zone ?? ref(instance, 'availability_zone'),
      size: input.dataDiskGb,
      type: 'gp3',
      encrypted: true,
    },
    { [STACK_VM_DATA_TAG]: input.stateId },
  );
  r.untagged('aws_volume_attachment', 'data', {
    device_name: DATA_DISK_DEVICE,
    volume_id: ref(disk, 'id'),
    instance_id: ref(instance, 'id'),
    stop_instance_before_detaching: true,
  });

  const snapshots = r.tagged('aws_iam_role', 'snapshots', label('snapshots'), {
    name: `cloudgate-stack-vm-snapshots-${id}`,
    path: STACK_VM_IAM_PATH,
    description: "Cloudgate: a Stack VM data disk's daily snapshots",
    assume_role_policy: assumedBy('dlm.amazonaws.com'),
  });
  r.untagged('aws_iam_role_policy_attachment', 'snapshots', {
    role: ref(snapshots, 'name'),
    policy_arn: SNAPSHOT_POLICY,
  });
  r.tagged('aws_dlm_lifecycle_policy', 'snapshots', label('snapshots'), {
    // DLM takes letters, numbers, spaces, `-` and `_` only.
    description: `Cloudgate daily snapshots of the ${input.configName} data disk`,
    execution_role_arn: ref(snapshots, 'arn'),
    state: 'ENABLED',
    policy_details: {
      resource_types: ['VOLUME'],
      target_tags: { [STACK_VM_DATA_TAG]: input.stateId },
      schedule: [
        {
          name: 'daily',
          create_rule: { interval: 24, interval_unit: 'HOURS' },
          retain_rule: { count: input.snapshotDays },
          copy_tags: false,
        },
      ],
    },
  });

  const domainOutputs =
    domains && loadBalancer
      ? stackVmDomainResources(r, domains, ports, {
          loadBalancer,
          vpcId: network.vpcId,
          instance,
          label,
        })
      : {};

  const output = (value: unknown) => ({ value });
  return {
    pins: input.pins,
    definition: {
      ...frame(account, input.region, mark),
      ...(input.imageId === null
        ? {
            data: {
              aws_ami: {
                ubuntu: {
                  owners: [CANONICAL_ACCOUNT],
                  most_recent: true,
                  filter: [{ name: 'name', values: [input.pins.image] }],
                },
              },
            },
          }
        : {}),
      // Native last, over everything Cloudgate wrote.
      resource: layNativeAws(r.all(), input.native),
      output: {
        [STACK_VM_OUTPUTS.instanceId]: output(ref(instance, 'id')),
        [STACK_VM_OUTPUTS.privateIp]: output(ref(instance, 'private_ip')),
        [STACK_VM_OUTPUTS.imageId]: output(ref(instance, 'ami')),
        [STACK_VM_OUTPUTS.dataVolumeId]: output(ref(disk, 'id')),
        [STACK_VM_OUTPUTS.zone]: output(ref(instance, 'availability_zone')),
        ...domainOutputs,
      },
    },
  };
}

/**
 * A Stack VM's load balancer pieces: per published port a target group
 * whose one target is the Stack VM, and the Domain blocks a `web` has, each
 * rule forwarding to its port's group. Keyed by port, so a port no Domain
 * reaches any more is destroyed by the run that removes its last Domain.
 */
function stackVmDomainResources(
  r: Resources,
  domains: readonly StackVmDomain[],
  ports: readonly number[],
  on: {
    loadBalancer: StackVmLoadBalancer;
    vpcId: string;
    instance: string;
    label: (part: string) => string;
  },
): Record<string, { value: string }> {
  const byPort = Object.fromEntries(ports.map((port) => [String(port), port]));
  const tags = (address: string) => ({
    [TAG_KEYS.address]: addressTag(`${address}["\${each.key}"]`),
    Name: on.label('targets/${each.key}'),
  });
  r.untagged('aws_lb_target_group', 'stack_vm', {
    for_each: byPort,
    name_prefix: 'cg-',
    target_type: 'instance',
    protocol: 'HTTP',
    port: '${each.value}',
    vpc_id: on.vpcId,
    deregistration_delay: '30',
    health_check: { ...STACK_VM_HEALTH_CHECK },
    lifecycle: { create_before_destroy: true },
    tags: tags('aws_lb_target_group.stack_vm'),
  });
  // A target group attachment takes no tags.
  r.untagged('aws_lb_target_group_attachment', 'stack_vm', {
    for_each: byPort,
    target_group_arn: '${aws_lb_target_group.stack_vm[each.key].arn}',
    target_id: ref(on.instance, 'id'),
    port: '${each.value}',
  });
  return domainResources(r, domains, {
    listenerArn: on.loadBalancer.httpsListenerArn,
    targetGroup: (domain) =>
      `\${aws_lb_target_group.stack_vm["${domain.port}"].arn}`,
    label: on.label,
  });
}
