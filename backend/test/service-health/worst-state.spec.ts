import { worstState } from '../../src/service-health/environment-health.service';

/**
 * The one rule the Health column, the Overview line and the Health tab read a
 * Service's state by. The Error-rate threshold feeds it through
 * `openIncidents` and its own `threshold` fact, judged here and nowhere else.
 */
describe('worstState', () => {
  const running = {
    status: 'done' as const,
    openIncidents: 0,
    threshold: null,
  };

  it('says incident while any Incident is open, even once Stopped', () => {
    expect(
      worstState({ ...running, openIncidents: 1, lastVerdicts: ['up'] }),
    ).toBe('incident');
    expect(
      worstState({
        status: 'stopped',
        openIncidents: 2,
        lastVerdicts: [],
        threshold: null,
      }),
    ).toBe('incident');
  });

  it('ranks a down verdict over an unprobed check over up', () => {
    expect(worstState({ ...running, lastVerdicts: ['up', null, 'down'] })).toBe(
      'down',
    );
    expect(worstState({ ...running, lastVerdicts: ['up', null] })).toBe(
      'pending',
    );
    expect(worstState({ ...running, lastVerdicts: ['up', 'up'] })).toBe('up');
  });

  it('says unchecked with nothing enabled, or when the Service is Stopped', () => {
    expect(worstState({ ...running, lastVerdicts: [] })).toBe('unchecked');
    expect(
      worstState({
        status: 'stopped',
        openIncidents: 0,
        lastVerdicts: ['down'],
        threshold: { enabled: true, errorRateAvailable: true },
      }),
    ).toBe('unchecked');
  });

  it('counts an enabled threshold with an Error rate to judge as up, and nothing else of it', () => {
    const judged = { enabled: true, errorRateAvailable: true };
    expect(
      worstState({ ...running, lastVerdicts: [], threshold: judged }),
    ).toBe('up');
    // A breach always opens an Incident, so the threshold has no down of its
    // own and never hides a check's.
    expect(
      worstState({ ...running, lastVerdicts: ['down'], threshold: judged }),
    ).toBe('down');
    expect(
      worstState({ ...running, lastVerdicts: [null], threshold: judged }),
    ).toBe('pending');
    for (const threshold of [
      { enabled: false, errorRateAvailable: true },
      { enabled: true, errorRateAvailable: false },
    ]) {
      expect(worstState({ ...running, lastVerdicts: [], threshold })).toBe(
        'unchecked',
      );
    }
  });
});
