import {
  cloudRunServiceDefinition,
  webDefinition,
} from '../../../../src/cloud-accounts/gcp/definitions/cloud-run-definition';
import type { GcpWebDefinitionInput } from '../../../../src/cloud-accounts/gcp/definitions/cloud-run-definition';
import type { NativeGcpBlock } from '../../../../src/native/gcp-native';
import { resource } from '../../aws/definitions/definition-helpers';
import type { WebEntry } from '../../../../src/project-config';

/**
 * ADR-0044 rule 3: `native.gcp` laid over the one Cloud Run
 * builder's definition of a `web`, before `main.tf.json` is written. Pure:
 * what the operator writes in, what the definition holds out.
 */

const ENTRY: WebEntry = {
  kind: 'web',
  managed: false,
  env: [],
  port: 8080,
  buildArgs: [],
  buildSecrets: [],
};

const INPUT: GcpWebDefinitionInput = {
  configName: 'api',
  entry: ENTRY,
  service: { serviceId: 'Svc_Web', copies: { min: 0, max: 10 } },
  cloudAccountId: 'Cloud_Acct-1',
  projectId: 'acme-prod-123',
  region: 'europe-west1',
  environmentId: 'Env_Prod',
  stateId: 'State_Svc-1',
  network: {
    networkName: 'cloudgate-abcdefghijkl-net',
    subnetName: 'cloudgate-abcdefghijkl-subnet',
  },
  pair: { cpu: 1, memoryMb: 512 },
  imageTag: 'Dep_123',
  variables: { API_KEY: 'hunter2' },
};

const RUN = 'google_cloud_run_v2_service.service';
const BACKEND = 'google_compute_backend_service.service';
const REPOSITORY = 'google_artifact_registry_repository.service';

function definitionOf(native?: NativeGcpBlock | null) {
  const result = webDefinition({ ...INPUT, native });
  if (!result.ok) throw new Error(result.refusal.message);
  return result.definition as unknown as Record<string, unknown>;
}

const templateOf = (native?: NativeGcpBlock) =>
  resource(definitionOf(native), RUN).template as Record<string, unknown>;

const containerOf = (native?: NativeGcpBlock) =>
  (templateOf(native).containers as Record<string, unknown>[])[0];

describe('webDefinition native.gcp (Google)', () => {
  it('writes exactly Cloudgate’s definition with no block, an empty one or null', () => {
    const own = definitionOf();
    expect(definitionOf(null)).toEqual(own);
    expect(definitionOf({})).toEqual(own);
  });

  it('merges template field by field, keeping Cloudgate’s account, egress and container', () => {
    const own = templateOf();
    const template = templateOf({
      [RUN]: {
        template: { max_instance_request_concurrency: 20, timeout: '120s' },
      },
    });
    expect(template).toEqual({
      ...own,
      max_instance_request_concurrency: 20,
      timeout: '120s',
    });
  });

  it('merges the container object into Cloudgate’s one container, keeping its image, ports and env', () => {
    const own = containerOf();
    const probe = {
      http_get: { path: '/healthz' },
      period_seconds: 10,
    };
    const containers = templateOf({
      [RUN]: {
        template: {
          containers: {
            liveness_probe: probe,
            resources: { cpu_idle: false, startup_cpu_boost: true },
          },
        },
      },
    }).containers as Record<string, unknown>[];
    expect(containers).toHaveLength(1);
    expect(containers[0]).toEqual({
      ...own,
      liveness_probe: probe,
      // Field by field: the limits the size set stay.
      resources: {
        limits: { cpu: '1', memory: '512Mi' },
        cpu_idle: false,
        startup_cpu_boost: true,
      },
    });
    expect(containers[0]).toMatchObject({
      image: expect.stringContaining(':Dep_123') as string,
      ports: { container_port: 8080 },
      env: [expect.objectContaining({ name: 'API_KEY' })],
    });
  });

  it('lays template and its container together', () => {
    const template = templateOf({
      [RUN]: {
        template: {
          max_instance_request_concurrency: 20,
          containers: { working_dir: '/srv' },
        },
      },
    });
    expect(template.max_instance_request_concurrency).toBe(20);
    expect(containerOf().name).toBe('service');
    expect((template.containers as Record<string, unknown>[])[0]).toEqual({
      ...containerOf(),
      working_dir: '/srv',
    });
  });

  it('replaces a real list whole: volumes on the template, cleanup policies on the repository', () => {
    const volumes = [{ name: 'tmp', empty_dir: { medium: 'MEMORY' } }];
    expect(templateOf({ [RUN]: { template: { volumes } } }).volumes).toEqual(
      volumes,
    );
    const policies = [
      {
        id: 'keep-five',
        action: 'KEEP',
        most_recent_versions: { keep_count: 5 },
      },
    ];
    expect(
      resource(
        definitionOf({ [REPOSITORY]: { cleanup_policies: policies } }),
        REPOSITORY,
      ).cleanup_policies,
    ).toEqual(policies);
  });

  it('merges annotations key by key', () => {
    const run = resource(
      definitionOf({
        [RUN]: {
          annotations: { 'example.com/team': 'payments' },
        },
      }),
      RUN,
    );
    expect(run.annotations).toEqual({ 'example.com/team': 'payments' });
  });

  it('closes the run.app address with ingress, keeping the load balancer’s routing', () => {
    const definition = definitionOf({
      [RUN]: { ingress: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER' },
    });
    expect(resource(definition, RUN)).toMatchObject({
      ingress: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER',
      invoker_iam_disabled: true,
    });
    expect(resource(definition, BACKEND)).toEqual(
      resource(definitionOf(), BACKEND),
    );
  });

  it('lays the backend service’s open settings over Cloudgate’s routing', () => {
    const backend = resource(
      definitionOf({
        [BACKEND]: {
          security_policy:
            'projects/acme-prod-123/global/securityPolicies/edge',
          iap: { enabled: true },
          log_config: { enable: true, sample_rate: 0.5 },
          timeout_sec: 60,
        },
      }),
      BACKEND,
    );
    expect(backend).toEqual({
      ...resource(definitionOf(), BACKEND),
      security_policy: 'projects/acme-prod-123/global/securityPolicies/edge',
      iap: { enabled: true },
      log_config: { enable: true, sample_rate: 0.5 },
      timeout_sec: 60,
    });
  });

  it('keeps Cloudgate’s own lifecycle', () => {
    const run = resource(
      definitionOf({ [RUN]: { template: { timeout: '120s' } } }),
      RUN,
    );
    expect(run.lifecycle).toEqual(resource(definitionOf(), RUN).lifecycle);
  });

  it('writes every string as typed, never read as a reference', () => {
    expect(
      containerOf({
        [RUN]: { template: { containers: { working_dir: '/srv/${HOME}' } } },
      }).working_dir,
    ).toBe('/srv/$${HOME}');
  });

  it('throws on an address its definition does not write, which the plan refuses first', () => {
    const result = () =>
      cloudRunServiceDefinition({
        ...INPUT,
        routing: { kind: 'none', instances: 1 },
        native: { [RUN]: { template: { timeout: '120s' } } },
      });
    expect(result).toThrow(
      /native\.gcp names google_cloud_run_v2_service\.service/,
    );
  });
});
