import type { PlanStep } from '../../../src/project-config';
import { readinessFrom } from '../../../src/templates/setup/auto-apply-readiness';
import type { ServerFacts } from '../../../src/templates/setup/auto-apply-readiness';
import { createsOnly } from '../../../src/templates/setup/pending-setup-auto-apply.service';

const ON_SERVER = { kind: 'server', serverId: 'srv_1' } as const;

/** An own Server whose last Setup run finished, with nothing going now. */
const SET_UP: ServerFacts = {
  name: 'web-1',
  setupOk: true,
  setupMessage: null,
  setupInFlight: false,
  boughtStage: null,
};

describe('readinessFrom', () => {
  it('is ready at once off a Server: the platform host and a Cloud account', () => {
    expect(readinessFrom({ kind: 'platform-host' }, null)).toEqual({
      kind: 'ready',
    });
    expect(
      readinessFrom(
        { kind: 'cloud', cloudAccountId: 'ca_1', region: 'eu-west-1' },
        null,
      ),
    ).toEqual({ kind: 'ready' });
  });

  it('is ready on a Server whose setup finished, own or bought and Ready', () => {
    expect(readinessFrom(ON_SERVER, SET_UP)).toEqual({ kind: 'ready' });
    expect(
      readinessFrom(ON_SERVER, { ...SET_UP, boughtStage: 'ready' }),
    ).toEqual({ kind: 'ready' });
  });

  it('waits for a Bought Server still in its stages, whatever its last setup said', () => {
    expect(
      readinessFrom(ON_SERVER, {
        ...SET_UP,
        setupOk: null,
        boughtStage: 'setting_up',
      }),
    ).toEqual({ kind: 'waiting', waitingFor: 'web-1 is still being set up' });
    expect(
      readinessFrom(ON_SERVER, { ...SET_UP, boughtStage: 'changing' }),
    ).toEqual({ kind: 'waiting', waitingFor: 'web-1 is being changed' });
  });

  it('waits while a Setup run is going, even after an earlier one finished', () => {
    expect(
      readinessFrom(ON_SERVER, { ...SET_UP, setupInFlight: true }),
    ).toEqual({ kind: 'waiting', waitingFor: 'web-1 is being set up' });
  });

  it('waits on a Server never set up, or whose setup failed, saying to run it', () => {
    expect(readinessFrom(ON_SERVER, { ...SET_UP, setupOk: null })).toEqual({
      kind: 'waiting',
      waitingFor:
        "web-1 has not been set up yet. Run setup on the Server's page",
    });
    expect(
      readinessFrom(ON_SERVER, {
        ...SET_UP,
        setupOk: false,
        setupMessage: 'docker did not start',
        boughtStage: 'ready',
      }),
    ).toEqual({
      kind: 'waiting',
      waitingFor:
        "web-1's setup failed: docker did not start. Run setup again on the Server's page",
    });
  });

  it('gives up on a Server that is gone, failed to be made or is being deleted', () => {
    expect(readinessFrom(ON_SERVER, null)).toMatchObject({ kind: 'gone' });
    for (const boughtStage of ['failed', 'deleting', 'deleted'] as const) {
      expect(
        readinessFrom(ON_SERVER, { ...SET_UP, boughtStage }),
      ).toMatchObject({ kind: 'gone' });
    }
  });
});

describe('createsOnly', () => {
  const create = (pendingSetupId: string | null) =>
    ({
      action: 'create',
      configName: 'ghost-app',
      kind: 'compose',
      placement: ON_SERVER,
      fields: [],
      ...(pendingSetupId
        ? {
            template: {
              pendingSetupId,
              templateId: 'ghost',
              templateName: 'Ghost',
              setupName: 'ghost',
              values: [],
            },
          }
        : {}),
    }) as unknown as PlanStep;

  it("holds for a plan of nothing but this setup's creates", () => {
    expect(createsOnly([create('ps_1'), create('ps_1')], 'ps_1')).toBe(true);
  });

  it("refuses a plan holding another setup's part, a create of no setup, or anything but a create", () => {
    expect(createsOnly([create('ps_1'), create('ps_2')], 'ps_1')).toBe(false);
    expect(createsOnly([create('ps_1'), create(null)], 'ps_1')).toBe(false);
    expect(
      createsOnly(
        [
          create('ps_1'),
          { action: 'destroy', configName: 'old' } as unknown as PlanStep,
        ],
        'ps_1',
      ),
    ).toBe(false);
  });

  it('refuses a plan with nothing in it', () => {
    expect(createsOnly([], 'ps_1')).toBe(false);
  });
});
