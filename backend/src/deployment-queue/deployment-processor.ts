import { Inject, Injectable } from '@nestjs/common';
import type { DeployableCompose } from '../compose/compose.types';
import { cloudDeployKind, runsInCloud } from '../deployment-engine/cloud-build';
import { DeploymentEngineService } from '../deployment-engine/deployment-engine.service';
import { CloudRunsService } from './cloud-runs.service';
import type { DeployableApplication } from '../deployment-engine/deployment-engine.types';
import { ownDeploymentId } from './job-types';
import type { DeploymentJob } from './job-types';

export const DEPLOYABLE_APPLICATIONS = Symbol('DEPLOYABLE_APPLICATIONS');
export const DEPLOYABLE_COMPOSES = Symbol('DEPLOYABLE_COMPOSES');
export const PREVIEW_DEPLOYMENTS = Symbol('PREVIEW_DEPLOYMENTS');

/**
 * Loads an application with the relations the deploy engine consumes
 * (decrypted registry credentials included). Jobs carry only ids so the row
 * is read fresh at process time; the real loader lands with Phase 23's
 * trigger path.
 */
export interface DeployableApplications {
  findDeployable(applicationId: string): Promise<DeployableApplication>;
}

/** The compose sibling of {@link DeployableApplications} (Phase 29). */
export interface DeployableComposes {
  findDeployable(composeId: string): Promise<DeployableCompose>;
}

/**
 * Deploys a preview (Phase 25) — owns the appName/branch override and the PR
 * comment, so preview jobs never hit the engine directly.
 */
export interface PreviewDeployer {
  deployPreview(
    previewDeploymentId: string,
    meta?: { title?: string; description?: string; deploymentId?: string },
  ): Promise<void>;
}

/**
 * The queue worker. Dispatches each job to the deployment engine by its type.
 */
@Injectable()
export class DeploymentProcessor {
  constructor(
    private readonly engine: DeploymentEngineService,
    @Inject(DEPLOYABLE_APPLICATIONS)
    private readonly applications: DeployableApplications,
    @Inject(DEPLOYABLE_COMPOSES)
    private readonly composes: DeployableComposes,
    @Inject(PREVIEW_DEPLOYMENTS)
    private readonly previews: PreviewDeployer,
    private readonly cloudRuns: CloudRunsService,
  ) {}

  async process(job: DeploymentJob): Promise<void> {
    const meta = { title: job.title, description: job.description };
    // The row the engine claims; a remote job names none.
    const deploymentId = ownDeploymentId(job) ?? undefined;
    switch (job.applicationType) {
      case 'application': {
        // 'redeploy' also goes through deploy: rebuilding without a fresh
        // clone lands with the deployments phase.
        const application = await this.applications.findDeployable(
          job.applicationId,
        );
        const built = await this.engine.deploy(application, {
          ...meta,
          deploymentId,
        });
        // A cloud Service's build is done; the rest of its Deployment
        // waits in the Cloud run pool, and this build slot is free for the
        // next build meanwhile.
        if (built && deploymentId && runsInCloud(application)) {
          await this.cloudRuns.handOff(deploymentId, {
            // A static site's files are uploaded, not an image pushed.
            kind: cloudDeployKind(application),
            stateKey: `application:${application.applicationId}`,
            environmentId: application.environmentId,
            touchesNetwork: false,
          });
        }
        return;
      }
      case 'application-preview':
        // Under the parent's Deployment its job names.
        await this.previews.deployPreview(job.previewDeploymentId, {
          ...meta,
          deploymentId,
        });
        return;
      case 'compose': {
        const compose = await this.composes.findDeployable(job.composeId);
        await this.engine.deployCompose(compose, { ...meta, deploymentId });
        return;
      }
    }
  }
}
