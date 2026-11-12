import {
  cloudRunResourceOf,
  cloudRunRoutingOf,
  cloudRunServiceDefinition,
  CLOUD_RUN_OUTPUTS,
  RELOAD_LABEL,
} from '../../../../src/cloud-accounts/gcp/definitions/cloud-run-definition';
import { idKey } from '../../../../src/cloud-accounts/gcp/definitions/names';
import { addresses, resource } from '../../aws/definitions/definition-helpers';

const POOL = 'google_cloud_run_v2_worker_pool.service';

const INPUT = {
  configName: 'jobs',
  entry: { command: 'node worker.js', args: ['--queue', 'mail'] },
  service: { serviceId: 'Svc_Worker', copies: { min: 0, max: 10 } },
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
  variables: { API_KEY: 'k' },
  routing: { kind: 'none', instances: 2 } as const,
};

function worker(input: Parameters<typeof cloudRunServiceDefinition>[0]) {
  const result = cloudRunServiceDefinition(input);
  if (!result.ok) throw new Error(result.refusal.message);
  return result;
}

/**
 * A Worker on Google Cloud (spec "Worker on Google Cloud"): the
 * shared Cloud Run builder with routing none, a worker pool in place of a
 * service, and nothing that routes traffic to it.
 */
describe('cloudRunServiceDefinition with routing none (a Worker)', () => {
  it("keeps a web's repository, service account and secrets, and has a worker pool and no service, NEG or backend service", () => {
    expect(addresses(worker(INPUT).definition)).toEqual(
      [
        'google_artifact_registry_repository.service',
        'google_service_account.service',
        'google_secret_manager_secret.variable',
        'google_secret_manager_secret_version.variable',
        'google_secret_manager_secret_iam_member.variable',
        POOL,
      ].sort(),
    );
  });

  it('lets nothing in: no ingress, no invoker setting, no port', () => {
    const pool = resource(worker(INPUT).definition, POOL);
    expect(pool).not.toHaveProperty('ingress');
    expect(pool).not.toHaveProperty('invoker_iam_disabled');
    const template = pool.template as { containers: Record<string, unknown>[] };
    expect(template.containers[0]).not.toHaveProperty('ports');
  });

  it("leaves through Direct VPC egress on the Environment network's subnet, private ranges only", () => {
    const pool = resource(worker(INPUT).definition, POOL);
    expect((pool.template as Record<string, unknown>).vpc_access).toEqual({
      egress: 'PRIVATE_RANGES_ONLY',
      network_interfaces: [
        {
          network: 'cloudgate-abcdefghijkl-net',
          subnetwork: 'cloudgate-abcdefghijkl-subnet',
        },
      ],
    });
  });

  it('is created at its replicas as the manual instance count, which Stop and Start own afterwards, at GA and removable', () => {
    const pool = resource(worker(INPUT).definition, POOL);
    expect(pool).toMatchObject({
      name: `cloudgate-${idKey('Svc_Worker')}`,
      location: 'europe-west1',
      deletion_protection: false,
      scaling: { scaling_mode: 'MANUAL', manual_instance_count: 2 },
    });
    expect(pool).not.toHaveProperty('launch_stage');
    const ignored = (pool.lifecycle as { ignore_changes: string[] })
      .ignore_changes;
    expect(ignored).toEqual(
      expect.arrayContaining([
        'scaling',
        `template[0].labels["${RELOAD_LABEL}"]`,
      ]),
    );
  });

  it("writes no probe and no request-only CPU, and runs the entry's command and args", () => {
    const pool = resource(worker(INPUT).definition, POOL);
    const [container] = (
      pool.template as { containers: Record<string, unknown>[] }
    ).containers;
    expect(container).not.toHaveProperty('startup_probe');
    expect(container).not.toHaveProperty('liveness_probe');
    expect(container).toMatchObject({
      name: 'service',
      image:
        'europe-west1-docker.pkg.dev/acme-prod-123/${google_artifact_registry_repository.service.repository_id}/service:Dep_123',
      command: ['node', 'worker.js'],
      args: ['--queue', 'mail'],
      resources: { limits: { cpu: '1', memory: '512Mi' } },
    });
    expect(container.resources).not.toHaveProperty('cpu_idle');
  });

  it("answers the worker pool's name and the repository's URL, and no run.app address", () => {
    const output = worker(INPUT).definition.output as Record<string, unknown>;
    expect(Object.keys(output).sort()).toEqual(
      [
        CLOUD_RUN_OUTPUTS.workerPoolName,
        CLOUD_RUN_OUTPUTS.repositoryUrl,
      ].sort(),
    );
  });
});

describe('cloudRunRoutingOf', () => {
  it('routes a worker by nothing, at its replicas, whatever port its row keeps', () => {
    expect(cloudRunRoutingOf('worker', 3000, 3)).toEqual({
      kind: 'none',
      instances: 3,
    });
  });

  it('routes a web through the public load balancer on its port', () => {
    expect(cloudRunRoutingOf('web', 8080, 1)).toEqual({
      kind: 'public-load-balancer',
      port: 8080,
    });
  });
});

/**
 * What a Service runs as on Google Cloud, by its kind: every
 * Cloud Run check reads it from here rather than from a kind name.
 */
describe('cloudRunResourceOf', () => {
  it('runs a web as a service, a worker as a worker pool, and a cron as a job', () => {
    expect(cloudRunResourceOf('web')).toBe('service');
    expect(cloudRunResourceOf('worker')).toBe('worker-pool');
    expect(cloudRunResourceOf('cron')).toBe('job');
  });
});
