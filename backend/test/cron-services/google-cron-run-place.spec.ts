import { serviceName } from '../../src/cloud-accounts/gcp/definitions/names';
import type { CloudAccountsService } from '../../src/cloud-accounts/cloud-accounts.service';
import type { CronRunPlace } from '../../src/cron-services/cron-run-place.port';
import { GoogleCronRunPlace } from '../../src/cron-services/google-cron-run-place';
import { makeApp } from '../deployment-engine/application.fixture';
import { FakeGoogleCloudPort } from '../utils/fake-google-cloud-port';

const PROJECT = 'shop-prod';
const REGION = 'europe-west1';
const JOB = serviceName('app-1');
const TOKEN = {
  accessToken: 'fake-impersonated-token',
  expiresAt: '2026-10-27T04:00:00Z',
};

function placeWith(
  over: {
    session?:
      | { ok: true; credential: unknown; token: typeof TOKEN }
      | { ok: false; refusal: string };
  } = {},
) {
  const google = new FakeGoogleCloudPort();
  const accounts = {
    findForUse: jest.fn().mockResolvedValue({
      cloudAccountId: 'cloud-1',
      cloud: 'gcp',
      cloudId: PROJECT,
      name: 'Prod',
    }),
    googleRunSession: jest
      .fn()
      .mockResolvedValue(
        over.session ?? { ok: true, credential: {}, token: TOKEN },
      ),
  };
  // Through the seam, as `CronRunsService` calls it.
  const place: CronRunPlace = new GoogleCronRunPlace(
    google,
    accounts as unknown as CloudAccountsService,
  );
  return { place, google, accounts };
}

const app = makeApp({
  applicationId: 'app-1',
  environmentId: 'env-1',
  cloudAccountId: 'cloud-1',
  region: REGION,
  serverId: null,
});

const run = {
  job: 'shop-api-x1-run-abc',
  image: `${REGION}-docker.pkg.dev/${PROJECT}/${JOB}/service:dep-1`,
  wiredEnv: () => Promise.reject(new Error('never built on Google Cloud')),
};

const ref = (cronRun: Record<string, unknown>) => ({
  serverId: null,
  cloudAccountId: 'cloud-1',
  region: REGION,
  applicationId: 'app-1',
  environmentId: 'env-1',
  cronRun: {
    job: run.job,
    image: run.image,
    startedBy: { kind: 'timetable' as const },
    ...cronRun,
  },
});

const first = `${JOB}-x0001`;

/**
 * A Cron run on Google Cloud is one execution of its Cron service's
 * Cloud Run job, against the faked Google cloud port (spec stories
 * 38–45).
 */
describe('GoogleCronRunPlace', () => {
  it('starts one execution of the Cron service’s job, with no overrides, and keeps the execution’s name', async () => {
    const { place, google } = placeWith();

    const job = await place.start(app, run);

    expect(
      google.calls.filter((call) => call.method === 'runCloudRunJob'),
    ).toEqual([
      {
        method: 'runCloudRunJob',
        impersonated: true,
        projectId: PROJECT,
        region: REGION,
        name: JOB,
      },
    ]);
    expect(google.executions.map((one) => one.execution)).toEqual([first]);
    expect(job.kept?.()).toEqual({ execution: first });
  });

  it('starts a second execution while the first still runs: each tick is its own', async () => {
    const { place, google } = placeWith();

    await place.start(app, run);
    await place.start(app, run);

    expect(google.executions.map((one) => one.state)).toEqual([
      'running',
      'running',
    ]);
  });

  it('never builds the wired variables: the execution reads its job’s own secrets', async () => {
    const { place } = placeWith();
    await expect(place.start(app, run)).resolves.toBeDefined();
  });

  it('throws with Google’s reason, holding nothing, when Cloud Run starts no execution', async () => {
    const { place, google } = placeWith();
    google.refuse(
      'runCloudRunJob',
      'NOT_FOUND',
      `Resource '${JOB}' of kind 'JOB' does not exist.`,
    );

    await expect(place.start(app, run)).rejects.toThrow(
      `Cloud Run refused to start it: NOT_FOUND: Resource '${JOB}' of kind 'JOB' does not exist.`,
    );
    expect(google.executions).toEqual([]);
  });

  it('throws with the refusal when the Cloud account cannot sign in', async () => {
    const { place, google } = placeWith({
      session: {
        ok: false,
        refusal: 'Cloud account Prod could not sign in to Google Cloud',
      },
    });

    await expect(place.start(app, run)).rejects.toThrow(
      'could not sign in to Google Cloud',
    );
    expect(google.executions).toEqual([]);
  });

  describe('a run’s execution', () => {
    it('goes on while Google runs it, and ends with its container’s exit code', async () => {
      const { place, google } = placeWith();
      const job = await place.start(app, run);

      await expect(job.ending()).resolves.toBeNull();
      google.endExecution(first, 3);
      await expect(job.ending()).resolves.toEqual({
        exitCode: 3,
        state: 'failed',
        err: null,
      });
    });

    it('succeeds with exit code 0', async () => {
      const { place, google } = placeWith();
      const job = await place.start(app, run);
      google.endExecution(first, 0);

      await expect(job.ending()).resolves.toEqual({
        exitCode: 0,
        state: 'succeeded',
        err: null,
      });
    });

    it('ends with Google’s condition when its container never ran', async () => {
      const { place, google } = placeWith();
      const job = await place.start(app, run);
      google.failExecutionUnstarted(
        first,
        'Image not found: europe-west1-docker.pkg.dev/shop-prod/x/service:dep-1',
      );

      await expect(job.ending()).resolves.toEqual({
        exitCode: null,
        state: 'failed',
        err: 'Image not found: europe-west1-docker.pkg.dev/shop-prod/x/service:dep-1',
      });
    });

    it('is cancelled with executions.cancel, and a cancel Google refuses is not confirmed', async () => {
      const { place, google } = placeWith();
      const job = await place.start(app, run);

      await expect(job.remove()).resolves.toBe(true);
      expect(google.executions[0].state).toBe('cancelled');

      const other = placeWith();
      const second = await other.place.start(app, run);
      other.google.refuse(
        'cancelCloudRunExecution',
        'PERMISSION_DENIED',
        "Permission 'run.executions.cancel' denied",
      );
      await expect(second.remove()).resolves.toBe(false);
    });

    it('counts one that has ended, or that Google no longer has, as gone without cancelling it', async () => {
      const { place, google } = placeWith();
      const job = await place.start(app, run);
      google.endExecution(first, 0);

      await expect(job.remove()).resolves.toBe(true);
      google.forgetExecution(first);
      await expect(job.remove()).resolves.toBe(true);
      expect(
        google.calls.filter(
          (call) => call.method === 'cancelCloudRunExecution',
        ),
      ).toEqual([]);
    });
  });

  /**
   * Its log (spec story 40): copied from Cloud Logging by its
   * execution's name, kept by entry timestamp and insert id, read on from
   * the last copied entry.
   */
  describe('a run’s log', () => {
    it('reads nothing before the first entry, and keeps no place for it', async () => {
      const { place } = placeWith();
      const job = await place.start(app, run);

      await expect(job.output()).resolves.toBe('');
      expect(job.kept?.()).toEqual({ execution: first });
    });

    it('reads its own execution’s entries on from the last copied one, never another run’s', async () => {
      const { place, google } = placeWith();
      const job = await place.start(app, run);
      await place.start(app, run);
      google.printExecution(first, ['one', 'two']);
      google.printExecution(`${JOB}-x0002`, ['the other run']);

      await expect(job.output()).resolves.toBe('one\ntwo\n');
      google.printExecution(first, ['three']);
      await expect(job.output()).resolves.toBe('three\n');
      const [read] = google.calls.filter(
        (call) => call.method === 'executionLogEntries',
      );
      expect(read).toMatchObject({
        projectId: PROJECT,
        region: REGION,
        job: JOB,
        execution: first,
        from: null,
      });
    });

    it('leaves its place where it was after a read that finds nothing', async () => {
      const { place, google } = placeWith();
      const job = await place.start(app, run);
      google.printExecution(first, ['one']);
      await job.output();
      const placeAfterOne = job.kept?.().logFrom;

      await expect(job.output()).resolves.toBe('');
      expect(job.kept?.().logFrom).toBe(placeAfterOne);
      // An entry Cloud Logging takes in late is still read.
      google.printExecution(first, ['late']);
      await expect(job.output()).resolves.toBe('late\n');
    });

    it('copies an entry stamped the same instant as the last copied one, and none twice', async () => {
      const { place, google } = placeWith();
      const job = await place.start(app, run);
      const at = '2026-10-27T03:00:01.000Z';
      google.printExecution(first, ['a'], at);
      await expect(job.output()).resolves.toBe('a\n');

      google.printExecution(first, ['b'], at);
      await expect(job.output()).resolves.toBe('b\n');
      await expect(job.output()).resolves.toBe('');
    });

    it('reads entries that arrive after its execution ends', async () => {
      const { place, google } = placeWith();
      const job = await place.start(app, run);
      google.printExecution(first, ['one']);
      await job.output();
      google.endExecution(first, 0);
      google.printExecution(first, ['written before the end, taken in after']);

      await expect(job.output()).resolves.toBe(
        'written before the end, taken in after\n',
      );
    });
  });

  describe('reaching a run again from its Run record', () => {
    it('reads its log on from where the record says the copy reached', async () => {
      const { place, google } = placeWith();
      const started = await place.start(app, run);
      google.printExecution(first, ['one', 'two']);
      await started.output();
      const kept = started.kept?.();
      google.printExecution(first, ['three']);

      const job = await place.reach(ref({ ...kept }));

      await expect(job.output()).resolves.toBe('three\n');
    });

    it('finds an execution still going, an ended one with its exit code, and one Google forgot as gone with no ending', async () => {
      const { place, google } = placeWith();
      await place.start(app, run);
      const job = await place.reach(ref({ execution: first }));

      await expect(job.find()).resolves.toEqual({ there: true });
      google.endExecution(first, 0);
      await expect(job.find()).resolves.toEqual({
        there: false,
        ending: { exitCode: 0, state: 'succeeded', err: null },
      });
      google.forgetExecution(first);
      await expect(job.find()).resolves.toEqual({
        there: false,
        ending: null,
      });
    });

    it('throws when Google Cloud cannot be reached, so the run stays running', async () => {
      const { place } = placeWith({
        session: { ok: false, refusal: 'Google Cloud could not be reached' },
      });
      await expect(place.reach(ref({ execution: first }))).rejects.toThrow(
        'Google Cloud could not be reached',
      );
    });

    it('says its result is unknown when its execution is gone with no ending', () => {
      const { place } = placeWith();
      expect(place.words.gone('Cloudgate restarted', 'restart')).toBe(
        'result unknown: Cloudgate was down when it finished',
      );
    });
  });
});
