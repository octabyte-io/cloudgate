import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGooglePlan } from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * The stored plan of an Existing database's endpoint and private zone on
 * Google Cloud, recorded from a real plan by the re-walk on
 * deploy role version 5 (`google-plan-fixtures.spec.ts`).
 */
function plan(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures', 'plans', 'google', `${name}.json`),
      'utf8',
    ),
  ) as TofuShowJson;
}

describe('readGooglePlan', () => {
  describe("an Existing database's endpoint and private zone", () => {
    const reading = readGooglePlan({
      show: plan('existing-postgres-create'),
      nameSearch: [],
      context: { serviceName: 'pg-1' },
    });

    it('shows the endpoint at about $7.30/month and the zone at about $0.20/month, each folding in its address or record', () => {
      expect(reading.summary).toEqual([
        "Private Service Connect endpoint `cloudgate-i62ao5cammge-psc`: create, from the private link subnet (10.64.16.0/24) to the existing instance's service attachment, about $7.30/month",
        'Private DNS zone for `4c583468c161.1idghei1xv0vf.europe-west1.sql.goog.`: create, private to the Environment network, with an A record to the endpoint, about $0.20/month',
      ]);
    });

    it('still lists all four in the raw lines, each a create', () => {
      expect(reading.raw.map((line) => [line.address, line.action])).toEqual([
        ['google_compute_address.endpoint', 'create'],
        ['google_compute_forwarding_rule.endpoint', 'create'],
        ['google_dns_managed_zone.instance', 'create'],
        ['google_dns_record_set.instance', 'create'],
      ]);
    });
  });
});
