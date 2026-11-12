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

const DOCS = `version: 1
services:
  docs:
    kind: static
    source: { github: acme/docs }
    build:
      publish: dist
`;

/** Every container-only field a static entry can set. */
const DOCS_WITH_CONTAINER_FIELDS = `version: 1
services:
  docs:
    kind: static
    size: small
    command: nginx
    args: ["-g", "daemon off;"]
    env: [API_URL]
    build_args: [NODE_ENV]
    build_secrets: [NPM_TOKEN]
    source: { github: acme/docs }
    build:
      publish: dist
`;

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

/** A static site already made on S3 + CloudFront in this Environment. */
function onCloudFront(
  settings: { isStaticSpa?: boolean | null } = {},
  env: string[] = [],
): SavedService {
  return {
    serviceType: 'application',
    serviceId: 'app-docs',
    name: 'docs',
    configName: 'docs',
    cloud: {
      cloudAccountId: 'ca-1',
      region: 'eu-west-1',
      linkedRegistries: [],
    },
    settings: {
      configKind: 'static',
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      command: null,
      args: null,
      port: 3000,
      cronSchedule: null,
      cronTimezone: null,
      cronTimeoutSeconds: null,
      sourceType: 'github',
      owner: 'acme',
      repository: 'docs',
      buildPath: '/',
      gitlabOwner: null,
      gitlabRepository: null,
      gitlabPathNamespace: null,
      gitlabBuildPath: '/',
      giteaOwner: null,
      giteaRepository: null,
      giteaBuildPath: '/',
      bitbucketOwner: null,
      bitbucketRepository: null,
      bitbucketBuildPath: '/',
      customGitUrl: null,
      customGitBuildPath: null,
      dockerImage: null,
      buildType: 'static',
      railpackVersion: '0.15.4',
      herokuVersion: '24',
      dockerfile: 'Dockerfile',
      dockerContextPath: null,
      dockerBuildStage: null,
      publishDirectory: 'dist',
      isStaticSpa: settings.isStaticSpa ?? false,
      createEnvFile: true,
      enableSubmodules: false,
      watchPaths: null,
    },
    variables: { env, buildArgs: [], buildSecrets: [] },
  };
}

/**
 * A cloud Deploy target makes a `static` entry as a private S3 bucket
 * behind CloudFront instead of refusing it ("not available … yet").
 * The fields only a container has are ignored, never refused, with one note
 * per Service naming those it sets; only `spa` reaches AWS.
 */
describe('planEnvironment, a static site in a Cloud account', () => {
  it('creates it there, reading AWS with its spa, with no Environment network for it', () => {
    const { steps, notes } = planned(DOCS);

    // CloudFront and S3 sit in no VPC: no network is made for the site.
    expect(steps).toEqual([
      expect.objectContaining({
        action: 'create',
        configName: 'docs',
        kind: 'static',
        placement: CLOUD,
        site: { spa: false },
        cloudRead: { status: 'reading' },
      }),
    ]);
    expect(steps[0]).not.toHaveProperty('cloud');
    expect(notes).toEqual([]);
  });

  it('reads spa: true into the site it creates', () => {
    const { steps } = planned(
      DOCS.replace('publish: dist', 'publish: dist\n      spa: true'),
    );

    expect(steps[0]).toMatchObject({ site: { spa: true } });
  });

  it('ignores every container-only field it sets, never refusing, and names them in one note', () => {
    const { steps, notes } = planned(DOCS_WITH_CONTAINER_FIELDS);

    expect(notes).toEqual([
      {
        kind: 'ignored-on-s3',
        configName: 'docs',
        fields: [
          'size',
          'command',
          'args',
          'env',
          'build_args',
          'build_secrets',
        ],
        message:
          'docs: `size`, `command`, `args`, `env`, `build_args`, `build_secrets` have no meaning on S3 + CloudFront, so they are ignored',
      },
    ]);
    const [step] = steps;
    if (step.action !== 'create') throw new Error('expected a create');
    const fields = step.fields.map((diff) => diff.field);
    expect(fields).not.toEqual(
      expect.arrayContaining(['size', 'command', 'args']),
    );
  });

  it('names one ignored field in the singular', () => {
    const { notes } = planned(
      DOCS.replace('kind: static', 'kind: static\n    size: small'),
    );

    expect(notes).toEqual([
      expect.objectContaining({
        fields: ['size'],
        message:
          'docs: `size` has no meaning on S3 + CloudFront, so it is ignored',
      }),
    ]);
  });

  it('plans nothing for a site whose config is as it was made', () => {
    expect(planned(DOCS, [onCloudFront()]).steps).toEqual([]);
  });

  it('plans no change for a container-only field, only the note, and removes no variable', () => {
    const { steps, notes } = planned(DOCS_WITH_CONTAINER_FIELDS, [
      onCloudFront({}, ['OLD_KEY']),
    ]);

    expect(steps).toEqual([]);
    expect(notes).toEqual([expect.objectContaining({ kind: 'ignored-on-s3' })]);
  });

  it('plans a spa change as a change that reads AWS with the spa it will have', () => {
    const { steps } = planned(
      DOCS.replace('publish: dist', 'publish: dist\n      spa: true'),
      [onCloudFront()],
    );

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'docs',
        kind: 'static',
        serviceId: 'app-docs',
        fields: [{ field: 'build.spa', from: false, to: true }],
        site: { spa: true },
        cloudRead: { status: 'reading' },
      }),
    ]);
  });

  it('reads it for Drift on Check for changes', () => {
    const { steps } = planned(DOCS, [onCloudFront()], {
      cloudReads: { everything: true, services: [] },
    });

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        kind: 'static',
        serviceId: 'app-docs',
        fields: [],
        cloudRead: { status: 'reading' },
      }),
    ]);
  });

  it('holds no Environment network: one nothing else uses is removed', () => {
    const { steps } = planned(DOCS, [onCloudFront()], {
      deployTarget: {
        kind: 'cloud',
        cloudAccountId: 'ca-1',
        region: 'us-east-1',
      },
      removableNetworks: [
        {
          environmentNetworkId: 'net-1',
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          dnsRecordsLeft: [],
        },
      ],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'network-remove',
        environmentNetworkId: 'net-1',
      }),
    ]);
  });
});
