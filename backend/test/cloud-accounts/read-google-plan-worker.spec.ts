import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGooglePlan } from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type {
  TofuResourceChange,
  TofuShowJson,
} from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * The stored Google plan of a Worker, planned offline from the real generated
 * definition and marked "not yet from a real project" until the walk
 * re-records it (`google-plan-fixtures.spec.ts`): the sample Worker
 * `svc_worker_1` made, its repository, its service account and its Cloud Run
 * worker pool at one instance, with no load-balancer piece.
 */
function plan(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures', 'plans', 'google', `${name}.json`),
      'utf8',
    ),
  ) as TofuShowJson;
}

const POOL = 'google_cloud_run_v2_worker_pool.service';
const REGISTRY =
  'europe-west1-docker.pkg.dev/example-project-123/cloudgate-ausyuuc4hp53/service';

function poolOf(show: TofuShowJson): TofuResourceChange {
  const found = show.resource_changes?.find((one) => one.address === POOL);
  if (!found) throw new Error(`no ${POOL}`);
  return found;
}

describe('readGooglePlan, a Worker on a Cloud Run worker pool', () => {
  it('lists the repository, service account and worker pool, and no load-balancer piece', () => {
    const reading = readGooglePlan({
      show: plan('worker-create'),
      nameSearch: [],
      context: { serviceName: 'jobs' },
    });

    expect(reading.summary).toEqual([
      'Artifact Registry repository `cloudgate-ausyuuc4hp53`: create',
      'Cloud Run worker pool `jobs`: create, 1 CPU / 512 MB, CPU always on, 1 instance, no ingress',
      'Service account `cloudgate-ausyuuc4hp53`: create',
    ]);
    expect(reading.raw.map((line) => `${line.action} ${line.address}`)).toEqual(
      [
        'create google_artifact_registry_repository.service',
        `create ${POOL}`,
        'create google_service_account.service',
      ],
    );
    expect(JSON.stringify(reading)).not.toMatch(
      /backend_service|network_endpoint_group|Domain/,
    );
  });

  it('reads a stopped Worker, its instance count 0, as no drift, and a new image as image-only', () => {
    const created = plan('worker-create');
    const made = poolOf(created).change.after as Record<string, unknown>;
    const template = made.template as Record<string, unknown>[];
    const containers = template[0].containers as Record<string, unknown>[];
    const stopped = { ...made, scaling: [{ manual_instance_count: 0 }] };
    const live = {
      ...stopped,
      template: [
        {
          ...template[0],
          containers: [{ ...containers[0], image: `${REGISTRY}:dep_1` }],
        },
      ],
    };
    const show: TofuShowJson = {
      ...created,
      resource_drift: [
        {
          ...poolOf(created),
          change: {
            actions: ['update'],
            before: { ...live, scaling: [{ manual_instance_count: 1 }] },
            after: live,
          },
        },
      ],
      resource_changes: [
        {
          ...poolOf(created),
          change: {
            actions: ['update'],
            before: live,
            after: {
              ...live,
              template: [
                {
                  ...template[0],
                  containers: [
                    { ...containers[0], image: `${REGISTRY}:dep_2` },
                  ],
                },
              ],
            },
          },
        },
      ],
    };

    const reading = readGooglePlan({
      show,
      nameSearch: [],
      context: { serviceName: 'jobs', imageRef: `${REGISTRY}:dep_2` },
    });

    expect(reading).toMatchObject({
      summary: [
        'Cloud Run worker pool `jobs`: change, new image, built by this deploy',
      ],
      drift: [],
      imageOnly: true,
    });
  });
});
