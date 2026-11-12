/**
 * The route a Private web service on Google Cloud is reached by (the Google Cloud kinds
 * spec "Private web service on Google Cloud"; ADR-0045): a private
 * Cloud DNS zone for `run.app.`, bound to the Environment network's VPC,
 * whose `*.run.app` and `run.app` A records answer `private.googleapis.com`'s
 * four addresses. Every Cloud Run service, worker pool and job of the
 * Environment already leaves through Direct VPC egress for private ranges
 * only, which sends those addresses into the VPC, and the subnet already has
 * Private Google Access on, so Google counts the call as internal and a
 * service with ingress `INTERNAL_ONLY` answers it. Proved live.
 *
 * The zone lives in the Environment network's Infrastructure state: the
 * first plan that creates a `web-private` in the network adds it, and it is
 * kept after the last one is gone, until the network goes, the AWS
 * namespace's rule.
 */

/** The network's kind of link that holds the zone (`network-links.ts`). */
export type GoogleRunAppLinkKind = 'run-app-zone';

/** Every such Google kind, in the order a definition writes them. */
export const GOOGLE_RUN_APP_LINK_KINDS: readonly GoogleRunAppLinkKind[] = [
  'run-app-zone',
];

/** The zone's DNS name, fully qualified as Cloud DNS takes it. */
export const RUN_APP_DNS_NAME = 'run.app.';

/**
 * `private.googleapis.com`'s addresses (199.36.153.8/30), which Google
 * documents for Private Google Access by private DNS: inside the VPC, the
 * only route to them is Google's own.
 */
export const PRIVATE_GOOGLE_ACCESS_ADDRESSES: readonly string[] = [
  '199.36.153.8',
  '199.36.153.9',
  '199.36.153.10',
  '199.36.153.11',
];

/** How long a caller's resolver keeps the records: they never change. */
export const RUN_APP_RECORD_TTL_SECONDS = 300;

/** What the zone costs: Cloud DNS's per-zone charge; queries are free here. */
export const RUN_APP_ZONE_COST = 'about $0.20/month';

/**
 * The zone as a sentence names it: a network run's title and log, when a
 * plan adds it, and a network removal's first line, when it goes.
 */
export const RUN_APP_ZONE_PART = 'private DNS zone `run.app`';

/** The zone as a plan line names it. */
export const RUN_APP_ZONE_LABEL = 'Private DNS zone `run.app`';

/**
 * How long, measured live, a caller inside the Environment is still
 * answered 404 after a new Private web service is made, before Google's
 * ingress and egress settings reach it. Docs and the walk say it; no deploy
 * waits on it.
 */
export const RUN_APP_SETTLE_WORDS = 'about 1.5 to 3.5 minutes';
