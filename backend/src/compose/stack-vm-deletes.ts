import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { quote } from 'shell-quote';

import { CLOUD_DELETE_REFUSED_CODE } from '../applications/cloud-delete-refusal';
import { destroyDefinition } from '../cloud-accounts/aws/definitions/destroy-definition';
import { TAG_KEYS } from '../cloud-accounts/aws/definitions/tags';
import {
  CLEAN_DELETE_LINE,
  deleteReportLines,
  findLeftovers,
  heldByState,
} from '../cloud-accounts/aws/delete-check';
import type {
  KeptResource,
  Leftover,
} from '../cloud-accounts/aws/delete-check';
import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import {
  byCloud,
  credentialOf,
  onCloud,
} from '../cloud-accounts/cloud-provider';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
  PerCloud,
} from '../cloud-accounts/cloud-provider';
import type { CloudKind } from '../cloud-accounts/cloud-account.schema';
import { AWS_CLOUD_PORT, CHANGED_NOTHING } from '../cloud-accounts/cloud.port';
import type {
  AwsCloudPort,
  AwsCredential,
  TofuFailure,
  TofuShow,
  TofuStateOutcome,
} from '../cloud-accounts/cloud.port';
import type { StackVmSettings } from '../cloud-accounts/definitions/stack-vm';
import {
  FINAL_SNAPSHOT_OF,
  keptStackVmSnapshot,
  stackVmDataDeletedLine,
  stackVmFinalSnapshotName,
} from '../cloud-accounts/definitions/stack-vm-final-snapshot';
import { googleRefusalReason } from '../cloud-accounts/gcp/api-off';
import { destroyDefinition as googleDestroyDefinition } from '../cloud-accounts/gcp/definitions/destroy-definition';
import { GOOGLE_CLEAN_DELETE_LINE } from '../cloud-accounts/gcp/delete-check';
import {
  GOOGLE_CLOUD_PORT,
  NOT_FOUND,
} from '../cloud-accounts/google-cloud.port';
import type {
  GoogleAnswer,
  GoogleCloudPort,
} from '../cloud-accounts/google-cloud.port';
import type { InfrastructureState } from '../cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { InfrastructureStatesService } from '../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { ownerOnlyDirectoryCommand } from '../common/files/owner-only';
import { describeError } from '../common/describe-error';
import { reclaimDeploymentLogs } from '../common/teardown-steps';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { compose, deployment } from '../db/schema';
import type { Compose, Deployment } from '../db/schema';
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
import { GoogleDomainRuns } from '../project-config/applier/google-domain-runs.service';
import { writeKept } from '../project-config/console-saves';
import type { KeepConfig } from '../project-config/console-saves';
import {
  snapshotDate,
  snapshotNames,
} from '../project-config/rds-postgres-places';
import type { PermissionCtx } from '../rbac/permission.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import { NothingRemoved } from '../common/nothing-removed';
import type { StackVmCloudDeleteRecord } from './stack-vm-delete-record';

/** A stack on a Stack VM, as its Delete reads its row. */
export interface StackVmTarget {
  readonly composeId: string;
  readonly appName: string;
  readonly name: string;
  readonly configName: string | null;
  readonly environmentId: string;
  readonly cloudAccountId: string;
  readonly region: string;
  readonly stackVm: StackVmSettings;
  readonly cloudDelete: StackVmCloudDeleteRecord | null;
}

/** A stack's row as its Delete reads it, or `null` when it is not on a Stack VM. */
export function stackVmTargetOf(row: Compose): StackVmTarget | null {
  if (!row.cloudAccountId || !row.region || !row.stackVm) return null;
  return {
    composeId: row.composeId,
    appName: row.appName,
    name: row.name,
    configName: row.configName,
    environmentId: row.environmentId,
    cloudAccountId: row.cloudAccountId,
    region: row.region,
    stackVm: row.stackVm,
    cloudDelete: row.cloudDelete,
  };
}

/**
 * Where a stack's Domains' host rules live (#1371): on AWS in its own
 * state, which its destroy removes; on Google Cloud on the network's one
 * URL map, which its Delete's network step writes first, so the run waits
 * as one that touches the network.
 */
const DOMAINS_ON_THE_NETWORK: PerCloud<{ readonly writesNetwork: boolean }> = {
  aws: { writesNetwork: false },
  gcp: { writesNetwork: true },
};

/** How long a run waits for EBS to finish the final snapshot before the Delete goes on without it. */
const SNAPSHOT_WAIT_MS = 60 * 60 * 1000;

/**
 * **A Compose stack on a Stack VM's Delete** (ADR-0070 "Delete", #1367;
 * ADR-0038): a destroy-only Cloud run, recorded as a Deployment of the
 * stack, that leaves nothing running or billed by surprise and never loses
 * data by accident.
 *
 * 1. The request checks the Cloud account can be reached (nothing removed
 *    otherwise), names the final snapshot for the day it was asked —
 *    `<project>-<environment>-<stack>-final-<date>` — unless it asked for
 *    the data to go, records the Deployment and marks the row `deleting`.
 * 2. The run takes the final snapshot of the data disk, through the cloud
 *    port's direct call, and keeps its id on the record at once, so a
 *    Retry takes no second one. On AWS it waits until EBS has finished it.
 *    The snapshot carries Cloudgate's account and Environment tags and the
 *    stack's name, never its state's, so no check counts it as left.
 * 3. It destroys everything in the stack's Infrastructure state: the VM,
 *    the data disk, its load balancer rules and target, its security or
 *    firewall rules, its cloud identity and its snapshot policy or
 *    schedule.
 * 4. It deletes the daily snapshots the policy or schedule took, which are
 *    in no state, leaving any snapshot of the disk taken by hand.
 * 5. It reads the state again, and on AWS searches for anything left by
 *    the state's tag; the state is removed only once it is empty.
 * 6. A clean finish removes the state, drops the row and its Deployments,
 *    and writes the report (the snapshot kept) into the audit entry.
 *    Anything else leaves the row Delete incomplete and says why: a Delete
 *    asked again Retries from the kept state.
 */
@Injectable()
export class StackVmDeletes implements OnModuleInit {
  /** How often the run reads a pending EBS snapshot. Tests shorten it. */
  snapshotPollMs = 15_000;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
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

  /** The Domain runs live in the project-config module, which imports this one. */
  private get domainRuns(): GoogleDomainRuns {
    return this.moduleRef.get(GoogleDomainRuns, { strict: false });
  }

  onModuleInit(): void {
    this.moduleRef
      .get(CloudReadWorks, { strict: false })
      .handle('stack-vm-destroy', (job, control) => this.run(job, control));
  }

  /**
   * The Delete, or, when the last one is incomplete, its Retry, which
   * keeps the snapshot the Delete named. Refused while one runs. Answers
   * the row, marked `deleting`, and the run's Deployment.
   */
  async request(
    ctx: PermissionCtx,
    target: StackVmTarget,
    keep: KeepConfig,
    options: { readonly deleteData: boolean },
  ): Promise<{ row: Compose | undefined; deploymentId: string }> {
    const record = await this.settled(target);
    if (record?.status === 'deleting') {
      throw refused(`${target.name} is already being deleted`);
    }
    const retrying = record?.status === 'incomplete';

    // A Delete whose Cloud account cannot be reached fails and removes
    // nothing: asked here, before a Deployment exists.
    const account = await this.cloudAccounts.findForUse(target.cloudAccountId);
    if (!account) {
      throw refused(
        'The Cloud account this stack runs in is gone. Nothing was removed',
      );
    }
    const signInRefusal = await this.cloudAccounts.signInRefusal(account);
    if (signInRefusal !== null) {
      throw refused(`${signInRefusal}. Nothing was removed`);
    }
    const finalSnapshot = retrying
      ? (record.finalSnapshot ?? null)
      : options.deleteData
        ? null
        : stackVmFinalSnapshotName(account.cloud, {
            ...(await snapshotNames(this.db, target.environmentId)),
            configName: target.configName ?? target.name,
            date: snapshotDate(new Date()),
          });
    const run = await this.record(target, retrying);
    const next: StackVmCloudDeleteRecord = {
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
      finalSnapshot,
      ...(retrying && record.snapshotTaken
        ? { snapshotTaken: record.snapshotTaken }
        : {}),
    };
    let row: Compose | undefined;
    try {
      row = await writeKept(
        this.db,
        keep,
        (db) => this.writeRecord(target.composeId, next, db),
        (written) =>
          written ? { serviceId: target.composeId, removed: {} } : null,
      );
    } catch (error) {
      await this.db
        .delete(deployment)
        .where(eq(deployment.deploymentId, run.deploymentId));
      throw error;
    }

    void this.cloudRuns
      .submit(run.deploymentId, {
        kind: 'stack-vm-destroy',
        stateKey: `compose:${target.composeId}`,
        environmentId: target.environmentId,
        touchesNetwork:
          byCloud(account.cloud, DOMAINS_ON_THE_NETWORK).writesNetwork &&
          (target.stackVm.routedPorts ?? []).length > 0,
      })
      .then(async (ending) => {
        if (ending.kind === 'shutdown' && !ending.started) return;
        await this.endedOutside(
          target,
          run.deploymentId,
          ending.kind === 'cancelled'
            ? null
            : (endingDescription(ending) ?? 'The Delete ended'),
        );
      })
      .catch(() => undefined);
    return { row, deploymentId: run.deploymentId };
  }

  /** The record as it stands; a `deleting` whose run is gone reads incomplete. */
  private async settled(
    target: StackVmTarget,
  ): Promise<StackVmCloudDeleteRecord | null> {
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
    target: StackVmTarget,
    retrying: boolean,
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
        ...parentColumns({ kind: 'compose', composeId: target.composeId }),
        title: retrying ? 'Retry Delete' : 'Delete',
        description: `Destroys ${target.name}'s Stack VM and everything in its Infrastructure state in ${target.region}`,
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
    if (!row?.composeId) throw new Error('This Cloud run records no stack');
    const [found] = await this.db
      .select()
      .from(compose)
      .where(eq(compose.composeId, row.composeId));
    const target = found ? stackVmTargetOf(found) : null;
    const record = target?.cloudDelete;
    if (!target || !record) {
      throw new Error('This stack has no Delete under way');
    }
    const log = (line: string) => this.cloudRuns.appendLog(row.logPath, line);
    try {
      const account = await this.cloudAccounts.findForUse(
        target.cloudAccountId,
      );
      if (!account) {
        throw new NothingRemoved(
          'The Cloud account this stack runs in is gone. Nothing was removed',
        );
      }
      await onCloud(account, {
        aws: (aws) => this.destroyOnAws(target, record, aws, control, log),
        gcp: (gcp) => this.destroyOnGoogle(target, record, gcp, control, log),
      });
    } catch (error) {
      if (error instanceof NothingRemoved) {
        await log(`❌ [Cloud run] ${error.message}`);
        await this.revert(target, record, error.message);
      }
      throw error;
    }
  }

  /**
   * On EC2: the final snapshot of the EBS data disk, waited on until EBS
   * has finished it; the destroy; Data Lifecycle Manager's snapshots of the
   * disk; and the check afterwards by the state's tag.
   */
  private async destroyOnAws(
    target: StackVmTarget,
    record: StackVmCloudDeleteRecord,
    account: AwsCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const reached = await this.cloudAccounts.deployRoleSession(account);
    if (!reached.ok) {
      throw new NothingRemoved(`${reached.refusal}. Nothing was removed`);
    }
    const { session } = reached;
    const state = await this.states.findForCompose(target.composeId);
    await this.opening(target, record, account.name, log);
    if (!control.beginApply()) {
      throw new NothingRemoved(
        'The run was ended before it changed anything. Nothing was removed',
      );
    }
    const volumeId = target.stackVm.made?.dataVolumeId || null;
    const said = (answer: { code: string; message: string }) =>
      `AWS answered ${answer.code}: ${answer.message}`;

    // 1. The final snapshot, kept on the record at once.
    let taken = record.snapshotTaken ?? null;
    let unfinished: string | null = null;
    if (record.finalSnapshot && !taken && volumeId) {
      await log(
        `📸 [Cloud run] Taking the final snapshot ${record.finalSnapshot} of data disk ${volumeId}`,
      );
      const took = await this.cloud
        .ec2TakeSnapshot(session, {
          region: target.region,
          volumeId,
          name: record.finalSnapshot,
          description: `Cloudgate: the final snapshot of ${target.name}'s Stack VM data disk`,
          tags: {
            [TAG_KEYS.cloudAccount]: target.cloudAccountId,
            [TAG_KEYS.environment]: target.environmentId,
            [FINAL_SNAPSHOT_OF.aws]: target.configName ?? target.name,
          },
        })
        .catch(unreachable);
      if (!took.ok) {
        throw new NothingRemoved(
          `EC2 could not take the final snapshot ${record.finalSnapshot}: ${said(took)}. Nothing was removed`,
        );
      }
      if (took.value) {
        taken = { id: took.value.snapshotId, sizeGb: took.value.sizeGb };
        await this.writeRecord(target.composeId, {
          ...record,
          snapshotTaken: taken,
        });
      } else {
        await log(
          `⚠️ [Cloud run] EC2 has no data disk ${volumeId}: there is nothing to snapshot`,
        );
      }
    } else if (record.finalSnapshot && !volumeId) {
      await log(
        `⚠️ [Cloud run] ${target.name}'s Stack VM was never made, so it has no data disk to snapshot`,
      );
    }
    if (taken && record.finalSnapshot) {
      const finished = await this.snapshotFinished(
        session,
        target.region,
        taken.id,
        control,
      );
      if (finished !== true) {
        unfinished = `The final snapshot ${record.finalSnapshot} (${taken.id}) ${finished}, so nothing was destroyed. Retry once EBS has finished it`;
      } else {
        await log(
          `📸 [Cloud run] The final snapshot ${record.finalSnapshot} (${taken.id}) is complete`,
        );
      }
    }

    // 2. The destroy.
    let show: TofuShow | null = null;
    let destroyed = false;
    if (unfinished === null && state) {
      await log(
        `🗑️ [Cloud run] Destroying everything in Infrastructure state ${state.infrastructureStateId}`,
      );
      const outcome = await this.states.destroy({
        stateId: state.infrastructureStateId,
        credential: credentialOf(account),
        definition: destroyDefinition(accessOf(account), target.region, {
          cloudAccountId: account.cloudAccountId,
          environmentId: target.environmentId,
          stateId: state.infrastructureStateId,
        }),
        onLine: (line) => void log(line),
        signal: control.signal,
        beforeApply: () =>
          control.beginApply() ? null : ENDED_BEFORE_DESTROYING,
      });
      if (outcome.ok) {
        show = outcome.show;
        destroyed = true;
      } else if (CHANGED_NOTHING.has(outcome.reason) && !taken) {
        throw new NothingRemoved(`${outcome.message} Nothing was removed`);
      } else {
        unfinished = outcome.message;
      }
    } else if (unfinished === null) {
      await log(
        `🗑️ [Cloud run] ${target.name} has no Infrastructure state: nothing was made for it in AWS`,
      );
      destroyed = true;
    }

    // 3. Data Lifecycle Manager's snapshots, in no state.
    if (destroyed && volumeId) {
      const daily = await this.cloud
        .ec2DailySnapshots(session, { region: target.region, volumeId })
        .catch(unreachable);
      if (!daily.ok) {
        unfinished ??= `Its daily snapshots could not be listed: ${said(daily)}`;
      } else {
        for (const snapshotId of daily.value) {
          if (snapshotId === taken?.id) continue;
          const gone = await this.cloud
            .ec2DeleteSnapshot(session, { region: target.region, snapshotId })
            .catch(unreachable);
          if (gone.ok) {
            await log(`🗑️ [Cloud run] Deleted daily snapshot ${snapshotId}`);
          } else {
            unfinished ??= `Daily snapshot ${snapshotId} could not be deleted: ${said(gone)}`;
          }
        }
      }
    }

    // 4. The check afterwards: the state empty, nothing left by its tag.
    let left: Leftover[] = [...record.left];
    if (control.signal.killed) {
      unfinished ??= 'The run was killed before it could check what is left.';
    } else if (destroyed && state) {
      unfinished ??= await this.stateLeft(
        this.states.resources({
          stateId: state.infrastructureStateId,
          credential: credentialOf(account),
          definition: destroyDefinition(accessOf(account), target.region, {
            cloudAccountId: account.cloudAccountId,
            environmentId: target.environmentId,
            stateId: state.infrastructureStateId,
          }),
          region: target.region,
        }),
      );
      await log('🔎 [Cloud run] Checking AWS for anything left');
      const check = await findLeftovers(this.cloud, session, {
        region: target.region,
        stateId: state.infrastructureStateId,
        ...heldByState(show),
      });
      if (check.ok) left = check.left;
      else unfinished ??= `What is left could not be checked: ${check.message}`;
    }

    await this.report(target, record, 'aws', {
      kept:
        taken && record.finalSnapshot
          ? [
              keptStackVmSnapshot('aws', {
                id: taken.id,
                name: record.finalSnapshot,
                region: target.region,
                sizeGb: taken.sizeGb || target.stackVm.dataDiskGb,
              }),
            ]
          : [],
      left,
      unfinished,
      destroyed,
      state,
      taken,
      log,
    });
  }

  /**
   * On Compute Engine: the final snapshot of the persistent data disk,
   * taken and waited on by the port; the destroy; and the snapshot
   * schedule's snapshots of the disk, which it keeps after the disk goes.
   */
  private async destroyOnGoogle(
    target: StackVmTarget,
    record: StackVmCloudDeleteRecord,
    account: GcpCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) {
      throw new NothingRemoved(`${session.refusal}. Nothing was removed`);
    }
    const state = await this.states.findForCompose(target.composeId);
    await this.opening(target, record, account.name, log);
    if (!control.beginApply()) {
      throw new NothingRemoved(
        'The run was ended before it changed anything. Nothing was removed',
      );
    }
    const made = target.stackVm.made;
    const disk =
      made?.dataVolumeId && made.zone
        ? {
            projectId: account.cloudId,
            zone: made.zone,
            disk: made.dataVolumeId,
          }
        : null;
    const said = (answer: { code: string; message: string }) =>
      `Google answered ${answer.code}: ${googleRefusalReason(answer.message, account.cloudId)}`;

    // 1. The final snapshot, kept on the record at once.
    let taken = record.snapshotTaken ?? null;
    let unfinished: string | null = null;
    if (record.finalSnapshot && !taken && disk) {
      await log(
        `📸 [Cloud run] Taking the final snapshot ${record.finalSnapshot} of data disk ${disk.disk}`,
      );
      const took = await this.google
        .takeDiskSnapshot(session.token, {
          ...disk,
          name: record.finalSnapshot,
          region: target.region,
          description: `Cloudgate: the final snapshot of ${target.name}'s Stack VM data disk`,
          labels: {
            [FINAL_SNAPSHOT_OF.gcp]: labelValue(
              target.configName ?? target.name,
            ),
          },
        })
        .catch(unreachable);
      if (!took.ok && took.code === NOT_FOUND) {
        await log(
          `⚠️ [Cloud run] Compute Engine has no data disk ${disk.disk}: there is nothing to snapshot`,
        );
      } else if (!took.ok) {
        throw new NothingRemoved(
          `Compute Engine could not take the final snapshot ${record.finalSnapshot}: ${said(took)}. Nothing was removed`,
        );
      } else {
        taken = {
          id: took.value.name,
          sizeGb: took.value.sizeGb || target.stackVm.dataDiskGb,
        };
        await this.writeRecord(target.composeId, {
          ...record,
          snapshotTaken: taken,
        });
        await log(
          `📸 [Cloud run] The final snapshot ${record.finalSnapshot} is taken`,
        );
      }
    } else if (record.finalSnapshot && !disk) {
      await log(
        `⚠️ [Cloud run] ${target.name}'s Stack VM was never made, so it has no data disk to snapshot`,
      );
    }

    // The network step: its Domains' host rules are on the network's one
    // URL map, naming backend services in the stack's state, which Google
    // will not delete while the map names them. So the network's Domains
    // run first without the stack's, as a cloud Service's Delete's does:
    // the row is marked as being deleted, which leaves them out
    // (`networkDomainRows`). A step that fails before it applied anything
    // removes nothing; one that fails after leaves the Delete incomplete,
    // the stack's own state untouched, for a Retry.
    let networkApplied = false;
    if (state && (target.stackVm.routedPorts ?? []).length > 0) {
      await log(
        `🌐 [Cloud run] Network step: removing ${target.name}'s Domains from the Environment network's load balancer`,
      );
      const watched: CloudRunControl = {
        signal: control.signal,
        beginApply: () => {
          const may = control.beginApply();
          if (may) networkApplied = true;
          return may;
        },
        holdTimeLimit: () => control.holdTimeLimit(),
      };
      try {
        await this.domainRuns.applyOnNetwork(target, watched, log);
      } catch (error) {
        const why = googleRefusalReason(describeError(error), account.cloudId);
        if (!taken && !networkApplied) {
          throw new NothingRemoved(
            `The network step failed: ${why}. Nothing was removed`,
          );
        }
        unfinished = `The network step failed before ${target.name}'s Stack VM was touched: ${why}`;
      }
    }

    // 2. The destroy, once the network step is done.
    let destroyed = false;
    if (unfinished === null && state) {
      await log(
        `🗑️ [Cloud run] Destroying everything in Infrastructure state ${state.infrastructureStateId}`,
      );
      const outcome = await this.states.destroy({
        stateId: state.infrastructureStateId,
        credential: session.credential,
        definition: googleDestroyDefinition(account.cloudId, target.region),
        onLine: (line) => void log(line),
        signal: control.signal,
        beforeApply: () =>
          control.beginApply() ? null : ENDED_BEFORE_DESTROYING,
      });
      if (outcome.ok) {
        destroyed = true;
      } else if (
        CHANGED_NOTHING.has(outcome.reason) &&
        !taken &&
        !networkApplied
      ) {
        throw new NothingRemoved(`${outcome.message} Nothing was removed`);
      } else {
        unfinished = googleRefusalReason(outcome.message, account.cloudId);
      }
    } else if (unfinished === null) {
      await log(
        `🗑️ [Cloud run] ${target.name} has no Infrastructure state: nothing was made for it in Google Cloud`,
      );
      destroyed = true;
    }

    // 3. The schedule's snapshots, which outlive the disk.
    if (destroyed && disk) {
      const scheduled = await this.google
        .scheduledDiskSnapshots(session.token, disk)
        .catch(unreachable);
      if (!scheduled.ok) {
        unfinished ??= `Its daily snapshots could not be listed: ${said(scheduled)}`;
      } else {
        for (const name of scheduled.value) {
          if (name === taken?.id) continue;
          const gone = await this.google
            .deleteDiskSnapshot(session.token, {
              projectId: account.cloudId,
              name,
            })
            .catch(unreachable);
          if (gone.ok) {
            await log(`🗑️ [Cloud run] Deleted daily snapshot ${name}`);
          } else {
            unfinished ??= `Daily snapshot ${name} could not be deleted: ${said(gone)}`;
          }
        }
      }
    }

    // 4. The state read again: removed only once empty.
    if (control.signal.killed) {
      unfinished ??= 'The run was killed before it could check what is left.';
    } else if (destroyed && state) {
      unfinished ??= await this.stateLeft(
        this.states.resources({
          stateId: state.infrastructureStateId,
          credential: session.credential,
          definition: googleDestroyDefinition(account.cloudId, target.region),
          region: target.region,
        }),
      );
    }

    await this.report(target, record, 'gcp', {
      kept:
        taken && record.finalSnapshot
          ? [
              keptStackVmSnapshot('gcp', {
                id: taken.id,
                name: record.finalSnapshot,
                region: target.region,
                sizeGb: taken.sizeGb,
              }),
            ]
          : [],
      left: record.left,
      unfinished,
      destroyed,
      state,
      taken,
      log,
    });
  }

  private async opening(
    target: StackVmTarget,
    record: StackVmCloudDeleteRecord,
    accountName: string,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    await log(
      `🗑️ [Cloud run] Deleting ${target.name}'s Stack VM from Cloud account ${accountName} in ${target.region}` +
        (record.finalSnapshot
          ? `, keeping a final snapshot ${record.finalSnapshot} of its data disk`
          : ', its data deleted for good: no final snapshot'),
    );
  }

  /**
   * Whether EBS finished the snapshot: `true`, or why the run stopped
   * waiting. Each read is the port's; a run ended from outside stops it.
   */
  private async snapshotFinished(
    session: AwsCredential,
    region: string,
    snapshotId: string,
    control: CloudRunControl,
  ): Promise<true | string> {
    const until = Date.now() + SNAPSHOT_WAIT_MS;
    for (;;) {
      const read = await this.cloud
        .ec2Snapshot(session, { region, snapshotId })
        .catch(unreachable);
      if (!read.ok) return `could not be read: AWS answered ${read.code}`;
      if (read.value === null) return 'is gone from EC2';
      if (read.value.state === 'completed') return true;
      if (read.value.state === 'error') return 'failed in EBS';
      if (control.signal.killed)
        return 'was still being taken when the run was ended';
      if (Date.now() >= until) return 'was still being taken after an hour';
      await new Promise((resolve) => setTimeout(resolve, this.snapshotPollMs));
    }
  }

  /**
   * What the state still holds once destroyed, as an unfinished reason, or
   * `null` when it is empty: the state goes only once it is (#1367).
   */
  private async stateLeft(
    reading: Promise<TofuStateOutcome<unknown>>,
  ): Promise<string | null> {
    const read = await reading;
    if (!read.ok) {
      return `Its Infrastructure state could not be read: ${read.message}`;
    }
    const count = read.resources.length;
    return count === 0
      ? null
      : `Its Infrastructure state still holds ${count} resource${count === 1 ? '' : 's'}`;
  }

  /** The report, then the row: dropped on a clean finish, else Delete incomplete. */
  private async report(
    target: StackVmTarget,
    record: StackVmCloudDeleteRecord,
    cloud: CloudKind,
    run: {
      readonly kept: KeptResource[];
      readonly left: readonly Leftover[];
      readonly unfinished: string | null;
      readonly destroyed: boolean;
      readonly state: InfrastructureState | null;
      readonly taken: StackVmCloudDeleteRecord['snapshotTaken'] | null;
      readonly log: (line: string) => Promise<void>;
    },
  ): Promise<void> {
    const { kept, left, unfinished, log } = run;
    if (run.destroyed && record.finalSnapshot === null) {
      await log(stackVmDataDeletedLine(target.name));
    }
    for (const line of deleteReportLines(
      { kept, left },
      byCloud(cloud, { aws: CLEAN_DELETE_LINE, gcp: GOOGLE_CLEAN_DELETE_LINE }),
    )) {
      await log(line);
    }
    if (unfinished === null && left.length === 0) {
      if (run.state) await this.states.remove(run.state.infrastructureStateId);
      await this.finish(target, record, kept);
      return;
    }
    await this.writeRecord(target.composeId, {
      ...record,
      ...(run.taken ? { snapshotTaken: run.taken } : {}),
      status: 'incomplete',
      kept,
      left: [...left],
      unfinished,
    });
    const where = byCloud(cloud, { aws: 'AWS', gcp: 'Google Cloud' });
    const summary = `Delete incomplete: ${
      left.length > 0
        ? `${left.length} resource${left.length === 1 ? ' is' : 's are'} left in ${where}`
        : unfinished
    }. Delete it again to Retry from the kept state`;
    await log(`⚠️ [Cloud run] ${summary}`);
    throw new Error(summary);
  }

  /** A clean finish: the row and its Deployments dropped, the report audited. */
  private async finish(
    target: StackVmTarget,
    record: StackVmCloudDeleteRecord,
    kept: readonly KeptResource[],
  ): Promise<void> {
    const unreclaimedArtifacts = await reclaimDeploymentLogs(this.remoteExec, [
      { appName: target.appName, serverId: null },
    ]);
    await this.db
      .delete(compose)
      .where(eq(compose.composeId, target.composeId));
    const asked = record.requestedBy;
    if (!asked) return;
    await this.auditLogs.audit(asked, {
      action: 'delete',
      resourceType: 'compose',
      resourceId: target.composeId,
      resourceName: target.name,
      metadata: {
        cloudDelete: 'finished',
        kept,
        dataDeleted: record.finalSnapshot === null,
        ...(unreclaimedArtifacts.length > 0 ? { unreclaimedArtifacts } : {}),
      },
    });
  }

  /** Back to how the stack was before this run: nothing was removed. */
  private async revert(
    target: StackVmTarget,
    record: StackVmCloudDeleteRecord,
    why: string,
  ): Promise<void> {
    await this.writeRecord(
      target.composeId,
      record.retrying || record.snapshotTaken
        ? { ...record, status: 'incomplete', unfinished: why }
        : null,
    );
  }

  /** A Cancel before it began puts the stack back; any other ending leaves it incomplete. */
  private async endedOutside(
    target: StackVmTarget,
    deploymentId: string,
    why: string | null,
  ): Promise<void> {
    const [row] = await this.db
      .select({ cloudDelete: compose.cloudDelete })
      .from(compose)
      .where(eq(compose.composeId, target.composeId));
    const record = row?.cloudDelete;
    if (!record || record.deploymentId !== deploymentId) return;
    if (why === null) {
      await this.revert(target, record, 'The Delete was cancelled');
      return;
    }
    if (record.status !== 'deleting') return;
    await this.writeRecord(target.composeId, {
      ...record,
      status: 'incomplete',
      unfinished: why,
    });
  }

  private async writeRecord(
    composeId: string,
    record: StackVmCloudDeleteRecord | null,
    db: Pick<DrizzleDB, 'update'> = this.db,
  ): Promise<Compose | undefined> {
    const [row] = await db
      .update(compose)
      .set({ cloudDelete: record })
      .where(eq(compose.composeId, composeId))
      .returning();
    return row;
  }
}

/** A port call that got no answer reads as one refused, so a step fails rather than throws. */
function unreachable(error: unknown): GoogleAnswer<never> {
  return {
    ok: false,
    code: 'Unreachable',
    message: error instanceof Error ? error.message : String(error),
  };
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

/** A Google label's value: lower-case letters, digits, `_` and `-`, at most 63. */
function labelValue(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .slice(0, 63);
}

function refused(message: string): ConflictException {
  return new ConflictException({ message, code: CLOUD_DELETE_REFUSED_CODE });
}
