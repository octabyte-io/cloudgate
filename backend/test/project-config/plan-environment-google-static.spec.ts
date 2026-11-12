import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanInput,
  PlanOutcome,
  SavedService,
} from '../../src/project-config';

const GOOGLE: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'gca-1',
  region: 'europe-west1',
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

function plan(
  text: string,
  saved: SavedService[] = [],
  more: Partial<PlanInput> = {},
): PlanOutcome {
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return planEnvironment({
    config: parsed.config,
    saved,
    deployTarget: GOOGLE,
    cloud: 'gcp',
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

/** A static site already made on Cloud Storage + Cloud CDN. */
function onCloudCdn(spa = false): SavedService {
  return {
    serviceType: 'application',
    serviceId: 'app-docs',
    name: 'docs',
    configName: 'docs',
    cloud: {
      cloudAccountId: 'gca-1',
      region: 'europe-west1',
      cloud: 'gcp',
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
      isStaticSpa: spa,
      createEnvFile: true,
      enableSubmodules: false,
      watchPaths: null,
    },
    variables: { env: [], buildArgs: [], buildSecrets: [] },
  };
}

const BY_USE = {
  kind: 'static-by-use',
  configName: 'docs',
  message:
    'docs: its Cloud Storage bucket and Cloud CDN backend bucket are $0/month fixed; serving is charged by use (stored files, requests and Cloud CDN traffic). The Environment network already pays for the load balancer',
};

const NO_DOMAIN = {
  kind: 'static-no-domain',
  configName: 'docs',
  message:
    'docs: answers nowhere until a Domain is added: a static site on Google Cloud has no address of its own. Add one in the console once its first deploy is done',
};

/**
 * Spec stories 31, 32, 50, 52: a Google Cloud Deploy target
 * makes a `static` entry as a private Cloud Storage bucket behind a Cloud
 * CDN backend bucket instead of refusing it. Its plan says what it costs,
 * that it answers nowhere until a Domain is added, and, in one note, which
 * container-only fields it ignores.
 */
describe('planEnvironment, a static site on Google Cloud', () => {
  it('creates it there, reading Google with its spa, with no Environment network made for it', () => {
    const { steps } = planned(DOCS);

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'create',
        configName: 'docs',
        kind: 'static',
        placement: GOOGLE,
        site: { spa: false },
        cloudRead: { status: 'reading' },
      }),
    ]);
    expect(steps[0]).not.toHaveProperty('cloud');
  });

  it('notes its $0/month fixed cost and that serving is charged by use, and that it answers nowhere until a Domain is added', () => {
    const { notes } = planned(DOCS);

    expect(notes).toEqual([BY_USE, NO_DOMAIN]);
  });

  it('ignores every container-only field it sets, never refusing, in one note naming Cloud Storage + Cloud CDN', () => {
    const { steps, notes } = planned(DOCS_WITH_CONTAINER_FIELDS);

    expect(notes).toEqual([
      {
        kind: 'ignored-on-cloud-cdn',
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
          'docs: `size`, `command`, `args`, `env`, `build_args`, `build_secrets` have no meaning on Cloud Storage + Cloud CDN, so they are ignored',
      },
      BY_USE,
      NO_DOMAIN,
    ]);
    const [step] = steps;
    if (step.action !== 'create') throw new Error('expected a create');
    expect(step.fields.map((diff) => diff.field)).not.toEqual(
      expect.arrayContaining(['size', 'command', 'args']),
    );
  });

  it('names one ignored field in the singular', () => {
    const { notes } = planned(
      DOCS.replace('kind: static', 'kind: static\n    size: small'),
    );

    expect(notes).toContainEqual(
      expect.objectContaining({
        kind: 'ignored-on-cloud-cdn',
        message:
          'docs: `size` has no meaning on Cloud Storage + Cloud CDN, so it is ignored',
      }),
    );
  });

  it('plans nothing for a site whose config is as it was made', () => {
    expect(planned(DOCS, [onCloudCdn()]).steps).toEqual([]);
  });

  it('plans no change for a container-only field on a made site, only the Google note', () => {
    const { steps, notes } = planned(DOCS_WITH_CONTAINER_FIELDS, [
      onCloudCdn(),
    ]);

    expect(steps).toEqual([]);
    expect(notes).toEqual([
      expect.objectContaining({ kind: 'ignored-on-cloud-cdn' }),
    ]);
  });
});

/**
 * Spec story 42, "Toggling `spa`": on Google Cloud a static
 * site's `spa` is its host rules' error policy on the Environment network,
 * never its own state's, so its change reads nothing of the site: its Apply
 * saves it and runs the network, which clears its Domains' cache at the
 * end. The plan says what visitors may see meanwhile.
 */
describe('planEnvironment, spa on a static site on Google Cloud', () => {
  const SPA = DOCS.replace('publish: dist', 'publish: dist\n      spa: true');

  it('plans turning spa on as a change that reads nothing of the site', () => {
    const { steps } = planned(SPA, [onCloudCdn()]);

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'docs',
        kind: 'static',
        fields: [expect.objectContaining({ field: 'build.spa' })],
      }),
    ]);
    expect(steps[0]).not.toHaveProperty('cloudRead');
  });

  it('notes that a network run clears its Domains, and what visitors may see meanwhile, both ways', () => {
    const on = planned(SPA, [onCloudCdn()]).notes;
    const off = planned(DOCS, [onCloudCdn(true)]).notes;

    for (const notes of [on, off]) {
      expect(notes).toEqual([
        {
          kind: 'static-spa-change',
          configName: 'docs',
          message:
            "docs: changing `spa` is a run of the Environment network, which clears the cache of the site's Domains at its end. Some visitors may see the old behaviour for missing pages for a few minutes, and a missing page cached with the shell can last up to a day",
        },
      ]);
    }
  });
});
