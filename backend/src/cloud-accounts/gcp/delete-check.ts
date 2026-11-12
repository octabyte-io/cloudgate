import { googleRefusalReason } from './api-off';
import { LABEL_KEYS } from './definitions/mark';
import {
  domainName,
  idKey,
  networkNamePrefix,
  serviceName,
} from './definitions/names';
import { NOT_FOUND } from '../google-cloud.port';
import type {
  FoundByName,
  GoogleAccessToken,
  GoogleCloudPort,
} from '../google-cloud.port';

/**
 * Something a Delete on Google Cloud should have removed and did not
 * (ADR-0038): what an operator needs to find it in their
 * Google Cloud project and remove it — its type, Google name, region and
 * label, as the Google Cloud databases spec expects.
 */
export interface GoogleLeftover {
  /** Google's own name for its kind, `run.googleapis.com/Service` and so on. */
  readonly type: string;
  /** The fixed name Cloudgate gave it (S4); a host rule's is its URL map's and host. */
  readonly googleName: string;
  /** Its region; `global` for a global kind. */
  readonly region: string;
  /** Cloudgate's state label on it, `key=value`; `null` on a kind that takes none, found by name. */
  readonly label: string | null;
  /**
   * Why it is left when the Delete itself chose to stop short of it: a
   * static site's bucket whose emptying stopped partway, so it still holds
   * files, as on AWS.
   */
  readonly because?: 'partly-emptied';
}

/** The report's one line when nothing was left. */
export const GOOGLE_CLEAN_DELETE_LINE =
  'Nothing was left in your Google Cloud project: every resource of this Service is gone.';

/**
 * The Delete dialog's line on logs: they are the project's,
 * not Cloudgate's, so they are not on the *Kept* list.
 */
export const GOOGLE_LOGS_STAY_LINE =
  "Its logs stay in the project's own log store and expire after its retention (30 days unless changed).";

/** {@link GOOGLE_CLEAN_DELETE_LINE}, for an Environment network's removal. */
export const GOOGLE_CLEAN_NETWORK_REMOVAL_LINE =
  'Nothing was left in your Google Cloud project: every resource of this Environment network is gone.';

/** The report as the Deployment log reads it, line by line. */
export function googleDeleteReportLines(
  left: readonly GoogleLeftover[],
  cleanLine: string = GOOGLE_CLEAN_DELETE_LINE,
): string[] {
  if (left.length === 0) return [cleanLine];
  return [
    'Left, although it should have gone:',
    ...left.map(
      (one) =>
        `  ${one.type} ${one.googleName} (${one.region}${one.label ? `, ${one.label}` : ''})${one.because === 'partly-emptied' ? ': partly emptied, it still holds files' : ''}`,
    ),
  ];
}

/** Google's type of a subnet, which it holds after use. */
const SUBNETWORK_TYPE = 'compute.googleapis.com/Subnetwork';
/** Google's type of a VPC network, which its held subnet keeps. */
const NETWORK_TYPE = 'compute.googleapis.com/Network';

/** One kind the search lists: its OpenTofu type, Google's type, and whether it is global. */
interface SearchedKind {
  readonly resourceType: string;
  readonly type: string;
  readonly global: boolean;
}

/**
 * A Service's own kinds, in the order its destroy removes them (the Google Cloud spec,
 * "Delete"): each named `cloudgate-<service key>`, a secret with its
 * variable after it.
 */
const SERVICE_KINDS: readonly SearchedKind[] = [
  {
    resourceType: 'google_compute_backend_service',
    type: 'compute.googleapis.com/BackendService',
    global: true,
  },
  {
    resourceType: 'google_compute_region_network_endpoint_group',
    type: 'compute.googleapis.com/NetworkEndpointGroup',
    global: false,
  },
  {
    resourceType: 'google_cloud_run_v2_service',
    type: 'run.googleapis.com/Service',
    global: false,
  },
  // A Worker's worker pool, by the same fixed name.
  {
    resourceType: 'google_cloud_run_v2_worker_pool',
    type: 'run.googleapis.com/WorkerPool',
    global: false,
  },
  // A Cron service's job, by the same fixed name.
  {
    resourceType: 'google_cloud_run_v2_job',
    type: 'run.googleapis.com/Job',
    global: false,
  },
  {
    resourceType: 'google_artifact_registry_repository',
    type: 'artifactregistry.googleapis.com/Repository',
    global: false,
  },
  {
    resourceType: 'google_secret_manager_secret',
    type: 'secretmanager.googleapis.com/Secret',
    global: true,
  },
  {
    resourceType: 'google_service_account',
    type: 'iam.googleapis.com/ServiceAccount',
    global: true,
  },
];

/** Google's type of a Cloud Storage bucket, as a report names it. */
export const GOOGLE_STORAGE_BUCKET_TYPE = 'storage.googleapis.com/Bucket';

/**
 * A `static` site's own kinds (the Google Cloud buckets spec "Static site"): its Cloud
 * CDN backend bucket, named `cloudgate-<service key>`, and its Cloud
 * Storage bucket, found by its own minted name. The load balancer's grant
 * on the bucket goes with the bucket.
 */
const SITE_BACKEND_KIND: SearchedKind = {
  resourceType: 'google_compute_backend_bucket',
  type: 'compute.googleapis.com/BackendBucket',
  global: true,
};
const SITE_BUCKET_KIND: SearchedKind = {
  resourceType: 'google_storage_bucket',
  type: GOOGLE_STORAGE_BUCKET_TYPE,
  global: false,
};

/** A certificate map entry, which is listed under its map. */
const MAP_ENTRY_KIND: SearchedKind = {
  resourceType: 'google_certificate_manager_certificate_map_entry',
  type: 'certificatemanager.googleapis.com/CertificateMapEntry',
  global: true,
};

/** A Domain's pieces in the network's state, each named for the Domain. */
const DOMAIN_KINDS: readonly SearchedKind[] = [
  MAP_ENTRY_KIND,
  {
    resourceType: 'google_certificate_manager_certificate',
    type: 'certificatemanager.googleapis.com/Certificate',
    global: true,
  },
  {
    resourceType: 'google_certificate_manager_dns_authorization',
    type: 'certificatemanager.googleapis.com/DnsAuthorization',
    global: true,
  },
];

/** One of the Service's Domains, as the search and a host rule name it. */
export interface SearchedDomain {
  readonly domainId: string;
  readonly host: string;
  readonly path: string | null;
}

/** What the search after a Service's Delete looks for. */
export interface GoogleLeftoverSearch {
  readonly projectId: string;
  readonly region: string;
  readonly serviceId: string;
  /** The Service's Domains, whose certificates and map entries the network held. */
  readonly domains: readonly SearchedDomain[];
  /** The network's certificate map, which a Domain's map entry lives under. */
  readonly certificateMap: string | null;
  /**
   * A `static` site's own Cloud Storage bucket: its backend bucket
   * and the bucket are searched for too. Absent for any other Service.
   */
  readonly siteBucket?: string | null;
}

export type GoogleLeftoverCheck =
  | { readonly ok: true; readonly left: GoogleLeftover[] }
  | { readonly ok: false; readonly message: string };

/**
 * The search after a Service's Delete: Google's own list call
 * for each kind Cloudgate makes for it, by its fixed name prefix (a service
 * account by its email), and for each of its Domains' certificate, map
 * entry and DNS authorization. Cloud Asset Inventory is not used. A refusal
 * or no answer is a search that did not happen, never a clean one; an API
 * turned off names the API and the setup step.
 */
export function findGoogleLeftovers(
  google: GoogleCloudPort,
  token: GoogleAccessToken,
  search: GoogleLeftoverSearch,
): Promise<GoogleLeftoverCheck> {
  return searchByName(google, token, search, [
    ...SERVICE_KINDS.map((kind) => ({
      kind,
      namePrefix: serviceName(search.serviceId),
    })),
    ...(search.siteBucket
      ? [
          {
            kind: SITE_BACKEND_KIND,
            namePrefix: serviceName(search.serviceId),
          },
          { kind: SITE_BUCKET_KIND, namePrefix: search.siteBucket },
        ]
      : []),
    ...search.domains.flatMap((one) =>
      DOMAIN_KINDS.map((kind) => ({
        kind,
        namePrefix: domainName(one.domainId),
        ...(search.certificateMap ? { parent: search.certificateMap } : {}),
      })),
    ),
  ]);
}

/**
 * An Environment network's kinds, in the order its destroy removes them
 * (the Google Cloud spec, "Environment network"): the load balancer's pieces,
 * the certificate map's default certificate and the map, the fixed IP,
 * the private link's policies (Cloud SQL's and Memorystore's, both
 * under the network's prefix) and Memorystore's firewall rule for
 * Redis's ports, its Private web services' private `run.app` zone
 * then the subnets (its own and the private link's) and the VPC
 * network last. Each is named
 * `cloudgate-<environment key>-<part>`. Slice 7 adds its kinds here.
 */
const NETWORK_KINDS: readonly SearchedKind[] = [
  {
    resourceType: 'google_compute_global_forwarding_rule',
    type: 'compute.googleapis.com/ForwardingRule',
    global: true,
  },
  {
    resourceType: 'google_compute_target_https_proxy',
    type: 'compute.googleapis.com/TargetHttpsProxy',
    global: true,
  },
  {
    resourceType: 'google_compute_target_http_proxy',
    type: 'compute.googleapis.com/TargetHttpProxy',
    global: true,
  },
  {
    resourceType: 'google_compute_url_map',
    type: 'compute.googleapis.com/UrlMap',
    global: true,
  },
  {
    resourceType: 'google_certificate_manager_certificate',
    type: 'certificatemanager.googleapis.com/Certificate',
    global: true,
  },
  {
    resourceType: 'google_certificate_manager_certificate_map',
    type: 'certificatemanager.googleapis.com/CertificateMap',
    global: true,
  },
  {
    resourceType: 'google_compute_global_address',
    type: 'compute.googleapis.com/Address',
    global: true,
  },
  {
    resourceType: 'google_network_connectivity_service_connection_policy',
    type: 'networkconnectivity.googleapis.com/ServiceConnectionPolicy',
    global: false,
  },
  {
    resourceType: 'google_compute_firewall',
    type: 'compute.googleapis.com/Firewall',
    global: true,
  },
  {
    // The private `run.app` zone of its Private web services,
    // bound to the VPC, so removed before it.
    resourceType: 'google_dns_managed_zone',
    type: 'dns.googleapis.com/ManagedZone',
    global: true,
  },
  {
    resourceType: 'google_compute_subnetwork',
    type: SUBNETWORK_TYPE,
    global: false,
  },
  {
    resourceType: 'google_compute_network',
    type: NETWORK_TYPE,
    global: true,
  },
];

/** What the search after an Environment network's removal looks for. */
export interface GoogleNetworkLeftoverSearch {
  readonly projectId: string;
  readonly region: string;
  readonly environmentId: string;
  /**
   * The network's certificate map: every entry in it is Cloudgate's (its
   * default one, or a Domain's), so each one left is listed under it.
   * `null` when the network never saved one.
   */
  readonly certificateMap: string | null;
}

/**
 * The search after an Environment network's removal:
 * the list call of each of its kinds by the network's name prefix, and
 * every entry still in its certificate map. Networks and subnets take no
 * label, so they are found by name alone. A refusal or no answer is a
 * search that did not happen, never a clean one.
 */
export function findGoogleNetworkLeftovers(
  google: GoogleCloudPort,
  token: GoogleAccessToken,
  search: GoogleNetworkLeftoverSearch,
): Promise<GoogleLeftoverCheck> {
  const prefix = networkNamePrefix(search.environmentId);
  return searchByName(google, token, search, [
    ...(search.certificateMap
      ? [
          {
            kind: MAP_ENTRY_KIND,
            namePrefix: 'cloudgate-',
            parent: search.certificateMap,
          },
        ]
      : []),
    ...NETWORK_KINDS.map((kind) => ({ kind, namePrefix: prefix })),
  ]);
}

/** What the label search after an Environment's Delete looks for. */
export interface GoogleLabelLeftoverSearch {
  readonly projectId: string;
  readonly environmentId: string;
}

/**
 * The label search after an Environment's Delete (the Google Cloud databases spec, "Deleting the
 * Environment"): once its databases, private link and network are
 * destroyed, everything in the project still carrying the Environment's
 * label (S5) — such as a Private Service Connect address Google still lists
 * as `CLOSED` — named by type, Google id, region and Cloudgate's label (its
 * state's, else its Environment's). A refusal or no answer is a search that
 * did not happen, never a clean one.
 */
export async function findGoogleLabelLeftovers(
  google: GoogleCloudPort,
  token: GoogleAccessToken,
  search: GoogleLabelLeftoverSearch,
): Promise<GoogleLeftoverCheck> {
  const label = {
    key: LABEL_KEYS.environment,
    value: idKey(search.environmentId),
  };
  let answer: Awaited<ReturnType<GoogleCloudPort['findByLabel']>>;
  try {
    answer = await google.findByLabel(token, {
      projectId: search.projectId,
      label,
    });
  } catch (error) {
    return {
      ok: false,
      message: `Google Cloud did not answer the search by Cloudgate's label: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!answer.ok) {
    return {
      ok: false,
      message: `Google refused the search by Cloudgate's label ${label.key}=${label.value}: ${googleRefusalReason(answer.message, search.projectId)}`,
    };
  }
  return {
    ok: true,
    left: answer.value.map((found) => {
      const state = found.labels[LABEL_KEYS.state];
      return {
        type: found.type,
        googleName: found.id,
        region: found.region,
        label: state
          ? `${LABEL_KEYS.state}=${state}`
          : `${label.key}=${label.value}`,
      };
    }),
  };
}

/** One list call of a search: a kind, the prefix its names start with, its parent. */
interface SearchAsk {
  readonly kind: SearchedKind;
  readonly namePrefix: string;
  readonly parent?: string;
}

/**
 * Google's own list call for each ask; Cloud Asset
 * Inventory is not used. An API turned off names the API and the setup
 * step.
 */
async function searchByName(
  google: GoogleCloudPort,
  token: GoogleAccessToken,
  where: { readonly projectId: string; readonly region: string },
  asks: readonly SearchAsk[],
): Promise<GoogleLeftoverCheck> {
  const left: GoogleLeftover[] = [];
  try {
    for (const ask of asks) {
      const answer = await google.findByName(token, {
        projectId: where.projectId,
        region: where.region,
        resourceType: ask.kind.resourceType,
        namePrefix: ask.namePrefix,
        ...(ask.parent ? { parent: ask.parent } : {}),
      });
      // A map the destroy just removed has no entries left to list: Google
      // answers that the map is not found (the live walk), which is
      // a search that happened, not a refused one.
      if (!answer.ok && ask.parent && answer.code === NOT_FOUND) continue;
      if (!answer.ok) {
        return {
          ok: false,
          message: `Google refused the search for ${ask.kind.type}: ${googleRefusalReason(answer.message, where.projectId)}`,
        };
      }
      left.push(
        ...answer.value.map((found) =>
          leftoverOf(found, ask.kind, where.region),
        ),
      );
    }
  } catch (error) {
    return {
      ok: false,
      message: `Google Cloud did not answer the search: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, left };
}

/** Google's words for a subnet still in use: `resourceInUseByAnotherResource`, "is already being used by". */
const IN_USE =
  /resourceInUseByAnotherResource|already being used by|is in use/i;

/**
 * Google's subnet hold (the Google Cloud spec, "The subnet hold"): a
 * subnet its services used is kept by Google 1–2 hours after they are
 * gone, and its VPC network with it. A removal is held when Google refused
 * a delete as still in use and what is left is only subnets and the VPC
 * network, a subnet among them.
 */
export function subnetHeld(
  left: readonly GoogleLeftover[],
  refusal: string | null,
): boolean {
  return (
    refusal !== null &&
    IN_USE.test(refusal) &&
    left.some((one) => one.type === SUBNETWORK_TYPE) &&
    left.every(
      (one) => one.type === SUBNETWORK_TYPE || one.type === NETWORK_TYPE,
    )
  );
}

/** How long after a held removal Cloudgate tries again by itself (S13): about 2 hours. */
export const HOLD_RETRY_AFTER_MS = 2 * 60 * 60 * 1000;

/** Cloudgate's own tries after the first held removal, at about 2 hours and about 4 (S13). */
export const HOLD_TRIES = 2;

/**
 * The sentence a held removal ends with, naming the subnet
 * and the network. `nextTryAt` is Cloudgate's own next try, `null` once it
 * has none left. The time is HH:MM in UTC: an Organization keeps no time
 * zone of its own.
 */
export function subnetHoldSentence(
  left: readonly GoogleLeftover[],
  nextTryAt: string | null,
): string {
  const names = (type: string) =>
    left.filter((one) => one.type === type).map((one) => one.googleName);
  const subnets = names(SUBNETWORK_TYPE);
  const networks = names(NETWORK_TYPE);
  const held = [
    `${subnets.length === 1 ? 'subnet' : 'subnets'} ${subnets.join(', ')}`,
    ...(networks.length > 0 ? [`network ${networks.join(', ')}`] : []),
  ].join(' and ');
  return `Google Cloud still holds ${held}. Google releases this 1–2 hours after the services are gone; ${
    nextTryAt
      ? `Cloudgate will try again at ${new Date(nextTryAt).toISOString().slice(11, 16)} UTC`
      : 'Cloudgate has tried again twice by itself, so Retry once Google has released it, or Forget it'
  }`;
}

/**
 * The host rules a network step that failed left on the network's URL map
 * (S18): one per Domain of the Service. A host rule is part of the URL map,
 * which no list call finds on its own, so it is named from the Domain.
 */
export function hostRulesLeft(
  urlMap: string,
  domains: readonly SearchedDomain[],
): GoogleLeftover[] {
  return domains.map((one) => ({
    type: 'compute.googleapis.com/UrlMap host rule',
    googleName: `${urlMap} ${one.host}${one.path && one.path !== '/' ? one.path : ''}`,
    region: 'global',
    label: null,
  }));
}

function leftoverOf(
  found: FoundByName,
  kind: SearchedKind,
  region: string,
): GoogleLeftover {
  const state = found.labels?.[LABEL_KEYS.state];
  return {
    type: kind.type,
    googleName: found.name,
    region: kind.global ? 'global' : region,
    label: state ? `${LABEL_KEYS.state}=${state}` : null,
  };
}
