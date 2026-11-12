import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';

import type { ApplicationStatus } from '../../applications/application.schema';
import { withImports } from '../../cloud-accounts/aws/definitions/imports';
import {
  STACK_VM_INSTANCE_ADDRESS,
  STACK_VM_OUTPUTS,
  stackVmDefinition,
} from '../../cloud-accounts/aws/definitions/stack-vm-definition';
import { stackVmWritten } from '../../cloud-accounts/definitions/stack-vm-written';
import { DOCKER_VOLUMES_FOLDER } from '../../cloud-accounts/definitions/stack-vm-cloud-init';
import type { StackVmWritten } from '../../cloud-accounts/definitions/stack-vm-written';
import type { PlanReading } from '../../cloud-accounts/aws/plan-reader/read-plan';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import { credentialOf, onCloud } from '../../cloud-accounts/cloud-provider';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../../cloud-accounts/cloud-provider';
import { withGoogleImports } from '../../cloud-accounts/gcp/definitions/imports';
import {
  GOOGLE_STACK_VM_INSTANCE_ADDRESS,
  GOOGLE_STACK_VM_OUTPUTS,
  googleStackVmDefinition,
} from '../../cloud-accounts/gcp/definitions/stack-vm-definition';
import { blameNativeGcp } from '../../native/gcp-lay';
import { googleNetworkNames } from '../cloud-sql-places';
import {
  applyApprovedOnGoogle,
  googleRunProof,
  outputText,
} from './google-apply';
import type { StackVmSettings } from '../../cloud-accounts/definitions/stack-vm';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { describeError } from '../../common/describe-error';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { compose, deployment } from '../../db/schema';
import type { Compose, Deployment } from '../../db/schema';
import { CloudReadWorks } from '../../deployment-queue/cloud-read-work';
import type {
  CloudRunControl,
  CloudRunJob,
} from '../../deployment-queue/cloud-run-job.types';
import { CloudRunsService } from '../../deployment-queue/cloud-runs.service';
import { DeploymentsService } from '../../deployments/deployments.service';
import { DomainsService } from '../../domains/domains.service';
import { MountsService } from '../../mounts/mounts.service';
import { handFreshStackVmOn } from './template-stack-handoff';
import { blameNativeAws } from '../../native/aws-lay';
import { isConnectionFailure } from '../../remote/exec-error';
import { RemoteExecService } from '../../remote/remote-exec.service';
import { runTargetOn } from '../../remote/run-target';
import { stackRowOf, stackVmPublicKeyOf } from '../../stack-vm/stack-vm-rows';
import { AwsPlanReads } from '../aws-plan-reads.service';
import { savedDatabaseNetwork } from '../rds-postgres-places';
import type { PlanStepDeploy } from './apply.types';
import { approvedOnPlan, beforeApplyingApproved } from './approved-run';
import {
  awsStackVmDomainPieces,
  googleStackVmPorts,
} from './stack-vm-domain-pieces';
import type { ApprovedRun } from './approved-run';

/** What one Stack VM's Cloud run works from, whatever its cloud. */
interface StackVmRun {
  readonly found: Compose & {
    readonly region: string;
    readonly stackVm: StackVmSettings;
  };
  readonly stateId: string;
  readonly approved: ApprovedRun;
  readonly control: CloudRunControl;
  readonly log: (line: string) => Promise<void>;
}

/**
 * The script that grows a Stack VM's data disk's filesystem to
 * `dataDiskGb` (#1368): it waits up to five minutes for the disk to show
 * that size, then grows the mounted filesystem, whose device it finds by
 * the volume folder, whatever its name.
 */
export function growFilesystemScript(dataDiskGb: number): string {
  const bytes = dataDiskGb * 1024 ** 3;
  return [
    'set -eu',
    `dev="$(findmnt -no SOURCE ${DOCKER_VOLUMES_FOLDER})"`,
    'for _ in $(seq 1 60); do',
    `  if [ "$(blockdev --getsize64 "$dev")" -ge ${bytes} ]; then break; fi`,
    '  sleep 5',
    'done',
    'resize2fs "$dev"',
  ].join('\n');
}

/** What a Stack VM's run says it does, by what it is written with. */
function doing(name: string, written: StackVmWritten, made: boolean): string {
  if (!made) return `Creating ${name}'s Stack VM (${written.machineType})`;
  if (written.replace) {
    return `Replacing ${name}'s Stack VM (${written.machineType}) at Cloudgate's new pins, keeping its data disk`;
  }
  return `Changing ${name}'s Stack VM (${written.machineType}, ${written.dataDiskGb} GB data disk)`;
}

/**
 * **A Compose stack's Stack VM is made by a Cloud run** (ADR-0070, #1359),
 * as a bucket on S3 is (`CloudBucketRuns`).
 *
 * An Apply that creates a `compose` entry in a Cloud Environment, AWS or
 * Google Cloud (#1362), writes the
 * stack's row (its Cloud account, region and Stack VM settings, never a
 * Server), keeps the Infrastructure state its plan read against, and
 * records the run as a Deployment whose parent is the stack, its log on the
 * platform host. The run writes the definition from the row, in the
 * Environment network the same Apply made first, reads AWS again and
 * applies only if that plan makes what the Apply approved. What the plan
 * adopted by Cloudgate's mark is imported, never made twice.
 *
 * Once applied, the image the Stack VM was made from, the Docker and
 * compose pins its first boot installs, and its instance, address and data
 * disk are recorded in the stack's settings. A failed apply leaves what it
 * made in the stack's state, so the next plan shows what is left.
 *
 * The run ends once the Stack VM answers through its cloud's tunnel
 * (Session Manager on AWS, #1361; IAP on Google Cloud, #1365) and its first
 * boot is done (Docker installed, the data disk mounted), and then queues
 * the stack's first Deployment onto it, as an Apply queues a Server
 * stack's.
 *
 * **A change is the same run** (#1368): the Apply writes the settings the
 * change moves to — a machine type, which restarts the Stack VM, a larger
 * data disk, or an approved "replace VM"'s new pins — and the run writes
 * the definition from them (`stackVmWritten`), the image, zone and pins it
 * was made with kept unless the replace was approved, which is planned
 * with `-replace` and keeps the data disk. Once applied it waits for the
 * Stack VM to answer again; a grown disk's filesystem is grown on it, and
 * a replaced Stack VM, whose boot disk is new, has its image, pins,
 * instance and address recorded and the stack deployed onto it again.
 */
/** How long a new Stack VM has to answer and finish its first boot. */
const FIRST_BOOT_WAIT_MS = 15 * 60_000;
/** How long between tries while it does not answer yet. */
const FIRST_BOOT_RETRY_MS = 15_000;

@Injectable()
export class CloudStackVmRuns implements OnModuleInit {
  private readonly logger = new Logger(CloudStackVmRuns.name);
  /** What each Apply approved for the run it recorded, until the run reads it. */
  private readonly approved = new Map<string, ApprovedRun>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly awsReads: AwsPlanReads,
    private readonly deployments: DeploymentsService,
    private readonly moduleRef: ModuleRef,
    private readonly remoteExec: RemoteExecService,
    // What a fresh Stack VM takes before its first Deployment (#1379).
    private readonly mounts: MountsService,
    private readonly domains: DomainsService,
  ) {}

  /** The pool lives in the queue module, which this module cannot import. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  onModuleInit(): void {
    this.moduleRef
      .get(CloudReadWorks, { strict: false })
      .handle('stack-vm', (job, control) => this.run(job, control));
  }

  /**
   * The create's run, recorded and submitted to the pool: the step's
   * result names its Deployment, whose log the operator follows. Answers
   * once the run waits, not once it ends.
   */
  async start(
    made: Pick<Compose, 'composeId' | 'appName' | 'configName'>,
    environmentId: string,
    approved: PlanReading & { readonly stateId: string },
    /** A change's run, titled by what it does; absent for the create. */
    change?: { readonly title: string },
  ): Promise<PlanStepDeploy> {
    const record = await this.deployments.recordComposeCloudRun({
      composeId: made.composeId,
      appName: made.appName,
      title: change?.title ?? `Create ${made.configName}'s Stack VM`,
      description: `Applied from a plan, into Infrastructure state ${approved.stateId}`,
    });
    this.approved.set(record.deploymentId, {
      reading: approved,
      change: !!change,
    });
    await this.setStatus(made.composeId, 'running');
    void this.cloudRuns
      .submit(record.deploymentId, {
        kind: 'stack-vm',
        stateKey: `compose:${made.composeId}`,
        environmentId,
        touchesNetwork: false,
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Cloud run ${record.deploymentId} failed to settle: ${describeError(error)}`,
        ),
      );
    return { status: 'queued', deploymentId: record.deploymentId };
  }

  private async run(job: CloudRunJob, control: CloudRunControl) {
    const [row] = await this.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, job.deploymentId ?? ''));
    if (!row?.composeId) throw new Error('This Cloud run records no stack');
    try {
      const made = await this.make(row, row.composeId, control);
      await this.setStatus(row.composeId, 'done');
      // A new Stack VM, made or replaced, has nothing on its boot disk yet;
      // a resized or grown one keeps running what it ran. Its config files
      // and a Template's waiting Domains first (#1379).
      if (made.fresh) {
        await handFreshStackVmOn(
          { db: this.db, mounts: this.mounts, domains: this.domains },
          { deploymentId: row.deploymentId, composeId: row.composeId },
          (line) => this.cloudRuns.appendLog(row.logPath, line),
        );
        await this.deployOnto(row, row.composeId);
      }
    } catch (error) {
      await this.setStatus(row.composeId, 'error').catch(() => undefined);
      throw error;
    } finally {
      this.approved.delete(row.deploymentId);
    }
  }

  private async make(
    row: Deployment,
    composeId: string,
    control: CloudRunControl,
  ): Promise<{ readonly fresh: boolean }> {
    const log = (line: string) => this.cloudRuns.appendLog(row.logPath, line);
    const found = await stackRowOf(this.db, composeId);
    const name = found.configName;
    if (!found.cloudAccountId || !found.region || !found.stackVm) {
      throw new Error(`${name} has no Stack VM in a Cloud account`);
    }
    const account = await this.cloudAccounts.findForUse(found.cloudAccountId);
    if (!account) throw new Error('The Cloud account this stack is in is gone');
    const state = await this.states.findForCompose(composeId);
    if (!state) throw new Error(`${name} has no Infrastructure state`);
    const approved =
      this.approved.get(row.deploymentId) ??
      (await approvedOnPlan(this.db, row.deploymentId, name));
    if (!approved) {
      throw new Error(
        'No applied plan names this run, so it changes nothing. Check for changes, then apply the new plan',
      );
    }
    const run = {
      found: { ...found, region: found.region, stackVm: found.stackVm },
      stateId: state.infrastructureStateId,
      approved,
      control,
      log,
    };
    await onCloud<Promise<void>>(account, {
      aws: (aws) => this.makeOnEc2(run, aws),
      gcp: (google) => this.makeOnComputeEngine(run, google),
    });
    const replaced = !!found.stackVm.replaceWith && found.stackVm.made !== null;
    // A change may have grown the data disk: its filesystem grows with it.
    if (approved.change) {
      await this.growFilesystem(found, found.stackVm.dataDiskGb, control, log);
    }
    return { fresh: !approved.change || replaced };
  }

  /**
   * Grows the data disk's filesystem to the disk (#1368): the cloud grows
   * the disk itself in place, and the Stack VM sees its new size once the
   * cloud has made it, so this waits for that, then `resize2fs` grows the
   * mounted ext4 with no restart. Nothing to do when it is full size
   * already.
   */
  private async growFilesystem(
    found: Compose,
    dataDiskGb: number,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const ended = new AbortController();
    control.signal.onInterrupt(() => ended.abort());
    control.signal.onKill(() => ended.abort());
    const grown = await runTargetOn(found, {
      remoteExec: this.remoteExec,
    }).exec(growFilesystemScript(dataDiskGb), { signal: ended.signal });
    if (grown.exitCode !== 0) {
      throw new Error(
        `${found.configName}'s Stack VM data disk could not grow its filesystem: ${grown.stderr.trim() || grown.stdout.trim()}`,
      );
    }
    await log(
      `${found.configName}'s Stack VM data disk holds ${dataDiskGb} GB for its volumes`,
    );
  }

  /**
   * A Stack VM's Cloud run on Compute Engine (#1362): the run's own proof
   * (S16), the definition from the row on the made Environment network,
   * applied only if Google read again makes what the Apply approved, what
   * the plan took back by its mark imported. Then the image, the zone, its
   * name, address and data disk are recorded in the stack's settings.
   */
  private async makeOnComputeEngine(
    { found, stateId, approved, control, log }: StackVmRun,
    account: GcpCloudAccount,
  ): Promise<void> {
    const name = found.configName;
    const proof = await googleRunProof(this.cloudAccounts, account);
    const network = await googleNetworkNames(this.db, {
      environmentId: found.environmentId,
      cloudAccountId: account.cloudAccountId,
      region: found.region,
    });
    if (network.standIns) {
      throw new Error(
        `${name}'s Environment network in ${found.region} is not made yet. Check for changes, then apply the new plan`,
      );
    }
    const { stackVm } = found;
    const sshPublicKey = await stackVmPublicKeyOf(this.db, found);
    const written = stackVmWritten(stackVm, 'gcp');
    const generated = googleStackVmDefinition({
      configName: name,
      serviceId: found.composeId,
      cloudAccountId: account.cloudAccountId,
      projectId: account.cloudId,
      region: found.region,
      environmentId: found.environmentId,
      stateId,
      network: network.names,
      machineType: written.machineType,
      dataDiskGb: written.dataDiskGb,
      snapshotDays: written.snapshotDays,
      imageId: written.imageId,
      zone: written.zone,
      pins: written.pins,
      native: stackVm.nativeGcp,
      sshPublicKey,
      // A change writes the whole definition: its Domains' backends stay.
      ports: googleStackVmPorts(stackVm),
    });
    await log(
      `☁️ [Cloud run] ${doing(name, written, stackVm.made !== null)} in Cloud account ${account.name} in ${found.region}, Infrastructure state ${stateId}`,
    );
    let outputs: Record<string, unknown>;
    try {
      outputs = await applyApprovedOnGoogle(
        this.states,
        account,
        proof,
        { approved, control, log },
        {
          stateId,
          definition: withGoogleImports(
            generated.definition,
            approved.reading.adopt,
          ),
          ...(written.replace
            ? { replaces: [GOOGLE_STACK_VM_INSTANCE_ADDRESS] }
            : {}),
        },
      );
    } catch (error) {
      // What it made is in its state: the next plan shows what is left.
      throw new Error(blameNativeGcp(describeError(error), stackVm.nativeGcp));
    }
    const output = (key: string) => outputText(outputs, key) ?? '';
    const made: StackVmSettings['made'] = {
      imageId: output(GOOGLE_STACK_VM_OUTPUTS.imageId),
      pins: generated.pins,
      instanceId: output(GOOGLE_STACK_VM_OUTPUTS.instanceName),
      privateIp: output(GOOGLE_STACK_VM_OUTPUTS.privateIp),
      dataVolumeId: output(GOOGLE_STACK_VM_OUTPUTS.dataDiskName),
      zone: output(GOOGLE_STACK_VM_OUTPUTS.zone),
    };
    await this.record(found.composeId, stackVm, made);
    await log(
      `${name}'s Stack VM is made in ${made.zone} from image ${made.imageId}; on its first boot it installs Docker ${made.pins.dockerEngine} and compose ${made.pins.composePlugin}`,
    );
    await this.awaitFirstBoot(found, control, log, 'IAP');
  }

  /** A Stack VM's Cloud run on EC2. */
  private async makeOnEc2(
    { found, stateId, approved, control, log }: StackVmRun,
    account: AwsCloudAccount,
  ): Promise<void> {
    const name = found.configName;
    const credential = credentialOf(account);
    const refused = await this.awsReads.credentialRefusal(account, credential);
    if (refused) throw new Error(refused);
    const network = await savedDatabaseNetwork(this.db, {
      environmentId: found.environmentId,
      cloudAccountId: account.cloudAccountId,
      region: found.region,
    });
    if (!network) {
      throw new Error(
        `${name}'s Environment network in ${found.region} is not made yet. Check for changes, then apply the new plan`,
      );
    }
    const { stackVm } = found;
    const sshPublicKey = await stackVmPublicKeyOf(this.db, found);
    const written = stackVmWritten(stackVm, 'aws');
    const generated = stackVmDefinition({
      configName: name,
      serviceId: found.composeId,
      account: {
        awsAccountId: account.cloudId,
        deployRoleArn: account.deployRoleArn,
        externalId: account.externalId,
        cloudAccountId: account.cloudAccountId,
      },
      region: found.region,
      environmentId: found.environmentId,
      stateId,
      network,
      machineType: written.machineType,
      dataDiskGb: written.dataDiskGb,
      snapshotDays: written.snapshotDays,
      imageId: written.imageId,
      zone: written.zone,
      pins: written.pins,
      native: stackVm.native,
      sshPublicKey,
      // A change writes the whole definition: its Domains stay on.
      ...(await awsStackVmDomainPieces(this.db, {
        composeId: found.composeId,
        environmentId: found.environmentId,
        cloudAccountId: account.cloudAccountId,
        region: found.region,
      })),
    });
    await log(
      `☁️ [Cloud run] ${doing(name, written, stackVm.made !== null)} in Cloud account ${account.name} in ${found.region}, Infrastructure state ${stateId}`,
    );
    await log('Reading AWS again before applying');
    const applied = await this.states.apply({
      stateId,
      credential,
      definition: withImports(generated.definition, approved.reading.adopt),
      ...(written.replace ? { replaces: [STACK_VM_INSTANCE_ADDRESS] } : {}),
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: beforeApplyingApproved(approved, log, control),
    });
    // What it made is in its state: the next plan shows what is left.
    if (!applied.ok) {
      throw new Error(blameNativeAws(applied.message, stackVm.native));
    }
    const output = (key: string) => {
      const value = applied.outputs[key];
      return typeof value === 'string' ? value : '';
    };
    const made: StackVmSettings['made'] = {
      imageId: output(STACK_VM_OUTPUTS.imageId),
      pins: generated.pins,
      instanceId: output(STACK_VM_OUTPUTS.instanceId),
      privateIp: output(STACK_VM_OUTPUTS.privateIp),
      dataVolumeId: output(STACK_VM_OUTPUTS.dataVolumeId),
      zone: output(STACK_VM_OUTPUTS.zone),
    };
    await this.record(found.composeId, stackVm, made);
    await log(
      `${name}'s Stack VM is made from image ${made.imageId}; on its first boot it installs Docker ${made.pins.dockerEngine} and compose ${made.pins.composePlugin}`,
    );
    await this.awaitFirstBoot(found, control, log, 'Session Manager');
  }

  /**
   * Until the Stack VM answers through its tunnel and its first boot is
   * done: Session Manager knows an instance only once its agent has started,
   * IAP reaches it only once its sshd listens, and Docker is there only once
   * cloud-init has run. Bounded, and ended by the run's own signal.
   */
  private async awaitFirstBoot(
    found: Compose,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
    tunnel: 'Session Manager' | 'IAP',
  ): Promise<void> {
    const target = runTargetOn(found, { remoteExec: this.remoteExec });
    const deadline = Date.now() + FIRST_BOOT_WAIT_MS;
    const ended = new AbortController();
    control.signal.onInterrupt(() => ended.abort());
    control.signal.onKill(() => ended.abort());
    await log(
      `Waiting for ${found.configName}'s Stack VM to answer through ${tunnel} and finish its first boot`,
    );
    for (;;) {
      try {
        await target.exec('cloud-init status --wait >/dev/null 2>&1 || true', {
          signal: ended.signal,
        });
        await log(`${found.configName}'s Stack VM is ready`);
        return;
      } catch (error) {
        if (
          ended.signal.aborted ||
          !isConnectionFailure(error) ||
          Date.now() >= deadline
        ) {
          throw error;
        }
      }
      await new Promise((settle) => setTimeout(settle, FIRST_BOOT_RETRY_MS));
    }
  }

  /** The stack's first Deployment onto the Stack VM this run made. */
  private async deployOnto(row: Deployment, composeId: string): Promise<void> {
    // A stack the console created is often made before its compose file
    // is written (#1372): nothing to deploy until the operator writes it.
    const [stack] = await this.db
      .select({
        sourceType: compose.sourceType,
        composeFile: compose.composeFile,
      })
      .from(compose)
      .where(eq(compose.composeId, composeId));
    if (stack?.sourceType === 'raw' && stack.composeFile.trim() === '') {
      await this.cloudRuns.appendLog(
        row.logPath,
        'Its compose file is still empty, so nothing is deployed yet; write it on the stack page, then Deploy',
      );
      return;
    }
    const queued = await this.deployments.deployComposeOnItsStackVm(composeId, {
      title: 'Plan applied',
      description: 'Queued once its Stack VM was made',
    });
    await this.cloudRuns.appendLog(
      row.logPath,
      `Deployment ${queued.deploymentId} deploys the stack onto its Stack VM`,
    );
  }

  /**
   * What the run made, recorded in the stack's settings: an approved
   * replace's pins now the ones it was made with, and the replace done.
   */
  private async record(
    composeId: string,
    stackVm: StackVmSettings,
    made: NonNullable<StackVmSettings['made']>,
  ): Promise<void> {
    const recorded: StackVmSettings = { ...stackVm, made };
    delete (recorded as { replaceWith?: unknown }).replaceWith;
    await this.db
      .update(compose)
      .set({ stackVm: recorded })
      .where(eq(compose.composeId, composeId));
  }

  private async setStatus(
    composeId: string,
    status: ApplicationStatus,
  ): Promise<void> {
    await this.db
      .update(compose)
      .set({ composeStatus: status })
      .where(eq(compose.composeId, composeId));
  }
}
