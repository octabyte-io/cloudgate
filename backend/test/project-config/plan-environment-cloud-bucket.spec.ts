import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanInput,
  PlanOutcome,
  ProjectConfig,
  SavedService,
} from '../../src/project-config';

const CLOUD: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};

const BUCKET = 'version: 1\nservices:\n  uploads:\n    kind: bucket\n';

function config(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.config;
}

function plan(
  text: string,
  saved: SavedService[] = [],
  more: Partial<PlanInput> = {},
): PlanOutcome {
  return planEnvironment({
    config: config(text),
    saved,
    deployTarget: CLOUD,
    context: { previous: null },
    ...more,
  });
}

function planned(...args: Parameters<typeof plan>) {
  const outcome = plan(...args);
  if (!outcome.ok) {
    throw new Error(
      `refused: ${outcome.refusals.map((r) => r.message).join('; ')}`,
    );
  }
  return outcome;
}

/** A bucket already made on S3 in this Environment. */
function onS3(
  origins: string[],
  applied: string[] | null,
  description: string | null = null,
): SavedService {
  return {
    serviceType: 'bucket',
    serviceId: 'bkt-id',
    name: 'uploads',
    configName: 'uploads',
    cloud: {
      cloudAccountId: 'ca-1',
      region: 'eu-west-1',
      linkedRegistries: [],
    },
    settings: {
      description,
      bucketName: 'uploads-k3f9a2qd-123456789012-eu-west-1-an',
    },
    variables: { env: [] },
    cors: { origins, applied },
  };
}

/**
 * A cloud Deploy target makes a `bucket` as an S3 bucket instead of
 * refusing it ("not available … yet"), reads it from AWS like a
 * `web`, and plans origins edited on its page as a CORS change.
 */
describe('planEnvironment, a bucket in a Cloud account', () => {
  it('creates it there, reading AWS, with no Environment network for it', () => {
    const { steps } = planned(BUCKET);

    expect(steps).toEqual([
      {
        action: 'create',
        configName: 'uploads',
        kind: 'bucket',
        placement: CLOUD,
        fields: [],
        cloudRead: { status: 'reading' },
      },
    ]);
  });

  it('still makes the network for a web created beside it', () => {
    const { steps } = planned(
      `${BUCKET}  api:\n    kind: web\n    source:\n      image: nginx:1\n`,
    );

    expect(steps.map((step) => step.action)).toEqual([
      'network-create',
      'create',
      'create',
    ]);
  });

  it('plans nothing for a bucket whose origins are as its last Cloud run wrote them', () => {
    expect(
      planned(BUCKET, [
        onS3(['https://app.example.com'], ['https://app.example.com']),
      ]).steps,
    ).toEqual([]);
  });

  it('plans origins edited on its page as a CORS change, read from AWS', () => {
    const { steps } = planned(BUCKET, [
      onS3(['https://app.example.com', 'http://localhost:3000'], []),
    ]);

    expect(steps).toEqual([
      {
        action: 'change',
        configName: 'uploads',
        kind: 'bucket',
        serviceType: 'bucket',
        serviceId: 'bkt-id',
        name: 'uploads',
        fields: [],
        cors: {
          from: [],
          to: ['https://app.example.com', 'http://localhost:3000'],
        },
        cloudRead: { status: 'reading' },
      },
    ]);
  });

  it('reads a bucket that never ran as having no origins', () => {
    expect(planned(BUCKET, [onS3([], null)]).steps).toEqual([]);
    expect(
      planned(BUCKET, [onS3(['https://app.example.com'], null)]).steps[0],
    ).toMatchObject({ cors: { from: [], to: ['https://app.example.com'] } });
  });

  it('compares origins as a set, not in order', () => {
    expect(
      planned(BUCKET, [
        onS3(
          ['https://b.example', 'https://a.example'],
          ['https://a.example', 'https://b.example'],
        ),
      ]).steps,
    ).toEqual([]);
  });

  it('changes a description alone without reading AWS', () => {
    const { steps } = planned(`${BUCKET}    description: Files\n`, [
      onS3([], []),
    ]);

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        fields: [{ field: 'description', from: null, to: 'Files' }],
      }),
    ]);
    expect(steps[0]).not.toHaveProperty('aws');
  });

  it('reads it for Drift on "Check for changes"', () => {
    const { steps } = planned(BUCKET, [onS3([], [])], {
      cloudReads: { everything: true, services: [] },
    });

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        serviceType: 'bucket',
        serviceId: 'bkt-id',
        fields: [],
        cloudRead: { status: 'reading' },
      }),
    ]);
  });

  it('holds no Environment network: a bucket on S3 sits in none', () => {
    const { steps } = planEnvironment({
      config: config(BUCKET),
      saved: [onS3([], [])],
      deployTarget: { kind: 'platform-host' },
      context: { previous: null },
      removableNetworks: [
        {
          environmentNetworkId: 'net-1',
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          dnsRecordsLeft: [],
        },
      ],
    }) as Extract<PlanOutcome, { ok: true }>;

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'network-remove',
        environmentNetworkId: 'net-1',
      }),
    ]);
  });
});
