import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  ConfigOutline,
  DeployTarget,
  PlanOutcome,
  SavedService,
} from '../../src/project-config';

const CLOUD: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};

function plan(
  text: string,
  saved: SavedService[],
  previous: ConfigOutline | null = null,
): PlanOutcome {
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return planEnvironment({
    config: parsed.config,
    saved,
    deployTarget: CLOUD,
    context: { previous },
    networks: [{ cloudAccountId: 'ca-1', region: 'eu-west-1' }],
  });
}

function planned(
  text: string,
  saved: SavedService[],
  previous: ConfigOutline | null = null,
) {
  const outcome = plan(text, saved, previous);
  if (!outcome.ok) {
    throw new Error(
      `refused: ${outcome.refusals.map((r) => r.message).join('; ')}`,
    );
  }
  return outcome;
}

/** `uploads` used as the existing bucket `acme-prod-uploads`. */
const existing: SavedService = {
  serviceType: 'bucket',
  serviceId: 'bucket-id',
  name: 'uploads',
  configName: 'uploads',
  existing: {
    cloudAccountId: 'ca-1',
    region: 'eu-west-1',
    bucketName: 'acme-prod-uploads',
  },
  settings: {
    description: null,
    bucketName: 'acme-prod-uploads',
    hasDomain: false,
  },
  variables: { env: [] },
};

const CONFIG = `version: 1
services:
  uploads:
    kind: bucket
`;

const DESCRIBED: ConfigOutline = {
  services: { uploads: { kind: 'bucket', managed: false } },
};

describe('planEnvironment, an existing bucket (ADR-0033)', () => {
  it('creates nothing and looks it up, with no CORS change and no Domain note', () => {
    const { steps, notes } = planned(CONFIG, [existing]);

    expect(steps).toEqual([
      {
        action: 'change',
        configName: 'uploads',
        kind: 'bucket',
        serviceType: 'bucket',
        serviceId: 'bucket-id',
        name: 'uploads',
        fields: [],
        existing: { identifier: 'acme-prod-uploads', version: null },
        cloudRead: { status: 'reading' },
      },
    ]);
    expect(notes).toEqual([]);
  });

  it('still changes what Cloudgate keeps of it, its description', () => {
    const { steps } = planned(`${CONFIG}    description: Customer uploads\n`, [
      existing,
    ]);

    expect(steps[0]).toMatchObject({
      action: 'change',
      fields: [{ field: 'description', from: null, to: 'Customer uploads' }],
      existing: { identifier: 'acme-prod-uploads' },
    });
  });

  it('is reached from a cloud web in its Cloud account and region, its key variables left unset', () => {
    const { steps, notes } = planned(
      `${CONFIG}  web:
    kind: web
    source: { image: nginx }
    env: [{ S3_BUCKET: uploads.name }, { AWS_ACCESS_KEY_ID: uploads.access_key_id }]
`,
      [existing],
    );

    expect(steps.map((step) => step.action)).toEqual(['change', 'create']);
    expect(notes).toContainEqual(
      expect.objectContaining({
        kind: 'task-role-access',
        configName: 'web',
        variable: 'AWS_ACCESS_KEY_ID',
      }),
    );
  });

  it('is unreachable from a web in another region', () => {
    const outcome = plan(
      `${CONFIG}  web:
    kind: web
    source: { image: nginx }
    env: [{ S3_BUCKET: uploads.name }]
`,
      [
        {
          ...existing,
          existing: {
            cloudAccountId: 'ca-1',
            region: 'us-east-1',
            bucketName: 'acme-prod-uploads',
          },
        },
      ],
    );

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.refusals[0].message).toContain(
      'cannot reach it',
    );
  });

  it('is destroyed as one left as it was, and a rename says its files are not copied', () => {
    const { steps, notes } = planned(
      `version: 1
services:
  files:
    kind: bucket
`,
      [existing],
      DESCRIBED,
    );

    expect(steps).toContainEqual({
      action: 'destroy',
      configName: 'uploads',
      kind: 'bucket',
      serviceType: 'bucket',
      serviceId: 'bucket-id',
      name: 'uploads',
      existing: { identifier: 'acme-prod-uploads' },
    });
    expect(notes).toContainEqual({
      kind: 'files-not-copied',
      configName: 'uploads',
      message:
        'uploads: the existing bucket acme-prod-uploads is left as it was, and its files are not copied; a bucket renamed or given another kind is a new, empty one',
    });
  });
});
