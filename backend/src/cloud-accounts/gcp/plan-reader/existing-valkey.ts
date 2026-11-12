import type {
  MemorystoreInstanceRead,
  ValkeyServiceAttachment,
} from '../../google-cloud.port';
import { LABEL_KEYS } from '../definitions/mark';
import type { ValkeyEndpoint } from '../definitions/existing-valkey-definition';

/**
 * An Existing database that is a Memorystore for Valkey `redis` on Google
 * Cloud (ADR-0033 as amended, ADR-0042): the name the
 * operator gives, how each plan's lookup of the instance is judged, and the
 * one step only the operator can take after the Apply — registering
 * Cloudgate's two endpoints on it. Pure: the instance is read through the
 * Google client port by the caller.
 */

/** A Memorystore instance's name, `project/region/instance`, in its parts. */
export interface ValkeyInstanceName {
  readonly projectId: string;
  readonly region: string;
  readonly instance: string;
}

/**
 * A Memorystore instance's name as the operator gives one: a project id (a
 * domain-scoped one, `example.com:project`, keeps its colon), a region, an
 * instance id (lowercase letters, digits and hyphens, starting with a
 * letter).
 */
const INSTANCE_NAME =
  /^((?:[a-z][a-z0-9.-]*[a-z0-9]:)?[a-z][a-z0-9-]{4,28}[a-z0-9])\/([a-z]+-[a-z]+[0-9]+)\/([a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;

export function parseValkeyName(text: string): ValkeyInstanceName | null {
  const found = INSTANCE_NAME.exec(text);
  if (!found) return null;
  return { projectId: found[1], region: found[2], instance: found[3] };
}

/**
 * The lowest maintenance version that takes endpoints from more than one
 * network: an instance below it cannot register Cloudgate's.
 * Google's versions sort as text: `MEMORYSTORE_<date>_<nn>_<nn>`.
 */
export const VALKEY_MIN_MAINTENANCE_VERSION = 'MEMORYSTORE_20251210_02_00';

/**
 * What Cloudgate's two manual endpoints cost together: two
 * Private Service Connect consumer endpoints, $0.01 an hour each, as an
 * existing Cloud SQL's one (about $7.30/month).
 */
export const VALKEY_ENDPOINTS_COST = 'about $14.60/month';

/** The only login mode Cloudgate's Outputs can carry (ADR-0042): none. */
const AUTH_DISABLED = 'AUTH_DISABLED';

/** Memorystore's TLS mode: the server's certificate, checked with its CA. */
const SERVER_AUTHENTICATION = 'SERVER_AUTHENTICATION';

/** The modes of an instance with cluster mode off. */
const CLUSTER_OFF = new Set(['CLUSTER_DISABLED', 'STANDALONE']);

/** What Memorystore answered for the instance. */
export type ValkeyLookup =
  | { readonly kind: 'found'; readonly instance: MemorystoreInstanceRead }
  /** `NOT_FOUND`: there is no such instance. */
  | { readonly kind: 'missing' }
  /** `PERMISSION_DENIED`: Cloudgate's service account may not read it. */
  | { readonly kind: 'unreadable'; readonly message: string };

/** What a lookup is judged against: the Service and the Environment's place. */
export interface ExistingValkeyContext {
  readonly serviceName: string;
  /** As the operator gave it. */
  readonly identifier: string;
  /** The Environment's own project: where Cloudgate's endpoints are made. */
  readonly projectId: string;
  /** The Environment's region. */
  readonly region: string;
  /** The deploy service account's email, which the read grant names. */
  readonly serviceAccount: string;
}

export type ExistingValkeyVerdict =
  | {
      readonly ok: false;
      readonly reason: string;
      /** Google has no such instance: its page says "Google Cloud cannot find" it. */
      readonly missing?: true;
    }
  | {
      readonly ok: true;
      /** TLS on: `rediss://` with the instance's CA as `ca`; off: `redis://` with none. */
      readonly tls: boolean;
      readonly ca: string | null;
      /** Where Cloudgate's two endpoints point. */
      readonly serviceAttachments: {
        readonly [endpoint in ValkeyEndpoint]: string;
      };
      /** The plan's lines for it. */
      readonly lines: string[];
    };

/**
 * The grant an instance in another project needs before every plan can look
 * it up: read on Memorystore there, for Cloudgate's service account.
 */
export function memorystoreViewerGrant(
  projectId: string,
  serviceAccount: string,
): string {
  return `gcloud projects add-iam-policy-binding ${projectId} --member=serviceAccount:${serviceAccount} --role=roles/memorystore.viewer`;
}

/** The command that moves an instance to the lowest maintenance version Cloudgate's endpoints need. */
export function maintenanceUpdateCommand(name: ValkeyInstanceName): string {
  return `gcloud memorystore instances update ${name.instance} --location=${name.region} --project=${name.projectId} --maintenance-version=${VALKEY_MIN_MAINTENANCE_VERSION}`;
}

/**
 * Whether an Existing database's Memorystore instance can be used as a
 * `redis` as given (ADR-0033), each refusal naming its fix:
 *
 * - not found, or not readable (with the read grant for another project);
 * - Memorystore for Redis or Redis Cluster: use Valkey (ADR-0042);
 * - Cloudgate's own labels;
 * - another region than the Environment's;
 * - cluster mode on;
 * - a login mode other than `AUTH_DISABLED` (a token or IAM, ADR-0042);
 * - a maintenance version below {@link VALKEY_MIN_MAINTENANCE_VERSION},
 *   with the update command;
 * - fewer than two service attachments, or TLS on with no CA reported.
 *
 * TLS and the login mode are read, never typed.
 */
export function judgeExistingValkey(
  lookup: ValkeyLookup,
  context: ExistingValkeyContext,
): ExistingValkeyVerdict {
  const { serviceName: name, identifier } = context;
  const uses = `${name} uses the existing cache ${identifier}`;
  const parts = parseValkeyName(identifier);
  if (!parts) {
    return {
      ok: false,
      reason: `${uses}, which is not a Memorystore instance name; give it as project/region/instance on ${name}'s page`,
    };
  }
  const elsewhere = parts.projectId !== context.projectId;
  const grant = `\`${memorystoreViewerGrant(parts.projectId, context.serviceAccount)}\``;
  if (lookup.kind === 'missing') {
    return {
      ok: false,
      missing: true,
      reason: `${uses}, but Google Cloud cannot find Memorystore for Valkey instance ${parts.instance} in project ${parts.projectId}, region ${parts.region}. Check the instance name on ${name}'s page${elsewhere ? `; it is in another project, so grant Cloudgate's service account read on Memorystore there: ${grant}` : ''}`,
    };
  }
  if (lookup.kind === 'unreadable') {
    return {
      ok: false,
      reason: `${uses}, but Cloudgate may not read it (${lookup.message}); give Cloudgate's service account read on Memorystore in ${parts.projectId}: ${grant}`,
    };
  }
  const { instance } = lookup;
  if (instance.product !== 'valkey') {
    const product =
      instance.product === 'redis'
        ? 'a Memorystore for Redis instance'
        : 'a Memorystore for Redis Cluster';
    return {
      ok: false,
      reason: `${uses}, but it is ${product}, which Cloudgate cannot reach without peering a network: use Valkey. Give the name of a Memorystore for Valkey instance with cluster mode off`,
    };
  }
  const ours = Object.keys(instance.labels)
    .filter((key) => (Object.values(LABEL_KEYS) as string[]).includes(key))
    .sort();
  if (ours.length > 0) {
    return {
      ok: false,
      reason: `${uses}, but it carries Cloudgate's labels (${ours.join(', ')}), so Cloudgate made it for an Environment; an existing cache must be one Cloudgate did not make`,
    };
  }
  if (parts.region !== context.region) {
    return {
      ok: false,
      reason: `${uses}, but it is in ${parts.region}, not this Environment's region ${context.region}; an existing cache must be in the Environment's region`,
    };
  }
  if (!instance.mode || !CLUSTER_OFF.has(instance.mode)) {
    return {
      ok: false,
      reason: `${uses}, but it is in cluster mode (${instance.mode ?? 'a mode Google did not name'}), so a redis cannot use it: it hands out one URL, to one primary endpoint. Give the name of a Valkey instance with cluster mode off`,
    };
  }
  if (instance.authorizationMode !== AUTH_DISABLED) {
    return {
      ok: false,
      reason: `${uses}, but it asks every client to log in (${instance.authorizationMode ?? 'a login mode Google did not name'}), and Cloudgate's Outputs carry no token and no IAM login. Use a Valkey instance with authorization off (${AUTH_DISABLED}); only this Environment's network reaches it through Cloudgate's endpoints`,
    };
  }
  if (
    !instance.maintenanceVersion ||
    instance.maintenanceVersion < VALKEY_MIN_MAINTENANCE_VERSION
  ) {
    return {
      ok: false,
      reason: `${uses}, but it runs maintenance version ${instance.maintenanceVersion ?? '(none reported)'}, below ${VALKEY_MIN_MAINTENANCE_VERSION}, the first that takes endpoints from another network. Update it: \`${maintenanceUpdateCommand(parts)}\``,
    };
  }
  const attachments = orderedAttachments(instance.serviceAttachments);
  if (!attachments) {
    return {
      ok: false,
      reason: `${uses}, but Google reported ${instance.serviceAttachments.length === 0 ? 'no service attachments' : 'only one service attachment'} for it, and Cloudgate's two endpoints need its primary's and its reader's`,
    };
  }
  const tls = instance.transitEncryptionMode === SERVER_AUTHENTICATION;
  if (tls && !instance.ca) {
    return {
      ok: false,
      reason: `${uses}, but Google reported no CA for it, so its linked Services could not check its certificate`,
    };
  }
  const version = valkeyVersion(instance.engineVersion);
  return {
    ok: true,
    tls,
    ca: tls ? instance.ca : null,
    serviceAttachments: attachments,
    lines: [
      `${name}: existing cache ${identifier}, ${version}, ${tls ? 'TLS on (rediss://)' : 'TLS off (redis://)'}, through Cloudgate's own two endpoints; used as given, Cloudgate changes nothing in it`,
    ],
  };
}

/** Its primary's attachment, then its reader's: by connection type, else as listed. */
function orderedAttachments(
  listed: readonly ValkeyServiceAttachment[],
): { readonly [endpoint in ValkeyEndpoint]: string } | null {
  if (listed.length < 2) return null;
  const primary =
    listed.find((one) => one.connectionType === 'CONNECTION_TYPE_PRIMARY') ??
    listed[0];
  const reader =
    listed.find((one) => one.connectionType === 'CONNECTION_TYPE_READER') ??
    listed.find((one) => one !== primary);
  if (!reader) return null;
  return {
    primary: primary.serviceAttachment,
    reader: reader.serviceAttachment,
  };
}

/** `VALKEY_8_0` as a plan line names it: `Valkey 8.0`. */
function valkeyVersion(engineVersion: string): string {
  const found = /^VALKEY_(\d+)(?:_(\d+))?$/.exec(engineVersion);
  if (!found) return engineVersion ? `Valkey (${engineVersion})` : 'Valkey';
  return `Valkey ${found[1]}${found[2] === undefined ? '' : `.${found[2]}`}`;
}

/** One of Cloudgate's endpoints as the run made it: what `--add-endpoints` names. */
export interface MadeValkeyEndpoint {
  readonly endpoint: ValkeyEndpoint;
  readonly name: string;
  readonly address: string;
  readonly pscConnectionId: string;
  readonly serviceAttachment: string;
}

/** A forwarding rule's relative name, as `--add-endpoints` must take it. */
export function forwardingRuleName(
  projectId: string,
  region: string,
  name: string,
): string {
  return `projects/${projectId}/regions/${region}/forwardingRules/${name}`;
}

/**
 * Whether the instance lists both of Cloudgate's forwarding rules as
 * registered connections: by their relative names, which Google may
 * list as full URLs.
 */
export function valkeyRegistered(
  instance: MemorystoreInstanceRead,
  rules: readonly string[],
): boolean {
  return rules.every((rule) =>
    instance.registeredForwardingRules.some(
      (listed) => listed === rule || listed.endsWith(`/${rule}`),
    ),
  );
}

/**
 * The exact command that registers Cloudgate's two endpoints on the
 * operator's instance: the step only the operator can take,
 * shown on the page after the Apply. The forwarding rules by relative name:
 * Google refuses the full URL.
 */
export function addEndpointsCommand(input: {
  readonly instance: ValkeyInstanceName;
  /** The Environment's project, where the endpoints are. */
  readonly projectId: string;
  /** The Environment network's relative name. */
  readonly network: string;
  readonly endpoints: readonly MadeValkeyEndpoint[];
}): string {
  const connections = input.endpoints.map((one) => ({
    pscConnection: {
      pscConnectionId: one.pscConnectionId,
      ipAddress: one.address,
      network: input.network,
      forwardingRule: forwardingRuleName(
        input.projectId,
        input.instance.region,
        one.name,
      ),
      serviceAttachment: one.serviceAttachment,
    },
  }));
  return `gcloud memorystore instances update ${input.instance.instance} --location=${input.instance.region} --project=${input.instance.projectId} --add-endpoints='${JSON.stringify([{ connections }])}'`;
}
