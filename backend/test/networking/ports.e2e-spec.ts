import { ForbiddenException, NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { z } from 'zod';
import { ApplicationsService } from '../../src/applications/applications.service';
import { generateConfigContainer } from '../../src/deployment-engine/mechanize';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { createPortSchema } from '../../src/networking/ports/dto/port.dto';
import { PortsService } from '../../src/networking/ports/ports.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionCtx } from '../../src/rbac/permission.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

/** The owner's bootstrap organization plus a service-seam permission ctx. */
async function setUpOwner(server: App) {
  const ownerSession = await signUp(server, owner);

  const orgs = await request(server)
    .get('/organizations')
    .set('Cookie', ownerSession.cookie);
  const organizationId = (orgs.body as { id: string }[])[0].id;

  return { organizationId, owner: ownerSession };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/** Invites a user into the owner's organization and accepts as them. */
async function inviteUser(
  server: App,
  ownerCookie: string,
  email: string,
  role: 'admin' | 'member',
): Promise<{ cookie: string; id: string }> {
  const invite = await request(server)
    .post('/organizations/invitations')
    .set('Cookie', ownerCookie)
    .send({ email, role });
  const inviteId = (invite.body as { id: string }).id;

  const su = await request(server)
    .post('/api/auth/sign-up/email')
    .set('x-cloudgate-token', inviteId)
    .send({ name: 'Ida Rhodes', email, password: 'super-secret-password' });
  const cookie = su.headers['set-cookie'];
  const id = (su.body as { user: { id: string } }).user.id;

  const accept = await request(server)
    .post(`/organizations/invitations/${inviteId}/accept`)
    .set('Cookie', cookie);
  expect(accept.status).toBe(201);

  return { cookie, id };
}

describe('Ports (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let ports: PortsService;

  /**
   * Publishes a port from a request-shaped fixture. `protocol` and
   * `publishMode` carry zod `.default()`s, so they are optional on the
   * schema's *input* and required on its output — and `CreatePortDto` is
   * typed from the output. Fixtures that omit them stand in for an HTTP
   * caller that omits them, so they are typed from the input and put through
   * the schema here, exactly as the ZodValidationPipe does before a request
   * body reaches the service.
   */
  const createPort = (
    permCtx: PermissionCtx,
    data: z.input<typeof createPortSchema>,
  ) => ports.create(permCtx, createPortSchema.parse(data));

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    ports = ctx.app.get(PortsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  /** An owner ctx plus a project + environment + application to attach ports to. */
  async function setUpApplication() {
    const { organizationId, owner: ownerSession } = await setUpOwner(server);
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const application = await applications.create(ownerCtx, {
      name: 'Blog',
      appName: 'blog-app',
      environmentId: environment.environmentId,
    });
    return {
      organizationId,
      ownerSession,
      ownerCtx,
      project,
      environment,
      application,
    };
  }

  describe('create → findOne', () => {
    it('creates a port retrievable with tcp and ingress as the input defaults', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const created = await createPort(ownerCtx, {
        publishedPort: 8080,
        targetPort: 3000,
        applicationId: application.applicationId,
      });

      expect(created.portId).toEqual(expect.any(String));
      expect(created.protocol).toBe('tcp');
      expect(created.publishMode).toBe('ingress');

      const found = await ports.findOne(ownerCtx, created.portId);
      expect(found).toMatchObject({
        portId: created.portId,
        publishedPort: 8080,
        targetPort: 3000,
        applicationId: application.applicationId,
      });
    });
  });

  describe('listByApplication', () => {
    it('lists the published ports of one application only', async () => {
      const { ownerCtx, application, environment } = await setUpApplication();
      const other = await applications.create(ownerCtx, {
        name: 'Shop',
        appName: 'shop-app',
        environmentId: environment.environmentId,
      });
      await createPort(ownerCtx, {
        publishedPort: 8080,
        targetPort: 3000,
        applicationId: application.applicationId,
      });
      await createPort(ownerCtx, {
        publishedPort: 5353,
        targetPort: 53,
        protocol: 'udp',
        applicationId: application.applicationId,
      });
      await createPort(ownerCtx, {
        publishedPort: 9090,
        targetPort: 9090,
        applicationId: other.applicationId,
      });

      const listed = await ports.listByApplication(ownerCtx, {
        applicationId: application.applicationId,
      });
      expect(
        listed.map((row) => row.publishedPort).sort((a, b) => a - b),
      ).toEqual([5353, 8080]);
    });

    it('lists nothing for an application with no published ports', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await expect(
        ports.listByApplication(ownerCtx, {
          applicationId: application.applicationId,
        }),
      ).resolves.toEqual([]);
    });
  });

  describe('published-port service spec', () => {
    it('maps port rows into the deployable EndpointSpec', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await createPort(ownerCtx, {
        publishedPort: 8080,
        targetPort: 3000,
        applicationId: application.applicationId,
      });
      await createPort(ownerCtx, {
        publishedPort: 5353,
        targetPort: 53,
        protocol: 'udp',
        publishMode: 'host',
        applicationId: application.applicationId,
      });

      const deployable = await applications.findDeployable(
        application.applicationId,
      );
      const { EndpointSpec } = generateConfigContainer(deployable);

      expect(EndpointSpec).toEqual({
        Ports: [
          {
            Protocol: 'tcp',
            TargetPort: 3000,
            PublishedPort: 8080,
            PublishMode: 'ingress',
          },
          {
            Protocol: 'udp',
            TargetPort: 53,
            PublishedPort: 5353,
            PublishMode: 'host',
          },
        ],
      });
    });

    it('lets an endpointSpecSwarm override beat the port rows', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await createPort(ownerCtx, {
        publishedPort: 8080,
        targetPort: 3000,
        applicationId: application.applicationId,
      });
      await applications.update(ownerCtx, application.applicationId, {
        endpointSpecSwarm: {
          Ports: [{ TargetPort: 9000, PublishedPort: 9999 }],
        },
      });

      const deployable = await applications.findDeployable(
        application.applicationId,
      );
      const { EndpointSpec } = generateConfigContainer(deployable);

      expect(EndpointSpec).toEqual({
        Ports: [
          {
            Protocol: 'tcp',
            TargetPort: 9000,
            PublishedPort: 9999,
            PublishMode: 'host',
          },
        ],
      });
    });

    it('reflects update and remove in the spec', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const first = await createPort(ownerCtx, {
        publishedPort: 8080,
        targetPort: 3000,
        applicationId: application.applicationId,
      });
      const second = await createPort(ownerCtx, {
        publishedPort: 5353,
        targetPort: 53,
        protocol: 'udp',
        applicationId: application.applicationId,
      });

      const updated = await ports.update(ownerCtx, first.portId, {
        publishedPort: 9090,
        publishMode: 'host',
      });
      expect(updated).toMatchObject({
        publishedPort: 9090,
        publishMode: 'host',
        targetPort: 3000,
      });

      await ports.remove(ownerCtx, second.portId);
      await expect(ports.findOne(ownerCtx, second.portId)).rejects.toThrow(
        NotFoundException,
      );

      const deployable = await applications.findDeployable(
        application.applicationId,
      );
      const { EndpointSpec } = generateConfigContainer(deployable);
      expect(EndpointSpec).toEqual({
        Ports: [
          {
            Protocol: 'tcp',
            TargetPort: 3000,
            PublishedPort: 9090,
            PublishMode: 'host',
          },
        ],
      });
    });
  });

  describe('row-level access', () => {
    it('denies a member without row access to the parent application', async () => {
      const { organizationId, ownerSession, ownerCtx, application } =
        await setUpApplication();
      const member = await inviteUser(
        server,
        ownerSession.cookie,
        'ida@example.com',
        'member',
      );
      const memberCtx = permissionCtx(member.id, organizationId);

      await expect(
        createPort(memberCtx, {
          publishedPort: 8080,
          targetPort: 3000,
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(ForbiddenException);

      const created = await createPort(ownerCtx, {
        publishedPort: 8080,
        targetPort: 3000,
        applicationId: application.applicationId,
      });
      await expect(ports.findOne(memberCtx, created.portId)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(ports.remove(memberCtx, created.portId)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        ports.listByApplication(memberCtx, {
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('hides ports and parents from other organizations', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const created = await createPort(ownerCtx, {
        publishedPort: 8080,
        targetPort: 3000,
        applicationId: application.applicationId,
      });

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );

      await expect(ports.findOne(secondOrgCtx, created.portId)).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        createPort(secondOrgCtx, {
          publishedPort: 8081,
          targetPort: 3000,
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(NotFoundException);
      // Another organization's application reads as absent, not forbidden.
      await expect(
        ports.listByApplication(secondOrgCtx, {
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('HTTP surface', () => {
    it('creates, lists, updates and deletes a port through the controller', async () => {
      const { ownerSession, application } = await setUpApplication();

      const invalid = await request(server)
        .post('/ports')
        .set('Cookie', ownerSession.cookie)
        .send({ applicationId: application.applicationId, publishedPort: 0 });
      expect(invalid.status).toBe(400);

      const created = await request(server)
        .post('/ports')
        .set('Cookie', ownerSession.cookie)
        .send({
          publishedPort: 8080,
          targetPort: 3000,
          applicationId: application.applicationId,
        });
      expect(created.status).toBe(201);
      const { portId } = created.body as { portId: string };

      const listed = await request(server)
        .get('/ports')
        .query({ applicationId: application.applicationId })
        .set('Cookie', ownerSession.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      expect((listed.body as { portId: string }[])[0].portId).toBe(portId);

      const unscoped = await request(server)
        .get('/ports')
        .set('Cookie', ownerSession.cookie);
      expect(unscoped.status).toBe(400);

      const found = await request(server)
        .get(`/ports/${portId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({ publishedPort: 8080 });

      const updated = await request(server)
        .patch(`/ports/${portId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ protocol: 'udp' });
      expect(updated.status).toBe(200);
      expect((updated.body as { protocol: string }).protocol).toBe('udp');

      const removed = await request(server)
        .delete(`/ports/${portId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/ports/${portId}`)
        .set('Cookie', ownerSession.cookie);
      expect(gone.status).toBe(404);

      const emptied = await request(server)
        .get('/ports')
        .query({ applicationId: application.applicationId })
        .set('Cookie', ownerSession.cookie);
      expect(emptied.status).toBe(200);
      expect(emptied.body).toEqual([]);
    });

    it('reads another organization application as absent', async () => {
      const { ownerSession, application } = await setUpApplication();

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;
      const switched = await request(server)
        .post('/api/auth/organization/set-active')
        .set('Cookie', ownerSession.cookie)
        .send({ organizationId: secondOrgId });
      expect(switched.status).toBe(200);

      const listed = await request(server)
        .get('/ports')
        .query({ applicationId: application.applicationId })
        .set('Cookie', ownerSession.cookie);
      expect(listed.status).toBe(404);
    });
  });
});
