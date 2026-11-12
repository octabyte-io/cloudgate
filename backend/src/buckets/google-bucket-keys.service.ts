import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';

import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import { googleAccountOf } from '../cloud-accounts/cloud-provider';
import {
  GCP_BUCKET_OUTPUTS,
  gcpBucketDefinition,
  gcpBucketKeyAddress,
  otherKeySlot,
} from '../cloud-accounts/gcp/definitions/bucket-definition';
import type {
  GcpBucketKeys,
  GcpBucketKeySlot,
} from '../cloud-accounts/gcp/definitions/bucket-definition';
import { readGooglePlan } from '../cloud-accounts/gcp/plan-reader/read-plan';
import { InfrastructureStatesService } from '../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { describeError } from '../common/describe-error';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { bucket, deployment } from '../db/schema';
import { CloudReadWorks } from '../deployment-queue/cloud-read-work';
import type {
  CloudRunControl,
  CloudRunJob,
} from '../deployment-queue/cloud-run-job.types';
import {
  CloudRunsService,
  endingDescription,
} from '../deployment-queue/cloud-runs.service';
import { DeploymentsService } from '../deployments/deployments.service';
import { checkBeforeApply } from '../project-config/applier/cloud-deploy-steps';
import {
  applyOnGoogle,
  googleRunProof,
  outputText,
} from '../project-config/applier/google-apply';
import type { Bucket, BucketKey } from './bucket.schema';
import { googleKeyLayout } from './google-key-layout';

/**
 * One `tofu` apply of a key run: the bucket's definition with `keys`,
 * limited to the key in `slot`, which may only be `action`ed (or left as
 * it is, for a run taken again after a restart).
 */
interface KeyStep {
  readonly keys: GcpBucketKeys;
  readonly slot: GcpBucketKeySlot;
  readonly action: 'create' | 'destroy';
}

/** What one key run does, held for its handler until the pool runs it. */
interface KeyRun {
  readonly steps: readonly KeyStep[];
  /** Read the spare slot's key from the outputs once it has applied. */
  readonly answersSpare: boolean;
}

/**
 * **A bucket on Cloud Storage's half of Rotate key** (spec
 * "Key rotation copies a Server", ADR-0037, ADR-0043): what Garage does for
 * a Server bucket, done by `tofu` on the bucket's own Infrastructure state,
 * so that its state always holds the keys that exist and the next plan shows
 * no change to them.
 *
 * The state has two key slots ({@link GcpBucketKeySlot}); the live key is in
 * one of them ({@link googleKeyLayout}).
 *
 * - **A new key** is made in the other slot, beside the live one, by
 *   applying the definition holding both, limited to the new one. A key a
 *   past rotation left there (a stray) is destroyed first, in the same run.
 * - **The old key**, once every linking Service runs with the new one, is
 *   destroyed in its slot by applying the definition holding only the new
 *   one, limited to the old one; the stored key's slot moves with it.
 *   Google's provider turns a key off before deleting it.
 * - **The new key**, after a failed rotation put every Service back, is
 *   destroyed the same way, the definition holding only the live key.
 *
 * Each is a short Cloud run of the bucket, a Deployment with a log beside
 * its creates and changes, waiting on the bucket's state in the pool; its
 * plan may touch only that one key, so Drift anywhere else refuses it with
 * nothing applied. A run the pool queues again after a restart does nothing
 * and fails: the rotation, which a restart picks up, runs it again. A
 * rotation a restart cut off before its new key was stored destroys what
 * the other slot may hold ({@link removeUnstored}).
 */
@Injectable()
export class GoogleBucketKeys implements OnModuleInit {
  private readonly logger = new Logger(GoogleBucketKeys.name);
  /** What each recorded key run does, until the pool runs it. */
  private readonly runs = new Map<string, KeyRun>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly deployments: DeploymentsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** The pool lives in the queue module, which this module cannot import. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  onModuleInit(): void {
    this.moduleRef
      .get(CloudReadWorks, { strict: false })
      .handle('bucket-key', (job, control) => this.run(job, control));
  }

  /**
   * The new key, in the slot the live one is not in, after destroying a
   * stray there; answers it with the strays left, none. Throws, naming why,
   * when the run did not make it.
   */
  async make(
    found: Bucket,
  ): Promise<{ key: BucketKey; strayKeyIds: readonly string[] }> {
    const layout = googleKeyLayout(found);
    const slot = otherKeySlot(layout.live);
    const steps: KeyStep[] = [
      ...(layout.spare
        ? [
            {
              keys: { live: layout.live, spare: false },
              slot,
              action: 'destroy' as const,
            },
          ]
        : []),
      { keys: { live: layout.live, spare: true }, slot, action: 'create' },
    ];
    const value = await this.submit(
      found,
      {
        title: 'Make a new key',
        description: `Rotate key: makes a new HMAC key for ${found.configName}'s own service account beside the one in use${layout.spare ? ', after destroying the key a past rotation left' : ''}`,
      },
      { steps, answersSpare: true },
    );
    return { key: value as BucketKey, strayKeyIds: [] };
  }

  /**
   * Destroys the live key once every linking Service runs with the new one;
   * answers the ids it could not destroy. The new key's slot is then the
   * stored key's: {@link storedSlot}.
   */
  async removeOld(found: Bucket, keyIds: readonly string[]): Promise<string[]> {
    const layout = googleKeyLayout(found);
    return this.remove(found, keyIds, {
      title: 'Remove the old key',
      description: `Rotate key: every Service linking ${found.configName} runs with the new key, so the old one is turned off and deleted`,
      step: {
        keys: { live: otherKeySlot(layout.live), spare: false },
        slot: layout.live,
        action: 'destroy',
      },
    });
  }

  /** Destroys the new key once a failed rotation put every Service back. */
  async removeNew(found: Bucket, keyIds: readonly string[]): Promise<string[]> {
    const layout = googleKeyLayout(found);
    return this.remove(found, keyIds, {
      title: 'Remove the new key',
      description: `Rotate key: a redeploy failed and every Service linking ${found.configName} is back on the old key, so the new one is turned off and deleted`,
      step: {
        keys: { live: layout.live, spare: false },
        slot: otherKeySlot(layout.live),
        action: 'destroy',
      },
    });
  }

  /**
   * After a restart cut a rotation off before its new key was stored
   * the key its Make a new key run may have made is in the other
   * slot, unknown to the row, so it is destroyed there, the definition
   * holding only the live key — a plan with nothing to destroy changes
   * nothing — and the next plan shows no Drift. A slot that holds a stray
   * the row knows is left as it is: the next rotation destroys what it
   * holds first. Answers whether nothing unknown is left.
   */
  async removeUnstored(found: Bucket): Promise<boolean> {
    const layout = googleKeyLayout(found);
    if (layout.spare) return true;
    await this.cloudRuns.settledAtStartUp();
    const left = await this.remove(found, ['the unstored key'], {
      title: 'Remove the unstored key',
      description: `Rotate key: a restart cut the rotation of ${found.configName} off before its new key was stored, so a key it may have made is turned off and deleted`,
      step: {
        keys: { live: layout.live, spare: false },
        slot: otherKeySlot(layout.live),
        action: 'destroy',
      },
    });
    return left.length === 0;
  }

  /** The slot the new key is in, the stored key's once a rotation succeeded. */
  storedSlot(found: Bucket): GcpBucketKeySlot {
    return otherKeySlot(googleKeyLayout(found).live);
  }

  private async remove(
    found: Bucket,
    keyIds: readonly string[],
    run: { title: string; description: string; step: KeyStep },
  ): Promise<string[]> {
    if (keyIds.length === 0) return [];
    try {
      await this.submit(found, run, { steps: [run.step], answersSpare: false });
      return [];
    } catch (error) {
      this.logger.warn(
        `${found.appName}: a key was not removed from Cloud Storage — ${describeError(error)}`,
      );
      return [...keyIds];
    }
  }

  /** Records the run, waits in the pool for it to end, and answers its value. */
  private async submit(
    found: Bucket,
    input: { title: string; description: string },
    run: KeyRun,
  ): Promise<unknown> {
    const record = await this.deployments.recordBucketCloudRun({
      bucketId: found.bucketId,
      appName: found.appName,
      title: input.title,
      description: input.description,
    });
    this.runs.set(record.deploymentId, run);
    try {
      const ending = await this.cloudRuns.submit(record.deploymentId, {
        kind: 'bucket-key',
        stateKey: `bucket:${found.bucketId}`,
        environmentId: found.environmentId,
        touchesNetwork: false,
      });
      if (ending.kind === 'finished') return ending.value;
      throw new Error(
        endingDescription(ending) ?? 'The key run ended before it finished',
      );
    } finally {
      this.runs.delete(record.deploymentId);
    }
  }

  private async run(
    job: CloudRunJob,
    control: CloudRunControl,
  ): Promise<BucketKey | null> {
    const run = this.runs.get(job.deploymentId ?? '');
    if (!run) {
      throw new Error(
        "This key run was cut off by a restart before it started; the bucket's Rotate key runs it again",
      );
    }
    const [row] = await this.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, job.deploymentId ?? ''));
    if (!row) throw new Error('This key run has no Deployment');
    const log = (line: string) => this.cloudRuns.appendLog(row.logPath, line);
    const found = await this.bucketOf(row.bucketId);
    const accountRow = await this.cloudAccounts.findForUse(
      found.cloudAccountId!,
    );
    if (!accountRow) {
      throw new Error('The Cloud account this bucket is in is gone');
    }
    const account = googleAccountOf(accountRow);
    const state = await this.states.findForBucket(found.bucketId);
    if (!state)
      throw new Error(`${found.configName} has no Infrastructure state`);
    const proof = await googleRunProof(this.cloudAccounts, account);

    let outputs: Record<string, unknown> = {};
    for (const step of run.steps) {
      const address = gcpBucketKeyAddress(step.slot);
      await log(
        `☁️ [Cloud run] ${step.action === 'create' ? 'Making a new key' : 'Turning off and deleting a key'} (${address}) for ${found.configName} in Cloud account ${account.name}, Infrastructure state ${state.infrastructureStateId}`,
      );
      outputs = await applyOnGoogle(this.states, account, proof, {
        stateId: state.infrastructureStateId,
        definition: gcpBucketDefinition({
          serviceId: found.bucketId,
          bucketName: found.bucketName,
          cloudAccountId: account.cloudAccountId,
          projectId: account.cloudId,
          region: found.region!,
          environmentId: found.environmentId,
          stateId: state.infrastructureStateId,
          // What its page holds, as its last Cloud run wrote it: the plan is
          // limited to the key, so neither is applied.
          origins: found.appliedOrigins ?? found.origins,
          keys: step.keys,
          // An existing bucket's state holds only its account and keys.
          existing: found.existing,
        }),
        targets: [address],
        onLine: (line) => void log(line),
        signal: control.signal,
        beforeApply: (show) =>
          checkBeforeApply(
            show,
            (reading) => onlyTheKey(reading.raw, address, step.action),
            () => control.beginApply(),
            [],
            (fresh) =>
              readGooglePlan({ show: fresh, nameSearch: [], context: {} }),
          ),
      });
    }
    if (!run.answersSpare) {
      await log(`✅ [Cloud run] The key is turned off and deleted`);
      return null;
    }
    const output = (name: string) => outputText(outputs, name);
    const accessKeyId = output(GCP_BUCKET_OUTPUTS.spareAccessKeyId);
    const secretAccessKey = output(GCP_BUCKET_OUTPUTS.spareSecretAccessKey);
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('Google did not answer the new key');
    }
    await log(
      `✅ [Cloud run] A new key is made beside the one in use; the linking Services are redeployed with it next`,
    );
    return { accessKeyId, secretAccessKey };
  }

  private async bucketOf(bucketId: string | null): Promise<Bucket> {
    const [found] = await this.db
      .select()
      .from(bucket)
      .where(eq(bucket.bucketId, bucketId ?? ''));
    if (!found?.cloudAccountId || !found.region) {
      throw new Error('This key run records no bucket on Cloud Storage');
    }
    return found;
  }
}

/**
 * A key run's plan may `action` its one key, or leave it as it is (a run
 * taken again after a restart), and touch nothing else: anything more is a
 * change or Drift an operator sees in a plan first.
 */
function onlyTheKey(
  raw: readonly { address: string; action: string }[],
  address: string,
  action: 'create' | 'destroy',
): string | null {
  const other = raw.filter(
    (line) => line.address !== address || line.action !== action,
  );
  return other.length === 0
    ? null
    : `Rotating the key would also ${other.map((line) => `${line.action} ${line.address}`).join('; ')}. Nothing was applied; Check for changes, apply the plan it shows, then rotate the key again`;
}
