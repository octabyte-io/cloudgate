import { destroyDefinition } from '../../../../src/cloud-accounts/gcp/definitions/destroy-definition';
import { networkDefinition } from '../../../../src/cloud-accounts/gcp/definitions/network-definition';

describe('destroyDefinition (Google)', () => {
  it('is the backend and the provider for the project and region, with no resource at all', () => {
    const definition = destroyDefinition('acme-prod-123', 'europe-west1');
    expect(Object.keys(definition).sort()).toEqual(['provider', 'terraform']);
    const network = networkDefinition({
      cloudAccountId: 'a',
      projectId: 'acme-prod-123',
      region: 'europe-west1',
      environmentId: 'e',
      stateId: 's',
      domains: [],
      privateLinks: [],
    });
    const { google } = network.provider as { google: unknown };
    // `hashicorp/google` alone, a Memorystore instance's too.
    expect(definition.provider).toEqual({ google });
    expect(definition.terraform).toEqual(network.terraform);
  });
});
