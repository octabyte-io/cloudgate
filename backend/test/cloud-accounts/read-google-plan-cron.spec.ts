import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGooglePlan } from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * The stored Google plans of a Cron service, planned offline from the real
 * generated definition (or derived by hand from it) and marked "not yet from a
 * real project" until the walk re-records them
 * (`google-plan-fixtures.spec.ts`): the sample Cron service `svc_cron_1` made
 * as its repository, its service account and its Cloud Run job, then its
 * command changed, then a new image.
 */
function plan(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures', 'plans', 'google', `${name}.json`),
      'utf8',
    ),
  ) as TofuShowJson;
}

const JOB = 'google_cloud_run_v2_job.service';

describe('readGooglePlan, a Cron service on a Cloud Run job', () => {
  it('lists the repository, service account and job, and no scheduler, service or load-balancer piece', () => {
    const reading = readGooglePlan({
      show: plan('cron-create'),
      nameSearch: [],
      context: { serviceName: 'report' },
    });

    expect(reading.summary).toEqual([
      'Artifact Registry repository `cloudgate-gx53zr4oagxf`: create',
      "Cloud Run job `report`: create, 1 CPU / 512 MB, one task, no retries, each run an execution Cloudgate's timetable starts",
      'Service account `cloudgate-gx53zr4oagxf`: create',
    ]);
    expect(reading.raw.map((line) => `${line.action} ${line.address}`)).toEqual(
      [
        'create google_artifact_registry_repository.service',
        `create ${JOB}`,
        'create google_service_account.service',
      ],
    );
    expect(JSON.stringify(reading)).not.toMatch(
      /scheduler|google_cloud_run_v2_service|backend_service|network_endpoint_group|Domain/,
    );
  });

  it('reads a changed command as a Google line on the job, which is not image-only', () => {
    const reading = readGooglePlan({
      show: plan('cron-command-change'),
      nameSearch: [],
      context: { serviceName: 'report' },
    });

    expect(reading.summary).toEqual([
      // The walk's command change: `stuck`'s `sleep` to `/bin/sleep`.
      'Cloud Run job `report`: change, command `/bin/sleep`',
    ]);
    expect(reading.raw).toEqual([
      expect.objectContaining({ address: JOB, action: 'change' }),
    ]);
    expect(reading.imageOnly).toBe(false);
  });

  it("reads a Deploy's new image on the job, a level deeper than a service's, as image-only", () => {
    const reading = readGooglePlan({
      show: plan('cron-image-only'),
      nameSearch: [],
      context: { serviceName: 'report' },
    });

    expect(reading.imageOnly).toBe(true);
    expect(reading.summary).toEqual([
      'Cloud Run job `report`: change, image `europe-west1-docker.pkg.dev/example-project-123/cloudgate-gx53zr4oagxf/service:cloudgate-stand-in-next-image`',
    ]);
  });
});
