import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PendingSetupInput,
  PlanOutcome,
  PlanStep,
} from '../../src/project-config';

/**
 * An own `web`'s generated host, made at setup because a Template value
 * refers to its URL (ADR-0064, #1375): the create of that `web` carries the
 * host its Pending setup picked, so its Apply makes the generated Domain on
 * exactly the host the value names.
 */

const GHOST = `version: 1
services:
  ghost-app:
    kind: web
    port: 2368
    source: { image: "ghost:5.96" }
    env: [PUBLIC_URL]
  ghost-worker:
    kind: worker
    source: { image: "ghost:5.96" }
`;

const HOST = 'ghost-app-a1b2c3-198-51-100-7.sslip.io';

const SETUP: PendingSetupInput = {
  pendingSetupId: 'ps-1',
  templateId: 'ghost',
  templateName: 'Ghost',
  setupName: 'ghost',
  parts: [
    {
      configName: 'ghost-app',
      kind: 'web',
      made: { PUBLIC_URL: 'fixed' },
      host: HOST,
    },
    { configName: 'ghost-worker', kind: 'worker', made: {} },
  ],
};

function plan(deployTarget: DeployTarget): PlanOutcome {
  const parsed = parseProjectConfig(GHOST);
  if (!parsed.ok) throw new Error(parsed.refusal.message);
  return planEnvironment({
    config: parsed.config,
    saved: [],
    deployTarget,
    context: { previous: null },
    pendingSetups: [SETUP],
  });
}

type Create = Extract<PlanStep, { action: 'create' }>;

function create(outcome: PlanOutcome, configName: string): Create | undefined {
  if (!outcome.ok) {
    throw new Error(outcome.refusals.map((r) => r.message).join('; '));
  }
  return outcome.steps.find(
    (step): step is Create =>
      step.action === 'create' && step.configName === configName,
  );
}

describe('planEnvironment', () => {
  describe("an own web's host picked at setup", () => {
    it("carries the picked host on the web's create, for its generated Domain", () => {
      const outcome = plan({ kind: 'server', serverId: 'srv-1' });

      expect(create(outcome, 'ghost-app')?.template?.host).toBe(HOST);
    });

    it('carries it on the platform host too', () => {
      const outcome = plan({ kind: 'platform-host' });

      expect(create(outcome, 'ghost-app')?.template?.host).toBe(HOST);
    });

    it('carries no host on a part the setup picked none for', () => {
      const outcome = plan({ kind: 'platform-host' });

      expect(create(outcome, 'ghost-worker')?.template).toBeDefined();
      expect(create(outcome, 'ghost-worker')?.template?.host).toBeUndefined();
    });

    it('refuses the create in a Cloud Environment, where the web gets no generated host', () => {
      const outcome = plan({
        kind: 'cloud',
        cloudAccountId: 'ca-1',
        region: 'eu-west-1',
      });

      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.refusals).toContainEqual({
        at: 'ghost-app',
        message: `ghost-app's values name its URL on ${HOST}, a generated host its Template setup made, and a web in a Cloud Environment gets no generated host`,
      });
    });
  });
});
