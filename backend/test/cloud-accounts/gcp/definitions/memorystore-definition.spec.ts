import { memorystoreDefinition } from '../../../../src/cloud-accounts/gcp/definitions/memorystore-definition';
import { idKey } from '../../../../src/cloud-accounts/gcp/definitions/names';
import { renderDefinition } from '../../../../src/cloud-accounts/definitions/tofu-json';
import { addresses, resource } from '../../aws/definitions/definition-helpers';

const INPUT = {
  serviceId: 'Svc_Redis',
  cloudAccountId: 'Cloud_Acct-1',
  projectId: 'acme-prod-123',
  region: 'europe-west1',
  environmentId: 'Env_Prod',
  stateId: 'State_Redis-1',
  network: { networkName: 'cloudgate-envkey-net' },
  nodeType: 'CUSTOM_MICRO',
  engineVersion: 'VALKEY_8_0',
  highAvailability: false,
  backupRetentionDays: 1,
};

describe('memorystoreDefinition', () => {
  const definition = memorystoreDefinition(INPUT);
  const instance = resource(definition, 'google_memorystore_instance.cache');

  it('holds the one instance, and nothing else', () => {
    expect(addresses(definition)).toEqual([
      'google_memorystore_instance.cache',
    ]);
  });

  it('names the instance by the Service id’s key, in the region', () => {
    expect(instance.instance_id).toBe(`cloudgate-${idKey('Svc_Redis')}`);
    expect(instance.location).toBe('europe-west1');
  });

  it('has cluster mode off, one shard and one node, on the node type and Valkey version it is given', () => {
    expect(instance).toEqual(
      expect.objectContaining({
        mode: 'CLUSTER_DISABLED',
        shard_count: 1,
        replica_count: 0,
        node_type: 'CUSTOM_MICRO',
        engine_version: 'VALKEY_8_0',
      }),
    );
  });

  it('has one replica, two nodes, with high availability on', () => {
    const available = resource(
      memorystoreDefinition({ ...INPUT, highAvailability: true }),
      'google_memorystore_instance.cache',
    );

    expect(available).toEqual(
      expect.objectContaining({ shard_count: 1, replica_count: 1 }),
    );
  });

  it('takes an automated backup a day, kept for the Service’s retention', () => {
    expect(instance.automated_backup_config).toEqual({
      fixed_frequency_schedule: { start_time: { hours: 3 } },
      retention: '86400s',
    });
    expect(
      resource(
        memorystoreDefinition({ ...INPUT, backupRetentionDays: 365 }),
        'google_memorystore_instance.cache',
      ).automated_backup_config,
    ).toEqual(expect.objectContaining({ retention: '31536000s' }));
  });

  it.each([
    ['a retention of 0, which is off', 0],
    ['an instance made before backups', null],
  ])('takes no automated backups with %s', (_why, days) => {
    expect(
      resource(
        memorystoreDefinition({ ...INPUT, backupRetentionDays: days }),
        'google_memorystore_instance.cache',
      ),
    ).not.toHaveProperty('automated_backup_config');
  });

  it('always sets noeviction and turns deletion protection off', () => {
    expect(instance.engine_configs).toEqual({
      'maxmemory-policy': 'noeviction',
    });
    expect(instance.deletion_protection_enabled).toBe(false);
  });

  it('has no password and TLS with its own CA from create, and never changes them, nor cluster mode', () => {
    expect(instance).toEqual(
      expect.objectContaining({
        authorization_mode: 'AUTH_DISABLED',
        transit_encryption_mode: 'SERVER_AUTHENTICATION',
        server_ca_mode: 'GOOGLE_MANAGED_PER_INSTANCE_CA',
      }),
    );
    expect(instance.lifecycle).toEqual({
      ignore_changes: [
        'mode',
        'authorization_mode',
        'transit_encryption_mode',
        'server_ca_mode',
      ],
    });
  });

  it('is made by `hashicorp/google`, set up for the project and region, naming no provider of its own', () => {
    expect(instance).not.toHaveProperty('provider');
    const google = {
      project: 'acme-prod-123',
      region: 'europe-west1',
      add_terraform_attribution_label: false,
    };
    expect(definition.provider).toEqual({ google });
  });

  it('takes its address from the Environment network, through an automatically created endpoint', () => {
    expect(instance.desired_auto_created_endpoints).toEqual([
      {
        network: 'projects/acme-prod-123/global/networks/cloudgate-envkey-net',
        project_id: 'acme-prod-123',
      },
    ]);
  });

  it('carries the mark as its labels', () => {
    expect(instance.labels).toEqual({
      'cloudgate-cloud-account': idKey('Cloud_Acct-1'),
      'cloudgate-environment': idKey('Env_Prod'),
      'cloudgate-state': idKey('State_Redis-1'),
    });
  });

  it('answers its primary endpoint, its port and its own CA as a sensitive output; never a token', () => {
    const output = definition.output as Record<
      string,
      { value: string; sensitive?: boolean }
    >;
    expect(Object.keys(output).sort()).toEqual(['address', 'ca', 'port']);
    expect(output.address.value).toContain('CONNECTION_TYPE_PRIMARY');
    expect(output.address.value).toContain('ip_address');
    expect(output.ca.value).toContain('managed_server_ca');
    expect(output.ca.sensitive).toBe(true);
    expect(renderDefinition(definition)).not.toMatch(/token"\s*:/);
  });
});
