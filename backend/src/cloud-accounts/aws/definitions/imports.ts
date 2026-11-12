import type { TaggedResource, TofuShow } from '../../cloud.port';
import type { TofuResourceChange } from '../plan-reader/tofu-show.types';
import { addressTag, TAG_KEYS, tagAddress } from './tags';
import type { TofuDefinition } from '../../definitions/tofu-json';
import {
  DATA_DISK_DEVICE,
  SESSION_MANAGER_POLICY,
  SNAPSHOT_POLICY,
} from './stack-vm-definition';

/**
 * One resource a plan adopts: its address in the state and the ARN the tag
 * search found — or, for a resource with no ARN of its own (a route, a
 * route table association), the id it imports by.
 */
export interface Adoption {
  readonly address: string;
  readonly resourceType: string;
  readonly arn: string;
}

/** The network's untagged resources, each beside the tagged ones it joins. */
const ROUTE_TABLE = 'aws_route_table.public';
const ROUTE = 'aws_route.internet';
const ASSOCIATED_SUBNETS = ['public_a', 'public_b'] as const;
const REPOSITORY = 'aws_ecr_repository.service';
/** The network's NAT gateway route (`nat-gateway.ts`), once a Stack VM needs it. */
const PRIVATE_ROUTE_TABLE = 'aws_route_table.private';
const PRIVATE_ROUTE = 'aws_route.private_internet';
const LIFECYCLE_POLICY = 'aws_ecr_lifecycle_policy.service';

/**
 * What a state's tag search implies of the resources no tag can be put on
 * (ADR-0036 §6 "what a tag search cannot find is checked by id"),
 * as finds of that state with their address: the network's internet route
 * and its two route table associations, from the route table and the public
 * subnets found; a Service's ECR lifecycle policy, from its repository. Each
 * is made with the resource it joins and goes only with it, so a state lost
 * after an apply adopts them too rather than failing to make them twice. One
 * removed by hand since fails its import at Apply, naming it.
 */
export function joinedFinds(
  found: readonly TaggedResource[],
  stateId: string,
): TaggedResource[] {
  const at = (address: string) =>
    found.find((one) => tagAddress(one) === address);
  const idOf = (resource: TaggedResource) =>
    resource.arn.slice(resource.arn.lastIndexOf('/') + 1);
  const joined = (address: string, arn: string): TaggedResource => ({
    arn,
    tags: {
      [TAG_KEYS.address]: addressTag(address),
      [TAG_KEYS.state]: stateId,
    },
  });

  const out: TaggedResource[] = [];
  const table = at(ROUTE_TABLE);
  if (table) {
    out.push(joined(ROUTE, `${idOf(table)}_0.0.0.0/0`));
    for (const local of ASSOCIATED_SUBNETS) {
      const subnet = at(`aws_subnet.${local}`);
      if (subnet) {
        out.push(
          joined(
            `aws_route_table_association.${local}`,
            `${idOf(subnet)}/${idOf(table)}`,
          ),
        );
      }
    }
  }
  // The private subnets' route through the NAT gateway, and their
  // associations, from the private route table found.
  const privateTable = at(PRIVATE_ROUTE_TABLE);
  if (privateTable) {
    out.push(joined(PRIVATE_ROUTE, `${idOf(privateTable)}_0.0.0.0/0`));
    for (const local of ['private_a', 'private_b'] as const) {
      const subnet = at(`aws_subnet.${local}`);
      if (subnet) {
        out.push(
          joined(
            `aws_route_table_association.${local}`,
            `${idOf(subnet)}/${idOf(privateTable)}`,
          ),
        );
      }
    }
  }
  const repository = at(REPOSITORY);
  if (repository) out.push(joined(LIFECYCLE_POLICY, repository.arn));
  out.push(...stackVmJoined(at, idOf, joined));
  return out;
}

/**
 * A Stack VM's untaggable pieces, each made with what it joins
 * (ADR-0070): its data disk's attachment, from the instance and the disk;
 * its instance profile, named as its role is; and each role's managed
 * policy attachment, imported as `<role>/<policy ARN>`.
 */
function stackVmJoined(
  at: (address: string) => TaggedResource | undefined,
  idOf: (resource: TaggedResource) => string,
  joined: (address: string, arn: string) => TaggedResource,
): TaggedResource[] {
  const out: TaggedResource[] = [];
  const instance = at('aws_instance.stack_vm');
  const disk = at('aws_ebs_volume.data');
  if (instance && disk) {
    out.push(
      joined(
        'aws_volume_attachment.data',
        `${DATA_DISK_DEVICE}:${idOf(disk)}:${idOf(instance)}`,
      ),
    );
  }
  const role = at('aws_iam_role.stack_vm');
  if (role) {
    out.push(joined('aws_iam_instance_profile.stack_vm', idOf(role)));
    out.push(
      joined(
        'aws_iam_role_policy_attachment.session_manager',
        `${idOf(role)}/${SESSION_MANAGER_POLICY}`,
      ),
    );
  }
  const snapshots = at('aws_iam_role.snapshots');
  if (snapshots) {
    out.push(
      joined(
        'aws_iam_role_policy_attachment.snapshots',
        `${idOf(snapshots)}/${SNAPSHOT_POLICY}`,
      ),
    );
  }
  return out;
}

/** The network's namespace, imported by its id and its VPC's. */
const NAMESPACE_TYPE = 'aws_service_discovery_private_dns_namespace';
const VPC = 'aws_vpc.network';

/**
 * The adoptions with the network's private DNS namespace's import id
 * `<namespace-id>:<vpc-id>`, the form OpenTofu's AWS provider
 * imports one by, which no ARN carries. The VPC's id is the VPC the same
 * tag search found, in the same state. Every other adoption, and the
 * namespace when no VPC was found, is left as it was: that import then
 * fails at Apply, naming it.
 */
export function withNamespaceImportIds<T extends Adoption>(
  adopt: readonly T[],
  found: readonly TaggedResource[],
): T[] {
  const vpc = found.find((one) => tagAddress(one) === VPC);
  if (!vpc) return [...adopt];
  const idOf = (arn: string) => arn.slice(arn.lastIndexOf('/') + 1);
  return adopt.map((one) =>
    one.resourceType === NAMESPACE_TYPE && one.arn.startsWith('arn:')
      ? { ...one, arn: `${idOf(one.arn)}:${idOf(vpc.arn)}` }
      : one,
  );
}

/** The resources a plan would make, by address. */
function creates(show: TofuShow): TofuResourceChange[] {
  const changes = (show.resource_changes ?? []) as TofuResourceChange[];
  return changes.filter(
    (change) =>
      change.change.actions.length === 1 &&
      change.change.actions[0] === 'create',
  );
}

/**
 * {@link joinedFinds} the plan would make: one already in the state is
 * held there by its own id, so it is no find to adopt or note.
 */
export function joinedToCreate(
  show: TofuShow,
  found: readonly TaggedResource[],
  stateId: string,
): TaggedResource[] {
  const made = new Set(creates(show).map((change) => change.address));
  return joinedFinds(found, stateId).filter((one) =>
    made.has(tagAddress(one) ?? ''),
  );
}

/**
 * The IAM roles a plan would create, by address and name: what a tag search
 * cannot see (ADR-0036 §6), so each is looked up by name before the plan is
 * read, and adopted when it exists.
 */
export function rolesToCreate(
  show: TofuShow,
): { address: string; name: string }[] {
  return creates(show).flatMap((change) => {
    const after = change.change.after as { name?: unknown } | null | undefined;
    return change.type === 'aws_iam_role' && typeof after?.name === 'string'
      ? [{ address: change.address, name: after.name }]
      : [];
  });
}

/** A role found by name, as a find of this state at its address. */
export function roleFind(
  address: string,
  arn: string,
  stateId: string,
): TaggedResource {
  return {
    arn,
    tags: {
      [TAG_KEYS.address]: addressTag(address),
      [TAG_KEYS.state]: stateId,
    },
  };
}

/**
 * The id OpenTofu's AWS provider imports each taggable resource by, from the
 * ARN a tag search answers (the AWS spec "Recovery by tag"). The EC2
 * resources take their own id, the last part of the ARN; the load balancer
 * family, the task definition and certificates take the ARN itself; the rest
 * take their name. A type not listed is imported by its ARN — and so is a
 * route or a route table association, whose `arn` is already its import id
 * ({@link joinedFinds}).
 */
export function importId(resourceType: string, arn: string): string {
  const resource = arn.split(':').slice(5).join(':');
  switch (resourceType) {
    case 'aws_vpc':
    case 'aws_subnet':
    case 'aws_internet_gateway':
    case 'aws_route_table':
    case 'aws_security_group':
    case 'aws_instance':
    case 'aws_ebs_volume':
    case 'aws_dlm_lifecycle_policy':
    case 'aws_nat_gateway':
    case 'aws_eip':
      return resource.slice(resource.lastIndexOf('/') + 1);
    case 'aws_ecs_cluster':
    case 'aws_ecr_repository':
      // `cluster/<name>`, `repository/<name>`; a repository's name may hold
      // a `/` of its own.
      return resource.slice(resource.indexOf('/') + 1);
    case 'aws_ecr_lifecycle_policy':
      // Imported by its repository's name: {@link joinedFinds} hands the
      // repository's ARN.
      return resource.slice(resource.indexOf('/') + 1);
    case 'aws_iam_role':
      // `role/<path>/<name>` imports as the bare name: a role's name holds
      // no `/`, its path does (the task role's is `/cloudgate/`).
      return resource.slice(resource.lastIndexOf('/') + 1);
    case 'aws_ssm_parameter':
      // `parameter/cloudgate/…` imports as the name, `/cloudgate/…`, which
      // is the id the provider keeps in the state.
      return resource.slice('parameter'.length);
    case 'aws_ecs_service':
      // `service/<cluster>/<service>` imports as `<cluster>/<service>`.
      return resource.slice(resource.indexOf('/') + 1);
    case 'aws_s3_bucket':
      // `arn:aws:s3:::<name>`: no region, no account, just the name.
      return resource;
    case 'aws_codebuild_project':
      // `project/<name>` imports as the name.
      return resource.slice(resource.indexOf('/') + 1);
    case 'aws_cloudwatch_log_group':
      // `log-group:<name>`, sometimes with a trailing `:*`.
      return resource.replace(/^log-group:/, '').replace(/:\*$/, '');
    case NAMESPACE_TYPE:
      // Already `<namespace-id>:<vpc-id>` ({@link withNamespaceImportIds}).
      return arn;
    case 'aws_service_discovery_service':
      // `service/srv-…` imports as its id.
      return resource.slice(resource.lastIndexOf('/') + 1);
    default:
      return arn;
  }
}

/**
 * The definition with an `import` block for each adoption (OpenTofu 1.5+
 * config-driven import), so the Apply that approved an adopt line takes the
 * resource into its state instead of making a second one. A plan of it then
 * lists each as importing, which the plan reader shows as adopt again.
 */
export function withImports(
  definition: TofuDefinition,
  adoptions: readonly Adoption[],
): TofuDefinition {
  if (adoptions.length === 0) return definition;
  return {
    ...definition,
    import: adoptions.map((one) => ({
      to: one.address,
      id: importId(one.resourceType, one.arn),
    })),
  };
}
