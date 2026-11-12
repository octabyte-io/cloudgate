import { Test, TestingModule } from '@nestjs/testing';
import { SchedulingService } from '../../src/scheduling/scheduling.service';

// The dynamic register/unregister seam. Backup, volume-backup and
// user-schedule cron jobs all go through this service, keyed by their row id.

describe('SchedulingService', () => {
  let moduleRef: TestingModule;
  let scheduling: SchedulingService;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [SchedulingService],
    }).compile();
    scheduling = moduleRef.get(SchedulingService);
  });

  // Closing the module clears any still-armed timers.
  afterEach(() => moduleRef.close());

  it('registering a cron arms a job with a next fire time', () => {
    jest.useFakeTimers({ now: new Date('2026-06-01T00:00:00Z') });
    try {
      scheduling.register('backup-1', '0 3 * * *', 'UTC', async () => {});

      expect(scheduling.has('backup-1')).toBe(true);
      expect(scheduling.get('backup-1')).toEqual({
        cronExpression: '0 3 * * *',
        timezone: 'UTC',
        nextFireAt: new Date('2026-06-01T03:00:00Z'),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('a due time runs the task, and arms the next', async () => {
    jest.useFakeTimers({ now: new Date('2026-06-01T00:00:00Z') });
    try {
      const task = jest.fn().mockResolvedValue(undefined);
      scheduling.register('backup-1', '0 3 * * *', 'UTC', task);

      await jest.advanceTimersByTimeAsync(3 * 60 * 60 * 1000 - 1);
      expect(task).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(1);
      expect(scheduling.get('backup-1')!.nextFireAt).toEqual(
        new Date('2026-06-02T03:00:00Z'),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('runNow runs the task and settles when it has', async () => {
    const task = jest.fn().mockResolvedValue(undefined);
    scheduling.register('backup-1', '0 3 * * *', null, task);

    await scheduling.runNow('backup-1');

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('re-registering the same id replaces the job', () => {
    scheduling.register('backup-1', '0 3 * * *', null, async () => {});
    scheduling.register('backup-1', '0 5 * * *', null, async () => {});

    expect(scheduling.ids()).toEqual(['backup-1']);
    expect(scheduling.get('backup-1')!.cronExpression).toBe('0 5 * * *');
  });

  it('unregistering removes the job and its timer; unknown ids are a no-op', async () => {
    jest.useFakeTimers({ now: new Date('2026-06-01T00:00:00Z') });
    try {
      const task = jest.fn().mockResolvedValue(undefined);
      scheduling.register('backup-1', '* * * * *', null, task);

      scheduling.unregister('backup-1');
      expect(scheduling.has('backup-1')).toBe(false);
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(task).not.toHaveBeenCalled();

      expect(() => scheduling.unregister('backup-1')).not.toThrow();
      expect(() => scheduling.unregister('never-registered')).not.toThrow();
    } finally {
      jest.useRealTimers();
    }
  });

  it('runs in the given timezone', () => {
    jest.useFakeTimers({ now: new Date('2026-06-01T00:00:00Z') });
    try {
      scheduling.register(
        'sched-1',
        '0 3 * * *',
        'Europe/Berlin',
        async () => {},
      );

      const job = scheduling.get('sched-1')!;
      expect(job.timezone).toBe('Europe/Berlin');
      // 03:00 CEST.
      expect(job.nextFireAt).toEqual(new Date('2026-06-01T01:00:00Z'));
    } finally {
      jest.useRealTimers();
    }
  });

  it("reads no timezone as the host's, as the cron library did", () => {
    scheduling.register('backup-1', '0 3 * * *', null, async () => {});

    expect(scheduling.get('backup-1')!.timezone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  // What the cronExpression/timezone validation in createScheduleSchema is
  // for: `register` throws synchronously, and before the fix that throw reached
  // the caller from `syncJob` — after the schedule row had already been
  // inserted. The DTO refuses these up front now, and this pins the property
  // of the collaborator it refuses them on behalf of.
  it('registering throws on input it cannot read, leaving no job', () => {
    expect(() =>
      scheduling.register('sched-1', 'not a cron', null, async () => {}),
    ).toThrow();
    expect(scheduling.has('sched-1')).toBe(false);

    expect(() =>
      scheduling.register('sched-2', '0 0 * * *', 'Not/AZone', async () => {}),
    ).toThrow();
    expect(scheduling.has('sched-2')).toBe(false);

    // Reads, but no date matches it: a job that would never run.
    expect(() =>
      scheduling.register('sched-3', '0 0 31 2 *', null, async () => {}),
    ).toThrow();
    expect(scheduling.has('sched-3')).toBe(false);
  });

  it('a failing task neither unregisters the job nor breaks later ticks', async () => {
    jest.useFakeTimers({ now: new Date('2026-06-01T00:00:00Z') });
    try {
      const task = jest
        .fn()
        .mockRejectedValueOnce(new Error('backup exploded'))
        .mockResolvedValue(undefined);
      scheduling.register('backup-1', '0 * * * *', 'UTC', task);

      await jest.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

      expect(task).toHaveBeenCalledTimes(2);
      expect(scheduling.has('backup-1')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits out a fire time past the longest timer', async () => {
    jest.useFakeTimers({ now: new Date('2026-06-01T00:00:00Z') });
    try {
      const task = jest.fn().mockResolvedValue(undefined);
      scheduling.register('yearly', '@yearly', 'UTC', task);

      // 2^31-1 ms is about 24.8 days; the first leg ending fires nothing.
      await jest.advanceTimersByTimeAsync(100 * 24 * 60 * 60 * 1000);
      expect(task).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(
        new Date('2027-01-01T00:00:00Z').getTime() - Date.now(),
      );
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a timer that comes late fires once, not once for each time it slept through', async () => {
    jest.useFakeTimers({ now: new Date('2026-06-01T00:00:00Z') });
    try {
      const task = jest.fn().mockResolvedValue(undefined);
      scheduling.register('minutely', '* * * * *', 'UTC', task);

      // The clock jumps ten minutes with no timer run in between, as an
      // event loop held up for that long would see it; the 00:01 timer then
      // comes at 00:11:30.
      jest.setSystemTime(new Date('2026-06-01T00:10:30Z'));
      await jest.advanceTimersByTimeAsync(60 * 1000);

      expect(task).toHaveBeenCalledTimes(1);
      expect(scheduling.get('minutely')!.nextFireAt).toEqual(
        new Date('2026-06-01T00:12:00Z'),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  // Around a daylight-saving change in the row's timezone, a Schedule
  // or backup follows the Cron service rule — a clock time that does not
  // exist is skipped, a repeated one fires once, at its first occurrence.
  describe('around a daylight-saving change', () => {
    afterEach(() => jest.useRealTimers());

    /** Every instant the task ran at, from `start` until `until`. */
    async function firings(
      expression: string,
      timezone: string,
      start: string,
      until: string,
    ): Promise<string[]> {
      jest.useFakeTimers({ now: new Date(start) });
      const fired: string[] = [];
      scheduling.register('dst', expression, timezone, () => {
        fired.push(new Date(Date.now()).toISOString());
        return Promise.resolve();
      });
      await jest.advanceTimersByTimeAsync(
        new Date(until).getTime() - new Date(start).getTime(),
      );
      return fired;
    }

    it('fires 01:00 and 01:30 once each in New York on the night the clocks go back', async () => {
      expect(
        await firings(
          '*/30 * * * *',
          'America/New_York',
          '2026-11-01T04:50:00Z',
          '2026-11-01T07:50:00Z',
        ),
      ).toEqual([
        '2026-11-01T05:00:00.000Z', // 01:00 EDT
        '2026-11-01T05:30:00.000Z', // 01:30 EDT
        // 01:00 and 01:30 EST (06:00Z, 06:30Z) are the same clock times again.
        '2026-11-01T07:00:00.000Z', // 02:00 EST
        '2026-11-01T07:30:00.000Z', // 02:30 EST
      ]);
    });

    it('skips 02:30 in New York on the day the clocks go forward', async () => {
      expect(
        await firings(
          '30 2 * * *',
          'America/New_York',
          '2026-03-07T12:00:00Z',
          '2026-03-09T12:00:00Z',
        ),
      ).toEqual([
        // 2026-03-08 02:30 never happens; 2026-03-09 02:30 EDT does.
        '2026-03-09T06:30:00.000Z',
      ]);
    });
  });
});
