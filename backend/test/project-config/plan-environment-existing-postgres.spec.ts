import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanOutcome,
  SavedService,
} from '../../src/project-config';

const CLOUD: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};

function plan(text: string, saved: SavedService[]): PlanOutcome {
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return planEnvironment({
    config: parsed.config,
    saved,
    deployTarget: CLOUD,
    context: { previous: null },
    networks: [{ cloudAccountId: 'ca-1', region: 'eu-west-1' }],
  });
}

function planned(text: string, saved: SavedService[]) {
  const outcome = plan(text, saved);
  if (!outcome.ok) {
    throw new Error(
      `refused: ${outcome.refusals.map((r) => r.message).join('; ')}`,
    );
  }
  return outcome;
}

/** `pg-1` used as the existing database `acme-prod`. */
const existing: SavedService = {
  serviceType: 'postgres',
  serviceId: 'pg-id',
  name: 'pg-1',
  configName: 'pg-1',
  existing: {
    cloudAccountId: 'ca-1',
    region: 'eu-west-1',
    identifier: 'acme-prod',
    madeReachable: false,
  },
  settings: {
    description: null,
    cpuLimit: null,
    memoryLimit: null,
    dockerImage: 'postgres:18',
    databaseName: 'shop',
    databaseUser: 'shop_app',
  },
  variables: { env: [] },
};

const CONFIG = `version: 1
services:
  pg-1:
    kind: postgres
    version: "17"
    size: large
    database: orders
    user: orders
`;

describe('planEnvironment, an existing database (ADR-0033)', () => {
  it('creates nothing and looks it up, with the config version to note against', () => {
    const { steps } = planned(CONFIG, [existing]);

    expect(steps).toEqual([
      {
        action: 'change',
        configName: 'pg-1',
        kind: 'postgres',
        serviceType: 'postgres',
        serviceId: 'pg-id',
        name: 'pg-1',
        fields: [],
        existing: { identifier: 'acme-prod', version: 'postgres:17' },
        cloudRead: { status: 'reading' },
      },
    ]);
  });

  it("notes that the config's database, user, size and version are not applied", () => {
    const { notes } = planned(CONFIG, [existing]);

    expect(notes).toContainEqual({
      kind: 'existing-not-applied',
      configName: 'pg-1',
      message:
        "pg-1 uses the existing database acme-prod: the config's database, user, size and version are not applied to it",
    });
  });

  it('still changes what Cloudgate keeps of it, its description', () => {
    const { steps } = planned(
      CONFIG.replace(
        'kind: postgres',
        'kind: postgres\n    description: orders db',
      ),
      [existing],
    );

    expect(steps[0]).toMatchObject({
      action: 'change',
      fields: [{ field: 'description', from: null, to: 'orders db' }],
    });
  });

  it('is reached from a cloud web in its Cloud account and region, ca included', () => {
    const { steps } = planned(
      `${CONFIG}  web:
    kind: web
    source: { image: nginx }
    env: [{ DATABASE_URL: pg-1.url }, { PGSSLROOTCERT: pg-1.ca }]
`,
      [existing],
    );

    expect(steps.map((step) => step.action)).toEqual(['change', 'create']);
  });

  it('is unreachable from a web in another region', () => {
    const outcome = plan(
      `${CONFIG}  web:
    kind: web
    source: { image: nginx }
    env: [{ DATABASE_URL: pg-1.url }]
`,
      [
        {
          ...existing,
          existing: { ...existing.existing!, region: 'us-east-1' },
        },
      ],
    );

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.refusals[0].message).toContain(
      'cannot reach it',
    );
  });
});

describe('planEnvironment, an existing Cloud SQL postgres on Google Cloud', () => {
  const GOOGLE: DeployTarget = {
    kind: 'cloud',
    cloudAccountId: 'gca-1',
    region: 'europe-west1',
  };
  const onGoogle: SavedService = {
    ...existing,
    existing: {
      cloudAccountId: 'gca-1',
      region: 'europe-west1',
      identifier: 'shop-prod:europe-west1:acme-prod',
      madeReachable: false,
    },
  };

  function googlePlan(
    networks: Parameters<typeof planEnvironment>[0]['networks'],
  ) {
    const parsed = parseProjectConfig(CONFIG);
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    const outcome = planEnvironment({
      config: parsed.config,
      saved: [onGoogle],
      deployTarget: GOOGLE,
      cloud: 'gcp',
      context: { previous: null },
      networks,
    });
    if (!outcome.ok) throw new Error(outcome.refusals[0].message);
    return outcome.steps;
  }

  it("looks it up, and adds Cloud SQL's private link to a made network first, whose subnet its endpoint's address is on", () => {
    const steps = googlePlan([
      {
        cloudAccountId: 'gca-1',
        region: 'europe-west1',
        environmentNetworkId: 'net-1',
        privateLinks: [],
      },
    ]);

    expect(steps).toEqual([
      {
        action: 'network-change',
        environmentNetworkId: 'net-1',
        cloudAccountId: 'gca-1',
        region: 'europe-west1',
        privateLinks: ['cloud-sql'],
        cloudRead: { status: 'reading' },
      },
      expect.objectContaining({
        action: 'change',
        configName: 'pg-1',
        existing: {
          identifier: 'shop-prod:europe-west1:acme-prod',
          version: 'postgres:17',
        },
        cloudRead: { status: 'reading' },
      }),
    ]);
  });

  it('makes the Environment network with the link when there is none', () => {
    const steps = googlePlan([]);

    expect(steps.map((step) => step.action)).toEqual([
      'network-create',
      'change',
    ]);
    expect(steps[0]).toMatchObject({ privateLinks: ['cloud-sql'] });
  });

  it('touches no network that holds the link already', () => {
    const steps = googlePlan([
      {
        cloudAccountId: 'gca-1',
        region: 'europe-west1',
        environmentNetworkId: 'net-1',
        privateLinks: ['cloud-sql'],
      },
    ]);

    expect(steps.map((step) => step.action)).toEqual(['change']);
  });

  it('never makes a network for an existing database on AWS', () => {
    expect(
      planned(CONFIG, [existing]).steps.map((step) => step.action),
    ).toEqual(['change']);
  });
});
