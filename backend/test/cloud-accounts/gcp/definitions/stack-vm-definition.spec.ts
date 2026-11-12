import {
  GOOGLE_STACK_VM_DOMAIN_ADDRESSES,
  GOOGLE_STACK_VM_OUTPUTS,
  IAP_TUNNEL_RANGE,
  UBUNTU_IMAGE_PROJECT,
  LOAD_BALANCER_RANGES,
  stackVmBackendName,
  googleStackVmDefinition,
  stackVmZone,
} from '../../../../src/cloud-accounts/gcp/definitions/stack-vm-definition';
import type { GoogleStackVmDefinitionInput } from '../../../../src/cloud-accounts/gcp/definitions/stack-vm-definition';
import {
  COMPOSE_PLUGIN_VERSION,
  DOCKER_ENGINE_VERSION,
  stackVmPinsOn,
} from '../../../../src/cloud-accounts/definitions/stack-vm-pins';
import {
  markDescription,
  stateLabels,
} from '../../../../src/cloud-accounts/gcp/definitions/mark';
import { idKey } from '../../../../src/cloud-accounts/gcp/definitions/names';
import {
  addresses,
  resource,
  resources,
} from '../../aws/definitions/definition-helpers';

/**
 * A Compose stack's Stack VM on Google Cloud (ADR-0070, #1362): what
 * OpenTofu is asked to make, from the stack's settings.
 */

function input(
  overrides: Partial<GoogleStackVmDefinitionInput> = {},
): GoogleStackVmDefinitionInput {
  return {
    configName: 'analytics',
    serviceId: 'Cmp_Id-1',
    cloudAccountId: 'Cloud_Acct-1',
    projectId: 'acme-prod-123',
    region: 'europe-west1',
    environmentId: 'Env_Prod',
    stateId: 'State_Analytics',
    network: {
      networkName: 'cloudgate-envkey-net',
      subnetName: 'cloudgate-envkey-subnet',
    },
    machineType: 'e2-small',
    dataDiskGb: 20,
    snapshotDays: 7,
    imageId: null,
    zone: null,
    sshPublicKey: null,
    pins: stackVmPinsOn('gcp'),
    ...overrides,
  };
}

const MARK = {
  cloudAccountId: 'Cloud_Acct-1',
  environmentId: 'Env_Prod',
  stateId: 'State_Analytics',
};
const NAME = `cloudgate-${idKey('Cmp_Id-1')}`;
const INSTANCE = 'google_compute_instance.stack_vm';

function instance(overrides: Partial<GoogleStackVmDefinitionInput> = {}) {
  return resource(
    googleStackVmDefinition(input(overrides)).definition,
    INSTANCE,
  );
}

describe('googleStackVmDefinition', () => {
  it('makes the Stack VM, its service account, its IAP firewall rule, its data disk and its snapshot schedule', () => {
    expect(addresses(googleStackVmDefinition(input()).definition)).toEqual([
      'google_compute_disk.data',
      'google_compute_disk_resource_policy_attachment.snapshots',
      'google_compute_firewall.iap',
      'google_compute_instance.stack_vm',
      'google_compute_resource_policy.snapshots',
      'google_service_account.stack_vm',
    ]);
  });

  it("puts it on the Environment network's subnet with no external IP, restarted by Google when it dies", () => {
    const vm = instance();
    expect(vm.machine_type).toBe('e2-small');
    expect(vm.zone).toBe('europe-west1-b');
    expect(vm.network_interface).toEqual([
      {
        network: 'projects/acme-prod-123/global/networks/cloudgate-envkey-net',
        subnetwork:
          'projects/acme-prod-123/regions/europe-west1/subnetworks/cloudgate-envkey-subnet',
      },
    ]);
    expect(vm.scheduling).toEqual({
      automatic_restart: true,
      on_host_maintenance: 'MIGRATE',
    });
    expect(vm.can_ip_forward).toBe(false);
    expect(vm.deletion_protection).toBe(false);
    // A new machine type is applied by stopping and starting it.
    expect(vm.allow_stopping_for_update).toBe(true);
  });

  it("boots the pinned Ubuntu 24.04 build from Canonical's project when none is recorded", () => {
    const { definition } = googleStackVmDefinition(
      input({
        pins: {
          image: 'ubuntu-2404-noble-amd64-v20261105',
          dockerEngine: DOCKER_ENGINE_VERSION,
          composePlugin: COMPOSE_PLUGIN_VERSION,
        },
      }),
    );
    expect(UBUNTU_IMAGE_PROJECT).toBe('ubuntu-os-cloud');
    expect(definition.data).toEqual({
      google_compute_image: {
        ubuntu: {
          project: 'ubuntu-os-cloud',
          name: 'ubuntu-2404-noble-amd64-v20261105',
        },
      },
    });
    expect(
      (instance().boot_disk as { initialize_params: { image: string } })
        .initialize_params.image,
    ).toBe('${data.google_compute_image.ubuntu.self_link}');
  });

  it('keeps the image and zone recorded in the stack’s settings, reading no image', () => {
    const recorded =
      'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20261101';
    const { definition } = googleStackVmDefinition(
      input({ imageId: recorded, zone: 'europe-west1-c' }),
    );
    expect(definition.data).toBeUndefined();
    const vm = resource(definition, INSTANCE);
    expect(
      (vm.boot_disk as { initialize_params: { image: string } })
        .initialize_params.image,
    ).toBe(recorded);
    expect(vm.zone).toBe('europe-west1-c');
    expect(resource(definition, 'google_compute_disk.data').zone).toBe(
      'europe-west1-c',
    );
  });

  describe('once made (#1368)', () => {
    const old = {
      image: 'ubuntu-2404-noble-amd64-v20260101',
      dockerEngine: '5:28.0.0-1~ubuntu.24.04~noble',
      composePlugin: '2.30.0-1~ubuntu.24.04~noble',
    };
    const made = (pins = old) =>
      resource(
        googleStackVmDefinition(
          input({ imageId: 'recorded-image', zone: 'europe-west1-b', pins }),
        ).definition,
        INSTANCE,
      );

    it('installs the pins it was made with, not the ones Cloudgate pins now', () => {
      const userData = (made().metadata as Record<string, string>)['user-data'];
      expect(userData).toContain('docker-ce=5:28.0.0-1~ubuntu.24.04~noble');
    });

    it('never changes its first boot in place, which it never reads again; only an approved replace makes it anew', () => {
      expect(made().lifecycle).toEqual({
        ignore_changes: ['metadata["user-data"]'],
      });
    });
  });

  it("puts a Stack VM in its region's zone b", () => {
    expect(stackVmZone('us-east1')).toBe('us-east1-b');
  });

  it('outputs the image, zone and ids the Apply records, and the pins it was made with', () => {
    const generated = googleStackVmDefinition(input());
    expect(generated.pins).toEqual(stackVmPinsOn('gcp'));
    expect(Object.keys(generated.definition.output as object).sort()).toEqual(
      Object.values(GOOGLE_STACK_VM_OUTPUTS).sort(),
    );
  });

  it('runs it as its own service account, which holds no role', () => {
    const { definition } = googleStackVmDefinition(input());
    expect(resource(definition, 'google_service_account.stack_vm')).toEqual(
      expect.objectContaining({ account_id: NAME }),
    );
    expect(instance().service_account).toEqual({
      email: '${google_service_account.stack_vm.email}',
      scopes: ['cloud-platform'],
    });
    expect(
      resources(definition).some((one) => one.type.endsWith('_iam_member')),
    ).toBe(false);
  });

  it("lets IAP's TCP forwarding range in on SSH only, to this Stack VM alone", () => {
    const rule = resource(
      googleStackVmDefinition(input()).definition,
      'google_compute_firewall.iap',
    );
    expect(IAP_TUNNEL_RANGE).toBe('35.235.240.0/20');
    expect(rule).toEqual(
      expect.objectContaining({
        name: `${NAME}-iap`,
        network: 'projects/acme-prod-123/global/networks/cloudgate-envkey-net',
        direction: 'INGRESS',
        source_ranges: ['35.235.240.0/20'],
        allow: [{ protocol: 'tcp', ports: ['22'] }],
        target_service_accounts: ['${google_service_account.stack_vm.email}'],
      }),
    );
  });

  it('makes a separate 20 GB persistent disk in its zone, attached to it', () => {
    const { definition } = googleStackVmDefinition(input());
    expect(resource(definition, 'google_compute_disk.data')).toEqual(
      expect.objectContaining({
        name: `${NAME}-data`,
        zone: 'europe-west1-b',
        size: 20,
        type: 'pd-balanced',
      }),
    );
    expect(instance().attached_disk).toEqual([
      {
        source: '${google_compute_disk.data.self_link}',
        device_name: 'cloudgate-data',
        mode: 'READ_WRITE',
      },
    ]);
  });

  it('snapshots the data disk daily, keeping 7 days', () => {
    const { definition } = googleStackVmDefinition(input());
    const policy = resource(
      definition,
      'google_compute_resource_policy.snapshots',
    );
    expect(policy.snapshot_schedule_policy).toEqual({
      schedule: {
        daily_schedule: { days_in_cycle: 1, start_time: '03:00' },
      },
      retention_policy: {
        max_retention_days: 7,
        on_source_disk_delete: 'APPLY_RETENTION_POLICY',
      },
      snapshot_properties: { storage_locations: ['europe-west1'] },
    });
    expect(
      resource(
        definition,
        'google_compute_disk_resource_policy_attachment.snapshots',
      ),
    ).toEqual({
      name: '${google_compute_resource_policy.snapshots.name}',
      disk: '${google_compute_disk.data.name}',
      zone: 'europe-west1-b',
    });
  });

  it("carries Cloudgate's mark on every resource: its description, and its labels where it takes them", () => {
    const { definition } = googleStackVmDefinition(input());
    for (const { type, body } of resources(definition)) {
      // An attachment has no description; its disk and policy carry the mark.
      if (type === 'google_compute_disk_resource_policy_attachment') continue;
      expect([type, body.description]).toEqual([type, markDescription(MARK)]);
    }
    expect(instance().labels).toEqual(stateLabels(MARK));
    expect(resource(definition, 'google_compute_disk.data').labels).toEqual(
      stateLabels(MARK),
    );
  });

  it('names everything by the stack’s id, so a lost state finds it again by name', () => {
    const { definition } = googleStackVmDefinition(input());
    for (const { type, body } of resources(definition)) {
      const name = (body.account_id ?? body.name) as string;
      if (type === 'google_compute_disk_resource_policy_attachment') continue;
      expect([type, name.startsWith(NAME)]).toEqual([type, true]);
    }
  });

  describe('its first boot', () => {
    const userData = (overrides: Partial<GoogleStackVmDefinitionInput> = {}) =>
      (instance(overrides).metadata as Record<string, string>)['user-data'];

    it('is cloud-config that installs the pinned Docker Engine and compose plugin', () => {
      expect(userData()).toMatch(/^#cloud-config\n/);
      expect(userData()).toContain(`docker-ce=${DOCKER_ENGINE_VERSION}`);
      expect(userData()).toContain(
        `docker-compose-plugin=${COMPOSE_PLUGIN_VERSION}`,
      );
    });

    it("mounts the data disk as Docker's volume folder, with unattended security updates and no automatic reboot", () => {
      expect(userData()).toContain('/var/lib/docker/volumes');
      expect(userData()).toContain('Unattended-Upgrade "1"');
      expect(userData()).toContain('Automatic-Reboot "false"');
    });

    it("authorizes the stack's own SSH key, which IAP's tunnel reaches it with", () => {
      const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStackVmKey';
      const text = userData({ sshPublicKey: key });
      expect(text).toContain('disable_root: false\n');
      expect(text).toContain(
        `  - name: root\n    ssh_authorized_keys:\n      - ${key}\n`,
      );
    });

    it('authorizes no key while its stack has none yet (a plan read before the Apply)', () => {
      expect(userData()).not.toContain('ssh_authorized_keys');
    });

    it("makes the shared network a stack's compose file is joined to", () => {
      expect(userData()).toContain('docker network create cloudgate-network');
    });
  });

  describe('its Domains (#1371)', () => {
    const withPorts = (ports: number[]) =>
      googleStackVmDefinition(input({ ports })).definition;

    it('makes no load balancer piece while the stack has no Domain', () => {
      const made = addresses(googleStackVmDefinition(input()).definition);
      expect(made).not.toContain('google_compute_instance_group.stack_vm');
      expect(made).not.toContain('google_compute_backend_service.stack_vm');
      expect(made).not.toContain('google_compute_firewall.load_balancer');
    });

    it("puts the Stack VM in an instance group naming each port a Domain reaches, as the load balancer's backend", () => {
      expect(
        resource(
          withPorts([8080, 3000]),
          'google_compute_instance_group.stack_vm',
        ),
      ).toMatchObject({
        name: `${NAME}-group`,
        description: markDescription(MARK),
        zone: 'europe-west1-b',
        instances: ['${google_compute_instance.stack_vm.self_link}'],
        named_port: [
          { name: 'p3000', port: 3000 },
          { name: 'p8080', port: 8080 },
        ],
      });
    });

    it('gives each port a backend service on the global load balancer, named for the URL map, with its own health check', () => {
      const definition = withPorts([3000]);
      expect(
        resource(definition, 'google_compute_backend_service.stack_vm'),
      ).toMatchObject({
        for_each: { '3000': 3000 },
        name: `${NAME}-p\${each.key}`,
        description: markDescription(MARK),
        load_balancing_scheme: 'EXTERNAL_MANAGED',
        protocol: 'HTTP',
        port_name: 'p${each.key}',
        backend: [
          { group: '${google_compute_instance_group.stack_vm.self_link}' },
        ],
        health_checks: ['${google_compute_health_check.stack_vm[each.key].id}'],
      });
      expect(
        resource(definition, 'google_compute_health_check.stack_vm'),
      ).toMatchObject({
        for_each: { '3000': 3000 },
        tcp_health_check: { port: '${each.value}' },
      });
      expect(stackVmBackendName('Cmp_Id-1', 3000)).toBe(`${NAME}-p3000`);
    });

    it("lets the load balancer's ranges in on the target ports alone, to the Stack VM alone", () => {
      expect(LOAD_BALANCER_RANGES).toEqual(['35.191.0.0/16', '130.211.0.0/22']);
      expect(
        resource(
          withPorts([8080, 3000]),
          'google_compute_firewall.load_balancer',
        ),
      ).toMatchObject({
        name: `${NAME}-lb`,
        direction: 'INGRESS',
        source_ranges: LOAD_BALANCER_RANGES,
        allow: [{ protocol: 'tcp', ports: ['3000', '8080'] }],
        target_service_accounts: ['${google_service_account.stack_vm.email}'],
      });
    });

    it('writes none of them once the last Domain is removed, so its targeted run destroys what its state holds', () => {
      expect(addresses(withPorts([]))).toEqual(
        addresses(googleStackVmDefinition(input()).definition),
      );
    });

    it('lists what a Domain run applies on the stack', () => {
      expect(GOOGLE_STACK_VM_DOMAIN_ADDRESSES).toEqual([
        'google_compute_instance_group.stack_vm',
        'google_compute_health_check.stack_vm',
        'google_compute_backend_service.stack_vm',
        'google_compute_firewall.load_balancer',
      ]);
    });
  });

  it('lays its native.gcp over what Cloudgate writes', () => {
    expect(
      instance({
        native: { [INSTANCE]: { machine_type: 'n2-standard-2' } },
      }).machine_type,
    ).toBe('n2-standard-2');
  });
});
