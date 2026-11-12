// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
const hosted = useHostedMode();

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  EXIT_CREATED,
  EXIT_REFUSED,
  EXIT_USAGE,
  runCreateInstanceOrganization,
} from '../../src/commands/create-instance-organization';
import {
  member,
  organization,
  server as serverTable,
  user,
} from '../../src/db/schema';
import { MailService } from '../../src/mail/mail.service';
import { MailRecorder } from '../utils/hosted-sign-up';
import { PASSING_TURNSTILE } from '../utils/fake-turnstile';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const staff = {
  email: 'Ops@Octabyte.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  organizationName: 'Octabyte',
  password: 'staff-only-password',
};

const visitor = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * Sign-up on the Hosted instance, before and after the Instance organization
 * exists (ADR-0051). Web sign-up says "not open yet" until
 * `create-instance-organization` has run on the platform host; that command
 * makes the first account and the Instance organization, whose owner holds
 * instance authority (ADR-0013's earliest owner row); then the form is open.
 *
 * The Self-hosted counterpart — the first sign-up still owns the instance and
 * closes sign-up — is `test/auth/sign-up-open.e2e-spec.ts`.
 */
describe('The Instance organization on the Hosted instance (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  beforeAll(async () => {
    // A Hosted sign-up sends a confirmation email.
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: new MailRecorder() },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  /** Runs the command against the test database, capturing what it prints. */
  async function run(argv: string[], stdin = '') {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCreateInstanceOrganization(argv, ctx.db, {
      readStdin: () => Promise.resolve(stdin),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out, err };
  }

  const staffArgs = [
    '--email',
    staff.email,
    '--first-name',
    staff.firstName,
    '--last-name',
    staff.lastName,
    '--organization-name',
    staff.organizationName,
  ];

  function signIn(email: string, password: string) {
    return request(httpServer)
      .post('/api/auth/sign-in/email')
      .send({ email, password });
  }

  describe('before the command has run', () => {
    it('says sign-up is not open yet, with no session at all', async () => {
      const res = await request(httpServer).get('/auth/sign-up-open');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        open: false,
        state: 'not-open-yet',
        turnstileSiteKey: hosted.TURNSTILE_SITE_KEY,
      });
    });

    it('refuses a web sign-up as not open yet and makes no account', async () => {
      const res = await request(httpServer)
        .post('/api/auth/sign-up/email')
        .set(PASSING_TURNSTILE)
        .send({ ...visitor, organizationName: 'Racing For Authority' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'SIGN_UP_NOT_OPEN_YET',
        message: 'Sign-up is not open yet',
      });
      expect(await ctx.db.select().from(user)).toEqual([]);
      expect(await ctx.db.select().from(organization)).toEqual([]);
    });
  });

  describe('create-instance-organization', () => {
    it('makes the first account and the Instance organization, whose owner holds instance authority', async () => {
      const { code, out, err } = await run(
        [...staffArgs, '--password-stdin'],
        `${staff.password}\n`,
      );

      expect(err).toEqual([]);
      expect(code).toBe(EXIT_CREATED);
      expect(out).toEqual([
        'Created ops@octabyte.test, owner of the Instance organization "Octabyte". Sign-up is now open.',
      ]);

      const [org] = await ctx.db.select().from(organization);
      expect(org.name).toBe('Octabyte');
      const members = await ctx.db
        .select({ role: member.role, userId: member.userId })
        .from(member);
      expect(members).toEqual([{ role: 'owner', userId: org.ownerId }]);
      const [account] = await ctx.db
        .select({
          email: user.email,
          emailVerified: user.emailVerified,
          firstName: user.firstName,
          lastName: user.lastName,
        })
        .from(user)
        .where(eq(user.id, org.ownerId));
      expect(account).toEqual({
        email: 'ops@octabyte.test',
        emailVerified: true,
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      // Only staff: no Servers came with it.
      expect(
        await ctx.db
          .select()
          .from(serverTable)
          .where(eq(serverTable.organizationId, org.id)),
      ).toEqual([]);

      // The account signs in with the password it was given, lands in the
      // Instance organization, and passes the instance-authority gate.
      const session = await signIn(staff.email, staff.password);
      expect(session.status).toBe(200);
      const cookie = session.headers['set-cookie'];
      const hostRead = await request(httpServer)
        .get('/traefik/config-status/console')
        .set('Cookie', cookie);
      expect(hostRead.status).toBe(200);
    });

    it('opens the sign-up form', async () => {
      expect(
        (await run([...staffArgs, '--password-stdin'], staff.password)).code,
      ).toBe(EXIT_CREATED);

      const open = await request(httpServer).get('/auth/sign-up-open');
      expect(open.body).toEqual({
        open: true,
        state: 'open',
        turnstileSiteKey: hosted.TURNSTILE_SITE_KEY,
      });

      const signUp = await request(httpServer)
        .post('/api/auth/sign-up/email')
        .set(PASSING_TURNSTILE)
        .send(visitor);
      expect(signUp.status).toBe(200);
    });

    it('leaves instance authority with the Instance organization once sign-up opens', async () => {
      await run([...staffArgs, '--password-stdin'], staff.password);
      const signUp = await request(httpServer)
        .post('/api/auth/sign-up/email')
        .set(PASSING_TURNSTILE)
        .send({ ...visitor, organizationName: 'Hopper Labs' });
      expect(signUp.status).toBe(200);

      // The web sign-up owns an Organization of its own, but the
      // earliest owner row — instance authority — is still the staff's.
      const owners = await ctx.db
        .select({ email: user.email })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(eq(member.role, 'owner'))
        .orderBy(member.createdAt);
      expect(owners).toEqual([
        { email: 'ops@octabyte.test' },
        { email: 'grace@example.com' },
      ]);
    });

    it('generates a password and prints it once when none is piped in', async () => {
      const { code, out } = await run(staffArgs);

      expect(code).toBe(EXIT_CREATED);
      expect(out).toHaveLength(2);
      const printed = /^Password \(shown once\): (\S+)$/.exec(out[1]);
      expect(printed).not.toBeNull();
      expect((await signIn(staff.email, printed![1])).status).toBe(200);
    });

    it('refuses a second run and writes nothing', async () => {
      await run([...staffArgs, '--password-stdin'], staff.password);

      const again = await run(
        [
          '--email',
          'someone@octabyte.test',
          '--first-name',
          'Someone',
          '--organization-name',
          'Second',
          '--password-stdin',
        ],
        staff.password,
      );

      expect(again.code).toBe(EXIT_REFUSED);
      expect(again.err).toEqual([
        'Nothing was created: this instance already has an Instance organization. It is made once; add staff to it by invitation from the console.',
      ]);
      expect(await ctx.db.select().from(organization)).toHaveLength(1);
      expect(await ctx.db.select().from(user)).toHaveLength(1);
    });

    it('refuses a password too short to sign in with, and writes nothing', async () => {
      const { code, err } = await run(
        [...staffArgs, '--password-stdin'],
        'short',
      );

      expect(code).toBe(EXIT_REFUSED);
      expect(err).toEqual([
        'Nothing was created: the password must be at least 8 characters.',
      ]);
      expect(await ctx.db.select().from(user)).toEqual([]);
      const open = await request(httpServer).get('/auth/sign-up-open');
      expect(open.body).toEqual({
        open: false,
        state: 'not-open-yet',
        turnstileSiteKey: hosted.TURNSTILE_SITE_KEY,
      });
    });

    it('names the missing flags as a usage error', async () => {
      const { code, err } = await run(['--email', staff.email]);

      expect(code).toBe(EXIT_USAGE);
      expect(err[0]).toBe('Missing --first-name, --organization-name.');
      expect(await ctx.db.select().from(user)).toEqual([]);
    });
  });
});
