import type { DeployableCompose } from '../../src/compose/compose.types';
import type { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import type { DeployableApplication } from '../../src/deployment-engine/deployment-engine.types';
import type { CloudRunsService } from '../../src/deployment-queue/cloud-runs.service';
import { DeploymentProcessor } from '../../src/deployment-queue/deployment-processor';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';

const makeDeps = () => {
  const application = {
    applicationId: 'app-1',
    appName: 'shop-api-x1',
  } as unknown as DeployableApplication;
  const composeStack = {
    composeId: 'compose-1',
    appName: 'wp-stack',
  } as unknown as DeployableCompose;
  const engine = {
    deploy: jest.fn().mockResolvedValue(undefined),
    deployCompose: jest.fn().mockResolvedValue(undefined),
  };
  const applications = {
    findDeployable: jest.fn().mockResolvedValue(application),
  };
  const composes = {
    findDeployable: jest.fn().mockResolvedValue(composeStack),
  };
  const previews = { deployPreview: jest.fn().mockResolvedValue(undefined) };
  const cloudRuns = { handOff: jest.fn().mockResolvedValue(undefined) };
  const processor = new DeploymentProcessor(
    engine as unknown as DeploymentEngineService,
    applications,
    composes,
    previews,
    cloudRuns as unknown as CloudRunsService,
  );
  return {
    cloudRuns,
    application,
    composeStack,
    engine,
    applications,
    composes,
    previews,
    processor,
  };
};

describe('DeploymentProcessor', () => {
  it("hands a cloud Service's row to the Cloud run pool once its build is done, and a Server's never", async () => {
    const { application, engine, cloudRuns, processor } = makeDeps();
    const job: DeploymentJob = {
      applicationType: 'application',
      applicationId: 'app-1',
      deploymentId: 'dep-1',
      type: 'deploy',
      title: 'Plan applied',
      description: '',
    };
    engine.deploy.mockResolvedValue(true);

    await processor.process(job);
    expect(cloudRuns.handOff).not.toHaveBeenCalled();

    Object.assign(application, {
      cloudAccountId: 'ca-1',
      region: 'eu-central-1',
      environmentId: 'env-1',
    });
    await processor.process(job);
    expect(cloudRuns.handOff).toHaveBeenCalledWith('dep-1', {
      kind: 'deploy',
      stateKey: 'application:app-1',
      environmentId: 'env-1',
      touchesNetwork: false,
    });

    // A build that never ran (its row was settled first) hands nothing on.
    cloudRuns.handOff.mockClear();
    engine.deploy.mockResolvedValue(false);
    await processor.process(job);
    expect(cloudRuns.handOff).not.toHaveBeenCalled();
  });

  it('deploys the loaded application when processing an application deploy job, under the Deployment its job names', async () => {
    const { application, engine, processor } = makeDeps();
    const job: DeploymentJob = {
      applicationType: 'application',
      applicationId: 'app-1',
      deploymentId: 'dep-1',
      type: 'deploy',
      title: 'Manual deployment',
      description: 'Triggered from the UI',
    };

    await processor.process(job);

    expect(engine.deploy).toHaveBeenCalledWith(application, {
      title: 'Manual deployment',
      description: 'Triggered from the UI',
      deploymentId: 'dep-1',
    });
  });

  it('redeploys through the engine as well (rebuild-without-clone lands later)', async () => {
    const { application, engine, processor } = makeDeps();
    const job: DeploymentJob = {
      applicationType: 'application',
      applicationId: 'app-1',
      deploymentId: 'dep-2',
      type: 'redeploy',
      title: 'Redeploy',
      description: '',
    };

    await processor.process(job);

    expect(engine.deploy).toHaveBeenCalledWith(application, {
      title: 'Redeploy',
      description: '',
      deploymentId: 'dep-2',
    });
  });

  it("dispatches preview jobs to the preview deployer, under the parent's Deployment its job names", async () => {
    const { engine, previews, processor } = makeDeps();
    const job: DeploymentJob = {
      applicationType: 'application-preview',
      applicationId: 'app-1',
      previewDeploymentId: 'preview-1',
      deploymentId: 'dep-4',
      type: 'deploy',
      title: 'Preview Deployment',
      description: 'Pull request #42',
    };

    await processor.process(job);

    expect(previews.deployPreview).toHaveBeenCalledWith('preview-1', {
      title: 'Preview Deployment',
      description: 'Pull request #42',
      deploymentId: 'dep-4',
    });
    // Preview deploys go through the deployer (which owns the appName/branch
    // override and the PR comment), never straight to the engine.
    expect(engine.deploy).not.toHaveBeenCalled();
  });

  it('deploys the loaded compose stack when processing a compose job, under the Deployment its job names', async () => {
    const { composeStack, engine, processor } = makeDeps();
    const job: DeploymentJob = {
      applicationType: 'compose',
      composeId: 'compose-1',
      deploymentId: 'dep-3',
      type: 'deploy',
      title: 'Deploy stack',
      description: '',
    };

    await processor.process(job);

    expect(engine.deployCompose).toHaveBeenCalledWith(composeStack, {
      title: 'Deploy stack',
      description: '',
      deploymentId: 'dep-3',
    });
    expect(engine.deploy).not.toHaveBeenCalled();
  });
});
