import { NETWORK_ADDRESS_RANGE } from './network-definition';
import { frame, Resources, rule } from './tofu-json';
import { ref } from '../../definitions/tofu-json';
import type { RdsPostgresVersion } from './postgres-version';
import { RDS_ENGINES } from './rds-engines';
import type { RdsEngineName } from './rds-engines';
import type { AwsAccountAccess } from './tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';
import { layNativeAws } from '../../../native/aws-lay';
import type { NativeAwsBlock } from '../../../native/aws-native';

/**
 * Cloudgate's own settings of an RDS postgres, never in the config (the AWS
 * databases spec "Schema changes"): its class (the size rule's, or Cloudgate's
 * when the entry has no size), storage start and autoscale ceiling, Multi-AZ and
 * backup retention. Editing them is the console's.
 */
export interface RdsPostgresSettings {
  readonly instanceClass: string;
  readonly storageGb: number;
  readonly maxStorageGb: number;
  readonly multiAz: boolean;
  readonly backupRetentionDays: number;
}

/** What a new RDS postgres starts with. */
export const RDS_POSTGRES_DEFAULTS: Omit<RdsPostgresSettings, 'instanceClass'> =
  {
    storageGb: 20,
    maxStorageGb: 200,
    multiAz: false,
    backupRetentionDays: 7,
  };

/** The ids of the Environment network a database sits in. */
export interface DatabaseNetworkIds {
  readonly vpcId: string;
  /** The network's two private subnets, one per zone. */
  readonly privateSubnetIds: readonly [string, string];
}

export interface RdsDatabaseDefinitionInput {
  /**
   * `postgres` or `mysql`: the instance's `engine`, and the port its
   * security group opens. Every other argument is the same for both.
   */
  readonly engine: RdsEngineName;
  readonly configName: string;
  /** The Service's id, which names the instance. */
  readonly serviceId: string;
  readonly account: AwsAccountAccess & { readonly cloudAccountId: string };
  readonly region: string;
  readonly environmentId: string;
  /** The Service's Infrastructure state. */
  readonly stateId: string;
  readonly network: DatabaseNetworkIds;
  /** The engine's version rule's reading (`rdsPostgresVersion`, `rdsMysqlVersion`). */
  readonly version: Pick<
    RdsPostgresVersion,
    'engineVersion' | 'autoMinorUpgrade'
  >;
  readonly settings: RdsPostgresSettings;
  /**
   * `allow_major_version_upgrade`: set only for the run of an Apply that
   * approved a major upgrade, never kept; off otherwise.
   */
  readonly allowMajorUpgrade?: boolean;
  /** The master user and initial database: the config's `user` and `database`. */
  readonly login: {
    readonly user: string;
    readonly database: string;
    /** Cloudgate's generated password; reaches `tofu` as a variable only. */
    readonly password: string;
  };
  /** What the final snapshot is named after (the AWS databases spec). */
  readonly finalSnapshot: {
    readonly projectName: string;
    readonly environmentName: string;
    /** `YYYY-MM-DD`. */
    readonly date: string;
  };
  /**
   * Written by a Delete's run alone, just before its destroy, which
   * reads both settings from the state: deletion protection off, and the
   * final snapshot the Delete names — `null` when the Delete asked for the
   * data to go, which skips it.
   */
  readonly deleting?: DeletingDatabase;
  /**
   * Its `native.aws` (ADR-0044 rule 3), already checked: laid over
   * what this builder writes, field by field, before `main.tf.json` is
   * written. A plan's read lays the entry's, a Cloud run the one its row
   * holds. Absent or `null`: exactly Cloudgate's definition.
   */
  readonly native?: NativeAwsBlock | null;
}

/** What a Delete's run writes into a database's state before destroying it. */
export interface DeletingDatabase {
  /** The final snapshot's name, dated the day of the Delete; `null` skips it. */
  readonly finalSnapshot: string | null;
}

export interface RdsDatabaseDefinition {
  readonly definition: TofuDefinition;
  /**
   * Values for the definition's `sensitive` variables, passed as
   * `TF_VAR_<name>`: never written to `main.tf.json`.
   */
  readonly variables: Record<string, string>;
}

/** The variable the master password reaches `tofu` through. */
export const MASTER_PASSWORD_VARIABLE = 'master_password';

/** The address of the instance in an RDS database's definition, which a Delete's run targets. */
export const POSTGRES_INSTANCE_ADDRESS = 'aws_db_instance.database';

/** The outputs a run saves of the instance. */
export const POSTGRES_OUTPUTS = {
  address: 'endpoint_address',
  port: 'endpoint_port',
  identifier: 'instance_identifier',
} as const;

/** An RDS identifier: lower-case letters, digits and single hyphens. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The instance's identifier: `cloudgate-` and the Service's id, folded into
 * what RDS allows (lower case, letters, digits, single hyphens, no trailing
 * one). Any other character of the id becomes `x`, never a hyphen, so two
 * never run together.
 */
export function rdsInstanceIdentifier(serviceId: string): string {
  return `cloudgate-${serviceId.toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
}

/**
 * The final snapshot's name (the AWS databases spec, US73):
 * `<project>-<environment>-<service>-final-<date>`, each part folded into an
 * RDS identifier, and starting with a letter as RDS requires.
 */
export function finalSnapshotIdentifier(input: {
  projectName: string;
  environmentName: string;
  configName: string;
  date: string;
}): string {
  const name = [
    slug(input.projectName) || 'project',
    slug(input.environmentName) || 'environment',
    slug(input.configName) || 'service',
    'final',
    input.date,
  ].join('-');
  return /^[a-z]/.test(name) ? name : `db-${name}`;
}

/**
 * The OpenTofu definition of a `postgres` on RDS, its own Infrastructure
 * state (the AWS databases spec "OpenTofu generation for a postgres on AWS"), and
 * of a `mysql` on RDS, which is the same definition with MySQL's
 * engine and port. Pure: no AWS call, no `tofu`, no database.
 *
 * One `aws_db_instance` in the **Environment network**'s two private
 * subnets (its own DB subnet group), never publicly accessible, with its
 * own security group. Every setting is the spec's: gp3 storage growing from
 * the start to the ceiling, Multi-AZ and backup retention from Cloudgate's
 * settings, changes applied at once, deletion protection on, and a final
 * snapshot on delete named `<project>-<environment>-<service>-final-<date>`,
 * which carries the instance's tags. Storage is encrypted with AWS's own
 * key. The master password is a `sensitive` variable and never in the file.
 * `db_name` is always set: RDS makes no MySQL database without it. No
 * parameter group is named, so RDS's default one stands, and a MySQL's
 * `require_secure_transport` stays off (the AWS kinds spec).
 *
 * **The security group** (the spec's open point, settled here) admits
 * the engine's port (5432, or 3306 for MySQL) only from the network's two public subnets, where this
 * Environment's cloud Services run their tasks, and nothing else; it
 * opens no way out. A rule naming each Service's own security group would
 * need the database's state applied again for every Service created after
 * it; the subnets hold only this Environment's tasks and its load balancer,
 * which forwards to registered targets alone, so they admit the same set.
 */
export function rdsDatabaseDefinition(
  input: RdsDatabaseDefinitionInput,
): RdsDatabaseDefinition {
  const { account, network, settings, version } = input;
  const { engine, port } = RDS_ENGINES[input.engine];
  const mark = {
    cloudAccountId: account.cloudAccountId,
    environmentId: input.environmentId,
    stateId: input.stateId,
  };
  const label = (part: string) => `cloudgate/${input.configName}/${part}`;
  const identifier = rdsInstanceIdentifier(input.serviceId);
  const r = new Resources();

  const subnets = r.tagged(
    'aws_db_subnet_group',
    'database',
    label('subnets'),
    {
      name: identifier,
      description: 'Cloudgate: the Environment network private subnets',
      subnet_ids: [...network.privateSubnetIds],
    },
  );

  const group = r.tagged('aws_security_group', 'database', label('database'), {
    name: `cloudgate-database-${input.serviceId}`,
    description:
      'Cloudgate: a database, reachable from the Services of the Environment only',
    vpc_id: network.vpcId,
    ingress: NETWORK_ADDRESS_RANGE.publicSubnets.map((cidr) =>
      rule({ port, protocol: 'tcp', cidr }),
    ),
    egress: [],
  });

  const instance = r.tagged('aws_db_instance', 'database', label('database'), {
    identifier,
    engine,
    engine_version: version.engineVersion,
    auto_minor_version_upgrade: version.autoMinorUpgrade,
    allow_major_version_upgrade: input.allowMajorUpgrade ?? false,
    instance_class: settings.instanceClass,
    storage_type: 'gp3',
    allocated_storage: settings.storageGb,
    max_allocated_storage: settings.maxStorageGb,
    storage_encrypted: true,
    multi_az: settings.multiAz,
    db_name: input.login.database,
    username: input.login.user,
    password: `\${var.${MASTER_PASSWORD_VARIABLE}}`,
    port,
    db_subnet_group_name: ref(subnets, 'name'),
    vpc_security_group_ids: [ref(group, 'id')],
    publicly_accessible: false,
    apply_immediately: true,
    backup_retention_period: settings.backupRetentionDays,
    deletion_protection: !input.deleting,
    skip_final_snapshot: input.deleting?.finalSnapshot === null,
    final_snapshot_identifier: input.deleting
      ? input.deleting.finalSnapshot
      : finalSnapshotIdentifier({
          ...input.finalSnapshot,
          configName: input.configName,
        }),
    copy_tags_to_snapshot: true,
    // The provider's default, said here: a Delete's check counts the
    // instance's automated snapshots as gone with it because RDS deletes
    // them.
    delete_automated_backups: true,
  });

  const output = (value: unknown) => ({ value });
  return {
    variables: { [MASTER_PASSWORD_VARIABLE]: input.login.password },
    definition: {
      ...frame(account, input.region, mark),
      variable: {
        [MASTER_PASSWORD_VARIABLE]: {
          type: 'string',
          sensitive: true,
          nullable: false,
        },
      },
      // Native last, over everything Cloudgate wrote.
      resource: layNativeAws(r.all(), input.native),
      output: {
        [POSTGRES_OUTPUTS.address]: output(ref(instance, 'address')),
        [POSTGRES_OUTPUTS.port]: output(ref(instance, 'port')),
        [POSTGRES_OUTPUTS.identifier]: output(ref(instance, 'identifier')),
      },
    },
  };
}
