import { promises as dns } from 'node:dns';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../common/config/env.schema';
import type {
  DnsAnswer,
  GoogleCredential,
  GoogleStateResource,
  TofuApplyOutcome,
  TofuApplyRequest,
  TofuPlanOutcome,
  TofuRunRequest,
  TofuStateOutcome,
  TofuStateReadRequest,
} from '../cloud.port';
import type {
  CacheClearRequest,
  CloudBuildLogRequest,
  CloudBuildRef,
  BuildSecretPut,
  CloudBuildStartRequest,
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
  GoogleDatabaseBackup,
  GoogleDatabaseRef,
  GoogleLocationsApi,
  GoogleProject,
  ImageVersionsRequest,
  ImpersonateRequest,
  ExecutionLogRequest,
  LogEntriesRequest,
  LogEntry,
  MemorystoreBackups,
  MemorystoreInstanceRead,
  MemorystoreInstanceRef,
  ObjectCopyRequest,
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
} from '../google-cloud.port';
import {
  NOT_FOUND,
  PERMISSION_DENIED,
  PSC_CONNECTION_STATUSES,
} from '../google-cloud.port';
import { GOOGLE_CREDENTIAL_FILE, TofuRunner } from '../tofu/tofu-runner';
import { cloudBuildLogFilter } from './cloud-build-log';
import { afterPlace, executionLogFilter } from './execution-log';
import { googleStateResources } from './state-resources';
import { stackVmZone } from './definitions/stack-vm-definition';

/** A Memorystore read of a product other than Valkey: named only to be refused. */
const EMPTY_MEMORYSTORE_READ: Omit<MemorystoreInstanceRead, 'product'> = {
  engineVersion: '',
  mode: null,
  authorizationMode: null,
  transitEncryptionMode: null,
  maintenanceVersion: null,
  labels: {},
  serviceAttachments: [],
  registeredForwardingRules: [],
  ca: null,
};

/** Google's endpoints, each named once, here. */
const STS_TOKEN_URL = 'https://sts.googleapis.com/v1/token';
const IAM_CREDENTIALS_URL = 'https://iamcredentials.googleapis.com/v1';
const RESOURCE_MANAGER_URL = 'https://cloudresourcemanager.googleapis.com/v1';
const SERVICE_USAGE_URL = 'https://serviceusage.googleapis.com/v1';
const COMPUTE_URL = 'https://compute.googleapis.com/compute/v1';
const ARTIFACT_REGISTRY_URL = 'https://artifactregistry.googleapis.com/v1';
const IAM_URL = 'https://iam.googleapis.com/v1';
const CLOUD_RUN_URL = 'https://run.googleapis.com/v2';
const SECRET_MANAGER_URL = 'https://secretmanager.googleapis.com/v1';
const CERTIFICATE_MANAGER_URL = 'https://certificatemanager.googleapis.com/v1';
const LOGGING_URL = 'https://logging.googleapis.com/v2';
const SQL_ADMIN_URL = 'https://sqladmin.googleapis.com/v1';
const NETWORK_CONNECTIVITY_URL =
  'https://networkconnectivity.googleapis.com/v1';
const MEMORYSTORE_URL = 'https://memorystore.googleapis.com/v1';
/** Memorystore for Redis and Redis Cluster: only asked to name one to refuse. */
const REDIS_URL = 'https://redis.googleapis.com/v1';
const STORAGE_URL = 'https://storage.googleapis.com/storage/v1';
const STORAGE_UPLOAD_URL = 'https://storage.googleapis.com/upload/storage/v1';
const DNS_URL = 'https://dns.googleapis.com/dns/v1';
const CLOUD_BUILD_URL = 'https://cloudbuild.googleapis.com/v1';
/** What the build identity holds on a build's own secret. */
const SECRET_ACCESSOR_ROLE = 'roles/secretmanager.secretAccessor';
/** The media types of a multi-platform image's index in Artifact Registry. */
const INDEX_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
/** Each API whose locations the region check lists, at its own endpoint. */
const LOCATIONS_URL: { readonly [api in GoogleLocationsApi]: string } = {
  'run.googleapis.com': 'https://run.googleapis.com/v1',
  'artifactregistry.googleapis.com':
    'https://artifactregistry.googleapis.com/v1',
};

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';

/** The field of the credential file that holds a run's token. */
const SUBJECT_TOKEN_FIELD = 'subject_token';

/** How long one call may take before it counts as never answered. */
const CALL_TIMEOUT_MS = 30_000;

/** How long one object's upload or copy may take: a static site's large file. */
const OBJECT_TIMEOUT_MS = 5 * 60_000;

/** `testIamPermissions` takes at most 100 permissions a call. */
const PERMISSIONS_PER_CALL = 100;

/**
 * The Google client port's adapter: **the only file in `src` that calls
 * Google Cloud's APIs** (`test/coding-standards/cloud-port.spec.ts`). It
 * speaks their REST APIs over `fetch` — the few calls the connect and region
 * checks need do not earn an SDK — and holds no client or token between calls,
 * for the AWS adapter's reason: each token belongs to one Cloud account.
 *
 * Google's refusal comes back as an answer with its status and words; a
 * request that got no response at all (no network, a timeout) throws.
 */
@Injectable()
export class GoogleCloudAdapter
  implements GoogleCloudPort, BeforeApplicationShutdown
{
  /** The shared runner (the Google Cloud spec, ADR-0030), for this cloud's `tofu` runs. */
  private readonly tofu: TofuRunner;

  constructor(config: ConfigService<Env, true>) {
    this.tofu = new TofuRunner({
      binary: config.get('OPENTOFU_BINARY', { infer: true }),
      providerMirror: config.get('OPENTOFU_PROVIDER_MIRROR', { infer: true }),
      stateDatabaseUrl: config.get('INFRASTRUCTURE_STATE_DATABASE_URL', {
        infer: true,
      }),
      appEncryptionSecret: config.get('APP_ENCRYPTION_SECRET', {
        infer: true,
      }),
      // The service runs from `backend/` (deploy/systemd), beside `deploy/`.
      pinsDirectory: resolve(process.cwd(), '..', 'deploy', 'opentofu'),
    });
  }

  /**
   * `tofu` and its provider run in the run's own folder, so the credential
   * configuration's `credential_source`, a path relative to that folder,
   * names the file the runner wrote there (S16).
   */
  plan(request: TofuRunRequest<GoogleCredential>): Promise<TofuPlanOutcome> {
    return this.tofu.plan(request);
  }

  /** As {@link plan}, then the apply and the outputs, in the same folder. */
  apply(
    request: TofuApplyRequest<GoogleCredential>,
  ): Promise<TofuApplyOutcome> {
    return this.tofu.apply(request);
  }

  async cloudRunService(
    token: GoogleAccessToken,
    service: CloudRunServiceRef,
  ): Promise<GoogleAnswer<CloudRunServiceStatus>> {
    const answer = await call<{
      reconciling?: boolean;
      latestCreatedRevision?: string;
      latestReadyRevision?: string;
      terminalCondition?: { state?: string; reason?: string; message?: string };
      trafficStatuses?: { revision?: string; percent?: number }[];
    }>(cloudRunServiceUrl(service), { method: 'GET', headers: bearer(token) });
    if (!answer.ok) return answer;
    const found = answer.value ?? {};
    const revision = (name: string | undefined) =>
      name ? (name.split('/').pop() ?? name) : null;
    const condition = found.terminalCondition;
    return {
      ok: true,
      value: {
        reconciling: found.reconciling ?? false,
        latestCreatedRevision: revision(found.latestCreatedRevision),
        latestReadyRevision: revision(found.latestReadyRevision),
        terminalCondition: condition
          ? {
              state: condition.state ?? 'STATE_UNSPECIFIED',
              reason: condition.reason ?? null,
              message: condition.message ?? null,
            }
          : null,
        traffic: (found.trafficStatuses ?? []).map((one) => ({
          revision: revision(one.revision),
          percent: one.percent ?? 0,
        })),
      },
    };
  }

  /**
   * Stop is the service switched off without being deleted: manual scaling
   * at no copies, which Google's own example sends at the `BETA` launch
   * stage (accepted). Start is automatic scaling again, its
   * revisions in the copy range; the launch stage is left where it is.
   */
  setCloudRunScaling(
    token: GoogleAccessToken,
    service: CloudRunServiceRef,
    scaling: CloudRunScaling,
  ): Promise<GoogleAnswer<true>> {
    return this.patchService(token, service, (found) => {
      const own = { ...found.scaling };
      if (scaling.mode === 'stopped') {
        if (!found.launchStage || found.launchStage === 'GA') {
          found.launchStage = 'BETA';
        }
        found.scaling = {
          ...own,
          scalingMode: 'MANUAL',
          manualInstanceCount: 0,
        };
        return;
      }
      delete own.manualInstanceCount;
      found.scaling = { ...own, scalingMode: 'AUTOMATIC' };
      found.template = withCopies(found.template, scaling.copies);
    });
  }

  setCloudRunCopies(
    token: GoogleAccessToken,
    service: CloudRunServiceRef,
    copies: CopyRange,
  ): Promise<GoogleAnswer<true>> {
    return this.patchService(token, service, (found) => {
      found.template = withCopies(found.template, copies);
    });
  }

  setRevisionLabel(
    token: GoogleAccessToken,
    service: CloudRunServiceRef,
    label: RevisionLabel,
  ): Promise<GoogleAnswer<true>> {
    return this.patchService(token, service, (found) => {
      const template = { ...found.template };
      template.labels = {
        ...(template.labels as Record<string, string> | undefined),
        [label.key]: label.value,
      };
      found.template = template;
    });
  }

  async cloudRunWorkerPool(
    token: GoogleAccessToken,
    pool: CloudRunWorkerPoolRef,
  ): Promise<GoogleAnswer<CloudRunWorkerPoolStatus>> {
    const answer = await call<{
      reconciling?: boolean;
      latestCreatedRevision?: string;
      latestReadyRevision?: string;
      terminalCondition?: { state?: string; reason?: string; message?: string };
      scaling?: { manualInstanceCount?: number };
      instanceSplitStatuses?: { revision?: string; percent?: number }[];
    }>(workerPoolUrl(pool), { method: 'GET', headers: bearer(token) });
    if (!answer.ok) return answer;
    const found = answer.value ?? {};
    const revision = (name: string | undefined) =>
      name ? (name.split('/').pop() ?? name) : null;
    const condition = found.terminalCondition;
    return {
      ok: true,
      value: {
        reconciling: found.reconciling ?? false,
        latestCreatedRevision: revision(found.latestCreatedRevision),
        latestReadyRevision: revision(found.latestReadyRevision),
        terminalCondition: condition
          ? {
              state: condition.state ?? 'STATE_UNSPECIFIED',
              reason: condition.reason ?? null,
              message: condition.message ?? null,
            }
          : null,
        // Google leaves a zero count out of its answer.
        instanceCount: found.scaling
          ? (found.scaling.manualInstanceCount ?? 0)
          : null,
        instanceSplits: (found.instanceSplitStatuses ?? []).map((one) => ({
          revision: revision(one.revision),
          percent: one.percent ?? 0,
        })),
      },
    };
  }

  /** The manual instance count alone, the rest of the worker pool kept. */
  setWorkerPoolInstances(
    token: GoogleAccessToken,
    pool: CloudRunWorkerPoolRef,
    instances: number,
  ): Promise<GoogleAnswer<true>> {
    return this.patchWhole(token, workerPoolUrl(pool), (found) => {
      found.scaling = { ...found.scaling, manualInstanceCount: instances };
    });
  }

  setWorkerPoolRevisionLabel(
    token: GoogleAccessToken,
    pool: CloudRunWorkerPoolRef,
    label: RevisionLabel,
  ): Promise<GoogleAnswer<true>> {
    return this.patchWhole(token, workerPoolUrl(pool), (found) => {
      const template = { ...found.template };
      template.labels = {
        ...(template.labels as Record<string, string> | undefined),
        [label.key]: label.value,
      };
      found.template = template;
    });
  }

  /**
   * `jobs.run` answers a long-running operation whose metadata is the new
   * execution (seen in a live check), named in full; its last part is kept.
   */
  async runCloudRunJob(
    token: GoogleAccessToken,
    job: CloudRunJobRef,
  ): Promise<GoogleAnswer<{ execution: string }>> {
    const answer = await call<{ metadata?: { name?: string } } | null>(
      `${cloudRunUrl('jobs', job)}:run`,
      withJson(token, 'POST', {}),
    );
    if (!answer.ok) return answer;
    const name = answer.value?.metadata?.name;
    if (!name) {
      return {
        ok: false,
        code: 'UNKNOWN',
        message: 'Cloud Run answered no execution for the run',
      };
    }
    return { ok: true, value: { execution: name.split('/').pop() ?? name } };
  }

  /**
   * Ended once Google sets its completion time: cancelled, succeeded or
   * failed by its counts, in its `Completed` condition's words. Its exit
   * code is its one task's last attempt's, read only once it has ended
   * (`run.tasks.list`); JSON leaves a zero out, so a last attempt
   * with no code and no error status exited 0.
   */
  async cloudRunExecution(
    token: GoogleAccessToken,
    execution: CloudRunExecutionRef,
  ): Promise<GoogleAnswer<CloudRunExecutionStatus>> {
    const url = executionUrl(execution);
    const answer = await call<{
      completionTime?: string;
      succeededCount?: number;
      failedCount?: number;
      cancelledCount?: number;
      conditions?: { type?: string; message?: string; reason?: string }[];
    } | null>(url, { method: 'GET', headers: bearer(token) });
    if (!answer.ok) return answer;
    const found = answer.value ?? {};
    if (!found.completionTime) {
      return {
        ok: true,
        value: { state: 'running', exitCode: null, message: null },
      };
    }
    const completed = (found.conditions ?? []).find(
      (one) => one.type === 'Completed',
    );
    const state =
      (found.cancelledCount ?? 0) > 0
        ? 'cancelled'
        : (found.succeededCount ?? 0) > 0 && (found.failedCount ?? 0) === 0
          ? 'succeeded'
          : 'failed';
    const message =
      state === 'succeeded'
        ? null
        : (completed?.message ?? completed?.reason ?? null);
    const tasks = await call<{
      tasks?: {
        index?: number;
        lastAttemptResult?: {
          exitCode?: number;
          status?: { code?: number; message?: string };
        };
      }[];
    } | null>(`${url}/tasks`, { method: 'GET', headers: bearer(token) });
    if (!tasks.ok) return tasks;
    const [task] = [...(tasks.value?.tasks ?? [])].sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0),
    );
    const attempt = task?.lastAttemptResult;
    const exitCode =
      attempt === undefined
        ? state === 'succeeded'
          ? 0
          : null
        : (attempt.exitCode ?? ((attempt.status?.code ?? 0) === 0 ? 0 : null));
    return {
      ok: true,
      value: {
        state,
        exitCode,
        message:
          message ??
          (exitCode === null ? (attempt?.status?.message ?? null) : null),
      },
    };
  }

  async cancelCloudRunExecution(
    token: GoogleAccessToken,
    execution: CloudRunExecutionRef,
  ): Promise<GoogleAnswer<true>> {
    const answer = await call<unknown>(
      `${executionUrl(execution)}:cancel`,
      withJson(token, 'POST', {}),
    );
    return answer.ok ? { ok: true, value: true } : answer;
  }

  async executionLogEntries(
    token: GoogleAccessToken,
    request: ExecutionLogRequest,
  ): Promise<GoogleAnswer<LogEntry[]>> {
    const read = await this.listLogEntries(token, {
      projectId: request.projectId,
      filter: executionLogFilter(request, request.from, Date.now()),
      limit: request.limit,
      oldestFirst: true,
    });
    if (!read.ok) return read;
    return { ok: true, value: afterPlace(read.value, request.from) };
  }

  /**
   * A patch names only what it changes: Cloud SQL's `instances.patch` keeps
   * every setting it is not sent, so the body is the activation policy
   * alone.
   */
  async setCloudSqlActivationPolicy(
    token: GoogleAccessToken,
    instance: CloudSqlInstanceRef,
    policy: CloudSqlActivationPolicy,
  ): Promise<GoogleAnswer<true>> {
    const written = await call<unknown>(
      `${SQL_ADMIN_URL}/projects/${encodeURIComponent(instance.projectId)}/instances/${encodeURIComponent(instance.name)}`,
      withJson(token, 'PATCH', { settings: { activationPolicy: policy } }),
    );
    return written.ok ? { ok: true, value: true } : written;
  }

  /**
   * The service read whole, changed, and written back whole with its
   * `etag`, as Cloud Run's own clients update it, so a field this call does
   * not name is never cleared, and only when something changed. Answers
   * once Google has taken the change; the rollout it starts is Google's.
   */
  private async patchService(
    token: GoogleAccessToken,
    service: CloudRunServiceRef,
    change: (found: CloudRunServiceBody) => void,
  ): Promise<GoogleAnswer<true>> {
    return this.patchWhole(token, cloudRunServiceUrl(service), change);
  }

  /**
   * A Cloud Run service or worker pool read whole, changed, and written back
   * whole with its `etag` ({@link patchService}): the two take the same
   * update.
   */
  private async patchWhole(
    token: GoogleAccessToken,
    url: string,
    change: (found: CloudRunServiceBody) => void,
  ): Promise<GoogleAnswer<true>> {
    const read = await call<CloudRunServiceBody | null>(url, {
      method: 'GET',
      headers: bearer(token),
    });
    if (!read.ok) return read;
    const found: CloudRunServiceBody = { ...read.value };
    const before = JSON.stringify(found);
    change(found);
    // Nothing to change writes nothing: a deploy's Start of a service that
    // was never stopped is no update, and starts no rollout.
    if (JSON.stringify(found) === before) return { ok: true, value: true };
    const written = await call<unknown>(url, withJson(token, 'PATCH', found));
    return written.ok ? { ok: true, value: true } : written;
  }

  async certificate(
    token: GoogleAccessToken,
    certificate: GoogleCertificateRef,
  ): Promise<GoogleAnswer<GoogleCertificate>> {
    const name = certificate.name.startsWith('projects/')
      ? certificate.name
      : `projects/${encodeURIComponent(certificate.projectId)}/locations/global/certificates/${encodeURIComponent(certificate.name)}`;
    const answer = await call<{
      managed?: {
        state?: string;
        provisioningIssue?: { reason?: string; details?: string };
        authorizationAttemptInfo?: {
          state?: string;
          failureReason?: string;
          details?: string;
        }[];
      };
    }>(`${CERTIFICATE_MANAGER_URL}/${name}`, {
      method: 'GET',
      headers: bearer(token),
    });
    if (!answer.ok) return answer;
    const managed = answer.value?.managed;
    // A failed authorization says more than the provisioning issue does.
    const attempt = (managed?.authorizationAttemptInfo ?? []).find(
      (one) => one.failureReason,
    );
    const issue = managed?.provisioningIssue;
    const reason = attempt
      ? [attempt.failureReason, attempt.details].filter(Boolean).join(': ')
      : issue?.reason
        ? [issue.reason, issue.details].filter(Boolean).join(': ')
        : null;
    return {
      ok: true,
      value: { state: managed?.state ?? 'STATE_UNSPECIFIED', reason },
    };
  }

  async cloudSqlBackups(
    token: GoogleAccessToken,
    instance: GoogleDatabaseRef,
  ): Promise<GoogleAnswer<CloudSqlBackups>> {
    const url = `${SQL_ADMIN_URL}/projects/${encodeURIComponent(instance.projectId)}/instances/${encodeURIComponent(instance.name)}`;
    const found = await call<{
      settings?: {
        backupConfiguration?: {
          enabled?: boolean;
          backupRetentionSettings?: { retainedBackups?: number };
        };
      };
    } | null>(url, { method: 'GET', headers: bearer(token) });
    if (!found.ok) return found;
    const backupConfiguration = found.value?.settings?.backupConfiguration;
    const runs = await everyPage<{
      id?: string;
      type?: string;
      status?: string;
      startTime?: string;
      enqueuedTime?: string;
      maxChargeableBytes?: string;
    }>(token, `${url}/backupRuns`, 'items', { maxResults: '500' });
    if (!runs.ok) return runs;
    // No recovery window yet (no backup, or point-in-time recovery off) is
    // Google's refusal of this one call; the rest of the tab still reads.
    const recovery = await call<{
      latestRecoveryTime?: string;
      earliestRecoveryTime?: string;
    } | null>(`${url}/getLatestRecoveryTime`, {
      method: 'GET',
      headers: bearer(token),
    });
    const window = recovery.ok ? recovery.value : null;
    return {
      ok: true,
      value: {
        retentionDays: backupConfiguration?.enabled
          ? (backupConfiguration.backupRetentionSettings?.retainedBackups ?? 0)
          : 0,
        earliestRestorableTime: window?.earliestRecoveryTime ?? null,
        latestRestorableTime: window?.latestRecoveryTime ?? null,
        backups: newestFirst(
          runs.value.map((run) => ({
            id: run.id ?? '',
            type: run.type === 'AUTOMATED' ? 'automated' : 'manual',
            createdAt: run.startTime ?? run.enqueuedTime ?? null,
            status: (run.status ?? 'unknown').toLowerCase(),
            size: bytesText(run.maxChargeableBytes),
          })),
        ),
      },
    };
  }

  async memorystoreBackups(
    token: GoogleAccessToken,
    instance: GoogleDatabaseRef,
  ): Promise<GoogleAnswer<MemorystoreBackups>> {
    const found = await call<{
      automatedBackupConfig?: {
        automatedBackupMode?: string;
        retention?: string;
      };
      backupCollection?: string;
    } | null>(
      `${MEMORYSTORE_URL}/projects/${encodeURIComponent(instance.projectId)}/locations/${encodeURIComponent(instance.region)}/instances/${encodeURIComponent(instance.name)}`,
      { method: 'GET', headers: bearer(token) },
    );
    if (!found.ok) return found;
    const config = found.value?.automatedBackupConfig;
    const retention =
      config?.automatedBackupMode === 'ENABLED'
        ? Math.round(Number.parseFloat(config.retention ?? '0') / 86_400)
        : 0;
    // Google makes the collection with the first backup.
    const collection = found.value?.backupCollection;
    if (!collection) {
      return { ok: true, value: { retentionDays: retention, backups: [] } };
    }
    const listed = await everyPage<{
      name?: string;
      createTime?: string;
      totalSizeBytes?: string;
      state?: string;
      backupType?: string;
    }>(token, `${MEMORYSTORE_URL}/${collection}/backups`, 'backups', {
      pageSize: '500',
    });
    if (!listed.ok) return listed;
    return {
      ok: true,
      value: {
        retentionDays: retention,
        backups: newestFirst(
          listed.value.map((backup) => ({
            id: backup.name?.split('/').pop() ?? '',
            type: backup.backupType === 'AUTOMATED' ? 'automated' : 'manual',
            createdAt: backup.createTime ?? null,
            status: (backup.state ?? 'unknown').toLowerCase(),
            size: bytesText(backup.totalSizeBytes),
          })),
        ),
      },
    };
  }

  async cloudSqlInstance(
    token: GoogleAccessToken,
    instance: ExistingCloudSqlRef,
  ): Promise<GoogleAnswer<CloudSqlInstanceRead>> {
    const answer = await call<{
      region?: string;
      databaseVersion?: string;
      pscServiceAttachmentLink?: string;
      dnsNames?: {
        name?: string;
        connectionType?: string;
        recordManager?: string;
      }[];
      serverCaCert?: { cert?: string };
      settings?: {
        userLabels?: Record<string, string>;
        ipConfiguration?: {
          sslMode?: string;
          ipv4Enabled?: boolean;
          privateNetwork?: string;
          pscConfig?: {
            pscEnabled?: boolean;
            allowedConsumerProjects?: string[];
          };
        };
      };
    }>(
      `${SQL_ADMIN_URL}/projects/${encodeURIComponent(instance.projectId)}/instances/${encodeURIComponent(instance.instance)}`,
      { method: 'GET', headers: bearer(token) },
    );
    if (!answer.ok) return answer;
    const found = answer.value ?? {};
    const ip = found.settings?.ipConfiguration ?? {};
    return {
      ok: true,
      value: {
        region: found.region ?? '',
        databaseVersion: found.databaseVersion ?? '',
        labels: found.settings?.userLabels ?? {},
        sslMode: ip.sslMode ?? null,
        pscEnabled: ip.pscConfig?.pscEnabled === true,
        publicIp: ip.ipv4Enabled === true,
        privateNetwork: ip.privateNetwork || null,
        allowedConsumerProjects: ip.pscConfig?.allowedConsumerProjects ?? [],
        serviceAttachment: found.pscServiceAttachmentLink || null,
        dnsNames: (found.dnsNames ?? []).flatMap((one) =>
          one.name
            ? [
                {
                  name: one.name,
                  connectionType: one.connectionType ?? null,
                  recordManager: one.recordManager ?? null,
                },
              ]
            : [],
        ),
        serverCa: found.serverCaCert?.cert || null,
      },
    };
  }

  /**
   * Cloud Storage's JSON API names no `status` in a refusal, only its HTTP
   * code, so a bucket it does not have is answered as `NOT_FOUND` here.
   * With `maxResults`, one page of at most that many; without, every page.
   */
  async listObjects(
    token: GoogleAccessToken,
    request: ObjectListRequest,
  ): Promise<GoogleAnswer<StoredObject[]>> {
    const objects: StoredObject[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        ...(request.prefix !== undefined ? { prefix: request.prefix } : {}),
        maxResults: String(request.maxResults ?? 1000),
        ...(request.versions ? { versions: 'true' } : {}),
        fields: 'items(name,md5Hash,size),nextPageToken',
        ...(pageToken ? { pageToken } : {}),
      });
      const answer = await call<{
        items?: { name: string; md5Hash?: string; size?: string }[];
        nextPageToken?: string;
      } | null>(`${bucketUrl(request.bucket)}/o?${query.toString()}`, {
        method: 'GET',
        headers: bearer(token),
      });
      if (!answer.ok) {
        return answer.code === '404' ? { ...answer, code: NOT_FOUND } : answer;
      }
      for (const item of answer.value?.items ?? [])
        objects.push(storedOf(item));
      pageToken =
        request.maxResults === undefined
          ? answer.value?.nextPageToken || undefined
          : undefined;
    } while (pageToken);
    return { ok: true, value: objects };
  }

  /**
   * As {@link listObjects}, Cloud Storage names no `status` in a refusal:
   * a 404 is `NOT_FOUND`, a 403 (or a 401) `PERMISSION_DENIED`.
   */
  async storageBucket(
    token: GoogleAccessToken,
    bucket: string,
  ): Promise<GoogleAnswer<StorageBucketRead>> {
    const query = new URLSearchParams({
      fields:
        'location,locationType,customPlacementConfig,billing,labels,projectNumber',
    });
    const answer = await call<{
      location?: string;
      locationType?: string;
      customPlacementConfig?: { dataLocations?: string[] };
      billing?: { requesterPays?: boolean };
      labels?: Record<string, string>;
      projectNumber?: string;
    } | null>(`${bucketUrl(bucket)}?${query.toString()}`, {
      method: 'GET',
      headers: bearer(token),
    });
    if (!answer.ok) return storageRefusal(answer);
    const found = answer.value ?? {};
    return {
      ok: true,
      value: {
        location: found.location ?? '',
        locationType: found.locationType ?? '',
        dataLocations: found.customPlacementConfig?.dataLocations ?? [],
        requesterPays: found.billing?.requesterPays === true,
        labels: found.labels ?? {},
        projectNumber: found.projectNumber ?? '',
      },
    };
  }

  async uploadObject(
    token: GoogleAccessToken,
    request: ObjectUploadRequest,
  ): Promise<GoogleAnswer<StoredObject>> {
    const body = await readFile(request.file);
    const query = new URLSearchParams({
      uploadType: 'media',
      name: request.name,
    });
    const answer = await call<{
      name: string;
      md5Hash?: string;
      size?: string;
    }>(
      `${STORAGE_UPLOAD_URL}/b/${encodeURIComponent(request.bucket)}/o?${query.toString()}`,
      {
        method: 'POST',
        headers: { ...bearer(token), 'content-type': request.contentType },
        body,
      },
      OBJECT_TIMEOUT_MS,
    );
    return answer.ok ? { ok: true, value: storedOf(answer.value) } : answer;
  }

  /** A rewrite answers in parts for a large object: each part's token is asked again until done. */
  async copyObject(
    token: GoogleAccessToken,
    request: ObjectCopyRequest,
  ): Promise<GoogleAnswer<true>> {
    const url = `${bucketUrl(request.bucket)}/o/${encodeURIComponent(request.from)}/rewriteTo/b/${encodeURIComponent(request.bucket)}/o/${encodeURIComponent(request.to)}`;
    let rewriteToken: string | undefined;
    do {
      const query = new URLSearchParams(
        rewriteToken ? { rewriteToken } : {},
      ).toString();
      const answer = await call<{ done?: boolean; rewriteToken?: string }>(
        query ? `${url}?${query}` : url,
        withJson(token, 'POST', {}),
        OBJECT_TIMEOUT_MS,
      );
      if (!answer.ok) return answer;
      rewriteToken = answer.value.done ? undefined : answer.value.rewriteToken;
    } while (rewriteToken);
    return { ok: true, value: true };
  }

  /**
   * As {@link listObjects}, Cloud Storage names only the HTTP code in a
   * refusal, so an object already gone is answered as `NOT_FOUND` here.
   */
  async deleteObject(
    token: GoogleAccessToken,
    object: ObjectRef,
  ): Promise<GoogleAnswer<true>> {
    const answer = await call<unknown>(
      `${bucketUrl(object.bucket)}/o/${encodeURIComponent(object.name)}`,
      { method: 'DELETE', headers: bearer(token) },
    );
    if (answer.ok) return { ok: true, value: true };
    return answer.code === '404' ? { ...answer, code: NOT_FOUND } : answer;
  }

  async emptyBucket(
    token: GoogleAccessToken,
    bucket: string,
  ): Promise<GoogleAnswer<{ deleted: number }>> {
    const listed = await this.listObjects(token, { bucket });
    if (!listed.ok) {
      return listed.code === NOT_FOUND
        ? { ok: true, value: { deleted: 0 } }
        : listed;
    }
    let deleted = 0;
    for (const object of listed.value) {
      const answer = await this.deleteObject(token, {
        bucket,
        name: object.name,
      });
      if (!answer.ok && answer.code !== NOT_FOUND) return answer;
      if (answer.ok) deleted++;
    }
    return { ok: true, value: { deleted } };
  }

  async memorystoreInstance(
    token: GoogleAccessToken,
    instance: ExistingValkeyRef,
  ): Promise<GoogleAnswer<MemorystoreInstanceRead>> {
    const path = `projects/${encodeURIComponent(instance.projectId)}/locations/${encodeURIComponent(instance.region)}`;
    const id = encodeURIComponent(instance.instance);
    const answer = await call<{
      engineVersion?: string;
      mode?: string;
      authorizationMode?: string;
      transitEncryptionMode?: string;
      maintenanceVersion?: string;
      effectiveMaintenanceVersion?: string;
      labels?: Record<string, string>;
      pscAttachmentDetails?: {
        serviceAttachment?: string;
        connectionType?: string;
      }[];
      endpoints?: {
        connections?: { pscConnection?: { forwardingRule?: string } }[];
      }[];
    }>(`${MEMORYSTORE_URL}/${path}/instances/${id}`, {
      method: 'GET',
      headers: bearer(token),
    });
    if (!answer.ok) {
      if (answer.code !== NOT_FOUND) return answer;
      // Not Valkey: Memorystore for Redis's instance, then its cluster, so
      // the plan can say "use Valkey". Any answer but a found one (its API
      // off, no read there) leaves Valkey's NOT_FOUND as the answer.
      for (const [product, collection] of [
        ['redis', 'instances'],
        ['redis-cluster', 'clusters'],
      ] as const) {
        const other = await call<unknown>(
          `${REDIS_URL}/${path}/${collection}/${id}`,
          { method: 'GET', headers: bearer(token) },
        ).catch(() => null);
        if (other?.ok) {
          return { ok: true, value: { ...EMPTY_MEMORYSTORE_READ, product } };
        }
      }
      return answer;
    }
    const found = answer.value ?? {};
    const tls = found.transitEncryptionMode === 'SERVER_AUTHENTICATION';
    let ca: string | null = null;
    if (tls) {
      const authority = await call<{
        managedServerCa?: { caCerts?: { certificates?: string[] }[] };
      }>(`${MEMORYSTORE_URL}/${path}/instances/${id}/certificateAuthority`, {
        method: 'GET',
        headers: bearer(token),
      });
      if (!authority.ok) return authority;
      const certificates = (
        authority.value?.managedServerCa?.caCerts ?? []
      ).flatMap((one) => one.certificates ?? []);
      ca = certificates.length > 0 ? certificates.join('\n') : null;
    }
    return {
      ok: true,
      value: {
        product: 'valkey',
        engineVersion: found.engineVersion ?? '',
        mode: found.mode ?? null,
        authorizationMode: found.authorizationMode ?? null,
        transitEncryptionMode: found.transitEncryptionMode ?? null,
        maintenanceVersion:
          found.effectiveMaintenanceVersion || found.maintenanceVersion || null,
        labels: found.labels ?? {},
        serviceAttachments: (found.pscAttachmentDetails ?? []).flatMap((one) =>
          one.serviceAttachment
            ? [
                {
                  serviceAttachment: one.serviceAttachment,
                  connectionType: one.connectionType ?? null,
                },
              ]
            : [],
        ),
        registeredForwardingRules: (found.endpoints ?? []).flatMap((endpoint) =>
          (endpoint.connections ?? []).flatMap((one) =>
            one.pscConnection?.forwardingRule
              ? [one.pscConnection.forwardingRule]
              : [],
          ),
        ),
        ca,
      },
    };
  }

  async pscEndpointStatus(
    token: GoogleAccessToken,
    endpoint: PscEndpointRef,
  ): Promise<GoogleAnswer<PscConnectionStatus>> {
    const answer = await call<{ pscConnectionStatus?: string }>(
      `${COMPUTE_URL}/projects/${encodeURIComponent(endpoint.projectId)}/regions/${encodeURIComponent(endpoint.region)}/forwardingRules/${encodeURIComponent(endpoint.name)}`,
      { method: 'GET', headers: bearer(token) },
    );
    if (!answer.ok) return answer;
    const said = answer.value?.pscConnectionStatus;
    return {
      ok: true,
      value:
        PSC_CONNECTION_STATUSES.find((status) => status === said) ??
        'STATUS_UNSPECIFIED',
    };
  }

  /**
   * A regional build (`projects.locations.builds`), in the Service's region,
   * where its source bucket is. The create answers a long-running
   * operation whose metadata holds the build, its id among its fields.
   */
  async startCloudBuild(
    token: GoogleAccessToken,
    request: CloudBuildStartRequest,
  ): Promise<GoogleAnswer<{ buildId: string }>> {
    const answer = await call<{
      metadata?: { build?: { id?: string } };
    } | null>(
      cloudBuildsUrl(request.projectId, request.region),
      withJson(token, 'POST', request.build),
    );
    if (!answer.ok) return answer;
    const buildId = answer.value?.metadata?.build?.id;
    if (!buildId) {
      return {
        ok: false,
        code: 'Unreachable',
        message: 'Cloud Build took the build but did not name it',
      };
    }
    return { ok: true, value: { buildId } };
  }

  async cloudBuild(
    token: GoogleAccessToken,
    build: CloudBuildRef,
  ): Promise<GoogleAnswer<CloudBuildState>> {
    const answer = await call<{
      status?: string;
      statusDetail?: string;
      failureInfo?: { detail?: string };
      results?: { buildStepOutputs?: string[] };
    } | null>(cloudBuildUrl(build), { method: 'GET', headers: bearer(token) });
    if (!answer.ok) return answer;
    const found = answer.value ?? {};
    const status = (
      CLOUD_BUILD_STATUSES.includes(found.status as CloudBuildStatusName)
        ? found.status
        : 'STATUS_UNKNOWN'
    ) as CloudBuildStatusName;
    return {
      ok: true,
      value: {
        phase:
          status === 'PENDING' || status === 'QUEUED'
            ? 'queued'
            : status === 'WORKING' || status === 'STATUS_UNKNOWN'
              ? 'running'
              : 'ended',
        status,
        reason: found.failureInfo?.detail || found.statusDetail || null,
        // `bytes` fields are base64 in Google's JSON.
        stepOutputs: (found.results?.buildStepOutputs ?? []).map((output) =>
          Buffer.from(output ?? '', 'base64').toString('utf8'),
        ),
      },
    };
  }

  /**
   * The secret is made with automatic replication, as Cloudgate's other
   * secrets are; a step that fails after the create leaves it for the
   * caller's {@link deleteSecret}, which always follows.
   */
  async putBuildSecret(
    token: GoogleAccessToken,
    request: BuildSecretPut,
  ): Promise<GoogleAnswer<{ versionName: string }>> {
    const secrets = `${SECRET_MANAGER_URL}/projects/${encodeURIComponent(request.projectId)}/secrets`;
    const secret = `${secrets}/${encodeURIComponent(request.secretId)}`;
    const made = await call<unknown>(
      `${secrets}?${new URLSearchParams({ secretId: request.secretId }).toString()}`,
      withJson(token, 'POST', {
        replication: { automatic: {} },
        labels: request.labels,
      }),
    );
    if (!made.ok) return made;
    const granted = await call<unknown>(
      `${secret}:setIamPolicy`,
      withJson(token, 'POST', {
        policy: {
          bindings: [
            {
              role: SECRET_ACCESSOR_ROLE,
              members: [`serviceAccount:${request.readerEmail}`],
            },
          ],
        },
      }),
    );
    if (!granted.ok) return granted;
    const added = await call<{ name?: string } | null>(
      `${secret}:addVersion`,
      withJson(token, 'POST', {
        payload: {
          data: Buffer.from(request.value, 'utf8').toString('base64'),
        },
      }),
    );
    if (!added.ok) return added;
    const versionName = added.value?.name;
    if (!versionName) {
      return {
        ok: false,
        code: 'Unreachable',
        message: 'Secret Manager added the version but did not name it',
      };
    }
    return { ok: true, value: { versionName } };
  }

  async deleteSecret(
    token: GoogleAccessToken,
    secret: SecretRef,
  ): Promise<GoogleAnswer<true>> {
    const answer = await call<unknown>(
      `${SECRET_MANAGER_URL}/projects/${encodeURIComponent(secret.projectId)}/secrets/${encodeURIComponent(secret.secretId)}`,
      { method: 'DELETE', headers: bearer(token) },
    );
    if (answer.ok || answer.code === NOT_FOUND)
      return { ok: true, value: true };
    return answer;
  }

  /** Google refuses the cancel of a build that has ended: it is done all the same. */
  async cancelCloudBuild(
    token: GoogleAccessToken,
    build: CloudBuildRef,
  ): Promise<GoogleAnswer<true>> {
    const answer = await call<unknown>(
      `${cloudBuildUrl(build)}:cancel`,
      withJson(token, 'POST', {
        name: `projects/${build.projectId}/locations/${build.region}/builds/${build.buildId}`,
        projectId: build.projectId,
        id: build.buildId,
      }),
    );
    if (answer.ok || answer.code === 'FAILED_PRECONDITION') {
      return { ok: true, value: true };
    }
    return answer;
  }

  async cloudBuildLogEntries(
    token: GoogleAccessToken,
    request: CloudBuildLogRequest,
  ): Promise<GoogleAnswer<LogEntry[]>> {
    const read = await this.listLogEntries(token, {
      projectId: request.projectId,
      filter: cloudBuildLogFilter(request, request.from, Date.now()),
      limit: request.limit,
      oldestFirst: true,
    });
    if (!read.ok) return read;
    return { ok: true, value: afterPlace(read.value, request.from) };
  }

  /**
   * `urlMaps.invalidateCache` for the host's every path, then its global
   * operation read until `DONE`: Google answers a clear at once and
   * finishes it in about 2 seconds.
   */
  async invalidateCache(
    token: GoogleAccessToken,
    request: CacheClearRequest,
  ): Promise<GoogleAnswer<true>> {
    const project = `${COMPUTE_URL}/projects/${encodeURIComponent(request.projectId)}/global`;
    const started = await call<ComputeOperation | null>(
      `${project}/urlMaps/${encodeURIComponent(request.urlMap)}/invalidateCache`,
      withJson(token, 'POST', { host: request.host, path: '/*' }),
    );
    if (!started.ok) return started;
    let current = started.value ?? {};
    for (let poll = 0; current.status !== 'DONE'; poll++) {
      if (!current.name || poll >= this.operationPolls) {
        return notFinished('Cloud CDN', current.name);
      }
      await new Promise((resolve) => setTimeout(resolve, this.operationPollMs));
      const read = await call<ComputeOperation | null>(
        `${project}/operations/${encodeURIComponent(current.name)}`,
        { method: 'GET', headers: bearer(token) },
      );
      if (!read.ok) return read;
      current = read.value ?? {};
    }
    const failed = current.error?.errors?.[0];
    if (failed) {
      return {
        ok: false,
        code: failed.code ?? 'UNKNOWN',
        message: failed.message ?? 'Cloud CDN did not say why',
      };
    }
    return { ok: true, value: true };
  }

  async dnsLookup(name: string): Promise<DnsAnswer> {
    const [cnames, addresses] = await Promise.all([
      dns.resolveCname(name).catch(() => [] as string[]),
      dns.resolve4(name).catch(() => [] as string[]),
    ]);
    return { cnames, addresses };
  }

  /** How often a long-running operation is read, and how many times, before it counts as never finished. */
  operationPollMs = 5000;
  operationPolls = 360;

  liftCloudSqlDeletionProtection(
    token: GoogleAccessToken,
    instance: CloudSqlInstanceRef,
  ): Promise<GoogleAnswer<true>> {
    return this.patchCloudSqlSettings(token, instance, {
      deletionProtectionEnabled: false,
    });
  }

  stopRetainingCloudSqlBackups(
    token: GoogleAccessToken,
    instance: CloudSqlInstanceRef,
  ): Promise<GoogleAnswer<true>> {
    return this.patchCloudSqlSettings(token, instance, {
      retainBackupsOnDelete: false,
    });
  }

  /** One `instances.patch` of the named settings only, waited on until done. */
  private async patchCloudSqlSettings(
    token: GoogleAccessToken,
    instance: CloudSqlInstanceRef,
    settings: Record<string, unknown>,
  ): Promise<GoogleAnswer<true>> {
    const started = await call<CloudSqlOperation>(
      cloudSqlInstanceUrl(instance),
      withJson(token, 'PATCH', { settings }),
    );
    if (!started.ok) return started;
    const done = await this.cloudSqlOperationDone(
      token,
      instance,
      started.value,
    );
    return done.ok ? { ok: true, value: true } : done;
  }

  async takeCloudSqlBackup(
    token: GoogleAccessToken,
    instance: CloudSqlInstanceRef,
    description: string,
  ): Promise<GoogleAnswer<TakenBackup>> {
    const url = `${cloudSqlInstanceUrl(instance)}/backupRuns`;
    const started = await call<CloudSqlOperation>(
      url,
      withJson(token, 'POST', { description }),
    );
    if (!started.ok) return started;
    const done = await this.cloudSqlOperationDone(
      token,
      instance,
      started.value,
    );
    if (!done.ok) return done;
    const backupId = done.value.backupContext?.backupId;
    // Taken: its size is a report's detail, so an unreadable one is unknown.
    const run = backupId
      ? await call<{ location?: string; maxChargeableBytes?: string }>(
          `${url}/${encodeURIComponent(backupId)}`,
          { method: 'GET', headers: bearer(token) },
        )
      : null;
    const read = run?.ok ? run.value : null;
    return {
      ok: true,
      value: {
        location: read?.location || 'us',
        sizeBytes: bytesOf(read?.maxChargeableBytes),
      },
    };
  }

  /** A Cloud SQL operation read until `DONE`: its error, as Google's refusal, or the finished operation. */
  private async cloudSqlOperationDone(
    token: GoogleAccessToken,
    instance: CloudSqlInstanceRef,
    operation: CloudSqlOperation | null,
  ): Promise<GoogleAnswer<CloudSqlOperation>> {
    let current = operation ?? {};
    for (let poll = 0; current.status !== 'DONE'; poll++) {
      if (!current.name || poll >= this.operationPolls) {
        return notFinished('Cloud SQL', current.name);
      }
      await new Promise((resolve) => setTimeout(resolve, this.operationPollMs));
      const read = await call<CloudSqlOperation>(
        `${SQL_ADMIN_URL}/projects/${encodeURIComponent(instance.projectId)}/operations/${encodeURIComponent(current.name)}`,
        { method: 'GET', headers: bearer(token) },
      );
      if (!read.ok) return read;
      current = read.value ?? {};
    }
    const failed = current.error?.errors?.[0];
    if (failed) {
      return {
        ok: false,
        code: failed.code ?? 'UNKNOWN',
        message: failed.message ?? 'Cloud SQL did not say why',
      };
    }
    return { ok: true, value: current };
  }

  async takeMemorystoreBackup(
    token: GoogleAccessToken,
    instance: MemorystoreInstanceRef,
    backupId: string,
  ): Promise<GoogleAnswer<TakenBackup>> {
    const url = `${MEMORYSTORE_URL}/projects/${encodeURIComponent(instance.projectId)}/locations/${encodeURIComponent(instance.region)}/instances/${encodeURIComponent(instance.name)}`;
    // No `ttl`: Google keeps it 100 years, which is "until you delete it".
    const started = await call<LongRunningOperation>(
      `${url}:backup`,
      withJson(token, 'POST', { backupId }),
    );
    if (!started.ok) return started;
    let current = started.value ?? {};
    for (let poll = 0; !current.done; poll++) {
      if (!current.name || poll >= this.operationPolls) {
        return notFinished('Memorystore', current.name);
      }
      await new Promise((resolve) => setTimeout(resolve, this.operationPollMs));
      const read = await call<LongRunningOperation>(
        `${MEMORYSTORE_URL}/${current.name}`,
        { method: 'GET', headers: bearer(token) },
      );
      if (!read.ok) return read;
      current = read.value ?? {};
    }
    if (current.error) {
      return {
        ok: false,
        code: statusName(current.error.code),
        message: current.error.message ?? 'Memorystore did not say why',
      };
    }
    // The backup sits in the instance's backup collection, made by its first.
    const found = await call<{ backupCollection?: string }>(url, {
      method: 'GET',
      headers: bearer(token),
    });
    const collection = found.ok ? found.value?.backupCollection : undefined;
    const backup = collection
      ? await call<{ totalSizeBytes?: string }>(
          `${MEMORYSTORE_URL}/${collection}/backups/${encodeURIComponent(backupId)}`,
          { method: 'GET', headers: bearer(token) },
        )
      : null;
    return {
      ok: true,
      value: {
        location: instance.region,
        sizeBytes: bytesOf(
          backup?.ok ? backup.value?.totalSizeBytes : undefined,
        ),
      },
    };
  }

  async takeDiskSnapshot(
    token: GoogleAccessToken,
    request: DiskSnapshotRequest,
  ): Promise<GoogleAnswer<TakenDiskSnapshot>> {
    const project = `${COMPUTE_URL}/projects/${encodeURIComponent(request.projectId)}`;
    const zone = `${project}/zones/${encodeURIComponent(request.zone)}`;
    const started = await call<ComputeOperation | null>(
      `${zone}/disks/${encodeURIComponent(request.disk)}/createSnapshot`,
      withJson(token, 'POST', {
        name: request.name,
        description: request.description,
        labels: request.labels,
        storageLocations: [request.region],
      }),
    );
    if (!started.ok) return started;
    const done = await this.computeOperationDone(
      token,
      `${zone}/operations`,
      started.value,
    );
    if (!done.ok) return done;
    const read = await call<{ diskSizeGb?: string } | null>(
      `${project}/global/snapshots/${encodeURIComponent(request.name)}`,
      { method: 'GET', headers: bearer(token) },
    );
    const sizeGb = Number(read.ok ? read.value?.diskSizeGb : undefined);
    return {
      ok: true,
      value: {
        name: request.name,
        sizeGb: Number.isFinite(sizeGb) ? sizeGb : 0,
      },
    };
  }

  async scheduledDiskSnapshots(
    token: GoogleAccessToken,
    disk: DiskRef,
  ): Promise<GoogleAnswer<string[]>> {
    const project = `${COMPUTE_URL}/projects/${encodeURIComponent(disk.projectId)}`;
    const source = `${project}/zones/${encodeURIComponent(disk.zone)}/disks/${encodeURIComponent(disk.disk)}`;
    const names: string[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        filter: `sourceDisk = "${source}"`,
        ...(pageToken ? { pageToken } : {}),
      });
      const page = await call<{
        items?: { name?: string; autoCreated?: boolean }[];
        nextPageToken?: string;
      } | null>(`${project}/global/snapshots?${query.toString()}`, {
        method: 'GET',
        headers: bearer(token),
      });
      if (!page.ok) return page;
      for (const item of page.value?.items ?? []) {
        // A schedule's snapshot only: one taken by hand stays.
        if (item.name && item.autoCreated) names.push(item.name);
      }
      pageToken = page.value?.nextPageToken;
    } while (pageToken);
    return { ok: true, value: names };
  }

  async deleteDiskSnapshot(
    token: GoogleAccessToken,
    snapshot: { readonly projectId: string; readonly name: string },
  ): Promise<GoogleAnswer<true>> {
    const global = `${COMPUTE_URL}/projects/${encodeURIComponent(snapshot.projectId)}/global`;
    const started = await call<ComputeOperation | null>(
      `${global}/snapshots/${encodeURIComponent(snapshot.name)}`,
      { method: 'DELETE', headers: bearer(token) },
    );
    if (!started.ok) {
      return started.code === NOT_FOUND ? { ok: true, value: true } : started;
    }
    const done = await this.computeOperationDone(
      token,
      `${global}/operations`,
      started.value,
    );
    return done.ok ? { ok: true, value: true } : done;
  }

  /** A Compute Engine operation read until `DONE`, from its zone's or the project's operations. */
  private async computeOperationDone(
    token: GoogleAccessToken,
    operations: string,
    operation: ComputeOperation | null,
  ): Promise<GoogleAnswer<ComputeOperation>> {
    let current = operation ?? {};
    for (let poll = 0; current.status !== 'DONE'; poll++) {
      if (!current.name || poll >= this.operationPolls) {
        return notFinished('Compute Engine', current.name);
      }
      await new Promise((resolve) => setTimeout(resolve, this.operationPollMs));
      const read = await call<ComputeOperation | null>(
        `${operations}/${encodeURIComponent(current.name)}`,
        { method: 'GET', headers: bearer(token) },
      );
      if (!read.ok) return read;
      current = read.value ?? {};
    }
    const failed = current.error?.errors?.[0];
    if (failed) {
      return {
        ok: false,
        code: failed.code ?? 'UNKNOWN',
        message: failed.message ?? 'Compute Engine did not say why',
      };
    }
    return { ok: true, value: current };
  }

  async listLogEntries(
    token: GoogleAccessToken,
    request: LogEntriesRequest,
  ): Promise<GoogleAnswer<LogEntry[]>> {
    const answer = await call<{
      entries?: {
        insertId?: string;
        logName?: string;
        timestamp?: string;
        resource?: { labels?: Record<string, string> };
        labels?: Record<string, string>;
        textPayload?: string;
        jsonPayload?: Record<string, unknown>;
        protoPayload?: {
          methodName?: string;
          status?: { message?: string };
        };
      }[];
    } | null>(
      `${LOGGING_URL}/entries:list`,
      withJson(token, 'POST', {
        resourceNames: [`projects/${request.projectId}`],
        filter: request.filter,
        orderBy: request.oldestFirst ? 'timestamp asc' : 'timestamp desc',
        pageSize: request.limit,
      }),
    );
    if (!answer.ok) return answer;
    return {
      ok: true,
      value: (answer.value?.entries ?? []).map((entry) => ({
        insertId: entry.insertId ?? '',
        logName: entry.logName ?? '',
        timestamp: entry.timestamp ?? '',
        revision: entry.resource?.labels?.revision_name ?? null,
        instance: entry.labels?.instanceId ?? null,
        text:
          entry.textPayload ??
          (typeof entry.jsonPayload?.message === 'string'
            ? entry.jsonPayload.message
            : // Cloud Run's own messages are audit entries (the live
              // walk): their words are the status message, else the call.
              entry.protoPayload
              ? entry.protoPayload.status?.message ||
                entry.protoPayload.methodName ||
                ''
              : JSON.stringify(entry.jsonPayload ?? {})),
      })),
    };
  }

  /** How long the deletes are waited for, and how often the list is read. */
  imageDeletePollMs = 2000;
  imageDeletePolls = 30;

  /** Every version of an image, with its tags and whether it is an index. */
  private async imageVersions(
    token: GoogleAccessToken,
    image: string,
  ): Promise<
    GoogleAnswer<{ name: string; tags: string[]; isIndex: boolean }[]>
  > {
    const versions: { name: string; tags: string[]; isIndex: boolean }[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        view: 'FULL',
        pageSize: '500',
        ...(pageToken ? { pageToken } : {}),
      });
      const answer = await call<{
        versions?: {
          name: string;
          relatedTags?: { name: string }[];
          metadata?: { mediaType?: string };
        }[];
        nextPageToken?: string;
      } | null>(
        `${ARTIFACT_REGISTRY_URL}/${image}/versions?${query.toString()}`,
        {
          method: 'GET',
          headers: bearer(token),
        },
      );
      if (!answer.ok) return answer;
      for (const version of answer.value?.versions ?? []) {
        versions.push({
          name: version.name,
          tags: (version.relatedTags ?? []).map(
            (tag) => tag.name.split('/').pop() ?? tag.name,
          ),
          isIndex: INDEX_MEDIA_TYPES.has(version.metadata?.mediaType ?? ''),
        });
      }
      pageToken = answer.value?.nextPageToken || undefined;
    } while (pageToken);
    return { ok: true, value: versions };
  }

  /**
   * Lists every version first, so a kept tag no version carries deletes
   * nothing: the live image is never taken by a wrong tag.
   */
  async deleteImageVersionsExcept(
    token: GoogleAccessToken,
    request: ImageVersionsRequest,
  ): Promise<GoogleAnswer<{ deleted: number }>> {
    const image = `projects/${encodeURIComponent(request.projectId)}/locations/${encodeURIComponent(request.region)}/repositories/${encodeURIComponent(request.repository)}/packages/${encodeURIComponent(request.image)}`;
    const listed = await this.imageVersions(token, image);
    if (!listed.ok) return listed;
    const versions = listed.value;
    const kept = versions.find((version) =>
      version.tags.includes(request.keepTag),
    );
    if (!kept) {
      return {
        ok: false,
        code: NOT_FOUND,
        message: `No version of ${request.image} in ${request.repository} carries the tag ${request.keepTag}, so none was deleted`,
      };
    }
    // A push from Docker's containerd image store is an index whose image
    // and attestation manifests are untagged versions of their own (the live
    // walk): they are the live image, never "older". The index
    // is read from the registry itself, which the role's
    // `repositories.downloadArtifacts` already allows.
    const digestOf = (name: string) => name.slice(name.lastIndexOf('/') + 1);
    const keptDigest = digestOf(kept.name);
    const live = new Set([keptDigest]);
    if (kept.isIndex) {
      const index = await call<{
        manifests?: { digest?: string }[];
      } | null>(
        `https://${request.region}-docker.pkg.dev/v2/${request.projectId}/${request.repository}/${request.image}/manifests/${keptDigest}`,
        {
          method: 'GET',
          headers: {
            ...bearer(token),
            accept: [...INDEX_MEDIA_TYPES].join(', '),
          },
        },
      );
      if (!index.ok) return index;
      for (const manifest of index.value?.manifests ?? []) {
        if (manifest.digest) live.add(manifest.digest);
      }
    }
    // An older index goes before its own manifests, which Google refuses to
    // delete while an index still names them.
    const older = versions
      .filter((version) => !live.has(digestOf(version.name)))
      .sort((a, b) => Number(b.isIndex) - Number(a.isIndex));
    for (const version of older) {
      const answer = await call<unknown>(
        `${ARTIFACT_REGISTRY_URL}/${version.name}?force=true`,
        { method: 'DELETE', headers: bearer(token) },
      );
      if (!answer.ok) return answer;
    }
    if (older.length === 0) return { ok: true, value: { deleted: 0 } };
    // A delete answers before it is done, and can still fail after, as a
    // tag immutability refusal did in the live walk. Its operation
    // is not readable with the role, so the versions are listed again until
    // the deleted ones are gone: only those count.
    const asked = new Set(older.map((version) => version.name));
    let left = asked.size;
    for (let poll = 0; poll < this.imageDeletePolls; poll++) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.imageDeletePollMs),
      );
      const again = await this.imageVersions(token, image);
      if (!again.ok) return again;
      left = again.value.filter((version) => asked.has(version.name)).length;
      if (left === 0) break;
    }
    if (left > 0) {
      return {
        ok: false,
        code: 'FAILED_PRECONDITION',
        message: `${left} of ${asked.size} older versions were still listed after the deletes`,
      };
    }
    return { ok: true, value: { deleted: asked.size } };
  }

  /** As {@link apply}, planned with `-destroy`: everything the state holds. */
  destroy(
    request: TofuApplyRequest<GoogleCredential>,
  ): Promise<TofuApplyOutcome> {
    return this.tofu.destroy(request);
  }

  /** What the state holds, as Google's projection makes it. */
  stateResources(
    request: TofuStateReadRequest<GoogleCredential>,
  ): Promise<TofuStateOutcome<GoogleStateResource>> {
    return this.tofu.stateResources(request, (show) =>
      googleStateResources(show, request.region),
    );
  }

  /** Shutdown waits for every running `tofu`, as the AWS adapter's does. */
  beforeApplicationShutdown(): Promise<void> {
    return this.tofu.whenIdle();
  }

  async findByName(
    token: GoogleAccessToken,
    request: FindByNameRequest,
  ): Promise<GoogleAnswer<FoundByName[]>> {
    // With no map named, a map entry is looked for under each map found by
    // the same prefix; a named map is listed directly.
    if (request.resourceType === MAP_ENTRY && !request.parent) {
      return this.findMapEntries(token, request);
    }
    const list = LISTS[request.resourceType]?.(request);
    if (!list) return { ok: true, value: [] };
    return listByName(token, request, list);
  }

  async findByLabel(
    token: GoogleAccessToken,
    request: FindByLabelRequest,
  ): Promise<GoogleAnswer<FoundByLabel[]>> {
    const found: FoundByLabel[] = [];
    for (const kind of LABELLED_KINDS) {
      const answer = await listByLabel(token, kind(request));
      if (!answer.ok) return answer;
      found.push(...answer.value);
    }
    return { ok: true, value: found };
  }

  /**
   * A certificate map entry lives under its map: the maps
   * found by the same prefix, then each one's entries by that prefix.
   */
  private async findMapEntries(
    token: GoogleAccessToken,
    request: FindByNameRequest,
  ): Promise<GoogleAnswer<FoundByName[]>> {
    const maps = await this.findByName(token, {
      ...request,
      resourceType: 'google_certificate_manager_certificate_map',
    });
    if (!maps.ok) return maps;
    const found: FoundByName[] = [];
    for (const map of maps.value) {
      const entries = await listByName(
        token,
        request,
        named(
          () => `${CERTIFICATE_MANAGER_URL}/${map.id}/certificateMapEntries`,
          'certificateMapEntries',
        )(request),
      );
      if (!entries.ok) return entries;
      found.push(...entries.value);
    }
    return { ok: true, value: found };
  }

  async exchangeToken(
    request: TokenExchangeRequest,
  ): Promise<GoogleAnswer<GoogleAccessToken>> {
    const answer = await call<{ access_token: string }>(STS_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        audience: request.audience,
        scope: CLOUD_PLATFORM_SCOPE,
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        subject_token: request.subjectToken,
        subject_token_type: JWT_TOKEN_TYPE,
      }).toString(),
    });
    return answer.ok
      ? { ok: true, value: { accessToken: answer.value.access_token } }
      : answer;
  }

  async impersonate(
    federated: GoogleAccessToken,
    request: ImpersonateRequest,
  ): Promise<GoogleAnswer<GoogleAccessToken>> {
    const answer = await call<{ accessToken: string }>(
      `${IAM_CREDENTIALS_URL}/projects/-/serviceAccounts/${encodeURIComponent(request.serviceAccount)}:generateAccessToken`,
      withJson(federated, 'POST', {
        scope: [CLOUD_PLATFORM_SCOPE],
        lifetime: `${request.lifetimeSeconds}s`,
      }),
    );
    return answer.ok
      ? { ok: true, value: { accessToken: answer.value.accessToken } }
      : answer;
  }

  async getProject(
    token: GoogleAccessToken,
    projectId: string,
  ): Promise<GoogleAnswer<GoogleProject>> {
    const answer = await call<{ projectId: string; projectNumber: string }>(
      `${RESOURCE_MANAGER_URL}/projects/${encodeURIComponent(projectId)}`,
      { method: 'GET', headers: bearer(token) },
    );
    return answer.ok
      ? {
          ok: true,
          value: {
            projectId: answer.value.projectId,
            projectNumber: String(answer.value.projectNumber),
          },
        }
      : answer;
  }

  async testIamPermissions(
    token: GoogleAccessToken,
    projectId: string,
    permissions: readonly string[],
  ): Promise<GoogleAnswer<string[]>> {
    const granted: string[] = [];
    for (let at = 0; at < permissions.length; at += PERMISSIONS_PER_CALL) {
      const answer = await call<{ permissions?: string[] }>(
        `${RESOURCE_MANAGER_URL}/projects/${encodeURIComponent(projectId)}:testIamPermissions`,
        withJson(token, 'POST', {
          permissions: permissions.slice(at, at + PERMISSIONS_PER_CALL),
        }),
      );
      if (!answer.ok) return answer;
      granted.push(...(answer.value.permissions ?? []));
    }
    return { ok: true, value: granted };
  }

  async enabledApis(
    token: GoogleAccessToken,
    projectNumber: string,
  ): Promise<GoogleAnswer<string[]>> {
    const names: string[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        filter: 'state:ENABLED',
        pageSize: '200',
        ...(pageToken ? { pageToken } : {}),
      });
      const answer = await call<{
        services?: { name: string; config?: { name?: string } }[];
        nextPageToken?: string;
      }>(
        `${SERVICE_USAGE_URL}/projects/${encodeURIComponent(projectNumber)}/services?${query.toString()}`,
        { method: 'GET', headers: bearer(token) },
      );
      if (!answer.ok) return answer;
      for (const service of answer.value.services ?? []) {
        names.push(service.config?.name ?? service.name.split('/').pop()!);
      }
      pageToken = answer.value.nextPageToken || undefined;
    } while (pageToken);
    return { ok: true, value: names };
  }

  async listLocations(
    token: GoogleAccessToken,
    projectId: string,
    api: GoogleLocationsApi,
  ): Promise<GoogleAnswer<string[]>> {
    const regions: string[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        pageSize: '500',
        ...(pageToken ? { pageToken } : {}),
      });
      const answer = await call<{
        locations?: { name: string; locationId?: string }[];
        nextPageToken?: string;
      }>(
        `${LOCATIONS_URL[api]}/projects/${encodeURIComponent(projectId)}/locations?${query.toString()}`,
        { method: 'GET', headers: bearer(token) },
      );
      if (!answer.ok) return answer;
      for (const location of answer.value.locations ?? []) {
        regions.push(location.locationId ?? location.name.split('/').pop()!);
      }
      pageToken = answer.value.nextPageToken || undefined;
    } while (pageToken);
    return { ok: true, value: regions };
  }

  async countNetworks(
    token: GoogleAccessToken,
    projectId: string,
  ): Promise<GoogleAnswer<number>> {
    let count = 0;
    let pageToken: string | undefined;
    do {
      // Only the names come back: the count is all the check needs.
      const query = new URLSearchParams({
        maxResults: '500',
        fields: 'items/name,nextPageToken',
        ...(pageToken ? { pageToken } : {}),
      });
      const answer = await call<{
        items?: { name: string }[];
        nextPageToken?: string;
      }>(
        `${COMPUTE_URL}/projects/${encodeURIComponent(projectId)}/global/networks?${query.toString()}`,
        { method: 'GET', headers: bearer(token) },
      );
      if (!answer.ok) return answer;
      count += answer.value?.items?.length ?? 0;
      pageToken = answer.value?.nextPageToken || undefined;
    } while (pageToken);
    return { ok: true, value: count };
  }

  /**
   * An external account's configuration, which reads the run's token from
   * its own file: the runner writes this as `GOOGLE_CREDENTIAL_FILE` in the
   * folder `tofu` and its providers run in, so the one file carries both,
   * and goes with the folder at the run's end (the Google Cloud spec, S16).
   */
  credentialConfiguration(
    request: CredentialConfigurationRequest,
  ): GoogleCredential {
    return {
      credentialConfiguration: JSON.stringify({
        type: 'external_account',
        audience: request.audience,
        subject_token_type: JWT_TOKEN_TYPE,
        token_url: STS_TOKEN_URL,
        service_account_impersonation_url: `${IAM_CREDENTIALS_URL}/projects/-/serviceAccounts/${encodeURIComponent(request.serviceAccount)}:generateAccessToken`,
        credential_source: {
          file: GOOGLE_CREDENTIAL_FILE,
          format: {
            type: 'json',
            subject_token_field_name: SUBJECT_TOKEN_FIELD,
          },
        },
        [SUBJECT_TOKEN_FIELD]: request.subjectToken,
      }),
    };
  }

  async stopComputeInstance(
    token: GoogleAccessToken,
    instance: ComputeInstanceRef,
  ): Promise<GoogleAnswer<true>> {
    const stopped = await call<unknown>(
      `${computeInstanceUrl(instance)}/stop`,
      {
        method: 'POST',
        headers: bearer(token),
      },
    );
    return stopped.ok ? { ok: true, value: true } : stopped;
  }

  async startComputeInstance(
    token: GoogleAccessToken,
    instance: ComputeInstanceRef,
  ): Promise<GoogleAnswer<true>> {
    const started = await call<unknown>(
      `${computeInstanceUrl(instance)}/start`,
      { method: 'POST', headers: bearer(token) },
    );
    return started.ok ? { ok: true, value: true } : started;
  }

  async computeInstanceStatus(
    token: GoogleAccessToken,
    instance: ComputeInstanceRef,
  ): Promise<GoogleAnswer<ComputeInstanceStatus>> {
    const read = await call<{ status?: ComputeInstanceStatus }>(
      computeInstanceUrl(instance),
      { method: 'GET', headers: bearer(token) },
    );
    if (!read.ok) return read;
    if (!read.value.status) {
      return {
        ok: false,
        code: 'UNKNOWN',
        message: 'Compute Engine answered the instance without a status',
      };
    }
    return { ok: true, value: read.value.status };
  }
}

/** A Compute Engine instance's own URL, in its zone. */
function computeInstanceUrl(instance: ComputeInstanceRef): string {
  return `${COMPUTE_URL}/projects/${encodeURIComponent(instance.projectId)}/zones/${encodeURIComponent(instance.zone)}/instances/${encodeURIComponent(instance.name)}`;
}

/** A Cloud Run service as `services.get` answers it: only what Cloudgate changes is named. */
type CloudRunServiceBody = Record<string, unknown> & {
  launchStage?: string;
  scaling?: Record<string, unknown>;
  template?: Record<string, unknown>;
};

/** A Cloud SQL Admin operation, the fields a wait reads. */
interface CloudSqlOperation {
  name?: string;
  status?: string;
  error?: { errors?: { code?: string; message?: string }[] };
  backupContext?: { backupId?: string };
}

/** A Compute Engine global operation, the fields a wait reads. */
interface ComputeOperation {
  name?: string;
  status?: string;
  error?: { errors?: { code?: string; message?: string }[] };
}

/** A google.longrunning operation (Memorystore's), the fields a wait reads. */
interface LongRunningOperation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
}

function cloudSqlInstanceUrl(instance: CloudSqlInstanceRef): string {
  return `${SQL_ADMIN_URL}/projects/${encodeURIComponent(instance.projectId)}/instances/${encodeURIComponent(instance.name)}`;
}

/** An int64 Google sends as a string, or `null`. */
function bytesOf(value: string | number | undefined): number | null {
  const bytes = Number(value);
  return value !== undefined && Number.isFinite(bytes) ? bytes : null;
}

/** google.rpc.Code's name for a long-running operation's numeric error code. */
function statusName(code: number | undefined): string {
  const names: Record<number, string> = {
    3: 'INVALID_ARGUMENT',
    5: 'NOT_FOUND',
    6: 'ALREADY_EXISTS',
    7: 'PERMISSION_DENIED',
    9: 'FAILED_PRECONDITION',
    13: 'INTERNAL',
    14: 'UNAVAILABLE',
  };
  return code === undefined ? 'UNKNOWN' : (names[code] ?? String(code));
}

/** An operation Google answered without a name to read, or never finished. */
function notFinished(
  product: string,
  name: string | undefined,
): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: 'DEADLINE_EXCEEDED',
    message: name
      ? `${product} had not finished operation ${name} when Cloudgate stopped waiting`
      : `${product} answered no operation to wait on`,
  };
}

/**
 * A Cloud Run service, a Worker's worker pool or a Cron service's
 * job, by its fixed name.
 */
function cloudRunUrl(
  collection: 'services' | 'workerPools' | 'jobs',
  ref: CloudRunServiceRef,
): string {
  return `${CLOUD_RUN_URL}/projects/${encodeURIComponent(ref.projectId)}/locations/${encodeURIComponent(ref.region)}/${collection}/${encodeURIComponent(ref.name)}`;
}

function cloudRunServiceUrl(service: CloudRunServiceRef): string {
  return cloudRunUrl('services', service);
}

function workerPoolUrl(pool: CloudRunWorkerPoolRef): string {
  return cloudRunUrl('workerPools', pool);
}

/** One execution of a Cron service's job. */
function executionUrl(execution: CloudRunExecutionRef): string {
  return `${cloudRunUrl('jobs', { ...execution, name: execution.job })}/executions/${encodeURIComponent(execution.execution)}`;
}

/** A revision template with its copy range set (S10), all else kept. */
function withCopies(
  template: Record<string, unknown> | undefined,
  copies: CopyRange,
): Record<string, unknown> {
  return {
    ...template,
    scaling: {
      ...(template?.scaling as Record<string, unknown> | undefined),
      minInstanceCount: copies.min,
      maxInstanceCount: copies.max,
    },
  };
}

/**
 * A Cloud Storage refusal with Google's status in place of its HTTP code,
 * which its JSON API alone gives: 404 `NOT_FOUND`, 403 or 401
 * `PERMISSION_DENIED`.
 */
function storageRefusal(answer: {
  readonly code: string;
  readonly message: string;
}): { ok: false; code: string; message: string } {
  const code =
    answer.code === '404'
      ? NOT_FOUND
      : answer.code === '403' || answer.code === '401'
        ? PERMISSION_DENIED
        : answer.code;
  return { ok: false, code, message: answer.message };
}

/** A Cloud Storage bucket's JSON API address. */
function bucketUrl(bucket: string): string {
  return `${STORAGE_URL}/b/${encodeURIComponent(bucket)}`;
}

/** An object as Cloud Storage's JSON answers it: its size is a string there. */
function storedOf(item: {
  name: string;
  md5Hash?: string;
  size?: string;
}): StoredObject {
  return {
    name: item.name,
    md5Hash: item.md5Hash ?? null,
    size: Number(item.size ?? 0),
  };
}

/** Cloud Build's builds in one region of a project. */
function cloudBuildsUrl(projectId: string, region: string): string {
  return `${CLOUD_BUILD_URL}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/builds`;
}

function cloudBuildUrl(build: CloudBuildRef): string {
  return `${cloudBuildsUrl(build.projectId, build.region)}/${encodeURIComponent(build.buildId)}`;
}

/** Every `Build.status` Cloud Build names; any other reads as unknown. */
const CLOUD_BUILD_STATUSES: readonly CloudBuildStatusName[] = [
  'STATUS_UNKNOWN',
  'PENDING',
  'QUEUED',
  'WORKING',
  'SUCCESS',
  'FAILURE',
  'INTERNAL_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'EXPIRED',
];

function bearer(token: GoogleAccessToken): Record<string, string> {
  return { authorization: `Bearer ${token.accessToken}` };
}

function withJson(
  token: GoogleAccessToken,
  method: string,
  body: unknown,
): RequestInit {
  return {
    method,
    headers: { ...bearer(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * One request: its JSON on a 2xx, Google's refusal otherwise. Google's APIs
 * answer `{ error: { status, message } }`; STS answers OAuth's
 * `{ error, error_description }`.
 */
async function call<T>(
  url: string,
  init: RequestInit,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<GoogleAnswer<T>> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (response.ok) return { ok: true, value: body as T };
  return { ok: false, ...refusalOf(response, body, text) };
}

function refusalOf(
  response: Response,
  body: unknown,
  text: string,
): { code: string; message: string } {
  const error = (body as { error?: unknown } | null)?.error;
  if (error && typeof error === 'object') {
    const { status, message } = error as { status?: string; message?: string };
    return {
      code: status ?? String(response.status),
      message: message ?? response.statusText,
    };
  }
  if (typeof error === 'string') {
    const description = (body as { error_description?: string })
      .error_description;
    return { code: error, message: description ?? error };
  }
  return {
    code: String(response.status),
    message: text.trim() || response.statusText,
  };
}

/** Every page of a list call: its items, or Google's refusal. */
async function everyPage<T>(
  token: GoogleAccessToken,
  url: string,
  items: string,
  query: Record<string, string>,
): Promise<GoogleAnswer<T[]>> {
  const found: T[] = [];
  let pageToken: string | undefined;
  do {
    const search = new URLSearchParams({
      ...query,
      ...(pageToken ? { pageToken } : {}),
    });
    const answer = await call<Record<string, unknown> | null>(
      `${url}?${search.toString()}`,
      { method: 'GET', headers: bearer(token) },
    );
    if (!answer.ok) return answer;
    found.push(...((answer.value?.[items] ?? []) as T[]));
    const next = answer.value?.nextPageToken;
    pageToken = typeof next === 'string' && next ? next : undefined;
  } while (pageToken);
  return { ok: true, value: found };
}

/** Backups newest first; one Google has not dated yet first of all. */
function newestFirst(backups: GoogleDatabaseBackup[]): GoogleDatabaseBackup[] {
  return [...backups].sort((a, b) =>
    (b.createdAt ?? '\uffff').localeCompare(a.createdAt ?? '\uffff'),
  );
}

/** `1.4 MB`, from Google's byte count; `null` for none. */
function bytesText(bytes: string | undefined): string | null {
  const count = Number(bytes);
  if (!bytes || !Number.isFinite(count)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = count;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${Math.round(value * 10) / 10} ${units[unit]}`;
}

/** One item of a list call, the fields a search by name reads. */
interface ListedItem {
  name: string;
  email?: string;
  description?: string;
  labels?: Record<string, string>;
  settings?: { userLabels?: Record<string, string> };
}

/** How one kind is listed: its list call, the field holding its items, its fixed name and its import id. */
interface KindList {
  url: string;
  query: Record<string, string>;
  items: string;
  name: (item: ListedItem) => string;
  id: (item: ListedItem, request: FindByNameRequest) => string;
}

/** The last part of a full resource name: the fixed name Cloudgate gave it. */
const lastPart = (item: ListedItem) => item.name.split('/').pop() ?? item.name;

/**
 * A Compute list, global, regional or zonal, filtered by name on Google's
 * side. A zonal one is a Stack VM's, in its region's zone (`stackVmZone`).
 */
function compute(scope: 'global' | 'regional' | 'zonal', collection: string) {
  return (request: FindByNameRequest): KindList => {
    const where = (region: string) =>
      scope === 'global'
        ? 'global'
        : scope === 'regional'
          ? `regions/${region}`
          : `zones/${stackVmZone(region)}`;
    return {
      url: `${COMPUTE_URL}/projects/${encodeURIComponent(request.projectId)}/${where(encodeURIComponent(request.region))}/${collection}`,
      query: { maxResults: '500', filter: `name eq "${request.namePrefix}.*"` },
      items: 'items',
      name: (item) => item.name,
      id: (item, { projectId, region }) =>
        `projects/${projectId}/${where(region)}/${collection}/${item.name}`,
    };
  };
}

/** A list whose items carry their full resource name as `name`. */
function named(url: (request: FindByNameRequest) => string, items: string) {
  return (request: FindByNameRequest): KindList => ({
    url: url(request),
    query: { pageSize: '500' },
    items,
    name: lastPart,
    id: (item) => item.name,
  });
}

/** One kind's list call, through every page, keeping what starts with the prefix. */
async function listByName(
  token: GoogleAccessToken,
  request: FindByNameRequest,
  list: KindList,
): Promise<GoogleAnswer<FoundByName[]>> {
  const found: FoundByName[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      ...list.query,
      ...(pageToken ? { pageToken } : {}),
    });
    const answer = await call<Record<string, unknown> | null>(
      `${list.url}?${query.toString()}`,
      { method: 'GET', headers: bearer(token) },
    );
    if (!answer.ok) return answer;
    const items = (answer.value?.[list.items] ?? []) as ListedItem[];
    for (const item of items) {
      const name = list.name(item);
      if (!name.startsWith(request.namePrefix)) continue;
      found.push({
        resourceType: request.resourceType,
        name,
        id: list.id(item, request),
        ...(typeof item.description === 'string'
          ? { description: item.description }
          : {}),
        ...(item.labels ? { labels: item.labels } : {}),
        // A Cloud SQL instance keeps its labels in its settings.
        ...(item.settings?.userLabels
          ? { labels: item.settings.userLabels }
          : {}),
      });
    }
    const next = answer.value?.nextPageToken;
    pageToken = typeof next === 'string' && next ? next : undefined;
  } while (pageToken);
  return { ok: true, value: found };
}

/** A certificate map entry: listed under its map, not by a list of its own. */
const MAP_ENTRY = 'google_certificate_manager_certificate_map_entry';

/**
 * The list call of each kind the network and web definitions make (the Google
 * Cloud spec, "Google client port"): one per kind, by Cloudgate's name prefix
 * (a service account by its email). A certificate map entry
 * lives under its map: under the map the request names as `parent`,
 * or else under each map found by the same prefix ({@link MAP_ENTRY});
 * slice 7 adds its own kinds here.
 */
const LISTS: Readonly<
  Record<string, (request: FindByNameRequest) => KindList | null>
> = {
  google_compute_network: compute('global', 'networks'),
  google_compute_subnetwork: compute('regional', 'subnetworks'),
  google_compute_global_address: compute('global', 'addresses'),
  google_compute_global_forwarding_rule: compute('global', 'forwardingRules'),
  google_compute_target_https_proxy: compute('global', 'targetHttpsProxies'),
  google_compute_target_http_proxy: compute('global', 'targetHttpProxies'),
  google_compute_url_map: compute('global', 'urlMaps'),
  google_compute_backend_service: compute('global', 'backendServices'),
  // A static site's Cloud CDN backend bucket.
  google_compute_backend_bucket: compute('global', 'backendBuckets'),
  // Memorystore's link opens Redis's ports.
  google_compute_firewall: compute('global', 'firewalls'),
  google_compute_region_network_endpoint_group: compute(
    'regional',
    'networkEndpointGroups',
  ),
  // A Compose stack's Stack VM, its data disk and snapshot schedule,
  // and the network's Cloud Router its Cloud NAT is on.
  google_compute_instance: compute('zonal', 'instances'),
  google_compute_disk: compute('zonal', 'disks'),
  google_compute_resource_policy: compute('regional', 'resourcePolicies'),
  google_compute_router: compute('regional', 'routers'),
  // An Existing database's manual endpoint, its address and rule.
  google_compute_address: compute('regional', 'addresses'),
  google_compute_forwarding_rule: compute('regional', 'forwardingRules'),
  // Its private DNS zone, listed with its short name.
  google_dns_managed_zone: (request) => ({
    url: `${DNS_URL}/projects/${encodeURIComponent(request.projectId)}/managedZones`,
    query: { maxResults: '500' },
    items: 'managedZones',
    name: (item) => item.name,
    id: (item, { projectId }) =>
      `projects/${projectId}/managedZones/${item.name}`,
  }),
  google_artifact_registry_repository: named(
    ({ projectId, region }) =>
      `${ARTIFACT_REGISTRY_URL}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/repositories`,
    'repositories',
  ),
  google_cloud_run_v2_service: named(
    ({ projectId, region }) =>
      `${CLOUD_RUN_URL}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/services`,
    'services',
  ),
  // A Worker's worker pool.
  google_cloud_run_v2_worker_pool: named(
    ({ projectId, region }) =>
      `${CLOUD_RUN_URL}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/workerPools`,
    'workerPools',
  ),
  // A Cron service's job.
  google_cloud_run_v2_job: named(
    ({ projectId, region }) =>
      `${CLOUD_RUN_URL}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/jobs`,
    'jobs',
  ),
  google_secret_manager_secret: named(
    ({ projectId }) =>
      `${SECRET_MANAGER_URL}/projects/${encodeURIComponent(projectId)}/secrets`,
    'secrets',
  ),
  google_certificate_manager_certificate_map: named(
    ({ projectId }) =>
      `${CERTIFICATE_MANAGER_URL}/projects/${encodeURIComponent(projectId)}/locations/global/certificateMaps`,
    'certificateMaps',
  ),
  google_certificate_manager_dns_authorization: named(
    ({ projectId }) =>
      `${CERTIFICATE_MANAGER_URL}/projects/${encodeURIComponent(projectId)}/locations/global/dnsAuthorizations`,
    'dnsAuthorizations',
  ),
  // A map entry lives under its certificate map, named as `parent`.
  google_certificate_manager_certificate_map_entry: (request) =>
    request.parent
      ? named(
          ({ projectId }) =>
            `${CERTIFICATE_MANAGER_URL}/projects/${encodeURIComponent(projectId)}/locations/global/certificateMaps/${encodeURIComponent(request.parent ?? '')}/certificateMapEntries`,
          'certificateMapEntries',
        )(request)
      : null,
  google_certificate_manager_certificate: named(
    ({ projectId }) =>
      `${CERTIFICATE_MANAGER_URL}/projects/${encodeURIComponent(projectId)}/locations/global/certificates`,
    'certificates',
  ),
  google_network_connectivity_service_connection_policy: named(
    ({ projectId, region }) =>
      `${NETWORK_CONNECTIVITY_URL}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/serviceConnectionPolicies`,
    'serviceConnectionPolicies',
  ),
  // A Cloud SQL instance is listed by its short name.
  google_sql_database_instance: (request) => ({
    url: `${SQL_ADMIN_URL}/projects/${encodeURIComponent(request.projectId)}/instances`,
    query: { maxResults: '500' },
    items: 'items',
    name: (item) => item.name,
    id: (item, { projectId }) => `projects/${projectId}/instances/${item.name}`,
  }),
  // A Memorystore instance, with its labels.
  google_memorystore_instance: named(
    ({ projectId, region }) =>
      `${MEMORYSTORE_URL}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/instances`,
    'instances',
  ),
  // A Cloud Storage bucket, by its name's prefix on Google's side;
  // a bucket's own name is the id OpenTofu imports it by.
  google_storage_bucket: (request) => ({
    url: `${STORAGE_URL}/b`,
    query: {
      project: request.projectId,
      prefix: request.namePrefix,
      maxResults: '500',
    },
    items: 'items',
    name: (item) => item.name,
    id: (item) => item.name,
  }),
  // A service account's fixed name is its account id, its email's first part.
  google_service_account: (request) => ({
    url: `${IAM_URL}/projects/${encodeURIComponent(request.projectId)}/serviceAccounts`,
    query: { pageSize: '100' },
    items: 'accounts',
    name: (item) => (item.email ?? lastPart(item)).split('@')[0],
    id: (item) => item.name,
  }),
};

/** How one labelled kind is listed by label in every region: its list call and how its page reads. */
interface LabelList {
  readonly url: string;
  readonly filter: string;
  readonly found: (page: Record<string, unknown>) => FoundByLabel[];
}

/** One item of a list by label, the fields the search reads. */
interface LabelledItem {
  name: string;
  region?: string;
  labels?: Record<string, string>;
  settings?: { userLabels?: Record<string, string> };
}

/**
 * A Compute kind's aggregated list, which answers each region's items and
 * the global ones under their scope, `regions/<region>` or `global`.
 */
function computeByLabel(collection: string, type: string) {
  return ({ projectId, label }: FindByLabelRequest): LabelList => ({
    url: `${COMPUTE_URL}/projects/${encodeURIComponent(projectId)}/aggregated/${collection}`,
    filter: `labels.${label.key} = "${label.value}"`,
    found: (page) =>
      Object.entries(
        (page.items ?? {}) as Record<string, Record<string, unknown>>,
      ).flatMap(([scope, held]) =>
        ((held[collection] ?? []) as LabelledItem[]).map((item) => ({
          type,
          id: `projects/${projectId}/${scope}/${collection}/${item.name}`,
          region: scope === 'global' ? 'global' : lastPart({ name: scope }),
          labels: item.labels ?? {},
        })),
      ),
  });
}

/**
 * The labelled kinds the label search lists (the Google Cloud databases spec): what an
 * Environment's databases and private link can leave billing in a project
 * — an address or a forwarding rule (a Private Service Connect address
 * Google still lists as `CLOSED`), a Cloud SQL instance, whose labels are
 * in its settings, and a Memorystore instance, in every location (`-`).
 */
const LABELLED_KINDS: readonly ((request: FindByLabelRequest) => LabelList)[] =
  [
    computeByLabel('addresses', 'compute.googleapis.com/Address'),
    computeByLabel('forwardingRules', 'compute.googleapis.com/ForwardingRule'),
    ({ projectId, label }) => ({
      url: `${SQL_ADMIN_URL}/projects/${encodeURIComponent(projectId)}/instances`,
      filter: `settings.userLabels.${label.key}:${label.value}`,
      found: (page) =>
        ((page.items ?? []) as LabelledItem[]).map((item) => ({
          type: 'sqladmin.googleapis.com/Instance',
          id: `projects/${projectId}/instances/${item.name}`,
          region: item.region ?? 'global',
          labels: item.settings?.userLabels ?? {},
        })),
    }),
    ({ projectId, label }) => ({
      url: `${MEMORYSTORE_URL}/projects/${encodeURIComponent(projectId)}/locations/-/instances`,
      filter: `labels.${label.key}="${label.value}"`,
      found: (page) =>
        ((page.instances ?? []) as LabelledItem[]).map((item) => ({
          type: 'memorystore.googleapis.com/Instance',
          id: item.name,
          // `projects/<id>/locations/<region>/instances/<name>`.
          region: item.name.split('/')[3] ?? 'global',
          labels: item.labels ?? {},
        })),
    }),
  ];

/** One kind's list by label, through every page. */
async function listByLabel(
  token: GoogleAccessToken,
  list: LabelList,
): Promise<GoogleAnswer<FoundByLabel[]>> {
  const found: FoundByLabel[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      filter: list.filter,
      ...(pageToken ? { pageToken } : {}),
    });
    const answer = await call<Record<string, unknown> | null>(
      `${list.url}?${query.toString()}`,
      { method: 'GET', headers: bearer(token) },
    );
    if (!answer.ok) return answer;
    found.push(...list.found(answer.value ?? {}));
    const next = answer.value?.nextPageToken;
    pageToken = typeof next === 'string' && next ? next : undefined;
  } while (pageToken);
  return { ok: true, value: found };
}
