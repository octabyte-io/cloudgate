import {
  GCP_REPOSITORY_ADDRESSES,
  webDefinition,
} from '../../../../src/cloud-accounts/gcp/definitions/cloud-run-definition';
import { idKey } from '../../../../src/cloud-accounts/gcp/definitions/names';
import { gcpNetworkStandIns } from '../../../../src/cloud-accounts/gcp/definitions/stand-ins';
import { backendServicePath } from '../../../../src/cloud-accounts/gcp/definitions/tofu-json';
import {
  isStandIn,
  STAND_IN_IMAGE_TAG,
} from '../../../../src/cloud-accounts/aws/definitions/stand-ins';
import { renderDefinition } from '../../../../src/cloud-accounts/definitions/tofu-json';
import {
  addresses,
  resource,
  resources,
} from '../../aws/definitions/definition-helpers';
import type { WebEntry } from '../../../../src/project-config';

const ENTRY: WebEntry = {
  kind: 'web',
  managed: false,
  env: [],
  port: 8080,
  buildArgs: [],
  buildSecrets: [],
};

const SERVICE = `cloudgate-${idKey('Svc_Web')}`;

/**
 * The google provider's resources that have a `labels` argument, read from
 * the provider's own documentation (hashicorp/google 8.x), among the kinds a
 * Service's state makes (S5). Service accounts, NEGs, backend services,
 * secret versions and IAM members have none.
 */
const LABELLED_TYPES = [
  'google_artifact_registry_repository',
  'google_cloud_run_v2_service',
  'google_secret_manager_secret',
];

/**
 * The same kinds with a `description` argument. A secret has none, and
 * neither does its version or an IAM member.
 */
const DESCRIBED_TYPES = [
  'google_artifact_registry_repository',
  'google_service_account',
  'google_cloud_run_v2_service',
  'google_compute_region_network_endpoint_group',
  'google_compute_backend_service',
];

const INPUT = {
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
  variables: {},
};

function definitionOf(input: Parameters<typeof webDefinition>[0]) {
  const result = webDefinition(input);
  if (!result.ok) throw new Error(result.refusal.message);
  return result;
}

describe('webDefinition (Google)', () => {
  it('holds the repository, service account, Cloud Run service, serverless NEG and backend service', () => {
    expect(addresses(definitionOf(INPUT).definition)).toEqual(
      [
        'google_artifact_registry_repository.service',
        'google_service_account.service',
        'google_cloud_run_v2_service.service',
        'google_compute_region_network_endpoint_group.service',
        'google_compute_backend_service.service',
      ].sort(),
    );
  });

  describe('the repository', () => {
    it('is Docker, in the region, with mutable tags, which the clean-up after a deploy can delete, and a live one-day clean-up of untagged versions', () => {
      expect(
        resource(
          definitionOf(INPUT).definition,
          'google_artifact_registry_repository.service',
        ),
      ).toMatchObject({
        repository_id: SERVICE,
        location: 'europe-west1',
        format: 'DOCKER',
        docker_config: { immutable_tags: false },
        cleanup_policy_dry_run: false,
        cleanup_policies: [
          {
            action: 'DELETE',
            condition: { tag_state: 'UNTAGGED', older_than: '86400s' },
          },
        ],
      });
    });

    it('ignores its docker_config once made, since Google reads mutable tags back as no block at all', () => {
      expect(
        resource(
          definitionOf(INPUT).definition,
          'google_artifact_registry_repository.service',
        ),
      ).toMatchObject({ lifecycle: { ignore_changes: ['docker_config'] } });
    });

    it('is what the first deploy applies before it pushes', () => {
      expect(GCP_REPOSITORY_ADDRESSES).toEqual([
        'google_artifact_registry_repository.service',
      ]);
    });
  });

  describe('the Cloud Run service', () => {
    const run = resource(
      definitionOf(INPUT).definition,
      'google_cloud_run_v2_service.service',
    );
    const template = run.template as Record<string, unknown>;
    const [container] = template.containers as Record<string, unknown>[];

    it('takes traffic from anywhere with the invoker check off, and can be deleted', () => {
      expect(run).toMatchObject({
        name: SERVICE,
        location: 'europe-west1',
        ingress: 'INGRESS_TRAFFIC_ALL',
        invoker_iam_disabled: true,
        deletion_protection: false,
      });
    });

    it('runs as the Service’s own account, on the subnet for private ranges only', () => {
      expect(
        resource(
          definitionOf(INPUT).definition,
          'google_service_account.service',
        ),
      ).toMatchObject({ account_id: SERVICE });
      expect(template).toMatchObject({
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

    it('writes the create-time copy range', () => {
      const copies = definitionOf({
        ...INPUT,
        service: { serviceId: 'Svc_Web', copies: { min: 1, max: 4 } },
      });
      expect(
        (
          resource(copies.definition, 'google_cloud_run_v2_service.service')
            .template as Record<string, unknown>
        ).scaling,
      ).toEqual({ min_instance_count: 1, max_instance_count: 4 });
      expect(template.scaling).toEqual({
        min_instance_count: 0,
        max_instance_count: 10,
      });
    });

    it('runs the pair with CPU only during requests', () => {
      expect(container.resources).toEqual({
        limits: { cpu: '1', memory: '512Mi' },
        cpu_idle: true,
      });
      const big = definitionOf({ ...INPUT, pair: { cpu: 2, memoryMb: 3072 } });
      const [bigContainer] = (
        resource(big.definition, 'google_cloud_run_v2_service.service')
          .template as { containers: Record<string, unknown>[] }
      ).containers;
      expect(bigContainer.resources).toMatchObject({
        limits: { cpu: '2', memory: '3Gi' },
      });
    });

    it('tags the image with the Deployment id, in the Service’s own repository', () => {
      expect(container).toMatchObject({
        name: 'service',
        image:
          'europe-west1-docker.pkg.dev/acme-prod-123/${google_artifact_registry_repository.service.repository_id}/service:Dep_123',
        ports: { container_port: 8080 },
      });
    });

    it('ignores Stop’s scaling and launch stage, the copy range, Reload’s label and the client fields', () => {
      expect(run.lifecycle).toEqual({
        ignore_changes: [
          'scaling',
          'launch_stage',
          'template[0].scaling',
          'template[0].labels["cloudgate-reload"]',
          'client',
          'client_version',
        ],
      });
    });

    it('gives the entry’s command and args, escaped against ${ and %{', () => {
      const odd = definitionOf({
        ...INPUT,
        entry: { ...INPUT.entry, command: 'node ${x}', args: ['%{y}'] },
      });
      const [oddContainer] = (
        resource(odd.definition, 'google_cloud_run_v2_service.service')
          .template as { containers: Record<string, unknown>[] }
      ).containers;
      expect(oddContainer).toMatchObject({
        command: ['node', '$${x}'],
        args: ['%%{y}'],
      });
    });
  });

  it('routes the load balancer to the Cloud Run service through a serverless NEG and a backend service the network’s URL map names', () => {
    const { definition } = definitionOf(INPUT);
    expect(
      resource(
        definition,
        'google_compute_region_network_endpoint_group.service',
      ),
    ).toMatchObject({
      name: SERVICE,
      region: 'europe-west1',
      network_endpoint_type: 'SERVERLESS',
      cloud_run: { service: '${google_cloud_run_v2_service.service.name}' },
    });
    const backend = resource(
      definition,
      'google_compute_backend_service.service',
    );
    expect(backend).toMatchObject({
      load_balancing_scheme: 'EXTERNAL_MANAGED',
      backend: {
        group: '${google_compute_region_network_endpoint_group.service.id}',
      },
    });
    expect(backendServicePath('acme-prod-123', backend.name as string)).toBe(
      `projects/acme-prod-123/global/backendServices/cloudgate-${idKey('Svc_Web')}`,
    );
  });

  it('outputs the run.app address, the service’s name and where to push', () => {
    expect(definitionOf(INPUT).definition.output).toEqual({
      service_uri: { value: '${google_cloud_run_v2_service.service.uri}' },
      service_name: { value: '${google_cloud_run_v2_service.service.name}' },
      repository_url: {
        value:
          'europe-west1-docker.pkg.dev/acme-prod-123/${google_artifact_registry_repository.service.repository_id}',
      },
    });
  });

  describe('variables', () => {
    const VALUES = { API_KEY: 'sk-live-1', DB_URL: 'postgres://u:p@h/d' };

    it('with none, makes no secret', () => {
      const { definition, variables } = definitionOf(INPUT);
      expect(
        resources(definition).filter((r) => r.type.startsWith('google_secret')),
      ).toEqual([]);
      expect(definition).not.toHaveProperty('variable');
      expect(variables).toEqual({});
    });

    it('with two, makes a secret, a version and one grant to the Service’s account each', () => {
      const { definition } = definitionOf({ ...INPUT, variables: VALUES });
      const names = {
        API_KEY: `cloudgate-${idKey('Svc_Web')}-API_KEY`,
        DB_URL: `cloudgate-${idKey('Svc_Web')}-DB_URL`,
      };
      expect(
        resource(definition, 'google_secret_manager_secret.variable'),
      ).toMatchObject({
        for_each: names,
        secret_id: '${each.value}',
        replication: { auto: {} },
      });
      expect(
        resource(definition, 'google_secret_manager_secret_version.variable'),
      ).toMatchObject({
        for_each: names,
        secret: '${google_secret_manager_secret.variable[each.key].id}',
        secret_data: '${local.variable_values[each.key]}',
      });
      expect(
        resource(
          definition,
          'google_secret_manager_secret_iam_member.variable',
        ),
      ).toEqual({
        for_each: names,
        secret_id: '${google_secret_manager_secret.variable[each.key].id}',
        role: 'roles/secretmanager.secretAccessor',
        member: '${google_service_account.service.member}',
      });
      // The Service's account holds no other role (S8).
      expect(
        resources(definition).filter((r) => r.type.includes('iam')),
      ).toHaveLength(1);
    });

    it('references each secret by version from the revision, after the grants', () => {
      const { definition } = definitionOf({
        ...INPUT,
        variables: { ...VALUES, EMPTY: '' },
      });
      const run = resource(definition, 'google_cloud_run_v2_service.service');
      const [container] = (run.template as { containers: { env: unknown }[] })
        .containers;
      expect(container.env).toEqual([
        {
          name: 'API_KEY',
          value_source: {
            secret_key_ref: {
              secret:
                '${google_secret_manager_secret.variable["API_KEY"].secret_id}',
              version:
                '${google_secret_manager_secret_version.variable["API_KEY"].version}',
            },
          },
        },
        {
          name: 'DB_URL',
          value_source: {
            secret_key_ref: {
              secret:
                '${google_secret_manager_secret.variable["DB_URL"].secret_id}',
              version:
                '${google_secret_manager_secret_version.variable["DB_URL"].version}',
            },
          },
        },
        // An empty value has nothing to keep secret.
        { name: 'EMPTY', value: '' },
      ]);
      expect(run.depends_on).toEqual([
        'google_secret_manager_secret_iam_member.variable',
      ]);
    });

    it('passes values only as sensitive variables, never in the definition', () => {
      const { definition, variables } = definitionOf({
        ...INPUT,
        variables: VALUES,
      });
      const text = renderDefinition(definition);
      for (const value of Object.values(VALUES)) {
        expect(text).not.toContain(value);
      }
      expect(variables).toEqual({
        variable_value_API_KEY: 'sk-live-1',
        variable_value_DB_URL: 'postgres://u:p@h/d',
      });
      expect(definition.variable).toEqual({
        variable_value_API_KEY: {
          type: 'string',
          sensitive: true,
          nullable: false,
        },
        variable_value_DB_URL: {
          type: 'string',
          sensitive: true,
          nullable: false,
        },
      });
    });

    it.each([
      [
        'a name a secret cannot take',
        { 'A.B': 'x' },
        /A\.B cannot be a Secret Manager secret name/,
      ],
      [
        'a name Cloud Run sets itself',
        { PORT: '1' },
        /PORT is set by Cloud Run itself/,
      ],
      ['a value over 64 KB', { BIG: 'x'.repeat(65537) }, /BIG is 65537 bytes/],
    ])('refuses %s, naming it', (_case, variables, message) => {
      const result = webDefinition({ ...INPUT, variables });
      expect(result).toEqual({
        ok: false,
        refusal: {
          at: 'api.env',
          message: expect.stringMatching(message) as string,
        },
      });
    });
  });

  describe('the mark', () => {
    const { definition } = definitionOf({
      ...INPUT,
      variables: { API_KEY: 'v' },
    });
    const MARK =
      'Cloudgate cloud-account=Cloud_Acct-1 environment=Env_Prod state=State_Svc-1';

    it('names every per-Service thing cloudgate-<service key>, within the service-account limit', () => {
      expect(SERVICE).toMatch(/^cloudgate-[a-z2-7]{12}$/);
      expect(SERVICE.length).toBeLessThanOrEqual(30);
      for (const address of [
        'google_cloud_run_v2_service.service',
        'google_compute_region_network_endpoint_group.service',
        'google_compute_backend_service.service',
      ]) {
        expect([address, resource(definition, address).name]).toEqual([
          address,
          SERVICE,
        ]);
      }
    });

    it('puts the unencoded ids in the description of every kind that has one', () => {
      for (const { address, type, body } of resources(definition)) {
        expect([address, body.description]).toEqual([
          address,
          DESCRIBED_TYPES.includes(type) ? MARK : undefined,
        ]);
      }
    });

    it('labels only the kinds whose resource takes labels, with the ids’ keys', () => {
      const labels = {
        'cloudgate-cloud-account': idKey('Cloud_Acct-1'),
        'cloudgate-environment': idKey('Env_Prod'),
        'cloudgate-state': idKey('State_Svc-1'),
      };
      for (const { address, type, body } of resources(definition)) {
        expect([address, body.labels]).toEqual([
          address,
          LABELLED_TYPES.includes(type) ? labels : undefined,
        ]);
      }
    });
  });

  describe('before the network is made', () => {
    it('accepts stand-in network names, marked as stand-ins', () => {
      const { definition } = definitionOf({
        ...INPUT,
        network: gcpNetworkStandIns(),
        imageTag: STAND_IN_IMAGE_TAG,
      });
      const template = resource(
        definition,
        'google_cloud_run_v2_service.service',
      ).template as {
        vpc_access: { network_interfaces: Record<string, string>[] };
        containers: { image: string }[];
      };
      const [nic] = template.vpc_access.network_interfaces;
      expect(isStandIn(nic.network)).toBe(true);
      expect(isStandIn(nic.subnetwork)).toBe(true);
      expect(nic.subnetwork).toMatch(/^[a-z]([-a-z0-9]*[a-z0-9])?$/);
      expect(isStandIn(template.containers[0].image)).toBe(true);
      expect(isStandIn(INPUT.network.subnetName)).toBe(false);
    });
  });

  it('writes the same text for the same input, whatever order the variables come in', () => {
    const input = {
      ...INPUT,
      variables: { B: '2', A: '1', C: '' },
    };
    expect(renderDefinition(definitionOf(input).definition)).toBe(
      renderDefinition(
        definitionOf({ ...input, variables: { C: '', A: '1', B: '2' } })
          .definition,
      ),
    );
  });
});
