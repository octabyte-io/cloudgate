import { RDS_ENGINES } from '../../aws/definitions/rds-engines';
import type { CloudSqlInstanceRead } from '../../google-cloud.port';
import {
  CLOUD_SQL_ENGINES,
  cloudSqlMajorOf,
} from '../definitions/cloud-sql-engines';
import type { CloudSqlEngineName } from '../definitions/cloud-sql-engines';
import { LABEL_KEYS } from '../definitions/mark';

/**
 * An Existing database that is a Cloud SQL `postgres` on Google Cloud
 * (ADR-0033 as amended), or a `mysql` by the same
 * rules: the connection name the operator gives, and how each
 * plan's lookup of the instance is judged. Pure: the instance is read
 * through the Google client port by the caller.
 */

/** A Cloud SQL connection name, `project:region:instance`, in its parts. */
export interface CloudSqlConnectionName {
  readonly projectId: string;
  readonly region: string;
  readonly instance: string;
}

/**
 * A connection name as Google writes one: a project id (a domain-scoped one,
 * `example.com:project`, keeps its own colon), a region, an instance name.
 */
const CONNECTION_NAME =
  /^((?:[a-z][a-z0-9.-]*[a-z0-9]:)?[a-z][a-z0-9-]{4,28}[a-z0-9]):([a-z]+-[a-z]+[0-9]+):([a-z][a-z0-9-]{0,96}[a-z0-9]|[a-z])$/;

export function parseConnectionName(
  text: string,
): CloudSqlConnectionName | null {
  const found = CONNECTION_NAME.exec(text);
  if (!found) return null;
  return { projectId: found[1], region: found[2], instance: found[3] };
}

/** What the Cloud SQL Admin API answered for the instance. */
export type CloudSqlLookup =
  | { readonly kind: 'found'; readonly instance: CloudSqlInstanceRead }
  /** `NOT_FOUND`: there is no such instance. */
  | { readonly kind: 'missing' }
  /** `PERMISSION_DENIED`: Cloudgate's service account may not read it. */
  | { readonly kind: 'unreadable'; readonly message: string };

/** What a lookup is judged against: the Service and the Environment's place. */
export interface ExistingCloudSqlContext {
  /** The kind the Service is: the engine its instance must run. */
  readonly engine: CloudSqlEngineName;
  readonly serviceName: string;
  /** As the operator gave it. */
  readonly connectionName: string;
  /** The Environment's own project: where Cloudgate's endpoint is made. */
  readonly project: {
    readonly projectId: string;
    readonly projectNumber: string;
  };
  /** The Environment's region. */
  readonly region: string;
  /** The deploy service account's email, which the read grant names. */
  readonly serviceAccount: string;
  /** The config's `version` when it states one (`postgres:17`, `mysql:8.4`), else `null`. */
  readonly configVersion: string | null;
}

export type ExistingCloudSqlVerdict =
  | {
      readonly ok: false;
      readonly reason: string;
      /** Google has no such instance: its page says "Google Cloud cannot find" it. */
      readonly missing?: true;
    }
  | {
      readonly ok: true;
      /** The `….sql.goog.` name exactly as Google reports it, and its engine's port. */
      readonly address: { readonly host: string; readonly port: number };
      /** The server CA the instance reports: the `ca` Output. */
      readonly ca: string;
      /** Where Cloudgate's endpoint points. */
      readonly serviceAttachment: string;
      /** The plan's lines for it, notes included. */
      readonly lines: string[];
    };

/** Cloud SQL's setting that asks every client for a certificate of its own. */
const CLIENT_CERTIFICATES_REQUIRED = 'TRUSTED_CLIENT_CERTIFICATE_REQUIRED';

/**
 * The grant an instance in another project needs before every plan can look
 * it up: read on Cloud SQL there, for Cloudgate's service account.
 */
export function cloudSqlViewerGrant(
  projectId: string,
  serviceAccount: string,
): string {
  return `gcloud projects add-iam-policy-binding ${projectId} --member=serviceAccount:${serviceAccount} --role=roles/cloudsql.viewer`;
}

/**
 * Whether an Existing database's Cloud SQL instance can be used as given
 * (ADR-0033), each refusal naming its fix:
 *
 * - not found, or not readable (with the read grant for another project);
 * - not the Service's engine: not PostgreSQL for a `postgres`, not MySQL
 *   for a `mysql`;
 * - Cloudgate's own labels (one Cloudgate made, for this or another
 *   Environment);
 * - another region than the Environment's;
 * - Private Service Connect off, with Google's patch command and what it
 *   costs (about 8 minutes, about 45 s down); a public-IP-only instance
 *   needs a private IP first;
 * - the Environment's project not on its allowed consumer projects — even
 *   its own project, since the walk saw the endpoint sit `PENDING`
 *   there — with a command that keeps the projects already listed, since
 *   Google's flag replaces the list;
 * - client certificates required;
 * - no `recordManager: CUSTOMER` `….sql.goog.` name, which its certificate
 *   carries: there is no IP fallback.
 *
 * A major version other than the config's is a note, not a refusal.
 */
export function judgeExistingCloudSql(
  lookup: CloudSqlLookup,
  context: ExistingCloudSqlContext,
): ExistingCloudSqlVerdict {
  const { serviceName: name, connectionName } = context;
  const uses = `${name} uses the existing database ${connectionName}`;
  const parts = parseConnectionName(connectionName);
  if (!parts) {
    return {
      ok: false,
      reason: `${uses}, which is not a Cloud SQL connection name; give it as project:region:instance on ${name}'s page`,
    };
  }
  const elsewhere = parts.projectId !== context.project.projectId;
  const grant = elsewhere
    ? `; it is in another project, so grant Cloudgate's service account read on Cloud SQL there: \`${cloudSqlViewerGrant(parts.projectId, context.serviceAccount)}\``
    : '';
  if (lookup.kind === 'missing') {
    return {
      ok: false,
      missing: true,
      reason: `${uses}, but Google Cloud cannot find Cloud SQL instance ${parts.instance} in project ${parts.projectId}. Check the connection name on ${name}'s page${grant}`,
    };
  }
  if (lookup.kind === 'unreadable') {
    return {
      ok: false,
      reason: `${uses}, but Cloudgate may not read it (${lookup.message})${grant || `; give Cloudgate's service account read on Cloud SQL in ${parts.projectId}: \`${cloudSqlViewerGrant(parts.projectId, context.serviceAccount)}\``}`,
    };
  }
  const { instance } = lookup;
  const engine = CLOUD_SQL_ENGINES[context.engine];
  const patch = `gcloud sql instances patch ${parts.instance} --project=${parts.projectId}`;
  if (!instance.databaseVersion.startsWith(engine.versionPrefix)) {
    return {
      ok: false,
      reason: `${uses}, but it runs ${instance.databaseVersion || 'another engine'}, not ${engine.label}, so a ${engine.engine} cannot use it`,
    };
  }
  const ours = Object.keys(instance.labels)
    .filter((key) => (Object.values(LABEL_KEYS) as string[]).includes(key))
    .sort();
  if (ours.length > 0) {
    return {
      ok: false,
      reason: `${uses}, but it carries Cloudgate's labels (${ours.join(', ')}), so Cloudgate made it for an Environment; an existing database must be one Cloudgate did not make`,
    };
  }
  if (instance.region !== context.region) {
    return {
      ok: false,
      reason: `${uses}, but it is in ${instance.region || 'a region Google did not name'}, not this Environment's region ${context.region}; an existing database must be in the Environment's region`,
    };
  }
  if (!instance.pscEnabled || !instance.serviceAttachment) {
    const privateFirst =
      instance.privateNetwork === null && instance.publicIp
        ? ' It has only a public IP, so give it a private IP first (private services access), then turn Private Service Connect on.'
        : '';
    return {
      ok: false,
      reason: `${uses}, but it has Private Service Connect off, and that is how Cloudgate reaches it without peering any network. Turn it on, allowing this Environment's project: \`${patch} --enable-private-service-connect --allowed-psc-projects=${allowedWith(instance.allowedConsumerProjects, context.project.projectId)}\`. Google takes about 8 minutes, about 45 s of which the instance is down.${privateFirst}`,
    };
  }
  const allowed = instance.allowedConsumerProjects.some(
    (one) =>
      one === context.project.projectId ||
      one === context.project.projectNumber ||
      one === `projects/${context.project.projectNumber}`,
  );
  if (!allowed) {
    return {
      ok: false,
      reason: `${uses}, but this Environment's project ${context.project.projectId} is not on its allowed consumer projects, so Cloudgate's endpoint would wait PENDING and never connect. Add it, keeping the projects already listed (Google's flag replaces the list): \`${patch} --allowed-psc-projects=${allowedWith(instance.allowedConsumerProjects, context.project.projectId)}\``,
    };
  }
  if (instance.sslMode === CLIENT_CERTIFICATES_REQUIRED) {
    return {
      ok: false,
      reason: `${uses}, but it requires a client certificate of every connection (${CLIENT_CERTIFICATES_REQUIRED}), and Cloudgate's Outputs carry none. Let it take encrypted connections without one: \`${patch} --ssl-mode=${engine.sslMode}\``,
    };
  }
  const own = instance.dnsNames.find(
    (one) =>
      one.recordManager === 'CUSTOMER' &&
      (one.connectionType === null ||
        one.connectionType === 'PRIVATE_SERVICE_CONNECT') &&
      one.name.replace(/\.$/, '').endsWith('.sql.goog'),
  );
  if (!own) {
    return {
      ok: false,
      reason: `${uses}, but it reports no \`….sql.goog.\` name of its own (recordManager CUSTOMER), the name its certificate carries; Cloudgate reaches an existing instance only by that name, never by its endpoint's IP`,
    };
  }
  if (!instance.serverCa) {
    return {
      ok: false,
      reason: `${uses}, but Google reported no server CA for it, so its linked Services could not check its certificate`,
    };
  }
  const running = cloudSqlMajorOf(engine, instance.databaseVersion);
  const lines = [
    `${name}: existing database ${connectionName}, ${engine.label} ${running ?? instance.databaseVersion}, at ${own.name}:${engine.port} through Cloudgate's own endpoint; used as given, Cloudgate changes nothing in it`,
  ];
  const wanted = RDS_ENGINES[context.engine].majorOf(context.configVersion);
  if (wanted !== null && running !== null && wanted !== running) {
    lines.push(
      `${name}: ${connectionName} runs ${engine.label} ${running}, and the config's version is ${wanted}; the version is not applied to an existing database`,
    );
  }
  return {
    ok: true,
    address: { host: own.name, port: engine.port },
    ca: instance.serverCa,
    serviceAttachment: instance.serviceAttachment,
    lines,
  };
}

/** The allowed consumer projects as listed, with `projectId` added once. */
function allowedWith(listed: readonly string[], projectId: string): string {
  return [...new Set([...listed, projectId])].join(',');
}
