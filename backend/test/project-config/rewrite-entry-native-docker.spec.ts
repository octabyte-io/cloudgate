import { parse } from 'yaml';

import {
  movedFields,
  rewriteEntry,
} from '../../src/project-config/console-saves/rewrite-entry';
import { generateProjectConfig } from '../../src/project-config/generator/generate-config';
import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type { DockerSettings } from '../../src/native/docker-native';
import type { DeployTarget, SavedService } from '../../src/project-config';

/**
 * On a Cloudgate-kept config, a console Save of a described
 * Service's Swarm settings rewrites its entry's `native.docker` — only the
 * settings the Save changed, each at the stored value, a default left out —
 * so the next plan finds nothing (ADR-0029, ADR-0044).
 */

const PLATFORM: DeployTarget = { kind: 'platform-host' };

/** A `web` as a console create leaves it, with these Swarm settings stored. */
function savedWeb(
  configName: string,
  docker?: DockerSettings,
  kind: 'web' | 'worker' | 'static' | 'cron' = 'web',
): SavedService {
  return {
    serviceType: 'application',
    serviceId: `app-${configName}`,
    name: `App ${configName}`,
    configName,
    ...(docker ? { docker } : {}),
    settings: {
      configKind: kind,
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      command: kind === 'cron' ? 'run' : null,
      args: null,
      port: 3000,
      cronSchedule: kind === 'cron' ? '0 * * * *' : null,
      cronTimezone: kind === 'cron' ? 'UTC' : null,
      cronTimeoutSeconds: kind === 'cron' ? 3600 : null,
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
      buildType: kind === 'static' ? 'static' : 'nixpacks',
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
    },
    variables: { env: [], buildArgs: [], buildSecrets: [] },
  };
}

/** The Save: `before` as stored, `after` as the console wrote it. */
function save(stored: string, before: SavedService, after: SavedService) {
  const environment = {
    name: 'production',
    deployTarget: PLATFORM,
    saved: [after],
  };
  return rewriteEntry({
    stored,
    configName: 'web',
    environments: [environment],
    creating: false,
    edited: { environment, before },
  });
}

/** What the Generator writes for `saved`, as a Cloudgate-kept text starts. */
function textOf(saved: SavedService): string {
  return generateProjectConfig({
    environments: [
      { name: 'production', deployTarget: PLATFORM, saved: [saved] },
    ],
    schemaUrl: null,
  });
}

/** The text with `native` YAML under the web entry. */
function withNative(text: string, native: string): string {
  const indented = native
    .trim()
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
  return text.replace(/(\n {2}web:\n(?: {4}.*\n)*)/, `$1${indented}\n`);
}

function entry(text: string): Record<string, unknown> {
  return (parse(text) as { services: Record<string, Record<string, unknown>> })
    .services.web;
}

/** The steps a plan of `text` against `saved` finds for `web`. */
function planned(text: string, saved: SavedService) {
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) throw new Error(parsed.refusal.message);
  const outcome = planEnvironment({
    config: parsed.config,
    saved: [saved],
    deployTarget: PLATFORM,
    context: { previous: parsed.config },
  });
  if (!outcome.ok) {
    throw new Error(outcome.refusals.map((r) => r.message).join('; '));
  }
  return outcome.steps.filter(
    (step) => 'configName' in step && step.configName === 'web',
  );
}

const HEALTH: DockerSettings = {
  HealthCheck: {
    Test: ['CMD', 'curl', '-f', 'http://localhost:3000/health'],
    Interval: 10_000_000_000,
    Retries: 5,
  },
};

describe('rewriteEntry native.docker', () => {
  it('writes a health check saved in the console into native.docker, keeping the comments, and the next plan finds nothing', () => {
    const before = savedWeb('web');
    const stored = textOf(before).replace(
      '  web:',
      '  # the storefront\n  web:',
    );
    const after = savedWeb('web', HEALTH);

    const text = save(stored, before, after);

    expect(text).not.toBeNull();
    expect(text).toContain('# the storefront\n  web:');
    expect(entry(text!).native).toEqual({ docker: HEALTH });
    expect(planned(text!, after)).toEqual([]);
  });

  it('rewrites only the setting the Save changed, keeping the others as written', () => {
    const written = {
      ...HEALTH,
      Labels: { 'com.example.team': 'payments' },
    };
    const before = savedWeb('web', written);
    const stored = withNative(
      textOf(savedWeb('web')),
      `native:
  docker:
    # who to page
    Labels:
      com.example.team: payments
    HealthCheck:
      Test: [CMD, curl, -f, http://localhost:3000/health]
      Interval: 10000000000
      Retries: 5`,
    );
    expect(planned(stored, before)).toEqual([]);
    const after = savedWeb('web', {
      ...written,
      HealthCheck: { ...HEALTH.HealthCheck, Retries: 3 },
      Labels: { 'com.example.team': 'payments', 'com.example.tier': 'gold' },
    });

    const text = save(stored, before, after)!;

    expect(text).toContain('# who to page');
    expect(text).toContain(
      'Test: [ CMD, curl, -f, http://localhost:3000/health ]',
    );
    expect(entry(text).native).toEqual({
      docker: {
        Labels: { 'com.example.team': 'payments', 'com.example.tier': 'gold' },
        HealthCheck: { ...HEALTH.HealthCheck, Retries: 3 },
      },
    });
    expect(planned(text, after)).toEqual([]);
  });

  it('removes a setting put back to the kind’s default rather than writing the default', () => {
    const before = savedWeb('web', {
      StopGracePeriod: 20_000_000_000,
      UpdateConfig: { Parallelism: 1, Order: 'start-first', Delay: 5 },
    });
    const stored = withNative(
      textOf(savedWeb('web')),
      `native:
  docker:
    StopGracePeriod: 20000000000
    UpdateConfig:
      Delay: 5`,
    );
    // The console stores Docker's defaults in full: an update with its
    // parallelism and order, and no grace period.
    const after = savedWeb('web', {
      UpdateConfig: { Parallelism: 1, Order: 'start-first', Delay: 5 },
    });

    const text = save(stored, before, after)!;

    expect(entry(text).native).toEqual({
      docker: { UpdateConfig: { Delay: 5 } },
    });
    expect(planned(text, after)).toEqual([]);

    const cleared = save(text, after, savedWeb('web'))!;
    expect(entry(cleared)).not.toHaveProperty('native');
    expect(planned(cleared, savedWeb('web'))).toEqual([]);
  });

  it('writes an update order set to the default as nothing at all', () => {
    const before = savedWeb('web');
    const after = savedWeb('web', {
      UpdateConfig: {
        Parallelism: 1,
        Order: 'start-first',
        FailureAction: 'rollback',
      },
    });

    expect(save(textOf(before), before, after)).toBeNull();
  });

  it('leaves a console-managed entry as it is', () => {
    const stored =
      'version: 1\nservices:\n  web:\n    kind: web\n    managed: console\n';

    expect(save(stored, savedWeb('web'), savedWeb('web', HEALTH))).toBeNull();
  });
});

/**
 * A cron's file takes Labels, StopGracePeriod and Ulimits alone, so a
 * console Save rewrites those and never a key a cron refuses, and only they
 * are the file's on a repository-kept config.
 */
describe('rewriteEntry native.docker on a Cron service', () => {
  const LABELS: DockerSettings = { Labels: { 'com.example.team': 'billing' } };

  it('writes a cron’s labels saved in the console into native.docker, and the next plan finds nothing', () => {
    const before = savedWeb('web', undefined, 'cron');
    const after = savedWeb('web', LABELS, 'cron');

    const text = save(textOf(before), before, after)!;

    expect(entry(text).native).toEqual({ docker: LABELS });
    expect(planned(text, after)).toEqual([]);
  });

  it('never writes a key a cron refuses that a row stored before the rule holds', () => {
    const before = savedWeb('web', HEALTH, 'cron');
    const after = savedWeb('web', { ...HEALTH, ...LABELS }, 'cron');

    const text = save(textOf(before), before, after)!;

    expect(entry(text).native).toEqual({ docker: LABELS });
    expect(text).not.toContain('HealthCheck');
    expect(planned(text, after)).toEqual([]);
  });

  it('finds only a moved open key the file’s, as a repository-kept config refuses it', () => {
    const before = savedWeb('web', undefined, 'cron');
    const parsed = parseProjectConfig(textOf(before));
    if (!parsed.ok) throw new Error(parsed.refusal.message);

    expect(
      movedFields(
        parsed.config,
        'web',
        PLATFORM,
        before,
        savedWeb('web', HEALTH, 'cron'),
      ),
    ).toEqual([]);
    expect(
      movedFields(
        parsed.config,
        'web',
        PLATFORM,
        before,
        savedWeb('web', LABELS, 'cron'),
      ),
    ).toEqual(['native.docker.Labels."com.example.team"']);
  });
});
