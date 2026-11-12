import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGooglePlan } from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type {
  FoundByName,
  GooglePlanReadContext,
} from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * The stored Google plans of a redis on Memorystore, planned offline from the
 * real generated definitions and marked "not yet from a real project" until the
 * walk re-records them (`google-plan-fixtures.spec.ts`): the sample Environment
 * `env_1`'s network made with Memorystore's private link (alone, or beside
 * Cloud SQL's), the link added to a made network with and without Cloud SQL's,
 * and the redis `redis_1` made, moved from `CUSTOM_PICO` to `CUSTOM_MICRO`,
 * upgraded from Valkey 8.0 to 9.1, and destroyed; and its replica added and
 * removed as high availability is turned on and off.
 */
function plan(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures', 'plans', 'google', `${name}.json`),
      'utf8',
    ),
  ) as TofuShowJson;
}

const REDIS: GooglePlanReadContext = { serviceName: 'redis' };

const NETWORK_LINE =
  'Environment network: create, $0/month for the network, about $18/month while idle for the load balancer';
const FIREWALL_LINE =
  'Private link firewall rule `cloudgate-w33lemwkholw-psc-redis-ports` (TCP 6379, 11000–13047): create, $0/month';
const SUBNET_LINE =
  'Private link subnet `cloudgate-w33lemwkholw-psc` (10.64.16.0/24): create, $0/month';
const POLICY_LINE =
  'Private link for Memorystore (service connection policy `cloudgate-w33lemwkholw-psc-redis`): create, $0/month';
const LINK_LINE =
  "Private link: lets this Environment's databases get a private address; made once, kept until the Environment is deleted";

function read(
  name: string,
  context: GooglePlanReadContext = {},
  nameSearch: FoundByName[] = [],
) {
  return readGooglePlan({ show: plan(name), nameSearch, context });
}

describe('readGooglePlan', () => {
  describe("Memorystore's private link", () => {
    it('lists the subnet, the Memorystore policy and the firewall rule for Redis’s ports after a new network’s line, at $0/month', () => {
      expect(read('network-create-memorystore-link').summary).toEqual([
        NETWORK_LINE,
        FIREWALL_LINE,
        SUBNET_LINE,
        POLICY_LINE,
        LINK_LINE,
      ]);
    });

    it('shares the one subnet with Cloud SQL’s link when one plan makes both', () => {
      expect(read('network-create-private-links').summary).toEqual([
        NETWORK_LINE,
        FIREWALL_LINE,
        SUBNET_LINE,
        expect.stringMatching(/^Private link for Cloud SQL /),
        POLICY_LINE,
        LINK_LINE,
      ]);
    });

    it('is all a made network’s plan creates when a redis first needs it, the subnet with it when no postgres made it', () => {
      const reading = read('memorystore-link-create');

      expect(reading.summary).toEqual([
        FIREWALL_LINE,
        SUBNET_LINE,
        POLICY_LINE,
        LINK_LINE,
      ]);
      expect(reading.counts).toEqual(
        expect.objectContaining({ create: 3, change: 0, destroy: 0 }),
      );
    });

    it('adds only its policy and the firewall rule to a network Cloud SQL’s link is on', () => {
      const reading = read('memorystore-link-add');

      expect(reading.summary).toEqual([FIREWALL_LINE, POLICY_LINE, LINK_LINE]);
      expect(reading.counts).toEqual(
        expect.objectContaining({ create: 2, change: 0, destroy: 0 }),
      );
    });
  });

  describe('a redis on Memorystore', () => {
    it('shows a new instance with its node type, version and node count, cluster mode off, no password and only this Environment’s private network reaching it, TLS with its own CA, noeviction and no deletion protection, and its own address under it', () => {
      const reading = read('memorystore-create', REDIS);

      expect(reading.summary).toEqual([
        "Memorystore instance `redis`: create, CUSTOM_PICO, VALKEY_8_0, 1 node, cluster mode off, no password: only this Environment's private network reaches it, over TLS with its own CA, maxmemory-policy noeviction, no deletion protection",
        '`redis` private addresses (primary and reader): create, made by Google with the instance on the private link subnet (10.64.16.0/24), about $14.60/month',
      ]);
      expect(reading.raw.map((line) => line.address)).toEqual([
        'google_memorystore_instance.cache',
      ]);
    });

    it('moves the node type in place', () => {
      const reading = read('memorystore-change', REDIS);

      expect(reading.summary).toEqual([
        'Memorystore instance `redis`: change, CUSTOM_PICO → CUSTOM_MICRO, in place',
      ]);
      expect(reading.counts).toEqual(
        expect.objectContaining({ change: 1, replace: 0, briefDowntime: 0 }),
      );
    });

    it('upgrades the Valkey version in place', () => {
      const reading = read('memorystore-upgrade', REDIS);

      expect(reading.summary).toEqual([
        'Memorystore instance `redis`: change, VALKEY_8_0 → VALKEY_9_1, in place',
      ]);
      expect(reading.counts).toEqual(
        expect.objectContaining({ change: 1, replace: 0 }),
      );
    });

    it.each([
      ['adds a replica', 'memorystore-replica-add', '1 node → 2 nodes'],
      ['removes the replica', 'memorystore-replica-remove', '2 nodes → 1 node'],
    ])(
      '%s in place when high availability is turned on or off',
      (_what, name, nodes) => {
        const reading = read(name, REDIS);

        expect(reading.summary).toEqual([
          `Memorystore instance \`redis\`: change, ${nodes}, in place`,
        ]);
        expect(reading.counts).toEqual(
          expect.objectContaining({ change: 1, replace: 0, briefDowntime: 0 }),
        );
      },
    );

    it('destroys the instance with its own address', () => {
      expect(read('memorystore-destroy', REDIS).summary).toEqual([
        'Memorystore instance `redis`: destroy, with its two private addresses',
      ]);
    });

    it('adopts an instance found by its name only when it carries the mark as its labels', () => {
      const show = plan('memorystore-create');
      const change = show.resource_changes![0];
      const labels = (change.change.after as { labels: Record<string, string> })
        .labels;
      const found = (withLabels: Record<string, string>): FoundByName => ({
        resourceType: 'google_memorystore_instance',
        name: 'cloudgate-rpwjluzdxftp',
        id: 'projects/example-project-123/locations/europe-west1/instances/cloudgate-rpwjluzdxftp',
        labels: withLabels,
      });

      expect(
        read('memorystore-create', REDIS, [found(labels)]).counts.adopt,
      ).toBe(1);
      expect(
        read('memorystore-create', REDIS, [found({ team: 'other' })]).counts
          .adopt,
      ).toBe(0);
    });
  });
});
