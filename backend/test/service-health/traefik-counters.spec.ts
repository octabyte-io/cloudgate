import { buildErrorRateIndex } from '../../src/service-health/error-rate-index';
import type { ErrorRateDomainRow } from '../../src/service-health/error-rate-index';
import {
  counterDeltas,
  parseCounterRead,
  REQUEST_COUNTERS_COMMAND,
} from '../../src/service-health/traefik-counters';

/**
 * The counter reader and the forward index (ADR-0027) at their pure seam. The
 * sample text is the shape Traefik 3.6.7 serves, captured from a real
 * container: label order `code, method, protocol, service`, `le`
 * last on a bucket, scientific notation on the start time.
 */

function page(
  startTime: number,
  series: { service: string; code: string; requests: number; fast?: number }[],
): string {
  const lines = [`process_start_time_seconds ${startTime.toExponential()}`];
  for (const s of series) {
    const labels = `code="${s.code}",method="GET",protocol="http",service="${s.service}"`;
    lines.push(
      `traefik_service_request_duration_seconds_bucket{${labels},le="1.2"} ${s.fast ?? s.requests}`,
    );
    lines.push(`traefik_service_requests_total{${labels}} ${s.requests}`);
  }
  return lines.join('\n') + '\n';
}

describe('parseCounterRead', () => {
  it('reads the start time, and per series its requests and fast bucket', () => {
    const read = parseCounterRead(
      [
        'process_start_time_seconds 1.79035486292e+09',
        'traefik_service_request_duration_seconds_bucket{code="502",method="GET",protocol="http",service="my-app-service-3@file",le="1.2"} 2',
        'traefik_service_requests_total{code="502",method="GET",protocol="http",service="my-app-service-3@file"} 2',
        'traefik_service_request_duration_seconds_bucket{code="200",method="GET",protocol="http",service="shop-3-web@docker",le="1.2"} 7',
        'traefik_service_requests_total{code="200",method="GET",protocol="http",service="shop-3-web@docker"} 9',
      ].join('\n'),
    );

    expect(read.startTime).toBe(1790354862.92);
    expect([...read.series.values()]).toEqual([
      { service: 'my-app-service-3@file', code: '502', requests: 2, fast: 2 },
      { service: 'shop-3-web@docker', code: '200', requests: 9, fast: 7 },
    ]);
  });

  it('ignores every other family, bucket and comment on an unfiltered page', () => {
    const read = parseCounterRead(
      [
        '# HELP traefik_service_requests_total How many HTTP requests processed on a service.',
        '# TYPE traefik_service_requests_total counter',
        'go_goroutines 32',
        'traefik_entrypoint_requests_total{code="200",entrypoint="web",method="GET",protocol="http"} 1',
        'traefik_service_request_duration_seconds_bucket{code="200",method="GET",protocol="http",service="a@file",le="0.3"} 4',
        'traefik_service_request_duration_seconds_bucket{code="200",method="GET",protocol="http",service="a@file",le="+Inf"} 5',
        'traefik_service_request_duration_seconds_count{code="200",method="GET",protocol="http",service="a@file"} 5',
        'traefik_service_requests_total{code="200",method="GET",protocol="http",service="a@file"} 5',
      ].join('\n'),
    );

    expect(read.startTime).toBeNull();
    expect([...read.series.values()]).toEqual([
      { service: 'a@file', code: '200', requests: 5, fast: 0 },
    ]);
  });
});

describe('counterDeltas', () => {
  const start = 1_790_000_000;

  it('sums each service across its codes, counting 5xx as errors and over 1.2 s as slow', () => {
    const before = parseCounterRead(
      page(start, [
        { service: 'a@file', code: '200', requests: 10 },
        { service: 'a@file', code: '502', requests: 1 },
      ]),
    );
    const after = parseCounterRead(
      page(start, [
        { service: 'a@file', code: '200', requests: 16, fast: 13 },
        { service: 'a@file', code: '502', requests: 3 },
        { service: 'a@file', code: '404', requests: 2 },
      ]),
    );

    // 200: +6 (3 slow); 502: +2; 404 is new since the last read: +2.
    expect(counterDeltas(before, after).get('a@file')).toEqual({
      requests: 10,
      errors: 2,
      slow: 3,
    });
  });

  it('reads a counter that went down as a reset, never a negative delta', () => {
    const before = parseCounterRead(
      page(start, [{ service: 'a@file', code: '500', requests: 900 }]),
    );
    // Same start time (a missed restart marker), yet the counter fell.
    const after = parseCounterRead(
      page(start, [{ service: 'a@file', code: '500', requests: 4 }]),
    );

    expect(counterDeltas(before, after).get('a@file')).toEqual({
      requests: 4,
      errors: 4,
      slow: 0,
    });
  });

  it('counts every series from zero when the start time moved, even one that grew past its old value', () => {
    const before = parseCounterRead(
      page(start, [{ service: 'a@file', code: '200', requests: 5 }]),
    );
    const after = parseCounterRead(
      page(start + 60, [{ service: 'a@file', code: '200', requests: 8 }]),
    );

    expect(counterDeltas(before, after).get('a@file')).toEqual({
      requests: 8,
      errors: 0,
      slow: 0,
    });
  });
});

describe('REQUEST_COUNTERS_COMMAND', () => {
  it('filters on the Server to the start time and the two service families', () => {
    expect(REQUEST_COUNTERS_COMMAND).toContain(
      'docker ps -q --filter name=cloudgate-traefik --filter status=running',
    );
    expect(REQUEST_COUNTERS_COMMAND).toContain(
      'wget -qO- http://127.0.0.1:8082/metrics',
    );
    expect(REQUEST_COUNTERS_COMMAND).toContain(
      `grep -E '^(process_start_time_seconds |traefik_service_requests_total\\{|traefik_service_request_duration_seconds_bucket\\{.*le="1\\.2"\\})'`,
    );
  });
});

describe('buildErrorRateIndex', () => {
  const row = (over: Partial<ErrorRateDomainRow>): ErrorRateDomainRow => ({
    domainId: 'd1',
    uniqueConfigKey: 3,
    https: false,
    customEntrypoint: null,
    application: null,
    compose: null,
    ...over,
  });

  it('names an Application Domain by its file-provider service, whatever its appName carries', () => {
    const index = buildErrorRateIndex([
      row({
        application: { applicationId: 'app1', appName: 'my-app-service-9' },
      }),
    ]);
    expect([...index]).toEqual([
      [
        'my-app-service-9-service-3@file',
        { serviceType: 'application', serviceId: 'app1', domainId: 'd1' },
      ],
    ]);
  });

  it('names an HTTPS docker-compose Domain once per entrypoint, both the one Domain', () => {
    const index = buildErrorRateIndex([
      row({
        https: true,
        compose: {
          composeId: 'c1',
          appName: 'shop',
          composeType: 'docker-compose',
        },
      }),
      row({
        domainId: 'd2',
        uniqueConfigKey: 4,
        https: true,
        customEntrypoint: 'internal',
        compose: {
          composeId: 'c1',
          appName: 'shop',
          composeType: 'docker-compose',
        },
      }),
    ]);
    const owner = { serviceType: 'compose', serviceId: 'c1' };
    expect([...index]).toEqual([
      ['shop-3-web@docker', { ...owner, domainId: 'd1' }],
      ['shop-3-websecure@docker', { ...owner, domainId: 'd1' }],
      ['shop-4-internal@docker', { ...owner, domainId: 'd2' }],
    ]);
  });

  it('names a stack Compose Domain by its one file-provider service, HTTPS or not', () => {
    const index = buildErrorRateIndex([
      row({
        https: true,
        compose: { composeId: 'c1', appName: 'shop', composeType: 'stack' },
      }),
    ]);
    expect([...index]).toEqual([
      [
        'shop-service-3@file',
        { serviceType: 'compose', serviceId: 'c1', domainId: 'd1' },
      ],
    ]);
  });
});
