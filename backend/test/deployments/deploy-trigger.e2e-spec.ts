import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { application as applicationTable } from '../../src/applications/application.schema';
import { ApplicationsService } from '../../src/applications/applications.service';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/** Polls until the condition holds (the queue processes in the background). */
async function waitFor(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * The deploy trigger path end-to-end: DeploymentsService.deploy → real
 * in-memory queue → DeploymentProcessor → DEPLOYABLE_APPLICATIONS loader →
 * DeploymentEngineService.deploy (mocked at that boundary — building is
 * Phase 21's tested territory).
 */
describe('Deploy trigger path (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let deployments: DeploymentsService;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
  const engineMock = {
    deploy: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: DeploymentEngineService, useValue: engineMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    deployments = ctx.app.get(DeploymentsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    engineMock.deploy.mockReset().mockResolvedValue(undefined);
  });

  it('a triggered deploy reaches the engine with the loaded application', async () => {
    const signUp = await request(server).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers['set-cookie'];
    const userId = (signUp.body as { user: { id: string } }).user.id;

    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    };

    const projects = ctx.app.get(ProjectsService);
    const environments = ctx.app.get(EnvironmentsService);
    const applications = ctx.app.get(ApplicationsService);
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const application = await applications.create(ownerCtx, {
      name: 'Web App',
      appName: 'web-app',
      environmentId: environment.environmentId,
    });
    // A source, so the deploy is not refused as having none.
    await ctx.db
      .update(applicationTable)
      .set({ sourceType: 'docker', dockerImage: 'nginx:1.27' })
      .where(eq(applicationTable.applicationId, application.applicationId));

    const recorded = await deployments.deploy(
      ownerCtx,
      application.applicationId,
      { description: 'wired end to end' },
    );

    await waitFor(() => engineMock.deploy.mock.calls.length > 0);
    expect(engineMock.deploy).toHaveBeenCalledTimes(1);

    const [deployable, meta] = engineMock.deploy.mock.calls[0] as [
      {
        applicationId: string;
        appName: string;
        environment: { project: { organizationId: string } };
      },
      { title: string; description: string; deploymentId?: string },
    ];
    // The loader hands the engine the full relation tree it consumes.
    expect(deployable.applicationId).toBe(application.applicationId);
    expect(deployable.appName).toBe('web-app');
    expect(deployable.environment.project.organizationId).toBe(organizationId);
    // The engine claims the row this trigger recorded, and no other.
    expect(meta).toEqual({
      title: 'Manual deployment',
      description: 'wired end to end',
      deploymentId: recorded.deploymentId,
    });
  });
});
