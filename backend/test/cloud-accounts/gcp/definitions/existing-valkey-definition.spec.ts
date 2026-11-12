import { existingValkeyDefinition } from '../../../../src/cloud-accounts/gcp/definitions/existing-valkey-definition';
import { idKey } from '../../../../src/cloud-accounts/gcp/definitions/names';
import { addresses, resource } from '../../aws/definitions/definition-helpers';

const PRIMARY =
  'projects/y1a2b3c4d5e6f7-tp/regions/europe-west1/serviceAttachments/gcp-memorystore-auto-a1b2-psc-sa';
const READER =
  'projects/y1a2b3c4d5e6f7-tp/regions/europe-west1/serviceAttachments/gcp-memorystore-auto-a1b2-psc-sa-2';

const INPUT = {
  serviceId: 'Svc_Cache',
  cloudAccountId: 'Cloud_Acct-1',
  projectId: 'shop-prod',
  region: 'europe-west1',
  environmentId: 'Env_Prod',
  stateId: 'State_Cache-1',
  serviceAttachments: { primary: PRIMARY, reader: READER },
};

const NETWORK = `projects/shop-prod/global/networks/cloudgate-${idKey('Env_Prod')}-net`;
const SUBNET = `projects/shop-prod/regions/europe-west1/subnetworks/cloudgate-${idKey('Env_Prod')}-psc`;

describe('existingValkeyDefinition', () => {
  const definition = existingValkeyDefinition(INPUT);

  it("holds two manual endpoints and never the operator's instance", () => {
    expect(addresses(definition)).toEqual([
      'google_compute_address.primary',
      'google_compute_address.reader',
      'google_compute_forwarding_rule.primary',
      'google_compute_forwarding_rule.reader',
    ]);
    expect(JSON.stringify(definition)).not.toContain(
      'google_memorystore_instance',
    );
    // No automatic connection, and no private zone: Valkey is reached at its endpoint's address.
    expect(JSON.stringify(definition)).not.toContain('psc_auto_connections');
    expect(JSON.stringify(definition)).not.toContain('google_dns');
  });

  it.each([
    ['primary', 0, PRIMARY],
    ['reader', 1, READER],
  ])(
    'points the %s endpoint from the private link subnet at that service attachment',
    (endpoint, index, attachment) => {
      const name = `cloudgate-${idKey('Svc_Cache')}-psc-${index}`;
      expect(
        resource(definition, `google_compute_address.${endpoint}`),
      ).toMatchObject({
        name,
        region: 'europe-west1',
        address_type: 'INTERNAL',
        subnetwork: SUBNET,
      });
      expect(
        resource(definition, `google_compute_forwarding_rule.${endpoint}`),
      ).toMatchObject({
        name,
        network: NETWORK,
        ip_address: `\${google_compute_address.${endpoint}.id}`,
        target: attachment,
        load_balancing_scheme: '',
      });
    },
  );

  it("carries Cloudgate's mark on each address and rule", () => {
    for (const address of addresses(definition)) {
      expect(resource(definition, address).labels).toEqual({
        'cloudgate-cloud-account': idKey('Cloud_Acct-1'),
        'cloudgate-environment': idKey('Env_Prod'),
        'cloudgate-state': idKey('State_Cache-1'),
      });
    }
  });

  it("outputs each endpoint's address, rule name and connection id, which --add-endpoints names", () => {
    expect(definition.output).toEqual({
      primary_address: { value: '${google_compute_address.primary.address}' },
      primary_name: { value: '${google_compute_forwarding_rule.primary.name}' },
      primary_psc_connection_id: {
        value: '${google_compute_forwarding_rule.primary.psc_connection_id}',
      },
      reader_address: { value: '${google_compute_address.reader.address}' },
      reader_name: { value: '${google_compute_forwarding_rule.reader.name}' },
      reader_psc_connection_id: {
        value: '${google_compute_forwarding_rule.reader.psc_connection_id}',
      },
    });
  });
});
