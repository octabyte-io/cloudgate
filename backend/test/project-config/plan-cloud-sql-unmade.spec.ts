import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanOutcome,
  SavedService,
} from '../../src/project-config';

/**
 * A postgres on Cloud SQL whose Cloud run failed before Cloudgate saved
 * where it answers (the live walk, where Google listed two PSC
 * names and the run saved none): its Deployment says to check for changes
 * and apply the new plan, so that plan runs it again, as an RDS one whose
 * first run failed. One whose address is saved plans nothing.
 */

const GOOGLE: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'us-central1',
};

const CONFIG = `version: 1
services:
  pg-1:
    kind: postgres
    version: "17"
    database: walk
    user: walk
`;

function pgOnCloudSql(unmade: boolean): SavedService {
  return {
    serviceType: 'postgres',
    serviceId: 'pg-id',
    name: 'pg-1',
    configName: 'pg-1',
    cloud: {
      cloudAccountId: 'ca-1',
      region: 'us-central1',
      cloud: 'gcp',
      linkedRegistries: [],
    },
    cloudSql: {
      backupRetentionDays: 7,
      applied: { backupRetentionDays: 7 },
      ...(unmade ? { unmade: true as const } : {}),
    },
    settings: {
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      dockerImage: 'postgres:17',
      databaseName: 'walk',
      databaseUser: 'walk',
    },
    variables: { env: [] },
  };
}

function plan(saved: SavedService[]): PlanOutcome {
  const parsed = parseProjectConfig(CONFIG);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return planEnvironment({
    config: parsed.config,
    saved,
    deployTarget: GOOGLE,
    context: { previous: null },
    networks: [{ cloudAccountId: 'ca-1', region: 'us-central1' }],
  });
}

describe('planEnvironment: a postgres on Cloud SQL whose Cloud run failed', () => {
  it('plans it again as a change that reads Google Cloud', () => {
    const outcome = plan([pgOnCloudSql(true)]);
    if (!outcome.ok) {
      throw new Error(outcome.refusals.map((r) => r.message).join('; '));
    }

    expect(outcome.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'pg-1',
        cloudSql: { tier: null, version: null, lines: [] },
        cloudRead: { status: 'reading' },
      }),
    ]);
  });

  it('plans nothing for one whose address is saved', () => {
    const outcome = plan([pgOnCloudSql(false)]);
    if (!outcome.ok) {
      throw new Error(outcome.refusals.map((r) => r.message).join('; '));
    }

    expect(outcome.steps.filter((step) => step.action === 'change')).toEqual(
      [],
    );
  });
});
