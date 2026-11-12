import {
  cloudRunResourceOf,
  cloudRunRoutingOf,
  cloudRunServiceDefinition,
  CLOUD_RUN_OUTPUTS,
  internalRunAppUrl,
} from '../../../../src/cloud-accounts/gcp/definitions/cloud-run-definition';
import { idKey } from '../../../../src/cloud-accounts/gcp/definitions/names';
import { addresses, resource } from '../../aws/definitions/definition-helpers';

const SERVICE = 'google_cloud_run_v2_service.service';

const INPUT = {
  configName: 'api',
  entry: { command: 'node api.js' },
  service: { serviceId: 'Svc_Api', copies: { min: 0, max: 10 } },
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
  routing: { kind: 'internal-only', port: 8080 } as const,
};

function privateService(
  input: Parameters<typeof cloudRunServiceDefinition>[0],
) {
  const result = cloudRunServiceDefinition(input);
  if (!result.ok) throw new Error(result.refusal.message);
  return result;
}

/**
 * A Private web service on Google Cloud (spec "Private web
 * service on Google Cloud"): the shared Cloud Run builder with routing
 * internal-only, a Cloud Run service that takes requests from its own
 * Environment network alone, and nothing of the public load balancer.
 */
describe('cloudRunServiceDefinition with routing internal-only (a Private web service)', () => {
  it("keeps a web's repository, service account, secrets and Cloud Run service, and drops the NEG and backend service", () => {
    expect(addresses(privateService(INPUT).definition)).toEqual(
      [
        'google_artifact_registry_repository.service',
        'google_service_account.service',
        'google_secret_manager_secret.variable',
        'google_secret_manager_secret_version.variable',
        'google_secret_manager_secret_iam_member.variable',
        SERVICE,
      ].sort(),
    );
  });

  it('takes requests from inside the Environment only, with the invoker check off so its callers need no token', () => {
    const run = resource(privateService(INPUT).definition, SERVICE);
    expect(run).toMatchObject({
      name: `cloudgate-${idKey('Svc_Api')}`,
      ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
      invoker_iam_disabled: true,
      deletion_protection: false,
    });
  });

  it("serves on its port, CPU only during requests, in its copy range, and leaves through Direct VPC egress on the network's subnet for private ranges only", () => {
    const run = resource(privateService(INPUT).definition, SERVICE);
    const template = run.template as Record<string, unknown> & {
      containers: Record<string, unknown>[];
    };
    expect(template.containers[0]).toMatchObject({
      ports: { container_port: 8080 },
      command: ['node', 'api.js'],
      resources: { cpu_idle: true },
    });
    expect(template.containers[0]).not.toHaveProperty('startup_probe');
    expect(template.containers[0]).not.toHaveProperty('liveness_probe');
    expect(template.scaling).toEqual({
      min_instance_count: 0,
      max_instance_count: 10,
    });
    expect(template.vpc_access).toEqual({
      egress: 'PRIVATE_RANGES_ONLY',
      network_interfaces: [
        {
          network: 'cloudgate-abcdefghijkl-net',
          subnetwork: 'cloudgate-abcdefghijkl-subnet',
        },
      ],
    });
  });

  it('answers its service name, its run.app URLs and the repository, and no Domain block', () => {
    const output = privateService(INPUT).definition.output as Record<
      string,
      { value: string }
    >;
    expect(Object.keys(output).sort()).toEqual(
      [
        CLOUD_RUN_OUTPUTS.serviceUri,
        CLOUD_RUN_OUTPUTS.serviceUrls,
        CLOUD_RUN_OUTPUTS.serviceName,
        CLOUD_RUN_OUTPUTS.repositoryUrl,
      ].sort(),
    );
    expect(output[CLOUD_RUN_OUTPUTS.serviceUrls].value).toBe(
      '${google_cloud_run_v2_service.service.urls}',
    );
    expect(JSON.stringify(privateService(INPUT).definition)).not.toMatch(
      /certificate_manager|url_map|network_endpoint_group|backend_service/,
    );
  });
});

describe('cloudRunServiceDefinition with routing public-load-balancer (a web beside a Private web service)', () => {
  it('keeps ingress ALL and the NEG and backend service: a public web is routed from anywhere', () => {
    const web = privateService({
      ...INPUT,
      routing: { kind: 'public-load-balancer', port: 8080 },
    });
    expect(resource(web.definition, SERVICE).ingress).toBe(
      'INGRESS_TRAFFIC_ALL',
    );
    expect(addresses(web.definition)).toEqual(
      expect.arrayContaining([
        'google_compute_region_network_endpoint_group.service',
        'google_compute_backend_service.service',
      ]),
    );
  });
});

describe('cloudRunRoutingOf a web-private', () => {
  it('runs it as a Cloud Run service, routed internal-only on its port', () => {
    expect(cloudRunResourceOf('web-private')).toBe('service');
    expect(cloudRunRoutingOf('web-private', 8080, 1)).toEqual({
      kind: 'internal-only',
      port: 8080,
    });
  });
});

/**
 * The address handed over (as a live check found it): Cloud Run v2's
 * `urls` hold `https://<service>-<project number>.<region>.run.app` beside
 * the older `-<hash>-<region code>.a.run.app` that `uri` holds; both reach
 * it through the zone, and the first is the one handed over.
 */
describe('internalRunAppUrl', () => {
  const NEW = 'https://cloudgate-abc-123456789012.europe-west1.run.app';
  const OLD = 'https://cloudgate-abc-6qzq3k7vqa-ew.a.run.app';

  it("picks the project-number form in the service's region, in whatever order Google lists them", () => {
    expect(internalRunAppUrl([NEW, OLD], 'europe-west1')).toBe(NEW);
    expect(internalRunAppUrl([OLD, NEW], 'europe-west1')).toBe(NEW);
  });

  it('falls back to the first https URL, and to nothing when there is none', () => {
    expect(internalRunAppUrl([OLD], 'europe-west1')).toBe(OLD);
    expect(internalRunAppUrl([], 'europe-west1')).toBeNull();
    expect(internalRunAppUrl(undefined, 'europe-west1')).toBeNull();
    expect(internalRunAppUrl('not a list', 'europe-west1')).toBeNull();
  });
});
