import {
  failedRevisionLogFilter,
  rolloutOf,
  workerPoolRolloutOf,
} from '../../../src/cloud-accounts/gcp/cloud-run-rollout';
import type {
  CloudRunServiceStatus,
  CloudRunWorkerPoolStatus,
} from '../../../src/cloud-accounts/google-cloud.port';

/**
 * Whether a Cloud Run service's new revision is done, from the service's
 * own report: ready and serving all traffic,
 * failed with Google's reason, or still on its way.
 */

const serving: CloudRunServiceStatus = {
  reconciling: false,
  latestCreatedRevision: 'cloudgate-abc-00002-new',
  latestReadyRevision: 'cloudgate-abc-00002-new',
  terminalCondition: {
    state: 'CONDITION_SUCCEEDED',
    reason: null,
    message: null,
  },
  traffic: [{ revision: null, percent: 100 }],
};

describe('rolloutOf', () => {
  it('is serving once the newest revision is ready and takes all traffic', () => {
    expect(rolloutOf(serving)).toEqual({
      state: 'serving',
      revision: 'cloudgate-abc-00002-new',
    });
    expect(
      rolloutOf({
        ...serving,
        traffic: [
          { revision: 'cloudgate-abc-00002-new', percent: 60 },
          { revision: null, percent: 40 },
        ],
      }),
    ).toMatchObject({ state: 'serving' });
  });

  it('waits while Google is still reconciling, the newest revision is not ready, or traffic is split with an older one', () => {
    expect(rolloutOf({ ...serving, reconciling: true })).toEqual({
      state: 'waiting',
    });
    expect(
      rolloutOf({
        ...serving,
        latestReadyRevision: 'cloudgate-abc-00001-old',
        terminalCondition: {
          state: 'CONDITION_RECONCILING',
          reason: null,
          message: null,
        },
      }),
    ).toEqual({ state: 'waiting' });
    expect(
      rolloutOf({
        ...serving,
        traffic: [
          { revision: 'cloudgate-abc-00001-old', percent: 50 },
          { revision: 'cloudgate-abc-00002-new', percent: 50 },
        ],
      }),
    ).toEqual({ state: 'waiting' });
  });

  it("is failed with the newest revision and Google's words when its Ready condition failed", () => {
    expect(
      rolloutOf({
        ...serving,
        latestReadyRevision: 'cloudgate-abc-00001-old',
        terminalCondition: {
          state: 'CONDITION_FAILED',
          reason: 'CONTAINER_FAILED',
          message:
            "Revision 'cloudgate-abc-00002-new' is not ready and cannot serve traffic.",
        },
      }),
    ).toEqual({
      state: 'failed',
      revision: 'cloudgate-abc-00002-new',
      reason:
        "Revision 'cloudgate-abc-00002-new' is not ready and cannot serve traffic.",
    });
    expect(
      rolloutOf({
        ...serving,
        terminalCondition: {
          state: 'CONDITION_FAILED',
          reason: 'CONTAINER_FAILED',
          message: null,
        },
      }),
    ).toMatchObject({ reason: 'CONTAINER_FAILED' });
  });
});

describe('failedRevisionLogFilter', () => {
  it("reads one revision's own lines and Cloud Run's about it, never the request log", () => {
    expect(
      failedRevisionLogFilter('cloudgate-abc', 'cloudgate-abc-00002-new'),
    ).toBe(
      'resource.type="cloud_run_revision" AND resource.labels.service_name="cloudgate-abc" AND resource.labels.revision_name="cloudgate-abc-00002-new" AND NOT log_name:"run.googleapis.com%2Frequests"',
    );
  });

  it("reads a Worker's revision from its worker pool's log", () => {
    expect(
      failedRevisionLogFilter(
        'cloudgate-abc',
        'cloudgate-abc-00002-new',
        'worker-pool',
      ),
    ).toBe(
      'resource.type="cloud_run_worker_pool" AND resource.labels.worker_pool_name="cloudgate-abc" AND resource.labels.revision_name="cloudgate-abc-00002-new" AND NOT log_name:"run.googleapis.com%2Frequests"',
    );
  });
});

/**
 * Whether a Worker's new revision is done: ready, running every
 * instance, and at the instance count its deploy asked for.
 */
describe('workerPoolRolloutOf', () => {
  const running: CloudRunWorkerPoolStatus = {
    reconciling: false,
    latestCreatedRevision: 'cloudgate-abc-00002-new',
    latestReadyRevision: 'cloudgate-abc-00002-new',
    terminalCondition: {
      state: 'CONDITION_SUCCEEDED',
      reason: null,
      message: null,
    },
    instanceCount: 2,
    instanceSplits: [{ revision: null, percent: 100 }],
  };

  it('is serving once the newest revision is ready, runs every instance, at its instance count', () => {
    expect(workerPoolRolloutOf(running, 2)).toEqual({
      state: 'serving',
      revision: 'cloudgate-abc-00002-new',
    });
  });

  it('waits while its instance count is not the one asked for, or instances are split with an older revision', () => {
    expect(workerPoolRolloutOf({ ...running, instanceCount: 0 }, 2)).toEqual({
      state: 'waiting',
    });
    expect(
      workerPoolRolloutOf(
        {
          ...running,
          instanceSplits: [
            { revision: 'cloudgate-abc-00001-old', percent: 50 },
            { revision: 'cloudgate-abc-00002-new', percent: 50 },
          ],
        },
        2,
      ),
    ).toEqual({ state: 'waiting' });
  });

  it("is failed with Google's condition message when the revision fails to start", () => {
    expect(
      workerPoolRolloutOf(
        {
          ...running,
          latestReadyRevision: null,
          terminalCondition: {
            state: 'CONDITION_FAILED',
            reason: 'CONTAINER_FAILED',
            message: 'The user-provided container failed to start.',
          },
        },
        2,
      ),
    ).toEqual({
      state: 'failed',
      revision: 'cloudgate-abc-00002-new',
      reason: 'The user-provided container failed to start.',
    });
  });
});
