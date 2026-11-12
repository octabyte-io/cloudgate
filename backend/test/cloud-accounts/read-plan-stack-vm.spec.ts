import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readPlan } from '../../src/cloud-accounts/aws/plan-reader/read-plan';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import { dataDiskRefusal } from '../../src/cloud-accounts/definitions/stack-vm-written';

/**
 * A stored `tofu show -json` of a Compose stack's Stack VM create
 * (`stack-vm-create.json`, ADR-0070, #1359), saved by the moto lane from the
 * real pinned OpenTofu and `hashicorp/aws`.
 */
function plan(name = 'stack-vm-create'): TofuShowJson {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'plans', `${name}.json`), 'utf8'),
  ) as TofuShowJson;
}

describe('readPlan, a Stack VM on AWS', () => {
  it('names the machine type with its CPU and memory, its data disk and its snapshots', () => {
    const reading = readPlan({
      show: plan(),
      tagSearch: [],
      context: { serviceName: 'analytics' },
    });

    expect(reading.summary).toEqual([
      'analytics Stack VM snapshots: create, daily, each kept 7 days',
      'analytics Stack VM data disk: create, 20 GB gp3, encrypted',
      'analytics Stack VM: create, t3.small (2 vCPU, 2 GB), no public address, reached through Session Manager',
    ]);
    expect(reading.counts.create).toBe(10);
    expect(reading.outages).toBeUndefined();
  });

  it('lists every resource it makes among the raw lines', () => {
    const reading = readPlan({
      show: plan(),
      tagSearch: [],
      context: { serviceName: 'analytics' },
    });

    expect(reading.raw.map((line) => line.address).sort()).toEqual([
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

  it('says a new machine type restarts the Stack VM, as an outage', () => {
    const reading = readPlan({
      // Its Stack VM made, then planned at t3.medium (`stack-vm-resize.json`).
      show: plan('stack-vm-resize'),
      tagSearch: [],
      context: { serviceName: 'analytics' },
    });

    const line =
      'analytics Stack VM: t3.small (2 vCPU, 2 GB) → t3.medium (2 vCPU, 4 GB), restarts the Stack VM';
    expect(reading.summary).toEqual([line]);
    expect(reading.outages).toEqual([
      { kind: 'restart', serviceName: 'analytics', line },
    ]);
  });

  it('says a larger data disk grows in place with no restart (#1368)', () => {
    const reading = readPlan({
      // Its data disk planned at 40 GB (`stack-vm-grow.json`).
      show: plan('stack-vm-grow'),
      tagSearch: [],
      context: { serviceName: 'analytics' },
    });

    expect(reading.summary).toEqual([
      'analytics Stack VM data disk: 20 GB → 40 GB, grown in place with no restart',
    ]);
    expect(reading.outages ?? []).toEqual([]);
  });

  it('says a "replace VM" makes it anew with its data disk kept, as an outage (#1368)', () => {
    const show = plan('stack-vm-replace');
    const reading = readPlan({
      // Planned with `-replace` at Cloudgate's new pins (`stack-vm-replace.json`).
      show,
      tagSearch: [],
      context: { serviceName: 'analytics' },
    });

    const line =
      'analytics Stack VM: replace, brief downtime, its data disk kept, t3.small (2 vCPU, 2 GB)';
    expect(reading.summary).toContain(line);
    expect(
      reading.summary.some((one) => one.includes('Stack VM data disk')),
    ).toBe(false);
    expect(reading.outages).toEqual([
      { kind: 'restart', serviceName: 'analytics', line },
    ]);
    expect(dataDiskRefusal('analytics', show, 'aws_ebs_volume')).toBeNull();
  });

  it('refuses a plan that would shrink a data disk grown by hand in AWS (#1368)', () => {
    // Grown to 60 GB by hand, planned at the 40 GB Cloudgate records
    // (`stack-vm-disk-grown-by-hand.json`).
    expect(
      dataDiskRefusal(
        'analytics',
        plan('stack-vm-disk-grown-by-hand'),
        'aws_ebs_volume',
      ),
    ).toBe(
      "analytics's Stack VM data disk is 60 GB in its cloud, larger than the 40 GB Cloudgate records, and a data disk never shrinks. Grow it to 60 GB on the stack's page, then Check for changes",
    );
  });

  it('takes back a Stack VM found by its mark rather than making a second', () => {
    const arn =
      'arn:aws:ec2:eu-central-1:123456789012:instance/i-0000000000000abcd';
    const reading = readPlan({
      show: plan(),
      tagSearch: [
        {
          arn,
          tags: {
            'cloudgate:address': 'aws_instance.stack_vm',
            'cloudgate:state': 'st_stack_1',
          },
        },
      ],
      context: { serviceName: 'analytics' },
    });

    expect(reading.adopt).toEqual([
      {
        address: 'aws_instance.stack_vm',
        resourceType: 'aws_instance',
        arn,
        line: "Stack VM `analytics`: found in AWS, taken back into Cloudgate's record",
      },
    ]);
    expect(reading.counts.create).toBe(9);
  });
});

/**
 * The Environment network's NAT gateway, the Stack VMs' way out, added with
 * the first one (the owner's amendment to ADR-0070): its create line prices
 * it in the network's region from the coded rate table.
 */
describe("readPlan, the Environment network's NAT gateway", () => {
  const natCreate = (): TofuShowJson => ({
    format_version: '1.2',
    resource_changes: [
      {
        address: 'aws_nat_gateway.nat',
        mode: 'managed',
        type: 'aws_nat_gateway',
        name: 'nat',
        change: {
          actions: ['create'],
          before: null,
          after: { connectivity_type: 'public' },
          after_unknown: { id: true },
        },
      },
    ],
  });

  it('prices it in its region on create', () => {
    const reading = readPlan({
      show: natCreate(),
      tagSearch: [],
      context: { region: 'eu-west-1' },
    });

    expect(reading.summary).toEqual([
      "NAT gateway: create, the Stack VMs' way out to the internet, about $38.69/month plus $0.048 per GB it carries",
    ]);
  });

  it('says where the rate table has no price', () => {
    const reading = readPlan({
      show: natCreate(),
      tagSearch: [],
      context: { region: 'af-south-1' },
    });

    expect(reading.summary).toEqual([
      "NAT gateway: create, the Stack VMs' way out to the internet, Cloudgate's rate table has no price for af-south-1; see AWS's VPC pricing",
    ]);
  });
});

describe("readPlan, a Stack VM's Domains (#1371)", () => {
  it("names a new Domain's certificate and rule, its port's target, and the port opened to the load balancer", () => {
    const reading = readPlan({
      // Its first Domain applied, then a second on port 8080 planned
      // (`stack-vm-domain-add.json`), by the moto lane.
      show: plan('stack-vm-domain-add'),
      tagSearch: [],
      context: { serviceName: 'analytics' },
    });

    expect(reading.summary).toEqual(
      expect.arrayContaining([
        'Domain `admin.example.com` certificate: request from ACM, issued once its DNS record is found',
        'Domain `admin.example.com`: create, a rule on the load balancer',
        "analytics Stack VM on port 8080: create, a target of the Environment network's load balancer",
        'analytics Stack VM security group: lets the load balancer in on TCP 3000, 8080 only',
      ]),
    );
    expect(reading.summary.some((line) => line.startsWith('`'))).toBe(false);
  });

  it('names the last Domain removed, its port taken off the load balancer and closed', () => {
    const reading = readPlan({
      show: plan('stack-vm-domain-remove'),
      tagSearch: [],
      context: { serviceName: 'analytics' },
    });

    expect(reading.summary).toEqual(
      expect.arrayContaining([
        'Domain `app.example.com`: destroy, its rule off the load balancer',
        "analytics Stack VM on port 3000: destroy, off the Environment network's load balancer",
        'analytics Stack VM security group: closes every port, no Domain left',
      ]),
    );
  });
});
