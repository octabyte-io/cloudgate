import { valueAt } from '../../aws/plan-reader/plan-values';
import type { StepAction } from '../../aws/plan-reader/plan-lines';
import type { TofuResourceChange } from '../../aws/plan-reader/tofu-show.types';
import { GCP_NETWORK_ADDRESS_RANGE } from '../definitions/network-definition';
import { formatInstanceCount } from '../definitions/cloud-run-size';
import {
  PRIVATE_LINK_COST,
  PRIVATE_LINK_KINDS,
  PRIVATE_LINK_PRODUCT,
  SERVICE_CLASS,
} from '../definitions/private-link';
import {
  RUN_APP_DNS_NAME,
  RUN_APP_ZONE_COST,
  RUN_APP_ZONE_LABEL,
} from '../definitions/run-app-zone';
import {
  isStackVmFirewall,
  stackVmLabel,
  stackVmSummaryLine,
} from './stack-vm-lines';

/**
 * The plain words for one Google change, the twin of
 * the AWS reader's `plan-lines.ts`: a label for every `google_*` type the
 * network and web definitions make, and the summary line a person reads
 * with the raw lines folded away.
 *
 * The network's own pieces (subnet, fixed IP, forwarding rules, proxies, URL
 * maps, certificate map and its default entry) fold into one "Environment
 * network" line when the network itself is made or removed by the same plan;
 * any other change to one of them gets its own line.
 */

export interface GoogleSummaryContext {
  readonly serviceName?: string;
  readonly sizeName?: string;
  /** The image this deploy builds, shown as "new image, built by this deploy". */
  readonly imageRef?: string;
  /** The VPC is made or removed by this plan: its pieces fold into its line. */
  readonly networkMadeOrRemoved?: boolean;
  /** Variables whose secret is added or removed by this plan: its version and access fold into that line. */
  readonly secretsMadeOrRemoved?: ReadonlySet<string>;
  /** A Cloud SQL instance is made or removed by this plan: its user and database fold into its line. */
  readonly instanceMadeOrRemoved?: boolean;
  /** The plan holds a static site's Cloud CDN backend bucket: its bucket is the site's own. */
  readonly staticSite?: boolean;
  /** An Existing database's endpoint is made or removed: its address folds into its line. */
  readonly endpointMadeOrRemoved?: boolean;
  /** An Existing database's private zone is made or removed: its record folds into its line. */
  readonly zoneMadeOrRemoved?: boolean;
}

/**
 * What an Existing database's manual endpoint costs: one
 * Private Service Connect consumer endpoint, $0.01 an hour, as a Cloudgate
 * -made instance's address.
 */
export const PSC_ENDPOINT_COST = 'about $7.30/month';

/** What its private DNS zone costs: Cloud DNS's per-zone charge. */
export const PRIVATE_ZONE_COST = 'about $0.20/month';

/**
 * The network's idle cost (S5): the network is free, the global
 * load balancer is not. It goes on the VPC's create, the one resource every
 * network plan makes.
 */
export const NETWORK_IDLE_COST =
  '$0/month for the network, about $18/month while idle for the load balancer';

/**
 * The private link's subnet: a subnet of the network, but one of the
 * link's pieces, never folded into the network's line.
 */
export function isPrivateLinkSubnet(change: TofuResourceChange): boolean {
  return (
    change.type === 'google_compute_subnetwork' &&
    values(change).ip_cidr_range ===
      GCP_NETWORK_ADDRESS_RANGE.reserved.privateServiceConnect
  );
}

/**
 * The private link's pieces: its subnet, its service
 * connection policies, and Memorystore's firewall rule for Redis's ports
 * (a Stack VM's own firewall rule is its stack's, not the link's).
 */
export function isPrivateLinkPiece(change: TofuResourceChange): boolean {
  return (
    isPrivateLinkSubnet(change) ||
    change.type === 'google_network_connectivity_service_connection_policy' ||
    (change.type === 'google_compute_firewall' && !isStackVmFirewall(change))
  );
}

/** The Environment network's private `run.app` zone, by its DNS name. */
export function isRunAppZone(change: TofuResourceChange): boolean {
  return (
    change.type === 'google_dns_managed_zone' &&
    values(change).dns_name === RUN_APP_DNS_NAME
  );
}

/** The network's own pieces, which fold into the VPC's line on its create or remove. */
const NETWORK_PIECES = new Set([
  'google_compute_subnetwork',
  'google_compute_global_address',
  'google_compute_global_forwarding_rule',
  'google_compute_target_https_proxy',
  'google_compute_target_http_proxy',
  'google_compute_url_map',
  'google_certificate_manager_certificate_map',
]);

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

/**
 * The fixed name Google knows a resource by (S4): `name` for most kinds, the
 * id field a few kinds name instead. The name is the mark, so it is what a
 * find by name is matched on.
 */
export function fixedName(change: TofuResourceChange): string | undefined {
  const v = values(change);
  switch (change.type) {
    case 'google_artifact_registry_repository':
      return text(v.repository_id);
    case 'google_service_account':
      return text(v.account_id);
    case 'google_secret_manager_secret':
      return text(v.secret_id);
    case 'google_memorystore_instance':
      return text(v.instance_id);
    default:
      return text(v.name);
  }
}

/** A secret's `cloudgate-<service key>-<NAME>` id, or a path to it, less the Service's prefix (S1, S4). */
const SECRET_ID = /(?:^|\/)cloudgate-[a-z2-7]{12}-([^/]+)$/;

/**
 * The variable a secret, its version or its access grant holds: from the
 * secret's id where the plan knows it, otherwise from the resource's own
 * name in the definition (`["API_KEY"]` or `API_KEY`).
 */
export function variableName(change: TofuResourceChange): string {
  const v = values(change);
  for (const id of [v.secret_id, v.secret]) {
    const found = typeof id === 'string' ? SECRET_ID.exec(id) : null;
    if (found) return found[1];
  }
  const index = /\["(.*)"\]$/.exec(change.address);
  return index ? index[1] : change.name;
}

/** How a resource is named in a drift, adopt or summary line. */
export function resourceLabel(
  change: TofuResourceChange,
  context: Pick<GoogleSummaryContext, 'serviceName'>,
): string {
  const v = values(change);
  // A Stack VM's resources, by its stack's name, and the network's Cloud NAT.
  const stackVm = stackVmLabel(
    change,
    fixedName(change) ?? change.name,
    context.serviceName,
  );
  if (stackVm) return stackVm;
  const name = `\`${fixedName(change) ?? change.name}\``;
  switch (change.type) {
    case 'google_cloud_run_v2_service':
      return context.serviceName
        ? `Cloud Run service \`${context.serviceName}\``
        : `Cloud Run service ${name}`;
    // A Worker's.
    case 'google_cloud_run_v2_worker_pool':
      return context.serviceName
        ? `Cloud Run worker pool \`${context.serviceName}\``
        : `Cloud Run worker pool ${name}`;
    // A Cron service's.
    case 'google_cloud_run_v2_job':
      return context.serviceName
        ? `Cloud Run job \`${context.serviceName}\``
        : `Cloud Run job ${name}`;
    case 'google_artifact_registry_repository':
      return `Artifact Registry repository ${name}`;
    case 'google_service_account':
      return `Service account ${name}`;
    case 'google_secret_manager_secret':
    case 'google_secret_manager_secret_version':
      return `Variable \`${variableName(change)}\``;
    case 'google_secret_manager_secret_iam_member':
      return `Variable \`${variableName(change)}\` access`;
    case 'google_compute_region_network_endpoint_group':
      return `Serverless network endpoint group ${name}`;
    case 'google_compute_backend_service':
      return `Backend service ${name}`;
    case 'google_compute_network':
      return `VPC ${name}`;
    case 'google_compute_subnetwork':
      return isPrivateLinkSubnet(change)
        ? `Private link subnet ${name} (${GCP_NETWORK_ADDRESS_RANGE.reserved.privateServiceConnect})`
        : `Subnet ${name}`;
    case 'google_network_connectivity_service_connection_policy': {
      const kind = PRIVATE_LINK_KINDS.find(
        (one) => SERVICE_CLASS[one] === v.service_class,
      );
      return `Private link for ${kind ? PRIVATE_LINK_PRODUCT[kind] : (text(v.service_class) ?? 'a database')} (service connection policy ${name})`;
    }
    case 'google_sql_database_instance':
      return context.serviceName
        ? `Cloud SQL instance \`${context.serviceName}\``
        : `Cloud SQL instance ${name}`;
    case 'google_memorystore_instance':
      return context.serviceName
        ? `Memorystore instance \`${context.serviceName}\``
        : `Memorystore instance ${name}`;
    case 'google_compute_firewall':
      return `Private link firewall rule ${name} (${portsOf(v)})`;
    // A `bucket` on Cloud Storage or a static site's own:
    // the bucket by its real name; a bucket's key its own service account
    // holds, a static site's grant to the load balancer.
    case 'google_storage_bucket':
      return `Cloud Storage bucket ${name}`;
    case 'google_storage_bucket_iam_member':
      return isLoadBalancerGrant(v)
        ? "Load balancer's read access to the bucket"
        : "Bucket access for the bucket's own service account";
    case 'google_storage_hmac_key':
      return "Bucket key (HMAC) of the bucket's own service account";
    case 'google_sql_database':
      return `Database ${name}`;
    case 'google_sql_user':
      return `Database user ${name}`;
    case 'google_compute_global_address':
      return `Fixed IP address ${name}`;
    case 'google_compute_address':
      return `Private Service Connect endpoint address ${name}`;
    case 'google_compute_forwarding_rule':
      return `Private Service Connect endpoint ${name}`;
    case 'google_dns_managed_zone':
      // The network's own `run.app` zone, named as the plan says it.
      if (isRunAppZone(change)) return RUN_APP_ZONE_LABEL;
      return `Private DNS zone for \`${text(v.dns_name) ?? fixedName(change) ?? change.name}\``;
    case 'google_dns_record_set':
      return `DNS record \`${text(v.name) ?? change.name}\` (${text(v.type) ?? 'A'})`;
    case 'google_compute_global_forwarding_rule': {
      const port = text(v.port_range);
      return port
        ? `Forwarding rule ${name} (port ${port})`
        : `Forwarding rule ${name}`;
    }
    case 'google_compute_target_https_proxy':
      return `HTTPS proxy ${name}`;
    case 'google_compute_target_http_proxy':
      return `HTTP proxy ${name}`;
    case 'google_compute_url_map':
      return `URL map ${name}`;
    case 'google_certificate_manager_certificate_map':
      return `Certificate map ${name}`;
    case 'google_certificate_manager_certificate_map_entry': {
      const host = text(v.hostname);
      return host
        ? `Domain \`${host}\` certificate map entry`
        : 'Default certificate map entry';
    }
    case 'google_certificate_manager_certificate': {
      const domain = domainsOf(v)[0];
      return domain
        ? `Domain \`${domain}\` certificate`
        : 'Default certificate (self-signed)';
    }
    case 'google_certificate_manager_dns_authorization': {
      const domain = text(v.domain);
      return domain
        ? `Domain \`${domain}\` DNS authorization`
        : `DNS authorization ${name}`;
    }
    // What serves a static site's own bucket.
    case 'google_compute_backend_bucket':
      return `Cloud CDN backend bucket ${name}`;
    default:
      return `\`${change.address}\``;
  }
}

/** The load balancer's service agent's grant on a static site's bucket. */
function isLoadBalancerGrant(v: Record<string, unknown>): boolean {
  const member = text(v.member);
  return (
    member !== undefined && member.endsWith('@https-lb.iam.gserviceaccount.com')
  );
}

/** `TCP 6379, 11000–13047`: what a firewall rule lets through. */
function portsOf(v: Record<string, unknown>): string {
  const allowed = Array.isArray(v.allow) ? (v.allow as unknown[]) : [];
  return allowed
    .map((rule) => {
      const protocol = text(valueAt(rule, ['protocol'])) ?? 'all';
      const ports = valueAt(rule, ['ports']);
      const list = Array.isArray(ports)
        ? ports.filter(isText).map((port) => port.replace('-', '–'))
        : [];
      return list.length > 0
        ? `${protocol.toUpperCase()} ${list.join(', ')}`
        : protocol.toUpperCase();
    })
    .join('; ');
}

function domainsOf(v: Record<string, unknown>): string[] {
  const domains = valueAt(v, ['managed', '0', 'domains']);
  return Array.isArray(domains) ? domains.filter(isText) : [];
}

export function summaryLine(
  change: TofuResourceChange,
  action: StepAction,
  context: GoogleSummaryContext,
): string | undefined {
  const label = resourceLabel(change, context);
  // A Stack VM's resources, and the network's Cloud NAT (`null`: folded).
  const stackVm = stackVmSummaryLine(change, action, label);
  if (stackVm !== undefined) return stackVm ?? undefined;
  if (isPrivateLinkPiece(change)) {
    // Only Cloud SQL's policy brings a cost of its own: the DNS zone for
    // its instances' names.
    const cloudSql =
      change.type === 'google_network_connectivity_service_connection_policy' &&
      values(change).service_class === SERVICE_CLASS['cloud-sql'];
    return action === 'create'
      ? `${label}: create, ${cloudSql ? PRIVATE_LINK_COST : '$0/month'}`
      : `${label}: ${action}`;
  }
  if (
    (change.type === 'google_sql_database' ||
      change.type === 'google_sql_user') &&
    context.instanceMadeOrRemoved &&
    (action === 'create' || action === 'destroy')
  ) {
    return undefined;
  }
  // An Existing database's endpoint and zone: the address goes with
  // the rule, the record with the zone, when they are made or removed together.
  if (
    (change.type === 'google_compute_address' &&
      context.endpointMadeOrRemoved) ||
    (change.type === 'google_dns_record_set' && context.zoneMadeOrRemoved)
  ) {
    if (action === 'create' || action === 'destroy') return undefined;
  }
  if (NETWORK_PIECES.has(change.type) || isDefaultCertificatePiece(change)) {
    if (
      context.networkMadeOrRemoved &&
      (action === 'create' || action === 'destroy')
    ) {
      return undefined;
    }
  }
  switch (change.type) {
    case 'google_cloud_run_v2_service':
    case 'google_cloud_run_v2_worker_pool':
      return cloudRunLine(change, action, label, context);
    case 'google_cloud_run_v2_job':
      return cloudRunJobLine(change, action, label, context);
    case 'google_sql_database_instance':
      return cloudSqlLine(change, action, label);
    case 'google_memorystore_instance':
      return memorystoreLine(change, action, label);
    case 'google_storage_bucket':
      return context.staticSite
        ? staticBucketLine(change, action, label)
        : storageBucketLine(change, action, label);
    case 'google_storage_bucket_iam_member':
      if (isLoadBalancerGrant(values(change))) {
        return action === 'create'
          ? `${label}: create, only Google's load balancer reads its files`
          : `${label}: ${action}`;
      }
      return action === 'create' || action === 'replace'
        ? `${label}: ${action}, ${text(values(change).role) ?? 'a role'} on this bucket only`
        : `${label}: ${action}`;
    case 'google_storage_hmac_key':
      return action === 'create' || action === 'replace'
        ? `${label}: ${action}, shared by every Service that links the bucket`
        : `${label}: ${action}`;
    case 'google_compute_network':
      if (action === 'create')
        return `Environment network: create, ${NETWORK_IDLE_COST}`;
      if (action === 'destroy') return 'Environment network: remove';
      if (action === 'replace')
        return 'Environment network: VPC replaced, brief downtime';
      return `${label}: change`;
    case 'google_compute_global_address':
      return action === 'replace'
        ? `${label}: replace, the IP address changes, so every Domain's \`A\` record must change`
        : `${label}: ${action}`;
    case 'google_compute_url_map':
      return urlMapLine(change, action, label);
    case 'google_compute_backend_bucket':
      return backendBucketLine(change, action, label);
    case 'google_compute_forwarding_rule':
      return action === 'create' || action === 'replace'
        ? `${label}: ${action}, from the private link subnet (${GCP_NETWORK_ADDRESS_RANGE.reserved.privateServiceConnect}) to the existing instance's service attachment, ${PSC_ENDPOINT_COST}`
        : `${label}: ${action}`;
    case 'google_dns_managed_zone':
      // The private `run.app` zone of the network's Private web services
      // on the network step of the plan that first needs it.
      if (isRunAppZone(change)) {
        return action === 'create'
          ? `${label}: create, for this Environment's Private web services, ${RUN_APP_ZONE_COST}`
          : `${label}: ${action}`;
      }
      return action === 'create' || action === 'replace'
        ? `${label}: ${action}, private to the Environment network, with an A record to the endpoint, ${PRIVATE_ZONE_COST}`
        : `${label}: ${action}`;
    case 'google_secret_manager_secret': {
      const verb = {
        create: 'added',
        change: 'changed',
        destroy: 'removed',
        replace: 'replaced',
      }[action];
      return `${label}: ${verb}`;
    }
    case 'google_secret_manager_secret_version':
      if (context.secretsMadeOrRemoved?.has(variableName(change)))
        return undefined;
      return action === 'destroy'
        ? `${label}: old value removed`
        : `${label}: value changed`;
    case 'google_secret_manager_secret_iam_member':
      if (context.secretsMadeOrRemoved?.has(variableName(change)))
        return undefined;
      return action === 'destroy'
        ? `${label}: the Service's own service account no longer reads it`
        : `${label}: ${action}, only the Service's own service account reads it`;
    case 'google_certificate_manager_certificate':
      return domainsOf(values(change)).length > 0 && action === 'create'
        ? `${label}: create, Google-managed, live once its DNS records are made`
        : `${label}: ${action}`;
    default:
      return `${label}: ${action}`;
  }
}

/** The self-signed certificate and its map entry: the map's main entry, part of the network. */
function isDefaultCertificatePiece(change: TofuResourceChange): boolean {
  const v = values(change);
  if (change.type === 'google_certificate_manager_certificate_map_entry')
    return text(v.hostname) === undefined;
  if (change.type === 'google_certificate_manager_certificate')
    return domainsOf(v).length === 0;
  return false;
}

/**
 * A Cloud Run service: on create its real CPU/memory pair
 * beside the size name, how CPU is billed and its copy range; on a change
 * the pair and the billing only when they move, and the image when it does.
 */
function cloudRunLine(
  change: TofuResourceChange,
  action: StepAction,
  label: string,
  context: GoogleSummaryContext,
): string {
  if (action === 'destroy') return `${label}: destroy`;
  const { before, after } = change.change;
  const container = ['template', '0', 'containers', '0'];
  const resources = [...container, 'resources', '0'];
  const parts: string[] = [action];
  if (action === 'replace') parts.push('brief downtime');

  const pair = cloudRunPair(valueAt(after, [...resources, 'limits']));
  const pairMoved =
    action === 'create' ||
    pair !== cloudRunPair(valueAt(before, [...resources, 'limits']));
  if (pair && pairMoved) {
    parts.push(context.sizeName ? `\`${context.sizeName}\` → ${pair}` : pair);
  }
  const idle = valueAt(after, [...resources, 'cpu_idle']);
  if (
    typeof idle === 'boolean' &&
    (action === 'create' ||
      idle !== valueAt(before, [...resources, 'cpu_idle']))
  ) {
    parts.push(idle ? 'CPU only during requests' : 'CPU always on');
  }
  // A Worker's worker pool: CPU always on, its only billing, and
  // the instance count its create writes; nothing routes to it.
  const pool = change.type === 'google_cloud_run_v2_worker_pool';
  if (pool && action === 'create') {
    parts.push('CPU always on');
    const count = valueAt(after, ['scaling', '0', 'manual_instance_count']);
    if (typeof count === 'number') {
      parts.push(`${formatInstanceCount(count)}, no ingress`);
    }
  }
  if (action === 'create' && !pool) {
    const min = valueAt(after, [
      'template',
      '0',
      'scaling',
      '0',
      'min_instance_count',
    ]);
    const max = valueAt(after, [
      'template',
      '0',
      'scaling',
      '0',
      'max_instance_count',
    ]);
    if (typeof min === 'number' && typeof max === 'number')
      parts.push(`${min}–${max} copies`);
    // A Private web service: nothing outside its Environment.
    if (valueAt(after, ['ingress']) === 'INGRESS_TRAFFIC_INTERNAL_ONLY') {
      parts.push('reached only from this Environment');
    }
  }
  const image = text(valueAt(after, [...container, 'image']));
  if (
    action !== 'create' &&
    image &&
    image !== valueAt(before, [...container, 'image'])
  ) {
    parts.push(
      context.imageRef && image === context.imageRef
        ? 'new image, built by this deploy'
        : `image \`${image}\``,
    );
  }
  // Each variable is read by its secret's version number (S1): one added,
  // removed or given a new value (its version not known until the apply,
  // so missing from `after`) moves the container's `env`.
  const env = [...container, 'env'];
  if (
    action !== 'create' &&
    JSON.stringify(valueAt(before, env) ?? []) !==
      JSON.stringify(valueAt(after, env) ?? [])
  ) {
    parts.push('variables changed, a new revision rolls out');
  }
  return `${label}: ${parts.join(', ')}`;
}

/**
 * A Cron service's Cloud Run job: on create its CPU/memory pair
 * beside the size name and that each run is one execution, one task never
 * retried, which Cloudgate's timetable starts, so nothing runs or bills
 * until one does; on a change the pair when it moves, its command and args
 * when they do (the Google Cloud kinds spec), the image and the variables. Its
 * timetable and `timeout` are Cloudgate's, never in the job.
 */
function cloudRunJobLine(
  change: TofuResourceChange,
  action: StepAction,
  label: string,
  context: GoogleSummaryContext,
): string {
  if (action === 'destroy') return `${label}: destroy`;
  const { before, after } = change.change;
  const container = ['template', '0', 'template', '0', 'containers', '0'];
  const limits = [...container, 'resources', '0', 'limits'];
  const parts: string[] = [action];
  const pair = cloudRunPair(valueAt(after, limits));
  if (
    pair &&
    (action === 'create' || pair !== cloudRunPair(valueAt(before, limits)))
  ) {
    parts.push(context.sizeName ? `\`${context.sizeName}\` → ${pair}` : pair);
  }
  if (action === 'create') {
    parts.push(
      "one task, no retries, each run an execution Cloudgate's timetable starts",
    );
    return `${label}: ${parts.join(', ')}`;
  }
  const moved = (key: string) =>
    JSON.stringify(valueAt(before, [...container, key]) ?? null) !==
    JSON.stringify(valueAt(after, [...container, key]) ?? null);
  for (const key of ['command', 'args']) {
    const now = valueAt(after, [...container, key]);
    if (moved(key)) {
      parts.push(
        Array.isArray(now) && now.length > 0
          ? `${key} \`${now.join(' ')}\``
          : `no ${key}`,
      );
    }
  }
  const image = text(valueAt(after, [...container, 'image']));
  if (image && moved('image')) {
    parts.push(
      context.imageRef && image === context.imageRef
        ? 'new image, built by this deploy'
        : `image \`${image}\``,
    );
  }
  if (moved('env')) parts.push('variables changed, the next run reads them');
  return `${label}: ${parts.join(', ')}`;
}

/**
 * What a Cloud Storage bucket costs while it holds nothing: Cloud
 * Storage bills stored data and requests by use, and nothing for an empty
 * bucket.
 */
export const STORAGE_BUCKET_COST =
  '$0/month while empty, then storage and requests by use';

/**
 * A Cloud Storage bucket, read from the plan rather than the
 * config: on create every setting Cloudgate always writes, when the plan
 * carries it (soft delete off, uniform access, public access prevented), its
 * browser-upload origins and its cost; on a change its origins when they
 * move, the AWS bucket's CORS line's words.
 */
function storageBucketLine(
  change: TofuResourceChange,
  action: StepAction,
  label: string,
): string {
  if (action === 'destroy') return `${label}: destroy`;
  const { before, after } = change.change;
  const parts: string[] = [action];
  if (action === 'create' || action === 'replace') {
    if (
      valueAt(after, [
        'soft_delete_policy',
        '0',
        'retention_duration_seconds',
      ]) === 0
    ) {
      parts.push('soft delete off');
    }
    if (valueAt(after, ['uniform_bucket_level_access']) === true) {
      parts.push('uniform access');
    }
    if (valueAt(after, ['public_access_prevention']) === 'enforced') {
      parts.push('public access prevented');
    }
  }
  const origins = corsOrigins(after);
  // On a create only when it trusts an origin: none is Cloud Storage's own.
  if (
    action === 'create'
      ? origins.length > 0
      : origins.join() !== corsOrigins(before).join()
  ) {
    const listed =
      origins.length > 0
        ? origins.map((one) => `\`${one}\``).join(', ')
        : 'no origin';
    parts.push(`browser uploads from ${listed}`);
  }
  if (action === 'create') parts.push(STORAGE_BUCKET_COST);
  return `${label}: ${parts.join(', ')}`;
}

/** The origins a bucket's CORS rules trust, as the plan prints them. */
function corsOrigins(value: unknown): string[] {
  const rules = valueAt(value, ['cors']);
  return Array.isArray(rules)
    ? rules.flatMap((rule: unknown) => {
        const origin = (rule as { origin?: unknown }).origin;
        return Array.isArray(origin) ? origin.filter(isText) : [];
      })
    : [];
}

/**
 * A Cloud SQL instance, read from the plan rather than the
 * config, so the line never claims what the definition did not ask for: on
 * create its machine, version, edition, how it takes connections and its
 * CA; on a change the machine or version when they move.
 */
function cloudSqlLine(
  change: TofuResourceChange,
  action: StepAction,
  label: string,
): string {
  if (action === 'destroy') {
    return `${label}: destroy, with its private address`;
  }
  const { before, after } = change.change;
  const settings = ['settings', '0'];
  const ip = [...settings, 'ip_configuration', '0'];
  const parts: string[] = [action];
  if (action === 'replace') parts.push('brief downtime');
  const tier = text(valueAt(after, [...settings, 'tier']));
  const version = text(valueAt(after, ['database_version']));
  if (action === 'create' || action === 'replace') {
    if (tier) parts.push(tier);
    if (version) parts.push(version);
    const edition = text(valueAt(after, [...settings, 'edition']));
    if (edition === 'ENTERPRISE') parts.push('Enterprise edition');
    else if (edition) parts.push(`${edition} edition`);
    const sslMode = valueAt(after, [...ip, 'ssl_mode']);
    if (sslMode === 'ENCRYPTED_ONLY') {
      parts.push('encrypted connections only');
    } else if (sslMode === 'ALLOW_UNENCRYPTED_AND_ENCRYPTED') {
      // A mysql's: its `url` names no TLS.
      parts.push('TLS offered, not required');
    }
    if (
      valueAt(after, [...ip, 'server_ca_mode']) === 'GOOGLE_MANAGED_INTERNAL_CA'
    ) {
      parts.push('its own CA');
    }
    if (valueAt(after, [...ip, 'ipv4_enabled']) === false) {
      parts.push('no public IP');
    }
    if (pscConfig(after, 'psc_auto_dns_enabled') === true) {
      parts.push('a private DNS name through the private link');
    }
    return `${label}: ${parts.join(', ')}`;
  }
  const tierBefore = text(valueAt(before, [...settings, 'tier']));
  if (tier && tierBefore && tier !== tierBefore) {
    parts.push(`${tierBefore} → ${tier}`);
  }
  const versionBefore = text(valueAt(before, ['database_version']));
  if (version && versionBefore && version !== versionBefore) {
    parts.push(`${versionBefore} → ${version}`);
  }
  return `${label}: ${parts.join(', ')}`;
}

/**
 * A Memorystore for Valkey instance, read from the plan rather
 * than the config, as a Cloud SQL one is: on create its node type, Valkey
 * version and node count, and every setting the spec has Cloudgate always
 * write (cluster mode off, no password and so only its Environment's
 * private network reaching it, TLS with its own CA, `noeviction`, no
 * deletion protection) only when the plan carries it; on a change the
 * node type, version or node count when they move, each in place.
 */
function memorystoreLine(
  change: TofuResourceChange,
  action: StepAction,
  label: string,
): string {
  if (action === 'destroy') {
    return `${label}: destroy, with its two private addresses`;
  }
  const { before, after } = change.change;
  const parts: string[] = [action];
  if (action === 'replace') parts.push('brief downtime');
  const nodeType = text(valueAt(after, ['node_type']));
  const version = text(valueAt(after, ['engine_version']));
  const nodes = (value: unknown) => {
    const replicas = valueAt(value, ['replica_count']);
    return typeof replicas === 'number' ? replicas + 1 : undefined;
  };
  const counted = (count: number) =>
    `${count} ${count === 1 ? 'node' : 'nodes'}`;
  if (action === 'create' || action === 'replace') {
    if (nodeType) parts.push(nodeType);
    if (version) parts.push(version);
    const count = nodes(after);
    if (count !== undefined) parts.push(counted(count));
    if (valueAt(after, ['mode']) === 'CLUSTER_DISABLED') {
      parts.push('cluster mode off');
    }
    const tls =
      valueAt(after, ['transit_encryption_mode']) === 'SERVER_AUTHENTICATION'
        ? valueAt(after, ['server_ca_mode']) ===
          'GOOGLE_MANAGED_PER_INSTANCE_CA'
          ? 'TLS with its own CA'
          : 'TLS'
        : null;
    // No password (ADR-0042): what keeps others out is said instead.
    if (valueAt(after, ['authorization_mode']) === 'AUTH_DISABLED') {
      parts.push(
        `no password: only this Environment's private network reaches it${tls ? `, over ${tls}` : ''}`,
      );
    } else if (tls) {
      parts.push(tls);
    }
    const eviction = text(
      valueAt(after, ['engine_configs', 'maxmemory-policy']),
    );
    if (eviction) parts.push(`maxmemory-policy ${eviction}`);
    if (valueAt(after, ['deletion_protection_enabled']) === false) {
      parts.push('no deletion protection');
    }
    return `${label}: ${parts.join(', ')}`;
  }
  const nodeTypeBefore = text(valueAt(before, ['node_type']));
  if (nodeType && nodeTypeBefore && nodeType !== nodeTypeBefore) {
    parts.push(`${nodeTypeBefore} → ${nodeType}`);
  }
  const versionBefore = text(valueAt(before, ['engine_version']));
  if (version && versionBefore && version !== versionBefore) {
    parts.push(`${versionBefore} → ${version}`);
  }
  const count = nodes(after);
  const countBefore = nodes(before);
  if (
    count !== undefined &&
    countBefore !== undefined &&
    count !== countBefore
  ) {
    parts.push(`${counted(countBefore)} → ${counted(count)}`);
  }
  if (parts.length > 1) parts.push('in place');
  return `${label}: ${parts.join(', ')}`;
}

/**
 * What a static site's bucket and backend bucket cost (the Google Cloud
 * buckets spec): nothing fixed; storage, operations and Cloud CDN's traffic are
 * charged by use, which the plan's note says once.
 */
export const STATIC_FIXED_COST = '$0/month fixed';

/**
 * A Cloud Storage bucket, read from the plan: on create its cost and
 * what keeps it private and its deleted files gone, only when the plan
 * carries them.
 */
function staticBucketLine(
  change: TofuResourceChange,
  action: StepAction,
  label: string,
): string {
  if (action !== 'create' && action !== 'replace') return `${label}: ${action}`;
  const after = change.change.after;
  const parts: string[] = [action, STATIC_FIXED_COST];
  if (valueAt(after, ['public_access_prevention']) === 'enforced') {
    parts.push('private (public access prevention enforced)');
  }
  const retention = valueAt(after, [
    'soft_delete_policy',
    '0',
    'retention_duration_seconds',
  ]);
  if (retention === 0) parts.push('soft delete off');
  return `${label}: ${parts.join(', ')}`;
}

/**
 * A Cloud CDN backend bucket, read from the plan: on create its cost
 * and how it caches — every file at the edge, browsers told to check back
 * every time, negative caching off — only when the plan carries them.
 */
function backendBucketLine(
  change: TofuResourceChange,
  action: StepAction,
  label: string,
): string {
  if (action !== 'create' && action !== 'replace') return `${label}: ${action}`;
  const policy = ['cdn_policy', '0'];
  const after = change.change.after;
  const parts: string[] = [action, STATIC_FIXED_COST];
  if (valueAt(after, [...policy, 'cache_mode']) === 'FORCE_CACHE_ALL') {
    parts.push('every file cached at the edge');
  }
  if (valueAt(after, [...policy, 'client_ttl']) === 0) {
    parts.push('browsers check back every time');
  }
  if (valueAt(after, [...policy, 'negative_caching']) === false) {
    parts.push('negative caching off');
  }
  return `${label}: ${parts.join(', ')}`;
}

/** One field of an instance's PSC config, a set the plan prints as a list. */
function pscConfig(value: unknown, field: string): unknown {
  const configs = valueAt(value, [
    'settings',
    '0',
    'ip_configuration',
    '0',
    'psc_config',
  ]);
  if (!Array.isArray(configs) || configs.length === 0) return undefined;
  const first: unknown = configs[0];
  return first && typeof first === 'object'
    ? (first as Record<string, unknown>)[field]
    : undefined;
}

/**
 * A Cloud SQL or Memorystore instance's own private address, made by Google
 * with it on the private link's subnet: the line listed
 * under its database, or nothing when the instance takes none.
 */
export function privateAddressLine(
  change: TofuResourceChange,
  action: StepAction,
  serviceName: string | undefined,
): string | undefined {
  if (action !== 'create' && action !== 'replace') return undefined;
  const connections =
    change.type === 'google_sql_database_instance'
      ? pscConfig(change.change.after, 'psc_auto_connections')
      : change.type === 'google_memorystore_instance'
        ? valueAt(change.change.after, ['desired_auto_created_endpoints'])
        : undefined;
  if (!Array.isArray(connections) || connections.length === 0) {
    return undefined;
  }
  const who = serviceName ? `\`${serviceName}\`` : 'Its';
  // Each is a Private Service Connect endpoint, billed $0.01 an hour (the Cloud
  // Billing catalog's "Private Service Connect Consumer End Point", read in the
  // live walk). Memorystore makes two per instance, a
  // primary and a reader; Cloud SQL one.
  const memorystore = change.type === 'google_memorystore_instance';
  return memorystore
    ? `${who} private addresses (primary and reader): ${action}, made by Google with the instance on the private link subnet (${GCP_NETWORK_ADDRESS_RANGE.reserved.privateServiceConnect}), about $14.60/month`
    : `${who} private address: ${action}, made by Google with the instance on the private link subnet (${GCP_NETWORK_ADDRESS_RANGE.reserved.privateServiceConnect}), about $7.30/month`;
}

/**
 * `1 CPU / 512 MB` from a container's limits as Cloud Run takes them
 * (`"1"` or `"1000m"`, `"512Mi"` or `"1Gi"`), read from the plan rather than
 * recomputed from the size name, so the line never claims a pair the
 * definition did not ask for.
 */
function cloudRunPair(limits: unknown): string | undefined {
  const cpu = cpuCount(valueAt(limits, ['cpu']));
  const memory = memoryText(valueAt(limits, ['memory']));
  if (cpu === undefined || !memory) return undefined;
  return `${cpu} CPU / ${memory}`;
}

function cpuCount(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const milli = /^(\d+)m$/.exec(value);
  const count = milli ? Number(milli[1]) / 1000 : Number(value);
  return Number.isFinite(count) && count > 0 ? count : undefined;
}

function memoryText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const found = /^(\d+(?:\.\d+)?)(Mi|Gi|M|G)$/.exec(value);
  if (!found) return undefined;
  const amount = Number(found[1]);
  const mebibytes = found[2].startsWith('G') ? amount * 1024 : amount;
  return mebibytes >= 1024 && mebibytes % 1024 === 0
    ? `${mebibytes / 1024} GB`
    : `${mebibytes} MB`;
}

/** The main URL map's host rules: the Domains it answers for once applied. */
function urlMapLine(
  change: TofuResourceChange,
  action: StepAction,
  label: string,
): string {
  if (action === 'destroy') return `${label}: destroy`;
  const hosts = (value: unknown) => {
    const rules = valueAt(value, ['host_rule']);
    return Array.isArray(rules)
      ? rules
          .flatMap((rule: unknown) => {
            const listed = (rule as { hosts?: unknown }).hosts;
            return Array.isArray(listed) ? listed.filter(isText) : [];
          })
          .sort()
      : [];
  };
  const after = hosts(change.change.after);
  const before = hosts(change.change.before);
  if (action !== 'create' && after.join() === before.join())
    return `${label}: ${action}`;
  const listed =
    after.length > 0
      ? `host rules for ${after.map((host) => `\`${host}\``).join(', ')}`
      : 'no host rules';
  return `${label}: ${action}, ${listed}`;
}

function isText(value: unknown): value is string {
  return typeof value === 'string';
}
