import { ConflictException } from '@nestjs/common';

import {
  assertKindTakesSwarmSettings,
  KIND_SWARM_SETTING_REFUSAL_CODE,
} from '../../src/applications/config-kind-locks';

/**
 * The console's save of a Cron service's Swarm settings refuses the
 * four a run never takes, with the reasons its plan gives, from one list.
 */
describe('assertKindTakesSwarmSettings', () => {
  const refusal = (
    data: Parameters<typeof assertKindTakesSwarmSettings>[1],
  ): { message: string; code: string } => {
    try {
      assertKindTakesSwarmSettings('cron', data);
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      return error.getResponse() as { message: string; code: string };
    }
    throw new Error('saved, but a refusal was expected');
  };

  it.each([
    [
      'HealthCheck',
      { healthCheckSwarm: { Test: ['CMD', 'true'] } },
      'a run is judged by its exit code, and a failing health check would kill it mid-command (AWS and Google Cloud runs have none)',
    ],
    [
      'RestartPolicy',
      { restartPolicySwarm: { Condition: 'any' } },
      'a run is never retried; Cloudgate runs it with Condition none',
    ],
    [
      'UpdateConfig',
      { updateConfigSwarm: { Parallelism: 1, Order: 'start-first' } },
      'a run is a one-off job with no copies to update',
    ],
    [
      'RollbackConfig',
      { rollbackConfigSwarm: { Parallelism: 1, Order: 'start-first' } },
      'a run is a one-off job with nothing to roll back',
    ],
  ])(
    'refuses a Cron service’s %s with the plan’s reason',
    (key, data, reason) => {
      const { message, code } = refusal(data);
      expect(code).toBe(KIND_SWARM_SETTING_REFUSAL_CODE);
      expect(message).toContain(`${key} {`);
      expect(message).toContain(`: refused - ${reason}`);
    },
  );

  it('names every refused setting in one refusal', () => {
    const { message } = refusal({
      healthCheckSwarm: { Retries: 3 },
      restartPolicySwarm: { Condition: 'none' },
    });
    expect(message).toMatch(/HealthCheck .*; RestartPolicy /);
  });

  it('takes a Cron service’s labels, stop grace and ulimits, and a cleared setting', () => {
    expect(() =>
      assertKindTakesSwarmSettings('cron', {
        labelsSwarm: { team: 'billing' },
        stopGracePeriodSwarm: 20_000_000_000,
        ulimitsSwarm: [{ Name: 'nofile', Soft: 1, Hard: 2 }],
        healthCheckSwarm: null,
        restartPolicySwarm: null,
        updateConfigSwarm: null,
        rollbackConfigSwarm: null,
      }),
    ).not.toThrow();
  });

  it('takes all seven on every other kind', () => {
    for (const kind of ['web', 'worker', 'web-private', 'static'] as const) {
      expect(() =>
        assertKindTakesSwarmSettings(kind, {
          healthCheckSwarm: { Retries: 3 },
          restartPolicySwarm: { Condition: 'any' },
          updateConfigSwarm: { Parallelism: 1, Order: 'start-first' },
          rollbackConfigSwarm: { Parallelism: 1, Order: 'start-first' },
        }),
      ).not.toThrow();
    }
  });
});
