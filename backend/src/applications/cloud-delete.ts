import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { quote } from 'shell-quote';

import { destroyDefinition } from '../cloud-accounts/aws/definitions/destroy-definition';
import { STATIC_SERVING_ADDRESSES } from '../cloud-accounts/aws/definitions/static-definition';
import { TAG_KEYS } from '../cloud-accounts/aws/definitions/tags';
import {
  deleteReportLines,
  findLeftovers,
  heldByState,
} from '../cloud-accounts/aws/delete-check';
import type { Leftover } from '../cloud-accounts/aws/delete-check';
import type { CloudKind } from '../cloud-accounts/cloud-account.schema';
import {
  byCloud,
  CLOUD_NAMES,
  cloudOrLegacy,
  onCloud,
} from '../cloud-accounts/cloud-provider';
import type { AwsCloudAccount } from '../cloud-accounts/cloud-provider';
import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import { credentialOf } from '../cloud-accounts/cloud-provider';
import { AWS_CLOUD_PORT, CHANGED_NOTHING } from '../cloud-accounts/cloud.port';
import type {
  AwsCloudPort,
  AwsCredential,
  TofuFailure,
  TofuShow,
} from '../cloud-accounts/cloud.port';
import { InfrastructureStatesService } from '../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { ownerOnlyDirectoryCommand } from '../common/files/owner-only';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { application, deployment } from '../db/schema';
import type { Deployment } from '../db/schema';
import { deploymentLogsDirectoryOn } from '../deployment-engine/deployment-engine.paths';
import { parentColumns } from '../deployment-engine/ports/deployment-recorder';
import { CloudReadWorks } from '../deployment-queue/cloud-read-work';
import type {
  CloudRunControl,
  CloudRunJob,
} from '../deployment-queue/cloud-run-job.types';
import {
  CloudRunsService,
  endingDescription,
} from '../deployment-queue/cloud-runs.service';
import { AuditLogService } from '../enterprise/audit-logs/audit-log.service';
import { OBJECT_STORAGE } from '../object-storage/object-storage.port';
import type {
  EmptyOutcome,
  ObjectStoragePort,
} from '../object-storage/object-storage.port';
import { writeKept } from '../project-config/console-saves';
import type { KeepConfig } from '../project-config/console-saves';
import type { PermissionCtx } from '../rbac/permission.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import { NothingRemoved } from '../common/nothing-removed';
import type {
  ServiceCloudDeleteRecord,
  ServiceLeftover,
} from './application.schema';
import {
  stillInUseLine,
  tryDeletion,
  waitingOf,
} from '../domains/certificate-deletions';
import { CLOUD_DELETE_REFUSED_CODE } from './cloud-delete-refusal';
import { GoogleServiceDeleteSteps } from './google-service-delete';
import type { GoogleDeleteOutcome } from './google-service-delete';

/**
 * The platform-host reclamations of a Server's Delete that apply to a cloud
 * Service (ADR-0018), and the row dropped; answers what it could not reclaim.
 */
export type DropCloudService = (
  applicationId: string,
) => Promise<Record<string, unknown>>;

/** Forget's warning, which the console shows before it is pressed. */
export const FORGET_WARNING =
  'Forget drops this Service from Cloudgate and keeps no record of what is left but the audit log. What is left may still bill you in AWS until you remove it there.';

/** {@link FORGET_WARNING}, for a Service on Google Cloud. */
export const GOOGLE_FORGET_WARNING =
  'Forget drops this Service from Cloudgate and keeps no record of what is left but the audit log. What is left may still bill you in Google Cloud until you remove it there.';

/** What a cloud Service's Delete reads off its row. */
export interface CloudDeleteTarget {
  readonly applicationId: string;
  readonly appName: string;
  /** Its display name, for the audit entry and the log. */
  readonly name: string;
  readonly configName: string | null;
  readonly environmentId: string;
  readonly cloudAccountId: string;
  readonly region: string;
  readonly cloudDelete: ServiceCloudDeleteRecord | null;
  /**
   * A `static` site's own S3 bucket, which its Delete empties first
   * and never keeps; absent or `null` for any other Service.
   */
  readonly cloudBucketName?: string | null;
}

/**
 * **A cloud Service's Delete** (spec "Delete", ADR-0038): a
 * Cloud run that only destroys, recorded as a Deployment of the Service,
 * queued and locked like a deploy and, once it applies, never cancelled.
 *
 * 1. The request checks the Cloud account can be reached (a Delete that
 *    cannot reach it fails and removes nothing), records the Deployment,
 *    marks the row `deleting` (the Service reads "Deleting") and hands the
 *    run to the pool.
 * 2. The run destroys everything in the Service's Infrastructure state —
 *    the ECS service, listener rule, target group, security group,
 *    certificates, log group, SSM parameters, task role, and the ECR
 *    repository with every image (`force_delete`). `DependencyViolation`
 *    is the AWS provider's to retry, up to its own timeouts.
 *    A `static` site's own bucket is emptied first, old versions and
 *    delete markers included, through the object-storage port: it
 *    is a rebuildable copy of the site's build, so it is never kept and no Delete asks
 *    about its files. An emptying that stops partway destroys only what serves the site,
 *    and the bucket, with its
 *    settings and what is left of its files, is *Left*, "partly emptied".
 * 3. Then it checks: a tag search by the state's tag, and by id what a tag
 *    search cannot find (the task role, AWS-made network cards).
 * 4. A clean finish removes the state, reclaims the build cache and source
 *    tree on the platform host as a Server's Delete does (ADR-0018), drops
 *    the row and its Deployments, and records the Delete in the audit log.
 *    Anything left — or a run that did not finish, the time limit's
 *    included — keeps the row `incomplete` with the list and the state,
 *    until Retry (another run) or Forget (the row dropped, the list written
 *    into the audit entry).
 *
 * What a run does is read from its Deployment and the row, so a run that
 * start-up queues again runs alike.
 *
 * **On Google Cloud** the run is {@link GoogleServiceDeleteSteps}:
 * a network step that removes the Service's Domains from the Environment
 * network first, so the run waits as one that touches the network; then
 * the destroy; then a search by name. A `static` site's bucket is emptied
 * between the network step and the destroy, and left "partly emptied" as
 * on AWS when that stops partway. Retry always starts again from
 * the network step.
 */
/** What a Service's Delete runs on its cloud, and how its Deployment says it. */
interface DeleteSteps {
  /** Its Environment's Delete already took its Domains off the network. */
  readonly networkStepDone: boolean;
  /** Its run takes the Environment network's lock. */
  readonly touchesNetwork: boolean;
  readonly description: string;
}

@Injectable()
export class CloudServiceDeletes implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    @Inject(OBJECT_STORAGE) private readonly objectStorage: ObjectStoragePort,
    private readonly googleSteps: GoogleServiceDeleteSteps,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly remoteExec: RemoteExecService,
    private readonly auditLogs: AuditLogService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** The pool lives in the queue module, which imports this one. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  /**
   * `ApplicationsService.dropCloudService`, which injects this service and
   * binds it here ({@link dropWith}) rather than the two injecting each other.
   */
  private dropService: DropCloudService | null = null;

  dropWith(drop: DropCloudService): void {
    this.dropService = drop;
  }

  private drop(applicationId: string): Promise<Record<string, unknown>> {
    if (!this.dropService) {
      throw new Error('Nothing drops a cloud Service row yet');
    }
    return this.dropService(applicationId);
  }

  onModuleInit(): void {
    this.moduleRef
      .get(CloudReadWorks, { strict: false })
      .handle('destroy', (job, control) => this.run(job, control));
  }

  /**
   * The Delete (or, `retrying`, its Retry): refused while one runs, and a
   * first Delete refused once incomplete, which only Retry or Forget end.
   * Answers the row, marked `deleting`.
   */
  async request(
    ctx: PermissionCtx,
    target: CloudDeleteTarget,
    keep: KeepConfig,
    retrying: boolean,
  ) {
    return (await this.start(ctx, target, keep, retrying)).row;
  }

  /**
   * {@link request}, with when its run ended and its row was written: what an
   * Environment's Delete waits on before it removes the Environment network.
   * On Google Cloud, `networkStepDone` is an Environment's Delete
   * that took every Domain off the network itself first: the run
   * skips its network step, and so does not wait as one touching it.
   */
  async start(
    ctx: PermissionCtx,
    target: CloudDeleteTarget,
    keep: KeepConfig,
    retrying: boolean,
    options: { readonly networkStepDone?: boolean } = {},
  ): Promise<{
    row: typeof application.$inferSelect | undefined;
    ended: Promise<void>;
  }> {
    const record = await this.settled(target);
    if (record?.status === 'deleting') {
      throw refused(`${target.name} is already being deleted`);
    }
    if (!retrying && record?.status === 'incomplete') {
      throw refused(
        `${target.name} is Delete incomplete: Retry the Delete, or Forget it`,
      );
    }
    if (retrying && record?.status !== 'incomplete') {
      throw refused(
        `${target.name} has no Delete to retry: Retry is for a Service whose Delete is incomplete`,
      );
    }

    // A Delete whose Cloud account cannot be reached fails and removes
    // nothing: asked here, before a Deployment exists.
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      target.cloudAccountId,
    );
    if (!cloudAccountRow) {
      throw refused(
        'The Cloud account this Service runs in is gone. Nothing was removed',
      );
    }
    const signInRefusal =
      await this.cloudAccounts.signInRefusal(cloudAccountRow);
    if (signInRefusal !== null) {
      throw refused(`${signInRefusal}. Nothing was removed`);
    }
    // What its cloud's Delete runs (ADR-0043). On AWS: its bucket emptied,
    // then its state destroyed. On Google Cloud a run of the Environment
    // network first takes its Domains off, unless its Environment's Delete
    // has run that for every Service; then its state is destroyed and Google
    // Cloud searched for anything left.
    const { networkStepDone, touchesNetwork, description } = byCloud<
      () => DeleteSteps
    >(cloudAccountRow.cloud, {
      aws: () => ({
        networkStepDone: false,
        touchesNetwork: false,
        description: `${target.cloudBucketName ? `Empties its S3 bucket ${target.cloudBucketName}, then destroys` : 'Destroys'} everything in the Service's Infrastructure state in ${target.region}`,
      }),
      gcp: () => {
        const done = options.networkStepDone === true;
        // A static site's own bucket is emptied between the two.
        const destroys = `${target.cloudBucketName ? `empties its Cloud Storage bucket ${target.cloudBucketName}, then destroys` : 'destroys'} everything in the Service's Infrastructure state in ${target.region}`;
        return {
          networkStepDone: done,
          touchesNetwork: !done,
          description: done
            ? `${destroys[0].toUpperCase()}${destroys.slice(1)}, its Environment's Delete having taken its Domains off the Environment network, then searches Google Cloud for anything left`
            : `Removes its Domains from the Environment network, then ${destroys}, then searches Google Cloud for anything left`,
        };
      },
    })();
    const run = await this.record(target, retrying, description);
    let row: typeof application.$inferSelect | undefined;
    try {
      row = await writeKept(
        this.db,
        keep,
        async (db) => {
          const [written] = await db
            .update(application)
            .set({
              cloudDelete: {
                status: 'deleting',
                deploymentId: run.deploymentId,
                retrying,
                requestedBy: {
                  userId: ctx.user.id,
                  organizationId: ctx.session.activeOrganizationId,
                },
                kept: [],
                left: record?.left ?? [],
                unfinished: null,
                ...(networkStepDone ? { networkStepDone } : {}),
              },
            })
            .where(eq(application.applicationId, target.applicationId))
            .returning();
          return written;
        },
        (written) =>
          written ? { serviceId: target.applicationId, removed: {} } : null,
      );
    } catch (error) {
      await this.db
        .delete(deployment)
        .where(eq(deployment.deploymentId, run.deploymentId));
      throw error;
    }

    const ended = this.cloudRuns
      .submit(run.deploymentId, {
        kind: 'destroy',
        stateKey: `application:${target.applicationId}`,
        environmentId: target.environmentId,
        touchesNetwork,
      })
      .then(async (ending) => {
        if (ending.kind === 'shutdown' && !ending.started) return;
        // Cancelled before it destroyed anything: nothing changed, so the
        // Service is as it was. Any other ending its run did not record
        // (one that never reached it) leaves the Delete incomplete.
        await this.endedOutside(
          target.applicationId,
          run.deploymentId,
          ending.kind === 'cancelled'
            ? null
            : (endingDescription(ending) ?? 'The Delete ended'),
        );
      })
      .catch(() => undefined);
    return { row, ended };
  }

  /**
   * An incomplete Delete forgotten as part of its Environment's Forget
   * the state and the row dropped, answering what was left, which
   * the Environment's own audit entry records.
   */
  async discard(target: CloudDeleteTarget): Promise<ServiceLeftover[]> {
    const record = await this.settled(target);
    const state = await this.states.findForApplication(target.applicationId);
    if (state) await this.states.remove(state.infrastructureStateId);
    await this.drop(target.applicationId);
    return [...(record?.left ?? [])];
  }

  /** {@link settled}, for an Environment's Delete reading its Services. */
  settledRecord(
    target: CloudDeleteTarget,
  ): Promise<ServiceCloudDeleteRecord | null> {
    return this.settled(target);
  }

  /**
   * Forget: the row dropped with what is left still in AWS or Google Cloud,
   * after the console's warning ({@link FORGET_WARNING},
   * {@link GOOGLE_FORGET_WARNING}), the list written into the audit entry,
   * where it outlives the row (ADR-0038).
   */
  async forget(ctx: PermissionCtx, target: CloudDeleteTarget) {
    const record = await this.settled(target);
    if (record?.status !== 'incomplete') {
      throw refused(
        record?.status === 'deleting'
          ? `${target.name} is being deleted; Forget is for a Delete that is incomplete`
          : `${target.name} has no incomplete Delete to forget`,
      );
    }
    // Cut off by a restart, the run never checked what is left: its list is
    // the previous one, empty on a first Delete, while the state may still
    // describe what bills. Retry lists it, and Forget then records it.
    if (target.cloudDelete?.status === 'deleting') {
      throw refused(
        `${target.name}'s Delete was cut off before it checked what is left in ${CLOUD_NAMES[await this.cloudOf(target)]}, so Forget would record nothing of it. Retry it first`,
      );
    }
    const state = await this.states.findForApplication(target.applicationId);
    if (state) await this.states.remove(state.infrastructureStateId);
    const leftBehind = await this.drop(target.applicationId);
    await this.auditLogs.audit(
      { userId: ctx.user.id, organizationId: ctx.session.activeOrganizationId },
      {
        action: 'delete',
        resourceType: 'application',
        resourceId: target.applicationId,
        resourceName: target.name,
        metadata: {
          cloudDelete: 'forgotten',
          left: record.left,
          ...(record.unfinished ? { unfinished: record.unfinished } : {}),
          ...leftBehind,
        },
      },
    );
    return { applicationId: target.applicationId, forgotten: record.left };
  }

  /**
   * The record as it stands. A `deleting` whose run is no longer queued or
   * running was cut off by a restart: it reads as incomplete, so Retry and
   * Forget reach it (a cut-off run is never run again by itself).
   */
  private async settled(
    target: CloudDeleteTarget,
  ): Promise<ServiceCloudDeleteRecord | null> {
    const record = target.cloudDelete;
    if (record?.status !== 'deleting') return record;
    const [run] = await this.db
      .select({ status: deployment.status })
      .from(deployment)
      .where(eq(deployment.deploymentId, record.deploymentId));
    if (run && (run.status === 'pending' || run.status === 'running')) {
      return record;
    }
    return {
      ...record,
      status: 'incomplete',
      unfinished:
        record.unfinished ?? 'The Delete was cut off before it finished',
    };
  }

  /** The Delete's Deployment, `pending`, its log on the platform host. */
  private async record(
    target: CloudDeleteTarget,
    retrying: boolean,
    description: string,
  ): Promise<Deployment> {
    const deploymentId = nanoid();
    const logPath = `${deploymentLogsDirectoryOn(null, target.appName)}/${deploymentId}.log`;
    const directory = logPath.slice(0, logPath.lastIndexOf('/'));
    await this.remoteExec.execAsync(
      `${ownerOnlyDirectoryCommand(directory)}; echo "Initializing deployment" >> ${quote([logPath])};`,
    );
    const [row] = await this.db
      .insert(deployment)
      .values({
        deploymentId,
        ...parentColumns({
          kind: 'application',
          applicationId: target.applicationId,
        }),
        title: retrying ? 'Retry Delete' : 'Delete',
        description,
        status: 'pending',
        logPath,
      })
      .returning();
    return row;
  }

  /** The run, as the pool runs it. */
  private async run(job: CloudRunJob, control: CloudRunControl) {
    const [row] = await this.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, job.deploymentId ?? ''));
    if (!row?.applicationId) {
      throw new Error('This Cloud run records no Service');
    }
    const [app] = await this.db
      .select()
      .from(application)
      .where(eq(application.applicationId, row.applicationId));
    const record = app?.cloudDelete;
    if (!app?.cloudAccountId || !app.region || !record) {
      throw new Error('This Service has no Delete under way');
    }
    const log = (line: string) => this.cloudRuns.appendLog(row.logPath, line);
    try {
      await this.destroy(
        {
          ...app,
          cloudAccountId: app.cloudAccountId,
          region: app.region,
          cloudDelete: record,
        },
        control,
        log,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof NothingRemoved) {
        await log(`❌ [Cloud run] ${message}`);
        await this.revert(app.applicationId, record, message);
      }
      throw error;
    }
  }

  /**
   * One try at each certificate the Service's state let go of;
   * answers every one tried. One ACM still holds the Domain poller deletes
   * later, and one just deleted the tag index may list for some minutes.
   */
  private async deleteWaiting(
    session: AwsCredential,
    stateId: string,
    log: (line: string) => Promise<void>,
  ): Promise<Set<string>> {
    const held = new Set<string>();
    for (const row of await waitingOf(this.db, stateId)) {
      const tried = await tryDeletion(this.db, this.cloud, session, row);
      const host = row.host ?? row.certificateArn;
      held.add(row.certificateArn);
      await log(
        tried === 'deleted' || tried === 'gone'
          ? `🔐 The certificate of ${host} is deleted from ACM`
          : stillInUseLine(host),
      );
    }
    return held;
  }

  private async destroy(
    app: CloudDeleteTarget,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      app.cloudAccountId,
    );
    if (!cloudAccountRow) {
      throw new NothingRemoved(
        'The Cloud account this Service runs in is gone. Nothing was removed',
      );
    }
    // Each cloud's half (ADR-0043).
    await onCloud(cloudAccountRow, {
      aws: (account) => this.destroyOnAws(app, account, control, log),
      gcp: async (account) =>
        this.destroyOnGoogle(
          app,
          await this.googleSteps.run(
            {
              ...app,
              networkStepDone: app.cloudDelete?.networkStepDone === true,
              siteBucket: app.cloudBucketName ?? null,
            },
            account,
            control,
            log,
          ),
          log,
        ),
    });
  }

  /** The Service's Delete on AWS: its bucket emptied, its state destroyed, then what is left looked for. */
  private async destroyOnAws(
    app: CloudDeleteTarget,
    account: AwsCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const reached = await this.cloudAccounts.deployRoleSession(account);
    if (!reached.ok) {
      throw new NothingRemoved(`${reached.refusal}. Nothing was removed`);
    }
    const state = await this.states.findForApplication(app.applicationId);

    // A static site's own bucket, emptied before anything is destroyed:
    // S3 destroys only an empty bucket. One whose emptying stopped partway
    // is left with its settings, and only what serves the site goes.
    const siteBucket = state ? (app.cloudBucketName ?? null) : null;
    let partlyEmptied = false;
    if (siteBucket) {
      await log(
        `🧹 [Cloud run] Emptying ${siteBucket}, the site's own bucket: every object, old version and delete marker`,
      );
      const emptied = await this.empty(siteBucket, app.region, reached.session);
      if (emptied.ok) {
        await log(`${siteBucket} is empty`);
      } else {
        partlyEmptied = true;
        await log(
          `⚠️ [Cloud run] Emptying ${siteBucket} stopped partway: ${emptied.message}. The bucket is kept as it is; what serves the site is destroyed`,
        );
      }
    }

    let show: TofuShow | null = null;
    let unfinished: string | null = null;
    if (state) {
      await log(
        `🗑️ [Cloud run] Deleting ${app.name} from Cloud account ${account.name} in ${app.region}: destroying ${partlyEmptied ? 'everything but its bucket' : 'everything'} in Infrastructure state ${state.infrastructureStateId}`,
      );
      let began = false;
      const outcome = await this.states.destroy({
        stateId: state.infrastructureStateId,
        credential: credentialOf(account),
        definition: destroyDefinition(accessOf(account), app.region, {
          cloudAccountId: account.cloudAccountId,
          environmentId: app.environmentId,
          stateId: state.infrastructureStateId,
        }),
        ...(partlyEmptied ? { targets: [...STATIC_SERVING_ADDRESSES] } : {}),
        onLine: (line) => void log(line),
        signal: control.signal,
        beforeApply: () => {
          if (control.beginApply()) {
            began = true;
            return null;
          }
          return ENDED_BEFORE_DESTROYING;
        },
      });
      if (outcome.ok) {
        show = outcome.show;
      } else if (CHANGED_NOTHING.has(outcome.reason)) {
        throw new NothingRemoved(`${outcome.message} Nothing was removed`);
      } else {
        unfinished = began
          ? outcome.message
          : `${outcome.message} The run ended before it destroyed anything`;
      }
    } else {
      await log(
        `🗑️ [Cloud run] ${app.name} has no Infrastructure state: nothing was made for it in AWS`,
      );
    }

    // The check afterwards, with a fresh session: a destroy may outlast one.
    let left: Leftover[] = [];
    let waiting = new Set<string>();
    if (control.signal.killed) {
      unfinished ??= 'The run was killed before it could check what is left';
    } else {
      await log('🔎 [Cloud run] Checking AWS for anything left');
      const session = await this.cloudAccounts.deployRoleSession(account);
      // A removed Domain's certificate the state let go of is being
      // deleted, not left: tried once more now nothing serves it, and
      // deleted by the Domain poller once ACM lets go.
      if (state && session.ok) {
        waiting = await this.deleteWaiting(
          session.session,
          state.infrastructureStateId,
          log,
        );
      }
      const held = heldByState(show);
      const check = !session.ok
        ? { ok: false as const, message: session.refusal }
        : state
          ? await findLeftovers(this.cloud, session.session, {
              region: app.region,
              stateId: state.infrastructureStateId,
              iamRoleNames: [
                ...held.iamRoleNames,
                `cloudgate-${app.applicationId}`,
              ],
              securityGroupIds: held.securityGroupIds,
            })
          : { ok: true as const, left: [] };
      if (check.ok) left = check.left.filter((one) => !waiting.has(one.awsId));
      else unfinished ??= `What is left could not be checked: ${check.message}`;
    }
    // Left on purpose, whatever a check found: it still holds files.
    if (siteBucket && partlyEmptied && state) {
      const arn = `arn:aws:s3:::${siteBucket}`;
      left = [
        ...left.filter((one) => one.awsId !== arn),
        {
          type: 's3',
          awsId: arn,
          region: app.region,
          tag: `${TAG_KEYS.state}=${state.infrastructureStateId}`,
          because: 'partly-emptied',
        },
      ];
    }

    for (const line of deleteReportLines({ kept: [], left })) await log(line);
    if (unfinished === null && left.length === 0) {
      if (state) await this.states.remove(state.infrastructureStateId);
      await this.finish(app);
      return;
    }
    await this.db
      .update(application)
      .set({
        cloudDelete: {
          ...app.cloudDelete!,
          status: 'incomplete',
          left,
          unfinished,
        },
      })
      .where(eq(application.applicationId, app.applicationId));
    const summary = `Delete incomplete: ${
      left.length > 0
        ? `${left.length} resource${left.length === 1 ? ' is' : 's are'} left in AWS`
        : unfinished
    }. ${partlyEmptied ? `Retry empties ${siteBucket} again, then destroys it` : 'Retry destroys again from the kept state'}`;
    await log(`⚠️ [Cloud run] ${summary}`);
    throw new Error(summary);
  }

  /** What the Google steps ended with, written as the AWS run writes its own. */
  private async destroyOnGoogle(
    app: CloudDeleteTarget,
    outcome: GoogleDeleteOutcome,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    if (outcome.kind === 'nothing-removed') {
      throw new NothingRemoved(outcome.message);
    }
    if (outcome.kind === 'clean') {
      if (outcome.stateId) await this.states.remove(outcome.stateId);
      await this.finish(app);
      return;
    }
    const { left, unfinished } = outcome;
    await this.db
      .update(application)
      .set({
        cloudDelete: {
          ...app.cloudDelete!,
          status: 'incomplete',
          left,
          unfinished,
        },
      })
      .where(eq(application.applicationId, app.applicationId));
    const summary = `Delete incomplete: ${
      left.length > 0
        ? `${left.length} resource${left.length === 1 ? ' is' : 's are'} left in Google Cloud`
        : unfinished
    }. ${outcome.summary}`;
    await log(`⚠️ [Cloud run] ${summary}`);
    throw new Error(summary);
  }

  /** The cloud of the Service's Cloud account; a gone one reads as AWS. */
  private async cloudOf(target: CloudDeleteTarget): Promise<CloudKind> {
    const row = await this.cloudAccounts.findForUse(target.cloudAccountId);
    return cloudOrLegacy(row?.cloud);
  }

  /**
   * A static site's bucket emptied through the port against S3: AWS's
   * own endpoint, virtual-hosted addressing, the deploy role's session.
   * Never throws.
   */
  private async empty(
    bucketName: string,
    region: string,
    session: AwsCredential,
  ): Promise<EmptyOutcome> {
    try {
      return await this.objectStorage.empty({
        endpoint: null,
        region,
        bucket: bucketName,
        credential: session,
        pathStyle: false,
      });
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** A clean finish: the row and its Deployments dropped, the Delete audited. */
  private async finish(app: CloudDeleteTarget) {
    const leftBehind = await this.drop(app.applicationId);
    const asked = app.cloudDelete?.requestedBy;
    if (!asked) return;
    await this.auditLogs.audit(asked, {
      action: 'delete',
      resourceType: 'application',
      resourceId: app.applicationId,
      resourceName: app.name,
      metadata: { cloudDelete: 'finished', ...leftBehind },
    });
  }

  /** Back to how the Service was before this run: nothing was removed. */
  private async revert(
    applicationId: string,
    record: ServiceCloudDeleteRecord,
    why: string,
  ): Promise<void> {
    await this.db
      .update(application)
      .set({
        cloudDelete: record.retrying
          ? { ...record, status: 'incomplete', unfinished: why }
          : null,
      })
      .where(eq(application.applicationId, applicationId));
  }

  /**
   * A run's ending its handler did not record: a Cancel before it began
   * (`why` null) puts the Service back; anything else that left it
   * `deleting` leaves it incomplete.
   */
  private async endedOutside(
    applicationId: string,
    deploymentId: string,
    why: string | null,
  ): Promise<void> {
    const [app] = await this.db
      .select({ cloudDelete: application.cloudDelete })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    const record = app?.cloudDelete;
    if (!record || record.deploymentId !== deploymentId) return;
    if (why === null) {
      await this.revert(applicationId, record, 'The Delete was cancelled');
      return;
    }
    if (record.status !== 'deleting') return;
    await this.db
      .update(application)
      .set({
        cloudDelete: { ...record, status: 'incomplete', unfinished: why },
      })
      .where(eq(application.applicationId, applicationId));
  }
}

const ENDED_BEFORE_DESTROYING: TofuFailure = {
  ok: false,
  reason: 'interrupted',
  message: 'The run was ended before it destroyed anything.',
};

function accessOf(account: AwsCloudAccount) {
  return {
    awsAccountId: account.cloudId,
    deployRoleArn: account.deployRoleArn,
    externalId: account.externalId,
  };
}

function refused(message: string): ConflictException {
  return new ConflictException({ message, code: CLOUD_DELETE_REFUSED_CODE });
}
