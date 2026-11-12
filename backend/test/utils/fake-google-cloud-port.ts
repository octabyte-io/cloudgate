import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type {
  DnsAnswer,
  GoogleCredential,
  GoogleStateResource,
  TofuApplyOutcome,
  TofuApplyRequest,
  TofuPlanOutcome,
  TofuRunRequest,
  TofuShow,
  TofuStateOutcome,
  TofuStateReadRequest,
} from '../../src/cloud-accounts/cloud.port';
import type {
  CacheClearRequest,
  CloudBuildLogRequest,
  CloudBuildRef,
  CloudBuildStartRequest,
  BuildSecretPut,
  SecretRef,
  CloudBuildState,
  CloudBuildStatusName,
  CloudRunExecutionRef,
  CloudRunExecutionStatus,
  CloudRunJobRef,
  CloudRunScaling,
  CloudRunServiceRef,
  CloudSqlBackups,
  CloudRunServiceStatus,
  CloudRunWorkerPoolRef,
  CloudRunWorkerPoolStatus,
  CloudSqlActivationPolicy,
  CloudSqlInstanceRead,
  CloudSqlInstanceRef,
  ComputeInstanceRef,
  ComputeInstanceStatus,
  CopyRange,
  CredentialConfigurationRequest,
  ExistingCloudSqlRef,
  ExistingValkeyRef,
  FindByLabelRequest,
  FindByNameRequest,
  FoundByLabel,
  FoundByName,
  GoogleAccessToken,
  GoogleAnswer,
  GoogleCertificate,
  GoogleCertificateRef,
  GoogleCloudPort,
  GoogleDatabaseRef,
  GoogleLocationsApi,
  GoogleProject,
  ExecutionLogRequest,
  ImageVersionsRequest,
  ImpersonateRequest,
  LogEntriesRequest,
  LogEntry,
  MemorystoreBackups,
  MemorystoreInstanceRef,
  ObjectCopyRequest,
  MemorystoreInstanceRead,
  ObjectListRequest,
  ObjectRef,
  ObjectUploadRequest,
  PscConnectionStatus,
  PscEndpointRef,
  RevisionLabel,
  StorageBucketRead,
  StoredObject,
  TakenBackup,
  DiskRef,
  DiskSnapshotRequest,
  TakenDiskSnapshot,
  TokenExchangeRequest,
} from '../../src/cloud-accounts/google-cloud.port';
import {
  NOT_FOUND,
  PERMISSION_DENIED,
} from '../../src/cloud-accounts/google-cloud.port';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import { GOOGLE_REGIONS } from '../../src/cloud-accounts/gcp/regions';
import { googleStateResources } from '../../src/cloud-accounts/gcp/state-resources';
import type { TofuStateShow } from '../../src/cloud-accounts/tofu/state-show';
import {
  OPENTOFU_VERSION,
  PINNED_PROVIDERS,
  providerDirectory,
} from '../../src/cloud-accounts/tofu/tofu-environment';
import type { PinnedProvider } from '../../src/cloud-accounts/tofu/tofu-environment';
import { TofuRunner } from '../../src/cloud-accounts/tofu/tofu-runner';

/** The token a fake STS hands out, and the one a fake impersonation does. */
const FEDERATED = 'fake-federated-token';
const IMPERSONATED = 'fake-impersonated-token';

/** What the fake's project number is unless a spec says otherwise. */
export const FAKE_PROJECT_NUMBER = '123456789012';

/** A token's header and claims, decoded — never its signature. */
export interface DecodedToken {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

/** One call the fake answered, without any token in it. */
export type FakeGoogleCall =
  | { method: 'exchangeToken'; audience: string; token: DecodedToken }
  | {
      method: 'impersonate';
      serviceAccount: string;
      lifetimeSeconds: number;
      /** Whether it was handed the fake STS's token. */
      federated: boolean;
    }
  | { method: 'getProject'; projectId: string; impersonated: boolean }
  | {
      method: 'testIamPermissions';
      projectId: string;
      permissions: string[];
    }
  | { method: 'enabledApis'; projectNumber: string }
  | {
      method: 'listLocations';
      projectId: string;
      api: GoogleLocationsApi;
      impersonated: boolean;
    }
  | { method: 'countNetworks'; projectId: string; impersonated: boolean }
  | ({ method: 'findByName'; impersonated: boolean } & FindByNameRequest)
  | ({ method: 'findByLabel'; impersonated: boolean } & FindByLabelRequest)
  | ({ method: 'cloudRunService'; impersonated: boolean } & CloudRunServiceRef)
  | ({
      method: 'setCloudRunScaling';
      impersonated: boolean;
      scaling: CloudRunScaling;
    } & CloudRunServiceRef)
  | ({
      method: 'setCloudRunCopies';
      impersonated: boolean;
      copies: CopyRange;
    } & CloudRunServiceRef)
  | ({
      method: 'setRevisionLabel';
      impersonated: boolean;
      label: RevisionLabel;
    } & CloudRunServiceRef)
  // A Worker's worker pool.
  | ({
      method: 'cloudRunWorkerPool';
      impersonated: boolean;
    } & CloudRunWorkerPoolRef)
  | ({
      method: 'setWorkerPoolInstances';
      impersonated: boolean;
      instances: number;
    } & CloudRunWorkerPoolRef)
  | ({
      method: 'setWorkerPoolRevisionLabel';
      impersonated: boolean;
      label: RevisionLabel;
    } & CloudRunWorkerPoolRef)
  // A Cron service's job and its executions.
  | ({ method: 'runCloudRunJob'; impersonated: boolean } & CloudRunJobRef)
  | ({
      method: 'cloudRunExecution' | 'cancelCloudRunExecution';
      impersonated: boolean;
    } & CloudRunExecutionRef)
  | ({
      method: 'executionLogEntries';
      impersonated: boolean;
    } & ExecutionLogRequest)
  | ({
      method: 'setCloudSqlActivationPolicy';
      impersonated: boolean;
      policy: CloudSqlActivationPolicy;
    } & CloudSqlInstanceRef)
  | ({
      method:
        | 'stopComputeInstance'
        | 'startComputeInstance'
        | 'computeInstanceStatus';
      impersonated: boolean;
    } & ComputeInstanceRef)
  | ({ method: 'listLogEntries'; impersonated: boolean } & LogEntriesRequest)
  | ({
      method: 'deleteImageVersionsExcept';
      impersonated: boolean;
    } & ImageVersionsRequest)
  | ({ method: 'certificate'; impersonated: boolean } & GoogleCertificateRef)
  | ({
      method: 'liftCloudSqlDeletionProtection' | 'stopRetainingCloudSqlBackups';
      impersonated: boolean;
    } & CloudSqlInstanceRef)
  | ({
      method: 'takeCloudSqlBackup';
      impersonated: boolean;
      description: string;
    } & CloudSqlInstanceRef)
  | ({
      method: 'takeMemorystoreBackup';
      impersonated: boolean;
      backupId: string;
    } & MemorystoreInstanceRef)
  | ({
      method: 'cloudSqlBackups' | 'memorystoreBackups';
      impersonated: boolean;
    } & GoogleDatabaseRef)
  // A Stack VM's Delete (#1367): its final snapshot, and the schedule's.
  | ({ method: 'takeDiskSnapshot' } & DiskSnapshotRequest)
  | ({ method: 'scheduledDiskSnapshots' } & DiskRef)
  | { method: 'deleteDiskSnapshot'; projectId: string; name: string }
  // A static site's objects in Cloud Storage, each in the order
  // asked, so a deploy's copy order is observable.
  | ({ method: 'listObjects'; impersonated: boolean } & ObjectListRequest)
  | ({
      method: 'uploadObject';
      impersonated: boolean;
      contentType: string;
    } & ObjectRef)
  | ({ method: 'copyObject'; impersonated: boolean } & ObjectCopyRequest)
  | ({ method: 'deleteObject'; impersonated: boolean } & ObjectRef)
  // A static site's Delete emptying its bucket.
  | { method: 'emptyBucket'; impersonated: boolean; bucket: string }
  | ({
      method: 'cloudSqlInstance';
      impersonated: boolean;
    } & ExistingCloudSqlRef)
  | ({ method: 'pscEndpointStatus'; impersonated: boolean } & PscEndpointRef)
  // A static site's per-Domain cache clear, in the order asked.
  | ({ method: 'invalidateCache'; impersonated: boolean } & CacheClearRequest)
  | ({
      method: 'memorystoreInstance';
      impersonated: boolean;
    } & ExistingValkeyRef)
  // An existing bucket's lookup and its key's access check; the
  // check names the key's access id, never its secret.
  | { method: 'storageBucket'; impersonated: boolean; bucket: string }
  | { method: 'stateResources'; stateId: string; region: string }
  // A hosted cloud build in Cloud Build.
  | ({
      method: 'startCloudBuild';
      impersonated: boolean;
    } & CloudBuildStartRequest)
  | ({
      method: 'cloudBuild' | 'cancelCloudBuild';
      impersonated: boolean;
    } & CloudBuildRef)
  | ({
      method: 'cloudBuildLogEntries';
      impersonated: boolean;
    } & CloudBuildLogRequest)
  // A copy build's registry password: its value only in `secrets`.
  | ({
      method: 'putBuildSecret';
      impersonated: boolean;
    } & Omit<BuildSecretPut, 'value'>)
  | ({ method: 'deleteSecret'; impersonated: boolean } & SecretRef)
  | {
      method: 'plan' | 'apply' | 'destroy';
      stateId: string;
      /** Which definition it was: the network's or a Service's. */
      kind: GoogleDefinitionKind;
      /** The names of the `TF_VAR_`s it was handed, never their values. */
      variables: string[];
      /** The addresses it was limited to, if any. */
      targets?: string[];
      /**
       * A network definition's Domains, by id: each one's host and
       * the name its certificate and map entry are given.
       */
      domains?: Record<string, { host: string; certificate: string }>;
      /** The run's credential configuration, less the token in it. */
      credential: Record<string, unknown>;
      /** The proof that configuration carries, decoded. */
      proof: DecodedToken;
    };

/**
 * Which Google definition a run was given, read off its resources: the
 * network's, a `web`'s, a postgres on Cloud SQL's, a redis on
 * Memorystore's, a bucket on Cloud Storage's, a static
 * site's, an Existing database's endpoint and zone, an
 * existing bucket's key account and key, with no bucket, a
 * Worker's worker pool, a Private web service's internal-only
 * service, a Cron service's job, or the destroy-only one,
 * which has none.
 */
export type GoogleDefinitionKind =
  | 'network'
  | 'web'
  | 'worker'
  | 'cron'
  | 'web-private'
  | 'postgres'
  /** A mysql on Cloud SQL: the Cloud SQL definition, a MySQL version. */
  | 'mysql'
  | 'redis'
  | 'bucket'
  | 'static'
  | 'existing-postgres'
  | 'existing-redis'
  | 'existing-bucket'
  | 'destroy';

const DEFINITION_KINDS: readonly GoogleDefinitionKind[] = [
  'network',
  'web',
  'worker',
  'cron',
  'web-private',
  'postgres',
  'mysql',
  'redis',
  'bucket',
  'static',
  'existing-postgres',
  'existing-redis',
  'existing-bucket',
  'destroy',
];

/** One object an object call wrote, deleted or copied. */
export type FakeObjectOperation =
  | { readonly op: 'upload'; readonly bucket: string; readonly name: string }
  | {
      readonly op: 'copy';
      readonly bucket: string;
      readonly from: string;
      readonly to: string;
    }
  | { readonly op: 'delete'; readonly bucket: string; readonly name: string };

/**
 * One execution of a Cron service's job the fake's Cloud Run holds:
 * where it runs, how it is going, and the image its job ran when it began,
 * so a deploy while it runs is seen not to change it.
 */
export interface FakeExecution extends CloudRunExecutionRef {
  state: CloudRunExecutionStatus['state'];
  exitCode: number | null;
  message: string | null;
  /** The image of the job's last applied definition when it started. */
  readonly image: string | null;
}

/**
 * How the fake's next Cloud Build build goes. By default it runs at
 * once, writes no lines and succeeds, its step writing an amd64 image with
 * no `HEALTHCHECK` to `$BUILDER_OUTPUT/output`.
 */
export interface FakeCloudBuildScript {
  /** How long, in real milliseconds, it waits in Cloud Build's queue. */
  queuedMs?: number;
  /** What it writes to Cloud Logging, one line per state read while it runs. */
  lines?: string[];
  /**
   * Lines Cloud Logging shows only once the build has ended and so many
   * reads of its log have missed them: the last lines of a build, taken in
   * its last second (a lesson learned).
   */
  lateLines?: { lines: string[]; reads: number };
  /** It keeps running, its lines written, until {@link FakeGoogleCloudPort.endCloudBuild}. */
  held?: boolean;
  /** How it ends by itself. */
  status?: 'SUCCESS' | 'FAILURE' | 'INTERNAL_ERROR' | 'TIMEOUT';
  /** Google's words for how it failed (`failureInfo.detail`). */
  reason?: string;
  /** What its step wrote to `$BUILDER_OUTPUT/output`. */
  image?: string;
  /** `builds.create`'s refusal, in Google's words; no build is started. */
  refusal?: { code: string; message: string };
}

/** A build the fake's Cloud Build started. */
export interface FakeCloudBuild {
  readonly buildId: string;
  readonly request: CloudBuildStartRequest;
  readonly script: FakeCloudBuildScript;
  readonly startedAt: number;
  /** How many of its lines it has written. */
  written: number;
  /** How many reads of its log have missed its late lines so far. */
  missed: number;
  /** How it ended, once it has. */
  ended: CloudBuildStatusName | null;
  /** Whether its cancel was asked. */
  cancelAsked: boolean;
}

/** An object the fake's Cloud Storage holds. */
interface HeldObject {
  readonly md5Hash: string;
  readonly size: number;
  readonly contentType: string;
}

/** A stored Google `tofu show -json`, by its name in `fixtures/plans/google/`. */
export function storedGooglePlan(name: string): TofuShow {
  return JSON.parse(
    readFileSync(
      join(
        __dirname,
        '..',
        'cloud-accounts',
        'fixtures',
        'plans',
        'google',
        `${name}.json`,
      ),
      'utf8',
    ),
  ) as TofuShow;
}

/**
 * A stored Google `tofu output -json`, by its name in
 * `fixtures/applies/google/`, without the fixture's own note.
 */
export function storedGoogleOutputs(name: string): Record<string, unknown> {
  const stored = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '..',
        'cloud-accounts',
        'fixtures',
        'applies',
        'google',
        `${name}.json`,
      ),
      'utf8',
    ),
  ) as { outputs: Record<string, unknown> };
  return stored.outputs;
}

/** A stored Google `tofu show -json` of a state, by its name in `fixtures/states/`. */
export function storedGoogleState(name: string): TofuStateShow {
  return JSON.parse(
    readFileSync(
      join(
        __dirname,
        '..',
        'cloud-accounts',
        'fixtures',
        'states',
        `${name}.json`,
      ),
      'utf8',
    ),
  ) as TofuStateShow;
}

/** What `tofu show -json` prints for a plan with nothing to do. */
const EMPTY_PLAN: TofuShow = {
  format_version: '1.2',
  terraform_version: OPENTOFU_VERSION,
  resource_changes: [],
};

const REPLAY_TOFU = resolve(
  __dirname,
  '..',
  'cloud-accounts',
  'fixtures',
  'replay-google-tofu.sh',
);
const PINS = resolve(__dirname, '..', '..', '..', 'deploy', 'opentofu');

/** A call a spec can script a refusal of; a `tofu` run fails through `failRunFor`. */
type Method = Exclude<
  FakeGoogleCall['method'],
  'plan' | 'apply' | 'destroy' | 'stateResources'
>;

/**
 * A call a Deployment makes that a spec can refuse some of, or act on as it
 * arrives: a static site's Cloud Storage object's or cache clear, or
 * the wait for a Cloud Run revision's read (as walked).
 */
type ObjectMethod =
  | 'uploadObject'
  | 'copyObject'
  | 'deleteObject'
  | 'invalidateCache'
  | 'cloudRunService';

/**
 * The Google client port's in-memory fake, registered in every
 * e2e app as `ctx.google`. It says yes unless a spec scripts otherwise:
 * every permission granted, every API on, any project read with
 * {@link FAKE_PROJECT_NUMBER}, Cloud Run and Artifact Registry in every
 * region Cloudgate knows, and no network yet. A spec scripts what Google would answer —
 * a refusal of any call with any code ({@link refuse}, with
 * {@link notFound} and {@link permissionDenied} for the two the port names),
 * permissions withheld, APIs off, another project behind the id, an API
 * missing from a region, a number of networks — never what
 * Cloudgate concludes from it.
 */
export class FakeGoogleCloudPort implements GoogleCloudPort {
  readonly calls: FakeGoogleCall[] = [];
  /** Each Stack VM's Compute Engine status, by name; one not named is `RUNNING`. */
  private readonly computeStatuses = new Map<string, ComputeInstanceStatus>();
  /**
   * What each `tofu` run was handed: its definition as written to
   * `main.tf.json` and its variables' values (S1), for a spec asserting a
   * value reached `tofu` as a variable and nowhere in the definition.
   * {@link calls} keeps only the variables' names.
   */
  readonly tofuInputs: {
    method: 'plan' | 'apply' | 'destroy';
    stateId: string;
    definition: string;
    variables: Record<string, string>;
  }[] = [];
  /** Every token STS was handed, whole, so a spec can verify its signature. */
  readonly subjectTokens: string[] = [];
  private readonly refusals = new Map<
    Method,
    { code: string; message: string }
  >();
  /**
   * Refusals of only some calls: `after` answered first, then `times`
   * refused, or `times` that never answer at all (`throws`).
   */
  private readonly someRefused = new Map<
    ObjectMethod,
    {
      after: number;
      times: number;
      code: string;
      message: string;
      throws: boolean;
    }
  >();
  /** What a spec does as each object call arrives, before it is answered. */
  private readonly onArrival = new Map<ObjectMethod, () => void>();
  private readonly withheld = new Set<string>();
  private readonly off = new Set<string>();
  private project: Partial<GoogleProject> = {};
  private readonly missing = new Map<GoogleLocationsApi, Set<string>>();
  private networks = 0;
  private found: FoundByName[] = [];
  /** What the label search finds, each by its labels. */
  private labelled: FoundByLabel[] = [];
  private held: Promise<void> | null = null;
  /** How many more reads of a Cloud Run service answer "still rolling out". */
  private pendingPolls = 0;
  /**
   * Each worker pool's manual instance count, by its name: the last
   * one set, or 1, a new Worker's `replicas`, before any is.
   */
  private readonly poolInstances = new Map<string, number>();
  /** A new revision's failure, once scripted, and the lines it printed. */
  private failure: { reason: string; lines: string[] } | null = null;
  /** What the project's log store holds beyond a failure's lines. */
  private readonly logEntries: LogEntry[] = [];
  /**
   * Every execution of a Cron service's job started, in order, as
   * Google holds it: a spec ends, fails or forgets one.
   */
  readonly executions: FakeExecution[] = [];
  /**
   * What each execution printed, as Cloud Logging holds it; an
   * entry with `hiddenFor` reads left is not shown yet.
   */
  private readonly executionLogs: {
    readonly execution: string;
    readonly entry: LogEntry;
    hiddenFor?: number;
  }[] = [];
  private logClock = 0;
  /** The image versions each repository holds, by tag. */
  private readonly versions = new Map<string, Set<string>>();
  /** What Certificate Manager says of each certificate, by its full name. */
  private readonly certificates = new Map<string, GoogleCertificate>();
  /** What DNS answers for each name. */
  private readonly dns = new Map<string, DnsAnswer>();
  /** How much each product's next on-demand backup holds, in bytes. */
  private backupBytes: Record<'cloud-sql' | 'memorystore', number | null> = {
    ...DEFAULT_BACKUP_BYTES,
  };
  /** What Cloud SQL holds of each instance's backups, by its name. */
  private readonly sqlBackups = new Map<string, CloudSqlBackups>();
  /** What Memorystore holds of each instance's backups, by its name. */
  private readonly cacheBackups = new Map<string, MemorystoreBackups>();
  /** What Cloud SQL says of each instance, by `<project>/<instance>`. */
  private readonly sqlInstances = new Map<string, CloudSqlInstanceRead>();
  /** What Memorystore says of each instance, by `<project>/<region>/<instance>`. */
  private readonly cacheInstances = new Map<string, MemorystoreInstanceRead>();
  /** Each manual endpoint's status, by its forwarding rule's name. */
  private readonly endpointStatuses = new Map<string, PscConnectionStatus>();
  /** What Cloud Storage says of each existing bucket, by its name. */
  private readonly storageBuckets = new Map<string, StorageBucketRead>();
  /** A destroy of each of these states fails, `tofu` printing the error. */
  private readonly failedDestroys = new Map<string, string>();
  /** What each Cloud Storage bucket holds, by object name. */
  private readonly buckets = new Map<string, Map<string, HeldObject>>();
  /** Each uploaded object's bytes, by `bucket/name`, kept after a delete. */
  readonly bodies = new Map<string, Buffer>();
  /** The scripts of the next Cloud Build builds, in order. */
  private buildScripts: FakeCloudBuildScript[] = [];
  /** Every build Cloud Build started, by id, in order. */
  private readonly cloudBuilds = new Map<string, FakeCloudBuild>();
  /** Secret Manager's secrets a copy build reads, by `<project>/<id>`. */
  private readonly buildSecrets = new Map<
    string,
    { value: string; reader: string; versionName: string }
  >();
  /** An emptying of each of these buckets stops after so many objects, Google refusing the next. */
  private readonly stoppedEmptyings = new Map<
    string,
    { after: number; code: string; message: string }
  >();
  /** The stored outputs each kind's apply answers, before the Domains'. */
  private readonly outputs = new Map<
    GoogleDefinitionKind,
    Record<string, unknown>
  >();
  /**
   * The `tofu` half: the real shared runner, with a stand-in `tofu`
   * (`fixtures/replay-google-tofu.sh`) that replays what a spec scripted
   * here, so a run's folder and credential file are the product's own.
   */
  private readonly root = mkdtempSync(join(tmpdir(), 'fake-google-tofu-'));
  private readonly runner = this.makeRunner();

  reset(): void {
    this.computeStatuses.clear();
    this.found = [];
    this.labelled = [];
    this.held = null;
    this.pendingPolls = 0;
    this.poolInstances.clear();
    this.failure = null;
    this.logEntries.length = 0;
    this.executions.length = 0;
    this.executionLogs.length = 0;
    this.logClock = 0;
    this.versions.clear();
    this.certificates.clear();
    this.dns.clear();
    this.sqlBackups.clear();
    this.cacheBackups.clear();
    this.sqlInstances.clear();
    this.cacheInstances.clear();
    this.endpointStatuses.clear();
    this.storageBuckets.clear();
    this.failedDestroys.clear();
    this.backupBytes = { ...DEFAULT_BACKUP_BYTES };
    this.buckets.clear();
    this.bodies.clear();
    this.buildScripts = [];
    this.cloudBuilds.clear();
    this.buildSecrets.clear();
    this.stoppedEmptyings.clear();
    for (const kind of DEFINITION_KINDS) {
      this.replayPlanFor(kind, null);
      this.replayOutputsFor(kind, null);
      rmSync(join(this.root, `fail-${kind}`), { force: true });
      rmSync(join(this.root, `fail-apply-${kind}`), { force: true });
    }
    for (const file of readdirSync(this.root)) {
      if (/^(plan-(state|importing)-|state-|unreadable-)/.test(file)) {
        rmSync(join(this.root, file), { force: true });
      }
    }
    rmSync(join(this.root, 'credentials'), { force: true });
    this.calls.length = 0;
    this.tofuInputs.length = 0;
    this.subjectTokens.length = 0;
    this.refusals.clear();
    this.someRefused.clear();
    this.onArrival.clear();
    this.withheld.clear();
    this.off.clear();
    this.project = {};
    this.missing.clear();
    this.networks = 0;
  }

  /** Google refuses every later call of `method` with `code`. */
  refuse(method: Method, code: string, message: string): void {
    this.refusals.set(method, { code, message });
  }

  /**
   * Google answers the next `after` calls of `method`, refuses the `times`
   * after them with `code`, then answers again: a passing error, as
   * a copy into a static site's `live/` meets one partway.
   */
  refuseSome(
    method: ObjectMethod,
    code: string,
    message: string,
    { after = 0, times = 1 }: { after?: number; times?: number } = {},
  ): void {
    this.someRefused.set(method, {
      after,
      times,
      code,
      message,
      throws: false,
    });
  }

  /**
   * As {@link refuseSome}, but the `times` calls get no answer at all: the
   * request times out or the connection drops, so the call throws `message`
   * rather than answering with Google's code.
   */
  failSome(
    method: ObjectMethod,
    message: string,
    { after = 0, times = 1 }: { after?: number; times?: number } = {},
  ): void {
    this.someRefused.set(method, {
      after,
      times,
      code: '',
      message,
      throws: true,
    });
  }

  /**
   * Runs `hook` as each call of `method` arrives, before Google answers it,
   * with how many have arrived since (1 for the first): how a spec
   * moves a hand clock on while a copy is under way.
   */
  whenCalled(method: ObjectMethod, hook: (count: number) => void): void {
    let count = 0;
    this.onArrival.set(method, () => hook((count += 1)));
  }

  notFound(method: Method, message = 'Requested entity was not found.'): void {
    this.refuse(method, NOT_FOUND, message);
  }

  permissionDenied(
    method: Method,
    message = 'The caller does not have permission',
  ): void {
    this.refuse(method, PERMISSION_DENIED, message);
  }

  /** The deploy service account lacks these permissions. */
  withhold(...permissions: string[]): void {
    for (const permission of permissions) this.withheld.add(permission);
  }

  /** These APIs are off in the project. */
  turnOff(...apis: string[]): void {
    for (const api of apis) this.off.add(api);
  }

  /** `projects.get` answers this, whatever id it was asked for. */
  answerProject(project: Partial<GoogleProject>): void {
    this.project = project;
  }

  /** `api` is not offered in these regions. */
  notOfferedIn(api: GoogleLocationsApi, ...regions: string[]): void {
    const set = this.missing.get(api) ?? new Set<string>();
    for (const region of regions) set.add(region);
    this.missing.set(api, set);
  }

  /** The project has this many VPC networks. */
  haveNetworks(count: number): void {
    this.networks = count;
  }

  /**
   * STS answers nothing until the returned release is called: a read held
   * mid-sign-in, for a spec to look at its plan while it is still reading.
   */
  holdSignIn(): () => void {
    let release!: () => void;
    this.held = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.held = null;
      release();
    };
  }

  /** Google's list calls find these, each by its kind and name prefix. */
  find(...found: FoundByName[]): void {
    this.found.push(...found);
  }

  /** Google's list calls find nothing any more: what a Retry's run removed. */
  findNothing(): void {
    this.found = [];
    this.labelled = [];
  }

  /** The label search finds these, each by the labels it carries. */
  findLabelled(...found: FoundByLabel[]): void {
    this.labelled.push(...found);
  }

  /** The next `polls` reads of a Cloud Run service answer it still rolling out. */
  rolloutTakes(polls: number): void {
    this.pendingPolls = polls;
  }

  /**
   * Every Cloud Run service's newest revision fails to become ready with
   * `reason`, having printed `lines` (oldest first) to the log store.
   */
  failRevision(reason: string, lines: string[] = []): void {
    this.failure = { reason, lines };
  }

  /**
   * The project's log store holds these entries too. The fake reads no
   * filter: every one comes back, so what the product's own filter would
   * have kept out is still the product's to drop.
   */
  writeLogEntries(...entries: LogEntry[]): void {
    this.logEntries.push(...entries);
  }

  /** A repository already holds image versions with these tags. */
  holdImageVersions(repository: string, ...tags: string[]): void {
    const held = this.versions.get(repository) ?? new Set<string>();
    for (const tag of tags) held.add(tag);
    this.versions.set(repository, held);
  }

  /**
   * Certificate Manager answers this about the certificate named `name`
   * (its full name); one not scripted is still provisioning.
   */
  certificateAnswers(name: string, certificate: GoogleCertificate): void {
    this.certificates.set(name, certificate);
  }

  /** DNS answers this for `name`; a name not scripted answers nothing. */
  dnsAnswers(name: string, answer: Partial<DnsAnswer>): void {
    this.dns.set(name.replace(/\.$/, '').toLowerCase(), {
      cnames: answer.cnames ?? [],
      addresses: answer.addresses ?? [],
    });
  }

  /**
   * The on-demand backups `product` takes from now hold `bytes` (`null`:
   * Google does not say how much).
   */
  backupsHold(
    product: 'cloud-sql' | 'memorystore',
    bytes: number | null,
  ): void {
    this.backupBytes[product] = bytes;
  }

  /**
   * Cloud SQL holds this of the instance named `name`; one not
   * scripted is not there (`NOT_FOUND`), as before its first Cloud run.
   */
  cloudSqlHolds(name: string, backups: CloudSqlBackups): void {
    this.sqlBackups.set(name, backups);
  }

  /** Memorystore holds this of the instance named `name`, as {@link cloudSqlHolds}. */
  memorystoreHolds(name: string, backups: MemorystoreBackups): void {
    this.cacheBackups.set(name, backups);
  }

  /** The names of the objects a bucket holds now, sorted. */
  objectsOf(bucket: string): string[] {
    return [...(this.buckets.get(bucket)?.keys() ?? [])].sort();
  }

  /** What one object holds: its content type and MD5, or `undefined`. */
  objectOf(
    bucket: string,
    name: string,
  ): { contentType: string; md5Hash: string } | undefined {
    const held = this.buckets.get(bucket)?.get(name);
    return held
      ? { contentType: held.contentType, md5Hash: held.md5Hash }
      : undefined;
  }

  /**
   * Every object write, copy and delete answered so far, in the order it
   * was asked: a static deploy's copy order.
   */
  objectOperations(): FakeObjectOperation[] {
    return this.calls.flatMap((call): FakeObjectOperation[] => {
      switch (call.method) {
        case 'uploadObject':
          return [{ op: 'upload', bucket: call.bucket, name: call.name }];
        case 'copyObject':
          return [
            { op: 'copy', bucket: call.bucket, from: call.from, to: call.to },
          ];
        case 'deleteObject':
          return [{ op: 'delete', bucket: call.bucket, name: call.name }];
        default:
          return [];
      }
    });
  }

  /**
   * Cloud SQL's `instances.get` answers this for the instance; one
   * not scripted answers `NOT_FOUND`. `null` takes it away again: an
   * instance that vanished.
   */
  cloudSqlInstanceAnswers(
    instance: ExistingCloudSqlRef,
    read: CloudSqlInstanceRead | null,
  ): void {
    const key = `${instance.projectId}/${instance.instance}`;
    if (read === null) this.sqlInstances.delete(key);
    else this.sqlInstances.set(key, read);
  }

  /**
   * Memorystore's `instances.get` answers this for the instance; one
   * not scripted answers `NOT_FOUND`. `null` takes it away again: an
   * instance that vanished.
   */
  memorystoreInstanceAnswers(
    instance: ExistingValkeyRef,
    read: MemorystoreInstanceRead | null,
  ): void {
    const key = `${instance.projectId}/${instance.region}/${instance.instance}`;
    if (read === null) this.cacheInstances.delete(key);
    else this.cacheInstances.set(key, read);
  }

  /**
   * Cloud Storage's `buckets.get` answers this for the bucket named `name`
   * one not scripted answers `NOT_FOUND`. `null` takes it away
   * again: a bucket that vanished.
   */
  storageBucketAnswers(name: string, read: StorageBucketRead | null): void {
    if (read === null) this.storageBuckets.delete(name);
    else this.storageBuckets.set(name, read);
  }

  /** A manual endpoint's forwarding rule reads `status`; one not scripted is `ACCEPTED`. */
  endpointStatusIs(name: string, status: PscConnectionStatus): void {
    this.endpointStatuses.set(name, status);
  }

  /**
   * Every cache clear answered so far, in the order it was asked:
   * one per Domain of a static site, by host on the network's URL map.
   */
  cacheClears(): { urlMap: string; host: string }[] {
    return this.calls.flatMap((call) =>
      call.method === 'invalidateCache'
        ? [{ urlMap: call.urlMap, host: call.host }]
        : [],
    );
  }

  /** The tags of the image versions a repository holds now. */
  imageVersions(repository: string): string[] {
    return [...(this.versions.get(repository) ?? [])].sort();
  }

  /** A plan of `kind`'s definition replays this stored plan (`null`: nothing to do). */
  replayPlanFor(kind: GoogleDefinitionKind, name: string | null): void {
    writeFileSync(
      join(this.root, `plan-${kind}.json`),
      JSON.stringify(name === null ? EMPTY_PLAN : storedGooglePlan(name)),
    );
  }

  /** A plan of `kind`'s definition replays `show`, a stored plan a spec altered. */
  replayShowFor(kind: GoogleDefinitionKind, show: TofuShow): void {
    writeFileSync(join(this.root, `plan-${kind}.json`), JSON.stringify(show));
  }

  /**
   * A plan of the one state `stateId` replays this stored plan (or `show`,
   * one a spec altered) rather than its kind's, as AWS's fake `replayPlan`.
   */
  replayPlanForState(stateId: string, plan: string | TofuShow): void {
    writeFileSync(
      join(this.root, `plan-state-${stateId}.json`),
      JSON.stringify(typeof plan === 'string' ? storedGooglePlan(plan) : plan),
    );
  }

  /**
   * An apply of `kind`'s definition answers this stored `tofu output -json`
   * (`fixtures/applies/google/<name>.json`; `null`: no outputs).
   */
  replayOutputsFor(kind: GoogleDefinitionKind, name: string | null): void {
    const outputs = name === null ? {} : storedGoogleOutputs(name);
    this.outputs.set(kind, outputs);
    writeFileSync(
      join(this.root, `outputs-${kind}.json`),
      JSON.stringify(outputs),
    );
  }

  /**
   * An apply of `kind`'s definition answers these outputs, each a string,
   * the ones named in `sensitive` marked so, as `tofu output -json` prints
   * them: for a spec whose runs answer values no stored apply holds, such
   * as a rotated key.
   */
  replayOutputValuesFor(
    kind: GoogleDefinitionKind,
    values: Record<string, string>,
    sensitive: readonly string[] = [],
  ): void {
    const outputs = Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        { sensitive: sensitive.includes(name), type: 'string', value },
      ]),
    );
    this.outputs.set(kind, outputs);
    writeFileSync(
      join(this.root, `outputs-${kind}.json`),
      JSON.stringify(outputs),
    );
  }

  /**
   * The state `stateId` holds this (a `tofu show -json` of a state): its
   * workspace is listed and `show -json` prints it, for a read of what it
   * holds.
   */
  stateHolds(stateId: string, show: TofuStateShow): void {
    writeFileSync(
      join(this.root, `state-${stateId}.json`),
      JSON.stringify(show),
    );
  }

  /**
   * Cloudgate cannot read the state `stateId` (corrupt, or the encryption
   * secret changed): `tofu show` of it fails as OpenTofu's decryption does.
   */
  stateUnreadable(stateId: string): void {
    writeFileSync(join(this.root, `unreadable-${stateId}`), '');
  }

  /** A plan of `kind`'s definition fails, `tofu` printing `error` as the provider does. */
  failRunFor(kind: GoogleDefinitionKind, error: string): void {
    writeFileSync(join(this.root, `fail-${kind}`), `Error: ${error}\n`);
  }

  /**
   * A destroy of this one state fails after it began, `tofu` printing
   * `error` as the provider does: a network's, while the Services'
   * destroys go through. `null` lets it through again. Only a destroy of the
   * whole state fails: one limited to some addresses (`-target`), such as a
   * bucket's key and account before its emptying, goes through.
   */
  failDestroyOf(stateId: string, error: string | null): void {
    if (error === null) this.failedDestroys.delete(stateId);
    else this.failedDestroys.set(stateId, error);
  }

  /**
   * The Cloud Storage bucket `bucket` holds just these objects,
   * each its name as its content; none is an empty bucket. Every bucket
   * holds nothing until this or an upload says otherwise.
   */
  holdObjects(bucket: string, ...names: string[]): void {
    this.buckets.set(
      bucket,
      new Map(
        names.map((name): [string, HeldObject] => [
          name,
          {
            md5Hash: createHash('md5').update(name).digest('base64'),
            size: name.length,
            contentType: 'application/octet-stream',
          },
        ]),
      ),
    );
  }

  /**
   * An emptying of `bucket` deletes its first `after` objects, then
   * Google refuses the next delete with `code` and `message`: an emptying
   * that stops partway. `null` lets it through again.
   */
  stopEmptyingOf(
    bucket: string,
    stop: { after: number; code: string; message: string } | null,
  ): void {
    if (stop === null) this.stoppedEmptyings.delete(bucket);
    else this.stoppedEmptyings.set(bucket, stop);
  }

  /**
   * One more object in `bucket`, holding `body`, beside what it holds
   * what a run cut off by a restart left behind it.
   */
  putObject(bucket: string, name: string, body: string): void {
    this.bucketOf(bucket).set(name, {
      md5Hash: createHash('md5').update(body).digest('base64'),
      size: body.length,
      contentType: 'application/octet-stream',
    });
  }

  /** An apply of `kind`'s definition fails after its plan, `tofu` printing `error`. */
  failApplyFor(kind: GoogleDefinitionKind, error: string): void {
    writeFileSync(join(this.root, `fail-apply-${kind}`), `Error: ${error}\n`);
  }

  /** Applies of `kind`'s definition succeed again. */
  passApplyFor(kind: GoogleDefinitionKind): void {
    rmSync(join(this.root, `fail-apply-${kind}`), { force: true });
  }

  /**
   * Each credential file a plan's `tofu` was pointed at, with its mode as
   * `tofu` found it, and whether it is still there now.
   */
  credentialFiles(): { path: string; mode: string; there: boolean }[] {
    const file = join(this.root, 'credentials');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [path, mode] = line.split(' ');
        return { path, mode, there: existsSync(path) };
      });
  }

  /** The working folders runs left behind: none, unless a run leaked one. */
  runFolders(): string[] {
    return readdirSync(join(this.root, 'work'));
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  exchangeToken(
    request: TokenExchangeRequest,
  ): Promise<GoogleAnswer<GoogleAccessToken>> {
    this.calls.push({
      method: 'exchangeToken',
      audience: request.audience,
      token: decode(request.subjectToken),
    });
    this.subjectTokens.push(request.subjectToken);
    const answered = this.answer('exchangeToken', { accessToken: FEDERATED });
    return this.held ? this.held.then(() => answered) : answered;
  }

  impersonate(
    federated: GoogleAccessToken,
    request: ImpersonateRequest,
  ): Promise<GoogleAnswer<GoogleAccessToken>> {
    this.calls.push({
      method: 'impersonate',
      serviceAccount: request.serviceAccount,
      lifetimeSeconds: request.lifetimeSeconds,
      federated: federated.accessToken === FEDERATED,
    });
    return this.answer('impersonate', { accessToken: IMPERSONATED });
  }

  getProject(
    token: GoogleAccessToken,
    projectId: string,
  ): Promise<GoogleAnswer<GoogleProject>> {
    this.calls.push({
      method: 'getProject',
      projectId,
      impersonated: token.accessToken === IMPERSONATED,
    });
    return this.answer('getProject', {
      projectId: this.project.projectId ?? projectId,
      projectNumber: this.project.projectNumber ?? FAKE_PROJECT_NUMBER,
    });
  }

  testIamPermissions(
    _token: GoogleAccessToken,
    projectId: string,
    permissions: readonly string[],
  ): Promise<GoogleAnswer<string[]>> {
    this.calls.push({
      method: 'testIamPermissions',
      projectId,
      permissions: [...permissions],
    });
    return this.answer(
      'testIamPermissions',
      permissions.filter((permission) => !this.withheld.has(permission)),
    );
  }

  enabledApis(
    _token: GoogleAccessToken,
    projectNumber: string,
  ): Promise<GoogleAnswer<string[]>> {
    this.calls.push({ method: 'enabledApis', projectNumber });
    // Every API Cloudgate could ask about, bar the ones turned off.
    return this.answer(
      'enabledApis',
      ALL_APIS.filter((api) => !this.off.has(api)),
    );
  }

  listLocations(
    token: GoogleAccessToken,
    projectId: string,
    api: GoogleLocationsApi,
  ): Promise<GoogleAnswer<string[]>> {
    this.calls.push({
      method: 'listLocations',
      projectId,
      api,
      impersonated: token.accessToken === IMPERSONATED,
    });
    const missing = this.missing.get(api) ?? new Set<string>();
    return this.answer(
      'listLocations',
      GOOGLE_REGIONS.filter((region) => !missing.has(region)),
    );
  }

  countNetworks(
    token: GoogleAccessToken,
    projectId: string,
  ): Promise<GoogleAnswer<number>> {
    this.calls.push({
      method: 'countNetworks',
      projectId,
      impersonated: token.accessToken === IMPERSONATED,
    });
    return this.answer('countNetworks', this.networks);
  }

  findByName(
    token: GoogleAccessToken,
    request: FindByNameRequest,
  ): Promise<GoogleAnswer<FoundByName[]>> {
    this.calls.push({
      method: 'findByName',
      impersonated: token.accessToken === IMPERSONATED,
      ...request,
    });
    return this.answer(
      'findByName',
      this.found.filter(
        (one) =>
          one.resourceType === request.resourceType &&
          one.name.startsWith(request.namePrefix),
      ),
    );
  }

  findByLabel(
    token: GoogleAccessToken,
    request: FindByLabelRequest,
  ): Promise<GoogleAnswer<FoundByLabel[]>> {
    this.calls.push({
      method: 'findByLabel',
      impersonated: token.accessToken === IMPERSONATED,
      ...request,
    });
    return this.answer(
      'findByLabel',
      this.labelled.filter(
        (one) => one.labels[request.label.key] === request.label.value,
      ),
    );
  }

  plan(request: TofuRunRequest<GoogleCredential>): Promise<TofuPlanOutcome> {
    this.record('plan', request);
    this.writeTargeted(request, true);
    return this.withImporting(request, () => this.runner.plan(request));
  }

  /**
   * As {@link plan}, then the apply; a network definition's apply answers,
   * beside the stored outputs, each Domain's certificate as Google would
   * name it ({@link fakeGoogleCertificateName}) with its authorization's
   * CNAME ({@link fakeAuthorizationRecord}).
   */
  apply(
    request: TofuApplyRequest<GoogleCredential>,
  ): Promise<TofuApplyOutcome> {
    this.record('apply', request);
    this.writeTargeted(request, true);
    const kind = kindOf(request.definition);
    const domains = domainsOf(request.definition);
    writeFileSync(
      join(this.root, `outputs-${kind}.json`),
      JSON.stringify({
        ...(this.outputs.get(kind) ?? {}),
        ...(domains
          ? {
              domain_certificates: {
                sensitive: false,
                value: Object.fromEntries(
                  Object.entries(domains).map(([key, one]) => [
                    key,
                    {
                      id: fakeGoogleCertificateName(
                        projectOf(request.definition),
                        one.certificate,
                      ),
                      validation: [fakeAuthorizationRecord(one.host)],
                    },
                  ]),
                ),
              },
            }
          : {}),
      }),
    );
    return this.withImporting(request, () => this.runner.apply(request));
  }

  /**
   * While `run` runs, a definition's `import` blocks mark each address they
   * name as importing its id in the plan the state replays,
   * as OpenTofu's plan of a config-driven import marks it.
   */
  private async withImporting<T>(
    request: TofuRunRequest<GoogleCredential>,
    run: () => Promise<T>,
  ): Promise<T> {
    const imports = (request.definition.import ?? []) as {
      to: string;
      id: string;
    }[];
    if (imports.length === 0) return run();
    const resources = (request.definition.resource ?? {}) as Record<
      string,
      unknown
    >;
    const kind =
      'google_sql_database_instance' in resources
        ? cloudSqlKindOf(resources)
        : kindOf(request.definition);
    const own = join(this.root, `plan-state-${request.stateId}.json`);
    const stored = JSON.parse(
      readFileSync(
        existsSync(own) ? own : join(this.root, `plan-${kind}.json`),
        'utf8',
      ),
    ) as TofuShowJson;
    const file = join(this.root, `plan-importing-${request.stateId}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        ...stored,
        resource_changes: (stored.resource_changes ?? []).map((change) => {
          const block = imports.find((one) => one.to === change.address);
          return block
            ? {
                ...change,
                change: { ...change.change, importing: { id: block.id } },
              }
            : change;
        }),
      }),
    );
    try {
      return await run();
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** What Certificate Manager says of the certificate; provisioning unless scripted. */
  certificate(
    token: GoogleAccessToken,
    certificate: GoogleCertificateRef,
  ): Promise<GoogleAnswer<GoogleCertificate>> {
    this.calls.push({
      method: 'certificate',
      impersonated: token.accessToken === IMPERSONATED,
      ...certificate,
    });
    return this.answer(
      'certificate',
      this.certificates.get(certificate.name) ?? {
        state: 'PROVISIONING',
        reason: null,
      },
    );
  }

  cloudSqlBackups(
    token: GoogleAccessToken,
    instance: GoogleDatabaseRef,
  ): Promise<GoogleAnswer<CloudSqlBackups>> {
    return this.heldBackups(
      'cloudSqlBackups',
      token,
      instance,
      this.sqlBackups,
    );
  }

  memorystoreBackups(
    token: GoogleAccessToken,
    instance: GoogleDatabaseRef,
  ): Promise<GoogleAnswer<MemorystoreBackups>> {
    return this.heldBackups(
      'memorystoreBackups',
      token,
      instance,
      this.cacheBackups,
    );
  }

  /** A backups read: a scripted refusal, what it holds, or `NOT_FOUND`. */
  private heldBackups<T>(
    method: 'cloudSqlBackups' | 'memorystoreBackups',
    token: GoogleAccessToken,
    instance: GoogleDatabaseRef,
    held: Map<string, T>,
  ): Promise<GoogleAnswer<T>> {
    this.calls.push({
      method,
      impersonated: token.accessToken === IMPERSONATED,
      ...instance,
    });
    const found = held.get(instance.name);
    if (!this.refusals.has(method) && found === undefined) {
      return Promise.resolve({
        ok: false,
        code: NOT_FOUND,
        message: `The instance ${instance.name} does not exist.`,
      });
    }
    return this.answer(method, found as T);
  }

  listObjects(
    token: GoogleAccessToken,
    request: ObjectListRequest,
  ): Promise<GoogleAnswer<StoredObject[]>> {
    this.calls.push({
      method: 'listObjects',
      impersonated: token.accessToken === IMPERSONATED,
      ...request,
    });
    const held =
      this.buckets.get(request.bucket) ?? new Map<string, HeldObject>();
    return this.answer(
      'listObjects',
      [...held.entries()]
        .filter(([name]) => name.startsWith(request.prefix ?? ''))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, request.maxResults)
        .map(([name, one]) => ({
          name,
          md5Hash: one.md5Hash,
          size: one.size,
        })),
    );
  }

  /** Reads the file as Cloud Storage would, so its MD5 is the content's. */
  uploadObject(
    token: GoogleAccessToken,
    request: ObjectUploadRequest,
  ): Promise<GoogleAnswer<StoredObject>> {
    this.calls.push({
      method: 'uploadObject',
      impersonated: token.accessToken === IMPERSONATED,
      bucket: request.bucket,
      name: request.name,
      contentType: request.contentType,
    });
    const refused = this.arrived('uploadObject');
    if (refused) return refused;
    if (this.refusals.has('uploadObject')) {
      return this.answer('uploadObject', {} as StoredObject);
    }
    const body = readFileSync(request.file);
    const held: HeldObject = {
      md5Hash: createHash('md5').update(body).digest('base64'),
      size: body.length,
      contentType: request.contentType,
    };
    this.bucketOf(request.bucket).set(request.name, held);
    this.bodies.set(`${request.bucket}/${request.name}`, body);
    return this.answer('uploadObject', {
      name: request.name,
      md5Hash: held.md5Hash,
      size: held.size,
    });
  }

  copyObject(
    token: GoogleAccessToken,
    request: ObjectCopyRequest,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'copyObject',
      impersonated: token.accessToken === IMPERSONATED,
      ...request,
    });
    const refused = this.arrived('copyObject');
    if (refused) return refused;
    if (this.refusals.has('copyObject')) return this.answer('copyObject', true);
    const bucket = this.bucketOf(request.bucket);
    const from = bucket.get(request.from);
    if (!from) {
      return Promise.resolve({
        ok: false,
        code: NOT_FOUND,
        message: `No such object: ${request.bucket}/${request.from}`,
      });
    }
    bucket.set(request.to, from);
    return this.answer('copyObject', true);
  }

  deleteObject(
    token: GoogleAccessToken,
    object: ObjectRef,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'deleteObject',
      impersonated: token.accessToken === IMPERSONATED,
      ...object,
    });
    const refused = this.arrived('deleteObject');
    if (refused) return refused;
    if (this.refusals.has('deleteObject')) {
      return this.answer('deleteObject', true);
    }
    if (!this.bucketOf(object.bucket).delete(object.name)) {
      return Promise.resolve({
        ok: false,
        code: NOT_FOUND,
        message: `No such object: ${object.bucket}/${object.name}`,
      });
    }
    return this.answer('deleteObject', true);
  }

  /** Deletes every object it holds, unless {@link stopEmptyingOf} stops it partway. */
  emptyBucket(
    token: GoogleAccessToken,
    bucket: string,
  ): Promise<GoogleAnswer<{ deleted: number }>> {
    this.calls.push({
      method: 'emptyBucket',
      impersonated: token.accessToken === IMPERSONATED,
      bucket,
    });
    if (this.refusals.has('emptyBucket')) {
      return this.answer('emptyBucket', { deleted: 0 });
    }
    const held = this.buckets.get(bucket) ?? new Map<string, HeldObject>();
    const stop = this.stoppedEmptyings.get(bucket);
    const names = [...held.keys()].sort();
    const deleting = stop ? names.slice(0, stop.after) : names;
    for (const name of deleting) held.delete(name);
    if (stop && names.length > stop.after) {
      return Promise.resolve({
        ok: false,
        code: stop.code,
        message: stop.message,
      });
    }
    return this.answer('emptyBucket', { deleted: deleting.length });
  }

  invalidateCache(
    token: GoogleAccessToken,
    request: CacheClearRequest,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'invalidateCache',
      impersonated: token.accessToken === IMPERSONATED,
      ...request,
    });
    const refused = this.arrived('invalidateCache');
    if (refused) return refused;
    return this.answer('invalidateCache', true);
  }

  private bucketOf(bucket: string): Map<string, HeldObject> {
    const held = this.buckets.get(bucket) ?? new Map<string, HeldObject>();
    this.buckets.set(bucket, held);
    return held;
  }

  /** The scripted instance, or Cloud SQL's `NOT_FOUND` for one never scripted. */
  cloudSqlInstance(
    token: GoogleAccessToken,
    instance: ExistingCloudSqlRef,
  ): Promise<GoogleAnswer<CloudSqlInstanceRead>> {
    this.calls.push({
      method: 'cloudSqlInstance',
      impersonated: token.accessToken === IMPERSONATED,
      ...instance,
    });
    const found = this.sqlInstances.get(
      `${instance.projectId}/${instance.instance}`,
    );
    if (!found && !this.refusals.has('cloudSqlInstance')) {
      return Promise.resolve({
        ok: false,
        code: NOT_FOUND,
        message: 'The Cloud SQL instance does not exist.',
      });
    }
    return this.answer('cloudSqlInstance', found as CloudSqlInstanceRead);
  }

  /** The scripted instance, or Memorystore's `NOT_FOUND` for one never scripted. */
  memorystoreInstance(
    token: GoogleAccessToken,
    instance: ExistingValkeyRef,
  ): Promise<GoogleAnswer<MemorystoreInstanceRead>> {
    this.calls.push({
      method: 'memorystoreInstance',
      impersonated: token.accessToken === IMPERSONATED,
      ...instance,
    });
    const found = this.cacheInstances.get(
      `${instance.projectId}/${instance.region}/${instance.instance}`,
    );
    if (!found && !this.refusals.has('memorystoreInstance')) {
      return Promise.resolve({
        ok: false,
        code: NOT_FOUND,
        message: 'Resource not found.',
      });
    }
    return this.answer('memorystoreInstance', found as MemorystoreInstanceRead);
  }

  pscEndpointStatus(
    token: GoogleAccessToken,
    endpoint: PscEndpointRef,
  ): Promise<GoogleAnswer<PscConnectionStatus>> {
    this.calls.push({
      method: 'pscEndpointStatus',
      impersonated: token.accessToken === IMPERSONATED,
      ...endpoint,
    });
    return this.answer<PscConnectionStatus>(
      'pscEndpointStatus',
      this.endpointStatuses.get(endpoint.name) ?? 'ACCEPTED',
    );
  }

  /** The scripted bucket, or Cloud Storage's `NOT_FOUND` for one never scripted. */
  storageBucket(
    token: GoogleAccessToken,
    bucket: string,
  ): Promise<GoogleAnswer<StorageBucketRead>> {
    this.calls.push({
      method: 'storageBucket',
      impersonated: token.accessToken === IMPERSONATED,
      bucket,
    });
    const found = this.storageBuckets.get(bucket);
    if (!found && !this.refusals.has('storageBucket')) {
      return Promise.resolve({
        ok: false,
        code: NOT_FOUND,
        message: 'The specified bucket does not exist.',
      });
    }
    return this.answer('storageBucket', found as StorageBucketRead);
  }

  dnsLookup(name: string): Promise<DnsAnswer> {
    return Promise.resolve(
      this.dns.get(name.replace(/\.$/, '').toLowerCase()) ?? {
        cnames: [],
        addresses: [],
      },
    );
  }

  /**
   * Answers a service whose newest revision is ready and takes all traffic,
   * after any scripted polls still rolling out; or, once scripted, one whose
   * newest revision failed, the older one still serving.
   */
  cloudRunService(
    token: GoogleAccessToken,
    service: CloudRunServiceRef,
  ): Promise<GoogleAnswer<CloudRunServiceStatus>> {
    this.calls.push({
      method: 'cloudRunService',
      impersonated: token.accessToken === IMPERSONATED,
      ...service,
    });
    const passing = this.arrived('cloudRunService');
    if (passing) return passing;
    const newest = `${service.name}-00002-new`;
    const older = `${service.name}-00001-old`;
    if (this.failure) {
      return this.answer('cloudRunService', {
        reconciling: false,
        latestCreatedRevision: newest,
        latestReadyRevision: older,
        terminalCondition: {
          state: 'CONDITION_FAILED',
          reason: 'CONTAINER_FAILED',
          message: this.failure.reason,
        },
        traffic: [{ revision: null, percent: 100 }],
      });
    }
    const rolling = this.pendingPolls > 0;
    if (rolling) this.pendingPolls--;
    return this.answer('cloudRunService', {
      reconciling: rolling,
      latestCreatedRevision: newest,
      latestReadyRevision: rolling ? older : newest,
      terminalCondition: {
        state: rolling ? 'CONDITION_RECONCILING' : 'CONDITION_SUCCEEDED',
        reason: null,
        message: null,
      },
      traffic: [{ revision: null, percent: 100 }],
    });
  }

  /**
   * A Worker's worker pool, as {@link cloudRunService} answers a
   * service: its newest revision ready and running every instance, after any
   * scripted polls still rolling out, or failed once scripted; at the
   * instance count last set.
   */
  cloudRunWorkerPool(
    token: GoogleAccessToken,
    pool: CloudRunWorkerPoolRef,
  ): Promise<GoogleAnswer<CloudRunWorkerPoolStatus>> {
    this.calls.push({
      method: 'cloudRunWorkerPool',
      impersonated: token.accessToken === IMPERSONATED,
      ...pool,
    });
    const newest = `${pool.name}-00002-new`;
    const older = `${pool.name}-00001-old`;
    const instanceCount = this.poolInstances.get(pool.name) ?? 1;
    const instanceSplits = [{ revision: null, percent: 100 }];
    if (this.failure) {
      return this.answer('cloudRunWorkerPool', {
        reconciling: false,
        latestCreatedRevision: newest,
        latestReadyRevision: older,
        terminalCondition: {
          state: 'CONDITION_FAILED',
          reason: 'CONTAINER_FAILED',
          message: this.failure.reason,
        },
        instanceCount,
        instanceSplits,
      });
    }
    const rolling = this.pendingPolls > 0;
    if (rolling) this.pendingPolls--;
    return this.answer('cloudRunWorkerPool', {
      reconciling: rolling,
      latestCreatedRevision: newest,
      latestReadyRevision: rolling ? older : newest,
      terminalCondition: {
        state: rolling ? 'CONDITION_RECONCILING' : 'CONDITION_SUCCEEDED',
        reason: null,
        message: null,
      },
      instanceCount,
      instanceSplits,
    });
  }

  setWorkerPoolInstances(
    token: GoogleAccessToken,
    pool: CloudRunWorkerPoolRef,
    instances: number,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'setWorkerPoolInstances',
      impersonated: token.accessToken === IMPERSONATED,
      ...pool,
      instances,
    });
    const answer = this.answer<true>('setWorkerPoolInstances', true);
    if (!this.refusals.has('setWorkerPoolInstances')) {
      this.poolInstances.set(pool.name, instances);
    }
    return answer;
  }

  setWorkerPoolRevisionLabel(
    token: GoogleAccessToken,
    pool: CloudRunWorkerPoolRef,
    label: RevisionLabel,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'setWorkerPoolRevisionLabel',
      impersonated: token.accessToken === IMPERSONATED,
      ...pool,
      label,
    });
    return this.answer('setWorkerPoolRevisionLabel', true);
  }

  liftCloudSqlDeletionProtection(
    token: GoogleAccessToken,
    instance: CloudSqlInstanceRef,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'liftCloudSqlDeletionProtection',
      impersonated: token.accessToken === IMPERSONATED,
      ...instance,
    });
    return this.answer('liftCloudSqlDeletionProtection', true);
  }

  stopRetainingCloudSqlBackups(
    token: GoogleAccessToken,
    instance: CloudSqlInstanceRef,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'stopRetainingCloudSqlBackups',
      impersonated: token.accessToken === IMPERSONATED,
      ...instance,
    });
    return this.answer('stopRetainingCloudSqlBackups', true);
  }

  /** Kept in the `us` multi-region, as the live check found. */
  takeCloudSqlBackup(
    token: GoogleAccessToken,
    instance: CloudSqlInstanceRef,
    description: string,
  ): Promise<GoogleAnswer<TakenBackup>> {
    this.calls.push({
      method: 'takeCloudSqlBackup',
      impersonated: token.accessToken === IMPERSONATED,
      ...instance,
      description,
    });
    return this.answer('takeCloudSqlBackup', {
      location: 'us',
      sizeBytes: this.backupBytes['cloud-sql'],
    });
  }

  /** Kept in the instance's region, as the live check found. */
  takeMemorystoreBackup(
    token: GoogleAccessToken,
    instance: MemorystoreInstanceRef,
    backupId: string,
  ): Promise<GoogleAnswer<TakenBackup>> {
    this.calls.push({
      method: 'takeMemorystoreBackup',
      impersonated: token.accessToken === IMPERSONATED,
      ...instance,
      backupId,
    });
    return this.answer('takeMemorystoreBackup', {
      location: instance.region,
      sizeBytes: this.backupBytes.memorystore,
    });
  }

  setCloudRunScaling(
    token: GoogleAccessToken,
    service: CloudRunServiceRef,
    scaling: CloudRunScaling,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'setCloudRunScaling',
      impersonated: token.accessToken === IMPERSONATED,
      ...service,
      scaling,
    });
    return this.answer('setCloudRunScaling', true);
  }

  setCloudRunCopies(
    token: GoogleAccessToken,
    service: CloudRunServiceRef,
    copies: CopyRange,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'setCloudRunCopies',
      impersonated: token.accessToken === IMPERSONATED,
      ...service,
      copies,
    });
    return this.answer('setCloudRunCopies', true);
  }

  setRevisionLabel(
    token: GoogleAccessToken,
    service: CloudRunServiceRef,
    label: RevisionLabel,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'setRevisionLabel',
      impersonated: token.accessToken === IMPERSONATED,
      ...service,
      label,
    });
    return this.answer('setRevisionLabel', true);
  }

  /** `TERMINATED` (Compute Engine's stopped) at once, unless a refusal is scripted. */
  async stopComputeInstance(
    token: GoogleAccessToken,
    instance: ComputeInstanceRef,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'stopComputeInstance',
      impersonated: token.accessToken === IMPERSONATED,
      ...instance,
    });
    const answered = await this.answer('stopComputeInstance', true as const);
    if (answered.ok) this.computeStatuses.set(instance.name, 'TERMINATED');
    return answered;
  }

  /** `RUNNING` at once, unless a refusal is scripted. */
  async startComputeInstance(
    token: GoogleAccessToken,
    instance: ComputeInstanceRef,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'startComputeInstance',
      impersonated: token.accessToken === IMPERSONATED,
      ...instance,
    });
    const answered = await this.answer('startComputeInstance', true as const);
    if (answered.ok) this.computeStatuses.set(instance.name, 'RUNNING');
    return answered;
  }

  /** The status the last Stop or Start left, `RUNNING` before either. */
  computeInstanceStatus(
    token: GoogleAccessToken,
    instance: ComputeInstanceRef,
  ): Promise<GoogleAnswer<ComputeInstanceStatus>> {
    this.calls.push({
      method: 'computeInstanceStatus',
      impersonated: token.accessToken === IMPERSONATED,
      ...instance,
    });
    return this.answer(
      'computeInstanceStatus',
      this.computeStatuses.get(instance.name) ?? 'RUNNING',
    );
  }

  /** A Stack VM's Compute Engine status, as something outside Cloudgate left it. */
  setComputeInstanceStatus(name: string, status: ComputeInstanceStatus): void {
    this.computeStatuses.set(name, status);
  }

  setCloudSqlActivationPolicy(
    token: GoogleAccessToken,
    instance: CloudSqlInstanceRef,
    policy: CloudSqlActivationPolicy,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'setCloudSqlActivationPolicy',
      impersonated: token.accessToken === IMPERSONATED,
      ...instance,
      policy,
    });
    return this.answer('setCloudSqlActivationPolicy', true);
  }

  /**
   * The scripted failure's lines and every written entry, newest first (or
   * oldest first when asked), at most `limit`.
   */
  listLogEntries(
    token: GoogleAccessToken,
    request: LogEntriesRequest,
  ): Promise<GoogleAnswer<LogEntry[]>> {
    this.calls.push({
      method: 'listLogEntries',
      impersonated: token.accessToken === IMPERSONATED,
      ...request,
    });
    const failed: LogEntry[] = (this.failure?.lines ?? []).map(
      (text, index) => ({
        insertId: `failed-${index}`,
        logName: `projects/${request.projectId}/logs/run.googleapis.com%2Fstderr`,
        timestamp: new Date(Date.UTC(2026, 9, 20, 10, 0, index)).toISOString(),
        revision: null,
        instance: null,
        text,
      }),
    );
    const oldestFirst = [...failed, ...this.logEntries].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
    return this.answer(
      'listLogEntries',
      (request.oldestFirst ? oldestFirst : oldestFirst.reverse()).slice(
        0,
        request.limit,
      ),
    );
  }

  /**
   * Starts one execution of the job, named as Google names one
   * (`<job>-<5 characters>`), running the image its last applied
   * definition names; a refusal scripted with {@link refuse} starts none.
   */
  runCloudRunJob(
    token: GoogleAccessToken,
    job: CloudRunJobRef,
  ): Promise<GoogleAnswer<{ execution: string }>> {
    this.calls.push({
      method: 'runCloudRunJob',
      impersonated: token.accessToken === IMPERSONATED,
      ...job,
    });
    if (this.refusals.has('runCloudRunJob')) {
      return this.answer('runCloudRunJob', { execution: '' });
    }
    const execution = `${job.name}-x${String(this.executions.length + 1).padStart(4, '0')}`;
    this.executions.push({
      projectId: job.projectId,
      region: job.region,
      job: job.name,
      execution,
      state: 'running',
      exitCode: null,
      message: null,
      image: this.jobImage(job.name),
    });
    return this.answer('runCloudRunJob', { execution });
  }

  cloudRunExecution(
    token: GoogleAccessToken,
    ref: CloudRunExecutionRef,
  ): Promise<GoogleAnswer<CloudRunExecutionStatus>> {
    this.calls.push({
      method: 'cloudRunExecution',
      impersonated: token.accessToken === IMPERSONATED,
      ...ref,
    });
    const found = this.executionOf(ref.execution);
    if (!found && !this.refusals.has('cloudRunExecution')) {
      return Promise.resolve({
        ok: false,
        code: NOT_FOUND,
        message: `Resource '${ref.execution}' of kind 'EXECUTION' in region '${ref.region}' in project '${ref.projectId}' does not exist.`,
      });
    }
    return this.answer('cloudRunExecution', {
      state: found?.state ?? 'running',
      exitCode: found?.exitCode ?? null,
      message: found?.message ?? null,
    });
  }

  /** Cancels a running execution; one that has ended is refused, as Google refuses it. */
  cancelCloudRunExecution(
    token: GoogleAccessToken,
    ref: CloudRunExecutionRef,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'cancelCloudRunExecution',
      impersonated: token.accessToken === IMPERSONATED,
      ...ref,
    });
    if (this.refusals.has('cancelCloudRunExecution')) {
      return this.answer('cancelCloudRunExecution', true);
    }
    const found = this.executionOf(ref.execution);
    if (!found) {
      return Promise.resolve({
        ok: false,
        code: NOT_FOUND,
        message: `Resource '${ref.execution}' of kind 'EXECUTION' does not exist.`,
      });
    }
    if (found.state !== 'running') {
      return Promise.resolve({
        ok: false,
        code: 'FAILED_PRECONDITION',
        message: `Execution ${ref.execution} has already completed.`,
      });
    }
    found.state = 'cancelled';
    found.message = 'The execution was cancelled.';
    return this.answer('cancelCloudRunExecution', true);
  }

  /** What the execution printed, oldest first, from the place on, as the adapter reads it. */
  executionLogEntries(
    token: GoogleAccessToken,
    request: ExecutionLogRequest,
  ): Promise<GoogleAnswer<LogEntry[]>> {
    this.calls.push({
      method: 'executionLogEntries',
      impersonated: token.accessToken === IMPERSONATED,
      ...request,
    });
    const from = request.from;
    const held = new Set(from?.insertIds ?? []);
    const entries = this.executionLogs
      .filter((one) => one.execution === request.execution)
      .filter((one) => {
        if (!one.hiddenFor) return true;
        one.hiddenFor -= 1;
        return false;
      })
      .map((one) => one.entry)
      .filter(
        (entry) =>
          !from ||
          entry.timestamp > from.timestamp ||
          (entry.timestamp === from.timestamp && !held.has(entry.insertId)),
      )
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(0, request.limit);
    return this.answer('executionLogEntries', entries);
  }

  /**
   * An execution prints `lines` to Cloud Logging, each its own
   * entry a moment after the last, or all at `at` when given.
   */
  printExecution(execution: string, lines: string[], at?: string): void {
    for (const text of lines) {
      this.logClock += 1;
      const timestamp =
        at ??
        new Date(Date.UTC(2026, 9, 27, 3, 0, 0, this.logClock)).toISOString();
      this.executionLogs.push({
        execution,
        entry: {
          insertId: `entry-${this.logClock}`,
          logName: 'projects/example/logs/run.googleapis.com%2Fstdout',
          timestamp,
          revision: null,
          instance: null,
          text,
        },
      });
    }
  }

  /**
   * An execution prints `lines` as {@link printExecution} does, but Cloud
   * Logging shows them only once `reads` reads of its log have missed them
   * the last lines of a run, received in its final second, that
   * the read just after its end does not see yet.
   */
  printExecutionLate(execution: string, lines: string[], reads: number): void {
    const from = this.executionLogs.length;
    this.printExecution(execution, lines);
    for (const one of this.executionLogs.slice(from)) one.hiddenFor = reads;
  }

  /** An execution's container exits with `exitCode`: 0 succeeds, any other fails. */
  endExecution(execution: string, exitCode: number): void {
    const found = this.mustFind(execution);
    found.state = exitCode === 0 ? 'succeeded' : 'failed';
    found.exitCode = exitCode;
    found.message =
      exitCode === 0
        ? null
        : `Task ${execution}-task0 failed with exit code ${exitCode}.`;
  }

  /** An execution fails with no exit code, its container never run, in Google's `message`. */
  failExecutionUnstarted(execution: string, message: string): void {
    const found = this.mustFind(execution);
    found.state = 'failed';
    found.exitCode = null;
    found.message = message;
  }

  /** Google no longer has the execution: it was deleted, or aged out. */
  forgetExecution(execution: string): void {
    const at = this.executions.findIndex((one) => one.execution === execution);
    if (at >= 0) this.executions.splice(at, 1);
  }

  private executionOf(execution: string): FakeExecution | undefined {
    return this.executions.find((one) => one.execution === execution);
  }

  private mustFind(execution: string): FakeExecution {
    const found = this.executionOf(execution);
    if (!found) throw new Error(`No execution ${execution}`);
    return found;
  }

  /** The image the last applied definition of `job` runs, or `null`. */
  private jobImage(job: string): string | null {
    for (const input of [...this.tofuInputs].reverse()) {
      if (input.method !== 'apply') continue;
      const resources = (
        JSON.parse(input.definition) as {
          resource?: {
            google_cloud_run_v2_job?: Record<
              string,
              {
                name?: string;
                template?: {
                  template?: { containers?: { image?: string }[] };
                };
              }
            >;
          };
        }
      ).resource?.google_cloud_run_v2_job;
      const found = Object.values(resources ?? {}).find(
        (one) => one.name === job,
      );
      if (found) {
        return found.template?.template?.containers?.[0]?.image ?? null;
      }
    }
    return null;
  }

  /**
   * Keeps only the version tagged `keepTag`. The deploy's own push goes
   * through `docker`, not this port, so the kept tag counts as held.
   */
  deleteImageVersionsExcept(
    token: GoogleAccessToken,
    request: ImageVersionsRequest,
  ): Promise<GoogleAnswer<{ deleted: number }>> {
    this.calls.push({
      method: 'deleteImageVersionsExcept',
      impersonated: token.accessToken === IMPERSONATED,
      ...request,
    });
    const held = this.versions.get(request.repository) ?? new Set<string>();
    const deleted = [...held].filter((tag) => tag !== request.keepTag).length;
    this.versions.set(request.repository, new Set([request.keepTag]));
    return this.answer('deleteImageVersionsExcept', { deleted });
  }

  destroy(
    request: TofuApplyRequest<GoogleCredential>,
  ): Promise<TofuApplyOutcome> {
    this.record('destroy', request);
    this.writeTargeted(request);
    const error = request.targets
      ? undefined
      : this.failedDestroys.get(request.stateId);
    if (error !== undefined) {
      // As `tofu` fails one: after its apply began.
      if (request.beforeApply) {
        const refused = request.beforeApply({ resource_changes: [] });
        if (refused) return Promise.resolve(refused);
      }
      return Promise.resolve({
        ok: false,
        reason: 'failed',
        message: `Error: ${error}`,
        failedAt: 'apply',
      });
    }
    return this.runner.destroy(request);
  }

  /**
   * What the state holds, through the real shared runner and the adapter's
   * own projection: the state a spec scripted with {@link stateHolds}, else
   * nothing; or OpenTofu's failure to decrypt it ({@link stateUnreadable}).
   */
  stateResources(
    request: TofuStateReadRequest<GoogleCredential>,
  ): Promise<TofuStateOutcome<GoogleStateResource>> {
    this.calls.push({
      method: 'stateResources',
      stateId: request.stateId,
      region: request.region,
    });
    return this.runner.stateResources(request, (show) =>
      googleStateResources(show, request.region),
    );
  }

  /** The secrets Secret Manager holds now, by `<project>/<id>`. */
  get secrets(): ReadonlyMap<
    string,
    { value: string; reader: string; versionName: string }
  > {
    return this.buildSecrets;
  }

  putBuildSecret(
    token: GoogleAccessToken,
    request: BuildSecretPut,
  ): Promise<GoogleAnswer<{ versionName: string }>> {
    const { value, ...named } = request;
    this.calls.push({
      method: 'putBuildSecret',
      impersonated: token.accessToken === IMPERSONATED,
      ...named,
    });
    const key = `${request.projectId}/${request.secretId}`;
    if (this.buildSecrets.has(key)) {
      return Promise.resolve({
        ok: false,
        code: 'ALREADY_EXISTS',
        message: `Secret [projects/${request.projectId}/secrets/${request.secretId}] already exists.`,
      });
    }
    // Google names a version by the project's number; the fake's is fixed.
    const versionName = `projects/123456789/secrets/${request.secretId}/versions/1`;
    this.buildSecrets.set(key, {
      value,
      reader: request.readerEmail,
      versionName,
    });
    return this.answer('putBuildSecret', { versionName });
  }

  deleteSecret(
    token: GoogleAccessToken,
    secret: SecretRef,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'deleteSecret',
      impersonated: token.accessToken === IMPERSONATED,
      ...secret,
    });
    this.buildSecrets.delete(`${secret.projectId}/${secret.secretId}`);
    return this.answer('deleteSecret', true as const);
  }

  /** How the next Cloud Build build goes; scripts queue in order. */
  scriptCloudBuild(script: FakeCloudBuildScript): void {
    this.buildScripts.push(script);
  }

  /** Every build Cloud Build started, in order. */
  get builds(): FakeCloudBuild[] {
    return [...this.cloudBuilds.values()];
  }

  /** A held build ends, by default succeeding. */
  endCloudBuild(
    buildId: string,
    status: 'SUCCESS' | 'FAILURE' = 'SUCCESS',
  ): void {
    const build = this.cloudBuilds.get(buildId);
    if (!build) throw new Error(`No build ${buildId}`);
    build.ended ??= status;
  }

  startCloudBuild(
    token: GoogleAccessToken,
    request: CloudBuildStartRequest,
  ): Promise<GoogleAnswer<{ buildId: string }>> {
    this.calls.push({
      method: 'startCloudBuild',
      impersonated: token.accessToken === IMPERSONATED,
      ...request,
    });
    const script = this.buildScripts.shift() ?? {};
    if (script.refusal) {
      return Promise.resolve({ ok: false, ...script.refusal });
    }
    if (this.refusals.has('startCloudBuild')) {
      return this.answer('startCloudBuild', { buildId: '' });
    }
    const buildId = `0000aaaa-bbbb-4ccc-8ddd-${String(
      this.cloudBuilds.size + 1,
    ).padStart(12, '0')}`;
    this.cloudBuilds.set(buildId, {
      buildId,
      request,
      script,
      startedAt: Date.now(),
      written: 0,
      missed: 0,
      ended: null,
      cancelAsked: false,
    });
    return this.answer('startCloudBuild', { buildId });
  }

  /**
   * Where the build is: queued for its `queuedMs`, then working, writing
   * one of its lines per read, then ended once every line is written
   * (unless held).
   */
  cloudBuild(
    token: GoogleAccessToken,
    ref: CloudBuildRef,
  ): Promise<GoogleAnswer<CloudBuildState>> {
    this.calls.push({
      method: 'cloudBuild',
      impersonated: token.accessToken === IMPERSONATED,
      ...ref,
    });
    const build = this.cloudBuilds.get(ref.buildId);
    if (!build) {
      return Promise.resolve({
        ok: false,
        code: NOT_FOUND,
        message: `Build ${ref.buildId} not found`,
      });
    }
    const { script } = build;
    const lines = script.lines ?? [];
    const queued =
      build.ended === null &&
      Date.now() - build.startedAt < (script.queuedMs ?? 0);
    if (!queued && build.ended === null) {
      if (build.written < lines.length) build.written += 1;
      else if (!script.held) build.ended = script.status ?? 'SUCCESS';
    }
    const ended = build.ended;
    return this.answer('cloudBuild', {
      phase: ended ? 'ended' : queued ? 'queued' : 'running',
      status: ended ?? (queued ? 'QUEUED' : 'WORKING'),
      reason:
        ended && ended !== 'SUCCESS' && ended !== 'CANCELLED'
          ? (script.reason ?? null)
          : null,
      stepOutputs: ended === 'SUCCESS' ? [script.image ?? 'amd64 null'] : [],
    });
  }

  /** Cancels a build; one already ended stays as it ended. */
  cancelCloudBuild(
    token: GoogleAccessToken,
    ref: CloudBuildRef,
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({
      method: 'cancelCloudBuild',
      impersonated: token.accessToken === IMPERSONATED,
      ...ref,
    });
    const build = this.cloudBuilds.get(ref.buildId);
    if (build) {
      build.cancelAsked = true;
      build.ended ??= 'CANCELLED';
    }
    return this.answer('cancelCloudBuild', true);
  }

  /** The lines the build has written, oldest first, from the place on, as the adapter reads them. */
  cloudBuildLogEntries(
    token: GoogleAccessToken,
    request: CloudBuildLogRequest,
  ): Promise<GoogleAnswer<LogEntry[]>> {
    this.calls.push({
      method: 'cloudBuildLogEntries',
      impersonated: token.accessToken === IMPERSONATED,
      ...request,
    });
    const build = this.cloudBuilds.get(request.buildId);
    if (!build) return this.answer('cloudBuildLogEntries', []);
    const texts = (build.script.lines ?? []).slice(0, build.written);
    const late = build.script.lateLines;
    if (late && build.ended) {
      if (build.missed >= late.reads) texts.push(...late.lines);
      else build.missed += 1;
    }
    const entries: LogEntry[] = texts.map((text, index) => ({
      insertId: `${build.buildId}-${index}`,
      logName: `projects/${request.projectId}/logs/cloudbuild`,
      timestamp: new Date(
        Date.UTC(2026, 10, 4, 12, 0, 0, index + 1),
      ).toISOString(),
      revision: null,
      instance: null,
      text,
    }));
    const from = request.from;
    const held = new Set(from?.insertIds ?? []);
    return this.answer(
      'cloudBuildLogEntries',
      entries
        .filter(
          (entry) =>
            !from ||
            entry.timestamp > from.timestamp ||
            (entry.timestamp === from.timestamp && !held.has(entry.insertId)),
        )
        .slice(0, request.limit),
    );
  }

  credentialConfiguration(
    request: CredentialConfigurationRequest,
  ): GoogleCredential {
    return {
      credentialConfiguration: JSON.stringify({
        type: 'fake_external_account',
        audience: request.audience,
        serviceAccount: request.serviceAccount,
        subject_token: request.subjectToken,
      }),
    };
  }

  /** A `tofu` run, as {@link FakeGoogleCall} keeps it: never a token or a value. */
  private record(
    method: 'plan' | 'apply' | 'destroy',
    request: TofuRunRequest<GoogleCredential>,
  ): void {
    const { subject_token: token, ...credential } = JSON.parse(
      request.credential.credentialConfiguration,
    ) as Record<string, unknown>;
    const domains = domainsOf(request.definition);
    this.calls.push({
      method,
      stateId: request.stateId,
      kind: kindOf(request.definition),
      variables: Object.keys(request.variables ?? {}).sort(),
      ...(request.targets ? { targets: [...request.targets] } : {}),
      ...(domains ? { domains } : {}),
      credential,
      proof: decode(String(token)),
    });
    this.tofuInputs.push({
      method,
      stateId: request.stateId,
      definition: JSON.stringify(request.definition, null, 2),
      variables: { ...request.variables },
    });
  }

  /**
   * A run limited to some addresses (`-target`) replays only their changes
   * from the stored plan, as `tofu` would plan them. A plan or apply's also
   * keeps only what its definition allows, as `tofu` would: a create of a
   * resource it holds, a delete of one it does not, so one stored
   * plan can script a key run's destroy of a slot and its create after.
   */
  private writeTargeted(
    request: TofuRunRequest<GoogleCredential>,
    asDefined = false,
  ): void {
    if (!request.targets) return;
    const kind = kindOf(request.definition);
    const stored = JSON.parse(
      readFileSync(join(this.root, `plan-${kind}.json`), 'utf8'),
    ) as TofuShowJson;
    const targets = request.targets;
    const resources = (request.definition.resource ?? {}) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    const allowed = (
      change: NonNullable<TofuShowJson['resource_changes']>[number],
    ) => {
      if (!asDefined) return true;
      const held = resources[change.type]?.[change.name] !== undefined;
      const [action, ...more] = change.change.actions;
      if (more.length > 0) return true;
      if (action === 'create') return held;
      if (action === 'delete') return !held;
      return true;
    };
    writeFileSync(
      join(this.root, `plan-${kind}-targeted.json`),
      JSON.stringify({
        ...stored,
        resource_changes: (stored.resource_changes ?? []).filter(
          (change) =>
            targets.some(
              (target) =>
                change.address === target ||
                change.address.startsWith(`${target}[`),
            ) && allowed(change),
        ),
      }),
    );
  }

  /** The shared runner, with the stand-in `tofu` and a provider mirror holding the pinned Google provider. */
  private makeRunner(): TofuRunner {
    const mirror = join(this.root, 'providers');
    for (const provider of ['google'] as PinnedProvider[]) {
      const folder = providerDirectory(mirror, provider);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(
          folder,
          `terraform-provider-${provider}_v${PINNED_PROVIDERS[provider]}_x5`,
        ),
        '',
      );
    }
    mkdirSync(join(this.root, 'work'));
    // The runner hands `tofu` a clean environment: the script's own
    // settings go in through a one-line wrapper.
    const binary = join(this.root, 'tofu');
    writeFileSync(
      binary,
      `#!/bin/sh\nFAKE_TOFU_DIR='${this.root}' FAKE_TOFU_VERSION='${OPENTOFU_VERSION}' exec '${REPLAY_TOFU}' "$@"\n`,
    );
    chmodSync(binary, 0o755);
    return new TofuRunner({
      binary,
      providerMirror: mirror,
      stateDatabaseUrl: 'postgresql://unused@127.0.0.1/unused',
      appEncryptionSecret: 'fake-google-tofu-encryption-secret',
      pinsDirectory: PINS,
      workRoot: join(this.root, 'work'),
    });
  }

  /**
   * An object call as it arrives: the spec's hook, then, when this one is
   * among those {@link refuseSome} refuses or {@link failSome} fails, its
   * answer.
   */
  private arrived(method: ObjectMethod): Promise<GoogleAnswer<never>> | null {
    this.onArrival.get(method)?.();
    const some = this.someRefused.get(method);
    if (!some) return null;
    if (some.after > 0) {
      some.after -= 1;
      return null;
    }
    if (some.times <= 0) return null;
    some.times -= 1;
    return some.throws
      ? Promise.reject(new Error(some.message))
      : Promise.resolve({ ok: false, code: some.code, message: some.message });
  }

  /** The snapshots a Stack VM's snapshot schedule took, by its disk's name. */
  readonly scheduledSnapshots = new Map<string, string[]>();
  /** Every disk snapshot Google keeps, by name: a Delete's final one included. */
  readonly diskSnapshots = new Map<string, number>();

  takeDiskSnapshot(
    _token: GoogleAccessToken,
    request: DiskSnapshotRequest,
  ): Promise<GoogleAnswer<TakenDiskSnapshot>> {
    this.calls.push({ method: 'takeDiskSnapshot', ...request });
    if (!this.refusals.get('takeDiskSnapshot')) {
      this.diskSnapshots.set(request.name, 20);
    }
    return this.answer('takeDiskSnapshot', { name: request.name, sizeGb: 20 });
  }

  scheduledDiskSnapshots(
    _token: GoogleAccessToken,
    disk: DiskRef,
  ): Promise<GoogleAnswer<string[]>> {
    this.calls.push({ method: 'scheduledDiskSnapshots', ...disk });
    return this.answer('scheduledDiskSnapshots', [
      ...(this.scheduledSnapshots.get(disk.disk) ?? []),
    ]);
  }

  deleteDiskSnapshot(
    _token: GoogleAccessToken,
    snapshot: { readonly projectId: string; readonly name: string },
  ): Promise<GoogleAnswer<true>> {
    this.calls.push({ method: 'deleteDiskSnapshot', ...snapshot });
    for (const [disk, names] of this.scheduledSnapshots) {
      this.scheduledSnapshots.set(
        disk,
        names.filter((one) => one !== snapshot.name),
      );
    }
    this.diskSnapshots.delete(snapshot.name);
    return this.answer('deleteDiskSnapshot', true as const);
  }

  private answer<T>(method: Method, value: T): Promise<GoogleAnswer<T>> {
    const refusal = this.refusals.get(method);
    return Promise.resolve(
      refusal ? { ok: false, ...refusal } : { ok: true, value },
    );
  }
}

/** What an on-demand backup holds unless a spec says otherwise: 2 GiB of Postgres, 1 GiB of Valkey. */
const DEFAULT_BACKUP_BYTES: Readonly<
  Record<'cloud-sql' | 'memorystore', number | null>
> = { 'cloud-sql': 2 * 1024 ** 3, memorystore: 1024 ** 3 };

/** The APIs the fake project has, on unless turned off. */
const ALL_APIS = [
  'run.googleapis.com',
  'artifactregistry.googleapis.com',
  'compute.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'sts.googleapis.com',
  'cloudresourcemanager.googleapis.com',
  'serviceusage.googleapis.com',
  'logging.googleapis.com',
  'certificatemanager.googleapis.com',
  'secretmanager.googleapis.com',
  'storage.googleapis.com',
  // Role version 2's, for the databases' private link.
  'sqladmin.googleapis.com',
  'servicenetworking.googleapis.com',
  'networkconnectivity.googleapis.com',
  'dns.googleapis.com',
  'memorystore.googleapis.com',
  'serviceconsumermanagement.googleapis.com',
  // Role version 6's, for a hosted cloud build.
  'cloudbuild.googleapis.com',
  // Role versions 7 and 8's, for a Stack VM's IAP tunnel.
  'iap.googleapis.com',
];

/** The name the fake's Certificate Manager gives a certificate. */
export function fakeGoogleCertificateName(
  projectId: string,
  name: string,
): string {
  return `projects/${projectId}/locations/global/certificates/${name}`;
}

/** The CNAME the fake's DNS authorization asks for, for `host`. */
export function fakeAuthorizationRecord(host: string): {
  name: string;
  type: string;
  value: string;
} {
  return {
    name: `_acme-challenge.${host}.`,
    type: 'CNAME',
    value: `${host.replace(/[^a-z0-9]/gi, '')}.1.authorize.certificatemanager.goog.`,
  };
}

/** A Cloud SQL definition's kind: a mysql's by its MySQL version. */
function cloudSqlKindOf(
  resources: Record<string, unknown>,
): 'postgres' | 'mysql' {
  const instances = resources.google_sql_database_instance as Record<
    string,
    { database_version?: string }
  >;
  return Object.values(instances).some((one) =>
    one.database_version?.startsWith('MYSQL_'),
  )
    ? 'mysql'
    : 'postgres';
}

/** Which Google definition this is, as the stand-in `tofu` tells them apart. */
function kindOf(definition: Record<string, unknown>): GoogleDefinitionKind {
  const resources = definition.resource as Record<string, unknown> | undefined;
  return !resources
    ? 'destroy'
    : 'google_compute_network' in resources
      ? 'network'
      : 'google_sql_database_instance' in resources
        ? cloudSqlKindOf(resources)
        : 'google_memorystore_instance' in resources
          ? 'redis'
          : 'google_compute_backend_bucket' in resources
            ? 'static'
            : 'google_storage_bucket' in resources
              ? 'bucket'
              : 'google_dns_managed_zone' in resources
                ? 'existing-postgres'
                : 'google_compute_forwarding_rule' in resources
                  ? 'existing-redis'
                  : 'google_storage_hmac_key' in resources
                    ? 'existing-bucket'
                    : 'google_cloud_run_v2_worker_pool' in resources
                      ? 'worker'
                      : 'google_cloud_run_v2_job' in resources
                        ? 'cron'
                        : JSON.stringify(resources).includes(
                              '"INGRESS_TRAFFIC_INTERNAL_ONLY"',
                            )
                          ? 'web-private'
                          : 'web';
}

/** The project a definition's provider acts in. */
function projectOf(definition: Record<string, unknown>): string {
  const provider = (definition.provider ?? {}) as {
    google?: { project?: string };
  };
  return provider.google?.project ?? 'unknown-project';
}

/** A network definition's Domains, by id, if it holds the blocks. */
function domainsOf(
  definition: Record<string, unknown>,
): Record<string, { host: string; certificate: string }> | null {
  const resources = (definition.resource ?? {}) as Record<
    string,
    Record<
      string,
      { for_each?: Record<string, { host: string; name: string }> } | undefined
    >
  >;
  const block =
    resources.google_certificate_manager_certificate?.domain?.for_each;
  if (!block) return null;
  return Object.fromEntries(
    Object.entries(block)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, one]) => [key, { host: one.host, certificate: one.name }]),
  );
}

function decode(token: string): DecodedToken {
  const [header, claims] = token.split('.');
  const part = (text: string) =>
    JSON.parse(Buffer.from(text, 'base64url').toString()) as Record<
      string,
      unknown
    >;
  return { header: part(header), claims: part(claims) };
}
