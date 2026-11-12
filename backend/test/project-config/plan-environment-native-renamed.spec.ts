import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type { DeployTarget, PlanOutcome } from '../../src/project-config';
import type { NativeAddressRenames } from '../../src/native/address-snapshot';

/**
 * ADR-0044 rule 10: a native block naming an address by the name
 * Cloudgate gave it before a rename plans exactly as one naming it by its
 * new name, plus a warning naming both. The committed rename table is empty
 * while nothing has been renamed, so these plans read one given here, as
 * a future rename would write it.
 */

const DOCKER: DeployTarget = { kind: 'platform-host' };
const AWS: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};

/** As if a `web`'s ECS service and a postgres's Cloud SQL instance had been renamed. */
const RENAMES: NativeAddressRenames = {
  aws: { web: { 'aws_ecs_service.app': 'aws_ecs_service.service' } },
  gcp: {
    postgres: {
      'google_sql_database_instance.db':
        'google_sql_database_instance.database',
    },
  },
};

type Entry = Record<string, unknown>;

function plan(
  services: Record<string, Entry>,
  deployTarget: DeployTarget,
  renames: NativeAddressRenames = RENAMES,
): PlanOutcome {
  const parsed = parseProjectConfig(JSON.stringify({ version: 1, services }), {
    renames,
  });
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return planEnvironment({
    config: parsed.config,
    saved: [],
    deployTarget,
    context: { previous: null },
  });
}

const GRACE = { health_check_grace_period_seconds: 120 };
const FLAGS = {
  settings: { insights_config: { query_insights_enabled: true } },
};

const web = (aws: Entry): Entry => ({ kind: 'web', native: { aws } });
const pg = (gcp: Entry): Entry => ({ kind: 'postgres', native: { gcp } });

describe('planEnvironment, a native address read by its old name', () => {
  describe.each([
    ['a Docker Environment', DOCKER],
    ['an AWS Environment', AWS],
  ] as const)('on %s', (_where, target) => {
    it('plans a native.aws block naming the old address exactly as one naming the new, and warns naming both', () => {
      const renamed = plan(
        { api: web({ 'aws_ecs_service.app': GRACE }) },
        target,
      );
      const current = plan(
        { api: web({ 'aws_ecs_service.service': GRACE }) },
        target,
      );
      if (!renamed.ok || !current.ok) throw new Error('refused');

      const warning = {
        kind: 'native-renamed',
        configName: 'api',
        at: 'api.native.aws."aws_ecs_service.app"',
        from: 'aws_ecs_service.app',
        to: 'aws_ecs_service.service',
        message:
          'api.native.aws."aws_ecs_service.app": renamed - Cloudgate now calls it aws_ecs_service.service, and this plan reads it so; write "aws_ecs_service.service" in the file when you choose',
      };
      // Every step and note the new name plans, and the warning beside them.
      expect(renamed).toEqual({ ...current, notes: renamed.notes });
      expect(renamed.notes.filter((n) => n.kind !== 'native-renamed')).toEqual(
        current.notes,
      );
      expect(renamed.notes.filter((n) => n.kind === 'native-renamed')).toEqual([
        warning,
      ]);
    });

    it('plans a native.gcp block naming the old address exactly as one naming the new, and warns naming both', () => {
      const renamed = plan(
        { pg: pg({ 'google_sql_database_instance.db': FLAGS }) },
        target,
      );
      const current = plan(
        { pg: pg({ 'google_sql_database_instance.database': FLAGS }) },
        target,
      );
      if (!renamed.ok || !current.ok) throw new Error('refused');

      expect(renamed.notes.filter((n) => n.kind !== 'native-renamed')).toEqual(
        current.notes,
      );
      expect(renamed).toEqual({ ...current, notes: renamed.notes });
      expect(renamed.notes.filter((n) => n.kind === 'native-renamed')).toEqual([
        expect.objectContaining({
          at: 'pg.native.gcp."google_sql_database_instance.db"',
          from: 'google_sql_database_instance.db',
          to: 'google_sql_database_instance.database',
        }),
      ]);
    });

    it('checks what the old address holds as the new address, by the new name', () => {
      const outcome = plan(
        { api: web({ 'aws_ecs_service.app': { tags: { team: 'a' } } }) },
        target,
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? [] : outcome.refusals.map((r) => r.message)).toEqual([
        'api.native.aws."aws_ecs_service.service".tags: refused - locked: tags are how Cloudgate finds, marks and deletes what it made',
      ]);
    });
  });

  it('refuses a block naming both the old address and the new: they are one resource', () => {
    const parsed = parseProjectConfig(
      JSON.stringify({
        version: 1,
        services: {
          api: web({
            'aws_ecs_service.app': GRACE,
            'aws_ecs_service.service': { enable_execute_command: true },
          }),
        },
      }),
      { renames: RENAMES },
    );

    expect(parsed).toEqual({
      ok: false,
      refusal: {
        reason: 'invalid',
        at: 'api.native.aws."aws_ecs_service.app"',
        message:
          'api.native.aws."aws_ecs_service.app": refused - Cloudgate now calls it aws_ecs_service.service, which this block also names; keep the settings under "aws_ecs_service.service" alone',
      },
    });
  });

  it("moves an address only on the kind the rename is of: a worker's is not a web's", () => {
    const outcome = plan(
      {
        jobs: {
          kind: 'worker',
          native: { aws: { 'aws_ecs_service.app': GRACE } },
        },
      },
      DOCKER,
    );

    expect(outcome.ok ? [] : outcome.refusals.map((r) => r.at)).toEqual([
      'jobs.native.aws."aws_ecs_service.app"',
    ]);
  });

  it('reads an address no rename names as written, with no warning', () => {
    const outcome = plan(
      { api: web({ 'aws_ecs_service.service': GRACE }) },
      DOCKER,
    );

    expect(outcome.ok && outcome.notes.map((n) => n.kind)).not.toContain(
      'native-renamed',
    );
    // With the committed table (empty today), an old name is just not made.
    const committed = parseProjectConfig(
      JSON.stringify({
        version: 1,
        services: { api: web({ 'aws_ecs_service.app': GRACE }) },
      }),
    );
    expect(committed.ok && committed.config.services.api).toEqual({
      kind: 'web',
      managed: false,
      env: [],
      buildArgs: [],
      buildSecrets: [],
      port: 3000,
      native: { aws: { 'aws_ecs_service.app': GRACE } },
    });
  });
});
