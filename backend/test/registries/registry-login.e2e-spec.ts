import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { member } from '../../src/organizations/organizations.schema';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember } from '../utils/test-auth';
import {
  dockerLoginRefusal,
  installDockerLoginStub,
} from './docker-login-stub';
import type { DockerLoginStub } from './docker-login-stub';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** The one login the stub's registry accepts, htpasswd-style. */
const HOST = '127.0.0.1:5000';
const USER = 'cgui';
const RIGHT = 'right-registry-pass';
const WRONG = 'wrong-registry-pass';

/**
 * Testing a registry credential before a build finds out it is wrong.
 *
 * **What is real and what is not.** The route, the service, `RemoteExecService`
 * and the shell are all the production ones, and the program they run is the
 * one a Server would run. What stands in is the `docker` binary on this
 * process's `PATH` (`docker-login-stub.ts`): it answers the way a `registry:2`
 * behind htpasswd does — `Login Succeeded`, or the daemon's 401 line measured
 * against one — and records what it was handed. That is §1.7's boundary, and it
 * is what lets this suite assert the two things the route is careful about,
 * which a live registry could not show it: the password reached `docker` on
 * stdin and nowhere else, and no answer carries it back out.
 *
 * The live half — the same program against a real `registry:2` with
 * `REGISTRY_AUTH=htpasswd`, where the refusal line above was measured — was
 * run by hand rather than here: a registry container per e2e run is a
 * cost this harness has so far refused (see `test-db.ts` on the second
 * Postgres it stopped starting).
 */
describe('Registry login test (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let stub: DockerLoginStub;
  let realPath: string | undefined;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
    stub = installDockerLoginStub({ user: USER, password: RIGHT });
    // The probe's local branch spreads `process.env` into the child, so this
    // is the `PATH` its shell resolves `docker` on.
    realPath = process.env.PATH;
    process.env.PATH = `${stub.binDir}:${realPath ?? '/usr/bin:/bin'}`;
  });

  afterAll(async () => {
    process.env.PATH = realPath;
    stub?.remove();
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  async function signUpOwner(): Promise<string> {
    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    return res.headers['set-cookie'];
  }

  /** Nothing a refusal or an answer says may hold either password. */
  const expectNoPassword = (res: request.Response) => {
    const said = JSON.stringify(res.body) + res.text;
    expect(said).not.toContain(RIGHT);
    expect(said).not.toContain(WRONG);
  };

  describe('POST /registries/test-connection', () => {
    it("reports a wrong password with the registry's own refusal", async () => {
      const cookie = await signUpOwner();

      const res = await request(server)
        .post('/registries/test-connection')
        .set('Cookie', cookie)
        .send({ url: HOST, username: USER, password: WRONG });

      expect(res.status).toBe(400);
      // The sentence in plain words, docker's own answer as `output`.
      expect(res.body).toMatchObject({
        message: `${HOST} refused the username or password (401 Unauthorized).`,
        output: dockerLoginRefusal(HOST),
      });
      expectNoPassword(res);
    });

    it('passes a right password with an empty 204', async () => {
      const cookie = await signUpOwner();

      const res = await request(server)
        .post('/registries/test-connection')
        .set('Cookie', cookie)
        .send({ url: HOST, username: USER, password: RIGHT });

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
    });

    it('hands docker the password on stdin, never on its command line', async () => {
      const cookie = await signUpOwner();
      const before = stub.calls().length;

      await request(server)
        .post('/registries/test-connection')
        .set('Cookie', cookie)
        .send({ url: HOST, username: USER, password: RIGHT });

      const [call] = stub.calls().slice(before);
      expect(call.stdin).toBe(RIGHT);
      expect(call.argv).toBe(`login ${HOST} -u ${USER} --password-stdin`);
    });

    it('refuses a Server outside the caller’s organization before running anything', async () => {
      const cookie = await signUpOwner();
      const before = stub.calls().length;

      const res = await request(server)
        .post('/registries/test-connection')
        .set('Cookie', cookie)
        .send({
          url: HOST,
          username: USER,
          password: RIGHT,
          serverId: 'no-such-server',
        });

      expect(res.status).toBe(404);
      expect((res.body as { message: string }).message).toBe(
        'Server not found',
      );
      expect(stub.calls()).toHaveLength(before);
    });

    it('refuses an empty password at the DTO, as the save does', async () => {
      const cookie = await signUpOwner();

      const res = await request(server)
        .post('/registries/test-connection')
        .set('Cookie', cookie)
        .send({ url: HOST, username: USER, password: '' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /registries/:id/test-connection', () => {
    async function saved(cookie: string, password: string): Promise<string> {
      const res = await request(server)
        .post('/registries')
        .set('Cookie', cookie)
        .send({ name: 'local', url: HOST, username: USER, password });
      expect(res.status).toBe(201);
      return (res.body as { registryId: string }).registryId;
    }

    it('tests the stored password, with no body at all', async () => {
      const cookie = await signUpOwner();
      const registryId = await saved(cookie, RIGHT);

      const res = await request(server)
        .post(`/registries/${registryId}/test-connection`)
        .set('Cookie', cookie);

      expect(res.status).toBe(204);
    });

    it('reports a stored wrong password without ever saying it', async () => {
      const cookie = await signUpOwner();
      const registryId = await saved(cookie, WRONG);

      const res = await request(server)
        .post(`/registries/${registryId}/test-connection`)
        .set('Cookie', cookie)
        .send({});

      expect(res.status).toBe(400);
      // The sentence in plain words, docker's own answer as `output`.
      expect(res.body).toMatchObject({
        message: `${HOST} refused the username or password (401 Unauthorized).`,
        output: dockerLoginRefusal(HOST),
      });
      expectNoPassword(res);
    });

    it('answers 404 for a registry that is not there', async () => {
      const cookie = await signUpOwner();

      const res = await request(server)
        .post('/registries/no-such-registry/test-connection')
        .set('Cookie', cookie);

      expect(res.status).toBe(404);
      expect((res.body as { message: string }).message).toBe(
        'Registry not found',
      );
    });
  });

  describe('POST /applications/:id/test-registry-login', () => {
    /** A Docker-image Application whose stored pull password is `password`. */
    async function dockerApplication(
      cookie: string,
      password: string | null,
    ): Promise<string> {
      const project = await request(server)
        .post('/projects')
        .set('Cookie', cookie)
        .send({ name: 'shop' });
      expect(project.status).toBe(201);
      const environment = await request(server)
        .post('/environments')
        .set('Cookie', cookie)
        .send({
          name: 'production',
          projectId: (project.body as { projectId: string }).projectId,
        });
      expect(environment.status).toBe(201);
      const app = await request(server)
        .post('/applications')
        .set('Cookie', cookie)
        .send({
          name: 'Shop',
          appName: 'shop-app',
          environmentId: (environment.body as { environmentId: string })
            .environmentId,
        });
      expect(app.status).toBe(201);
      const applicationId = (app.body as { applicationId: string })
        .applicationId;

      const source = await request(server)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', cookie)
        .send({
          sourceType: 'docker',
          dockerImage: `${HOST}/ui/shop:latest`,
          registryUrl: HOST,
          username: USER,
          password,
        });
      expect(source.status).toBe(200);
      return applicationId;
    }

    it("reports a typed wrong password with the registry's own refusal", async () => {
      const cookie = await signUpOwner();
      const applicationId = await dockerApplication(cookie, RIGHT);

      const res = await request(server)
        .post(`/applications/${applicationId}/test-registry-login`)
        .set('Cookie', cookie)
        .send({ registryUrl: HOST, username: USER, password: WRONG });

      expect(res.status).toBe(400);
      // The sentence in plain words, docker's own answer as `output`.
      expect(res.body).toMatchObject({
        message: `${HOST} refused the username or password (401 Unauthorized).`,
        output: dockerLoginRefusal(HOST),
      });
      expectNoPassword(res);
    });

    it('passes a typed right password', async () => {
      const cookie = await signUpOwner();
      const applicationId = await dockerApplication(cookie, null);

      const res = await request(server)
        .post(`/applications/${applicationId}/test-registry-login`)
        .set('Cookie', cookie)
        .send({ registryUrl: HOST, username: USER, password: RIGHT });

      expect(res.status).toBe(204);
    });

    it('tests the stored password when none is typed, against the registry it was saved for', async () => {
      const cookie = await signUpOwner();
      const good = await dockerApplication(cookie, RIGHT);
      const before = stub.calls().length;

      const passes = await request(server)
        .post(`/applications/${good}/test-registry-login`)
        .set('Cookie', cookie)
        .send({ registryUrl: HOST, username: USER, password: '' });
      expect(passes.status).toBe(204);
      expect(
        stub
          .calls()
          .slice(before)
          .map((call) => call.stdin),
      ).toEqual([RIGHT]);
    });

    /**
     * The stored password goes to whatever host the login names, so a typed
     * hostname or username with no typed password would let a caller who never
     * held the secret deliver it to a registry of their own. Refused before
     * anything runs — `docker` is never invoked.
     */
    it.each([
      [
        'another registry',
        { registryUrl: 'attacker.example:5000', username: USER },
      ],
      ['Docker Hub', { registryUrl: '', username: USER }],
      ['another username', { registryUrl: HOST, username: 'someone-else' }],
    ])('refuses to send the stored password to %s', async (_case, body) => {
      const cookie = await signUpOwner();
      const applicationId = await dockerApplication(cookie, RIGHT);
      const before = stub.calls().length;

      const res = await request(server)
        .post(`/applications/${applicationId}/test-registry-login`)
        .set('Cookie', cookie)
        .send(body);

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        'The stored password is only tested against the registry and username it was saved with. Type the password to test these values',
      );
      expect(stub.calls()).toHaveLength(before);
      expectNoPassword(res);
    });

    it('says so when no password is typed and none is stored', async () => {
      const cookie = await signUpOwner();
      const applicationId = await dockerApplication(cookie, null);
      const before = stub.calls().length;

      const res = await request(server)
        .post(`/applications/${applicationId}/test-registry-login`)
        .set('Cookie', cookie)
        .send({ registryUrl: HOST, username: USER });

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        'No registry password is stored for this Application',
      );
      expect(stub.calls()).toHaveLength(before);
    });

    /**
     * Why this is a route of its own rather than the Registry one: a Member
     * who may edit this source holds `registry: []`, so the Registry route
     * refuses them the question this one answers.
     */
    it('answers a Member with access to the Application, whom the Registry route refuses', async () => {
      const cookie = await signUpOwner();
      const applicationId = await dockerApplication(cookie, RIGHT);
      const ida = await signUpMember(server, cookie);
      await ctx.db
        .update(member)
        .set({ accessedServices: [applicationId] })
        .where(eq(member.userId, ida.id));

      const own = await request(server)
        .post(`/applications/${applicationId}/test-registry-login`)
        .set('Cookie', ida.cookie)
        .send({ registryUrl: HOST, username: USER, password: RIGHT });
      expect(own.status).toBe(204);

      const registries = await request(server)
        .post('/registries/test-connection')
        .set('Cookie', ida.cookie)
        .send({ url: HOST, username: USER, password: RIGHT });
      expect(registries.status).toBe(403);
    });

    it('refuses a Member without access to the Application before running anything', async () => {
      const cookie = await signUpOwner();
      const applicationId = await dockerApplication(cookie, RIGHT);
      const ida = await signUpMember(server, cookie);
      const before = stub.calls().length;

      const res = await request(server)
        .post(`/applications/${applicationId}/test-registry-login`)
        .set('Cookie', ida.cookie)
        .send({ registryUrl: HOST, username: USER, password: RIGHT });

      expect(res.status).toBe(403);
      expect((res.body as { message: string }).message).toBe(
        "You don't have access to this service",
      );
      expect(stub.calls()).toHaveLength(before);
    });
  });
});
