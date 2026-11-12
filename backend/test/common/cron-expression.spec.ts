import {
  createBackupSchema,
  updateBackupSchema,
} from '../../src/backups/dto/backup.dto';
import {
  cronExpressionSchema,
  readCronExpression,
} from '../../src/common/cron-expression';
import { nextFireTimes } from '../../src/scheduling/fire-times';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import { createScheduleSchema } from '../../src/scheduling/schedules/dto/schedule.dto';
import {
  createVolumeBackupSchema,
  updateVolumeBackupSchema,
} from '../../src/volume-backups/dto/volume-backup.dto';

// The one refinement standing between a request body and
// `SchedulingService.register`. It was a private const in schedule.dto.ts
// until the fix found the second DTO feeding the same scheduler with
// `z.string().min(1)`, and a later one the third.

describe('cronExpressionSchema', () => {
  it('accepts an expression the scheduler can register', () => {
    // The expectation comes from the collaborator, not from the refinement:
    // whatever `register` takes without throwing is what must be accepted.
    const scheduling = new SchedulingService();
    try {
      expect(() =>
        scheduling.register('probe', '0 3 * * *', null, async () => {}),
      ).not.toThrow();
    } finally {
      scheduling.onModuleDestroy();
    }
    expect(cronExpressionSchema.safeParse('0 3 * * *').success).toBe(true);
  });

  it('refuses an expression the scheduler throws on, naming the field', () => {
    const scheduling = new SchedulingService();
    expect(() =>
      scheduling.register('probe', 'not a cron', null, async () => {}),
    ).toThrow();

    const refused = cronExpressionSchema.safeParse('not a cron');
    expect(refused.success).toBe(false);
    expect(refused.error!.issues[0].message).toBe('Invalid cron expression');
  });

  it('refuses a day-of-month no month has', () => {
    expect(() => readCronExpression('0 0 32 * *')).toThrow();
    expect(cronExpressionSchema.safeParse('0 0 32 * *').success).toBe(false);
  });

  it('refuses an expression that reads but that no date matches', () => {
    const scheduling = new SchedulingService();
    expect(() =>
      scheduling.register('probe', '0 0 31 2 *', null, async () => {}),
    ).toThrow();

    const refused = cronExpressionSchema.safeParse('0 0 31 2 *');
    expect(refused.success).toBe(false);
    expect(refused.error!.issues[0].message).toBe(
      'Cron expression never fires: no date matches it',
    );
  });

  it('refuses the empty string a min(1) alone was there for', () => {
    expect(cronExpressionSchema.safeParse('').success).toBe(false);
  });

  // The point of lifting it: every DTO holds the *same* schema object, so
  // none can drift into accepting what another refuses (§2.4).
  describe('the DTOs that share it', () => {
    it('is the schedule, volume-backup and backup DTOs’ cron field', () => {
      expect(createScheduleSchema.shape.cronExpression).toBe(
        cronExpressionSchema,
      );
      expect(createVolumeBackupSchema.shape.schedule).toBe(
        cronExpressionSchema,
      );
      expect(createBackupSchema.shape.schedule).toBe(cronExpressionSchema);
    });

    it('refuses an unparseable cron on the volume-backup create and update shapes', () => {
      const body = {
        name: 'Nightly volume backup',
        volumeName: 'shop-data',
        prefix: 'daily',
        serviceId: 'svc-1',
        destinationId: 'dest-1',
      };
      expect(
        createVolumeBackupSchema.safeParse({ ...body, schedule: 'not a cron' })
          .success,
      ).toBe(false);
      expect(
        createVolumeBackupSchema.safeParse({ ...body, schedule: '0 3 * * *' })
          .success,
      ).toBe(true);
      expect(
        updateVolumeBackupSchema.safeParse({ schedule: 'not a cron' }).success,
      ).toBe(false);
    });

    // A backup's `schedule` was `z.string().min(1)`, so `not a cron` was
    // inserted and then threw out of `register` — the unvalidated-cron hole again.
    it('refuses an unparseable cron on the backup update shape', () => {
      expect(
        updateBackupSchema.safeParse({ schedule: 'not a cron' }).success,
      ).toBe(false);
      expect(
        updateBackupSchema.safeParse({ schedule: '0 3 * * *' }).success,
      ).toBe(true);
    });
  });
});

/**
 * Schedules and backups moved off the `cron` library, and a stored
 * expression must not change its meaning with it. These fire times are what
 * `cron` 4.4.0's `CronTime.getNextDateFrom` gave in UTC from 2026-01-01, for
 * the expressions croner reads differently or not at all.
 */
describe('readCronExpression', () => {
  const FROM = new Date('2026-01-01T00:00:00Z');
  const fires = (expression: string, count: number) =>
    nextFireTimes(readCronExpression(expression), 'UTC', FROM, count).map(
      (time) => time.toISOString(),
    );

  it('reads a step from a number as running to the end of the field', () => {
    expect(fires('5/15 * * * *', 4)).toEqual([
      '2026-01-01T00:05:00.000Z',
      '2026-01-01T00:20:00.000Z',
      '2026-01-01T00:35:00.000Z',
      '2026-01-01T00:50:00.000Z',
    ]);
    // Day-of-week runs to 7, which is Sunday: 1, 3, 5 and 7.
    expect(fires('0 0 * * 1/2', 4)).toEqual([
      '2026-01-02T00:00:00.000Z', // Friday
      '2026-01-04T00:00:00.000Z', // Sunday
      '2026-01-05T00:00:00.000Z', // Monday
      '2026-01-07T00:00:00.000Z', // Wednesday
    ]);
  });

  it('fires on either day field when both are restricted', () => {
    // Every Monday, and every 1st: 2026-03-01 is a Sunday.
    expect(fires('0 0 1 * 1', 12).slice(8)).toEqual([
      '2026-02-23T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      '2026-03-02T00:00:00.000Z',
      '2026-03-09T00:00:00.000Z',
    ]);
  });

  it('reads a day field that names every day as unrestricted', () => {
    // 1-31 is every day of the month, so only the Mondays are left.
    expect(fires('0 0 1-31 * 1', 2)).toEqual([
      '2026-01-05T00:00:00.000Z',
      '2026-01-12T00:00:00.000Z',
    ]);
  });

  it.each([
    ['@minutely', ['2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z']],
    ['@secondly', ['2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z']],
    ['@weekdays', ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z']],
    ['@weekends', ['2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z']],
    ['@DAILY', ['2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z']],
  ])('reads the shortcut %s', (expression, expected) => {
    // @weekdays from midnight on Thursday 2026-01-01: that midnight is not
    // after FROM, so read it from a second earlier.
    const from =
      expression === '@weekdays' ? new Date(FROM.getTime() - 1000) : FROM;
    expect(
      nextFireTimes(readCronExpression(expression), 'UTC', from, 2).map(
        (time) => time.toISOString(),
      ),
    ).toEqual(expected);
  });

  it('reads a sixth field as seconds, first', () => {
    expect(fires('*/10 * * * * *', 2)).toEqual([
      '2026-01-01T00:00:10.000Z',
      '2026-01-01T00:00:20.000Z',
    ]);
  });

  it('reads names in any case and 7 as Sunday', () => {
    expect(fires('0 12 * jan,JUL sun-tue', 1)).toEqual(
      fires('0 12 * 1,7 0-2', 1),
    );
    expect(fires('0 0 * * 7', 1)).toEqual(['2026-01-04T00:00:00.000Z']);
  });

  // What `cron` refused stays refused, though croner takes each of these.
  it.each([
    '0 0 L * *',
    '0 0 ? * *',
    '0 0 * * 1#2',
    '0 0 1W * *',
    '* * * * * * *',
    '@annually',
    '@midnight',
    ' @daily',
    '/10 * * * *',
    '5-1 * * * *',
    '*/0 * * * *',
    '60 * * * *',
  ])('refuses %j', (expression) => {
    expect(() => readCronExpression(expression)).toThrow();
    expect(cronExpressionSchema.safeParse(expression).success).toBe(false);
  });
});
