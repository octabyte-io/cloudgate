import type { LogEntry } from '../../src/cloud-accounts/google-cloud.port';
import {
  googleRuntimeLines,
  runtimeLogFilter,
} from '../../src/project-config/runtime-log/google-runtime-log';

const entry = (
  log: string,
  timestamp: string,
  text: string,
  more: Partial<LogEntry> = {},
): LogEntry => ({
  insertId: `${log}-${timestamp}`,
  logName: `projects/shop-prod/logs/${encodeURIComponent(log)}`,
  timestamp,
  revision: 'cloudgate-abc-00002-xyz',
  instance: '0069f1e2d3c4b5a6',
  text,
  ...more,
});

/** One read of the project's log store as the Runtime log's lines. */
describe('googleRuntimeLines', () => {
  it("marks the app's stdout and stderr and Cloud Run's own messages, each naming its copy and revision", () => {
    const lines = googleRuntimeLines([
      entry('run.googleapis.com/stdout', '2026-10-20T10:00:01Z', 'listening'),
      entry('run.googleapis.com/stderr', '2026-10-20T10:00:02Z', 'warn: slow'),
      entry(
        'run.googleapis.com/varlog/system',
        '2026-10-20T10:00:03Z',
        'Container called exit(1).',
      ),
      entry('app-events', '2026-10-20T10:00:04Z', 'order placed'),
    ]);

    expect(lines).toEqual([
      {
        id: 'run.googleapis.com/stdout-2026-10-20T10:00:01Z',
        at: Date.UTC(2026, 9, 20, 10, 0, 1),
        task: '0069f1e2d3c4b5a6',
        revision: 'cloudgate-abc-00002-xyz',
        source: 'stdout',
        message: 'listening',
      },
      expect.objectContaining({ source: 'stderr', message: 'warn: slow' }),
      expect.objectContaining({
        source: 'cloud-run',
        message: 'Container called exit(1).',
      }),
      expect.objectContaining({ source: 'app', message: 'order placed' }),
    ]);
  });

  it('drops a per-request entry that comes back all the same', () => {
    const lines = googleRuntimeLines([
      entry('run.googleapis.com/requests', '2026-10-20T10:00:01Z', 'GET /'),
      entry('run.googleapis.com/stdout', '2026-10-20T10:00:02Z', 'hello'),
    ]);

    expect(lines.map((line) => line.message)).toEqual(['hello']);
  });

  it('merges every copy by time, whatever order the entries came in', () => {
    const lines = googleRuntimeLines([
      entry('run.googleapis.com/stdout', '2026-10-20T10:00:03.5Z', 'b late', {
        instance: 'bbbb',
      }),
      entry(
        'run.googleapis.com/stdout',
        '2026-10-20T10:00:01.250000001Z',
        'a',
        {
          instance: 'aaaa',
        },
      ),
      entry('run.googleapis.com/stdout', '2026-10-20T10:00:02Z', 'b', {
        instance: 'bbbb',
      }),
    ]);

    expect(lines.map((line) => [line.task, line.message])).toEqual([
      ['aaaa', 'a'],
      ['bbbb', 'b'],
      ['bbbb', 'b late'],
    ]);
    expect(lines[0].at).toBe(Date.UTC(2026, 9, 20, 10, 0, 1, 250));
  });

  it('names no copy or revision for a Cloud Run message about none', () => {
    const [line] = googleRuntimeLines([
      entry(
        'cloudaudit.googleapis.com/system_event',
        '2026-10-20T10:00:01Z',
        'Ready condition status changed to False',
        { instance: null, revision: null },
      ),
    ]);

    expect(line).toMatchObject({
      task: '',
      revision: null,
      source: 'cloud-run',
    });
  });
});

describe('runtimeLogFilter', () => {
  it("reads one Cloud Run service's log from a time on, never the per-request log", () => {
    expect(
      runtimeLogFilter(
        {
          serviceName: 'cloudgate-abc',
          region: 'europe-west1',
          resource: 'service',
        },
        Date.UTC(2026, 9, 20, 10, 0, 0),
      ),
    ).toBe(
      'resource.type="cloud_run_revision" AND resource.labels.service_name="cloudgate-abc" AND resource.labels.location="europe-west1" AND NOT log_name:"run.googleapis.com%2Frequests" AND timestamp>="2026-10-20T10:00:00.000Z"',
    );
  });

  it("reads a Worker's worker pool by its own resource type and name", () => {
    expect(
      runtimeLogFilter(
        {
          serviceName: 'cloudgate-abc',
          region: 'europe-west1',
          resource: 'worker-pool',
        },
        Date.UTC(2026, 9, 20, 10, 0, 0),
      ),
    ).toBe(
      'resource.type="cloud_run_worker_pool" AND resource.labels.worker_pool_name="cloudgate-abc" AND resource.labels.location="europe-west1" AND NOT log_name:"run.googleapis.com%2Frequests" AND timestamp>="2026-10-20T10:00:00.000Z"',
    );
  });
});
