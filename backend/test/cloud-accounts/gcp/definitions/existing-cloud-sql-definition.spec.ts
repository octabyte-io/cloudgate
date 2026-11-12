import { existingCloudSqlDefinition } from '../../../../src/cloud-accounts/gcp/definitions/existing-cloud-sql-definition';
import { idKey } from '../../../../src/cloud-accounts/gcp/definitions/names';
import { addresses, resource } from '../../aws/definitions/definition-helpers';

const ATTACHMENT =
  'projects/a1b2c3d4e5f6-tp/regions/europe-west1/serviceAttachments/a-1234-psc-service-attachment-abcd';
const NAME = '4c583468c161.1idghei1xv0vf.europe-west1.sql.goog.';

const INPUT = {
  serviceId: 'Svc_Pg',
  cloudAccountId: 'Cloud_Acct-1',
  projectId: 'shop-prod',
  region: 'europe-west1',
  environmentId: 'Env_Prod',
  stateId: 'State_Pg-1',
  serviceAttachment: ATTACHMENT,
  dnsName: NAME,
};

const NETWORK = `projects/shop-prod/global/networks/cloudgate-${idKey('Env_Prod')}-net`;

describe('existingCloudSqlDefinition', () => {
  const definition = existingCloudSqlDefinition(INPUT);
  const address = resource(definition, 'google_compute_address.endpoint');
  const rule = resource(definition, 'google_compute_forwarding_rule.endpoint');
  const zone = resource(definition, 'google_dns_managed_zone.instance');
  const record = resource(definition, 'google_dns_record_set.instance');

  it("holds one manual endpoint and one private zone with its record, and never the operator's instance", () => {
    expect(addresses(definition)).toEqual([
      'google_compute_address.endpoint',
      'google_compute_forwarding_rule.endpoint',
      'google_dns_managed_zone.instance',
      'google_dns_record_set.instance',
    ]);
    expect(JSON.stringify(definition)).not.toContain(
      'google_sql_database_instance',
    );
    // No automatic connection: that would be a setting on the instance.
    expect(JSON.stringify(definition)).not.toContain('psc_auto_connections');
  });

  it("takes the endpoint's address from the Environment network's private link subnet", () => {
    expect(address).toMatchObject({
      name: `cloudgate-${idKey('Svc_Pg')}-psc`,
      region: 'europe-west1',
      address_type: 'INTERNAL',
      subnetwork: `projects/shop-prod/regions/europe-west1/subnetworks/cloudgate-${idKey('Env_Prod')}-psc`,
    });
  });

  it("points the forwarding rule from the Environment network at the instance's service attachment", () => {
    expect(rule).toMatchObject({
      name: `cloudgate-${idKey('Svc_Pg')}-psc`,
      network: NETWORK,
      ip_address: '${google_compute_address.endpoint.id}',
      target: ATTACHMENT,
      load_balancing_scheme: '',
    });
  });

  it("names the private zone for exactly the instance's name as Google reports it, bound to the Environment network", () => {
    expect(zone).toMatchObject({
      dns_name: NAME,
      visibility: 'private',
      private_visibility_config: { networks: [{ network_url: NETWORK }] },
    });
  });

  it('records that name as an A record to the endpoint', () => {
    expect(record).toMatchObject({
      name: NAME,
      managed_zone: '${google_dns_managed_zone.instance.name}',
      type: 'A',
      ttl: 300,
      rrdatas: ['${google_compute_address.endpoint.address}'],
    });
  });

  it("carries Cloudgate's mark on the address, the rule and the zone", () => {
    for (const marked of [address, rule, zone]) {
      expect(marked.labels).toEqual({
        'cloudgate-cloud-account': idKey('Cloud_Acct-1'),
        'cloudgate-environment': idKey('Env_Prod'),
        'cloudgate-state': idKey('State_Pg-1'),
      });
      expect(marked.description).toBe(
        'Cloudgate cloud-account=Cloud_Acct-1 environment=Env_Prod state=State_Pg-1',
      );
    }
  });
});
