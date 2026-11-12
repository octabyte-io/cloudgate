import { pairWording } from '../../../native/size-override';
import { valueAt } from './plan-values';
import {
  PRIVATE_DNS_COST,
  PRIVATE_DNS_NAMESPACE,
  privateHost,
} from '../definitions/private-dns';
import type { TofuResourceChange } from './tofu-show.types';
import { natCost } from '../definitions/nat-gateway';

/**
 * The plain words for one AWS change: what a person reads with
 * the raw lines folded away. Only the resources an operator would recognise
 * from their config get a line — the Service, its image, its variables, its
 * ECR repository and the network's load balancer (its idle cost). The rest
 * (subnets, rules, roles) are the raw lines' job; a summary that listed all
 * nineteen would be the raw lines again.
 */

export type StepAction = 'create' | 'change' | 'destroy' | 'replace';

export interface SummaryContext {
  readonly serviceName?: string;
  /** The region the plan is in, for a price the rate table has by region. */
  readonly region?: string;
  readonly sizeName?: string;
  /** No size: a database's class is its family's smallest. */
  readonly noSize?: boolean;
  /**
   * A database's class or node type its `native.aws` sets, which
   * wins over the size: its line says `set by native`.
   */
  readonly nativeMachine?: boolean;
  /**
   * The halves of a task's Fargate pair its `native.aws` sets,
   * each marked on its line: `2 vCPU (native) / 2 GB`.
   */
  readonly nativePair?: { readonly cpu: boolean; readonly memory: boolean };
  readonly imageRef?: string;
  /** The task definition's values in this plan, for the Service's Fargate pair. */
  readonly taskDefinition?: Readonly<Record<string, unknown>>;
}

/**
 * The network's idle cost, the only price a plan shows besides the
 * Advanced parameter's. It goes on the load balancer's create
 * because that is the one resource in the network's state every plan makes.
 */
export const NETWORK_IDLE_COST = 'about $24/month while idle';
const ADVANCED_PARAMETER_PRICE = 'Advanced parameter, $0.05/month';

function values(change: TofuResourceChange): Record<string, unknown> {
  const after = change.change.after;
  const before = change.change.before;
  const pick = after && typeof after === 'object' ? after : before;
  return (pick && typeof pick === 'object' ? pick : {}) as Record<
    string,
    unknown
  >;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A variable's name: the last segment of `/cloudgate/<env>/<service>/<NAME>`. */
export function variableName(change: TofuResourceChange): string {
  const name = text(values(change).name);
  if (name) return name.slice(name.lastIndexOf('/') + 1);
  const index = /\["(.*)"\]$/.exec(change.address);
  return index ? index[1] : change.name;
}

/** How a resource is named in a drift, adopt or summary line. */
export function resourceLabel(
  change: TofuResourceChange,
  context: Pick<SummaryContext, 'serviceName'>,
): string {
  const name = text(values(change).name) ?? change.name;
  switch (change.type) {
    case 'aws_ecs_service':
      return `ECS service \`${context.serviceName ?? name}\``;
    case 'aws_ssm_parameter':
      return `Variable \`${variableName(change)}\``;
    case 'aws_ecr_repository':
      return `ECR repository \`${name}\``;
    case 'aws_ecs_task_definition':
      return 'Task definition';
    case 'aws_s3_bucket':
      return `S3 bucket \`${text(values(change).bucket) ?? change.name}\``;
    case 'aws_s3_bucket_cors_configuration':
      return 'Browser uploads (CORS)';
    case 'aws_s3_bucket_public_access_block':
      return 'Block Public Access';
    case 'aws_s3_bucket_server_side_encryption_configuration':
      return 'Bucket encryption';
    case 'aws_s3_bucket_ownership_controls':
      return 'Object ownership (ACLs off)';
    case 'aws_s3_bucket_policy':
      return 'Bucket policy';
    case 'aws_cloudfront_origin_access_control':
      return 'Origin Access Control';
    case 'aws_cloudfront_function':
      return 'CloudFront function (index.html for a path ending in /)';
    case 'aws_cloudfront_distribution':
      return 'CloudFront distribution';
    case 'aws_iam_role_policy':
      return "Task role's bucket access";
    case 'aws_service_discovery_private_dns_namespace':
      return `Private DNS namespace \`${PRIVATE_DNS_NAMESPACE}\``;
    case 'aws_service_discovery_service':
      return `Private DNS name \`${privateHost(name)}\``;
    // A Compose stack's Stack VM (ADR-0070), by its stack's name.
    case 'aws_instance':
      return `Stack VM \`${context.serviceName ?? change.name}\``;
    case 'aws_ebs_volume':
      return `Stack VM data disk of \`${context.serviceName ?? change.name}\``;
    case 'aws_dlm_lifecycle_policy':
      return `Stack VM daily snapshots of \`${context.serviceName ?? change.name}\``;
    default:
      return `\`${change.address}\``;
  }
}

/**
 * `0.5 vCPU / 1 GB` from a task definition's `cpu` units and `memory` MB — the
 * pair AWS actually runs, read from the plan rather than recomputed from the
 * size name, so the line can never claim a pair the definition did not ask for.
 */
function fargatePair(
  taskDefinition: Readonly<Record<string, unknown>> | undefined,
  native: SummaryContext['nativePair'],
): string | undefined {
  const cpu = Number(taskDefinition?.cpu);
  const memory = Number(taskDefinition?.memory);
  if (!cpu || !memory) return undefined;
  return pairWording(
    { text: `${cpu / 1024} vCPU`, native: native?.cpu ?? false },
    { text: `${memory / 1024} GB`, native: native?.memory ?? false },
  );
}

function imageOf(change: TofuResourceChange): string | undefined {
  const definitions = values(change).container_definitions;
  if (typeof definitions !== 'string') return undefined;
  try {
    const parsed = JSON.parse(definitions) as { image?: unknown }[];
    return text(parsed[0]?.image);
  } catch {
    return undefined;
  }
}

export function summaryLine(
  change: TofuResourceChange,
  action: StepAction,
  context: SummaryContext,
): string | undefined {
  const label = resourceLabel(change, context);
  switch (change.type) {
    case 'aws_ecs_service': {
      if (action === 'destroy') return `${label}: destroy`;
      const parts: string[] = [action];
      if (action === 'replace') parts.push('brief downtime');
      const pair = fargatePair(context.taskDefinition, context.nativePair);
      if (pair) {
        parts.push(
          context.sizeName ? `\`${context.sizeName}\` → ${pair}` : pair,
        );
      }
      const tasks = values(change).desired_count;
      if (typeof tasks === 'number') {
        parts.push(`${tasks} ${tasks === 1 ? 'task' : 'tasks'}`);
      }
      return `${label}: ${parts.join(', ')}`;
    }
    case 'aws_ecs_task_definition': {
      if (action === 'destroy') return `${label}: destroy`;
      const verb = action === 'create' ? 'create' : 'new revision';
      const image = imageOf(change);
      if (context.imageRef && image === context.imageRef) {
        return `${label}: ${verb}, new image, built by this deploy`;
      }
      return image
        ? `${label}: ${verb}, image \`${image}\``
        : `${label}: ${verb}`;
    }
    case 'aws_ssm_parameter': {
      const verb = {
        create: 'added',
        change: 'value changed',
        destroy: 'removed',
        replace: 'replaced',
      }[action];
      const advanced =
        action !== 'destroy' &&
        valueAt(change.change.after, ['tier']) === 'Advanced';
      return advanced
        ? `${label}: ${verb} (${ADVANCED_PARAMETER_PRICE})`
        : `${label}: ${verb}`;
    }
    case 'aws_ecr_repository':
      return `${label}: ${action}`;
    case 'aws_s3_bucket':
      // The bucket a `bucket` entry is, by its real name.
      return action === 'create'
        ? `${label}: create, versioning off, S3's default encryption, Block Public Access on`
        : `${label}: ${action}`;
    case 'aws_s3_bucket_cors_configuration':
      return corsLine(change, action, label);
    // A `static` site's own pieces.
    case 'aws_s3_bucket_policy':
      return action === 'create' || action === 'replace'
        ? `${label}: ${action}, only its CloudFront distribution reads the bucket`
        : `${label}: ${action}`;
    case 'aws_cloudfront_origin_access_control':
      return action === 'create'
        ? `${label}: create, CloudFront signs every request to the bucket`
        : `${label}: ${action}`;
    case 'aws_cloudfront_function':
      return `${label}: ${action}`;
    case 'aws_cloudfront_distribution':
      return distributionLine(change, action, label);
    case 'aws_iam_role_policy':
      return bucketAccessLine(change, action, label);
    // A Private web service's private DNS: the network's namespace,
    // with its price, and each Service's own name in it.
    case 'aws_service_discovery_private_dns_namespace':
      return action === 'create'
        ? `${label}: create, for this Environment's Private web services, ${PRIVATE_DNS_COST}; kept until the Environment network goes`
        : `${label}: ${action}`;
    // A replace is followed by a new deployment of the ECS service, which
    // lists its running tasks in the new one.
    case 'aws_service_discovery_service':
      if (action === 'create') {
        return `${label}: create, one record per healthy task, reached from this Environment network only`;
      }
      return action === 'replace'
        ? `${label}: replace, its running tasks listed again by a new deployment`
        : `${label}: ${action}`;
    // A Stack VM's way out, made with the first one (`nat-gateway.ts`).
    case 'aws_nat_gateway':
      if (action === 'create') {
        return `NAT gateway: create, the Stack VMs' way out to the internet, ${natCost(context.region)}`;
      }
      return action === 'destroy'
        ? 'NAT gateway: remove'
        : `NAT gateway: ${action}`;
    case 'aws_lb':
      if (action === 'create')
        return `Environment network: create, ${NETWORK_IDLE_COST}`;
      if (action === 'destroy') return 'Environment network: remove';
      if (action === 'replace') {
        return 'Environment network: load balancer replaced, brief downtime';
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * A bucket's browser-upload origins, as its CORS resource moves: the
 * origins it will allow, or that none will once it is removed.
 */
function corsLine(
  change: TofuResourceChange,
  action: StepAction,
  label: string,
): string {
  if (action === 'destroy') return `${label}: removed, no origin may upload`;
  const rules = valueAt(change.change.after, ['cors_rule']);
  const origins = Array.isArray(rules)
    ? rules.flatMap((rule: unknown) => {
        const allowed = (rule as { allowed_origins?: unknown }).allowed_origins;
        return Array.isArray(allowed) ? allowed.filter(isText) : [];
      })
    : [];
  const listed = origins.length > 0 ? origins.join(', ') : 'none';
  return action === 'create'
    ? `${label}: allow ${listed}`
    : `${label}: ${action}, allow ${listed}`;
}

/**
 * A `static` site's distribution: on create, HTTPS only and how it
 * answers a missing path; on a change, its error responses when they move
 * (`spa`), which is what an operator changed in the config.
 */
function distributionLine(
  change: TofuResourceChange,
  action: StepAction,
  label: string,
): string {
  if (action === 'destroy') return `${label}: destroy`;
  const after = errorResponses(change.change.after);
  if (action === 'create') {
    return `${label}: create, HTTPS only, ${after}`;
  }
  const before = errorResponses(change.change.before);
  return before === after
    ? `${label}: ${action}`
    : `${label}: ${action}, ${after}`;
}

/** How the error responses answer: `spa`'s `/index.html`, or a 403 as a 404. */
function errorResponses(values: unknown): string {
  const listed = valueAt(values, ['custom_error_response']);
  // A set in the provider's schema: printed in no fixed order.
  const responses = Array.isArray(listed)
    ? [...(listed as Record<string, unknown>[])].sort(
        (a, b) => Number(a.error_code) - Number(b.error_code),
      )
    : [];
  if (responses.length === 0) return 'no error responses';
  return `error responses ${responses
    .map(
      (one) =>
        `${String(one.error_code)} → ${String(one.response_code)}${
          one.response_code === 200 || one.response_code === '200'
            ? ` ${String(one.response_page_path)}`
            : ''
        }`,
    )
    .join(', ')}`;
}

/**
 * A cloud Service's task role's access to the buckets it links, by
 * their real names: the buckets whose objects it may read and write, or
 * none once its last link goes.
 */
function bucketAccessLine(
  change: TofuResourceChange,
  action: StepAction,
  label: string,
): string {
  if (action === 'destroy') return `${label}: removed, it reaches no bucket`;
  const policy = valueAt(change.change.after, ['policy']);
  let buckets: string[] = [];
  try {
    const parsed = JSON.parse(typeof policy === 'string' ? policy : '') as {
      Statement?: { Resource?: unknown }[];
    };
    buckets = (parsed.Statement ?? []).flatMap((statement) =>
      Array.isArray(statement.Resource)
        ? statement.Resource.filter(isText).flatMap((arn) =>
            arn.endsWith('/*') ? [arn.slice('arn:aws:s3:::'.length, -2)] : [],
          )
        : [],
    );
  } catch {
    // Unknown until applied, or not JSON: the raw lines show it.
  }
  const named = buckets.map((name) => `\`${name}\``).join(', ');
  const what = named
    ? `read and write the objects of ${named}`
    : 'read and write the objects of the buckets it links';
  return action === 'create'
    ? `${label}: ${what}`
    : `${label}: ${action}, ${what}`;
}

function isText(value: unknown): value is string {
  return typeof value === 'string';
}
