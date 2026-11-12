import type {
  ApplicationConfigKind,
  BuildType,
  ServiceType,
} from '../../applications/application.schema';
import type { BucketFiles } from '../../buckets/bucket-files';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import type { PlanReading } from '../../cloud-accounts/aws/plan-reader/read-plan';
import type { NetworkLinkKind } from '../../cloud-accounts/definitions/network-links';
import type { DnsRecord } from '../../domains/domain.schema';
import type { NativeAwsBlock } from '../../native/aws-native';
import type { StackVmMonthly } from '../../cloud-accounts/definitions/stack-vm';
import type { StackVmPins } from '../../cloud-accounts/definitions/stack-vm-pins';
import type { NativeGcpBlock } from '../../native/gcp-native';
import type { DockerSettings } from '../../native/docker-native';
import type { ComposeSourceType } from '../../compose/dto/compose.dto';
import type { SourceType } from '../../git-providers/git-provider.schema';
import type {
  EXPRESSIBLE_KINDS,
  ExpressibleServiceType,
} from '../format/config-schema';
import type { Size, SizeName } from '../format/config-size';
import type { ConfigLinks, ProjectConfig } from '../project-config.types';
import type { VariableList } from './fields';

/**
 * Where a Service that a plan creates will run (`CONTEXT.md`, **Deploy
 * target**): the Environment's `deployTarget`, restated here so the
 * planner's input is its own module's type. The environments module's
 * `deployTargetSchema` is what a stored one was checked against.
 */
export type DeployTarget =
  | { readonly kind: 'server'; readonly serverId: string }
  | { readonly kind: 'platform-host' }
  | {
      readonly kind: 'cloud';
      readonly cloudAccountId: string;
      readonly region: string;
    };

/** A kind a version 1 entry may describe (as opposed to `managed: console`). */
export type ConfigKind = (typeof EXPRESSIBLE_KINDS)[number];

/** The variable-name lists the config owns, by their wire names. */
export type { VariableList };

/**
 * The keys (never the values) of a Service's variable blobs in this
 * Environment. `buildArgs` and `buildSecrets` are an Application's only.
 */
export interface SavedVariableKeys {
  readonly env: readonly string[];
  readonly buildArgs?: readonly string[];
  readonly buildSecrets?: readonly string[];
}

/**
 * An Application's saved settings for the fields the config owns,
 * named as their columns are. Nothing Cloudgate owns is here — branch,
 * connection, Domains, replicas — so a plan cannot diff it.
 */
export interface SavedApplicationSettings {
  /** Its recorded kind in config terms, never its build type's. */
  readonly configKind: ApplicationConfigKind;
  readonly description: string | null;
  readonly cpuLimit: string | null;
  readonly memoryLimit: string | null;
  readonly command: string | null;
  readonly args: readonly string[] | null;
  readonly port: number;
  /** A Cron service's timetable; `null` on every other kind. */
  readonly cronSchedule: string | null;
  readonly cronTimezone: string | null;
  readonly cronTimeoutSeconds: number | null;
  readonly sourceType: SourceType;
  readonly owner: string | null;
  readonly repository: string | null;
  readonly buildPath: string | null;
  readonly gitlabOwner: string | null;
  readonly gitlabRepository: string | null;
  readonly gitlabPathNamespace: string | null;
  readonly gitlabBuildPath: string | null;
  readonly giteaOwner: string | null;
  readonly giteaRepository: string | null;
  readonly giteaBuildPath: string | null;
  readonly bitbucketOwner: string | null;
  readonly bitbucketRepository: string | null;
  readonly bitbucketBuildPath: string | null;
  readonly customGitUrl: string | null;
  readonly customGitBuildPath: string | null;
  readonly dockerImage: string | null;
  readonly buildType: BuildType;
  readonly railpackVersion: string | null;
  readonly herokuVersion: string | null;
  readonly dockerfile: string | null;
  readonly dockerContextPath: string | null;
  readonly dockerBuildStage: string | null;
  readonly publishDirectory: string | null;
  readonly isStaticSpa: boolean | null;
  readonly createEnvFile: boolean;
  readonly enableSubmodules: boolean;
  readonly watchPaths: readonly string[] | null;
}

export interface SavedPostgresSettings {
  readonly description: string | null;
  readonly cpuLimit: string | null;
  readonly memoryLimit: string | null;
  readonly dockerImage: string;
  readonly databaseName: string;
  readonly databaseUser: string;
}

/** A MySQL's are a postgres's: the same fields, the same columns. */
export type SavedMysqlSettings = SavedPostgresSettings;

export interface SavedRedisSettings {
  readonly description: string | null;
  readonly cpuLimit: string | null;
  readonly memoryLimit: string | null;
  readonly dockerImage: string;
}

/** A Bucket's: its description and its real name, which no config writes. */
export interface SavedBucketSettings {
  readonly description: string | null;
  readonly bucketName: string;
  /**
   * Whether a bucket on a Server has a Domain now, which its
   * `endpoint` is while it has one; `false` is noted on every plan that
   * keeps it. Absent where a bucket has no Domains at all.
   */
  readonly hasDomain?: boolean;
}

/**
 * A Compose stack's saved settings for the fields a `compose` entry owns
 * (ADR-0069): where its compose file comes from, the file's path and how
 * it is deployed. The branch, the connection, Domains, mounts and variables
 * are Cloudgate's, so none is here and a plan cannot diff one.
 */
export interface SavedComposeSettings {
  readonly sourceType: ComposeSourceType;
  readonly owner: string | null;
  readonly repository: string | null;
  readonly gitlabOwner: string | null;
  readonly gitlabRepository: string | null;
  readonly gitlabPathNamespace: string | null;
  readonly giteaOwner: string | null;
  readonly giteaRepository: string | null;
  readonly bitbucketOwner: string | null;
  readonly bitbucketRepository: string | null;
  readonly customGitUrl: string | null;
  /** As stored, `./docker-compose.yml` by default. */
  readonly composePath: string;
  readonly composeType: 'docker-compose' | 'stack';
}

/**
 * A Compose stack's Stack VM as a plan reads it (ADR-0070): its place,
 * which never moves (ADR-0035), whether its Apply made it yet, what its
 * data disk holds, and the size its console setting asks for; and what a
 * plan compares it by (#1368): what its last Apply wrote and the pins it was
 * made with. Present only on a stack whose place is a Cloud account, never
 * beside `serverId`.
 */
export interface SavedStackVm {
  readonly cloudAccountId: string;
  readonly region: string;
  readonly cloud: CloudKind;
  /**
   * Whether a Cloud run recorded what it made. A stack the console created
   * in a Cloud Environment has none until the plan that makes it is
   * applied (#1372).
   */
  readonly made: boolean;
  /** The machine type it runs, or was written down to start at. */
  readonly machineType: string;
  /** The data disk it has, or starts at. */
  readonly dataDiskGb: number;
  /**
   * The size set in the console: a console-managed stack's, which its
   * plans size the Stack VM to as a described stack's entry `size` does
   * (#1372). `null` when none was set, which is `medium`.
   */
  readonly consoleSize: SizeName | null;
  /** The data disk grown to in the console, at least {@link dataDiskGb}; `null` when not grown. */
  readonly consoleDataDiskGb: number | null;
  /**
   * The size its last Apply planned it at, or `null` when its `native`
   * set the machine type (#1368).
   */
  readonly sizeName: SizeName | null;
  readonly snapshotDays: number;
  /** The `native.aws` its last Apply laid; absent when none. */
  readonly native?: NativeAwsBlock;
  /** The `native.gcp` its last Apply laid; absent when none. */
  readonly nativeGcp?: NativeGcpBlock;
  /**
   * The pins it was made with (#1368): what a "replace VM" line compares
   * with Cloudgate's. `null` until its Apply has made it.
   */
  readonly pins: StackVmPins | null;
}

/**
 * What a `static` site on S3 + CloudFront is written from: of its
 * config, only `spa` reaches its definition. `source`, `publish` and the
 * rest are its deploys'; the container-only fields mean nothing there.
 */
export interface CloudStaticSite {
  readonly spa: boolean;
}

/** A bucket on AWS's origins now, and as its last Cloud run wrote them. */
export interface SavedBucketCors {
  readonly origins: readonly string[];
  /** `null` until its first Cloud run ends, which is read as none. */
  readonly applied: readonly string[] | null;
}

/**
 * A bucket's CORS a change on AWS writes: its browser-upload origins
 * as the last Cloud run wrote them and as the bucket's page holds them now.
 * Cloudgate's, never the config's, so it is not a field.
 */
export interface BucketCorsChange {
  readonly from: readonly string[];
  readonly to: readonly string[];
}

interface SavedBase {
  readonly serviceId: string;
  /** The display name, Cloudgate's label; never what a plan matches on. */
  readonly name: string;
  readonly configName: string;
  /**
   * An Application's cloud place (ADR-0035), present only on one in a Cloud
   * account, with the Registries linked to it by name: a cloud Service's
   * image goes to its own ECR repository, so a plan describing it refuses
   * a linked one. Absent, not `null`, elsewhere, so the fingerprint
   * of a Service on a Server is what it was. A postgres in a Cloud account
   * has one too, with no Registries.
   */
  readonly cloud?: SavedCloudPlace;
  /**
   * The Server it runs on, absent on the platform host and in a Cloud
   * account: where a wired variable's source must be for it to be reached
   * (ADR-0031).
   */
  readonly serverId?: string;
  /**
   * The links its config entry last applied (ADR-0031), by variable name;
   * absent when it has none, so a Service with none fingerprints as before.
   */
  readonly links?: ConfigLinks;
  /**
   * The seven Swarm settings `native.docker` owns, as its Swarm
   * columns hold them: an Application's or a database's. Absent when none
   * is set, so a Service with none fingerprints as before.
   */
  readonly docker?: DockerSettings;
  /**
   * The `native.aws` its last Apply laid (ADR-0044), as written: an
   * Application's on ECS, a static site's on S3 and CloudFront, or a
   * bucket's on S3. Absent when it has none, so a Service with none
   * fingerprints as before.
   */
  readonly nativeAws?: NativeAwsBlock;
  /**
   * The `native.gcp` its last Apply laid (ADR-0044), as written: an
   * Application's on Cloud Run, a postgres's on Cloud SQL or a redis's on
   * Memorystore. Absent when it has none, so a Service with none
   * fingerprints as before.
   */
  readonly nativeGcp?: NativeGcpBlock;
  /**
   * Whether an Application on Google Cloud has a Domain now: what
   * closing its `run.app` address warns of when it has none. Absent
   * elsewhere, so a Service off Google Cloud fingerprints as before.
   */
  readonly hasDomain?: boolean;
}

export interface SavedCloudPlace {
  readonly cloudAccountId: string;
  readonly region: string;
  /**
   * The cloud its Cloud account is in (the Google Cloud spec S17), which decides what a
   * change to a database there is checked against. Absent is `aws`,
   * so the fingerprint of a Service on AWS is what it was.
   */
  readonly cloud?: CloudKind;
  readonly linkedRegistries: readonly {
    readonly as: 'Registry' | 'build Registry';
    readonly name: string;
  }[];
}

/**
 * An Existing database's place (ADR-0033): the Cloud account and
 * region it is looked up in, fixed at its creation, its identifier there,
 * and the operator's "I made it reachable from this Environment" tick.
 */
export interface SavedExistingPlace {
  readonly cloudAccountId: string;
  readonly region: string;
  readonly identifier: string;
  readonly madeReachable: boolean;
}

/**
 * A switch between a Cloudgate-made and an existing database: which
 * way, and the RDS identifier it goes to (`null` going to a made one).
 */
export interface SavedSwitch {
  readonly to: 'existing' | 'made';
  readonly identifier: string | null;
}

/**
 * An existing bucket's place (ADR-0033): the Cloud account and region
 * it is looked up in, fixed at its creation, and its name there.
 */
export interface SavedExistingBucketPlace {
  readonly cloudAccountId: string;
  readonly region: string;
  readonly bucketName: string;
  /**
   * Its Cloud account's cloud, said only on Google Cloud, where it is
   * reached by its own key, so a link to that key has a value; absent is AWS,
   * whose place reads as it did before Google could be one.
   */
  readonly cloud?: 'gcp';
}

/**
 * The lookup of an Existing database a plan makes on its step: which
 * database, and the config's `version` (`postgres:17`) when it states one,
 * which a different major is noted against. Its AWS lines say what was found.
 * An existing bucket's is the same step: `identifier` is the bucket's
 * name, and `version` always `null`.
 */
export interface ExistingDatabaseLookup {
  readonly identifier: string;
  readonly version: string | null;
}

/**
 * One Service as this Environment has saved it. Matched to a config entry by
 * `configName` only, and compared with saved settings, never with what a
 * container is doing (US20).
 */
export type SavedService =
  | (SavedBase & {
      readonly serviceType: 'application';
      readonly settings: SavedApplicationSettings;
      readonly variables: SavedVariableKeys;
    })
  | (SavedBase & {
      readonly serviceType: 'postgres';
      readonly settings: SavedPostgresSettings;
      readonly variables: SavedVariableKeys;
      /**
       * Cloudgate's own settings of a postgres on RDS, present only
       * beside `cloud`: what the console holds now and what the last Apply
       * wrote, so a console edit plans as a change.
       */
      readonly rds?: SavedRdsSettings;
      /**
       * Cloudgate's own setting of a postgres on Cloud SQL, present
       * only beside a Google `cloud`: its backup retention, now and as the
       * last Apply wrote it, so an edit on its Backups tab plans as a
       * change.
       */
      readonly cloudSql?: SavedCloudSqlSettings;
      /**
       * Present only on an **Existing database** (ADR-0033): the
       * database it uses as given, and where it is looked up. Never beside
       * `cloud` or `serverId`.
       */
      readonly existing?: SavedExistingPlace;
      /**
       * A switch the operator asked for on its page (ADR-0033): to an
       * existing database (`identifier`), or, on an Existing database, to
       * one Cloudgate makes. The plan removes this Service and adds the
       * other. Absent when none is asked for.
       */
      readonly switching?: SavedSwitch;
    })
  | (SavedBase & {
      readonly serviceType: 'mysql';
      readonly settings: SavedMysqlSettings;
      readonly variables: SavedVariableKeys;
      /**
       * Cloudgate's own settings of a mysql on RDS, as a
       * postgres's on RDS: present only beside `cloud`.
       */
      readonly rds?: SavedRdsSettings;
      /**
       * Cloudgate's own setting of a mysql on Cloud SQL, as a
       * postgres's on Cloud SQL: present only beside a Google `cloud`.
       */
      readonly cloudSql?: SavedCloudSqlSettings;
      /**
       * Present only on an Existing database that is an RDS for MySQL
       * instance (ADR-0033), as on a postgres. Never beside `cloud`
       * or `serverId`.
       */
      readonly existing?: SavedExistingPlace;
      /** A switch the operator asked for on its page, as a postgres's. */
      readonly switching?: SavedSwitch;
    })
  | (SavedBase & {
      readonly serviceType: 'redis';
      readonly settings: SavedRedisSettings;
      readonly variables: SavedVariableKeys;
      /**
       * Cloudgate's own settings of a redis on ElastiCache, present
       * only beside `cloud`: what the console holds now and what the last
       * Apply wrote, so a console edit plans as a change.
       */
      readonly elasticache?: SavedElastiCacheSettings;
      /**
       * Cloudgate's own setting of a redis on Memorystore (the Google Cloud databases spec
       * "Schema changes"), present only beside a Google `cloud`: high
       * availability, which adds a replica in another zone, now and
       * as the last Apply wrote it, so a console edit plans as a change.
       */
      readonly memorystore?: SavedMemorystoreSettings;
      /**
       * Present only on an **Existing database** that is a replication
       * group the operator already has (ADR-0033). Never beside
       * `cloud` or `serverId`.
       */
      readonly existing?: SavedExistingPlace;
      /**
       * A switch the operator asked for on its page (ADR-0033), as a
       * postgres's: to an existing replication group, or, on an Existing
       * cache, to one Cloudgate makes. Absent when none is asked for.
       */
      readonly switching?: SavedSwitch;
    })
  | (SavedBase & {
      readonly serviceType: 'bucket';
      readonly settings: SavedBucketSettings;
      /** A bucket reads no variables, so it holds none. */
      readonly variables: SavedVariableKeys;
      /**
       * A bucket on AWS's browser-upload origins, present only beside
       * `cloud`: what its page holds now and what its last Cloud run wrote
       * to the S3 bucket's CORS, so an edit plans as a CORS change. On a
       * Server its Garage takes an edit at once, so a plan never reads them.
       */
      readonly cors?: SavedBucketCors;
      /**
       * Present only on an **existing bucket** (ADR-0033): the bucket
       * it uses as given, and where it is looked up. Never beside `cloud`.
       */
      readonly existing?: SavedExistingBucketPlace;
    })
  | (SavedBase & {
      readonly serviceType: 'compose';
      readonly settings: SavedComposeSettings;
      /** The config names none of a stack's variables, so it holds none. */
      readonly variables: SavedVariableKeys;
      /**
       * Its Stack VM, made or still to be made, present only on a stack
       * whose place is a Cloud account (ADR-0070). Absent on a Server and
       * the platform host, so their fingerprints are what they were.
       */
      readonly stackVm?: SavedStackVm;
    })
  | (SavedBase & {
      readonly serviceType: Exclude<ServiceType, ExpressibleServiceType>;
    });

/**
 * Which Services a config listed and how — each Config name's kind, and
 * whether it was `managed: console` — with no field and no value. A parsed
 * {@link ProjectConfig} is one; a plan row stores one (`plan.outline`), so a
 * repository-kept config's previous read is known without keeping its text
 * (ADR-0029).
 */
export interface ConfigOutline {
  readonly services: Readonly<
    Record<
      string,
      { readonly kind: string; readonly managed: 'console' | false }
    >
  >;
}

/** What the planner knows from Cloudgate's side beyond the saved settings. */
export interface PlanContext {
  /**
   * What the config in effect before this one listed, or `null` when
   * nothing is known: for a Cloudgate-kept config the stored text, for a
   * repository-kept one the outline of the plan the Environment last
   * settled (`previous-config.ts`). Only a Service it **described** is
   * destroyed when the config does not list it; a Service it listed as
   * `managed: console`, or did not list, is a note (US33, US34). A
   * `managed: console` line it already had is not checked again.
   */
  readonly previous: ConfigOutline | null;
}

export interface PlanInput {
  readonly config: ProjectConfig;
  readonly saved: readonly SavedService[];
  readonly deployTarget: DeployTarget;
  /**
   * The cloud a cloud Deploy target's Cloud account is in (the Google Cloud spec S17),
   * which decides the kinds a plan may create there. Absent is `aws`, the
   * one cloud a Cloud account was before slice 6. Unread on a Deploy target
   * that is not a Cloud account.
   */
  readonly cloud?: CloudKind;
  readonly context: PlanContext;
  /**
   * The Cloud accounts and regions this Environment already has an
   * **Environment network** in. A plan that creates a cloud `web`
   * where there is none makes one first, as its own step.
   */
  readonly networks?: readonly NetworkPlace[];
  /**
   * The Environment's networks a plan may remove: every one not
   * being made or removed. A plan that finds neither a Service nor the
   * Deploy target in one's Cloud account and region removes it, as its own
   * step, typed-confirmed like a Service destroy.
   */
  readonly removableNetworks?: readonly RemovableNetwork[];
  /**
   * Which of what already exists in a Cloud account this plan reads for
   * Drift (the AWS spec "When AWS is read"). A cloud Service a step
   * touches is always read; `everything` ("Check for changes") also reads
   * every other cloud Service and each made Environment network, and
   * `services` names the ones an open plan this one replaces found drift on.
   * Absent, only what a step touches is read.
   */
  readonly cloudReads?: CloudReads;
  /**
   * Switches to an existing database whose Service is gone already:
   * a Cloudgate-made instance's Delete is a Cloud run that ended after the
   * Apply that asked for it, so the entry it was is created as the
   * existing database it switches to, by Config name. A switch whose
   * Service is still saved is on that Service (`switching`).
   */
  readonly existingCreates?: readonly {
    readonly configName: string;
    /** The kind of Service the switch was asked on: only its entry takes it. */
    readonly kind: 'postgres' | 'mysql' | 'redis';
    readonly identifier: string;
  }[];
  /**
   * The Services, by id, whose live image has a `HEALTHCHECK`, as their last
   * finished deploy recorded it; `HEALTHCHECK NONE` is none.
   * Kept out of {@link SavedService}, so a deploy never moves an open
   * plan's fingerprint. Absent, none has one.
   */
  readonly imageHealthChecks?: readonly string[];
  /**
   * A Compose stack's starting size, by Config name, when the
   * Template it is set up from names a minimum (ADR-0070 "Machine"): its
   * Stack VM starts there when its entry has no `size`. Absent, a stack
   * with no size starts at `medium`. Read from the Environment's Pending
   * setups, each compose part's `size` (#1379).
   */
  readonly stackVmStartingSizes?: Readonly<Record<string, SizeName>>;
  /**
   * A cloud Deploy target's Cloud account: its name and the permissions
   * version its last passing check held its role to. A plan that would
   * make a Stack VM where that version lacks what one needs is refused
   * (#1366, `stack-vm-permissions.ts`). Absent, nothing is refused for it.
   */
  readonly cloudAccount?: {
    readonly name: string;
    readonly policyVersion: number;
  };
  /**
   * The Environment's **Pending setups** (ADR-0064, ADR-0065): what each
   * Template setup waiting here will create, and how each of its values is
   * made. Never a value: values stay in the encrypted row until the Apply
   * that creates their Service, and a plan is readable by an Agent.
   * Absent, none waits.
   */
  readonly pendingSetups?: readonly PendingSetupInput[];
  /**
   * The Project's **Setup records** (ADR-0065): which Config names each
   * Template setup made. Read only to hold a setup's parts back together in
   * an Environment where none of them exists and no Pending setup covers
   * them (#1377). Never a link: nothing updates from it. Absent, none.
   */
  readonly setupRecords?: readonly SetupRecordInput[];
  /**
   * The hosts of a Pending setup's Domains already taken, each with why:
   * a route another Domain holds, or a host another organization claims
   * on this Server (`DomainsService`'s own rules, read by the plan store
   * before planning). A create of a part with one is refused, so a taken
   * host is told at the Plan and never first at Apply (ADR-0065).
   * Absent, none is.
   */
  readonly takenHosts?: ReadonlyMap<string, string>;
  /**
   * Where the config planned is kept. A repository-kept config's plan
   * (a push's, or Check for changes) reads a file the user pasted a
   * Template's entries into (#1378), so it notes each Pending setup part it
   * does not create, and the values left unused (`setup-values-unused`). A
   * Cloudgate-kept config's setup wrote its entries itself. Absent, it is
   * Cloudgate-kept.
   */
  readonly configKept?: 'cloudgate' | 'repository';
}

/** One Setup record, as a plan reads it. */
export interface SetupRecordInput {
  readonly setupRecordId: string;
  /** The Template's id: its folder name. */
  readonly templateId: string;
  readonly setupName: string;
  /** The Config names the setup made, one per part. */
  readonly configNames: readonly string[];
}

/** One Pending setup, as a plan reads it: names and rules, no values. */
export interface PendingSetupInput {
  readonly pendingSetupId: string;
  /** The Template's id (its folder name) and its display name. */
  readonly templateId: string;
  readonly templateName: string;
  readonly setupName: string;
  /** The parts it has not created yet, each by Config name and kind. */
  readonly parts: readonly PendingSetupPart[];
}

/**
 * One part a Pending setup will create. A create picks it up only when both
 * its Config name and its kind match (ADR-0065 "Matching").
 */
export interface PendingSetupPart {
  readonly configName: string;
  readonly kind: ConfigKind;
  /** How each of its values is made, by variable name. */
  readonly made: Readonly<Record<string, string>>;
  /**
   * A `web`'s generated host, made at setup because a value refers to its
   * URL or host (ADR-0064, #1375). Absent for every other part.
   */
  readonly host?: string;
  /**
   * A compose part's Domains, each on the host the setup picked (#1373).
   * Hosts are no secret: a Domain's host is public, and the plan shows it.
   */
  readonly domains?: readonly TemplateDomain[];
  /**
   * Its config files: each path in its Service's files directory, and,
   * for an own-kind part, where its container mounts the file. Paths
   * only: the text stays in the encrypted body.
   */
  readonly files?: readonly TemplateFile[];
  /**
   * A compose part's minimum size from `template.yaml` (ADR-0070
   * "Machine"): its Stack VM starts there in a Cloud Environment, through
   * {@link PlanInput.stackVmStartingSizes}. Absent, `medium`.
   */
  readonly size?: SizeName;
  /**
   * A compose part whose stack an Apply made in a Cloud Environment, while
   * its Domains wait here for its Stack VM, which a Cloud run makes after
   * the Apply (#1379, ADR-0065 as amended): the stack's id. No plan creates
   * it again; the Cloud run adds the Domains once the Stack VM is made.
   */
  readonly stackId?: string;
}

/** A Template's compose Domain, on its picked host. */
export interface TemplateDomain {
  /** The compose service it routes to. */
  readonly service: string;
  readonly port: number;
  readonly path: string;
  readonly host: string;
  /**
   * Whether it is served over HTTPS, decided at setup with the URL its
   * values were filled with (#1411): false only on the host the setup form
   * generated. Absent on a Pending setup saved before setup recorded it.
   */
  readonly https?: boolean;
}

/** A Template's config file, as a plan may name it: never its text. */
export interface TemplateFile {
  readonly path: string;
  /** Where an own-kind part's container mounts it; null for a compose part. */
  readonly mount: string | null;
}

/**
 * A create's Template: the Pending setup it takes its values from, and how
 * each value is made, once per list that lists the variable. Never a value.
 * The Apply that runs the create writes the values into the Service's own
 * variables and takes them out of the Pending setup.
 */
export interface TemplateCreate {
  readonly pendingSetupId: string;
  readonly templateId: string;
  readonly templateName: string;
  readonly setupName: string;
  readonly values: readonly {
    readonly list: VariableList;
    readonly variable: string;
    readonly made: string;
  }[];
  /**
   * The host a `web`'s generated Domain is made on, picked at setup since a
   * value names it (ADR-0064, #1375): the Apply uses it rather than
   * generating one, so the value and the Domain agree. Absent, the Apply
   * generates the host as for any `web`.
   */
  readonly host?: string;
  /** A compose part's Domains, on the hosts the setup picked (#1373). */
  readonly domains?: readonly TemplateDomain[];
  /** The config files the create writes as mounts (#1373). */
  readonly files?: readonly TemplateFile[];
}

export interface NetworkPlace {
  readonly cloudAccountId: string;
  readonly region: string;
  /** Set on a network that is made (`ready`), which "Check for changes" reads. */
  readonly environmentNetworkId?: string;
  /** The kinds of private link a Google network holds; absent is none. */
  readonly privateLinks?: readonly NetworkLinkKind[];
}

export interface CloudReads {
  readonly everything: boolean;
  readonly services: readonly string[];
}

/**
 * An Environment network a plan may remove: its row, and the DNS
 * records its Domains left, which its removal names.
 */
export interface RemovableNetwork extends NetworkPlace {
  readonly environmentNetworkId: string;
  readonly dnsRecordsLeft: readonly DnsRecord[];
}

/**
 * What a plan read of the cloud found for one step (the AWS spec "Plan behaviour"),
 * whichever cloud the step is in (the Google Cloud spec S17). The planner
 * is pure, so it writes every cloud step `reading`; the read runs
 * afterwards in the Cloud run pool, taking the state's lock, and replaces
 * it with the plan reader's lines, or with why it failed. Apply is
 * refused while any step is not `read`.
 */
export type CloudRead =
  | { readonly status: 'reading' }
  | {
      readonly status: 'failed';
      /** What stopped the read, as the operator reads it. */
      readonly reason: string;
    }
  | (PlanReading & {
      readonly status: 'read';
      /**
       * The Infrastructure state the read planned against: for a create, a
       * new one, which the Apply that makes it keeps.
       */
      readonly stateId: string;
      /** The id a created Service's definition was written with; its Apply keeps it. */
      readonly serviceId?: string;
      /**
       * On a read of a Service that exists: the tag of the live image
       * its definition was written with (its last finished deploy's), or
       * `null` when it has none yet. What an Apply of a drift-only step puts
       * back runs on that image, and a deploy that builds a new one may add
       * only its image's lines to what was read. Absent on every other read.
       */
      readonly liveImage?: string | null;
      /**
       * On an Existing database's lookup: it was found at another
       * host or port than the one saved. That changes its Outputs (`moved`,
       * as `<source>.<output>`), so the plan redeploys what links to them,
       * and its Apply saves `to` before it does. Absent when it is where it
       * was, and on its first lookup, which saves where it is found.
       */
      readonly addressMoved?: {
        readonly from: { readonly host: string; readonly port: number };
        readonly to: { readonly host: string; readonly port: number };
        readonly moved: readonly string[];
      };
      readonly readAt: string;
    });

/**
 * The CPU and memory a size lands on in a cloud (the Google Cloud spec S17), in that
 * cloud's own wording: on AWS `{ runsOn: 'Fargate', wording: '0.5 vCPU / 1 GB' }`.
 */
export interface SizePair {
  /** What runs it, as the plan line names it: `Fargate`. */
  readonly runsOn: string;
  /** The pair itself: `0.5 vCPU / 1 GB`. */
  readonly wording: string;
  /**
   * What the size asked for, when the cloud's pair had to round it up:
   * `0.5 CPU`. Absent when the size is an allowed pair as it is.
   */
  readonly roundedUpFrom?: string;
  /**
   * What else the plan line says of how it runs, in the cloud's own words:
   * on Cloud Run a create's billing and copy range, and a change's "same on
   * Cloud Run: …" when its new size lands on the pair it has.
   * Absent when there is nothing to add, as on AWS.
   */
  readonly notes?: readonly string[];
}

/**
 * A `web` a plan creates in a Cloud account, beyond its fields; or a
 * `worker` on ECS, written from the same with no port.
 */
export interface CloudWebCreate {
  /** The size's name and the cloud's pair it lands on. */
  readonly size: { readonly name: string | null; readonly pair: SizePair };
  /** What the Service's OpenTofu definition is written from. */
  readonly service: {
    /** `null` for a worker, which listens on nothing. */
    readonly port: number | null;
    readonly command: string | null;
    readonly args: readonly string[];
    readonly size: Size | null;
  };
  /**
   * Its config's links, so its read writes the SSM parameter of each
   * wired variable its deploy will write. Absent when it has none.
   */
  readonly links?: ConfigLinks;
  /**
   * Its entry's `native.aws`, checked, which its read lays over
   * Cloudgate's definition as its deploy will. Absent when it has none, or
   * off AWS.
   */
  readonly native?: NativeAwsBlock;
  /**
   * Its entry's `native.gcp`, checked, which its read lays over
   * Cloudgate's definition as its deploy will. Absent when it has none, or
   * off Google Cloud.
   */
  readonly nativeGcp?: NativeGcpBlock;
}

/**
 * A Compose stack a plan creates in a Cloud account: its own **Stack
 * VM** (ADR-0070), beyond its fields. What its OpenTofu definition is
 * written from, each rule already applied, so the read and the Apply write
 * the same definition, and the plan's lines for it.
 */
export interface StackVmCreate {
  readonly size: {
    /** The size it runs at: the entry's, the Template's minimum or `medium`. */
    readonly name: SizeName | null;
    /**
     * Where the size came from; `native` when its cloud block sets the
     * machine type, `console` for a console-managed stack's console setting.
     */
    readonly from: 'entry' | 'template' | 'default' | 'native' | 'console';
    /** The cloud's machine type: `t3.small`, `e2-small`. */
    readonly machineType: string;
    /** `2 vCPU, 2 GB`; `null` for a native type the machine list does not know. */
    readonly machine: string | null;
  };
  readonly region: string;
  /** The data disk Docker's volumes live on, which only grows. */
  readonly dataDiskGb: number;
  /** How many days each daily snapshot of the data disk is kept. */
  readonly snapshotDays: number;
  /** Its monthly price from the rate table; `null` when the table has none. */
  readonly monthly: StackVmMonthly | null;
  /** The plan's lines for it: machine, cost and data disk. */
  readonly lines: readonly string[];
  /**
   * Its entry's `native.aws`, checked, which its read lays over
   * Cloudgate's definition as its Cloud run will. Absent when it has none.
   */
  readonly native?: NativeAwsBlock;
  /** On Google Cloud, its entry's `native.gcp`, checked, laid alike. */
  readonly nativeGcp?: NativeGcpBlock;
  /**
   * A console-managed stack's own id, when the console created the stack
   * in a Cloud Environment and this step makes only its Stack VM (#1372):
   * its read and its Apply use the row the console wrote, and no Service is
   * created. Absent on a described entry's create, which makes both.
   */
  readonly consoleStackId?: string;
}

/**
 * A Stack VM stack's destroy (ADR-0070 "Delete", #1367): what its Delete
 * removes and what it keeps. Everything in the stack's Infrastructure
 * state goes; its data disk is kept as a final snapshot unless the Apply
 * ticks "also delete its data" for it (`deleteDataOf`).
 */
export interface StackVmDestroy {
  readonly cloud: CloudKind;
  readonly region: string;
  readonly dataDiskGb: number;
  /**
   * About what the final snapshot of the data disk costs a month, from the
   * cloud's rate table; `null` when the table has no price for the region.
   */
  readonly finalSnapshotMonthlyUsd: number | null;
  /** The plan's lines for it: what goes, and what is kept. */
  readonly lines: readonly string[];
}

/**
 * A Compose stack's Stack VM a plan changes, or reads for Drift (#1368):
 * what its OpenTofu definition is written from after the change, each
 * rule already applied, so the read and the Apply write the same
 * definition, what moves, and the plan's lines for it.
 */
export interface StackVmChange {
  readonly machineType: string;
  readonly sizeName: SizeName | null;
  readonly dataDiskGb: number;
  readonly snapshotDays: number;
  /** Its monthly price after the change; `null` when the rate table has none. */
  readonly monthly: StackVmMonthly | null;
  /** A new machine type, which restarts the Stack VM. */
  readonly resize?: {
    readonly from: {
      readonly machineType: string;
      readonly monthly: StackVmMonthly | null;
    };
    readonly to: {
      readonly machineType: string;
      readonly monthly: StackVmMonthly | null;
    };
  };
  /** A larger data disk, grown in place. */
  readonly grow?: { readonly fromGb: number; readonly toGb: number };
  /**
   * "Replace VM": Cloudgate's pins moved since it was made, so it is made
   * again at the new ones, its data disk kept. Applied only as the
   * approved line of an Apply, with `-replace`.
   */
  readonly replace?: {
    readonly from: StackVmPins;
    readonly to: Required<StackVmPins>;
  };
  /** The plan's lines for it; none on a read for Drift alone. */
  readonly lines: readonly string[];
  /** Its entry's `native.aws`, checked, which its read and run lay. */
  readonly native?: NativeAwsBlock;
  /** On Google Cloud, its entry's `native.gcp`, laid alike. */
  readonly nativeGcp?: NativeGcpBlock;
}

/**
 * A `postgres` a plan creates in a Cloud account: an RDS for
 * PostgreSQL instance, beyond its fields; or a `mysql`, an RDS for
 * MySQL one, the step's `kind` saying which. What its OpenTofu definition is
 * written from, each rule already applied, so the read and the Apply write
 * the same definition.
 */
export interface CloudPostgresCreate {
  /** The size's name and the class it lands on, with its CPU and memory. */
  readonly size: {
    readonly name: string | null;
    readonly instanceClass: string;
    /**
     * `2 vCPU, 1 GB`; `null` for a class its `native.aws` sets that the
     * committed class table does not know.
     */
    readonly machine: string | null;
    /** No size: the smallest class, which is Cloudgate's after creation. */
    readonly smallest: boolean;
    /** The class is its `native.aws`'s, which wins over the size. */
    readonly native?: true;
  };
  /** The version rule's reading of the config's `version`. */
  readonly version: {
    readonly written: string;
    readonly engineVersion: string;
    readonly autoMinorUpgrade: boolean;
  };
  /** The master user and initial database. */
  readonly login: { readonly user: string; readonly database: string };
  /**
   * Its entry's `native.aws`, checked, which its read lays over
   * Cloudgate's definition as its Cloud run will. Absent when it has none.
   */
  readonly native?: NativeAwsBlock;
  /** On Google Cloud, its entry's `native.gcp`, checked, laid alike. */
  readonly nativeGcp?: NativeGcpBlock;
}

/**
 * A `redis` a plan creates in a Cloud account: a one-node
 * ElastiCache for Valkey replication group, beyond its fields. What its
 * OpenTofu definition is written from, each rule already applied, so the
 * read and the Apply write the same definition.
 */
export interface CloudRedisCreate {
  /** The size's name and the node type it lands on, with its CPU and memory. */
  readonly size: {
    readonly name: string | null;
    readonly nodeType: string;
    /**
     * `2 vCPU, 1.37 GB`; `null` for a node type its `native.aws` sets that
     * the committed class table does not know.
     */
    readonly machine: string | null;
    /** No size: the smallest node type, which is Cloudgate's after creation. */
    readonly smallest: boolean;
    /** The node type is its `native.aws`'s, which wins over the size. */
    readonly native?: true;
  };
  /** The version rule's reading of the config's `version`. */
  readonly version: {
    readonly written: string;
    /** The Valkey it runs: `7.2`, `8.0`, `8.1`. */
    readonly engineVersion: string;
    readonly parameterFamily: string;
  };
  /**
   * Its entry's `native.aws`, checked, which its read lays over
   * Cloudgate's definition as its Cloud run will. Absent when it has none.
   */
  readonly native?: NativeAwsBlock;
  /** On Google Cloud, its entry's `native.gcp`, checked, laid alike. */
  readonly nativeGcp?: NativeGcpBlock;
}

/**
 * A `postgres` a plan creates on Google Cloud (the Google Cloud databases spec): a Cloud SQL
 * for PostgreSQL instance on the Enterprise edition, beyond its fields. Its
 * machine and version, each rule already applied, so the Cloud SQL
 * definition reads them from here and maps nothing of its own.
 */
export interface CloudSqlCreate {
  readonly size: {
    readonly name: string | null;
    /** The machine: `db-g1-small`, `db-custom-1-3840`. */
    readonly tier: string;
    /**
     * `shared CPU, 1.7 GB, no SLA` or `1 vCPU, 3.75 GB`; `null` for a tier
     * its `native.gcp` sets that the committed tier table does not know.
     */
    readonly machine: string | null;
    /** No size: `db-f1-micro`, which is Cloudgate's after creation. */
    readonly smallest: boolean;
    /** The tier is its `native.gcp`'s, which wins over the size. */
    readonly native?: true;
  };
  /** The shared version rule's reading of the config's `version`. */
  readonly version: {
    readonly written: string;
    readonly major: number;
    /** `database_version`: `POSTGRES_17`. */
    readonly databaseVersion: string;
  };
  /** The user and initial database, named as on any other target. */
  readonly login: { readonly user: string; readonly database: string };
  /**
   * The daily automated backups it is made keeping, with
   * point-in-time recovery on: the Service's default, edited later on its
   * Backups tab.
   */
  readonly backupRetentionDays: number;
  /**
   * Whether it is made with point-in-time recovery: the planner's
   * one wanted value, on unless `native.gcp` turns it off. Made either way,
   * nothing restarts.
   */
  readonly pointInTimeRecovery: boolean;
  /**
   * The plan's lines for it, as the operator reads them: the machine with
   * its real CPU and memory, and the no-SLA mark on a shared-core one, then
   * its backups.
   */
  readonly lines: readonly string[];
  /**
   * Its entry's `native.gcp`, checked, which its read lays over
   * Cloudgate's definition as its Cloud run will. Absent when it has none.
   */
  readonly native?: NativeGcpBlock;
}

/**
 * Cloudgate's own setting of a postgres on Cloud SQL (the Google Cloud buckets spec
 * "Schema changes"), never in the config, edited on its Backups tab: how
 * many daily automated backups it keeps.
 */
export interface CloudSqlConsoleSettings {
  readonly backupRetentionDays: number;
}

/**
 * What the last Apply wrote to a postgres on Cloud SQL: its
 * backup retention, and whether point-in-time recovery is on, which is the
 * config's (`native.gcp`) and so not a console setting. Absent is on: each
 * one made with backups is made with it.
 */
export interface CloudSqlAppliedSettings extends CloudSqlConsoleSettings {
  readonly pointInTimeRecovery?: boolean;
}

/** A postgres on Cloud SQL's console setting now and as its last Apply wrote it. */
export interface SavedCloudSqlSettings extends CloudSqlConsoleSettings {
  /**
   * `null` for one made before backups: Google has no backups,
   * point-in-time recovery or deletion protection on it, and its next plan
   * catches it up.
   */
  readonly applied: CloudSqlAppliedSettings | null;
  /**
   * The tier it runs on, as its last Apply saved it: a native one
   * taken out with no size stays here. Absent on one saved without it,
   * whose tier is read from its caps.
   */
  readonly tier?: string;
  /**
   * Present only when its Cloud run failed before Cloudgate saved where
   * the instance answers (the live walk): the next plan runs it
   * again, as an RDS `unmade` one.
   */
  readonly unmade?: true;
}

/** A change to a `postgres` on Cloud SQL: only what moves is set. */
export interface CloudSqlChange {
  /** A move to another machine: a restart. */
  readonly tier: {
    readonly from: string;
    readonly to: string;
    /** `1 vCPU, 3.75 GB`; `null` for a native tier the table does not know. */
    readonly machine: string | null;
    readonly sizeName: string | null;
    /** Set by its `native.gcp`, which wins over the size. */
    readonly native?: true;
  } | null;
  readonly version: {
    readonly from: string;
    readonly to: string;
    readonly databaseVersion: string;
  } | null;
  /** Its backup retention edited on its Backups tab: no restart. */
  readonly backupRetentionDays?: {
    readonly from: number;
    readonly to: number;
  } | null;
  /**
   * One made before backups brought level: automated backups on,
   * kept its Backups tab's retention, deletion protection and retained
   * backups on delete on, all in place with no restart. Absent on one made
   * with them.
   */
  readonly catchUp?: { readonly backupRetentionDays: number };
  /**
   * Point-in-time recovery turned on or off, either way and for any
   * reason: Postgres restarts twice, so its line carries the restart mark,
   * with no typed confirmation. Absent when it stays as it is.
   */
  readonly pointInTimeRecovery?: {
    readonly from: boolean;
    readonly to: boolean;
  };
  /** Each move, then its restart mark. */
  readonly lines: readonly string[];
  /**
   * The `native.gcp` the change lays, the entry's, `null` when it
   * takes its last one out: what its read writes the definition with
   * before the Apply saves it. Absent when neither it nor the last Apply
   * has one.
   */
  readonly native?: NativeGcpBlock | null;
}

/**
 * A `redis` a plan creates on Google Cloud (the Google Cloud databases spec): a Memorystore
 * for Valkey instance with cluster mode off, beyond its fields. Its node
 * type, node count and version, each rule already applied, so the
 * Memorystore definition reads them from here.
 */
export interface MemorystoreCreate {
  readonly size: {
    readonly name: string | null;
    /** `node_type`: `CUSTOM_PICO`. */
    readonly nodeType: string;
    /**
     * Its default writable memory: `1.08 GB`; `null` for a node type its
     * `native.gcp` sets that Cloudgate does not choose.
     */
    readonly writableMemory: string | null;
    /** No size: `custom-pico`, which is Cloudgate's after creation. */
    readonly smallest: boolean;
    /** The node type is its `native.gcp`'s, which wins over the size. */
    readonly native?: true;
  };
  /** One, or two with high availability. */
  readonly nodes: number;
  readonly version: {
    readonly written: string;
    /** `engine_version`: `VALKEY_9_1`. */
    readonly engineVersion: string;
  };
  /**
   * How many days its daily automated backups are kept: the
   * Service's default, edited later on its Backups tab; 0 is off.
   */
  readonly backupRetentionDays: number;
  /** The node type, its writable memory and the node count, then its backups. */
  readonly lines: readonly string[];
  /**
   * Its entry's `native.gcp`, checked, which its read lays over
   * Cloudgate's definition as its Cloud run will. Absent when it has none.
   */
  readonly native?: NativeGcpBlock;
}

/**
 * Cloudgate's own setting of a redis on Memorystore (the Google Cloud databases spec "Schema
 * changes"), never in the config, edited on its cloud Database page:
 * high availability, one replica in another zone (`replica_count = 1`).
 */
export interface MemorystoreConsoleSettings {
  readonly highAvailability: boolean;
  /**
   * How many days its daily automated backups are kept, 0 off.
   * Absent from what the last Apply wrote of one made before backups, which
   * no plan gives backups until its catch-up.
   */
  readonly backupRetentionDays?: number;
}

/** A redis on Memorystore's console setting now and as its last Apply wrote it. */
export interface SavedMemorystoreSettings extends MemorystoreConsoleSettings {
  /** Its backup retention on its Backups tab now. */
  readonly backupRetentionDays: number;
  /** `null` for one no Apply has written since these settings were saved (read as the same). */
  readonly applied: MemorystoreConsoleSettings | null;
  /**
   * The `engine_version` it runs, `VALKEY_9_1`, which a version
   * change is read against; `null` for one made before it was saved (read from its
   * written version).
   */
  readonly engineVersion: string | null;
  /**
   * The node type it runs on, as its last Apply saved it: a native
   * one taken out with no size stays here. Absent on one saved without it,
   * whose node type is read from its caps.
   */
  readonly nodeType?: string;
  /**
   * Present only when its Cloud run failed before Cloudgate saved where
   * the instance answers (the live walk): the next plan runs it
   * again, as a Cloud SQL or ElastiCache `unmade` one.
   */
  readonly unmade?: true;
}

/** A change to a `redis` on Memorystore: only what moves is set. */
export interface MemorystoreChange {
  /** A move to another node type, made in place while it resizes. */
  readonly nodeType: {
    readonly from: string;
    readonly to: string;
    /** `1.08 GB`; `null` for a native node type Cloudgate does not choose. */
    readonly writableMemory: string | null;
    readonly sizeName: string | null;
    /** Set by its `native.gcp`, which wins over the size. */
    readonly native?: true;
  } | null;
  readonly version: {
    readonly from: string;
    readonly to: string;
    readonly engineVersion: string;
  } | null;
  /** High availability turned on or off on the console: its replica added or removed in place. */
  readonly highAvailability: {
    readonly from: boolean;
    readonly to: boolean;
  } | null;
  /** Its backup retention edited on its Backups tab, 0 off. */
  readonly backupRetentionDays?: {
    readonly from: number;
    readonly to: number;
  } | null;
  /** Each move, then its mark; a major upgrade shown apart. */
  readonly lines: readonly string[];
  /** The `native.gcp` the change lays, as a postgres's on Cloud SQL. */
  readonly native?: NativeGcpBlock | null;
}

/**
 * Cloudgate's own settings of a postgres on RDS (the AWS databases spec "Schema
 * changes"), never in the config, edited on the cloud Database page.
 * `instanceClass` is set only for an entry with no size, whose class is
 * then Cloudgate's; `null` when the size decides it.
 */
export interface RdsConsoleSettings {
  readonly instanceClass: string | null;
  readonly storageGb: number;
  readonly maxStorageGb: number;
  readonly multiAz: boolean;
  readonly backupRetentionDays: number;
}

/** A postgres on RDS's console settings now and as its last Apply wrote them. */
export interface SavedRdsSettings extends RdsConsoleSettings {
  /** `null` for one no Apply has written since these settings were saved (read as the same). */
  readonly applied: RdsConsoleSettings | null;
  /** Its Cloud run failed before the instance was made; absent otherwise. */
  readonly unmade?: true;
}

/** One of {@link RdsConsoleSettings} a change moves, by its own name. */
export type RdsSettingChange =
  | {
      readonly setting: 'storageGb' | 'maxStorageGb' | 'backupRetentionDays';
      readonly from: number;
      readonly to: number;
    }
  | {
      readonly setting: 'multiAz';
      readonly from: boolean;
      readonly to: boolean;
    };

/**
 * A database's move to another machine on RDS or ElastiCache:
 * its class or node type.
 */
export interface MachineMove {
  readonly from: string;
  readonly to: string;
  /**
   * `2 vCPU, 4 GB`; `null` for one its `native.aws` sets that the committed
   * class table does not know.
   */
  readonly machine: string | null;
  /** The size's name, or `null` for a pair or the console's machine. */
  readonly sizeName: string | null;
  /** Set by its `native.aws`, which wins over the size. */
  readonly native?: true;
}

/**
 * A change to a `postgres` on RDS, beyond its fields: what its
 * OpenTofu definition is written with, so the read and the Apply's Cloud run
 * write the same one. Only what moves is set.
 */
export interface CloudPostgresChange {
  /** A move to another class: a restart. */
  readonly instanceClass: MachineMove | null;
  /** A new version, as the config wrote it and by RDS's rule. */
  readonly version: {
    readonly from: string;
    readonly to: string;
    readonly engineVersion: string;
    readonly autoMinorUpgrade: boolean;
  } | null;
  /** The console's no-outage settings that move. */
  readonly settings: readonly RdsSettingChange[];
  /**
   * The `native.aws` the change lays, the entry's, `null` when it
   * takes its last one out: what its read writes the definition with
   * before the Apply saves it. Absent when neither it nor the last Apply
   * has one.
   */
  readonly native?: NativeAwsBlock | null;
}

/**
 * Cloudgate's own settings of a redis on ElastiCache (the AWS databases spec "Schema
 * changes"), never in the config, edited on the cloud Database page.
 * `nodeType` is set only for an entry with no size, whose node type is then
 * Cloudgate's; `null` when the size decides it.
 */
export interface ElastiCacheConsoleSettings {
  readonly nodeType: string | null;
  readonly replica: boolean;
  readonly snapshotRetentionDays: number;
}

/** A redis on ElastiCache's console settings now and as its last Apply wrote them. */
export interface SavedElastiCacheSettings extends ElastiCacheConsoleSettings {
  /** `null` for one no Apply has written since these settings were saved (read as the same). */
  readonly applied: ElastiCacheConsoleSettings | null;
  /** Its Cloud run failed before the cache was made; absent otherwise. */
  readonly unmade?: true;
}

/** One of {@link ElastiCacheConsoleSettings} a change moves, by its own name. */
export type ElastiCacheSettingChange =
  | {
      readonly setting: 'replica';
      readonly from: boolean;
      readonly to: boolean;
    }
  | {
      readonly setting: 'snapshotRetentionDays';
      readonly from: number;
      readonly to: number;
    };

/**
 * A change to a `redis` on ElastiCache, beyond its fields: what its
 * OpenTofu definition is written with, so the read and the Apply's Cloud run
 * write the same one. Only what moves is set.
 */
export interface CloudRedisChange {
  /** A move to another node type: connections may drop while it resizes. */
  readonly nodeType: MachineMove | null;
  /** A new Valkey, as the config wrote it and by Valkey's rule. */
  readonly version: {
    readonly from: string;
    readonly to: string;
    readonly engineVersion: string;
    readonly parameterFamily: string;
  } | null;
  /** The console's replica and snapshot retention, when they move. */
  readonly settings: readonly ElastiCacheSettingChange[];
  /** The `native.aws` the change lays, as a postgres's on RDS. */
  readonly native?: NativeAwsBlock | null;
}

/**
 * A major version upgrade on a change step: offline while it runs and
 * never undone, so Apply needs the Service's name typed, as for a destroy.
 * Not RDS's alone: a redis on ElastiCache sets it too.
 */
export interface MajorUpgrade {
  readonly from: string;
  readonly to: string;
}

/**
 * One field's difference, named as the config writes it (`port`,
 * `build.dockerfile`, `source`) so an operator can find it in the YAML.
 * Values are JSON: `null` is "not set".
 */
export interface FieldDiff {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
  /**
   * A Native setting: `field` is its path in the file's spelling
   * (`native.docker.HealthCheck.Retries`), and the line is marked native.
   * Absent on every config field's line.
   */
  readonly native?: true;
  /**
   * A side that is the kind's default rather than a written value,
   * shown as `default (none)` or `default (<value>)`; only on a native line.
   */
  readonly fromDefault?: true;
  readonly toDefault?: true;
  /**
   * A side that is the console's value of a setting it owned before native
   * shown as `console (<value>)`; only on a native line.
   */
  readonly fromConsole?: true;
  readonly toConsole?: true;
  /**
   * A side that is the entry's `size`'s value of a size-bearing argument
   * native sets none of, shown as `size (<value>)`; only on a
   * native line.
   */
  readonly fromSize?: true;
  readonly toSize?: true;
}

export type PlanStep =
  | {
      readonly action: 'create';
      readonly configName: string;
      readonly kind: ConfigKind;
      /** Where it will run: the Environment's Deploy target. */
      readonly placement: DeployTarget;
      /** What it will get beyond a console create's defaults. */
      readonly fields: readonly FieldDiff[];
      /** A `web` created in a Cloud account; absent elsewhere. */
      readonly cloud?: CloudWebCreate;
      /**
       * A `postgres` created in a Cloud account, or a `mysql` on RDS
       * absent elsewhere.
       */
      readonly database?: CloudPostgresCreate;
      /** A `redis` created in a Cloud account; absent elsewhere. */
      readonly cache?: CloudRedisCreate;
      /** A `postgres` created on Google Cloud, instead of `database`. */
      readonly cloudSql?: CloudSqlCreate;
      /** A `redis` created on Google Cloud, instead of `cache`. */
      readonly memorystore?: MemorystoreCreate;
      /** A `static` site created on S3 + CloudFront; absent elsewhere. */
      readonly site?: CloudStaticSite;
      /** A Compose stack created in a Cloud account: its Stack VM. */
      readonly stackVm?: StackVmCreate;
      /** A part of a Template set up here, made from its Pending setup. */
      readonly template?: TemplateCreate;
      /**
       * A `bucket` or a `static` site created on AWS: its entry's
       * `native.aws`, checked, which its read lays as its Cloud run will.
       * Absent when it has none, and elsewhere.
       */
      readonly nativeAws?: NativeAwsBlock | null;
      /**
       * A `postgres` created as the existing database a switch names
       * (ADR-0033): its Apply creates the Existing database Service
       * from the switch's login, and makes nothing. The next plan looks it
       * up. Absent on every other create.
       */
      readonly existing?: { readonly identifier: string };
      /** What its read of the cloud found, on a cloud create only. */
      readonly cloudRead?: CloudRead;
      /**
       * A bucket's real name, minted when the plan is stored and made
       * by its Apply as shown; on a `static` site created on AWS, its
       * own bucket's, named the same way. Absent on every other kind, and on
       * a plan the pure planner made and nothing stored.
       */
      readonly bucket?: {
        readonly name: string;
        /**
         * On AWS, where the name is made in the account regional
         * namespace: the AWS account and region it is made in, which the
         * plan shows beside it.
         */
        readonly awsAccountId?: string;
        readonly region?: string;
        /**
         * On Google Cloud, where the name starts with the bucket
         * Service's own key (`googleBucketName`): that Service's id, minted
         * with the name, which its read and its Apply keep.
         */
        readonly serviceId?: string;
      };
    }
  | {
      /**
       * The Environment network made first, before the cloud `web` this
       * plan creates: its VPC, subnets and load balancer, with their
       * idle cost. Its Apply is a Deployment of the Environment network.
       */
      readonly action: 'network-create';
      readonly cloudAccountId: string;
      readonly region: string;
      /**
       * On Google Cloud: the kinds of private link it is made with,
       * for the databases this plan creates. Absent when none.
       */
      readonly privateLinks?: readonly NetworkLinkKind[];
      readonly cloudRead: CloudRead;
    }
  | {
      /**
       * An Environment network nothing uses any more:
       * neither a Service nor the Deploy target is in its Cloud account and
       * region, as a Deploy target switch leaves it. Its Apply runs the
       * network's destroy-only Cloud run. Confirmed by typing
       * {@link confirmName}, as a Service destroy is by its name.
       */
      readonly action: 'network-remove';
      readonly environmentNetworkId: string;
      readonly cloudAccountId: string;
      readonly region: string;
      /** What the Apply's confirmation names for it: `network-<region>`. */
      readonly confirmName: string;
      /** The DNS records its Domains left at the operator's DNS provider. */
      readonly dnsRecordsLeft: readonly DnsRecord[];
    }
  | {
      /**
       * The Environment network, made already, read for Drift by "Check for
       * changes". Its Apply is a network run that puts AWS back.
       */
      readonly action: 'network-change';
      readonly environmentNetworkId: string;
      readonly cloudAccountId: string;
      readonly region: string;
      /**
       * On Google Cloud: the kinds of private link this plan adds to
       * the made network, for the first database of that kind it creates.
       * Its Apply is the same network run, made before the database's.
       * Absent on a read for Drift alone.
       */
      readonly privateLinks?: readonly NetworkLinkKind[];
      /**
       * The kinds of private link this plan takes off the made network:
       * its NAT (AWS's NAT gateway, Google's Cloud NAT) once the
       * Environment has no Stack VM left (#1367). Absent when none goes.
       */
      readonly removedLinks?: readonly NetworkLinkKind[];
      readonly cloudRead: CloudRead;
    }
  | {
      readonly action: 'change';
      readonly configName: string;
      readonly kind: ConfigKind;
      readonly serviceType: ServiceType;
      readonly serviceId: string;
      readonly name: string;
      /**
       * Empty on a cloud Service the plan only reads for Drift: its
       * config is unchanged, and its AWS lines say whether AWS is.
       */
      readonly fields: readonly FieldDiff[];
      /** A cloud `web`'s config as its read writes the definition. */
      readonly cloud?: CloudWebCreate;
      /** A `static` site on AWS's config as its read writes the definition. */
      readonly site?: CloudStaticSite;
      /**
       * A `bucket` or a `static` site on AWS whose change plans native lines
       * its entry's `native.aws`, `null` for none, which its read
       * lays as its Cloud run will. Absent, its read lays the one its last
       * Apply laid.
       */
      readonly nativeAws?: NativeAwsBlock | null;
      /** A `postgres` or a `mysql` on RDS whose instance this change moves. */
      readonly database?: CloudPostgresChange;
      /** A `redis` on ElastiCache whose replication group this change moves. */
      readonly cache?: CloudRedisChange;
      /** A `postgres` on Cloud SQL whose instance this change moves. */
      readonly cloudSql?: CloudSqlChange;
      /** A `redis` on Memorystore whose instance this change moves. */
      readonly memorystore?: MemorystoreChange;
      /** A Compose stack's Stack VM this change moves, or reads for Drift. */
      readonly stackVm?: StackVmChange;
      /** A major version upgrade, confirmed by name at Apply. */
      readonly majorUpgrade?: MajorUpgrade;
      /**
       * Why its Apply will not run it: `pg-1 is stopped. Start it
       * first.` on a postgres on RDS Cloudgate stopped. The planner is pure,
       * so it never sets this; the plan store does, and the Apply checks
       * again when it runs. The rest of the plan applies as usual.
       */
      readonly blocked?: string;
      /**
       * A bucket on AWS whose browser-upload origins were edited on its page
       * since its last Cloud run: its CORS change, which its read
       * shows on AWS and its Apply writes.
       */
      readonly cors?: BucketCorsChange;
      /**
       * An Existing database or an existing bucket: every
       * plan looks it up, so it has a step even when the config changes
       * nothing, whose read is the lookup.
       */
      readonly existing?: ExistingDatabaseLookup;
      /**
       * The links whose source's Output this plan changes, as
       * `<source>.<output>`: its change deploys it anyway, so the reason
       * rides on it rather than on a {@link RedeployStep}. Absent when none.
       */
      readonly because?: readonly string[];
      /**
       * A cloud Service's AWS lines: what its read found, or, on the
       * step of a plan its deploy stopped on, what that deploy's own
       * read found, which an Apply of the plan approves; on a postgres on
       * RDS's change, the read of its state the planner asks for.
       */
      readonly cloudRead?: CloudRead;
    }
  | RedeployStep
  | {
      readonly action: 'destroy';
      readonly configName: string;
      readonly kind: ConfigKind;
      readonly serviceType: ServiceType;
      readonly serviceId: string;
      readonly name: string;
      /**
       * A bucket's destroy only: whether it holds files —
       * *holds files*, *empty* or *can't tell* (`unknown`, which counts as
       * holds files) — from one cheap read when the plan is stored. The
       * planner is pure, so it never sets this; the plan store does, and the
       * step reads the bucket again when it runs.
       */
      readonly files?: BucketFiles;
      /**
       * A postgres on RDS's or a redis on ElastiCache's destroy only
       * the final snapshot its Delete keeps unless the Apply ticks
       * "also delete its data" for it (`deleteDataOf`), named for the day
       * the plan was stored, and about what it costs a month. On Google
       * Cloud a Cloud SQL or Memorystore destroy's final backup,
       * which the line calls "a final backup". Set by the plan store, never
       * the pure planner; the Delete names its own.
       */
      readonly finalSnapshot?: {
        /** Which cloud keeps it: a snapshot on AWS, a backup on Google Cloud. */
        readonly cloud: 'aws' | 'gcp';
        readonly name: string;
        /** `null` for a Stack VM in a region its rate table has no price for. */
        readonly monthlyUsd: number | null;
        /**
         * A Stack VM's data disk (ADR-0070): a disk snapshot on either
         * cloud, never a database backup. Absent on a database.
         */
        readonly of?: 'data-disk';
      };
      /**
       * An Existing database's or an existing bucket's destroy (ADR-0033): what
       * it uses as given, which its Delete leaves as it
       * was. Such a bucket's files are never read and never deleted.
       */
      readonly existing?: { readonly identifier: string };
      /**
       * A Compose stack's destroy only (ADR-0069): the volumes its Delete
       * removes, as Docker names them, from the file of its last
       * successful deploy; `null` when no deploy has recorded them yet.
       * Set by the plan store, never the pure planner, which reads no
       * compose file.
       */
      readonly volumes?: readonly string[] | null;
      /**
       * A Compose stack on a Stack VM's destroy only (#1367): what its
       * Delete removes and keeps, and the final snapshot's price.
       */
      readonly stackVm?: StackVmDestroy;
    };

/** A step about an Environment network: its create, its read for Drift, or its removal. */
export type NetworkStep = Extract<
  PlanStep,
  { action: 'network-create' | 'network-change' | 'network-remove' }
>;

/** A step about one Service: every step but an Environment network's. */
export type ServiceStep = Exclude<
  PlanStep,
  { action: 'network-create' | 'network-change' | 'network-remove' }
>;

/**
 * A Service the config does not change, deployed again because it links to
 * a source whose Output this plan changes (ADR-0031): "`web`
 * redeploys: `pg-1.url` changed". It runs after the source's step, and its
 * deploy builds the new value.
 */
export interface RedeployStep {
  readonly action: 'redeploy';
  readonly configName: string;
  readonly kind: ConfigKind;
  readonly serviceType: ServiceType;
  readonly serviceId: string;
  readonly name: string;
  /** Each changed link, as `<source>.<output>`. */
  readonly because: readonly string[];
}

/** Something worth knowing that changes nothing. */
export type PlanNote =
  | {
      /**
       * A Pending setup's parts a repository-kept config's plan does not
       * create from it (#1378): the file lists no entry under the part's
       * Config name and kind (renamed in the pasted YAML, say), or its
       * Service already exists. Their values are left unused, and the setup
       * keeps them. Named by its first such part's Config name.
       */
      readonly kind: 'setup-values-unused';
      readonly configName: string;
      readonly configNames: readonly string[];
      readonly pendingSetupId: string;
      readonly templateId: string;
      readonly setupName: string;
      readonly message: string;
    }
  | {
      /**
       * A Template setup's parts, held back together in an Environment the
       * template was not set up in (#1377): none of them exists here and no
       * Pending setup covers them. Named by its first part's Config name.
       */
      readonly kind: 'setup-held-back';
      readonly configName: string;
      readonly configNames: readonly string[];
      readonly templateId: string;
      readonly setupName: string;
      readonly message: string;
    }
  | {
      readonly kind: 'variable-without-value';
      readonly configName: string;
      readonly list: VariableList;
      readonly variable: string;
      readonly message: string;
    }
  | {
      readonly kind: 'console-managed-unlisted' | 'console-managed-dropped';
      readonly configName: string;
      /** The YAML to paste under `services:`. */
      readonly line: string;
      readonly message: string;
    }
  | {
      /** A console-managed `mysql` entry, which can now be described. */
      readonly kind: 'mysql-can-be-described';
      readonly configName: string;
      readonly message: string;
    }
  | {
      /**
       * A console-managed `compose` entry whose stack's compose file is in
       * a repository, which can now be described (ADR-0069).
       */
      readonly kind: 'compose-can-be-described';
      readonly configName: string;
      readonly message: string;
    }
  | {
      /**
       * A bucket replaced by a destroy plus a create — a new Config name or
       * a kind change — whose files are not copied to what replaces it.
       */
      readonly kind: 'files-not-copied';
      readonly configName: string;
      readonly message: string;
    }
  | {
      /**
       * A database replaced by a destroy plus a create — a rename or a kind
       * change: "the new <name> starts empty; <old>'s data is not
       * copied". Named by the new one's Config name.
       */
      readonly kind: 'data-not-copied';
      readonly configName: string;
      readonly message: string;
    }
  | {
      /**
       * A bucket on a Server with no Domain: its `endpoint` is the
       * internal URL, so presigned URLs and browser uploads do not work.
       */
      readonly kind: 'bucket-no-domain';
      readonly configName: string;
      readonly message: string;
    }
  | {
      /**
       * A variable linked to an Output with no value where its Service runs
       * (ADR-0032): a bucket's key on AWS, where the task's role gives
       * access, so the variable is left unset. Warns that an app passing
       * keys to its S3 client by hand breaks there.
       */
      readonly kind: 'task-role-access';
      readonly configName: string;
      readonly variable: string;
      readonly message: string;
    }
  | {
      /**
       * A variable linked to a redis's `password` on Google Cloud (ADR-0042):
       * Memorystore has none, so the variable is left unset.
       * Says plainly that only the Environment's private network keeps
       * others out, so any Service in it can connect.
       */
      readonly kind: 'no-password';
      readonly configName: string;
      readonly variable: string;
      readonly message: string;
    }
  | {
      /**
       * A variable linked to a bucket on Google Cloud: newer S3 SDKs' default
       * checksums, and the two settings that turn
       * them off. Behind one switch, off until the walk by hand decides it
       * (`BUCKET_CHECKSUM_NOTE_ON`).
       */
      readonly kind: 'bucket-checksums';
      readonly configName: string;
      readonly variable: string;
      readonly message: string;
    }
  | {
      /** A `web` created in a Cloud account, which gets no generated Domain. */
      readonly kind: 'cloud-no-domain';
      readonly configName: string;
      readonly message: string;
    }
  | {
      /**
       * A `web` on Google Cloud whose `native.gcp` closes its `run.app`
       * address (`ingress: INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`):
       * "run.app address closes: only Domains and this Environment reach
       * it"; and, beside it, the warning when the Service has no Domain.
       */
      readonly kind: 'run-app-closes' | 'run-app-closes-no-domain';
      readonly configName: string;
      readonly message: string;
    }
  | {
      /**
       * An always-running Service on Google Cloud whose live image has a
       * `HEALTHCHECK` (the Google Cloud kinds spec): a Cloud Run probe is
       * HTTP, TCP or gRPC only, so it is not run, and no probe is written
       * from it. Once per Service.
       */
      readonly kind: 'healthcheck-not-run';
      readonly configName: string;
      readonly message: string;
    }
  | {
      /**
       * A cloud database's version written with an image suffix, which the
       * cloud drops; or a size change landing on the class it
       * already runs on, which changes nothing on AWS; or a redis version of
       * 7 or lower, which runs as Valkey 7.2, the oldest on AWS; or,
       * once per plan, that Memorystore never moves a Valkey minor by
       * itself.
       */
      readonly kind:
        | 'cloud-version-suffix'
        | 'cloud-same-class'
        | 'cloud-version-oldest'
        | 'cloud-version-minor';
      readonly configName: string;
      readonly message: string;
    }
  | {
      /**
       * A `static` site on S3 + CloudFront that sets fields only a container
       * has: ignored, never refused, named once per Service. On
       * Cloud Storage + Cloud CDN the same note, naming Google's.
       */
      readonly kind: 'ignored-on-s3' | 'ignored-on-cloud-cdn';
      readonly configName: string;
      /** The fields it sets, as the config writes them. */
      readonly fields: readonly string[];
      readonly message: string;
    }
  | {
      /**
       * A `static` site a plan creates on Google Cloud (the Google Cloud
       * buckets spec): its bucket and backend bucket cost nothing fixed, and
       * serving is charged by use.
       */
      readonly kind: 'static-by-use';
      readonly configName: string;
      readonly message: string;
    }
  | {
      /**
       * A `static` site a plan creates on Google Cloud (the Google Cloud buckets spec):
       * there is no generated Domain, so it answers nowhere until one is
       * added.
       */
      readonly kind: 'static-no-domain';
      readonly configName: string;
      readonly message: string;
    }
  | {
      /**
       * A `static` site's `spa` change on Google Cloud (the Google Cloud buckets spec):
       * a run of the Environment network that clears the cache of the
       * site's Domains at its end, and what visitors may see meanwhile.
       */
      readonly kind: 'static-spa-change';
      readonly configName: string;
      readonly message: string;
    }
  | {
      /**
       * An entry an Existing database stands for (ADR-0033): its
       * `database`, `user`, `size` and `version` are not applied to it.
       */
      readonly kind: 'existing-not-applied';
      readonly configName: string;
      readonly message: string;
    }
  | {
      /**
       * A native argument the pinned provider deprecates (ADR-0044 rule 5): the
       * plan goes ahead, since the provider still takes it,
       * and says so by its full path, on every target. Its own line once
       * the per-kind tickets plan native lines on a cloud.
       */
      readonly kind: 'native-deprecated';
      readonly configName: string;
      /** The full path in the file's spelling (`api.native.aws."…".acl`). */
      readonly at: string;
      readonly message: string;
    }
  | {
      /**
       * A native block names an address by the name Cloudgate gave it before
       * a rename (ADR-0044 rule 10): planned exactly as under its new
       * name, with this warning naming both, so the operator updates the file
       * when they choose.
       */
      readonly kind: 'native-renamed';
      readonly configName: string;
      /** The old address's full path in the file's spelling (`api.native.aws."…"`). */
      readonly at: string;
      readonly from: string;
      readonly to: string;
      readonly message: string;
    };

/** Why the whole plan is refused, naming where (`<service>.<field>`). */
export interface PlanRefusal {
  readonly at: string | null;
  readonly message: string;
}

export type PlanOutcome =
  | {
      readonly ok: true;
      /**
       * The order an Apply runs: a network create or read first, then
       * creates, changes, redeploys and destroys, except that a link's
       * source always runs before what links to it, a kind change's destroy
       * is followed by its create, and a destroyed source goes after
       * whatever stops linking to it; then Drift reads, then network
       * removals.
       */
      readonly steps: readonly PlanStep[];
      readonly notes: readonly PlanNote[];
    }
  | { readonly ok: false; readonly refusals: readonly PlanRefusal[] };
