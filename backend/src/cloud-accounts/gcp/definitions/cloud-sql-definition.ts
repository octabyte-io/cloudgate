import { literal, ref } from '../../definitions/tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';
import { CLOUD_SQL_ENGINES } from './cloud-sql-engines';
import type { CloudSqlEngine, CloudSqlEngineName } from './cloud-sql-engines';
import { stateLabels } from './mark';
import { serviceName } from './names';
import { frame } from './tofu-json';
import type { GcpNetworkNames } from './stand-ins';
import { layNativeGcp } from '../../../native/gcp-lay';
import type { NativeGcpBlock } from '../../../native/gcp-native';

export interface CloudSqlDefinitionInput {
  /**
   * `postgres` or `mysql`: its `database_version`'s engine, its
   * `ssl_mode`, and whether its `root` gets a password (`CLOUD_SQL_ENGINES`).
   */
  readonly engine: CloudSqlEngineName;
  /** The Service's id, which names the instance (S4). */
  readonly serviceId: string;
  /** Cloudgate's id of the Cloud account, for the mark. */
  readonly cloudAccountId: string;
  /** The Google Cloud project the Cloud account connects. */
  readonly projectId: string;
  readonly region: string;
  readonly environmentId: string;
  /** The Service's Infrastructure state. */
  readonly stateId: string;
  /** The network's saved names, or `gcpNetworkStandIns()` before it is made. */
  readonly network: Pick<GcpNetworkNames, 'networkName'>;
  /** The machine (`db-g1-small`, `db-custom-1-3840`): the planner's, or the row's. */
  readonly tier: string;
  /** `POSTGRES_17`, `MYSQL_8_4`: the shared version rule's reading. */
  readonly databaseVersion: string;
  /** The user and initial database: the config's `user` and `database`. */
  readonly login: {
    readonly user: string;
    readonly database: string;
    /** Cloudgate's generated password; reaches `tofu` as a variable only. */
    readonly password: string;
    /**
     * A `mysql`'s `root` password, generated as the user's is and
     * reaching `tofu` the same way; unread on a `postgres`.
     */
    readonly rootPassword?: string;
  };
  /**
   * How many daily automated backups it keeps, the Service's own setting
   * (1–365): point-in-time recovery is on beside them. `null` for an
   * instance made before backups, whose definition writes no backup
   * setting, so its plan leaves it as Google has it until its catch-up.
   */
  readonly backupRetentionDays: number | null;
  /**
   * Whether point-in-time recovery is on beside the backups: the
   * planner's wanted value, on unless `native.gcp` turns it off. Turning it
   * either way restarts Postgres twice, which the plan marks. Unread when
   * no backups are written.
   */
  readonly pointInTimeRecovery: boolean;
  /**
   * The definition a Delete applies to the instance alone just before its
   * destroy: both deletion-protection flags off, everything else as
   * it is. The provider refuses to destroy an instance whose state still
   * says `deletion_protection`, which only an apply changes.
   */
  readonly deletionProtectionLifted?: boolean;
  /**
   * Its `native.gcp` (ADR-0044 rule 3), already checked: laid over
   * what this builder writes, field by field, before `main.tf.json` is
   * written: `settings` field by field, its `database_flags` whole. A
   * plan's read lays the entry's, a Cloud run the one its row holds.
   * Absent or `null`: exactly Cloudgate's definition.
   */
  readonly native?: NativeGcpBlock | null;
}

export interface CloudSqlDefinition {
  readonly definition: TofuDefinition;
  /**
   * Values for the definition's `sensitive` variables, passed as
   * `TF_VAR_<name>`: never written to `main.tf.json`.
   */
  readonly variables: Record<string, string>;
}

/** The variable the user's password reaches `tofu` through. */
export const CLOUD_SQL_PASSWORD_VARIABLE = 'user_password';

/** The variable a `mysql`'s `root` password reaches `tofu` through. */
export const CLOUD_SQL_ROOT_PASSWORD_VARIABLE = 'root_password';

/** The address of the instance in a Cloud SQL definition. */
export const CLOUD_SQL_INSTANCE_ADDRESS =
  'google_sql_database_instance.database';

/** The outputs a run saves of the instance. */
export const CLOUD_SQL_OUTPUTS = {
  /** Its Private Service Connect DNS name: the `host` Output. */
  dnsName: 'dns_name',
  /** Its own server CA, PEM: the `ca` Output. */
  ca: 'ca',
  /** The address Google gave it on the network's private link subnet. */
  privateAddress: 'private_address',
  instanceName: 'instance_name',
} as const;

/**
 * A Google `postgres`'s backup retention: 7 daily backups by
 * default, 1 to 365 (Google's range). 0 is refused: it would turn automated
 * backups and point-in-time recovery off.
 */
export const CLOUD_SQL_BACKUP_RETENTION = {
  default: 7,
  min: 1,
  max: 365,
} as const;

/**
 * The days of transaction log point-in-time recovery keeps: Google's most
 * on the Enterprise edition, never more than the backups kept.
 */
const TRANSACTION_LOG_DAYS = 7;

/** Cloud SQL's edition: always Enterprise. */
export const CLOUD_SQL_EDITION = 'ENTERPRISE';

/** A CA of the instance's own, for its whole life. */
export const CLOUD_SQL_CA_MODE = 'GOOGLE_MANAGED_INTERNAL_CA';

/** The DNS names entry whose name is the instance's PSC name. */
const PSC_CONNECTION_TYPE = 'PRIVATE_SERVICE_CONNECT';

/**
 * The suffix of the PSC name Google's own automation records for the
 * consumer network (`recordManager: CLOUD_SQL_AUTOMATION`), in the
 * `sql-psc.goog.` zone it makes there (the live walk).
 */
const PSC_AUTOMATED_DNS_SUFFIX = '.sql-psc.goog';

/**
 * The OpenTofu definition of a `postgres` on Cloud SQL, its own
 * Infrastructure state (the Google Cloud databases spec "Postgres on Cloud SQL"), and of a
 * `mysql` by the same rules with MySQL's parameters (`CLOUD_SQL_ENGINES`): a
 * MySQL `database_version`, **TLS offered, not
 * required** (`ALLOW_UNENCRYPTED_AND_ENCRYPTED`, written, never left to
 * Google's default) beside the same pinned CA, and a
 * password for its `root`, which exists from create. Its app user keeps
 * Cloud SQL's `cloudsqlsuperuser`, and Cloudgate never logs into it. Pure:
 * no Google call, no `tofu`, no database.
 *
 * One Cloud SQL for PostgreSQL instance, named `cloudgate-<service key>` by
 * the Service's id as on AWS: no random suffix, since Google lets a
 * deleted instance's name be used again at once, and a Service made again
 * (a destroy and a create, or a Config name renamed) is a new Service id and
 * so a new name beside the old one. Its user and its initial database are
 * their own resources, which a destroy leaves to the instance's own
 * removal (`ABANDON`: Postgres refuses to drop a user that owns objects).
 *
 * Every setting is the spec's: the **Enterprise** edition on the
 * planner's machine; **encrypted connections only**, with no client
 * certificate, and **its own CA**, set here at create and never changed
 * (so `server_ca_mode` is ignored after it); **no public IP**, and
 * **Private Service Connect** with automatic connections into the
 * Environment network, through the network's private link policy, and
 * automatic DNS, so its `host` is a name the CA's certificate carries.
 * **Automated backups**, one a day, kept for the Service's retention, with
 * **point-in-time recovery** on unless the config keeps it off
 * An instance made before backups is written without them until
 * its catch-up plan's Apply.
 * **Deletion protection is on**, Google's `deletion_protection_enabled` and
 * the provider's `deletion_protection` alike, so a hand mistake cannot drop
 * it: only Cloudgate's own Delete lifts both, as its first step.
 * **Retained backups on delete** is on, so the on-demand backup that Delete
 * takes outlives the instance until the operator deletes it. Google's
 * `final_backup_config` is never set: it expires. Cloud SQL
 * takes no `description`, so the mark is its labels.
 */
export function cloudSqlDefinition(
  input: CloudSqlDefinitionInput,
): CloudSqlDefinition {
  const labels = stateLabels({
    cloudAccountId: input.cloudAccountId,
    environmentId: input.environmentId,
    stateId: input.stateId,
  });
  const instance = CLOUD_SQL_INSTANCE_ADDRESS;
  const engine = CLOUD_SQL_ENGINES[input.engine];
  const rootPassword = engine.rootPassword ? input.login.rootPassword : null;
  if (engine.rootPassword && !rootPassword) {
    throw new Error(`A ${engine.engine} on Cloud SQL needs a root password`);
  }
  const protectedFromDeletion = !input.deletionProtectionLifted;
  const resource = {
    google_sql_database_instance: {
      database: {
        name: serviceName(input.serviceId),
        region: input.region,
        database_version: input.databaseVersion,
        // A MySQL's `root` is never left without a password.
        ...(rootPassword
          ? { root_password: `\${var.${CLOUD_SQL_ROOT_PASSWORD_VARIABLE}}` }
          : {}),
        deletion_protection: protectedFromDeletion,
        settings: {
          tier: input.tier,
          edition: CLOUD_SQL_EDITION,
          user_labels: labels,
          deletion_protection_enabled: protectedFromDeletion,
          retain_backups_on_delete: true,
          ...backupConfiguration(
            input.backupRetentionDays,
            input.pointInTimeRecovery,
            engine.pointInTimeRecoveryArgument,
          ),
          ip_configuration: {
            ipv4_enabled: false,
            ssl_mode: engine.sslMode,
            server_ca_mode: CLOUD_SQL_CA_MODE,
            psc_config: [
              {
                psc_enabled: true,
                psc_auto_dns_enabled: true,
                allowed_consumer_projects: [input.projectId],
                psc_auto_connections: [
                  {
                    consumer_network: `projects/${input.projectId}/global/networks/${input.network.networkName}`,
                    consumer_service_project_id: input.projectId,
                  },
                ],
              },
            ],
          },
        },
        lifecycle: {
          ignore_changes: [
            // Set at create, never changed by Cloudgate: a new CA would
            // break every app given the old one as `ca`.
            'settings[0].ip_configuration[0].server_ca_mode',
            // Stop and Start's, by a direct call: an Apply never
            // starts a stopped instance, and a plan never counts Stop as a
            // change.
            'settings[0].activation_policy',
          ],
        },
      },
    },
    google_sql_database: {
      database: {
        name: literal(input.login.database),
        instance: ref(instance, 'name'),
        deletion_policy: 'ABANDON',
      },
    },
    google_sql_user: {
      user: {
        name: literal(input.login.user),
        instance: ref(instance, 'name'),
        password: `\${var.${CLOUD_SQL_PASSWORD_VARIABLE}}`,
        deletion_policy: 'ABANDON',
      },
    },
  };

  const secret = { type: 'string', sensitive: true, nullable: false };
  return {
    variables: {
      [CLOUD_SQL_PASSWORD_VARIABLE]: input.login.password,
      ...(rootPassword
        ? { [CLOUD_SQL_ROOT_PASSWORD_VARIABLE]: rootPassword }
        : {}),
    },
    definition: {
      ...frame(input.projectId, input.region),
      variable: {
        [CLOUD_SQL_PASSWORD_VARIABLE]: secret,
        ...(rootPassword ? { [CLOUD_SQL_ROOT_PASSWORD_VARIABLE]: secret } : {}),
      },
      // Native last, over everything Cloudgate wrote.
      resource: layNativeGcp(resource, input.native),
      output: {
        [CLOUD_SQL_OUTPUTS.dnsName]: {
          // Google lists two PSC names (the live walk): `….sql.goog.`,
          // whose record is the customer's to make, and `….sql-psc.goog`,
          // which its own automation records in the network's private zone.
          // Only the second resolves from the Environment network. It is
          // handed out exactly as Google reports it, as an existing
          // instance's `….sql.goog.` name is: libpq's
          // `verify-full` compares it with the certificate's letter for
          // letter, and a live walk found it reported, and carried by
          // the certificate, with no trailing dot. The match alone ignores
          // a dot.
          value: `\${try(one([for entry in ${instance}.dns_names : entry.name if entry.connection_type == "${PSC_CONNECTION_TYPE}" && endswith(trimsuffix(entry.name, "."), "${PSC_AUTOMATED_DNS_SUFFIX}")]), "")}`,
        },
        [CLOUD_SQL_OUTPUTS.ca]: {
          value: `\${${instance}.server_ca_cert[0].cert}`,
          sensitive: true,
        },
        [CLOUD_SQL_OUTPUTS.privateAddress]: {
          value: `\${try(one(flatten([for config in ${instance}.settings[0].ip_configuration[0].psc_config : [for connection in config.psc_auto_connections : connection.ip_address]])), "")}`,
        },
        [CLOUD_SQL_OUTPUTS.instanceName]: { value: ref(instance, 'name') },
      },
    },
  };
}

/**
 * Daily automated backups kept `days` by count (Cloud SQL takes one a day),
 * and point-in-time recovery, when on, over the transaction logs of the
 * last days, or nothing for an instance made before backups. `argument` is
 * the engine's switch for it: a MySQL's binary log.
 */
function backupConfiguration(
  days: number | null,
  pointInTimeRecovery: boolean,
  argument: CloudSqlEngine['pointInTimeRecoveryArgument'],
) {
  if (days === null) return {};
  return {
    backup_configuration: {
      enabled: true,
      [argument]: pointInTimeRecovery,
      transaction_log_retention_days: Math.min(TRANSACTION_LOG_DAYS, days),
      backup_retention_settings: {
        retained_backups: days,
        retention_unit: 'COUNT',
      },
    },
  };
}
