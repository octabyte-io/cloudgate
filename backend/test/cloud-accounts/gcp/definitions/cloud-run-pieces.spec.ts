import {
  cloudRunPieces,
  webDefinition,
} from '../../../../src/cloud-accounts/gcp/definitions/cloud-run-definition';
import { addresses } from '../../aws/definitions/definition-helpers';
import type { WebEntry } from '../../../../src/project-config';

const ENTRY: WebEntry = {
  kind: 'web',
  managed: false,
  env: [],
  port: 8080,
  buildArgs: [],
  buildSecrets: [],
};

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
  variables: { API_KEY: 'k', EMPTY: '' },
};

const KEPT = [
  'google_artifact_registry_repository.service',
  'google_service_account.service',
  'google_secret_manager_secret.variable',
  'google_secret_manager_secret_version.variable',
  'google_secret_manager_secret_iam_member.variable',
];

/**
 * The pieces every Cloud Run resource of a Service keeps whatever its routing:
 * a later Cron service's job is built from them with no Cloud Run service.
 */
describe('cloudRunPieces', () => {
  it('makes the repository, service account and secrets with no Cloud Run service', () => {
    const placed = cloudRunPieces({
      configName: INPUT.configName,
      serviceId: INPUT.service.serviceId,
      cloudAccountId: INPUT.cloudAccountId,
      projectId: INPUT.projectId,
      region: INPUT.region,
      environmentId: INPUT.environmentId,
      stateId: INPUT.stateId,
      variables: INPUT.variables,
    });
    if (!placed.ok) throw new Error(placed.refusal.message);
    expect(addresses(placed.pieces.finish({}).definition)).toEqual(
      [...KEPT].sort(),
    );
    expect(placed.pieces.variables).toEqual({ variable_value_API_KEY: 'k' });
  });

  it('are the same pieces a web on Cloud Run holds', () => {
    const web = webDefinition(INPUT);
    if (!web.ok) throw new Error(web.refusal.message);
    expect(addresses(web.definition)).toEqual(
      [
        ...KEPT,
        'google_cloud_run_v2_service.service',
        'google_compute_region_network_endpoint_group.service',
        'google_compute_backend_service.service',
      ].sort(),
    );
  });

  it('refuses a variable Google cannot hold, naming it, before anything is made', () => {
    const placed = cloudRunPieces({
      configName: 'api',
      serviceId: 'Svc_Web',
      cloudAccountId: 'Cloud_Acct-1',
      projectId: 'acme-prod-123',
      region: 'europe-west1',
      environmentId: 'Env_Prod',
      stateId: 'State_Svc-1',
      variables: { PORT: '1' },
    });
    expect(placed).toEqual({
      ok: false,
      refusal: {
        at: 'api.env',
        message: expect.stringMatching(
          /PORT is set by Cloud Run itself/,
        ) as string,
      },
    });
  });
});
