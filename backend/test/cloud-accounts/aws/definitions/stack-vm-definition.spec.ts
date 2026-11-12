import {
  CANONICAL_ACCOUNT,
  STACK_VM_DOMAIN_ADDRESSES,
  STACK_VM_OUTPUTS,
  stackVmDefinition,
} from '../../../../src/cloud-accounts/aws/definitions/stack-vm-definition';
import type { StackVmDefinitionInput } from '../../../../src/cloud-accounts/aws/definitions/stack-vm-definition';
import {
  COMPOSE_PLUGIN_VERSION,
  DOCKER_ENGINE_VERSION,
  stackVmPinsOn,
} from '../../../../src/cloud-accounts/definitions/stack-vm-pins';
import { TAG_KEYS } from '../../../../src/cloud-accounts/aws/definitions/tags';
import {
  addresses,
  effectiveTags,
  resource,
  taggableResources,
} from './definition-helpers';

/**
 * A Compose stack's Stack VM on AWS (ADR-0070, #1359): what OpenTofu is
 * asked to make, from the stack's settings.
 */

const UNTAGGABLE = new Set([
  'aws_iam_role_policy_attachment',
  'aws_volume_attachment',
]);

function input(
  overrides: Partial<StackVmDefinitionInput> = {},
): StackVmDefinitionInput {
  return {
    configName: 'analytics',
    serviceId: 'Cmp_Id-1',
    account: {
      cloudAccountId: 'cloud-acct-1',
      awsAccountId: '123456789012',
      deployRoleArn:
        'arn:aws:iam::123456789012:role/cloudgate/cloudgate-deploy',
      externalId: 'ext-abc',
    },
    region: 'eu-west-1',
    environmentId: 'env-prod',
    stateId: 'state-analytics',
    network: {
      vpcId: 'vpc-0a1b',
      privateSubnetIds: ['subnet-0ccc', 'subnet-0ddd'],
    },
    machineType: 't3.small',
    dataDiskGb: 20,
    snapshotDays: 7,
    imageId: null,
    sshPublicKey: null,
    zone: null,
    pins: stackVmPinsOn('aws'),
    ...overrides,
  };
}

const INSTANCE = 'aws_instance.stack_vm';

function userData(definition: Record<string, unknown>): string {
  return resource(definition, INSTANCE).user_data as string;
}

describe('stackVmDefinition', () => {
  it('makes the Stack VM, its identity, its security group, its data disk and its snapshot policy', () => {
    expect(addresses(stackVmDefinition(input()).definition)).toEqual([
      'aws_dlm_lifecycle_policy.snapshots',
      'aws_ebs_volume.data',
      'aws_iam_instance_profile.stack_vm',
      'aws_iam_role.snapshots',
      'aws_iam_role.stack_vm',
      'aws_iam_role_policy_attachment.session_manager',
      'aws_iam_role_policy_attachment.snapshots',
      'aws_instance.stack_vm',
      'aws_security_group.stack_vm',
      'aws_volume_attachment.data',
    ]);
  });

  it('puts it in a private subnet of the Environment network, with no public IP and auto-recovery', () => {
    const { definition } = stackVmDefinition(input());
    expect(resource(definition, INSTANCE)).toMatchObject({
      instance_type: 't3.small',
      subnet_id: 'subnet-0ccc',
      associate_public_ip_address: false,
      vpc_security_group_ids: ['${aws_security_group.stack_vm.id}'],
      iam_instance_profile: '${aws_iam_instance_profile.stack_vm.name}',
      maintenance_options: { auto_recovery: 'default' },
      metadata_options: { http_tokens: 'required' },
    });
  });

  it("boots the pinned Ubuntu 24.04 build, Canonical's AMI of that name in the region, when none is recorded", () => {
    const { definition } = stackVmDefinition(
      input({
        pins: {
          image:
            'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20261017',
          dockerEngine: DOCKER_ENGINE_VERSION,
          composePlugin: COMPOSE_PLUGIN_VERSION,
        },
      }),
    );
    expect(CANONICAL_ACCOUNT).toBe('099720109477');
    expect(
      (definition.data as Record<string, Record<string, unknown>>).aws_ami
        .ubuntu,
    ).toEqual({
      owners: ['099720109477'],
      most_recent: true,
      filter: [
        {
          name: 'name',
          values: [
            'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20261017',
          ],
        },
      ],
    });
    expect(resource(definition, INSTANCE).ami).toBe(
      '${data.aws_ami.ubuntu.id}',
    );
  });

  it('keeps the image recorded in the stack’s settings, looking up none', () => {
    const { definition } = stackVmDefinition(
      input({ imageId: 'ami-0123456789abcdef0' }),
    );
    expect(definition.data).toBeUndefined();
    expect(resource(definition, INSTANCE).ami).toBe('ami-0123456789abcdef0');
  });

  it('outputs the image and the pins it was made with, which the Apply records', () => {
    const { definition } = stackVmDefinition(input());
    expect(definition.output).toEqual({
      [STACK_VM_OUTPUTS.instanceId]: { value: '${aws_instance.stack_vm.id}' },
      [STACK_VM_OUTPUTS.privateIp]: {
        value: '${aws_instance.stack_vm.private_ip}',
      },
      [STACK_VM_OUTPUTS.imageId]: { value: '${aws_instance.stack_vm.ami}' },
      [STACK_VM_OUTPUTS.dataVolumeId]: { value: '${aws_ebs_volume.data.id}' },
      [STACK_VM_OUTPUTS.zone]: {
        value: '${aws_instance.stack_vm.availability_zone}',
      },
    });
    expect(stackVmDefinition(input()).pins).toEqual(stackVmPinsOn('aws'));
  });

  describe('once made (#1368)', () => {
    const made = () =>
      stackVmDefinition(
        input({
          imageId: 'ami-0123456789abcdef0',
          zone: 'eu-west-1a',
          pins: {
            image: 'old-image',
            dockerEngine: '5:28.0.0-1~ubuntu.24.04~noble',
            composePlugin: '2.30.0-1~ubuntu.24.04~noble',
          },
        }),
      ).definition;

    it('installs the pins it was made with, not the ones Cloudgate pins now', () => {
      const text = userData(made());
      expect(text).toContain('docker-ce=5:28.0.0-1~ubuntu.24.04~noble');
      expect(text).toContain(
        'docker-compose-plugin=2.30.0-1~ubuntu.24.04~noble',
      );
    });

    it('puts its data disk in its recorded zone, so a replaced Stack VM keeps the disk', () => {
      expect(resource(made(), 'aws_ebs_volume.data').availability_zone).toBe(
        'eu-west-1a',
      );
      expect(resource(made(), INSTANCE).availability_zone).toBe('eu-west-1a');
    });

    it('never changes its first boot in place, which it never reads again; only an approved replace makes it anew', () => {
      expect(resource(made(), INSTANCE).lifecycle).toEqual({
        ignore_changes: ['user_data'],
      });
    });

    it('stops the Stack VM before its data disk is detached, so the disk is let go cleanly', () => {
      expect(
        resource(made(), 'aws_volume_attachment.data')
          .stop_instance_before_detaching,
      ).toBe(true);
    });
  });

  it('gives it a role with the Session Manager policy, and nothing else', () => {
    const { definition } = stackVmDefinition(input());
    expect(
      JSON.parse(
        resource(definition, 'aws_iam_role.stack_vm')
          .assume_role_policy as string,
      ),
    ).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'ec2.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
      ],
    });
    expect(
      resource(definition, 'aws_iam_role_policy_attachment.session_manager'),
    ).toEqual({
      role: '${aws_iam_role.stack_vm.name}',
      policy_arn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
    });
    expect(
      resource(definition, 'aws_iam_instance_profile.stack_vm'),
    ).toMatchObject({ role: '${aws_iam_role.stack_vm.name}' });
  });

  it('opens nothing in its security group yet', () => {
    const { definition } = stackVmDefinition(input());
    expect(resource(definition, 'aws_security_group.stack_vm')).toMatchObject({
      vpc_id: 'vpc-0a1b',
      ingress: [],
    });
  });

  it('makes a 20 GB encrypted data disk in its zone, attached to it', () => {
    const { definition } = stackVmDefinition(input());
    expect(resource(definition, 'aws_ebs_volume.data')).toMatchObject({
      availability_zone: '${aws_instance.stack_vm.availability_zone}',
      size: 20,
      type: 'gp3',
      encrypted: true,
    });
    expect(resource(definition, 'aws_volume_attachment.data')).toMatchObject({
      volume_id: '${aws_ebs_volume.data.id}',
      instance_id: '${aws_instance.stack_vm.id}',
    });
  });

  it('snapshots the data disk daily, keeping 7, with Data Lifecycle Manager', () => {
    const { definition } = stackVmDefinition(input());
    const disk = resource(definition, 'aws_ebs_volume.data');
    const policy = resource(definition, 'aws_dlm_lifecycle_policy.snapshots');
    expect(policy).toMatchObject({
      execution_role_arn: '${aws_iam_role.snapshots.arn}',
      state: 'ENABLED',
      policy_details: {
        resource_types: ['VOLUME'],
        target_tags: { 'cloudgate:stack-vm-data': 'state-analytics' },
        schedule: [
          {
            create_rule: { interval: 24, interval_unit: 'HOURS' },
            retain_rule: { count: 7 },
            copy_tags: false,
          },
        ],
      },
    });
    expect(disk.tags).toMatchObject({
      'cloudgate:stack-vm-data': 'state-analytics',
    });
  });

  it("carries Cloudgate's mark on every resource that takes tags", () => {
    const { definition } = stackVmDefinition(input());
    const taggable = taggableResources(definition).filter(
      (one) => !UNTAGGABLE.has(one.type),
    );
    expect(taggable.length).toBeGreaterThan(0);
    for (const one of taggable) {
      expect(effectiveTags(definition, one.body)).toMatchObject({
        [TAG_KEYS.cloudAccount]: 'cloud-acct-1',
        [TAG_KEYS.environment]: 'env-prod',
        [TAG_KEYS.state]: 'state-analytics',
        [TAG_KEYS.address]: one.address,
      });
    }
  });

  it('names the role and instance profile by the stack’s id, so a lost state finds them again', () => {
    const { definition } = stackVmDefinition(input());
    expect(resource(definition, 'aws_iam_role.stack_vm').name).toBe(
      'cloudgate-stack-vm-cmpxidx1',
    );
    expect(resource(definition, 'aws_iam_instance_profile.stack_vm').name).toBe(
      'cloudgate-stack-vm-cmpxidx1',
    );
  });

  it("puts its roles and profile under /cloudgate/stack-vm/, where the deploy role's Stack VM grants reach and its task role grants do not", () => {
    const { definition } = stackVmDefinition(input());
    for (const address of [
      'aws_iam_role.stack_vm',
      'aws_iam_role.snapshots',
      'aws_iam_instance_profile.stack_vm',
    ]) {
      expect([address, resource(definition, address).path]).toEqual([
        address,
        '/cloudgate/stack-vm/',
      ]);
    }
  });

  describe('its first boot', () => {
    it('is cloud-config that installs the pinned Docker Engine and compose plugin, and holds them', () => {
      const text = userData(stackVmDefinition(input()).definition);
      expect(text.startsWith('#cloud-config\n')).toBe(true);
      expect(text).toContain(
        `docker-ce=${DOCKER_ENGINE_VERSION} docker-ce-cli=${DOCKER_ENGINE_VERSION}`,
      );
      expect(text).toContain(`docker-compose-plugin=${COMPOSE_PLUGIN_VERSION}`);
      expect(text).toContain(
        'apt-mark hold docker-ce docker-ce-cli docker-compose-plugin',
      );
    });

    it("mounts the data disk as Docker's volume folder before Docker starts", () => {
      const text = userData(stackVmDefinition(input()).definition);
      const mount = text.indexOf('/usr/local/sbin/cloudgate-data-disk\n');
      const install = text.indexOf('apt-get install -y docker-ce=');
      expect(mount).toBeGreaterThan(-1);
      expect(mount).toBeLessThan(install);
      expect(text).toContain('/var/lib/docker/volumes');
    });

    it("authorizes the stack's own SSH key, which Cloudgate reaches it with through the tunnel", () => {
      const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStackVmKey';
      const text = userData(
        stackVmDefinition(input({ sshPublicKey: key })).definition,
      );
      expect(text).toContain('disable_root: false\n');
      expect(text).toContain(
        `  - name: root\n    ssh_authorized_keys:\n      - ${key}\n`,
      );
    });

    it('authorizes no key while its stack has none yet (a plan read before the Apply)', () => {
      const text = userData(stackVmDefinition(input()).definition);
      expect(text).not.toContain('ssh_authorized_keys');
    });

    it("makes the shared network a stack's compose file is joined to, once Docker runs", () => {
      const text = userData(stackVmDefinition(input()).definition);
      const docker = text.indexOf('systemctl enable --now docker');
      const network = text.indexOf('docker network create cloudgate-network');
      expect(docker).toBeGreaterThan(-1);
      expect(network).toBeGreaterThan(docker);
    });

    it('turns on unattended security updates, with automatic reboot off', () => {
      const text = userData(stackVmDefinition(input()).definition);
      expect(text).toContain('APT::Periodic::Unattended-Upgrade "1";');
      expect(text).toContain('Unattended-Upgrade::Automatic-Reboot "false";');
    });
  });

  describe('its Domains (#1371)', () => {
    const loadBalancer = {
      httpsListenerArn:
        'arn:aws:elasticloadbalancing:eu-west-1:123456789012:listener/app/cg/1/2',
      albSecurityGroupId: 'sg-0alb',
    };
    const domains = [
      {
        domainId: 'dom_a',
        host: 'app.example.com',
        path: '/',
        attempt: 1,
        attach: true,
        port: 3000,
      },
      {
        domainId: 'dom_b',
        host: 'admin.example.com',
        path: '/panel',
        attempt: 2,
        attach: false,
        port: 8080,
      },
      {
        domainId: 'dom_c',
        host: 'www.example.com',
        path: '/',
        attempt: 1,
        attach: false,
        port: 3000,
      },
    ];
    const withDomains = () =>
      stackVmDefinition(input({ domains, loadBalancer })).definition;

    it('makes no load balancer piece while the stack has no Domain', () => {
      const made = addresses(stackVmDefinition(input()).definition);
      expect(made.filter((one) => one.startsWith('aws_lb'))).toEqual([]);
      expect(made).not.toContain('aws_acm_certificate.domain');
    });

    it('makes one target group per published port, the Stack VM its one target on that port', () => {
      const definition = withDomains();
      expect(
        resource(definition, 'aws_lb_target_group.stack_vm'),
      ).toMatchObject({
        for_each: { '3000': 3000, '8080': 8080 },
        target_type: 'instance',
        protocol: 'HTTP',
        port: '${each.value}',
        vpc_id: 'vpc-0a1b',
      });
      expect(
        resource(definition, 'aws_lb_target_group_attachment.stack_vm'),
      ).toMatchObject({
        for_each: { '3000': 3000, '8080': 8080 },
        target_group_arn: '${aws_lb_target_group.stack_vm[each.key].arn}',
        target_id: '${aws_instance.stack_vm.id}',
        port: '${each.value}',
      });
    });

    it('opens its security group to the load balancer alone, on each target port only', () => {
      const ingress = resource(definition(), 'aws_security_group.stack_vm')
        .ingress as Record<string, unknown>[];
      expect(
        ingress.map((one) => [
          one.from_port,
          one.to_port,
          one.security_groups,
          one.cidr_blocks,
        ]),
      ).toEqual([
        [3000, 3000, ['sg-0alb'], []],
        [8080, 8080, ['sg-0alb'], []],
      ]);
      function definition() {
        return withDomains();
      }
    });

    it('describes its security group by what it is for, the same with Domains as without, since a new description replaces the group', () => {
      const description = (made: Record<string, unknown>) =>
        resource(made, 'aws_security_group.stack_vm').description;
      const without = description(stackVmDefinition(input()).definition);

      expect(description(withDomains())).toBe(without);
      expect(without).toBe(
        'Cloudgate: the Stack VM of a Compose stack, reached through Session Manager',
      );
    });

    it("gives each Domain its certificate and a host rule on the network's HTTPS listener, forwarding to its port's target group", () => {
      const definition = withDomains();
      const rule = resource(definition, 'aws_lb_listener_rule.domain');
      expect(rule).toMatchObject({
        listener_arn: loadBalancer.httpsListenerArn,
        action: {
          type: 'forward',
          target_group_arn: '${each.value.target_group}',
        },
      });
      const rules = rule.for_each as Record<string, Record<string, unknown>>;
      expect(rules.dom_a).toMatchObject({
        host: 'app.example.com',
        paths: ['/*'],
        target_group: '${aws_lb_target_group.stack_vm["3000"].arn}',
      });
      expect(rules.dom_b).toMatchObject({
        paths: ['/panel', '/panel/*'],
        target_group: '${aws_lb_target_group.stack_vm["8080"].arn}',
      });
      expect(
        Object.keys(
          resource(definition, 'aws_acm_certificate.domain').for_each as object,
        ),
      ).toEqual(['dom_a-1', 'dom_b-2', 'dom_c-1']);
      expect(
        Object.keys(
          resource(definition, 'aws_lb_listener_certificate.domain')
            .for_each as object,
        ),
      ).toEqual(['dom_a-1']);
      expect(definition.output).toHaveProperty('domain_certificates');
    });

    it('writes the blocks with nothing in them once the last Domain is removed, so its run destroys them', () => {
      const { definition } = stackVmDefinition(
        input({ domains: [], loadBalancer }),
      );
      expect(
        resource(definition, 'aws_lb_listener_rule.domain').for_each,
      ).toEqual({});
      expect(
        resource(definition, 'aws_lb_target_group.stack_vm').for_each,
      ).toEqual({});
      expect(
        resource(definition, 'aws_security_group.stack_vm').ingress,
      ).toEqual([]);
    });

    it("refuses Domains without the network's load balancer", () => {
      expect(() => stackVmDefinition(input({ domains }))).toThrow(
        /load balancer/,
      );
    });

    it('lists what a Domain run applies: the Domain blocks, the target groups, their targets and the security group', () => {
      expect(STACK_VM_DOMAIN_ADDRESSES).toEqual([
        'aws_acm_certificate.domain',
        'aws_lb_listener_rule.domain',
        'aws_lb_listener_certificate.domain',
        'aws_lb_target_group.stack_vm',
        'aws_lb_target_group_attachment.stack_vm',
        'aws_security_group.stack_vm',
      ]);
    });
  });

  it('lays its native.aws over what Cloudgate writes', () => {
    const { definition } = stackVmDefinition(
      input({
        native: { 'aws_instance.stack_vm': { instance_type: 'm7i.large' } },
      }),
    );
    expect(resource(definition, INSTANCE).instance_type).toBe('m7i.large');
  });
});
