import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types';

import {
  application,
  deployment,
  projectConfigLocation,
  webServerSettings,
} from '../../src/db/schema';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  JobState,
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
import { createTestApp } from '../utils/test-app';
import type { TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

interface PlanBody {
  planId: string;
  status: string;
  steps: Record<string, unknown>[];
}

/** The deployment queue as a list: a queued job is asserted, never run. */
class ListQueue implements QueuePort {
  jobs: QueuedJob[] = [];
  private next = 0;

  add(data: DeploymentJob): Promise<QueuedJob> {
    const job: QueuedJob = { id: `job-${++this.next}`, data, state: 'waiting' };
    this.jobs.push(job);
    return Promise.resolve({ ...job });
  }

  getJobs(states?: JobState[]): Promise<QueuedJob[]> {
    return Promise.resolve(
      this.jobs.filter((job) => !states || states.includes(job.state)),
    );
  }

  cancel(): Promise<boolean> {
    return Promise.resolve(false);
  }

  clearWaiting(): Promise<QueuedJob[]> {
    return Promise.resolve([]);
  }
}

/**
 * A config entry built from a subfolder of a **Project folder**
 * (`source: { folder: apps/web }`, ADR-0080): a plan creates it with the
 * uploaded-files source and that subfolder as its build path, and a changed
 * folder is a change of its `source`. The deployment queue is the boundary.
 */
describe('Plans of a folder source (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let projectId: string;
  let environmentId: string;

  const queue = new ListQueue();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: DEPLOYMENT_QUEUE, useValue: queue }],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    queue.jobs = [];
    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');

    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;

    const environment = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name: 'production', projectId });
    expect(environment.status).toBe(201);
    environmentId = (environment.body as { environmentId: string })
      .environmentId;

    // The platform host's address, which a created web's Domain carries.
    await ctx.db.insert(webServerSettings).values({ serverIp: '198.51.100.7' });
  });

  /** Writes the stored Cloudgate-kept text, as an applied edit does. */
  async function storeConfig(text: string) {
    await ctx.db
      .update(projectConfigLocation)
      .set({ text })
      .where(eq(projectConfigLocation.projectId, projectId));
  }

  const askForPlan = () =>
    request(server)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);

  const apply = (planId: string) =>
    request(server)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

  const folderWeb = (folder: string) => `version: 1
services:
  web:
    kind: web
    source:
      folder: ${folder}
`;

  const savedWeb = async () => {
    const [row] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.environmentId, environmentId));
    return row;
  };

  it('creates the app with the uploaded-files source and the folder as its build path, then plans nothing', async () => {
    await storeConfig(folderWeb('apps/web'));

    const asked = await askForPlan();

    expect(asked.status).toBe(201);
    const open = asked.body as PlanBody;
    expect(open.steps).toEqual([
      expect.objectContaining({
        action: 'create',
        configName: 'web',
        kind: 'web',
        fields: expect.arrayContaining([
          { field: 'source', from: null, to: { folder: 'apps/web' } },
        ]) as unknown,
      }),
    ]);

    const applied = await apply(open.planId);

    expect(applied.status).toBe(200);
    expect((applied.body as PlanBody).status).toBe('applied');
    expect(await savedWeb()).toMatchObject({
      configName: 'web',
      configKind: 'web',
      sourceType: 'drop',
      dropBuildPath: 'apps/web',
    });

    const again = await askForPlan();
    expect((again.body as PlanBody).steps).toEqual([]);
  });

  it('changes the folder as a change of source, writing the new build path', async () => {
    await storeConfig(folderWeb('apps/web'));
    const created = await askForPlan();
    expect((await apply((created.body as PlanBody).planId)).status).toBe(200);

    await storeConfig(folderWeb('apps/site'));
    const asked = await askForPlan();

    const open = asked.body as PlanBody;
    expect(open.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'web',
        fields: [
          {
            field: 'source',
            from: { folder: 'apps/web' },
            to: { folder: 'apps/site' },
          },
        ],
      }),
    ]);

    const applied = await apply(open.planId);

    expect(applied.status).toBe(200);
    expect(await savedWeb()).toMatchObject({
      sourceType: 'drop',
      dropBuildPath: 'apps/site',
    });
    expect(((await askForPlan()).body as PlanBody).steps).toEqual([]);
  });

  it('queues no Deployment for a folder-source app no upload has reached, at its create or at a change', async () => {
    await storeConfig(folderWeb('apps/web'));
    const created = await askForPlan();

    const applied = await apply((created.body as PlanBody).planId);

    expect(applied.status).toBe(200);
    expect((applied.body as PlanBody).status).toBe('applied');
    expect(queue.jobs).toEqual([]);
    expect(
      await ctx.db
        .select({ id: deployment.deploymentId })
        .from(deployment)
        .where(eq(deployment.applicationId, (await savedWeb()).applicationId)),
    ).toEqual([]);

    // A change before any upload: still nothing on the build host to build.
    await storeConfig(folderWeb('apps/site'));
    const changed = await askForPlan();
    expect((await apply((changed.body as PlanBody).planId)).status).toBe(200);

    expect(queue.jobs).toEqual([]);
    const deploy = await request(server)
      .post(`/applications/${(await savedWeb()).applicationId}/deployments`)
      .set('Cookie', cookie)
      .send({ title: 'by hand' });
    expect(deploy.status).toBe(409);
    expect((deploy.body as { message: string }).message).toContain(
      'no files have been uploaded',
    );
  });

  it('queues no Plan-applied Deployment of an uploaded folder-source app when the root deploy builds it next', async () => {
    await storeConfig(folderWeb('apps/web'));
    const created = await askForPlan();
    expect((await apply((created.body as PlanBody).planId)).status).toBe(200);
    // A root deploy's upload has reached it.
    await ctx.db
      .update(application)
      .set({ dropUploaded: true })
      .where(eq(application.applicationId, (await savedWeb()).applicationId));

    await storeConfig(`version: 1
services:
  web:
    kind: web
    source:
      folder: apps/web
    build:
      type: dockerfile
      dockerfile: web.Dockerfile
`);
    const changed = await askForPlan();
    const applied = await request(server)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({
        planId: (changed.body as PlanBody).planId,
        folderSourcesDeployedNext: true,
      });

    expect(applied.status).toBe(200);
    expect((applied.body as PlanBody).status).toBe('applied');
    // The previous upload is not rebuilt under the new settings: the root
    // deploy uploads and builds it straight after.
    expect(queue.jobs).toEqual([]);
    expect(await savedWeb()).toMatchObject({
      buildType: 'dockerfile',
      dockerfile: 'web.Dockerfile',
    });
  });

  it('still queues the Plan-applied Deployment of an uploaded folder-source app when nothing builds it next', async () => {
    await storeConfig(folderWeb('apps/web'));
    const created = await askForPlan();
    expect((await apply((created.body as PlanBody).planId)).status).toBe(200);
    await ctx.db
      .update(application)
      .set({ dropUploaded: true })
      .where(eq(application.applicationId, (await savedWeb()).applicationId));

    await storeConfig(`version: 1
services:
  web:
    kind: web
    source:
      folder: apps/web
    port: 4000
`);
    const changed = await askForPlan();
    expect((await apply((changed.body as PlanBody).planId)).status).toBe(200);

    expect(queue.jobs).toHaveLength(1);
  });

  it('forgets the uploaded files once the source moves off them, so going back to a folder builds nothing stale', async () => {
    await storeConfig(folderWeb('apps/web'));
    const created = await askForPlan();
    expect((await apply((created.body as PlanBody).planId)).status).toBe(200);
    // A root deploy's upload has reached it.
    await ctx.db
      .update(application)
      .set({ dropUploaded: true })
      .where(eq(application.applicationId, (await savedWeb()).applicationId));

    await storeConfig(`version: 1
services:
  web:
    kind: web
    source:
      image: nginx:1.27
`);
    const toImage = await askForPlan();
    expect((await apply((toImage.body as PlanBody).planId)).status).toBe(200);

    expect(await savedWeb()).toMatchObject({
      sourceType: 'docker',
      dropUploaded: false,
    });

    await storeConfig(folderWeb('apps/web'));
    const back = await askForPlan();
    expect((await apply((back.body as PlanBody).planId)).status).toBe(200);
    const deploy = await request(server)
      .post(`/applications/${(await savedWeb()).applicationId}/deployments`)
      .set('Cookie', cookie)
      .send({ title: 'by hand' });
    expect(deploy.status).toBe(409);
    expect((deploy.body as { message: string }).message).toContain(
      'no files have been uploaded',
    );
  });

  it('refuses a folder combined with a repository, naming the entry', async () => {
    await storeConfig(`version: 1
services:
  web:
    kind: web
    source:
      folder: apps/web
      github: acme/shop
`);

    const asked = await askForPlan();

    expect(asked.status).toBe(409);
    expect((asked.body as { message: string }).message).toContain(
      'web.source names a subfolder of the Project folder, so folder cannot be combined with github',
    );
    expect(await savedWeb()).toBeUndefined();
  });
});
