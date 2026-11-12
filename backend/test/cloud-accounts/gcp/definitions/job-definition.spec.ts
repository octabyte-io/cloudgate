import {
  cloudRunRoutingOf,
  cloudRunServiceDefinition,
  CLOUD_RUN_OUTPUTS,
} from '../../../../src/cloud-accounts/gcp/definitions/cloud-run-definition';
import { idKey } from '../../../../src/cloud-accounts/gcp/definitions/names';
import { addresses, resource } from '../../aws/definitions/definition-helpers';

const JOB = 'google_cloud_run_v2_job.service';

const INPUT = {
  configName: 'report',
  entry: { command: 'node dist/report.js', args: ['--all'] },
  service: { serviceId: 'Svc_Cron', copies: { min: 0, max: 10 } },
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
  routing: { kind: 'job' } as const,
};

function cron(input: Parameters<typeof cloudRunServiceDefinition>[0]) {
  const result = cloudRunServiceDefinition(input);
  if (!result.ok) throw new Error(result.refusal.message);
  return result;
}

const template = (job: Record<string, unknown>) =>
  job.template as {
    task_count: number;
    parallelism: number;
    template: Record<string, unknown> & {
      containers: Record<string, unknown>[];
    };
  };

/**
 * A Cron service on Google Cloud (spec "Cron service on Google
 * Cloud", stories 35–37, 44, 55): the shared Cloud Run builder with a job's
 * routing, one Cloud Run job in place of a service, run one execution per
 * run by Cloudgate's timetable.
 */
describe('cloudRunServiceDefinition with a job’s routing (a Cron service)', () => {
  it("keeps a web's repository, service account and secrets, and has a job and no service, worker pool, NEG, backend service or scheduler", () => {
    expect(addresses(cron(INPUT).definition)).toEqual(
      [
        'google_artifact_registry_repository.service',
        'google_service_account.service',
        'google_secret_manager_secret.variable',
        'google_secret_manager_secret_version.variable',
        'google_secret_manager_secret_iam_member.variable',
        JOB,
      ].sort(),
    );
  });

  it('runs one task, with no parallelism and no retries, its own task timeout fixed at 24h as a backstop', () => {
    const job = resource(cron(INPUT).definition, JOB);
    expect(template(job)).toMatchObject({
      task_count: 1,
      parallelism: 1,
      template: { max_retries: 0, timeout: '86400s' },
    });
  });

  it("leaves through Direct VPC egress on the Environment network's subnet, private ranges only, as its own service account", () => {
    const job = resource(cron(INPUT).definition, JOB);
    expect(template(job).template).toMatchObject({
      service_account: '${google_service_account.service.email}',
      vpc_access: {
        egress: 'PRIVATE_RANGES_ONLY',
        network_interfaces: [
          {
            network: 'cloudgate-abcdefghijkl-net',
            subnetwork: 'cloudgate-abcdefghijkl-subnet',
          },
        ],
      },
    });
  });

  it('is removable, by its fixed name, with no ingress and no launch stage', () => {
    const job = resource(cron(INPUT).definition, JOB);
    expect(job).toMatchObject({
      name: `cloudgate-${idKey('Svc_Cron')}`,
      location: 'europe-west1',
      deletion_protection: false,
    });
    expect(job).not.toHaveProperty('ingress');
    expect(job).not.toHaveProperty('launch_stage');
  });

  it("writes no probe, no port and no request-only CPU, and runs the entry's command and args with its variables", () => {
    const [container] = template(resource(cron(INPUT).definition, JOB)).template
      .containers;
    for (const key of ['startup_probe', 'liveness_probe', 'ports']) {
      expect(container).not.toHaveProperty(key);
    }
    expect(container).toMatchObject({
      name: 'service',
      image:
        'europe-west1-docker.pkg.dev/acme-prod-123/${google_artifact_registry_repository.service.repository_id}/service:Dep_123',
      command: ['node', 'dist/report.js'],
      args: ['--all'],
      resources: { limits: { cpu: '1', memory: '512Mi' } },
      env: [
        {
          name: 'API_KEY',
          value_source: {
            secret_key_ref: expect.objectContaining({
              version: expect.any(String) as unknown,
            }) as unknown,
          },
        },
      ],
    });
    expect(container.resources).not.toHaveProperty('cpu_idle');
  });

  it("answers the job's name and the repository's URL, and no run.app address", () => {
    const output = cron(INPUT).definition.output as Record<string, unknown>;
    expect(Object.keys(output).sort()).toEqual(
      [CLOUD_RUN_OUTPUTS.jobName, CLOUD_RUN_OUTPUTS.repositoryUrl].sort(),
    );
  });
});

describe('cloudRunRoutingOf for a cron', () => {
  it('routes a cron as a job, with no port, whatever its row keeps', () => {
    expect(cloudRunRoutingOf('cron', null, 1)).toEqual({ kind: 'job' });
    expect(cloudRunRoutingOf('cron', 3000, 2)).toEqual({ kind: 'job' });
  });
});
