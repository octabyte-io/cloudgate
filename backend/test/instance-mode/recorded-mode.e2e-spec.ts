import { and, isNull } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  EXIT_CHANGED,
  EXIT_REFUSED,
  EXIT_USAGE,
  runSetInstanceMode,
} from '../../src/commands/set-instance-mode';
import {
  application,
  cloudAccount,
  environment,
  member,
  organization,
  postgres,
  project,
  recordedInstanceMode,
  server as serverTable,
} from '../../src/db/schema';
import { InstanceModeBootError } from '../../src/instance-mode/instance-mode';
import type { InstanceModeName } from '../../src/instance-mode/instance-mode';
import { RecordedInstanceModeCheck } from '../../src/instance-mode/instance-mode.module';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { seededConfigName } from '../utils/seeded-config-name';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * The recorded mode and the mode-change command (ADR-0049), against the
 * e2e database. The first start records the Instance's mode; a later start
 * whose setting disagrees refuses, naming both; `set-instance-mode` changes
 * the record on purpose, after which a start in the new mode boots; and
 * turning hosted on refuses while any Service has the platform host as its
 * place, listing them (ADR-0053).
 *
 * The app here starts Self-hosted (no `useHostedMode()`). A "later start" is
 * the app's own boot check run again, with `isHosted` turned as that start's
 * setting would be — the same hook `init()` ran.
 */
describe('The recorded instance mode (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  /** What the app's own first start left in the table, read before any reset. */
  let recordedByFirstStart: Array<{ id: string; mode: string }>;

  beforeAll(async () => {
    ctx = await createTestApp();
    http = ctx.app.getHttpServer() as App;
    recordedByFirstStart = await ctx.db
      .select({
        id: recordedInstanceMode.id,
        mode: recordedInstanceMode.mode,
      })
      .from(recordedInstanceMode);
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.restoreAllMocks();
  });

  /** Another start of this Instance, in `mode`. */
  function startIn(mode: InstanceModeName): Promise<void> {
    jest
      .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
      .mockReturnValue(mode === 'hosted');
    return ctx.app.get(RecordedInstanceModeCheck).onModuleInit();
  }

  async function recorded(): Promise<string[]> {
    const rows = await ctx.db
      .select({ mode: recordedInstanceMode.mode })
      .from(recordedInstanceMode);
    return rows.map((row) => row.mode);
  }

  async function setMode(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSetInstanceMode(argv, ctx.db, {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  describe('at start', () => {
    it('records the mode on the first start', () => {
      expect(recordedByFirstStart).toEqual([
        { id: 'instance', mode: 'self-hosted' },
      ]);
    });

    it('boots a later start in the same mode, and records nothing more', async () => {
      await startIn('self-hosted');
      await startIn('self-hosted');

      expect(await recorded()).toEqual(['self-hosted']);
    });

    it('records a first hosted start as hosted', async () => {
      await startIn('hosted');

      expect(await recorded()).toEqual(['hosted']);
    });

    it('refuses a later start whose setting disagrees, naming both modes', async () => {
      await startIn('hosted');

      // The environment file was rewritten without the setting.
      const start = startIn('self-hosted');

      await expect(start).rejects.toThrow(InstanceModeBootError);
      await expect(start).rejects.toThrow(
        /recorded mode is hosted, but its setting says self-hosted/,
      );
      expect(await recorded()).toEqual(['hosted']);
    });
  });

  describe('set-instance-mode', () => {
    it('switches the recorded mode, after which a start in the new mode boots', async () => {
      await startIn('self-hosted');

      const result = await setMode('--mode', 'hosted');

      expect(result).toMatchObject({ code: EXIT_CHANGED, err: '' });
      expect(result.out).toContain(
        'Recorded mode changed from self-hosted to hosted',
      );
      expect(result.out).toContain('HOSTED_MODE=true');
      expect(await recorded()).toEqual(['hosted']);
      await expect(startIn('hosted')).resolves.toBeUndefined();
      await expect(startIn('self-hosted')).rejects.toThrow(
        InstanceModeBootError,
      );
    });

    it('switches back to self-hosted', async () => {
      await startIn('hosted');

      const result = await setMode('--mode', 'self-hosted');

      expect(result.code).toBe(EXIT_CHANGED);
      expect(await recorded()).toEqual(['self-hosted']);
      await expect(startIn('self-hosted')).resolves.toBeUndefined();
    });

    it('says so and changes nothing when the mode is already recorded', async () => {
      await startIn('self-hosted');

      const result = await setMode('--mode', 'self-hosted');

      expect(result.code).toBe(EXIT_CHANGED);
      expect(result.out).toBe(
        'The recorded mode is already self-hosted. Nothing changed.',
      );
      expect(await recorded()).toEqual(['self-hosted']);
    });

    it('records the mode on an Instance that has none recorded yet', async () => {
      const result = await setMode('--mode', 'hosted');

      expect(result.code).toBe(EXIT_CHANGED);
      expect(result.out).toContain('from none recorded to hosted');
      expect(await recorded()).toEqual(['hosted']);
    });

    it.each([
      [[], /Missing --mode/],
      [['--mode', 'cloud'], /--mode must be hosted or self-hosted/],
      [['--hosted'], /Unknown option/],
    ])('refuses %j as a usage error', async (argv, says) => {
      await startIn('self-hosted');

      const result = await setMode(...argv);

      expect(result.code).toBe(EXIT_USAGE);
      expect(result.err).toMatch(says);
      expect(await recorded()).toEqual(['self-hosted']);
    });

    describe('while Services run on the platform host', () => {
      /** A Self-hosted Organization with Services in each kind of place. */
      async function givenServicesInEveryPlace() {
        const signUp = await request(http)
          .post('/api/auth/sign-up/email')
          .send({
            name: 'Grace Hopper',
            email: 'grace@example.com',
            password: 'super-secret-password',
          });
        expect(signUp.status).toBe(200);
        const [{ organizationId }] = await ctx.db
          .select({ organizationId: member.organizationId })
          .from(member);
        const [{ projectId }] = await ctx.db
          .insert(project)
          .values({ name: 'shop', organizationId })
          .returning();
        const [{ environmentId }] = await ctx.db
          .insert(environment)
          .values({
            name: 'production',
            projectId,
            deployTarget: { kind: 'platform-host' },
          })
          .returning();
        const [{ serverId }] = await ctx.db
          .insert(serverTable)
          .values({
            name: 'box-1',
            ipAddress: '203.0.113.10',
            port: 22,
            organizationId,
          })
          .returning();
        const [{ cloudAccountId }] = await ctx.db
          .insert(cloudAccount)
          .values({
            organizationId,
            name: 'Production AWS',
            cloud: 'aws',
            cloudId: '123456789012',
            accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
            secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
            taskExecutionRoleArn:
              'arn:aws:iam::123456789012:role/cloudgate-task-execution',
            externalId: 'external-id-1',
            policyVersion: 3,
            lastCheckedAt: new Date().toISOString(),
            lastCheckResult: 'passed',
          })
          .returning();

        const [onHost] = await ctx.db
          .insert(application)
          .values({
            name: 'Storefront',
            environmentId,
            configName: seededConfigName(),
            sourceType: 'docker',
          })
          .returning();
        const [dbOnHost] = await ctx.db
          .insert(postgres)
          .values({
            name: 'Orders DB',
            environmentId,
            configName: seededConfigName(),
            dockerImage: 'postgres:16',
            databaseName: 'orders',
            databaseUser: 'orders',
            databasePassword: 'super-secret-database-password',
          })
          .returning();
        await ctx.db.insert(application).values([
          {
            name: 'On a Server',
            environmentId,
            configName: seededConfigName(),
            serverId,
            sourceType: 'docker',
          },
          {
            name: 'In a cloud',
            environmentId,
            configName: seededConfigName(),
            cloudAccountId,
            region: 'eu-central-1',
            sourceType: 'docker',
          },
        ]);
        const [{ name: organizationName }] = await ctx.db
          .select({ name: organization.name })
          .from(organization);
        return {
          organizationName,
          applicationId: onHost.applicationId,
          postgresId: dbOnHost.postgresId,
        };
      }

      it('refuses to turn hosted on, listing every Service on the platform host and nothing else', async () => {
        await startIn('self-hosted');
        const { organizationName, applicationId, postgresId } =
          await givenServicesInEveryPlace();

        const result = await setMode('--mode', 'hosted');

        expect(result.code).toBe(EXIT_REFUSED);
        expect(result.out).toBe('');
        expect(result.err.split('\n')).toEqual([
          'Refusing to turn hosted mode on: 2 Services run on the platform ' +
            'host, which the Hosted instance never runs Services on. Move or ' +
            'delete each one first.',
          `  - postgres "Orders DB" (${postgresId}) in ${organizationName} / shop / production`,
          `  - application "Storefront" (${applicationId}) in ${organizationName} / shop / production`,
        ]);
        expect(await recorded()).toEqual(['self-hosted']);
        await expect(startIn('hosted')).rejects.toThrow(InstanceModeBootError);
      });

      it('turns hosted on once they are gone', async () => {
        await startIn('self-hosted');
        await givenServicesInEveryPlace();
        await ctx.db.delete(postgres);
        await ctx.db
          .delete(application)
          .where(
            and(
              isNull(application.serverId),
              isNull(application.cloudAccountId),
            ),
          );

        const result = await setMode('--mode', 'hosted');

        expect(result.code).toBe(EXIT_CHANGED);
        expect(await recorded()).toEqual(['hosted']);
      });

      it('lets a Hosted instance turn self-hosted whatever runs where', async () => {
        // Seeded first: the Hosted instance's sign-up form is not open yet.
        await givenServicesInEveryPlace();
        await startIn('hosted');

        const result = await setMode('--mode', 'self-hosted');

        expect(result.code).toBe(EXIT_CHANGED);
        expect(await recorded()).toEqual(['self-hosted']);
      });
    });
  });
});
