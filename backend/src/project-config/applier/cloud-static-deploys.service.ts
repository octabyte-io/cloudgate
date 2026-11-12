import { rm } from 'node:fs/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq, sql } from 'drizzle-orm';

import { ApplicationsService } from '../../applications/applications.service';
import { DEPLOYMENTS_PREFIX } from '../../cloud-accounts/aws/definitions/static-definition';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import { onCloud } from '../../cloud-accounts/cloud-provider';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { application, deployment, rollback } from '../../db/schema';
import type { Application, Deployment } from '../../db/schema';
import { staticUploadDirectory } from '../../deployment-engine/deployment-engine.paths';
import { CloudReadWorks } from '../../deployment-queue/cloud-read-work';
import type {
  CloudRunControl,
  CloudRunJob,
} from '../../deployment-queue/cloud-run-job.types';
import { CloudRunsService } from '../../deployment-queue/cloud-runs.service';
import { DeploymentsService } from '../../deployments/deployments.service';
import type {
  FolderRemoval,
  StaticRollbackRunner,
} from '../../rollbacks/static-rollback-runner.port';
import { describeError } from '../../common/describe-error';
import { AwsStaticDeploys } from './aws-static-deploys.service';
import { GoogleStaticDeploys } from './google-static-deploys.service';
import { cleanUpFolders } from './static-folders';
import { counted } from './static-place';
import type { StaticHalf, StaticServing, StaticSite } from './static-place';
import { elapsed, STATIC_SPREAD_CLOCK } from './static-spread';
import type { SpreadClock } from './static-spread';

/** The site's row, when it has the columns a static site in a Cloud account has. */
function staticSiteOf(found: Application): StaticSite | null {
  if (!found.cloudAccountId || !found.region || !found.cloudBucketName) {
    return null;
  }
  return {
    found,
    name: found.configName ?? found.appName,
    region: found.region,
    bucket: found.cloudBucketName,
  };
}

/** What every step of a run reads, once. */
interface Site {
  site: StaticSite;
  folders: StaticHalf['folders'];
  serving: StaticServing;
}

/** The size of an upload, as the log says it. */
function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * **A `static` site's Deployment** (the AWS buckets spec "Landing"; per
 * cloud): the `static-deploy` Cloud run that follows its checkout.
 *
 * The build slot checks the source out on the platform host, applies its
 * patches and copies `publish` aside into the Deployment's own upload
 * folder (`staticUploadDirectory`); nothing is built and nothing goes to a
 * registry. The queue then hands the row to the Cloud run pool, and this
 * runs it on the platform host, so no cloud credential reaches a Server.
 * What is the same on every cloud is here; how a folder goes live and how
 * the CDN learns of it is the cloud's half (`static-place.ts`), chosen by
 * the cloud seam (ADR-0043) — on AWS, `AwsStaticDeploys`:
 *
 * 1. **Upload** the folder to `deployments/<deployment id>/` in the site's
 *    own bucket. Until here the run may be cancelled: nothing a visitor
 *    sees has changed.
 * 2. **Go live**: the half makes that folder the one visitors are served.
 * 3. **Settle**: the half's CDN learns of it, within the static
 *    Deployment's cap (`STATIC_DEPLOY_CAP_MS`).
 * 4. **Clean up**: every folder that is neither in use, as the half says,
 *    nor a rollback point is deleted, so a failed Deployment's
 *    half-uploaded folder does not pile up.
 *
 * With rollbacks on, going live also makes the folder a **rollback point**
 * a `rollback` row naming it, kept until the point is removed.
 * A **Rollback** is a `static-rollback` run of the same Service state, so
 * it queues with the pushes' runs and never races their switch: a
 * Deployment of its own that builds and uploads nothing and runs steps 2
 * to 4 on the point's folder, restoring files only.
 *
 * What it does is read from the Deployment row and the Application, so a
 * run start-up queues again runs alike; a run cut off by a restart ends
 * `error` by the Cloud run rules, and the next Deployment picks up.
 * On Google Cloud that holds for a copy into `live/` cut off partway: each
 * copy lists `live/` again, so the next run, or one still queued at
 * start-up and queued again, runs the copy again from what is there.
 */
@Injectable()
export class CloudStaticDeploys implements OnModuleInit, StaticRollbackRunner {
  private readonly logger = new Logger(CloudStaticDeploys.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(STATIC_SPREAD_CLOCK) private readonly clock: SpreadClock,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly applications: ApplicationsService,
    private readonly deployments: DeploymentsService,
    private readonly onAws: AwsStaticDeploys,
    private readonly onGoogle: GoogleStaticDeploys,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** The pool lives in the queue module, which this module cannot import. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  onModuleInit(): void {
    const works = this.moduleRef.get(CloudReadWorks, { strict: false });
    works.handle('static-deploy', (job, control) => this.run(job, control));
    // A Rollback runs steps 2 to 4 on a rollback point's folder.
    works.handle('static-rollback', (job, control) => this.run(job, control));
  }

  /**
   * Records a Rollback to `folder` as a Deployment of the Service and queues
   * it under the Service's state, `application:<id>`, the key a push's
   * `static-deploy` runs under: the pool never runs two runs of one state at
   * once, so a Rollback's switch and a push's never race, and go in the
   * order they reached the queue.
   */
  async queue(input: {
    applicationId: string;
    folder: string;
    title: string;
    description: string;
  }): Promise<string> {
    const [app] = await this.db
      .select({
        appName: application.appName,
        environmentId: application.environmentId,
      })
      .from(application)
      .where(eq(application.applicationId, input.applicationId));
    if (!app) throw new Error('The Service is gone');
    const row = await this.deployments.recordApplicationCloudRun({
      applicationId: input.applicationId,
      appName: app.appName,
      title: input.title,
      description: input.description,
    });
    void this.cloudRuns
      .submit(row.deploymentId, {
        kind: 'static-rollback',
        stateKey: `application:${input.applicationId}`,
        environmentId: app.environmentId,
        touchesNetwork: false,
        rollbackFolder: input.folder,
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Rollback ${row.deploymentId} failed to settle: ${describeError(error)}`,
        ),
      );
    return row.deploymentId;
  }

  /**
   * Deletes a removed rollback point's folder from the site's bucket
   * unless visitors are served it now: then it stays, and the
   * clean-up of the next Deployment that goes live elsewhere removes it,
   * since no point spares it any more.
   */
  async removeFolder(input: {
    applicationId: string;
    folder: string;
  }): Promise<FolderRemoval> {
    const [found] = await this.db
      .select()
      .from(application)
      .where(eq(application.applicationId, input.applicationId));
    const site = found ? staticSiteOf(found) : null;
    if (!site) return { ok: true, kept: false };
    if (site.found.cloudLiveFolder === input.folder) {
      return { ok: true, kept: true };
    }
    try {
      const half = await this.halfOf(site);
      if (!half) {
        return {
          ok: false,
          message: 'the Cloud account this Service runs in is gone',
        };
      }
      const gone = await half.folders.delete(
        `${DEPLOYMENTS_PREFIX}${input.folder}/`,
      );
      return gone.ok
        ? { ok: true, kept: false }
        : { ok: false, message: gone.message };
    } catch (error) {
      return { ok: false, message: describeError(error) };
    }
  }

  private async run(job: CloudRunJob, control: CloudRunControl) {
    const [row] = await this.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, job.deploymentId ?? ''));
    if (!row?.applicationId) {
      throw new Error('This Cloud run records no Service');
    }
    try {
      if (job.kind === 'static-rollback') {
        const folder = row.cloudRun?.rollbackFolder;
        if (!folder) {
          throw new Error(
            'This Rollback names no rollback point to go back to',
          );
        }
        await this.rollBack(row, row.applicationId, folder, control);
      } else {
        await this.deploy(row, row.applicationId, control);
      }
      await this.applications.updateStatus(row.applicationId, 'done');
    } catch (error) {
      await this.applications
        .updateStatus(row.applicationId, 'error')
        .catch(() => undefined);
      throw error;
    } finally {
      // Its copy of `publish` is uploaded or never will be: a run is never
      // run again by itself, and the next Deployment copies its own. A
      // Rollback copied nothing.
      if (job.kind === 'static-deploy') await this.removeUploadCopy(row);
    }
  }

  private async removeUploadCopy(row: Deployment): Promise<void> {
    const [found] = await this.db
      .select({ appName: application.appName })
      .from(application)
      .where(eq(application.applicationId, row.applicationId ?? ''));
    if (!found) return;
    await rm(staticUploadDirectory(found.appName, row.deploymentId), {
      recursive: true,
      force: true,
    }).catch((error: unknown) =>
      this.logger.warn(
        `The upload folder of ${row.deploymentId} was not removed: ${describeError(error)}`,
      ),
    );
  }

  /**
   * The cloud's half for the site (ADR-0043): S3 + CloudFront on AWS, Cloud
   * Storage + Cloud CDN on Google Cloud. `null` when the Cloud
   * account is gone.
   */
  private async halfOf(site: StaticSite): Promise<StaticHalf | null> {
    const accountId = site.found.cloudAccountId;
    const cloudAccountRow = accountId
      ? await this.cloudAccounts.findForUse(accountId)
      : null;
    if (!cloudAccountRow) return null;
    return onCloud(cloudAccountRow, {
      aws: (account) => this.onAws.halfOf(site, account),
      gcp: (account) => this.onGoogle.halfOf(site, account),
    });
  }

  /** What every step reads: the site, its cloud's half and how it is served. */
  private async siteOf(applicationId: string): Promise<Site> {
    const [found] = await this.db
      .select()
      .from(application)
      .where(eq(application.applicationId, applicationId));
    if (!found) throw new Error('The Service is gone');
    const site = staticSiteOf(found);
    if (!site) {
      throw new Error(
        `${found.configName ?? found.appName} is not a static site in a Cloud account`,
      );
    }
    const half = await this.halfOf(site);
    if (!half) {
      throw new Error('The Cloud account this Service runs in is gone');
    }
    return { site, folders: half.folders, serving: half.serving() };
  }

  /** A push's run: steps 1 to 4. */
  private async deploy(
    row: Deployment,
    applicationId: string,
    control: CloudRunControl,
  ): Promise<void> {
    const log = (line: string) => this.cloudRuns.appendLog(row.logPath, line);
    const started = this.clock.now();
    const one = await this.siteOf(applicationId);
    const { site, folders, serving } = one;
    const { found, name } = site;
    const folder = row.deploymentId;
    const prefix = `${DEPLOYMENTS_PREFIX}${folder}/`;
    const directory = staticUploadDirectory(found.appName, row.deploymentId);

    await log(
      `☁️ [Cloud run] Deploying ${name} to ${serving.place}: its files go to ${site.bucket}, ${serving.servedBy}`,
    );

    // 1. Upload: nothing a visitor sees changes until it goes live.
    await log(`📤 [Upload] Uploading the files to ${folders.where(prefix)}`);
    const uploadStarted = this.clock.now();
    const uploaded = await folders.upload({ directory, prefix }, started);
    if (!uploaded.ok) {
      throw new Error(
        `The files could not be uploaded to ${site.bucket}: ${uploaded.message}. The site still serves its previous version`,
      );
    }
    await log(
      `✅ [Upload] Uploaded ${counted(uploaded.files, 'file')} (${sizeOf(uploaded.bytes)}) in ${elapsed(this.clock.now() - uploadStarted)}`,
    );

    await this.goLive(row, one, folder, { started, control, log });
    await log(`✅ [Cloud run] ${name} serves the files of this Deployment`);
    await log(
      `🏁 [Cloud run] Done after ${elapsed(this.clock.now() - started)}`,
    );
  }

  /**
   * A Rollback's run (the AWS buckets spec "Rollback"): steps 2 to 4 on a
   * rollback point's folder, which is there to go back to, since every
   * clean-up spares it. Nothing is built or uploaded, and the site's
   * settings are not touched, so it comes back to that Deployment's files
   * and stays as the Project config says. It takes no rollback point of its
   * own.
   */
  private async rollBack(
    row: Deployment,
    applicationId: string,
    folder: string,
    control: CloudRunControl,
  ): Promise<void> {
    const log = (line: string) => this.cloudRuns.appendLog(row.logPath, line);
    const started = this.clock.now();
    const one = await this.siteOf(applicationId);
    const { site, folders, serving } = one;
    const { name } = site;
    await log(
      `⏪ [Rollback] Rolling ${name} back to the files of Deployment ${folder} on ${serving.place}. Nothing is built or uploaded, and ${serving.settings} stay as the Project config says`,
    );
    const listed = await folders.list(DEPLOYMENTS_PREFIX);
    if (!listed.ok) {
      throw new Error(
        `The folders of ${site.bucket} could not be listed (${listed.message}), so this version's files could not be found. The site still serves its current version`,
      );
    }
    if (!listed.folders.includes(folder)) {
      throw new Error(
        `This version's files are no longer in ${site.bucket} (${DEPLOYMENTS_PREFIX}${folder}/), so there is nothing to go back to. The site still serves its current version`,
      );
    }
    await log(
      `📁 [Files] This version's files are in ${folders.where(`${DEPLOYMENTS_PREFIX}${folder}/`)}`,
    );
    await this.goLive(row, one, folder, {
      started,
      control,
      log,
      capture: false,
    });
    await log(
      `✅ [Cloud run] ${name} serves the files of Deployment ${folder} again`,
    );
    await log(
      `🏁 [Cloud run] Done after ${elapsed(this.clock.now() - started)}`,
    );
  }

  /**
   * Steps 2 to 4: make `folder` live, settle, clean up. A push's run with
   * rollbacks on also makes `folder` a rollback point once it is live
   * before the clean-up, which then spares it.
   */
  private async goLive(
    row: Deployment,
    { site, folders, serving }: Site,
    folder: string,
    {
      started,
      control,
      log,
      capture = true,
    }: {
      started: number;
      control: CloudRunControl;
      log: (line: string) => Promise<void>;
      capture?: boolean;
    },
  ): Promise<void> {
    const { found } = site;

    // 2. Go live: from here the Deployment has changed what visitors see.
    if (!control.beginApply()) {
      throw new Error('The run was ended before it changed anything');
    }
    if (serving.cutOff) {
      // What a restart that cuts it off from here ends the row with.
      await this.db
        .update(deployment)
        .set({
          cloudRun: sql`${deployment.cloudRun} || ${JSON.stringify({ cutOff: serving.cutOff })}::jsonb`,
        })
        .where(eq(deployment.deploymentId, row.deploymentId));
    }
    await serving.goLive({ folder, startedAt: started, control, log });
    if (capture && found.rollbackActive) {
      await this.db
        .insert(rollback)
        .values({ deploymentId: row.deploymentId, folder });
    }

    // 3. Settle: the CDN learns of it.
    const inUse = await serving.settle({
      deploymentId: row.deploymentId,
      folder,
      startedAt: started,
      control,
      log,
    });

    // 4. Clean up the folders that are neither in use nor a rollback point.
    await cleanUpFolders(
      this.db,
      folders,
      { applicationId: found.applicationId, ...inUse },
      log,
    );
  }
}
