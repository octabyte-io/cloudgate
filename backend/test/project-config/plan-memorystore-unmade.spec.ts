import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import { readGooglePlan } from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type { DeployTarget, SavedService } from '../../src/project-config';

/**
 * A redis on Memorystore whose Cloud run failed after the create, before
 * Cloudgate saved where the instance answers (the live walk,
 * where the token read failed): its Deployment says to apply a plan
 * again, so that plan runs it again, as a Cloud SQL or ElastiCache one
 * whose run failed. One whose address is saved plans nothing.
 */

const GOOGLE: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'gca-1',
  region: 'europe-west1',
};

const CONFIG = `version: 1
services:
  redis:
    kind: redis
    version: "8"
`;

function redisOnMemorystore(unmade: boolean): SavedService {
  return {
    serviceType: 'redis',
    serviceId: 'redis-id',
    name: 'redis',
    configName: 'redis',
    cloud: {
      cloudAccountId: 'gca-1',
      region: 'europe-west1',
      cloud: 'gcp',
      linkedRegistries: [],
    },
    settings: {
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      dockerImage: 'redis:8',
    },
    memorystore: {
      highAvailability: false,
      backupRetentionDays: 1,
      applied: { highAvailability: false, backupRetentionDays: 1 },
      engineVersion: 'VALKEY_8_0',
      ...(unmade ? { unmade: true as const } : {}),
    },
    variables: { env: [] },
  };
}

function plan(saved: SavedService[]) {
  const parsed = parseProjectConfig(CONFIG);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  const outcome = planEnvironment({
    config: parsed.config,
    saved,
    deployTarget: GOOGLE,
    cloud: 'gcp',
    context: { previous: null },
    networks: [{ cloudAccountId: 'gca-1', region: 'europe-west1' }],
  });
  if (!outcome.ok) {
    throw new Error(outcome.refusals.map((r) => r.message).join('; '));
  }
  return outcome;
}

describe('planEnvironment', () => {
  describe('a redis on Memorystore whose Cloud run failed', () => {
    it('plans it again as a change that reads Google Cloud', () => {
      expect(plan([redisOnMemorystore(true)]).steps).toEqual([
        expect.objectContaining({
          action: 'change',
          configName: 'redis',
          memorystore: {
            nodeType: null,
            version: null,
            highAvailability: null,
            lines: [],
          },
          cloudRead: { status: 'reading' },
        }),
      ]);
    });

    it('plans nothing for one whose address is saved', () => {
      expect(plan([redisOnMemorystore(false)]).steps).toEqual([]);
    });

    // A run that failed before `tofu` made the instance leaves the same row,
    // and a state that holds nothing: the change step is planned all the same,
    // and its read, planned against that state, shows the instance's create.
    it('plans it again when its run failed before the instance was made, and that read shows its create', () => {
      const [step] = plan([redisOnMemorystore(true)]).steps;
      const show = JSON.parse(
        readFileSync(
          join(
            __dirname,
            '..',
            'cloud-accounts',
            'fixtures',
            'plans',
            'google',
            'memorystore-create.json',
          ),
          'utf8',
        ),
      ) as TofuShowJson;
      const reading = readGooglePlan({
        show,
        nameSearch: [],
        context: { serviceName: 'redis' },
      });

      expect(step.action).toBe('change');
      expect(reading.summary[0]).toMatch(
        /^Memorystore instance `redis`: create, /,
      );
      expect(reading.counts).toEqual(
        expect.objectContaining({ create: 1, change: 0, destroy: 0 }),
      );
    });
  });
});
