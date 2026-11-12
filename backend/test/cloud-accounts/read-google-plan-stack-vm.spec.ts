import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGooglePlan } from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type { FoundByName } from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import { dataDiskRefusal } from '../../src/cloud-accounts/definitions/stack-vm-written';

/**
 * The stored Google plans of a Compose stack's Stack VM (ADR-0070, #1362),
 * planned offline from the real generated definitions and marked "not yet
 * from a real project" until a walk re-records them: the stack `analytics`
 * (`svc_compose_1`) made at medium, on `e2-small`, and the sample
 * Environment `env_1`'s network made with the Cloud NAT its Stack VMs go
 * out through.
 */
function plan(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures', 'plans', 'google', `${name}.json`),
      'utf8',
    ),
  ) as TofuShowJson;
}

const NAME = 'cloudgate-cmyrpsiafuea';
const DESCRIPTION =
  'Cloudgate cloud-account=cloud_1 environment=env_1 state=state_compose_1';

function read(show: TofuShowJson, nameSearch: FoundByName[] = []) {
  return readGooglePlan({
    show,
    nameSearch,
    context: { serviceName: 'analytics' },
  });
}

/** The stored create with its instance's change rewritten, as a later plan would show it. */
function instanceChange(
  actions: string[],
  before: Record<string, unknown>,
  after: Record<string, unknown> | null,
): TofuShowJson {
  const show = plan('stack-vm-create');
  return {
    ...show,
    resource_changes: (show.resource_changes ?? [])
      .filter((change) => change.type === 'google_compute_instance')
      .map((change) => ({
        ...change,
        change: {
          ...change.change,
          actions,
          before: { ...(change.change.after as object), ...before },
          after:
            after === null
              ? null
              : { ...(change.change.after as object), ...after },
          after_unknown: {},
        },
      })),
  } as TofuShowJson;
}

describe('readGooglePlan, a Stack VM', () => {
  it('names the Stack VM with its machine type, CPU and memory, its data disk, its way in and its daily snapshots', () => {
    expect(read(plan('stack-vm-create')).summary).toEqual([
      'analytics Stack VM data disk: create, 20 GB pd-balanced, in europe-west1-b',
      `analytics Stack VM firewall rule \`${NAME}-iap\`: create, lets IAP's tunnel (35.235.240.0/20) in on TCP 22 only`,
      "analytics Stack VM: create, e2-small (2 vCPU, 2 GB), in europe-west1-b, no external IP, reached through IAP's tunnel",
      'analytics Stack VM snapshots: create, daily, each kept 7 days',
      `Service account \`${NAME}\`: create`,
    ]);
  });

  it('counts every resource it makes, the snapshot attachment among them', () => {
    const reading = read(plan('stack-vm-create'));
    expect(reading.counts).toMatchObject({ create: 6, change: 0, destroy: 0 });
    expect(reading.raw.map((line) => line.address)).toContain(
      'google_compute_disk_resource_policy_attachment.snapshots',
    );
  });

  it('says a new machine type restarts the Stack VM, old and new with their CPU and memory', () => {
    const reading = read(
      instanceChange(
        ['update'],
        { machine_type: 'e2-small' },
        { machine_type: 'e2-medium' },
      ),
    );
    const line =
      'analytics Stack VM: e2-small (2 vCPU, 2 GB) → e2-medium (2 vCPU, 4 GB), restarts the Stack VM';
    expect(reading.summary).toEqual([line]);
    expect(reading.outages).toEqual([
      { kind: 'restart', serviceName: 'analytics', line },
    ]);
  });

  it('says a "replace VM" makes it anew beside its data disk, as an outage (#1368)', () => {
    const reading = read(
      instanceChange(['delete', 'create'], { name: NAME }, { name: NAME }),
    );
    const line =
      "analytics Stack VM: replace, brief downtime, its data disk kept, e2-small (2 vCPU, 2 GB), in europe-west1-b, no external IP, reached through IAP's tunnel";
    expect(reading.summary).toEqual([line]);
    expect(reading.outages).toEqual([
      { kind: 'restart', serviceName: 'analytics', line },
    ]);
  });

  it('says a larger data disk grows in place, and refuses one that would shrink (#1368)', () => {
    const show = plan('stack-vm-create');
    const diskChange = (from: number, to: number): TofuShowJson => ({
      ...show,
      resource_changes: (show.resource_changes ?? [])
        .filter((change) => change.type === 'google_compute_disk')
        .map((change) => ({
          ...change,
          change: {
            ...change.change,
            actions: ['update'],
            before: { ...(change.change.after as object), size: from },
            after: { ...(change.change.after as object), size: to },
            after_unknown: {},
          },
        })),
    });

    expect(read(diskChange(20, 40)).summary).toEqual([
      'analytics Stack VM data disk: 20 GB → 40 GB, grown in place with no restart',
    ]);
    expect(
      dataDiskRefusal('analytics', diskChange(20, 40), 'google_compute_disk'),
    ).toBeNull();
    expect(
      dataDiskRefusal('analytics', diskChange(60, 40), 'google_compute_disk'),
    ).toBe(
      "analytics's Stack VM data disk is 60 GB in its cloud, larger than the 40 GB Cloudgate records, and a data disk never shrinks. Grow it to 60 GB on the stack's page, then Check for changes",
    );
  });

  it('refuses a change that would delete its data disk: only its Delete removes it (#1368)', () => {
    const show = plan('stack-vm-create');
    const replaced = {
      ...show,
      resource_changes: (show.resource_changes ?? [])
        .filter((change) => change.type === 'google_compute_disk')
        .map((change) => ({
          ...change,
          change: { ...change.change, actions: ['delete', 'create'] },
        })),
    } as TofuShowJson;
    expect(
      dataDiskRefusal('analytics', replaced, 'google_compute_disk'),
    ).toMatch(
      /^analytics's Stack VM data disk would be deleted by this change/,
    );
  });

  it('names a machine type it does not know alone', () => {
    expect(
      read(
        instanceChange(
          ['update'],
          { machine_type: 'e2-small' },
          { machine_type: 'c3-standard-4' },
        ),
      ).summary,
    ).toEqual([
      'analytics Stack VM: e2-small (2 vCPU, 2 GB) → c3-standard-4, restarts the Stack VM',
    ]);
  });

  it('takes back a Stack VM found by its name and mark, and leaves one with another mark', () => {
    const found = (
      resourceType: string,
      name: string,
      description: string,
    ) => ({
      resourceType,
      name,
      id: `projects/example-project-123/zones/europe-west1-b/instances/${name}`,
      description,
    });
    const ours = read(plan('stack-vm-create'), [
      found('google_compute_instance', NAME, DESCRIPTION),
    ]);
    expect(ours.adopt).toEqual([
      expect.objectContaining({
        address: 'google_compute_instance.stack_vm',
        line: "analytics Stack VM: found in Google Cloud, taken back into Cloudgate's record",
      }),
    ]);

    const theirs = read(plan('stack-vm-create'), [
      found('google_compute_instance', NAME, 'made by hand'),
    ]);
    expect(theirs.adopt).toEqual([]);
    expect(theirs.noState).toEqual([
      expect.objectContaining({
        address: 'google_compute_instance.stack_vm',
      }),
    ]);
  });

  it('takes back the snapshot attachment with both the data disk and the schedule it joins', () => {
    const reading = read(plan('stack-vm-create'), [
      {
        resourceType: 'google_compute_disk',
        name: `${NAME}-data`,
        id: `projects/example-project-123/zones/europe-west1-b/disks/${NAME}-data`,
        description: DESCRIPTION,
      },
      {
        resourceType: 'google_compute_resource_policy',
        name: `${NAME}-snapshots`,
        id: `projects/example-project-123/regions/europe-west1/resourcePolicies/${NAME}-snapshots`,
        description: DESCRIPTION,
      },
    ]);
    expect(reading.adopt.map((line) => [line.address, line.arn])).toEqual([
      [
        'google_compute_disk.data',
        `projects/example-project-123/zones/europe-west1-b/disks/${NAME}-data`,
      ],
      [
        'google_compute_resource_policy.snapshots',
        `projects/example-project-123/regions/europe-west1/resourcePolicies/${NAME}-snapshots`,
      ],
      [
        'google_compute_disk_resource_policy_attachment.snapshots',
        `example-project-123/europe-west1-b/${NAME}-data/${NAME}-snapshots`,
      ],
    ]);
  });
});

describe("readGooglePlan, the Environment network's Cloud NAT", () => {
  it('prices Cloud NAT on its own line after a new network’s line, its router folded into it', () => {
    const reading = readGooglePlan({
      show: plan('network-create-cloud-nat'),
      nameSearch: [],
      context: {},
    });
    expect(reading.summary).toEqual([
      'Environment network: create, $0/month for the network, about $18/month while idle for the load balancer',
      "Cloud NAT: create, the Stack VMs' way out to the internet, about $4.67/month for one Stack VM, plus $0.045 per GB it carries",
    ]);
  });
});

describe("readGooglePlan, a Stack VM's Domains (#1371)", () => {
  it("names its load balancer backend, each port's backend service and the firewall rule from the load balancer", () => {
    const summary = read(plan('stack-vm-domains')).summary;
    expect(summary).toEqual(
      expect.arrayContaining([
        "analytics Stack VM on port 3000: create, a backend of the Environment network's load balancer",
        "analytics Stack VM on port 8080: create, a backend of the Environment network's load balancer",
        'analytics Stack VM load balancer group: create, ports 3000, 8080',
        `analytics Stack VM firewall rule \`${NAME}-lb\`: create, lets the load balancer (35.191.0.0/16, 130.211.0.0/22) in on TCP 3000, 8080 only`,
      ]),
    );
    // Each port's health check is its backend's, and says nothing of its own.
    expect(summary.filter((line) => line.includes('health check'))).toEqual([]);
  });

  it('labels each piece by its stack, never by its raw address', () => {
    const reading = read(plan('stack-vm-domains'));
    expect(reading.summary.some((line) => line.startsWith('`'))).toBe(false);
    expect(reading.counts).toMatchObject({ create: 12 });
  });

  it('says a port removed takes it off the load balancer', () => {
    const show = plan('stack-vm-domains');
    const removed = {
      ...show,
      resource_changes: (show.resource_changes ?? [])
        .filter(
          (change) =>
            change.address ===
            'google_compute_backend_service.stack_vm["8080"]',
        )
        .map((change) => ({
          ...change,
          change: {
            ...change.change,
            actions: ['delete'],
            before: change.change.after,
            after: null,
            after_unknown: {},
          },
        })),
    } as TofuShowJson;
    expect(read(removed).summary).toEqual([
      "analytics Stack VM on port 8080: destroy, off the Environment network's load balancer",
    ]);
  });
});
