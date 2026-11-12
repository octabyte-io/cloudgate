import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanInput,
  PlanOutcome,
  SavedService,
} from '../../src/project-config';
import { bucketChecksumNotes } from '../../src/project-config/planner/plan-links';

const GOOGLE: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'gca-1',
  region: 'europe-west1',
};

const BUCKET = 'version: 1\nservices:\n  uploads:\n    kind: bucket\n';

/** A `web` wired to every one of the bucket's six Outputs. */
const WEB_AND_BUCKET = `version: 1
services:
  uploads:
    kind: bucket
  api:
    kind: web
    source: { image: nginx }
    env:
      - S3_BUCKET: uploads.name
      - S3_REGION: uploads.region
      - S3_ENDPOINT: uploads.endpoint
      - AWS_ACCESS_KEY_ID: uploads.access_key_id
      - AWS_SECRET_ACCESS_KEY: uploads.secret_access_key
      - S3_PATH_STYLE: uploads.path_style
`;

function input(text: string, saved: SavedService[] = []): PlanInput {
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return {
    config: parsed.config,
    saved,
    deployTarget: GOOGLE,
    cloud: 'gcp',
    context: { previous: null },
    networks: [{ cloudAccountId: 'gca-1', region: 'europe-west1' }],
  };
}

function planned(text: string, saved: SavedService[] = []) {
  const outcome: PlanOutcome = planEnvironment(input(text, saved));
  if (!outcome.ok) {
    throw new Error(
      `refused: ${outcome.refusals.map((r) => r.message).join('; ')}`,
    );
  }
  return outcome;
}

/** A bucket already made on Cloud Storage in this Environment. */
function onCloudStorage(
  origins: string[],
  applied: string[] | null,
): SavedService {
  return {
    serviceType: 'bucket',
    serviceId: 'bkt-id',
    name: 'uploads',
    configName: 'uploads',
    cloud: {
      cloudAccountId: 'gca-1',
      region: 'europe-west1',
      cloud: 'gcp',
      linkedRegistries: [],
    },
    settings: {
      description: null,
      bucketName: 'cloudgate-xj4bnp4pahh6-a1b2c3d4',
    },
    variables: { env: [] },
    cors: { origins, applied },
  };
}

/**
 * Spec "Kinds on Google Cloud", "Bucket on Cloud Storage": a
 * Google Cloud Deploy target makes a `bucket` as a Cloud Storage bucket
 * instead of refusing it, read from Google like a `web`; its key Outputs
 * have a value there, so no variable linked to one is left unset; and the
 * checksum note is built behind one switch, off.
 */
describe('planEnvironment, a bucket on Google Cloud', () => {
  it('creates it there, reading Google, with no Environment network for it', () => {
    const { steps } = planned(BUCKET);

    expect(steps).toEqual([
      {
        action: 'create',
        configName: 'uploads',
        kind: 'bucket',
        placement: GOOGLE,
        fields: [],
        cloudRead: { status: 'reading' },
      },
    ]);
  });

  it('wires a web to all six Outputs, its key among them, with no note that a variable is left unset', () => {
    const { steps, notes } = planned(WEB_AND_BUCKET);

    expect(
      steps.map((step) => [
        step.action,
        'configName' in step ? step.configName : null,
      ]),
    ).toEqual([
      ['create', 'uploads'],
      ['create', 'api'],
    ]);
    expect(notes.map((note) => note.kind)).not.toContain('task-role-access');
    // The checksum note's switch is off until the walk by hand.
    expect(notes.map((note) => note.kind)).not.toContain('bucket-checksums');
  });

  it('plans origins edited on its page as a CORS change, read from Google, as on AWS', () => {
    const { steps } = planned(BUCKET, [
      onCloudStorage(['https://app.example.com'], []),
    ]);

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'uploads',
        serviceType: 'bucket',
        cors: { from: [], to: ['https://app.example.com'] },
        cloudRead: { status: 'reading' },
      }),
    ]);
    expect(
      planned(BUCKET, [
        onCloudStorage(
          ['https://app.example.com'],
          ['https://app.example.com'],
        ),
      ]).steps,
    ).toEqual([]);
  });
});

describe('bucketChecksumNotes', () => {
  it('names both settings and when_required for each variable linked to a bucket on Google Cloud, once switched on', () => {
    const notes = bucketChecksumNotes(input(WEB_AND_BUCKET), true);

    expect(notes.map((note) => 'variable' in note && note.variable)).toEqual([
      'S3_BUCKET',
      'S3_REGION',
      'S3_ENDPOINT',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'S3_PATH_STYLE',
    ]);
    expect(notes[0]).toEqual({
      kind: 'bucket-checksums',
      configName: 'api',
      variable: 'S3_BUCKET',
      message:
        'api.env.S3_BUCKET links to uploads.name: newer S3 SDKs send checksums Cloud Storage does not take. Set AWS_REQUEST_CHECKSUM_CALCULATION and AWS_RESPONSE_CHECKSUM_VALIDATION to when_required on api; Cloudgate never sets them itself.',
    });
  });

  it('says nothing while the switch is off, as every plan has it', () => {
    expect(bucketChecksumNotes(input(WEB_AND_BUCKET))).toEqual([]);
  });

  it('says nothing of a bucket on AWS, nor of a link to anything but a bucket', () => {
    const onAws = { ...input(WEB_AND_BUCKET), cloud: 'aws' as const };
    expect(bucketChecksumNotes(onAws, true)).toEqual([]);

    const redis = input(`version: 1
services:
  cache:
    kind: redis
  api:
    kind: web
    source: { image: nginx }
    env:
      - REDIS_URL: cache.url
`);
    expect(bucketChecksumNotes(redis, true)).toEqual([]);
  });
});
