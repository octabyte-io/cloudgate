import { ref } from '../../definitions/tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';
import { markDescription, stateLabels } from './mark';
import { serviceName } from './names';
import { frame } from './tofu-json';

export interface GcpStaticDefinitionInput {
  /** The site's Service id, which names its backend bucket (S4). */
  readonly serviceId: string;
  /**
   * Its own bucket's real name, minted once by the plan that created it:
   * `cloudgate-<service key>-<8 random>`.
   */
  readonly bucketName: string;
  /** Cloudgate's id of the Cloud account, for the mark. */
  readonly cloudAccountId: string;
  /** The Google Cloud project the Cloud account connects. */
  readonly projectId: string;
  /** That project's number, which names its load balancer's service agent. */
  readonly projectNumber: string;
  readonly region: string;
  readonly environmentId: string;
  /** The site's Infrastructure state. */
  readonly stateId: string;
}

/** The address of the site's bucket in its definition. */
export const GCP_STATIC_BUCKET_ADDRESS = 'google_storage_bucket.site';

/** The address of its Cloud CDN backend bucket. */
export const GCP_STATIC_BACKEND_ADDRESS = 'google_compute_backend_bucket.site';

/** The address of the load balancer's read grant on the bucket. */
export const GCP_STATIC_GRANT_ADDRESS =
  'google_storage_bucket_iam_member.load_balancer';

/**
 * The one folder a static site on Google Cloud is served from (the Google Cloud
 * buckets spec): the network's rules always point at it, and each Deployment or
 * Rollback copies its files into it, so going live never changes the network.
 */
export const LIVE_PREFIX = 'live/';

/**
 * How long Cloud CDN keeps a file: a day. Every deploy clears
 * the cache of each Domain once its copy is done, so a long life costs
 * nothing in freshness.
 */
export const STATIC_EDGE_TTL_SECONDS = 86_400;

/**
 * The role the load balancer's service agent holds on the bucket: read and
 * list, so a missing file is a plain 404, never a 403.
 */
export const STATIC_READER_ROLE = 'roles/storage.objectViewer';

/**
 * The Google-managed service agent the load balancer fetches a private
 * bucket's files as (a live probe granted exactly this member).
 */
export function loadBalancerAgent(projectNumber: string): string {
  return `serviceAccount:service-${projectNumber}@https-lb.iam.gserviceaccount.com`;
}

/**
 * The OpenTofu definition of a `static` site on Google Cloud, its own
 * Infrastructure state (the Google Cloud buckets spec "Static site on Cloud
 * Storage and Cloud CDN", as corrected, and facts established live).
 * Pure: no Google call, no `tofu`, no database. Of the config only the
 * site's existence reaches it: its files are its deploys', and its host
 * rules, `live/` rewrite and `spa` error policy are the Environment network's.
 *
 * - **The bucket** is made under its real name in the Environment's project
 *   and region, **private**: uniform access, and public access prevention
 *   enforced, so nobody can list or fetch it directly. **Soft delete is off**
 *   (retention 0), as on every bucket Cloudgate makes. **No hierarchical
 *   namespace**, so an object whose name ends in `/` (`live/about/`, the
 *   folder link) is allowed, and **no website configuration**: no
 *   `MainPageSuffix`, since the folder links are objects of their own.
 * - **Its Cloud CDN backend bucket**, named by the Service's key: every file
 *   cached at the edge (`FORCE_CACHE_ALL`) for {@link STATIC_EDGE_TTL_SECONDS},
 *   browsers told to check back every time (`client_ttl` 0, so they get
 *   `public,max-age=0`), **no `max_ttl`** (Google refuses one with
 *   `FORCE_CACHE_ALL`), and **negative caching off**, so a 404 never
 *   outlives the deploy that fixes it.
 * - **The load balancer's service agent** holds {@link STATIC_READER_ROLE}
 *   on this bucket only: the one reader besides Cloudgate's deploys.
 */
export function gcpStaticDefinition(
  input: GcpStaticDefinitionInput,
): TofuDefinition {
  const mark = {
    cloudAccountId: input.cloudAccountId,
    environmentId: input.environmentId,
    stateId: input.stateId,
  };
  const bucket = GCP_STATIC_BUCKET_ADDRESS;
  const resource = {
    google_storage_bucket: {
      site: {
        name: input.bucketName,
        // Cloud Storage keeps a location upper-case.
        location: input.region.toUpperCase(),
        force_destroy: false,
        uniform_bucket_level_access: true,
        public_access_prevention: 'enforced',
        soft_delete_policy: [{ retention_duration_seconds: 0 }],
        hierarchical_namespace: [{ enabled: false }],
        labels: stateLabels(mark),
      },
    },
    google_compute_backend_bucket: {
      site: {
        name: serviceName(input.serviceId),
        description: markDescription(mark),
        bucket_name: ref(bucket, 'name'),
        enable_cdn: true,
        cdn_policy: [
          {
            cache_mode: 'FORCE_CACHE_ALL',
            client_ttl: 0,
            default_ttl: STATIC_EDGE_TTL_SECONDS,
            negative_caching: false,
          },
        ],
      },
    },
    google_storage_bucket_iam_member: {
      load_balancer: {
        bucket: ref(bucket, 'name'),
        role: STATIC_READER_ROLE,
        member: loadBalancerAgent(input.projectNumber),
      },
    },
  };
  return { ...frame(input.projectId, input.region), resource };
}
