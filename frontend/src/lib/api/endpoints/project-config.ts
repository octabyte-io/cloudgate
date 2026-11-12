import { api } from "../client";
import type { DomainPortMove } from "./applications";
import type { DeploymentStatus } from "./deployments";
import type { BucketLeftBehind, TeardownReport } from "./teardown";
import type { DnsRecord } from "./environments";

/**
 * `project-config.controller.ts`: a Project's config, and an
 * Environment's Plan. Seeing or asking for a plan, and saving a whole YAML
 * text, is `environment: ['read']`; dismissing one is
 * `environment: ['update']`. Applying one is checked against each step's own
 * statements (`service: create/update/delete`, `deployment: create`) before
 * any step runs.
 */

/** A Cloudgate-kept config, with its text. */
export interface CloudgateLocation {
  kind: "cloudgate";
  /** The YAML, as stored. */
  text: string;
  textHash: string;
  updatedAt: string;
  /**
   * The repository file this config was moved out of, which
   * Cloudgate no longer reads; `null` for one never moved out.
   */
  movedOutOf: {
    providerType: "github" | "gitlab" | "gitea" | "bitbucket" | null;
    repository: string;
    path: string;
    movedAt: string;
  } | null;
}

/**
 * A repository-kept config: where it is read, never its text, which
 * each Environment reads from its own Config branch. The connection fields are
 * `null` once the connection is deleted.
 */
export interface RepositoryLocation {
  kind: "repository";
  gitProviderId: string | null;
  providerType: "github" | "gitlab" | "gitea" | "bitbucket" | null;
  connectionName: string | null;
  /** `owner/repo`. */
  repository: string;
  path: string;
  updatedAt: string;
}

export type ConfigLocation = CloudgateLocation | RepositoryLocation;

/** `GET /projects/:projectId/config`. */
export interface ProjectConfig {
  projectId: string;
  /**
   * `null` for a Project made before Project configs existed: it gets one
   * generated at upgrade, and shows none until then.
   */
  location: ConfigLocation | null;
}

/**
 * `GET /environments/:environmentId/config`: an Environment's copy,
 * read now from its Config branch and never stored by Cloudgate.
 */
export type EnvironmentConfigCopy =
  | { kind: "cloudgate"; environmentId: string }
  | {
      kind: "repository";
      environmentId: string;
      repository: string;
      path: string;
      /** `null` is the repository's default branch. */
      configBranch: string | null;
      copy: {
        text: string;
        commitSha: string;
        branch: string;
        fileUrl: string;
      } | null;
      refusal: {
        reason: "repository-unreachable" | "branch-missing" | "file-missing";
        branch: string | null;
        message: string;
      } | null;
      /**
       * The Environment's Services of a kind the config describes:
       * `owned` when the file describes it (or cannot be read), so the
       * backend refuses its config-owned writes and the console locks them.
       */
      services: LockedService[];
    };

/** A config's variable-name lists, by their wire names. */
export type VariableList = "env" | "build_args" | "build_secrets";

/** One Service as its Environment's copy locks it. */
export interface LockedService {
  serviceType: "application" | "postgres" | "mysql" | "redis";
  serviceId: string;
  configName: string;
  owned: boolean;
  /**
   * Of the fields the config sets only when it states them (`size`, a
   * postgres's `database` and `user`), those the file states; one it does not
   * state stays the console's.
   */
  stated: string[];
  /** The variable names the file lists, which may be given values here. */
  listed: Record<VariableList, string[]>;
  /** The plan that last wrote its config-owned fields, and its commit. */
  appliedFrom: {
    planId: string;
    /** `null` for a plan made while Cloudgate kept the config. */
    commitSha: string | null;
    branch: string | null;
    appliedAt: string | null;
  } | null;
}

/** A move into a repository, or between repositories or paths. */
export interface RepositoryTarget {
  kind: "repository";
  /** The `git_provider` row's id. */
  gitProviderId: string;
  /** `owner/repo`. */
  repository: string;
  /**
   * Omitted, the move finds `cloudgate.yaml`, or `cloudgate.yml` when every
   * Config branch has only that, and the preview's `to.path` answers which.
   */
  path?: string;
}

/**
 * A move out of a repository: the copy `fromEnvironmentId`'s Config
 * branch has becomes the Cloudgate-kept text; absent or `null` keeps the
 * default branch's.
 */
export interface CloudgateTarget {
  kind: "cloudgate";
  fromEnvironmentId?: string | null;
}

/** Where a move takes the config. */
export type MoveTarget = RepositoryTarget | CloudgateTarget;

/** What one Environment's copy read as; a confirm carries these back. */
export interface ConfigRead {
  environmentId: string;
  commitSha: string | null;
  textHash: string;
}

/** `POST /projects/:projectId/config/move/preview`: stores nothing. */
export interface MovePreview {
  to:
    | (RepositoryTarget & {
        path: string;
        providerType: string;
        connectionName: string;
      })
    | {
        kind: "cloudgate";
        fromEnvironmentId: string | null;
        /** The copy that becomes the Cloudgate-kept text. */
        copy: {
          repository: string;
          path: string;
          branch: string;
          commitSha: string;
          fileUrl: string;
          text: string;
        };
      };
  reads: ConfigRead[];
  environments: Array<{
    environmentId: string;
    name: string;
    branch: string | null;
    commitSha: string | null;
    fileUrl: string | null;
    steps: PlanStep[];
    notes: PlanNote[];
  }>;
}

/** Where a Service a plan creates will run. */
export type DeployTarget =
  | { kind: "server"; serverId: string }
  | { kind: "platform-host" }
  | { kind: "cloud"; cloudAccountId: string; region: string };

export type ConfigKind =
  | "web"
  | "web-private"
  | "static"
  | "worker"
  | "postgres"
  | "mysql"
  | "redis"
  | "cron"
  | "bucket"
  /** A Compose stack, by the compose file it names (ADR-0069). */
  | "compose";

/** One field's difference, named as the config writes it (`build.dockerfile`). */
export interface FieldDiff {
  field: string;
  /** JSON; `null` is "not set". */
  from: unknown;
  to: unknown;
  /**
   * A Native setting: `field` is its path in the file's spelling
   * (`native.docker.HealthCheck.Retries`), and the line is marked native.
   */
  native?: true;
  /** A side that is the kind's default rather than a written value. */
  fromDefault?: true;
  toDefault?: true;
  /**
   * A side that is the console's value of a setting it owned before native
   * where native sets none, or once a key is taken out.
   */
  fromConsole?: true;
  toConsole?: true;
  /**
   * A side that is the entry's `size`'s value of a size-bearing argument
   * native sets none of: once a native class is taken out.
   */
  fromSize?: true;
  toSize?: true;
}

/** One AWS resource under "Show N AWS resources". */
export interface AwsRawLine {
  address: string;
  resourceType: string;
  action: "create" | "change" | "destroy" | "replace" | "adopt";
  /** Field names only, never values. */
  fields: string[];
  briefDowntime: boolean;
  drift: boolean;
}

export interface AwsCounts {
  create: number;
  change: number;
  destroy: number;
  replace: number;
  drift: number;
  adopt: number;
  briefDowntime: number;
}

/**
 * The CPU and memory a size lands on in a cloud (S17), in that
 * cloud's own wording: on AWS `{ runsOn: "Fargate", wording: "0.5 vCPU / 1 GB" }`.
 */
export interface SizePair {
  runsOn: string;
  wording: string;
  /** What the size asked for, when the cloud rounded it up: `0.5 CPU`. */
  roundedUpFrom?: string;
  /**
   * What else the plan says of how it runs: on Cloud Run a create's billing
   * and copy range, or a change's "same on Cloud Run: …".
   */
  notes?: string[];
}

/**
 * A cloud step's read of its cloud (`cloudRead` since S17):
 * still reading, failed with its reason, or the plan reader's plain summary
 * and raw cloud lines.
 */
export type CloudRead =
  | { status: "reading" }
  | { status: "failed"; reason: string }
  | {
      status: "read";
      summary: string[];
      raw: AwsRawLine[];
      counts: AwsCounts;
      drift: AwsDrift[];
      adopt: { address: string; line: string }[];
      noState: { arn: string; line: string }[];
      imageOnly: boolean;
      /**
       * What takes a database offline, each line also in `summary`:
       * a restart, or a major upgrade, which is never undone. Absent when
       * nothing does.
       */
      outages?: Outage[];
      stateId: string;
      serviceId?: string;
      /**
       * On a Service that exists: the live image it was read with,
       * or `null` before its first deploy. Its drift-only step's Apply puts
       * AWS back on that image.
       */
      liveImage?: string | null;
      /**
       * An Existing database found at another host or port: what
       * changed, as `<source>.<output>`; its Apply saves `to`, then
       * redeploys what links to it.
       */
      addressMoved?: {
        from: { host: string; port: number };
        to: { host: string; port: number };
        moved: string[];
      };
      readAt: string;
    };

/**
 * A hand change in the AWS console a plan puts back: each field's
 * hand value and Cloudgate's (a sensitive one never shown), "will be made
 * again" for what was deleted, red with brief downtime when only a replace
 * puts it back.
 */
export interface AwsDrift {
  address: string;
  resourceType: string;
  line: string;
  deleted: boolean;
  replaceForcing: boolean;
  fields: { field: string; hand: string; cloudgate: string }[];
}

/** One outage a cloud database's change brings. */
export interface Outage {
  kind: "restart" | "major-upgrade";
  serviceName: string;
  line: string;
}

/**
 * A change to a `postgres` on RDS: what moves on its instance. Only
 * what moves is set.
 */
export interface CloudPostgresChange {
  instanceClass: {
    from: string;
    to: string;
    /** `2 vCPU, 4 GB`; `null` for a native class the class table does not know. */
    machine: string | null;
    sizeName: string | null;
    /** Set by its `native.aws`. */
    native?: true;
  } | null;
  version: {
    from: string;
    to: string;
    engineVersion: string;
    autoMinorUpgrade: boolean;
  } | null;
  /** Cloudgate's own settings, edited on the cloud Database page. */
  settings: {
    setting: "storageGb" | "maxStorageGb" | "backupRetentionDays" | "multiAz";
    from: number | boolean;
    to: number | boolean;
  }[];
}

/**
 * A change to a `redis` on ElastiCache, beyond its fields: what its
 * replication group moves to. Only what moves is set.
 */
export interface CloudRedisChange {
  nodeType: {
    from: string;
    to: string;
    /** `2 vCPU, 3.09 GB`; `null` for a native node type the class table does not know. */
    machine: string | null;
    sizeName: string | null;
    /** Set by its `native.aws`. */
    native?: true;
  } | null;
  version: {
    from: string;
    to: string;
    engineVersion: string;
    parameterFamily: string;
  } | null;
  /** Cloudgate's own settings, edited on the cloud Database page. */
  settings: {
    setting: "replica" | "snapshotRetentionDays";
    from: number | boolean;
    to: number | boolean;
  }[];
}

/**
 * A part an Environment network gains for the first Service that needs it:
 * on Google Cloud the private link of a kind of database, on
 * AWS the private DNS namespace of its Private web services.
 */
export type PrivateLinkKind = "cloud-sql" | "memorystore" | "private-dns";

/** A Template part's create: its setup and how each of its values is made. */
export interface TemplateOnPlan {
  pendingSetupId: string;
  templateId: string;
  templateName: string;
  setupName: string;
  values: {
    list: "env" | "build_args" | "build_secrets";
    variable: string;
    /** `generated (base64, 32 bytes)`, `asked`, `fixed`, … */
    made: string;
  }[];
  /**
   * A `web`'s generated host, made at setup because a value names its URL
   * (#1375): its Domain is made on exactly this host. Absent otherwise.
   */
  host?: string;
  /** A compose part's Domains, on the hosts its setup picked. */
  domains?: { service: string; port: number; path: string; host: string }[];
  /** Its config files, each a file mount; never their text. */
  files?: { path: string; mount: string | null }[];
}

export type PlanStep =
  | {
      action: "create";
      configName: string;
      kind: ConfigKind;
      placement: DeployTarget;
      fields: FieldDiff[];
      /** A `web` created in a Cloud account: its size on its cloud's pair. */
      cloud?: { size: { name: string | null; pair: SizePair } };
      /**
       * A Compose stack created in a Cloud account: its Stack VM, as the
       * plan's lines for it (machine, cost, data disk).
       */
      stackVm?: StackVmOnPlan;
      /**
       * A part of a Template set up here, made from its Pending setup: how
       * each value is made, never a value (ADR-0064).
       */
      template?: TemplateOnPlan;
      /** A `postgres` created in a Cloud account: an RDS instance. */
      database?: {
        size: {
          name: string | null;
          instanceClass: string;
          /** `2 vCPU, 1 GB`; `null` for a native class the class table does not know. */
          machine: string | null;
          smallest: boolean;
          /** The class is its `native.aws`'s, which wins over the size. */
          native?: true;
        };
        version: {
          written: string;
          engineVersion: string;
          autoMinorUpgrade: boolean;
        };
        login: { user: string; database: string };
      };
      /** A `redis` created in a Cloud account: an ElastiCache group. */
      cache?: {
        size: {
          name: string | null;
          nodeType: string;
          /** `2 vCPU, 1.37 GB`; `null` for a native node type the class table does not know. */
          machine: string | null;
          smallest: boolean;
          /** The node type is its `native.aws`'s, which wins over the size. */
          native?: true;
        };
        version: {
          written: string;
          engineVersion: string;
          parameterFamily: string;
        };
      };
      cloudRead?: CloudRead;
      /**
       * A bucket's real name, minted when the plan was stored; on AWS
       * in the account regional namespace of `awsAccountId` and
       * `region`, which the plan shows beside it. On a `static` site created
       * on AWS, its own bucket's.
       */
      bucket?: { name: string; awsAccountId?: string; region?: string };
      /** A `static` site created on S3 + CloudFront: its `spa`. */
      site?: { spa: boolean };
      /**
       * A `postgres` created as the existing database a switch names:
       * nothing is made, and the next plan looks it up.
       */
      existing?: { identifier: string };
    }
  | {
      /** The Environment network, made first for a plan's first cloud `web`. */
      action: "network-create";
      cloudAccountId: string;
      region: string;
      /** The private link it is made with: on Google Cloud for this plan's databases, on AWS its private DNS namespace. */
      privateLinks?: PrivateLinkKind[];
      cloudRead: CloudRead;
    }
  | {
      /**
       * An Environment network nothing uses any more: neither a
       * Service nor the Deploy target is in its Cloud account and region.
       * Confirmed by typing `confirmName`, as a destroy is by its name.
       */
      action: "network-remove";
      environmentNetworkId: string;
      cloudAccountId: string;
      region: string;
      confirmName: string;
      /** The DNS records its Domains left at the DNS provider. */
      dnsRecordsLeft: DnsRecord[];
    }
  | {
      /**
       * The made Environment network, read for Drift by Check for changes
       * or gaining the private link its databases need.
       */
      action: "network-change";
      environmentNetworkId: string;
      cloudAccountId: string;
      region: string;
      /** The private link this plan adds to it: on Google Cloud a database's, on AWS the private DNS namespace. */
      privateLinks?: PrivateLinkKind[];
      cloudRead: CloudRead;
    }
  | {
      action: "change";
      configName: string;
      kind: ConfigKind;
      serviceType: string;
      serviceId: string;
      name: string;
      fields: FieldDiff[];
      /** A cloud `web`'s size as its read writes it, with its cloud's words. */
      cloud?: { size: { name: string | null; pair: SizePair } };
      /** A `postgres` on RDS whose instance this change moves. */
      database?: CloudPostgresChange;
      /** A `redis` on ElastiCache whose replication group this change moves. */
      cache?: CloudRedisChange;
      /**
       * A Compose stack's Stack VM this change moves (#1368): a resize, a
       * grown data disk, a replace, and the cost, as plan lines.
       */
      stackVm?: StackVmOnPlan;
      /**
       * A major version upgrade: offline while it runs and never
       * undone, so Apply needs the Service's name typed, as for a destroy.
       */
      majorUpgrade?: { from: string; to: string };
      /**
       * Why its Apply will not run it: "pg-1 is stopped. Start it
       * first." on a postgres on RDS Cloudgate stopped. The rest applies.
       */
      blocked?: string;
      /**
       * A bucket on AWS whose browser-upload origins were edited on its page
       * since its last Cloud run: the origins written, and those now.
       */
      cors?: { from: string[]; to: string[] };
      /** A `static` site on S3 + CloudFront: the `spa` it will have. */
      site?: { spa: boolean };
      /**
       * An Existing database: looked up at every plan, so it has a
       * step even when the config changes nothing. Its `cloudRead` is the
       * lookup: what was found and its notes, or why the plan is refused.
       */
      existing?: { identifier: string; version: string | null };
      /**
       * The links whose source's Output this plan changes, as
       * `<source>.<output>`; the change deploys anyway.
       */
      because?: string[];
      /**
       * A cloud Service's AWS lines, or, on the step of a plan its
       * deploy stopped on, what that deploy read; Apply approves them;
       * on a postgres on RDS's change, the read of its own state.
       * `fields` is empty on a cloud Service read only for Drift.
       */
      cloudRead?: CloudRead;
    }
  | {
      /**
       * A Service the config leaves as it is, deployed again because a
       * source it links to changes an Output.
       */
      action: "redeploy";
      configName: string;
      kind: ConfigKind;
      serviceType: string;
      serviceId: string;
      name: string;
      /** Each changed link, as `<source>.<output>`. */
      because: string[];
    }
  | {
      action: "destroy";
      configName: string;
      kind: ConfigKind;
      serviceType: string;
      serviceId: string;
      name: string;
      /**
       * A bucket's destroy only: whether it holds files, read when the
       * plan was made. `unknown` is "can't tell", which counts as holding
       * files.
       */
      files?: BucketFiles;
      /**
       * A postgres on RDS's or a redis on ElastiCache's destroy only:
       * the final snapshot it keeps unless its box is ticked. On Google
       * Cloud a Cloud SQL or Memorystore destroy's final backup.
       */
      finalSnapshot?: FinalSnapshotOnDestroy;
      /**
       * An existing database's or bucket's destroy: what it
       * uses as given, which its Delete leaves as it was. Such a bucket's
       * files are never read and never deleted, so it has no files box.
       */
      existing?: { identifier: string };
      /**
       * A Compose stack's destroy only: the volumes its Delete removes,
       * as its last successful deploy recorded them; `null` when no deploy
       * has recorded them yet.
       */
      volumes?: string[] | null;
      /**
       * A Compose stack on a Stack VM's destroy only: what its Delete
       * removes and keeps, as plan lines.
       */
      stackVm?: StackVmOnDestroy;
    };

/**
 * A Stack VM on a create or change step: the plan's own lines for it
 * (`StackVmCreate.lines`, `StackVmChange.lines`); its other fields are
 * the plan's and are not read here.
 */
export interface StackVmOnPlan {
  lines: string[];
}

/** A Stack VM's destroy: everything in its state goes, its data disk is kept. */
export interface StackVmOnDestroy {
  cloud: "aws" | "gcp";
  region: string;
  dataDiskGb: number;
  finalSnapshotMonthlyUsd: number | null;
  lines: string[];
}

/**
 * The final snapshot a cloud database's destroy keeps: named for the
 * day the plan was made, with about what it costs a month until it is
 * deleted in AWS — or, on Google Cloud, its final backup, kept
 * until it is deleted in Google Cloud. A Stack VM's is a snapshot of
 * its data disk on either cloud.
 */
export interface FinalSnapshotOnDestroy {
  /** Which cloud keeps it; absent on an older plan (AWS). */
  cloud?: "aws" | "gcp";
  name: string;
  /** `null` for a Stack VM in a region Cloudgate's rate table does not price. */
  monthlyUsd: number | null;
  /** A Stack VM's data disk: a disk snapshot, never a database backup. */
  of?: "data-disk";
}

/** Whether a destroyed bucket holds files. */
export type BucketFiles = "holds-files" | "empty" | "unknown";

export type PlanNote =
  | {
      /** A Template setup's parts, held back where it was not set up. */
      kind: "setup-held-back";
      configName: string;
      configNames: string[];
      templateId: string;
      setupName: string;
      message: string;
    }
  | {
      /**
       * A Pending setup's parts a repository-kept config's plan does not
       * create from it, renamed in the pasted entries say, and the values
       * they left unused (#1378).
       */
      kind: "setup-values-unused";
      configName: string;
      configNames: string[];
      pendingSetupId: string;
      templateId: string;
      setupName: string;
      message: string;
    }
  | {
      kind: "variable-without-value";
      configName: string;
      list: "env" | "build_args" | "build_secrets";
      variable: string;
      message: string;
    }
  | {
      kind: "console-managed-unlisted" | "console-managed-dropped";
      configName: string;
      /** The YAML to paste under `services:`. */
      line: string;
      message: string;
    }
  | {
      /** A console-managed `mysql` entry, which can now be described. */
      kind: "mysql-can-be-described";
      configName: string;
      message: string;
    }
  | {
      /**
       * A console-managed `compose` entry whose compose file is in a
       * repository, which can now be described (ADR-0069).
       */
      kind: "compose-can-be-described";
      configName: string;
      message: string;
    }
  | {
      /** A bucket a rename or kind change replaces; its files are not copied. */
      kind: "files-not-copied";
      configName: string;
      message: string;
    }
  | {
      /**
       * A database a rename or kind change replaces: "the new <name>
       * starts empty; <old>'s data is not copied".
       */
      kind: "data-not-copied";
      configName: string;
      message: string;
    }
  | {
      /**
       * A bucket on a Server with no Domain: its endpoint is the
       * internal URL, so presigned URLs and browser uploads stop working.
       */
      kind: "bucket-no-domain";
      configName: string;
      message: string;
    }
  | {
      /**
       * A variable linked to a bucket's key on AWS: the task's role
       * gives access, so it is left unset.
       */
      kind: "task-role-access";
      configName: string;
      variable: string;
      message: string;
    }
  | {
      /**
       * A variable linked to a redis's password on Google Cloud:
       * Memorystore has none, so it is left unset.
       */
      kind: "no-password";
      configName: string;
      variable: string;
      message: string;
    }
  | {
      /**
       * A variable linked to a bucket on Google Cloud: the S3 SDK's
       * checksum settings to set to `when_required`. Off until the walk by
       * hand decides it.
       */
      kind: "bucket-checksums";
      configName: string;
      variable: string;
      message: string;
    }
  | {
      /** A `web` created in a Cloud account, which gets no generated Domain. */
      kind: "cloud-no-domain";
      configName: string;
      message: string;
    }
  | {
      /**
       * A `web` on Google Cloud whose `native.gcp` closes its `run.app`
       * address, and the warning beside it when it has no Domain.
       */
      kind: "run-app-closes" | "run-app-closes-no-domain";
      configName: string;
      message: string;
    }
  | {
      /**
       * An always-running Service on Google Cloud whose live image has a
       * `HEALTHCHECK`, which Cloud Run cannot run. Once per Service.
       */
      kind: "healthcheck-not-run";
      configName: string;
      message: string;
    }
  | {
      /**
       * A cloud database's version suffix the cloud drops, or a size landing
       * on the class it already runs on: no change on AWS; or a redis
       * of 7 or lower, which runs as Valkey 7.2, the oldest on AWS; or,
       * once per plan, that Memorystore never moves a Valkey minor.
       */
      kind:
        | "cloud-version-suffix"
        | "cloud-same-class"
        | "cloud-version-oldest"
        | "cloud-version-minor";
      configName: string;
      message: string;
    }
  | {
      /**
       * A `static` site on S3 + CloudFront setting fields only a container
       * has: ignored, never refused, named in one note; on Cloud
       * Storage + Cloud CDN the same.
       */
      kind: "ignored-on-s3" | "ignored-on-cloud-cdn";
      configName: string;
      fields: string[];
      message: string;
    }
  | {
      /**
       * A `static` site created on Google Cloud: its $0/month fixed
       * cost with serving charged by use, and that it answers nowhere until
       * a Domain is added; and its `spa` change, a run of the
       * Environment network that clears its Domains' cache at its end.
       */
      kind: "static-by-use" | "static-no-domain" | "static-spa-change";
      configName: string;
      message: string;
    }
  | {
      /**
       * An entry an Existing database stands for: the config's
       * `database`, `user`, `size` and `version` are not applied to it.
       */
      kind: "existing-not-applied";
      configName: string;
      message: string;
    }
  | {
      /**
       * A native argument the pinned provider deprecates: planned,
       * with this warning naming its full path.
       */
      kind: "native-deprecated";
      configName: string;
      at: string;
      message: string;
    }
  | {
      /**
       * A native block names an address by its name before a rename
       * planned as under the new name, with this warning naming both.
       */
      kind: "native-renamed";
      configName: string;
      at: string;
      from: string;
      to: string;
      message: string;
    };

export type PlanStatus =
  | "open"
  | "applied"
  | "partly-applied"
  | "dismissed"
  | "superseded"
  | "unchanged";

/** What an Apply did about a Service's Deployment once a step wrote it. */
export type PlanStepDeploy =
  /** An Application's ordinary Deployment, queued; its build is its own. */
  | { status: "queued"; deploymentId: string }
  /** A database's deploy, which writes no Deployment; its status follows it. */
  | { status: "started" }
  | { status: "not-deployed"; message: string };

/**
 * What a destroy's Delete said it left behind, as the Delete answers
 * it: each field absent rather than empty. `volumeLeftBehind` is a
 * database's data volume, which a Delete keeps: `true` kept, `null` unknown.
 * `bucketLeftBehind` is a bucket the Delete kept with its files.
 */
export type PlanStepLeftovers = Pick<
  TeardownReport,
  "unreclaimedArtifacts" | "unreclaimedImages" | "orphanedPreviews"
> & {
  volumeLeftBehind?: boolean | null;
  bucketLeftBehind?: BucketLeftBehind;
  /** An existing bucket's destroy: left as it was, files and all. */
  bucketLeftAsItWas?: { bucketName: string; message: string };
};

/**
 * One step's result, in the order the Apply ran it, the plan's step order:
 * the Environment network first, a kind change's create right after
 * its destroy, a link's source before what links to it. `running` is the network's alone: the Apply
 * answers while its run makes it, and the rest follows.
 */
export interface PlanStepResult {
  /** The Config name; for the network, `Environment network (<region>)`. */
  configName: string;
  action:
    | "network-create"
    | "network-change"
    | "create"
    | "change"
    | "redeploy"
    | "destroy"
    | "network-remove";
  /** `blocked`: a change to a stopped RDS instance, not tried. */
  status: "running" | "applied" | "failed" | "blocked";
  /** Why it failed or is blocked; `null` when it was applied. */
  message: string | null;
  serviceType: string | null;
  serviceId: string | null;
  /** A plan-created `web`'s generated sslip.io host. */
  domain: string | null;
  deploy: PlanStepDeploy | null;
  /**
   * A destroy's leftovers; `null` when it left nothing. Absent on a plan
   * applied before destroys could be.
   */
  leftovers?: PlanStepLeftovers | null;
  /** The network step's run: the network made and the Deployment recording it. */
  network?: { environmentNetworkId: string; deploymentId: string };
  /** A network removal's DNS records its Domains left. */
  dnsRecordsLeft?: DnsRecord[];
  /**
   * A change of a `web`'s `port` on a Server or the platform host: the
   * Domains it moved and those it left (ADR-0068); absent on every other step.
   */
  domainPortMove?: DomainPortMove;
}

/** The Config names an Apply confirms by typing each Service's name. */
export interface PlanConfirmation {
  destroy: readonly string[];
  upgrade: readonly string[];
  /** The destroyed buckets whose files go too; absent is none. */
  deleteFilesOf?: readonly string[];
  /**
   * The destroyed cloud databases whose data goes too, with no final
   * snapshot; absent is none.
   */
  deleteDataOf?: readonly string[];
}

/** The `plan` row (without the config text, which is the Project's). */
export interface Plan {
  planId: string;
  environmentId: string;
  /** `deploy`: a cloud Service's deploy stopped on more than its image. */
  source: "push" | "request" | "save" | "move" | "generate" | "deploy";
  textHash: string;
  /**
   * The commit a repository-kept config was read at, and the Config branch
   * it was read from; `null` for a Cloudgate-kept config.
   */
  commitSha: string | null;
  branch: string | null;
  /** The stored text's hash when the plan was made. */
  baseTextHash: string;
  settingsFingerprint: string;
  /** Creates, then changes, then destroys. */
  steps: PlanStep[];
  notes: PlanNote[];
  status: PlanStatus;
  /** Each step's result, once applied; `null` before. */
  results: PlanStepResult[] | null;
  requestedBy: string | null;
  createdAt: string;
  appliedBy: string | null;
  appliedAt: string | null;
  dismissedBy: string | null;
  dismissedAt: string | null;
  /**
   * The builds this plan holds or held: an Application's build a push
   * held because the same push changed its own config entry. `held` until
   * the plan is applied (new settings) or dismissed (old ones), a newer plan
   * no longer changes it, or "Build now with saved settings" releases it.
   * Absent on a synthetic plan (a move preview's).
   */
  heldBuilds?: HeldBuild[];
  /**
   * The cloud deploy this plan was opened for: one no Apply queued
   * that met more than its new image and stopped before any change. Its step
   * is the change of `configName`. Absent on a feed older than the field.
   */
  stoppedDeployment?: StoppedDeployment | null;
}

/** A deploy a plan was opened for. */
export interface StoppedDeployment {
  deploymentId: string;
  applicationId: string;
  configName: string;
  title: string;
  status: DeploymentStatus;
  createdAt: string;
}

/** A build a plan holds or held. */
export interface HeldBuild {
  deploymentId: string;
  applicationId: string;
  configName: string;
  title: string;
  description: string | null;
  status: DeploymentStatus;
  createdAt: string;
}

export const projectConfigApi = {
  findConfig: (projectId: string) =>
    api.get<ProjectConfig>(`/projects/${projectId}/config`),

  /** An Environment's copy, read now; a refusal says why it cannot be. */
  findCopy: (environmentId: string) =>
    api.get<EnvironmentConfigCopy>(`/environments/${environmentId}/config`),

  /**
   * Reads every Environment's copy at the new place and plans it, storing
   * nothing. `CONFIG_UNREADABLE` or `PLAN_REFUSED` (409) names the
   * Environment, repository and branch that could not be read or planned.
   */
  previewMove: (projectId: string, to: MoveTarget) =>
    api.post<MovePreview>(`/projects/${projectId}/config/move/preview`, {
      to,
    }),

  /**
   * Switches the location and leaves each Environment's plan open; applies
   * nothing. `MOVE_STALE` (409) when a copy changed since the preview.
   */
  confirmMove: (
    projectId: string,
    to: MoveTarget,
    reads: readonly ConfigRead[],
  ) =>
    api.post<{ location: ConfigLocation; plans: Plan[] }>(
      `/projects/${projectId}/config/move`,
      { to, reads },
    ),

  /** The open plan, else the latest, else `{ plan: null }`. */
  findPlan: (environmentId: string) =>
    api.get<{ plan: Plan | null }>(`/environments/${environmentId}/plan`),

  /** "Check for changes". A config that cannot be planned is a 409. */
  requestPlan: (environmentId: string) =>
    api.post<Plan>(`/environments/${environmentId}/plan`),

  dismissPlan: (environmentId: string, planId: string) =>
    api.post<Plan>(`/environments/${environmentId}/plan/dismiss`, { planId }),

  /**
   * The whole-YAML edit: a plan per Environment, nothing applied. `stored`
   * is true only when no Environment has anything to change.
   */
  saveConfig: (projectId: string, text: string) =>
    api.post<{ stored: boolean; plans: Plan[] }>(
      `/projects/${projectId}/config/plans`,
      { text },
    ),

  /**
   * Applies the open plan, `confirm.destroy` naming the Config name of every
   * Service it destroys and `confirm.upgrade` of every Service it upgrades
   * to a new major version, and no other. Refused with
   * `PLAN_DESTROY_NOT_CONFIRMED` or `PLAN_UPGRADE_NOT_CONFIRMED` when a set
   * is not exactly the plan's, `PLAN_STALE` when the config or the settings
   * moved on, `PLAN_REFUSED` when a repository is out of reach, and 403 when
   * a step needs a statement the caller lacks — all with nothing written.
   * `confirm.deleteFilesOf` names the destroyed buckets whose files go too,
   * one tick per bucket; every other bucket that holds files is kept.
   */
  applyPlan: (
    environmentId: string,
    planId: string,
    confirm: PlanConfirmation,
  ) =>
    api.post<Plan>(`/environments/${environmentId}/plan/apply`, {
      planId,
      confirmDestroy: confirm.destroy,
      confirmUpgrade: confirm.upgrade,
      deleteFilesOf: confirm.deleteFilesOf ?? [],
      deleteDataOf: confirm.deleteDataOf ?? [],
    }),
};
