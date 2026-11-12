import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { CertificatesService } from '../../src/certificates/certificates.service';
import {
  certificate,
  licenseKey,
  member,
  organizationRole,
  server as serverTable,
} from '../../src/db/schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import {
  secondOrganizationOwner,
  signUpMember,
  createOrganization,
} from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const selfSigned = {
  name: 'wildcard-example-com',
  certificateData:
    '-----BEGIN CERTIFICATE-----\nMIIBszCCAVo=\n-----END CERTIFICATE-----',
  privateKey:
    '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBM=\n-----END PRIVATE KEY-----',
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

describe('Certificates (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let certificates: CertificatesService;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
    writeCertificate: jest.fn(),
    removeCertificate: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: TraefikWriterService, useValue: traefikWriterMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    certificates = ctx.app.get(CertificatesService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
  });

  describe('create → findOne', () => {
    it('stores a certificate retrievable by id, private key encrypted at rest and stripped from responses', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await certificates.create(ownerCtx, selfSigned);

      expect(created.certificateId).toEqual(expect.any(String));
      expect(created.organizationId).toBe(organizationId);
      expect(created.certificatePath).toMatch(/^certificate-/);
      expect(created).not.toHaveProperty('privateKey');

      const found = await certificates.findOne(ownerCtx, created.certificateId);
      expect(found).toMatchObject({
        certificateId: created.certificateId,
        name: 'wildcard-example-com',
        certificateData: selfSigned.certificateData,
        certificatePath: created.certificatePath,
        organizationId,
      });
      expect(found).not.toHaveProperty('privateKey');

      const raw = await ctx.db.$client.query<{ private_key: string }>(
        'select private_key from certificate where certificate_id = $1',
        [created.certificateId],
      );
      expect(raw.rows[0].private_key).not.toContain('BEGIN PRIVATE KEY');
      expect(raw.rows[0].private_key.startsWith('enc:v1:')).toBe(true);
    });

    it('writes the cert files into the traefik certs dir on create', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await certificates.create(ownerCtx, selfSigned);

      expect(traefikWriterMock.writeCertificate).toHaveBeenCalledTimes(1);
      expect(traefikWriterMock.writeCertificate).toHaveBeenCalledWith(
        expect.objectContaining({
          certificatePath: created.certificatePath,
          certificateData: selfSigned.certificateData,
          privateKey: selfSigned.privateKey,
          serverId: null,
        }),
      );
    });

    /**
     * This route had no lookup of any kind: `serverId` went straight into
     * the insert, where the foreign key answered 500 for an id in another
     * organization or none. It is worse here than on the sibling creates,
     * because `certificate.serverId` also decides which host
     * `writeCertificate` materializes the PEM on — so an unowned id was a
     * write attempt against another organization's machine, not only a 500.
     *
     * The negative is the assertion: nothing was written on the way to being
     * refused.
     */
    it('refuses a serverId in another organization before any PEM material is written', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      // A real `server` row in a second organization, not an id nothing owns —
      // one lookup raises the same NotFound whichever predicate misses, so a
      // dangling id cannot tell a passing organization check from one that
      // never ran.
      const other = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'other-tenant', slug: `other-${Date.now()}` },
      );
      const [theirs] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'not-yours',
          ipAddress: '203.0.113.31',
          port: 22,
          organizationId: (other.body as { id: string }).id,
        })
        .returning();

      await expect(
        certificates.create(ownerCtx, {
          ...selfSigned,
          serverId: theirs.serverId,
        }),
      ).rejects.toThrow(new NotFoundException('Server not found'));

      expect(traefikWriterMock.writeCertificate).not.toHaveBeenCalled();
      expect(await certificates.list(ownerCtx)).toHaveLength(0);
    });

    it('refuses an unknown serverId with the same 404 over HTTP', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const res = await request(server)
        .post('/certificates')
        .set('Cookie', ownerSession.cookie)
        .send({ ...selfSigned, serverId: 'w03nonexistentid00000' });

      expect(res.status).toBe(404);
      expect((res.body as { message: string }).message).toBe(
        'Server not found',
      );
      expect(traefikWriterMock.writeCertificate).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('lists the organization certificates newest first, keys stripped', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await certificates.create(ownerCtx, { ...selfSigned, name: 'older' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await certificates.create(ownerCtx, { ...selfSigned, name: 'newer' });

      const listed = await certificates.list(ownerCtx);
      expect(listed.map((c) => c.name)).toEqual(['newer', 'older']);
      for (const item of listed) {
        expect(item).not.toHaveProperty('privateKey');
      }
    });
  });

  describe('update', () => {
    it('changes the given fields and rewrites the files only when the PEM material changes', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await certificates.create(ownerCtx, selfSigned);
      jest.clearAllMocks();

      const renamed = await certificates.update(
        ownerCtx,
        created.certificateId,
        { name: 'renamed' },
      );
      expect(renamed).toMatchObject({
        certificateId: created.certificateId,
        name: 'renamed',
      });
      expect(renamed).not.toHaveProperty('privateKey');
      expect(traefikWriterMock.writeCertificate).not.toHaveBeenCalled();

      const rotatedKey =
        '-----BEGIN PRIVATE KEY-----\nROTATED=\n-----END PRIVATE KEY-----';
      const rotated = await certificates.update(
        ownerCtx,
        created.certificateId,
        { privateKey: rotatedKey },
      );
      expect(rotated).not.toHaveProperty('privateKey');
      expect(traefikWriterMock.writeCertificate).toHaveBeenCalledTimes(1);
      expect(traefikWriterMock.writeCertificate).toHaveBeenCalledWith(
        expect.objectContaining({
          certificatePath: created.certificatePath,
          certificateData: selfSigned.certificateData,
          privateKey: rotatedKey,
        }),
      );

      const raw = await ctx.db.$client.query<{ private_key: string }>(
        'select private_key from certificate where certificate_id = $1',
        [created.certificateId],
      );
      expect(raw.rows[0].private_key).not.toContain('ROTATED');
      expect(raw.rows[0].private_key.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('remove', () => {
    it('deletes the certificate and drops its files from the certs dir', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await certificates.create(ownerCtx, selfSigned);

      const removed = await certificates.remove(
        ownerCtx,
        created.certificateId,
      );
      expect(removed.certificateId).toBe(created.certificateId);
      expect(removed).not.toHaveProperty('privateKey');

      expect(traefikWriterMock.removeCertificate).toHaveBeenCalledWith(
        created.certificatePath,
        null,
      );
      await expect(
        certificates.findOne(ownerCtx, created.certificateId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * `create` inserted the row and *then* wrote the PEM pair into the
   * Traefik certs dir, so a host that could not take the files answered 500
   * and kept a certificate whose material does not exist — one Traefik will
   * never serve and whose `certificatePath` names an empty directory. The
   * insert is now the last thing that can fail.
   */
  describe('a create whose PEM material cannot be written', () => {
    it('writes the certificate files before the row exists', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      // Read the table from inside the write, which is the only moment the
      // ordering is observable: an insert-then-write create passes every
      // after-the-fact assertion this file makes.
      let rowsDuringWrite: unknown[] | undefined;
      let writtenPath: string | undefined;
      traefikWriterMock.writeCertificate.mockImplementationOnce(
        async (cert: { certificatePath: string }) => {
          rowsDuringWrite = await ctx.db.select().from(certificate);
          writtenPath = cert.certificatePath;
        },
      );

      const created = await certificates.create(ownerCtx, selfSigned);

      expect(rowsDuringWrite).toHaveLength(0);
      // The certificatePath the files went to is the one that landed: it is
      // minted in the service now, not by the column default.
      expect(writtenPath).toBe(created.certificatePath);
      expect(await ctx.db.select().from(certificate)).toHaveLength(1);
    });

    it('leaves no certificate row when the files cannot be written', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      traefikWriterMock.writeCertificate.mockRejectedValueOnce(
        new Error('EACCES: permission denied, mkdir'),
      );

      await expect(certificates.create(ownerCtx, selfSigned)).rejects.toThrow(
        'EACCES',
      );

      // Nothing was written on the way to being refused.
      expect(await ctx.db.select().from(certificate)).toHaveLength(0);
      expect(await certificates.list(ownerCtx)).toHaveLength(0);
    });
  });

  /**
   * This service gated nothing: `create` had no permission call at all,
   * and neither did `list`, `findOne`, `update` or `remove`. The controller's
   * `@RequirePermission` decorators mean the HTTP routes were covered by
   * `PermissionsGuard`, so every assertion here goes through the *service*
   * seam — which is what `TemplatesService`, `AiService` and every future
   * in-process caller reach, and what the sibling creates (`applications`,
   * `compose`, the six database engines) have always checked for themselves.
   *
   * The fixture is a licensed custom role rather than the organization's own
   * owner, deliberately. `certificate` is in `enterpriseOnlyResources`, so
   * `PermissionService.checkPermission` returns early for owner and admin —
   * an owner-fixtured test cannot tell a passing gate from an absent one, and
   * this repo has shipped that assertion shape green twice.
   */
  describe('permission gating', () => {
    /**
     * Puts an accepted member on a licensed custom role holding exactly
     * `permission`. The enterprise path is the only one where a role's
     * statements come off `organization_role` rows, so it is the only way to
     * express "may create a certificate but not read one" — the static roles
     * cannot: owner and admin bypass the resource outright and `memberRole`
     * carries `certificate: []`.
     */
    async function setUpCustomRole(permission: Record<string, string[]>) {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const invitee = await signUpMember(server, ownerSession.cookie);

      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db
        .insert(organizationRole)
        .values({ organizationId, role: 'cert-operator', permission });
      await ctx.db
        .update(member)
        .set({ role: 'cert-operator' })
        .where(
          and(
            eq(member.userId, invitee.id),
            eq(member.organizationId, organizationId),
          ),
        );

      return {
        organizationId,
        ownerSession,
        ownerCtx: permissionCtx(ownerSession.id, organizationId),
        roleCtx: permissionCtx(invitee.id, organizationId),
      };
    }

    it('refuses a create to a role that does not hold certificate create', async () => {
      const { roleCtx } = await setUpCustomRole({ certificate: ['read'] });

      await expect(certificates.create(roleCtx, selfSigned)).rejects.toThrow(
        ForbiddenException,
      );

      // Nothing was written on the way to being refused.
      expect(traefikWriterMock.writeCertificate).not.toHaveBeenCalled();
      expect(await ctx.db.select().from(certificate)).toHaveLength(0);
    });

    it('refuses a create before it looks the serverId up', async () => {
      const { ownerSession, roleCtx } = await setUpCustomRole({
        certificate: ['read'],
      });
      const other = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'other-tenant', slug: `other-${Date.now()}` },
      );
      const [theirs] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'not-yours',
          ipAddress: '203.0.113.31',
          port: 22,
          organizationId: (other.body as { id: string }).id,
        })
        .returning();

      // `checkServerAccess` would answer 404 for this serverId. The
      // permission gate runs first, so the refusal is the 403 — the order
      // `databases/common/database-service.ts`'s createDatabase uses.
      await expect(
        certificates.create(roleCtx, {
          ...selfSigned,
          serverId: theirs.serverId,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses a read, an update and a delete to a role holding only create', async () => {
      const { ownerCtx, roleCtx } = await setUpCustomRole({
        certificate: ['create'],
      });
      const created = await certificates.create(ownerCtx, selfSigned);

      await expect(certificates.list(roleCtx)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        certificates.findOne(roleCtx, created.certificateId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        certificates.update(roleCtx, created.certificateId, { name: 'theirs' }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        certificates.remove(roleCtx, created.certificateId),
      ).rejects.toThrow(ForbiddenException);

      // The refusals cost the certificate nothing.
      const [row] = await ctx.db
        .select()
        .from(certificate)
        .where(eq(certificate.certificateId, created.certificateId));
      expect(row.name).toBe('wildcard-example-com');
      expect(traefikWriterMock.removeCertificate).not.toHaveBeenCalled();
    });

    /**
     * ADR-0013's third consequence, on this surface: *"a licensed custom
     * role can be granted it"*, so no statement can carry the platform host.
     * This is the strongest caller the host branch had — stronger than another
     * organization's owner, because the operator granted this role the create
     * on purpose — and it is still refused, with the instance sentence rather
     * than a statement refusal.
     */
    it('refuses a role holding certificate create the platform host, however licensed', async () => {
      const { roleCtx } = await setUpCustomRole({ certificate: ['create'] });

      await expect(certificates.create(roleCtx, selfSigned)).rejects.toThrow(
        new ForbiddenException(
          'Only an owner or admin of the instance organization can configure the platform host',
        ),
      );

      // Nothing was written on the way to being refused.
      expect(traefikWriterMock.writeCertificate).not.toHaveBeenCalled();
      expect(await ctx.db.select().from(certificate)).toHaveLength(0);
    });

    it('allows all four operations to a role that holds them', async () => {
      const { organizationId, roleCtx } = await setUpCustomRole({
        certificate: ['read', 'create', 'update', 'delete'],
      });
      // On a **Server** of this organization's own rather than the platform
      // host: now the host branch takes instance authority on top of the
      // statement (see the test above), and what is under test here is the
      // statement — so the target is one a statement is allowed to decide.
      const [ours] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'ours',
          ipAddress: '203.0.113.7',
          port: 22,
          organizationId,
        })
        .returning();

      const created = await certificates.create(roleCtx, {
        ...selfSigned,
        serverId: ours.serverId,
      });
      expect(await certificates.list(roleCtx)).toHaveLength(1);
      expect(
        (await certificates.findOne(roleCtx, created.certificateId)).name,
      ).toBe('wildcard-example-com');
      expect(
        (
          await certificates.update(roleCtx, created.certificateId, {
            name: 'renamed',
          })
        ).name,
      ).toBe('renamed');
      await certificates.remove(roleCtx, created.certificateId);
      expect(await ctx.db.select().from(certificate)).toHaveLength(0);
    });
  });

  describe('cross-org isolation', () => {
    it('a certificate is invisible and unmodifiable outside its own organization', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);
      const foreign = await certificates.create(secondOrgCtx, {
        ...selfSigned,
        name: 'org-b-only',
      });

      // Same user, but acting in the first organization: the second org's
      // certificate must not resolve, even for its creator.
      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        certificates.findOne(firstOrgCtx, foreign.certificateId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        certificates.update(firstOrgCtx, foreign.certificateId, {
          name: 'stolen',
        }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        certificates.remove(firstOrgCtx, foreign.certificateId),
      ).rejects.toThrow(NotFoundException);
      expect(await certificates.list(firstOrgCtx)).toEqual([]);
    });
  });

  /**
   * The **platform host's** certificate store, which is one Traefik's and not
   * an Organization's (ADR-0013).
   *
   * An earlier fix closed the named Server; the branch it left is a nullish `serverId`,
   * where `writeCertificate` lands a `tls.certificates` fragment the
   * console's own Traefik loads — the one that terminates TLS for every
   * organization's gated Domain, choosing by the SANs inside the material
   * rather than by which row asked for it. `certificate: ['create']` is held
   * outright by every organization's owner and admin, so before the fix the
   * first test answered **201** and wrote Mallory's key onto the shared host.
   *
   * Mallory rather than a second organization owned by the same user — the
   * fixture ADR-0013 asks for, and `patch-tenancy.e2e-spec.ts` states the
   * reason at length: a second organization of one's own carries that user's
   * instance-organization owner row with it, so it cannot tell "another
   * organization" from "another organization's *caller*".
   *
   * The **update** pair is the decision's fine print rather than a second copy
   * of the create: material takes the boundary because material is the write
   * into the shared dir; a rename does not, because the row is the
   * organization's own — which is what keeps an organization able to tidy a
   * host certificate it created before this check existed.
   */
  describe('the platform host store', () => {
    /** Mallory, plus a host certificate her Organization already owns. */
    async function setUpNeighbour() {
      const { owner: ownerSession } = await setUpOwner(server);
      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerSession.cookie,
        { organizationName: 'Neighbour Org' },
      );

      const [hers] = await ctx.db
        .insert(certificate)
        .values({
          name: 'neighbour-cert',
          certificateData: selfSigned.certificateData,
          privateKey: selfSigned.privateKey,
          organizationId: mallory.organizationId,
          serverId: null,
        })
        .returning();

      return { ownerSession, mallory, hers };
    }

    it("refuses another organization's owner a certificate on the platform host, and writes nothing", async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerSession.cookie,
        { organizationName: 'Neighbour Org' },
      );

      const refused = await request(server)
        .post('/certificates')
        .set('Cookie', mallory.cookie)
        .send(selfSigned);

      expect(refused.status).toBe(403);
      expect((refused.body as { message: string }).message).toBe(
        'Only an owner or admin of the instance organization can configure the platform host',
      );
      // She holds `certificate: ['create']` — she is an owner, of her own
      // Organization — so the statement gate passed and this is the only thing
      // that refused her. Nothing reached the certs dir.
      expect(traefikWriterMock.writeCertificate).not.toHaveBeenCalled();
      expect(await ctx.db.select().from(certificate)).toHaveLength(0);
    });

    it('refuses her new material on her own host certificate, and the row keeps the material the certs dir holds', async () => {
      const { mallory, hers } = await setUpNeighbour();

      const refused = await request(server)
        .patch(`/certificates/${hers.certificateId}`)
        .set('Cookie', mallory.cookie)
        .send({
          privateKey:
            '-----BEGIN PRIVATE KEY-----\nc3dhcHBlZA==\n-----END PRIVATE KEY-----',
        });

      expect(refused.status).toBe(403);
      expect(traefikWriterMock.writeCertificate).not.toHaveBeenCalled();
      // The check runs ahead of the row write, so nothing is left claiming
      // material the certs dir never took (the traversal failure, in reverse).
      const [row] = await ctx.db
        .select()
        .from(certificate)
        .where(eq(certificate.certificateId, hers.certificateId));
      expect(row.privateKey).toBe(selfSigned.privateKey);
    });

    it('lets her rename it, which touches no file', async () => {
      const { mallory, hers } = await setUpNeighbour();

      const renamed = await request(server)
        .patch(`/certificates/${hers.certificateId}`)
        .set('Cookie', mallory.cookie)
        .send({ name: 'her-own-name' });

      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ name: 'her-own-name' });
      expect(traefikWriterMock.writeCertificate).not.toHaveBeenCalled();
    });

    it('lets her delete it, since the directory it names is only ever its own', async () => {
      const { mallory, hers } = await setUpNeighbour();

      const removed = await request(server)
        .delete(`/certificates/${hers.certificateId}`)
        .set('Cookie', mallory.cookie);

      expect(removed.status).toBe(200);
      expect(traefikWriterMock.removeCertificate).toHaveBeenCalledWith(
        hers.certificatePath,
        null,
      );
      expect(await ctx.db.select().from(certificate)).toHaveLength(0);
    });
  });

  describe('HTTP endpoint surface', () => {
    it('supports the full CRUD round-trip over HTTP, never leaking the private key', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/certificates')
        .set('Cookie', cookie)
        .send(selfSigned);
      expect(created.status).toBe(201);
      expect(created.body).not.toHaveProperty('privateKey');
      const id = (created.body as { certificateId: string }).certificateId;

      const rejected = await request(server)
        .post('/certificates')
        .set('Cookie', cookie)
        .send({ ...selfSigned, name: '' });
      expect(rejected.status).toBe(400);

      const listed = await request(server)
        .get('/certificates')
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      const listedBody = listed.body as { name: string }[];
      expect(listedBody.map((c) => c.name)).toEqual(['wildcard-example-com']);
      expect(listedBody[0]).not.toHaveProperty('privateKey');

      const one = await request(server)
        .get(`/certificates/${id}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ name: 'wildcard-example-com' });
      expect(one.body).not.toHaveProperty('privateKey');

      const patched = await request(server)
        .patch(`/certificates/${id}`)
        .set('Cookie', cookie)
        .send({ name: 'renamed' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ name: 'renamed' });
      expect(patched.body).not.toHaveProperty('privateKey');

      const removed = await request(server)
        .delete(`/certificates/${id}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/certificates/${id}`)
        .set('Cookie', cookie);
      expect(gone.status).toBe(404);
    });
  });
});
