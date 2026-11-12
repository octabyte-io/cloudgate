import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGooglePlan } from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * The stored plan of an existing Valkey's two manual endpoints on Google
 * Cloud, recorded from a real plan by the re-walk on deploy
 * role version 5 (`google-plan-fixtures.spec.ts`).
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
  describe("an existing Valkey's two endpoints", () => {
    const reading = readGooglePlan({
      show: plan('existing-redis-create'),
      nameSearch: [],
      context: { serviceName: 'cache' },
    });

    it('shows each endpoint at about $7.30/month, folding in its address', () => {
      expect(reading.summary).toEqual([
        "Private Service Connect endpoint `cloudgate-f3gtu4y7gg2f-psc-0`: create, from the private link subnet (10.64.16.0/24) to the existing instance's service attachment, about $7.30/month",
        "Private Service Connect endpoint `cloudgate-f3gtu4y7gg2f-psc-1`: create, from the private link subnet (10.64.16.0/24) to the existing instance's service attachment, about $7.30/month",
      ]);
    });

    it('still lists all four in the raw lines, each a create', () => {
      expect(reading.raw.map((line) => [line.address, line.action])).toEqual([
        ['google_compute_address.primary', 'create'],
        ['google_compute_address.reader', 'create'],
        ['google_compute_forwarding_rule.primary', 'create'],
        ['google_compute_forwarding_rule.reader', 'create'],
      ]);
    });
  });
});
