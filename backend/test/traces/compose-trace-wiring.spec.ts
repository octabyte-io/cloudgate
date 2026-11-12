import { parse } from 'yaml';
import { injectComposeTraceWiring } from '../../src/traces/compose-trace-wiring';

/**
 * A traced Compose's wiring, written into the converted file a deploy applies
 * the three `OTEL_EXPORTER_OTLP_*` variables and a default
 * `OTEL_SERVICE_NAME` on every inner service, and every inner service joined to
 * the network its Trace store is on.
 *
 * The expected values are spelled out rather than rebuilt from the module's
 * own helpers (§1.7).
 */

const WIRING = {
  env: {
    OTEL_EXPORTER_OTLP_ENDPOINT:
      'http://cloudgate-trace-store-compose-shop:4318',
    OTEL_EXPORTER_OTLP_HEADERS:
      'Authorization=Basic%20dHJhY2VzOnNlY3JldA%3D%3D',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
  },
  network: 'cloudgate-traces-shop',
};

interface Service {
  environment?: Record<string, unknown> | string[];
  networks?: string[] | Record<string, unknown>;
  network_mode?: string;
  [key: string]: unknown;
}
interface Spec {
  services: Record<string, Service>;
  networks?: Record<string, unknown>;
}

const wired = (content: string): Spec =>
  parse(injectComposeTraceWiring(content, WIRING)) as Spec;

/** A service's environment as a map, whichever form the file wrote it in. */
function envOf(service: Service): Record<string, unknown> {
  const env = service.environment ?? {};
  if (!Array.isArray(env)) return env;
  return Object.fromEntries(
    env.map((entry) => {
      const at = entry.indexOf('=');
      return at < 0 ? [entry, null] : [entry.slice(0, at), entry.slice(at + 1)];
    }),
  );
}

describe('injectComposeTraceWiring', () => {
  it('writes the three OTLP variables into every inner service, whatever form its environment is in', () => {
    const spec = wired(`services:
  web:
    image: shop/web
    environment:
      GREETING: hello
  worker:
    image: shop/worker
    environment:
      - QUEUE=orders
  cron:
    image: shop/cron
`);

    for (const name of ['web', 'worker', 'cron']) {
      expect(envOf(spec.services[name])).toMatchObject({
        OTEL_EXPORTER_OTLP_ENDPOINT:
          'http://cloudgate-trace-store-compose-shop:4318',
        OTEL_EXPORTER_OTLP_HEADERS:
          'Authorization=Basic%20dHJhY2VzOnNlY3JldA%3D%3D',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      });
    }
    // The author's own variables are kept, in the form they were written in.
    expect(spec.services.web.environment).toMatchObject({ GREETING: 'hello' });
    expect(spec.services.worker.environment).toContain('QUEUE=orders');
  });

  it('replaces an author-set OTLP endpoint, header or protocol, as an Application deploy does', () => {
    const spec = wired(`services:
  web:
    image: shop/web
    environment:
      OTEL_EXPORTER_OTLP_ENDPOINT: http://collector:4317
  worker:
    image: shop/worker
    environment:
      - OTEL_EXPORTER_OTLP_PROTOCOL=grpc
      - OTEL_EXPORTER_OTLP_HEADERS
`);

    expect(envOf(spec.services.web).OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      'http://cloudgate-trace-store-compose-shop:4318',
    );
    const worker = spec.services.worker.environment as string[];
    expect(worker.filter((e) => e.startsWith('OTEL_EXPORTER_OTLP_'))).toEqual([
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://cloudgate-trace-store-compose-shop:4318',
      'OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20dHJhY2VzOnNlY3JldA%3D%3D',
      'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf',
    ]);
  });

  it('defaults each inner service’s OTEL_SERVICE_NAME to its own name', () => {
    const spec = wired(`services:
  web:
    image: shop/web
  worker:
    image: shop/worker
    environment:
      - QUEUE=orders
  cron:
    image: shop/cron
    environment:
      OTEL_RESOURCE_ATTRIBUTES: deployment.environment=prod
`);

    expect(envOf(spec.services.web).OTEL_SERVICE_NAME).toBe('web');
    expect(envOf(spec.services.worker).OTEL_SERVICE_NAME).toBe('worker');
    // Resource attributes that do not name the service leave the default on.
    expect(envOf(spec.services.cron)).toMatchObject({
      OTEL_SERVICE_NAME: 'cron',
      OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=prod',
    });
  });

  it('keeps a service name the author set, as OTEL_SERVICE_NAME or as a service.name resource attribute', () => {
    const spec = wired(`services:
  web:
    image: shop/web
    environment:
      OTEL_SERVICE_NAME: storefront
  worker:
    image: shop/worker
    environment:
      - OTEL_SERVICE_NAME=order-worker
  passthrough:
    image: shop/passthrough
    environment:
      - OTEL_SERVICE_NAME
  cron:
    image: shop/cron
    environment:
      OTEL_RESOURCE_ATTRIBUTES: deployment.environment=prod,service.name=nightly
  batch:
    image: shop/batch
    environment:
      - OTEL_RESOURCE_ATTRIBUTES=service.name=batcher
`);

    expect(envOf(spec.services.web).OTEL_SERVICE_NAME).toBe('storefront');
    expect(
      (spec.services.worker.environment as string[]).filter((e) =>
        e.startsWith('OTEL_SERVICE_NAME'),
      ),
    ).toEqual(['OTEL_SERVICE_NAME=order-worker']);
    expect(
      (spec.services.passthrough.environment as string[]).filter((e) =>
        e.startsWith('OTEL_SERVICE_NAME'),
      ),
    ).toEqual(['OTEL_SERVICE_NAME']);
    expect(envOf(spec.services.cron)).not.toHaveProperty('OTEL_SERVICE_NAME');
    expect(envOf(spec.services.batch)).not.toHaveProperty('OTEL_SERVICE_NAME');
  });

  it('names each service by its own name when two share one environment through a YAML alias', () => {
    const spec = wired(`x-env: &env
  QUEUE: orders
services:
  web:
    image: shop/web
    environment: *env
  worker:
    image: shop/worker
    environment: *env
`);

    expect(envOf(spec.services.web).OTEL_SERVICE_NAME).toBe('web');
    expect(envOf(spec.services.worker).OTEL_SERVICE_NAME).toBe('worker');
  });

  it('joins every inner service to the Trace store’s network, keeping the networks it was on, and declares it external', () => {
    const spec = wired(`services:
  web:
    image: shop/web
    networks:
      - cloudgate-network
      - default
  worker:
    image: shop/worker
    networks:
      backend:
        aliases: [jobs]
  cron:
    image: shop/cron
networks:
  cloudgate-network:
    external: true
  backend: {}
`);

    expect(spec.services.web.networks).toEqual([
      'cloudgate-network',
      'default',
      'cloudgate-traces-shop',
    ]);
    expect(spec.services.worker.networks).toEqual({
      backend: { aliases: ['jobs'] },
      'cloudgate-traces-shop': {},
    });
    // Implicitly on `default` before, so it stays there.
    expect(spec.services.cron.networks).toEqual([
      'default',
      'cloudgate-traces-shop',
    ]);
    expect(spec.networks).toEqual({
      'cloudgate-network': { external: true },
      backend: {},
      'cloudgate-traces-shop': { external: true },
    });
  });

  it('joins no network for a service that brings its own network mode, and still hands it the variables', () => {
    const spec = wired(`services:
  sidecar:
    image: shop/sidecar
    network_mode: "service:web"
  web:
    image: shop/web
`);

    expect(spec.services.sidecar).not.toHaveProperty('networks');
    expect(spec.services.sidecar.network_mode).toBe('service:web');
    expect(envOf(spec.services.sidecar)).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT:
        'http://cloudgate-trace-store-compose-shop:4318',
      OTEL_SERVICE_NAME: 'sidecar',
    });
  });

  it('is a no-op on a second pass over its own output', () => {
    const once = injectComposeTraceWiring(
      `services:
  web:
    image: shop/web
    environment:
      - QUEUE=orders
    networks: [default]
`,
      WIRING,
    );
    expect(injectComposeTraceWiring(once, WIRING)).toBe(once);
  });
});
