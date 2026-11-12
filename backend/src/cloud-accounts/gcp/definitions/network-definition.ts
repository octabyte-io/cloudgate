import { DEFAULT_CERTIFICATE_HOST } from '../../definitions/default-certificate';
import { DEFAULT_CERTIFICATE_VARIABLES } from '../../definitions/default-certificate';
import { literal, ref } from '../../definitions/tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';
import {
  BUILD_SOURCE_MAX_AGE_DAYS,
  buildPieceNames,
} from '../cloud-build-names';
import { markDescription, stateLabels } from './mark';
import {
  domainCertificateName,
  domainName,
  networkName,
  serviceName,
} from './names';
import type { NetworkPart } from './names';
import { joinedLinks, REDIS_PORTS, SERVICE_CLASS } from './private-link';
import type { PrivateLinkKind } from './private-link';
import type { NetworkLinkKind } from '../../definitions/network-links';
import {
  PRIVATE_GOOGLE_ACCESS_ADDRESSES,
  RUN_APP_DNS_NAME,
  RUN_APP_RECORD_TTL_SECONDS,
} from './run-app-zone';
import {
  backendBucketPath,
  backendServicePath,
  frame,
  LOAD_BALANCING_SCHEME,
} from './tofu-json';
import { LIVE_PREFIX } from './static-definition';

/**
 * The address plan of every Google Environment network (the Google Cloud spec, S6).
 * Each Environment has its own VPC and nothing peers them, so all use the
 * same ranges, clear of Google's auto-mode `10.128.0.0/9`.
 *
 * `subnet` is the Services' own. `privateServiceConnect` is the private
 * link's subnet, written only once a database has needed it,
 * where Google puts each database's own address. The fallback range is kept
 * free and documented here, and no definition writes it: a possible
 * private-services-access range for Postgres should PSC not serve.
 */
export const GCP_NETWORK_ADDRESS_RANGE = {
  subnet: '10.64.0.0/20',
  reserved: {
    privateServiceConnect: '10.64.16.0/24',
    privateServicesAccessFallback: '10.64.32.0/20',
  },
} as const;

/**
 * The outputs the network's Apply saves on the Environment network row
 * what a Service's definition and a Domain's records need.
 */
export const GCP_NETWORK_OUTPUTS = {
  networkName: 'network_name',
  subnetName: 'subnet_name',
  ipAddress: 'ip_address',
  urlMapName: 'url_map_name',
  certificateMapName: 'certificate_map_name',
} as const;

/** One Domain on the Environment's load balancer. */
export interface GcpNetworkDomain {
  readonly domainId: string;
  /** The host name, as the operator wrote it. */
  readonly host: string;
  /**
   * The Domain's path; `/` takes the whole host. Any other path is routed
   * with its sub-paths, and the rest of the host goes nowhere, as an
   * unknown host does. A host is one Domain's on Google Cloud: its map
   * entry is the host's one certificate.
   */
  readonly path: string;
  /**
   * Which certificate of the Domain is current (Ask again, a new host), as
   * on AWS: a new one is a new certificate and map entry, under a
   * new name, while its DNS authorization, and so the operator's CNAME,
   * stays.
   */
  readonly attempt: number;
  /** The Service whose backend service, or backend bucket, the host is routed to. */
  readonly serviceId: string;
  /**
   * The backend service's own name, when it is not the Service's: a
   * Compose stack's Stack VM has one per port its Domains reach
   * (`stackVmBackendName`, #1371).
   */
  readonly backend?: string;
  /**
   * Set when that Service is a `static` site: the host goes to its
   * Cloud CDN backend bucket, its `/` rewritten to the fixed `live/`
   * folder, and under `spa` a missing page answers the shell. Absent for a
   * Service on Cloud Run.
   */
  readonly site?: { readonly spa: boolean };
}

export interface GcpNetworkDefinitionInput {
  /** Cloudgate's id of the Cloud account, for the mark. */
  readonly cloudAccountId: string;
  /** The Google Cloud project the Cloud account connects. */
  readonly projectId: string;
  readonly region: string;
  readonly environmentId: string;
  /** The network's Infrastructure state. */
  readonly stateId: string;
  /** Every Domain of every Service in the Environment. */
  readonly domains: readonly GcpNetworkDomain[];
  /**
   * The kinds of private link the network holds: the row's, and
   * those a plan's network step adds. Empty for a network no database has
   * needed, which then has none of the link's pieces; and the private
   * `run.app` zone once a Private web service has needed it.
   * Another cloud's kinds are not written here.
   */
  readonly privateLinks: readonly NetworkLinkKind[];
  /**
   * The standing piece of a hosted cloud build (ADR-0047): true on
   * the Hosted instance, whose cloud Services build in Cloud Build in the
   * Cloud account's project, and false or absent on a Self-hosted one, which
   * builds on its platform host and makes none of it.
   */
  readonly cloudBuilds?: boolean;
}

/** The address of a hosted cloud build's source bucket. */
export const GCP_BUILD_SOURCE_ADDRESS = 'google_storage_bucket.build_source';

/**
 * The three Domain blocks, each one resource over every Domain
 * (`for_each`, keyed by the Domain's id), as on AWS: a Domain's own
 * Cloud run can target the blocks, and a Domain no longer given is destroyed.
 */
export const GCP_DOMAIN_ADDRESSES: readonly string[] = [
  'google_certificate_manager_dns_authorization.domain',
  'google_certificate_manager_certificate.domain',
  'google_certificate_manager_certificate_map_entry.domain',
];

/**
 * What a Domain's own network run applies (`-target`): the
 * three Domain blocks and the URL map that holds every Domain's host rule.
 */
export const GCP_DOMAIN_RUN_ADDRESSES: readonly string[] = [
  ...GCP_DOMAIN_ADDRESSES,
  'google_compute_url_map.network',
];

/**
 * The output a Domain's run reads each certificate from, by Domain id: its
 * full name and the CNAME its DNS authorization asks for.
 */
export const GCP_DOMAIN_CERTIFICATES_OUTPUT = 'domain_certificates';

/**
 * The OpenTofu definition of a Google Environment network's state (the Google
 * Cloud spec, "The Environment network"). Pure: no Google call, no
 * `tofu`.
 *
 * It holds a custom-mode VPC with one subnet, `10.64.0.0/20`, with Private
 * Google Access on, and the Environment's load balancer: a fixed global IP,
 * a forwarding rule on 443 to the HTTPS proxy, and one on 80 to an HTTP
 * proxy whose URL map redirects everything to 443. The HTTPS proxy serves
 * from a certificate map whose main entry is a self-signed certificate made
 * by Cloudgate (`default-certificate.ts`, passed as variables as on AWS), so
 * no Domain is special. The main URL map holds every Domain's host rule,
 * since Google keeps all of them in that one object, and each Domain has its
 * DNS authorization, Google-managed certificate and map entry here too.
 *
 * **No NAT and no router** until a Stack VM needs one: Cloud Run reaches
 * the internet through Google directly (`private-ranges-only`), and a
 * custom-mode VPC has no firewall rule until one is made. The first Stack
 * VM adds a Cloud Router and its Cloud NAT (`cloud-nat` among
 * `privateLinks`, `cloud-nat.ts`): it has no external IP.
 *
 * **The private link**, once a database has needed it: the
 * subnet `10.64.16.0/24` and, per kind linked, a service connection policy
 * on it, through which Google gives each instance of that kind its own
 * address there when the instance is made; Memorystore's comes with the
 * one firewall rule, for Redis's ports. A web-only network has none
 * of it.
 *
 * **The private `run.app` zone** (`run-app-zone.ts`), once a
 * Private web service has needed it: a private Cloud DNS zone for
 * `run.app.` bound to the VPC, with `*.run.app` and `run.app` A records to
 * `private.googleapis.com`'s four addresses. Kept after the last Private
 * web service goes, until the network does. Still no NAT and no router:
 * `private-ranges-only` egress and the subnet's Private Google Access carry
 * it. A network with none has none of it.
 *
 * A host no Domain's rule takes is redirected to `cloudgate.invalid`, which
 * no resolver answers: a URL map cannot answer 404 by itself, and needs a
 * backend or a redirect as its default; the network has no backend of its
 * own.
 */
export function networkDefinition(
  input: GcpNetworkDefinitionInput,
): TofuDefinition {
  const mark = {
    cloudAccountId: input.cloudAccountId,
    environmentId: input.environmentId,
    stateId: input.stateId,
  };
  const description = markDescription(mark);
  const labels = stateLabels(mark);
  const name = (part: NetworkPart) => networkName(input.environmentId, part);
  const blocks: Record<string, Record<string, unknown>> = {};
  /** Adds a block, with the mark in its description, and returns its address. */
  const add = (type: string, local: string, body: object): string => {
    (blocks[type] ??= {})[local] = { description, ...body };
    return `${type}.${local}`;
  };

  const network = add('google_compute_network', 'network', {
    name: name('net'),
    auto_create_subnetworks: false,
  });
  const subnet = add('google_compute_subnetwork', 'network', {
    name: name('subnet'),
    network: ref(network, 'id'),
    region: input.region,
    ip_cidr_range: GCP_NETWORK_ADDRESS_RANGE.subnet,
    private_ip_google_access: true,
  });

  const address = add('google_compute_global_address', 'network', {
    name: name('ip'),
    address_type: 'EXTERNAL',
    ip_version: 'IPV4',
    labels,
  });

  const certificateMap = add(
    'google_certificate_manager_certificate_map',
    'network',
    { name: name('certs'), labels },
  );
  // Made by Cloudgate and handed in as variables; a new one comes with every
  // run, so after the first upload they are ignored.
  const defaultCertificate = add(
    'google_certificate_manager_certificate',
    'default',
    {
      name: name('default'),
      labels,
      self_managed: {
        pem_certificate: `\${var.${DEFAULT_CERTIFICATE_VARIABLES.certificate}}`,
        pem_private_key: `\${var.${DEFAULT_CERTIFICATE_VARIABLES.privateKey}}`,
      },
      lifecycle: { ignore_changes: ['self_managed'] },
    },
  );
  add('google_certificate_manager_certificate_map_entry', 'default', {
    name: name('default'),
    labels,
    map: ref(certificateMap, 'name'),
    matcher: 'PRIMARY',
    certificates: [ref(defaultCertificate, 'id')],
  });

  const domains = [...input.domains]
    .sort((a, b) =>
      a.domainId < b.domainId ? -1 : a.domainId > b.domainId ? 1 : 0,
    )
    .map((domain) => ({
      ...domain,
      host: literal(domain.host),
      name: domainName(domain.domainId),
      certificateName: domainCertificateName(domain.domainId, domain.attempt),
    }));
  const nowhere = {
    host_redirect: DEFAULT_CERTIFICATE_HOST,
    redirect_response_code: 'FOUND',
    strip_query: true,
  };
  const urlMap = add('google_compute_url_map', 'network', {
    name: name('urls'),
    host_rule: domains.map((domain) => ({
      hosts: [domain.host],
      path_matcher: domain.name,
    })),
    path_matcher: domains.map((domain) => {
      if (domain.site) {
        return staticPathMatcher(domain.name, input.projectId, domain);
      }
      const service = backendServicePath(
        input.projectId,
        domain.backend ?? serviceName(domain.serviceId),
      );
      return domain.path === '/'
        ? { name: domain.name, default_service: service }
        : {
            name: domain.name,
            default_url_redirect: nowhere,
            path_rule: [
              {
                paths: [literal(domain.path), literal(`${domain.path}/*`)],
                service,
              },
            ],
          };
    }),
    default_url_redirect: nowhere,
  });
  domainResources(add, domains, { labels, certificateMap });
  privateLinkResources(add, joinedLinks(input.privateLinks), {
    name,
    labels,
    network,
    region: input.region,
  });
  if (input.privateLinks.includes('run-app-zone')) {
    runAppZoneResources(add, blocks, { name, labels, network });
  }
  if (input.privateLinks.includes('cloud-nat')) {
    cloudNatResources(add, blocks, {
      name,
      network,
      subnet,
      region: input.region,
    });
  }

  const redirectMap = add('google_compute_url_map', 'redirect', {
    name: name('redirect'),
    default_url_redirect: {
      https_redirect: true,
      redirect_response_code: 'MOVED_PERMANENTLY_DEFAULT',
      strip_query: false,
    },
  });

  const httpsProxy = add('google_compute_target_https_proxy', 'network', {
    name: name('https-proxy'),
    url_map: ref(urlMap, 'id'),
    certificate_map: `//certificatemanager.googleapis.com/${ref(certificateMap, 'id')}`,
  });
  const httpProxy = add('google_compute_target_http_proxy', 'network', {
    name: name('http-proxy'),
    url_map: ref(redirectMap, 'id'),
  });
  const rule = (part: 'https' | 'http', port: string, target: string) =>
    add('google_compute_global_forwarding_rule', part, {
      name: name(part),
      ip_address: ref(address, 'id'),
      ip_protocol: 'TCP',
      port_range: port,
      load_balancing_scheme: LOAD_BALANCING_SCHEME,
      target: ref(target, 'id'),
    });
  rule('https', '443', httpsProxy);
  rule('http', '80', httpProxy);

  if (input.cloudBuilds) buildSourceBucket(blocks, input, labels);

  const output = (value: string) => ({ value });
  return {
    ...frame(input.projectId, input.region),
    variable: {
      [DEFAULT_CERTIFICATE_VARIABLES.certificate]: { type: 'string' },
      [DEFAULT_CERTIFICATE_VARIABLES.privateKey]: {
        type: 'string',
        sensitive: true,
      },
    },
    resource: blocks,
    output: {
      [GCP_NETWORK_OUTPUTS.networkName]: output(ref(network, 'name')),
      [GCP_NETWORK_OUTPUTS.subnetName]: output(ref(subnet, 'name')),
      [GCP_NETWORK_OUTPUTS.ipAddress]: output(ref(address, 'address')),
      [GCP_NETWORK_OUTPUTS.urlMapName]: output(ref(urlMap, 'name')),
      [GCP_NETWORK_OUTPUTS.certificateMapName]: output(
        ref(certificateMap, 'name'),
      ),
      [GCP_DOMAIN_CERTIFICATES_OUTPUT]: output(
        '${ {for key, certificate in google_certificate_manager_certificate.domain : key => { id = certificate.id, validation = [for record in google_certificate_manager_dns_authorization.domain[key].dns_resource_record : { name = record.name, type = record.type, value = record.data }] }} }',
      ),
    },
  };
}

/**
 * A static site's host on the URL map (the Google Cloud buckets spec "Where things
 * live"): the whole host to the site's Cloud CDN backend bucket, with the
 * one prefix rewrite onto `live/` ({@link LIVE_REWRITE}), so every request reads the fixed
 * folder each deploy copies into and no deploy or rollback changes the
 * network. A static site's Domain is always its whole host.
 *
 * Under `spa: true` a 404 answers `/live/index.html` with 200, so the app's
 * client routes work; the error path is the bucket's own, not rewritten.
 * Google documents `customErrorResponsePolicy` as unsupported on a map with
 * no backend service, but it served live both ways (an open question of
 * the Google Cloud buckets spec).
 */
function staticPathMatcher(
  name: string,
  projectId: string,
  domain: { readonly serviceId: string; readonly site?: { spa: boolean } },
): Record<string, unknown> {
  const bucket = backendBucketPath(projectId, serviceName(domain.serviceId));
  return {
    name,
    default_service: bucket,
    default_route_action: {
      url_rewrite: { path_prefix_rewrite: LIVE_REWRITE },
    },
    ...(domain.site?.spa
      ? {
          default_custom_error_response_policy: {
            error_response_rule: [
              {
                match_response_codes: ['404'],
                path: `/${LIVE_PREFIX}${STATIC_SHELL}`,
                override_response_code: 200,
              },
            ],
            error_service: bucket,
          },
        }
      : {}),
  };
}

/** The page a `spa` site answers a missing path with, in its `live/` folder. */
const STATIC_SHELL = 'index.html';

/**
 * The rewrite onto `live/`, written with no trailing slash. A path matcher's
 * default route matches no prefix, so Google puts this value in front of the
 * whole request path rather than in place of a matched `/`: `/live/` read
 * `/about/` as the key `live//about/` and every page of the site answered
 * `NoSuchKey`. `/live` reads `/` as `live/` (the root's
 * folder link) and `/about/` as `live/about/`. The earlier live probe walked a route rule
 * with `prefixMatch: /`, which replaces the `/`, so it never saw this.
 */
const LIVE_REWRITE = `/${LIVE_PREFIX.replace(/\/$/, '')}`;

/**
 * The standing piece of a hosted cloud build in this Environment (ADR-0047),
 * the only part of a cloud build OpenTofu makes (ADR-0030): Cloud
 * Build needs nothing else standing, and starting, watching and cancelling
 * a build are API calls.
 *
 * **The source bucket**, where the platform host uploads each build's zip
 * and the build identity reads it: in the Environment's region, private as
 * every bucket Cloudgate makes (uniform bucket-level access, public access
 * prevented), with no soft delete, a zip a build left behind deleted after
 * a day, and `force_destroy` on, since it holds nothing but Cloudgate's own
 * zips and must not keep the network from going. Its name is
 * `cloud-build-names.ts`'s, which the build identity's grant is scoped to.
 * A bucket takes no description, so it is written beside `add`, with the
 * state's labels as its mark.
 */
function buildSourceBucket(
  blocks: Record<string, Record<string, unknown>>,
  input: GcpNetworkDefinitionInput,
  labels: Record<string, string>,
): void {
  const names = buildPieceNames({
    projectId: input.projectId,
    cloudAccountId: input.cloudAccountId,
    environmentId: input.environmentId,
  });
  (blocks.google_storage_bucket ??= {}).build_source = {
    name: names.sourceBucketName,
    // Cloud Storage keeps a location upper-case.
    location: input.region.toUpperCase(),
    force_destroy: true,
    uniform_bucket_level_access: true,
    public_access_prevention: 'enforced',
    soft_delete_policy: [{ retention_duration_seconds: 0 }],
    lifecycle_rule: [
      {
        condition: [{ age: BUILD_SOURCE_MAX_AGE_DAYS }],
        action: [{ type: 'Delete' }],
      },
    ],
    labels,
  };
}

/**
 * The private link's pieces: its subnet, then one service connection
 * policy per kind linked, each handing that kind's instances their address
 * from the subnet. Nothing when no kind is linked.
 */
function privateLinkResources(
  add: (type: string, local: string, body: object) => string,
  kinds: readonly PrivateLinkKind[],
  on: {
    name: (part: NetworkPart) => string;
    labels: Record<string, string>;
    network: string;
    region: string;
  },
): void {
  if (kinds.length === 0) return;
  const subnet = add('google_compute_subnetwork', 'private_link', {
    name: on.name('psc'),
    network: ref(on.network, 'id'),
    region: on.region,
    ip_cidr_range: GCP_NETWORK_ADDRESS_RANGE.reserved.privateServiceConnect,
  });
  const parts: { readonly [kind in PrivateLinkKind]: NetworkPart } = {
    'cloud-sql': 'psc-sql',
    memorystore: 'psc-redis',
  };
  const locals: { readonly [kind in PrivateLinkKind]: string } = {
    'cloud-sql': 'cloud_sql',
    memorystore: 'memorystore',
  };
  for (const kind of kinds) {
    add('google_network_connectivity_service_connection_policy', locals[kind], {
      name: on.name(parts[kind]),
      location: on.region,
      service_class: SERVICE_CLASS[kind],
      network: ref(on.network, 'id'),
      labels: on.labels,
      psc_config: { subnetworks: [ref(subnet, 'id')] },
    });
  }
  // Memorystore's link opens Redis's ports: a client asks 6379 for
  // the topology, which names each node's port in 11000–13047. Egress from
  // the network's Services to the link's subnet, where each instance's
  // address is; a custom-mode VPC allows that today, and this keeps it so.
  if (kinds.includes('memorystore')) {
    add('google_compute_firewall', 'redis_ports', {
      name: on.name('psc-redis-ports'),
      network: ref(on.network, 'id'),
      direction: 'EGRESS',
      priority: 1000,
      destination_ranges: [
        GCP_NETWORK_ADDRESS_RANGE.reserved.privateServiceConnect,
      ],
      allow: [{ protocol: 'tcp', ports: [...REDIS_PORTS] }],
    });
  }
}

/**
 * The private `run.app` zone: the zone, bound to the network, and
 * its two A records to `private.googleapis.com`. A record set takes no
 * description or label, so the records are written beside `add`, which
 * marks every block it writes; the zone carries the mark.
 */
function runAppZoneResources(
  add: (type: string, local: string, body: object) => string,
  blocks: Record<string, Record<string, unknown>>,
  on: {
    name: (part: NetworkPart) => string;
    labels: Record<string, string>;
    network: string;
  },
): void {
  const zone = add('google_dns_managed_zone', 'run_app', {
    name: on.name('run-app'),
    dns_name: RUN_APP_DNS_NAME,
    visibility: 'private',
    labels: on.labels,
    private_visibility_config: {
      networks: [{ network_url: ref(on.network, 'id') }],
    },
  });
  const record = (name: string) => ({
    name,
    managed_zone: ref(zone, 'name'),
    type: 'A',
    ttl: RUN_APP_RECORD_TTL_SECONDS,
    rrdatas: [...PRIVATE_GOOGLE_ACCESS_ADDRESSES],
  });
  blocks.google_dns_record_set = {
    run_app_wildcard: record(`*.${RUN_APP_DNS_NAME}`),
    run_app: record(RUN_APP_DNS_NAME),
  };
}

/**
 * The Cloud NAT of the network's Stack VMs (`cloud-nat.ts`): a Cloud
 * Router on the VPC, carrying the mark, and its NAT for the network's one
 * subnet, with addresses Google allocates. A NAT takes no description or
 * label, so it is written beside `add`; its fixed name is its mark.
 */
function cloudNatResources(
  add: (type: string, local: string, body: object) => string,
  blocks: Record<string, Record<string, unknown>>,
  on: {
    name: (part: NetworkPart) => string;
    network: string;
    subnet: string;
    region: string;
  },
): void {
  const router = add('google_compute_router', 'nat', {
    name: on.name('router'),
    region: on.region,
    network: ref(on.network, 'id'),
  });
  blocks.google_compute_router_nat = {
    nat: {
      name: on.name('nat'),
      router: ref(router, 'name'),
      region: on.region,
      nat_ip_allocate_option: 'AUTO_ONLY',
      source_subnetwork_ip_ranges_to_nat: 'LIST_OF_SUBNETWORKS',
      subnetwork: [
        {
          name: ref(on.subnet, 'id'),
          source_ip_ranges_to_nat: ['ALL_IP_RANGES'],
        },
      ],
    },
  };
}

/**
 * Per Domain: a DNS authorization (the CNAME the operator makes proves the
 * name), a Google-managed certificate issued through it, and the map entry
 * that serves it for the host. Nothing waits on the certificate: a deploy
 * never does.
 *
 * The certificate and its map entry are named for the Domain's attempt, so
 * a new one (Ask again, a new host) replaces both: the entry is destroyed
 * before the certificate it serves, which Google refuses to delete while in
 * use, and the new ones are made after. The authorization keeps the
 * Domain's own name, so Ask again leaves the operator's CNAME as it is.
 */
function domainResources(
  add: (type: string, local: string, body: object) => string,
  domains: readonly {
    domainId: string;
    host: string;
    name: string;
    certificateName: string;
  }[],
  on: { labels: Record<string, string>; certificateMap: string },
): void {
  const each = (name: (domain: (typeof domains)[number]) => string) =>
    Object.fromEntries(
      domains.map((domain) => [
        domain.domainId,
        { host: domain.host, name: name(domain) },
      ]),
    );
  const authorization = add(
    'google_certificate_manager_dns_authorization',
    'domain',
    {
      for_each: each((domain) => domain.name),
      name: '${each.value.name}',
      labels: on.labels,
      domain: '${each.value.host}',
    },
  );
  const certificate = add('google_certificate_manager_certificate', 'domain', {
    for_each: each((domain) => domain.certificateName),
    name: '${each.value.name}',
    labels: on.labels,
    managed: {
      domains: ['${each.value.host}'],
      dns_authorizations: [`\${${authorization}[each.key].id}`],
    },
  });
  add('google_certificate_manager_certificate_map_entry', 'domain', {
    for_each: each((domain) => domain.certificateName),
    name: '${each.value.name}',
    labels: on.labels,
    map: ref(on.certificateMap, 'name'),
    hostname: '${each.value.host}',
    certificates: [`\${${certificate}[each.key].id}`],
  });
}
