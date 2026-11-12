import {
  RUNTIME_LOG_LATE_MS,
  RUNTIME_LOG_LOOKBACK_MS,
  RUNTIME_LOG_WINDOW_MS,
  runtimeLogOf,
  startOf,
  taskOf,
} from '../../src/project-config/runtime-log/runtime-log';

const NOW = 1_800_000_000_000;

const event = (
  task: string,
  timestamp: number,
  message: string,
  eventId = `${task}-${timestamp}`,
) => ({
  eventId,
  logStreamName: `service/service/${task}`,
  timestamp,
  message,
});

/** The Runtime log of a cloud Service, as one read of CloudWatch makes it. */
describe('runtimeLogOf', () => {
  it('merges every task by time, each line naming its task', () => {
    const log = runtimeLogOf(
      {
        events: [
          event('task-a', NOW - 3_000, 'a first'),
          event('task-a', NOW - 1_000, 'a second'),
          event('task-b', NOW - 2_000, 'b first'),
        ],
        more: false,
      },
      { startTime: NOW - 60_000, now: NOW },
    );
    expect(log.lines.map((line) => [line.task, line.message])).toEqual([
      ['task-a', 'a first'],
      ['task-b', 'b first'],
      ['task-a', 'a second'],
    ]);
    expect(log.lines[0]).toEqual({
      id: `task-a-${NOW - 3_000}`,
      at: NOW - 3_000,
      task: 'task-a',
      message: 'a first',
    });
  });

  it('orders lines of the same millisecond by task, then as CloudWatch numbered them', () => {
    const log = runtimeLogOf(
      {
        events: [
          event('task-b', NOW, 'b', '2'),
          event('task-a', NOW, 'a two', '3'),
          event('task-a', NOW, 'a one', '1'),
        ],
        more: false,
      },
      { startTime: NOW - 60_000, now: NOW },
    );
    expect(log.lines.map((line) => line.message)).toEqual([
      'a one',
      'a two',
      'b',
    ]);
  });

  it('reads again from a few seconds back when it has read everything, for events CloudWatch takes in late', () => {
    const log = runtimeLogOf(
      { events: [event('task-a', NOW - 30_000, 'old')], more: false },
      { startTime: NOW - 60_000, now: NOW },
    );
    expect(log).toMatchObject({ next: NOW - RUNTIME_LOG_LATE_MS, more: false });
  });

  it('never moves the next read before this one', () => {
    const log = runtimeLogOf(
      { events: [], more: false },
      { startTime: NOW - 2_000, now: NOW },
    );
    expect(log.next).toBe(NOW - 2_000);
  });

  it('carries on from the last line read when more was left', () => {
    const log = runtimeLogOf(
      {
        events: [
          event('task-a', NOW - 50_000, 'one'),
          event('task-a', NOW - 40_000, 'two'),
        ],
        more: true,
      },
      { startTime: NOW - 60_000, now: NOW },
    );
    expect(log).toMatchObject({ next: NOW - 40_000, more: true });
  });
});

describe('startOf', () => {
  it('opens on the last few minutes', () => {
    expect(startOf(undefined, NOW)).toBe(NOW - RUNTIME_LOG_WINDOW_MS);
  });

  it('reads from the time asked', () => {
    expect(startOf(NOW - 5_000, NOW)).toBe(NOW - 5_000);
  });

  it('reads no further back than the lookback, nor from the future', () => {
    expect(startOf(0, NOW)).toBe(NOW - RUNTIME_LOG_LOOKBACK_MS);
    expect(startOf(NOW + 60_000, NOW)).toBe(NOW);
  });
});

describe('taskOf', () => {
  it('is the task id at the end of the stream name awslogs gives it', () => {
    expect(taskOf('service/service/0f1e2d3c4b5a6978')).toBe('0f1e2d3c4b5a6978');
  });

  it('is the whole stream name when it has another shape', () => {
    expect(taskOf('other-stream')).toBe('other-stream');
  });
});
