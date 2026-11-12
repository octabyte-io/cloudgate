import { defaultMetricsConfig } from '../../src/servers/server.schema';
import type { MetricsConfig } from '../../src/servers/server.schema';
import { ThresholdService } from '../../src/monitoring/threshold.service';
import type { ThresholdTarget } from '../../src/monitoring/threshold.service';

/**
 * A server row with the given thresholds whose breach columns live on the
 * object itself, the way the row keeps them between samples: `saveBreach`
 * writes them back, so the next `check` reads what the last one stored.
 */
function serverWith(
  thresholds: { cpu: number; memory: number },
  organizationId: string | null = 'org-1',
): ThresholdTarget {
  const metricsConfig: MetricsConfig = {
    ...defaultMetricsConfig,
    server: { ...defaultMetricsConfig.server, thresholds },
  };
  const row: ThresholdTarget = {
    name: 'worker-1',
    organizationId,
    metricsConfig,
    cpuBreachedSince: null,
    memoryBreachedSince: null,
    saveBreach: (metric, since) => {
      if (metric === 'CPU') row.cpuBreachedSince = since;
      else row.memoryBreachedSince = since;
      return Promise.resolve();
    },
  };
  return row;
}

/** The same row with a new threshold saved, its breaches as stored. */
function withThresholds(
  row: ThresholdTarget,
  thresholds: { cpu: number; memory: number },
): void {
  row.metricsConfig = {
    ...row.metricsConfig,
    server: { ...row.metricsConfig.server, thresholds },
  };
}

const at = (minute: number) =>
  `2026-07-24T10:${String(minute).padStart(2, '0')}:00.000Z`;

describe('ThresholdService', () => {
  const dispatcher = { dispatch: jest.fn<Promise<void>, [string, unknown]>() };
  const service = new ThresholdService(dispatcher as never);

  beforeEach(() => dispatcher.dispatch.mockReset());

  it('fires a CPU alert with the Go agent message when the sample exceeds the threshold', async () => {
    await service.check(
      serverWith({ cpu: 80, memory: 0 }),
      { cpu: 85.5, memUsed: 50 },
      '2026-07-24T10:00:00.000Z',
    );

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith('org-1', {
      type: 'server-threshold',
      serverName: 'worker-1',
      metric: 'CPU',
      value: 85.5,
      threshold: 80,
      message: 'CPU usage (85.50%) exceeded threshold (80.00%)',
      timestamp: '2026-07-24T10:00:00.000Z',
    });
  });

  it('fires a Memory alert when memory exceeds its threshold', async () => {
    await service.check(
      serverWith({ cpu: 0, memory: 90 }),
      { cpu: 10, memUsed: 92.15 },
      '2026-07-24T10:00:00.000Z',
    );

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        metric: 'Memory',
        value: 92.15,
        threshold: 90,
        message: 'Memory usage (92.15%) exceeded threshold (90.00%)',
      }),
    );
  });

  it('fires both alerts when both metrics exceed their thresholds', async () => {
    await service.check(
      serverWith({ cpu: 50, memory: 50 }),
      { cpu: 60, memUsed: 70 },
      '2026-07-24T10:00:00.000Z',
    );
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it('stays silent below the thresholds and when thresholds are disabled', async () => {
    await service.check(
      serverWith({ cpu: 80, memory: 90 }),
      { cpu: 80, memUsed: 90 },
      '2026-07-24T10:00:00.000Z',
    );
    await service.check(
      serverWith({ cpu: 0, memory: 0 }),
      { cpu: 99, memUsed: 99 },
      '2026-07-24T10:00:00.000Z',
    );
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  describe('a breach opens and closes once', () => {
    it('announces 60 breaching samples once, stores the opening, and one recovery closes it', async () => {
      const row = serverWith({ cpu: 80, memory: 0 });

      for (let minute = 0; minute < 60; minute++) {
        await service.check(row, { cpu: 95, memUsed: 10 }, at(minute));
      }

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(row.cpuBreachedSince).toBe(at(0));

      dispatcher.dispatch.mockReset();
      await service.check(
        row,
        { cpu: 80, memUsed: 10 },
        '2026-07-24T11:00:00.000Z',
      );

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatch).toHaveBeenCalledWith('org-1', {
        type: 'server-threshold',
        serverName: 'worker-1',
        metric: 'CPU',
        value: 80,
        threshold: 80,
        message: 'CPU usage (80.00%) is back at or under threshold (80.00%)',
        timestamp: '2026-07-24T11:00:00.000Z',
        close: { reason: 'recovered', breachedSince: at(0) },
      });
      expect(row.cpuBreachedSince).toBeNull();

      dispatcher.dispatch.mockReset();
      await service.check(row, { cpu: 10, memUsed: 10 }, at(1));
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('keeps CPU and memory apart: a memory breach opening and closing leaves an open CPU breach alone', async () => {
      const row = serverWith({ cpu: 80, memory: 70 });
      await service.check(row, { cpu: 95, memUsed: 10 }, at(0));
      await service.check(row, { cpu: 95, memUsed: 90 }, at(1));
      await service.check(row, { cpu: 95, memUsed: 20 }, at(2));

      expect(
        dispatcher.dispatch.mock.calls.map(([, event]) => {
          const { metric, close } = event as {
            metric: string;
            close?: { reason: string };
          };
          return `${metric} ${close?.reason ?? 'opened'}`;
        }),
      ).toEqual(['CPU opened', 'Memory opened', 'Memory recovered']);
      expect(row.cpuBreachedSince).toBe(at(0));
      expect(row.memoryBreachedSince).toBeNull();
    });

    it('announces nothing again after a restart when the breach was stored open', async () => {
      const row = serverWith({ cpu: 80, memory: 0 });
      row.cpuBreachedSince = at(0);
      const restarted = new ThresholdService(dispatcher as never);

      await restarted.check(row, { cpu: 95, memUsed: 10 }, at(5));

      expect(dispatcher.dispatch).not.toHaveBeenCalled();
      expect(row.cpuBreachedSince).toBe(at(0));
    });

    it('still closes a breached metric once as turned off on a sample that finds its threshold at 0 (a write with no save hook)', async () => {
      const row = serverWith({ cpu: 80, memory: 0 });
      await service.check(row, { cpu: 95, memUsed: 10 }, at(0));
      dispatcher.dispatch.mockReset();

      withThresholds(row, { cpu: 0, memory: 0 });
      await service.check(row, { cpu: 95, memUsed: 10 }, at(1));
      await service.check(row, { cpu: 99, memUsed: 10 }, at(2));

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatch).toHaveBeenCalledWith('org-1', {
        type: 'server-threshold',
        serverName: 'worker-1',
        metric: 'CPU',
        value: 95,
        threshold: 0,
        message: 'CPU threshold was turned off while breached; usage is 95.00%',
        timestamp: at(1),
        close: { reason: 'turned-off', breachedSince: at(0) },
      });
      expect(row.cpuBreachedSince).toBeNull();
    });

    it('closes a breached metric once as turned off when its threshold is saved as 0, and the next sample says nothing', async () => {
      const row = serverWith({ cpu: 80, memory: 70 });
      await service.check(row, { cpu: 95, memUsed: 90 }, at(0));
      dispatcher.dispatch.mockReset();

      withThresholds(row, { cpu: 0, memory: 70 });
      await service.thresholdsSaved(row, { cpu: 97, memUsed: 91 }, at(1));

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatch).toHaveBeenCalledWith('org-1', {
        type: 'server-threshold',
        serverName: 'worker-1',
        metric: 'CPU',
        value: 97,
        threshold: 0,
        message: 'CPU threshold was turned off while breached; usage is 97.00%',
        timestamp: at(1),
        close: { reason: 'turned-off', breachedSince: at(0) },
      });
      expect(row.cpuBreachedSince).toBeNull();
      // Still above 0: left for the next sample, as any threshold change is.
      expect(row.memoryBreachedSince).toBe(at(0));

      dispatcher.dispatch.mockReset();
      await service.check(row, { cpu: 99, memUsed: 91 }, at(2));
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('reports 0 on a save-time turn-off when no sample is left, and does nothing for a metric with no open breach', async () => {
      const row = serverWith({ cpu: 0, memory: 0 });
      row.memoryBreachedSince = at(0);

      await service.thresholdsSaved(row, null, at(1));
      await service.thresholdsSaved(row, null, at(2));

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({
          metric: 'Memory',
          value: 0,
          close: { reason: 'turned-off', breachedSince: at(0) },
        }),
      );
      expect(row.memoryBreachedSince).toBeNull();
    });

    it('keeps a breach open across a raised threshold the sample still breaches, and lets the next sample close it', async () => {
      const row = serverWith({ cpu: 80, memory: 0 });
      await service.check(row, { cpu: 95, memUsed: 10 }, at(0));
      dispatcher.dispatch.mockReset();

      withThresholds(row, { cpu: 90, memory: 0 });
      await service.check(row, { cpu: 95, memUsed: 10 }, at(1));
      expect(dispatcher.dispatch).not.toHaveBeenCalled();

      withThresholds(row, { cpu: 99, memory: 0 });
      await service.check(row, { cpu: 95, memUsed: 10 }, at(2));
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({
          threshold: 99,
          close: { reason: 'recovered', breachedSince: at(0) },
        }),
      );
    });

    it('behaves the same on the platform host, instance-wide', async () => {
      const row = serverWith({ cpu: 0, memory: 50 }, null);
      for (let minute = 0; minute < 5; minute++) {
        await service.check(row, { cpu: 1, memUsed: 75 }, at(minute));
      }
      await service.check(row, { cpu: 1, memUsed: 25 }, at(5));

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
      expect(dispatcher.dispatch.mock.calls.map(([org]) => org)).toEqual([
        null,
        null,
      ]);
      expect(dispatcher.dispatch.mock.calls[1][1]).toMatchObject({
        metric: 'Memory',
        close: { reason: 'recovered', breachedSince: at(0) },
      });
    });
  });
});
