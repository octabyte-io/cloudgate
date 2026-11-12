import {
  STOP_RULE_TOLERANCE,
  backwardStopRule,
  parseRawConfig,
  processLogs,
} from '../../src/monitoring/access-log.parser';

// A real Traefik JSON access-log entry, verbatim.
const sampleLogEntry = `{"ClientAddr":"172.19.0.1:56732","ClientHost":"172.19.0.1","ClientPort":"56732","ClientUsername":"-","DownstreamContentSize":0,"DownstreamStatus":304,"Duration":14729375,"OriginContentSize":0,"OriginDuration":14051833,"OriginStatus":304,"Overhead":677542,"RequestAddr":"s222-umami-c381af.traefik.me","RequestContentSize":0,"RequestCount":122,"RequestHost":"s222-umami-c381af.traefik.me","RequestMethod":"GET","RequestPath":"/dashboard?_rsc=1rugv","RequestPort":"-","RequestProtocol":"HTTP/1.1","RequestScheme":"http","RetryAttempts":0,"RouterName":"s222-umami-60e104-47-web@docker","ServiceAddr":"10.0.1.15:3000","ServiceName":"s222-umami-60e104-47-web@docker","ServiceURL":{"Scheme":"http","Opaque":"","User":null,"Host":"10.0.1.15:3000","Path":"","RawPath":"","ForceQuery":false,"RawQuery":"","Fragment":"","RawFragment":""},"StartLocal":"2024-08-25T04:34:37.306691884Z","StartUTC":"2024-08-25T04:34:37.306691884Z","entryPointName":"web","level":"info","msg":"","time":"2024-08-25T04:34:37Z"}`;

/** A variant of the sample entry with specific fields overridden. */
function entry(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    ...(JSON.parse(sampleLogEntry) as Record<string, unknown>),
    ...overrides,
  });
}

/**
 * A variant of the sample entry with keys Traefik did not write **absent**.
 *
 * Not `entry({ RequestHost: undefined })`: that reads as an override and the
 * only reason it works is that `JSON.stringify` happens to drop `undefined`.
 * The line an internet scanner produces has no such key at all, and that is
 * the shape under test.
 */
function entryWithout(keys: string[], overrides: Record<string, unknown> = {}) {
  const fields = {
    ...(JSON.parse(sampleLogEntry) as Record<string, unknown>),
    ...overrides,
  };
  for (const key of keys) delete fields[key];
  return JSON.stringify(fields);
}

// The Cloudgate dashboard's own traefik service — must never show up in
// request analytics.
const dashboardEntry = entry({ ServiceName: 'cloudgate-service-app@file' });

describe('processLogs', () => {
  it('buckets a single entry into its UTC hour', () => {
    expect(processLogs(sampleLogEntry)).toEqual([
      { hour: '2024-08-25T04:00:00Z', count: 1 },
    ]);
  });

  it('groups multiple entries by hour, sorted chronologically', () => {
    const lines = [
      entry({ StartUTC: '2024-08-25T17:44:29.274072471Z' }),
      entry({ StartUTC: '2024-08-25T17:44:29.278990221Z' }),
      entry({ StartUTC: '2024-08-25T04:10:00.000000000Z' }),
    ].join('\n');

    expect(processLogs(lines)).toEqual([
      { hour: '2024-08-25T04:00:00Z', count: 1 },
      { hour: '2024-08-25T17:00:00Z', count: 2 },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(processLogs('')).toEqual([]);
    expect(processLogs(null as unknown as string)).toEqual([]);
    expect(processLogs(undefined as unknown as string)).toEqual([]);
  });

  it('applies the date range filter', () => {
    const lines = [
      entry({ StartUTC: '2024-08-25T04:10:00.000000000Z' }),
      entry({ StartUTC: '2024-08-25T17:44:29.274072471Z' }),
    ].join('\n');

    expect(
      processLogs(lines, {
        start: '2024-08-25T10:00:00Z',
        end: '2024-08-25T20:00:00Z',
      }),
    ).toEqual([{ hour: '2024-08-25T17:00:00Z', count: 1 }]);
  });

  it('excludes the Cloudgate dashboard service', () => {
    expect(processLogs(dashboardEntry)).toEqual([]);
  });
});

describe('parseRawConfig', () => {
  it('parses multiple entries and handles whitespace and blank lines', () => {
    const result = parseRawConfig(`\n${sampleLogEntry}\n\n${sampleLogEntry}\n`);
    expect(result.data).toHaveLength(2);
    expect(result.totalCount).toBe(2);
    for (const log of result.data) {
      expect(log.ClientAddr).toBe('172.19.0.1:56732');
    }
  });

  it('returns empty for empty input', () => {
    expect(parseRawConfig('')).toEqual({ data: [], totalCount: 0 });
  });

  /**
   * `parseRawConfig` is how both platform-host reads answer rows
   * (`GET /monitoring/requests` with no Server, and
   * `POST /monitoring/requests/logs`), and the platform host fronts every
   * Organization's Domains: a reset or signed-download token in a query is a
   * stored secret, never shown back (ADR-0019, ADR-0055).
   */
  describe('query values', () => {
    it('hides every query value and keeps the names', () => {
      const result = parseRawConfig(
        entry({ RequestPath: '/reset?token=abc&next=/home' }),
      );
      expect(result.data[0].RequestPath).toBe('/reset?token=***&next=***');
    });

    it('leaves a path with no query unchanged', () => {
      const result = parseRawConfig(entry({ RequestPath: '/health' }));
      expect(result.data[0].RequestPath).toBe('/health');
    });

    it('is searched hidden, so a value finds nothing', () => {
      const lines = entry({
        RequestHost: 'shop.example.com',
        RequestPath: '/reset?token=abc',
      });
      expect(parseRawConfig(lines, undefined, undefined, 'abc')).toEqual({
        data: [],
        totalCount: 0,
      });
      expect(
        parseRawConfig(lines, undefined, undefined, 'token=***').totalCount,
      ).toBe(1);
    });
  });

  it('filters out Cloudgate dashboard requests', () => {
    expect(parseRawConfig(dashboardEntry).totalCount).toBe(0);

    const mixed = parseRawConfig(`${dashboardEntry}\n${sampleLogEntry}`);
    expect(mixed.totalCount).toBe(1);
    expect(mixed.data[0].ServiceName).not.toBe('cloudgate-service-app@file');
  });

  it('filters by status range buckets', () => {
    const lines = [
      entry({ DownstreamStatus: 200 }),
      entry({ DownstreamStatus: 404 }),
      entry({ DownstreamStatus: 502 }),
    ].join('\n');

    const clientAndServer = parseRawConfig(
      lines,
      undefined,
      undefined,
      undefined,
      ['client', 'server'],
    );
    expect(clientAndServer.totalCount).toBe(2);
    expect(clientAndServer.data.map((l) => l.DownstreamStatus).sort()).toEqual([
      404, 502,
    ]);
  });

  it('searches by request host, case-insensitively', () => {
    const lines = [
      entry({ RequestHost: 'app.example.com' }),
      entry({ RequestHost: 'other.example.com' }),
    ].join('\n');

    const result = parseRawConfig(lines, undefined, undefined, 'APP.');
    expect(result.totalCount).toBe(1);
    expect(result.data[0].RequestHost).toBe('app.example.com');
  });

  it('falls back to the request path when no host matches the term', () => {
    const lines = [
      entry({ RequestHost: 'shop.example.com', RequestPath: '/api/checkout' }),
      entry({ RequestHost: 'shop.example.com', RequestPath: '/health' }),
    ].join('\n');

    const result = parseRawConfig(lines, undefined, undefined, '/API/CHECK');
    expect(result.totalCount).toBe(1);
    expect(result.data[0].RequestPath).toBe('/api/checkout');
  });

  it('falls back to the service name when no host matches the term', () => {
    const lines = [
      entry({
        RequestHost: 'shop.example.com',
        ServiceName: 'checkout@docker',
      }),
      entry({ RequestHost: 'shop.example.com', ServiceName: 'cms@docker' }),
    ].join('\n');

    const result = parseRawConfig(lines, undefined, undefined, 'CHECKOUT@');
    expect(result.totalCount).toBe(1);
    expect(result.data[0].ServiceName).toBe('checkout@docker');
  });

  it('keeps host-only results when the term matches a host', () => {
    const lines = [
      entry({ RequestHost: 'api.example.com', RequestPath: '/health' }),
      entry({ RequestHost: 'shop.example.com', RequestPath: '/api/checkout' }),
      entry({ RequestHost: 'shop.example.com', ServiceName: 'api-gw@docker' }),
    ].join('\n');

    const result = parseRawConfig(lines, undefined, undefined, 'api');
    expect(result.totalCount).toBe(1);
    expect(result.data[0].RequestHost).toBe('api.example.com');
  });

  /**
   * A request that arrives without a `Host` header is written with no
   * `RequestHost` key, and internet scanners send those to any public :80/:443
   * routinely. `SEARCH_TIERS[0]` handed that `undefined` to `.toLowerCase()`,
   * so one such line in the window made **every** search a 500 — and the second
   * tier interpolated the same absence into the searchable text `"undefined"`,
   * which is a word a term can match.
   */
  describe('a line Traefik wrote no host, path or service for', () => {
    it('answers the matching rows rather than throwing', () => {
      const lines = [
        entryWithout(['RequestHost'], { RequestPath: '/' }),
        entry({ RequestHost: 'app.example.com' }),
      ].join('\n');

      const result = parseRawConfig(lines, undefined, undefined, 'app.');

      expect(result.totalCount).toBe(1);
      expect(result.data[0].RequestHost).toBe('app.example.com');
    });

    it('is not matched by the text “undefined”', () => {
      const lines = [
        entryWithout(['RequestPath', 'ServiceName'], {
          RequestHost: 'scan.example.com',
        }),
        entry({ RequestHost: 'app.example.com', RequestPath: '/health' }),
      ].join('\n');

      expect(parseRawConfig(lines, undefined, undefined, 'undefined')).toEqual({
        data: [],
        totalCount: 0,
      });
    });

    it('matches nothing on the host tier, and does not hide the rows that do', () => {
      const lines = [
        entryWithout(['RequestHost', 'RouterName', 'ServiceName']),
        entry({ RequestHost: 'app.example.com' }),
        entry({ RequestHost: 'other.example.com' }),
      ].join('\n');

      const result = parseRawConfig(lines, undefined, undefined, 'example.com');

      expect(result.totalCount).toBe(2);
      // Nothing was dragged in alongside them: the host-less line is absent
      // rather than present with an empty host.
      expect(result.data.map((log) => log.RequestHost)).toEqual([
        'app.example.com',
        'other.example.com',
      ]);
    });

    it('is still counted, sorted and paged when nothing is searched for', () => {
      const lines = [
        entryWithout(['RequestHost', 'RequestPath', 'ServiceName'], {
          time: '2024-08-25T06:00:00Z',
        }),
        entry({ time: '2024-08-25T04:00:00Z' }),
      ].join('\n');

      const result = parseRawConfig(lines);

      expect(result.totalCount).toBe(2);
      expect(result.data[0].RequestHost).toBeUndefined();
    });
  });

  it('filters by request method, case-insensitively', () => {
    const lines = [
      entry({ RequestMethod: 'GET' }),
      entry({ RequestMethod: 'POST' }),
      entry({ RequestMethod: 'DELETE' }),
    ].join('\n');

    const result = parseRawConfig(
      lines,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ['post'],
    );
    expect(result.totalCount).toBe(1);
    expect(result.data[0].RequestMethod).toBe('POST');
  });

  it('accepts several methods and ignores an empty method list', () => {
    const lines = [
      entry({ RequestMethod: 'GET' }),
      entry({ RequestMethod: 'POST' }),
      entry({ RequestMethod: 'DELETE' }),
    ].join('\n');

    const some = parseRawConfig(
      lines,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ['POST', 'DELETE'],
    );
    expect(some.data.map((l) => l.RequestMethod).sort()).toEqual([
      'DELETE',
      'POST',
    ]);

    const none = parseRawConfig(
      lines,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );
    expect(none.totalCount).toBe(3);
  });

  it('combines the method filter with search and status', () => {
    const lines = [
      entry({
        RequestMethod: 'POST',
        RequestPath: '/api/checkout',
        DownstreamStatus: 500,
      }),
      entry({
        RequestMethod: 'GET',
        RequestPath: '/api/checkout',
        DownstreamStatus: 500,
      }),
      entry({
        RequestMethod: 'POST',
        RequestPath: '/api/checkout',
        DownstreamStatus: 200,
      }),
      entry({
        RequestMethod: 'POST',
        RequestPath: '/health',
        DownstreamStatus: 500,
      }),
    ].join('\n');

    const result = parseRawConfig(
      lines,
      undefined,
      undefined,
      '/api/checkout',
      ['server'],
      undefined,
      ['POST'],
    );
    expect(result.totalCount).toBe(1);
    expect(result.data[0].DownstreamStatus).toBe(500);
    expect(result.data[0].RequestMethod).toBe('POST');
  });

  it('sorts by the requested column and defaults to time desc', () => {
    const lines = [
      entry({ DownstreamStatus: 500, time: '2024-08-25T04:00:00Z' }),
      entry({ DownstreamStatus: 200, time: '2024-08-25T06:00:00Z' }),
    ].join('\n');

    const byStatus = parseRawConfig(lines, undefined, {
      id: 'DownstreamStatus',
      desc: false,
    });
    expect(byStatus.data.map((l) => l.DownstreamStatus)).toEqual([200, 500]);

    const byDefault = parseRawConfig(lines);
    expect(byDefault.data.map((l) => l.time)).toEqual([
      '2024-08-25T06:00:00Z',
      '2024-08-25T04:00:00Z',
    ]);
  });

  it('paginates after filtering while totalCount reports the full set', () => {
    const lines = [
      entry({ RequestPath: '/a' }),
      entry({ RequestPath: '/b' }),
      entry({ RequestPath: '/c' }),
    ].join('\n');

    const page = parseRawConfig(lines, { pageIndex: 1, pageSize: 2 });
    expect(page.totalCount).toBe(3);
    expect(page.data).toHaveLength(1);
  });

  it('applies the date range filter on StartUTC', () => {
    const lines = [
      entry({ StartUTC: '2024-08-25T04:10:00.000000000Z' }),
      entry({ StartUTC: '2024-08-25T17:44:29.274072471Z' }),
    ].join('\n');

    const result = parseRawConfig(
      lines,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        start: '2024-08-25T10:00:00Z',
      },
    );
    expect(result.totalCount).toBe(1);
    expect(result.data[0].StartUTC).toBe('2024-08-25T17:44:29.274072471Z');
  });
});

// The rule a reader that walks a log backwards from its end stops by. What it
// has to get right is that the file is in *completion* order while every row is
// stamped with its *start*.
describe('backwardStopRule', () => {
  const window = {
    start: '2026-01-01T12:00:00Z',
    end: '2026-01-01T13:00:00Z',
  };
  const second = 1_000_000_000;

  /** Rows kept by walking `rows` (file order) from the end, until the rule stops. */
  function walk(rows: { StartUTC: string; Duration?: number; n: number }[]) {
    const stop = backwardStopRule(window);
    const kept: number[] = [];
    for (const row of [...rows].reverse()) {
      if (stop(row)) break;
      const at = Date.parse(row.StartUTC);
      if (at >= Date.parse(window.start) && at <= Date.parse(window.end)) {
        kept.push(row.n);
      }
    }
    return kept.reverse();
  }

  const finishedBefore = (n: number) => ({
    n,
    StartUTC: '2026-01-01T11:00:00Z',
    Duration: 5 * second,
  });

  it('stops once a run of lines finished before the window opened', () => {
    const rows = [
      { n: 0, StartUTC: '2026-01-01T12:10:00Z' },
      ...Array.from({ length: STOP_RULE_TOLERANCE + 1 }, (_, i) =>
        finishedBefore(i + 1),
      ),
      { n: 999, StartUTC: '2026-01-01T12:30:00Z' },
    ];

    // Row 0 is in the window by its stamp but sits behind a full run of lines
    // that finished before the window opened, which only a log out of
    // completion order could produce: the walk is entitled to stop.
    expect(walk(rows)).toEqual([999]);
  });

  it('does not stop on a short run, which is two requests racing to the writer', () => {
    const rows = [
      { n: 0, StartUTC: '2026-01-01T12:10:00Z' },
      ...Array.from({ length: 5 }, (_, i) => finishedBefore(i + 1)),
      { n: 999, StartUTC: '2026-01-01T12:30:00Z' },
    ];

    expect(walk(rows)).toEqual([0, 999]);
  });

  // The defect: a line that *started* before the window is not proof the
  // window is behind us. A long download that started at 11:50 and finished at
  // 12:20 is written after requests that started at 12:10 — so walking
  // backwards it is met first, and stopping there drops them.
  it('reaches a line inside the window that was written before a run of lines started before it', () => {
    const startedBeforeFinishedInside = (n: number) => ({
      n,
      StartUTC: '2026-01-01T11:50:00Z',
      Duration: 30 * 60 * second,
    });
    const rows = [
      { n: 0, StartUTC: '2026-01-01T12:10:00Z' },
      ...Array.from({ length: STOP_RULE_TOLERANCE * 2 }, (_, i) =>
        startedBeforeFinishedInside(i + 1),
      ),
      { n: 999, StartUTC: '2026-01-01T12:30:00Z' },
    ];

    expect(walk(rows)).toEqual([0, 999]);
  });

  it('treats a line with no readable start as no evidence either way', () => {
    const stop = backwardStopRule(window);
    for (let i = 0; i < STOP_RULE_TOLERANCE * 2; i += 1) {
      expect(stop({ StartUTC: 'garbage' })).toBe(false);
    }
  });

  it('never stops for a window with no start', () => {
    const stop = backwardStopRule({ end: window.end });
    for (let i = 0; i < STOP_RULE_TOLERANCE * 2; i += 1) {
      expect(stop(finishedBefore(i))).toBe(false);
    }
  });
});
