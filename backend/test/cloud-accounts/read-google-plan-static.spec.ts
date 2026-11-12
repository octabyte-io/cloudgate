import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGooglePlan } from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * The stored Google plan of a static site, recorded from a real plan by the
 * walk by hand and rewritten to the sample ids
 * (`google-plan-fixtures.spec.ts`): the sample static site
 * `svc_static_1` made, its private bucket, its Cloud CDN backend bucket and
 * the load balancer's grant on the bucket.
 */
function plan(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures', 'plans', 'google', `${name}.json`),
      'utf8',
    ),
  ) as TofuShowJson;
}

describe('readGooglePlan, a static site on Cloud Storage and Cloud CDN', () => {
  const reading = readGooglePlan({
    show: plan('static-create'),
    nameSearch: [],
    context: { serviceName: 'docs' },
  });

  it('shows the bucket and the backend bucket at $0/month fixed, each with what keeps the site private and fresh', () => {
    expect(reading.summary).toEqual([
      'Cloud CDN backend bucket `cloudgate-bw7upcvsg6j2`: create, $0/month fixed, every file cached at the edge, browsers check back every time, negative caching off',
      'Cloud Storage bucket `cloudgate-bw7upcvsg6j2-p4x8m2rt`: create, $0/month fixed, private (public access prevention enforced), soft delete off',
      "Load balancer's read access to the bucket: create, only Google's load balancer reads its files",
    ]);
  });

  it('is a create of three resources, nothing adopted or drifting', () => {
    expect(reading.raw.map((line) => line.action)).toEqual([
      'create',
      'create',
      'create',
    ]);
    expect(reading.drift).toEqual([]);
    expect(reading.adopt).toEqual([]);
  });
});
