import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGooglePlan } from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * The stored Google plans of a Private web service, planned offline from the real
 * generated definitions (or derived from a recorded one) and marked "not
 * yet from a real project" until the walk re-records them
 * (`google-plan-fixtures.spec.ts`): the sample Private web service
 * `svc_private_1` made, and the Environment network made with, or given,
 * its private `run.app` zone.
 */
function plan(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures', 'plans', 'google', `${name}.json`),
      'utf8',
    ),
  ) as TofuShowJson;
}

const ZONE_LINE =
  "Private DNS zone `run.app`: create, for this Environment's Private web services, about $0.20/month";

describe('readGooglePlan, a Private web service on Cloud Run', () => {
  it('lists the repository, service account and an internal-only Cloud Run service, and no load-balancer piece', () => {
    const reading = readGooglePlan({
      show: plan('web-private-create'),
      nameSearch: [],
      context: { serviceName: 'inside' },
    });

    expect(reading.summary).toEqual([
      'Artifact Registry repository `cloudgate-tfeyly54xiuh`: create',
      'Cloud Run service `inside`: create, 1 CPU / 512 MB, CPU only during requests, 0–10 copies, reached only from this Environment',
      'Service account `cloudgate-tfeyly54xiuh`: create',
    ]);
    expect(JSON.stringify(reading)).not.toMatch(
      /backend_service|network_endpoint_group|Domain/,
    );
  });
});

describe("readGooglePlan, the Environment network's run.app zone", () => {
  it("shows the zone with its price on a new network's step, its records folded into it, and no NAT or router", () => {
    const reading = readGooglePlan({
      show: plan('network-create-run-app-zone'),
      nameSearch: [],
      context: {},
    });

    expect(reading.summary).toContain(ZONE_LINE);
    expect(reading.summary).toContain(
      'Environment network: create, $0/month for the network, about $18/month while idle for the load balancer',
    );
    expect(reading.summary.join('\n')).not.toMatch(
      /DNS record|router|NAT|Private link/,
    );
    expect(
      reading.raw
        .filter((line) => line.resourceType.startsWith('google_dns_'))
        .map((line) => `${line.action} ${line.address}`),
    ).toEqual([
      'create google_dns_managed_zone.run_app',
      'create google_dns_record_set.run_app',
      'create google_dns_record_set.run_app_wildcard',
    ]);
  });

  it('shows only the zone when a made network gains it', () => {
    const reading = readGooglePlan({
      show: plan('run-app-zone-add'),
      nameSearch: [],
      context: {},
    });

    expect(reading.summary).toEqual([ZONE_LINE]);
    expect(reading.counts).toMatchObject({ create: 3, destroy: 0, change: 0 });
  });
});
