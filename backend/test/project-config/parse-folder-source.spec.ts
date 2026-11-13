import {
  generateProjectConfig,
  parseProjectConfig,
  planEnvironment,
  projectConfigJsonSchema,
} from '../../src/project-config';
import type {
  ConfigRefusal,
  GeneratorEnvironment,
  ProjectConfig,
  SavedApplicationSettings,
  SavedService,
} from '../../src/project-config';

/**
 * A folder source (ADR-0080): an app built from a subfolder of a **Project
 * folder** says so in its entry, `source: { folder: apps/web }`, and a plan
 * gives it the uploaded-files source with that subfolder as its build path.
 */

function parsed(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.config;
}

function refused(text: string): ConfigRefusal {
  const result = parseProjectConfig(text);
  if (result.ok) throw new Error('parsed, but a refusal was expected');
  return result.refusal;
}

/** A one-Service config, so a refusal test states only what it is about. */
function oneService(name: string, entry: string): string {
  const indented = entry
    .trim()
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
  return `version: 1\nservices:\n  ${name}:\n${indented}\n`;
}

/** An Application as a console create leaves it, with these settings on top. */
function app(
  configName: string,
  settings: Partial<SavedApplicationSettings> = {},
): SavedService {
  return {
    serviceType: 'application',
    serviceId: `app-${configName}`,
    name: `App ${configName}`,
    configName,
    settings: {
      configKind: 'web',
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
      owner: null,
      repository: null,
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
      buildType: 'nixpacks',
      railpackVersion: '0.15.4',
      herokuVersion: '24',
      dockerfile: 'Dockerfile',
      dockerContextPath: null,
      dockerBuildStage: null,
      publishDirectory: null,
      isStaticSpa: null,
      createEnvFile: true,
      enableSubmodules: false,
      watchPaths: null,
      ...settings,
    },
    variables: { env: [], buildArgs: [], buildSecrets: [] },
  };
}

const production = (saved: SavedService[]): GeneratorEnvironment => ({
  name: 'production',
  deployTarget: { kind: 'platform-host' },
  saved,
});

describe('parseProjectConfig folder source', () => {
  it.each([
    ['web', 'kind: web'],
    ['worker', 'kind: worker'],
    ['static', 'kind: static'],
    ['cron', 'kind: cron\ncommand: node sweep.js\nschedule: "0 3 * * *"'],
  ])(
    'reads source: { folder: apps/web } on a %s as the uploaded files built from that subfolder',
    (_kind, head) => {
      const entry = parsed(
        oneService('site', `${head}\nsource:\n  folder: apps/web`),
      ).services.site;

      expect(entry).toMatchObject({
        source: { sourceType: 'drop', buildPath: 'apps/web' },
      });
    },
  );

  it('reads a folder written with a trailing slash as the same folder', () => {
    expect(
      parsed(oneService('web', 'kind: web\nsource:\n  folder: apps/web/'))
        .services.web,
    ).toMatchObject({
      source: { sourceType: 'drop', buildPath: 'apps/web' },
    });
  });

  it.each([
    ['/apps/web', 'absolute'],
    ['/', 'absolute'],
    ['../shared', '..'],
    ['apps/../../etc', '..'],
  ])('refuses folder %s, naming the entry', (folder, why) => {
    const refusal = refused(
      oneService('web', `kind: web\nsource:\n  folder: "${folder}"`),
    );

    expect(refusal).toMatchObject({
      reason: 'invalid',
      at: 'web.source.folder',
    });
    expect(refusal.message).toMatch(/^web\.source\.folder /);
    expect(refusal.message).toContain(why);
  });

  it.each([
    ['github: acme/shop', 'github'],
    ['git: https://example.com/acme/shop.git', 'git'],
    ['image: acme/web:1', 'image'],
    ['path: apps/web', 'path'],
  ])('refuses folder combined with %s, naming the entry', (other, key) => {
    const refusal = refused(
      oneService('web', `kind: web\nsource:\n  folder: apps/web\n  ${other}`),
    );

    expect(refusal).toMatchObject({ reason: 'invalid', at: 'web.source' });
    expect(refusal.message).toMatch(/^web\.source /);
    expect(refusal.message).toContain(`folder cannot be combined with ${key}`);
  });

  it('names folder among the sources a source may be', () => {
    const refusal = refused(oneService('web', 'kind: web\nsource: {}'));

    expect(refusal.message).toContain('folder');
  });
});

describe('projectConfigJsonSchema', () => {
  it('includes folder as a source, and version stays 1', () => {
    const schema = JSON.stringify(projectConfigJsonSchema());

    expect(schema).toContain('"folder"');
    expect(projectConfigJsonSchema()).toMatchObject({
      properties: { version: { const: 1 } },
    });
  });
});

describe('planEnvironment folder source against an uploaded-files Application', () => {
  it('changes nothing when the saved build path is the folder, written with a leading slash', () => {
    const config = parsed(
      oneService('web', 'kind: web\nsource:\n  folder: apps/web'),
    );
    const outcome = planEnvironment({
      config,
      saved: [app('web', { sourceType: 'drop', dropBuildPath: '/apps/web' })],
      deployTarget: { kind: 'platform-host' },
      context: { previous: config },
    });

    expect(outcome).toMatchObject({ ok: true, steps: [] });
  });

  it('changes the source field when the folder changes', () => {
    const config = parsed(
      oneService('web', 'kind: web\nsource:\n  folder: apps/site'),
    );
    const outcome = planEnvironment({
      config,
      saved: [app('web', { sourceType: 'drop', dropBuildPath: 'apps/web' })],
      deployTarget: { kind: 'platform-host' },
      context: { previous: config },
    });

    expect(outcome).toMatchObject({
      ok: true,
      steps: [
        {
          action: 'change',
          configName: 'web',
          fields: [
            {
              field: 'source',
              from: { folder: 'apps/web' },
              to: { folder: 'apps/site' },
            },
          ],
        },
      ],
    });
  });
});

describe('generateProjectConfig folder source', () => {
  it('writes an uploaded-files Application with a build path other than / as source: { folder }, and its first plan changes nothing', () => {
    const environments = [
      production([
        app('web', { sourceType: 'drop', dropBuildPath: '/apps/web' }),
      ]),
    ];

    const text = generateProjectConfig({ environments, schemaUrl: null });
    const config = parsed(text);

    expect(text).toContain('    source:\n      folder: apps/web\n');
    expect(config.services.web).toMatchObject({
      kind: 'web',
      managed: false,
      source: { sourceType: 'drop', buildPath: 'apps/web' },
    });
    expect(
      planEnvironment({
        config,
        saved: environments[0].saved,
        deployTarget: environments[0].deployTarget,
        context: { previous: config },
      }),
    ).toMatchObject({ ok: true, steps: [] });
  });

  it('keeps an uploaded-files Application built from the upload’s root console-managed', () => {
    const text = generateProjectConfig({
      environments: [
        production([app('web', { sourceType: 'drop', dropBuildPath: '/' })]),
      ],
      schemaUrl: null,
    });

    expect(parsed(text).services.web).toEqual({
      kind: 'web',
      managed: 'console',
    });
  });
});
