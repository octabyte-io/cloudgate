import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGooglePlan } from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * The stored Google plan of a bucket on Cloud Storage, recorded from a real
 * plan by the walk by hand and rewritten to the sample ids
 * (`google-plan-fixtures.spec.ts`): the sample bucket
 * `svc_bucket_1` made on Cloud Storage with its own service account, that
 * account's binding on it and its HMAC key.
 */
function plan(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures', 'plans', 'google', `${name}.json`),
      'utf8',
    ),
  ) as TofuShowJson;
}

/** `bucket-create` with its CORS changed from no origin to two, in place. */
function corsChanged(): TofuShowJson {
  const show = plan('bucket-create');
  const changes = (show.resource_changes ?? []).filter(
    (change) => change.type === 'google_storage_bucket',
  );
  return {
    ...show,
    resource_changes: changes.map((change) => ({
      ...change,
      change: {
        ...change.change,
        actions: ['update'],
        before: { ...(change.change.after as object), cors: [] },
        after: {
          ...(change.change.after as object),
          cors: [
            {
              origin: ['https://app.example.com', 'http://localhost:3000'],
              method: ['GET', 'PUT', 'POST', 'HEAD'],
              response_header: ['Content-Type', 'ETag'],
              max_age_seconds: 3600,
            },
          ],
        },
      },
    })),
  };
}

describe('readGooglePlan', () => {
  describe('a bucket on Cloud Storage', () => {
    it('shows the bucket by its real name with what it is made with and its cost, its binding on it only and its one key', () => {
      const read = readGooglePlan({
        show: plan('bucket-create'),
        nameSearch: [],
        context: { serviceName: 'uploads' },
      });

      expect(read.summary).toEqual([
        'Service account `cloudgate-33lu2dv74xuy`: create',
        'Cloud Storage bucket `cloudgate-33lu2dv74xuy-k3f9a2qd`: create, soft delete off, uniform access, public access prevented, $0/month while empty, then storage and requests by use',
        "Bucket access for the bucket's own service account: create, roles/storage.objectUser on this bucket only",
        "Bucket key (HMAC) of the bucket's own service account: create, shared by every Service that links the bucket",
      ]);
    });

    it('never shows the key’s secret', () => {
      const read = readGooglePlan({
        show: plan('bucket-create'),
        nameSearch: [],
        context: {},
      });

      expect(JSON.stringify(read)).not.toMatch(/"secret"\s*:\s*"[^"]/);
    });

    it('shows the origins a CORS change moves to, as on AWS', () => {
      const read = readGooglePlan({
        show: corsChanged(),
        nameSearch: [],
        context: {},
      });

      expect(read.summary).toEqual([
        'Cloud Storage bucket `cloudgate-33lu2dv74xuy-k3f9a2qd`: change, browser uploads from `https://app.example.com`, `http://localhost:3000`',
      ]);
    });
  });
});
