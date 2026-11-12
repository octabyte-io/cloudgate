import { describe, expect, it } from 'vitest';

import { runningBuildVerdict, sourceVerdict } from '../src/deploy-guards.js';
import type { BuildRow } from '../src/deploy-guards.js';

/**
 * The rules `cloudgate deploy` checks before it uploads (deploy steps 5
 * and 10): when a source switch is refused, asked about or let through,
 * and when a build in progress is waited for. Which kinds take an upload is
 * `kindRefusal`'s, in `service-status.test.ts`. The wording is the spec's;
 * the e2e walk checks a few of these against a real Instance.
 */

describe('sourceVerdict', () => {
  const github = {
    type: 'git' as const,
    provider: 'github',
    repository: 'octabyte-io/shop',
  };
  const base = {
    configName: 'api',
    source: github,
    configRepository: null,
    switchSource: false,
    canAsk: false,
  };

  it('asks nothing for a Service already on uploaded files', () => {
    expect(sourceVerdict({ ...base, source: { type: 'uploaded' } })).toEqual({
      kind: 'go',
    });
  });

  it('asks nothing for a new Service that has no source yet', () => {
    expect(
      sourceVerdict({
        ...base,
        source: { type: 'git', provider: 'github', repository: null },
      }),
    ).toEqual({ kind: 'go' });
    expect(
      sourceVerdict({ ...base, source: { type: 'image', image: null } }),
    ).toEqual({ kind: 'go' });
    expect(sourceVerdict({ ...base, source: null })).toEqual({ kind: 'go' });
  });

  it('in a terminal, asks once, showing the current source', () => {
    expect(sourceVerdict({ ...base, canAsk: true })).toEqual({
      kind: 'ask',
      question:
        'api builds from github octabyte-io/shop. Deploying this folder switches it to uploaded files. Continue?',
    });
    expect(
      sourceVerdict({
        ...base,
        canAsk: true,
        source: { type: 'image', image: 'nginx:1.27' },
      }),
    ).toMatchObject({
      question:
        'api runs image nginx:1.27. Deploying this folder switches it to uploaded files. Continue?',
    });
    expect(
      sourceVerdict({
        ...base,
        canAsk: true,
        source: { type: 'git', provider: 'git', repository: null },
      }),
    ).toMatchObject({
      question:
        'api builds from a git repository. Deploying this folder switches it to uploaded files. Continue?',
    });
  });

  it('with no terminal, refuses with exit 2 naming --switch-source', () => {
    const verdict = sourceVerdict(base);
    expect(verdict.kind).toBe('refuse');
    if (verdict.kind !== 'refuse') return;
    expect(verdict.error.exitCode).toBe(2);
    expect(verdict.error.message).toBe(
      'api builds from github octabyte-io/shop, and deploying this folder switches it to uploaded files',
    );
    expect(verdict.error.hint).toBe('Pass --switch-source to switch it.');
  });

  it('--switch-source is the yes, with or without a terminal', () => {
    expect(sourceVerdict({ ...base, switchSource: true })).toEqual({
      kind: 'go',
    });
    expect(
      sourceVerdict({ ...base, switchSource: true, canAsk: true }),
    ).toEqual({ kind: 'go' });
  });

  it('refuses every time when the Project config kept in a repository names a repository for the Service, --switch-source or not', () => {
    for (const asked of [
      { switchSource: false, canAsk: false },
      { switchSource: true, canAsk: true },
      { switchSource: false, canAsk: true },
    ]) {
      const verdict = sourceVerdict({
        ...base,
        ...asked,
        // The file can name one even while the row is already uploaded.
        source: { type: 'uploaded' },
        configRepository: {
          keptIn: 'repository',
          provider: 'github',
          repository: 'octabyte-io/shop',
        },
      });
      expect(verdict.kind).toBe('refuse');
      if (verdict.kind !== 'refuse') continue;
      expect(verdict.error.exitCode).toBe(1);
      expect(verdict.error.message).toBe(
        "the Project config names github octabyte-io/shop as api's source, and it is kept in a repository, so its next plan would undo an upload",
      );
      expect(verdict.error.hint).toBe(
        'List api as managed: console in the Project config first, then deploy again.',
      );
    }
  });

  it('refuses every time when the Project config kept in a repository could not be read, rather than upload past it unseen', () => {
    for (const asked of [
      { switchSource: false, canAsk: false },
      { switchSource: true, canAsk: true },
    ]) {
      const verdict = sourceVerdict({
        ...base,
        ...asked,
        source: { type: 'uploaded' },
        configRepository: { keptIn: 'repository', readable: false },
      });
      expect(verdict.kind).toBe('refuse');
      if (verdict.kind !== 'refuse') continue;
      expect(verdict.error.exitCode).toBe(1);
      expect(verdict.error.message).toBe(
        "the Project config is kept in a repository and could not be read, so whether it names api's source is not known",
      );
      expect(verdict.error.hint).toBe(
        "Fix the Project config, or the Instance's access to its repository, then deploy again.",
      );
    }
  });

  it('treats a Cloudgate-kept config naming the repository as the git source it is: the upload rewrites that entry', () => {
    const cloudgateKept = {
      ...base,
      configRepository: {
        keptIn: 'cloudgate' as const,
        provider: 'github',
        repository: 'octabyte-io/shop',
      },
    };
    expect(sourceVerdict({ ...cloudgateKept, canAsk: true })).toMatchObject({
      kind: 'ask',
    });
    expect(sourceVerdict({ ...cloudgateKept, switchSource: true })).toEqual({
      kind: 'go',
    });
    expect(sourceVerdict(cloudgateKept)).toMatchObject({
      kind: 'refuse',
      error: { exitCode: 2 },
    });
  });
});

describe('runningBuildVerdict', () => {
  const now = new Date('2026-11-03T12:00:00.000Z');
  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000).toISOString();
  const row = (
    deploymentId: string,
    status: string,
    minutes: number,
    extra: Partial<BuildRow> = {},
  ): BuildRow => ({
    deploymentId,
    status,
    createdAt: minutesAgo(minutes),
    applicationId: 'svc_1',
    previewDeploymentId: null,
    cronRun: null,
    ...extra,
  });

  it('goes ahead with nothing to say when no build is in progress', () => {
    expect(runningBuildVerdict('svc_1', [], now)).toEqual({
      kind: 'go',
      warnings: [],
    });
    expect(
      runningBuildVerdict(
        'svc_1',
        [
          row('d3', 'done', 1),
          row('d2', 'error', 3),
          row('d1', 'cancelled', 9),
        ],
        now,
      ),
    ).toEqual({ kind: 'go', warnings: [] });
  });

  it.each(['pending', 'running'])('waits for a %s build', (status) => {
    expect(
      runningBuildVerdict(
        'svc_1',
        [row('d2', status, 3), row('d1', 'done', 30)],
        now,
      ),
    ).toEqual({ kind: 'wait', deploymentId: 'd2' });
  });

  it('waits for the running build before a pending one queued behind it', () => {
    expect(
      runningBuildVerdict(
        'svc_1',
        [row('d3', 'pending', 1), row('d2', 'running', 4)],
        now,
      ),
    ).toEqual({ kind: 'wait', deploymentId: 'd2' });
  });

  it('still waits at exactly 60 minutes', () => {
    expect(
      runningBuildVerdict('svc_1', [row('d1', 'running', 60)], now),
    ).toEqual({ kind: 'wait', deploymentId: 'd1' });
  });

  it('goes ahead with a warning past a build pending or running for more than 60 minutes', () => {
    expect(
      runningBuildVerdict('svc_1', [row('d1', 'running', 75)], now),
    ).toEqual({
      kind: 'go',
      warnings: [
        'Warning: Deployment d1 has been running for 1h 15m; deploying without waiting for it.',
      ],
    });
    expect(
      runningBuildVerdict('svc_1', [row('d1', 'pending', 61)], now),
    ).toEqual({
      kind: 'go',
      warnings: [
        'Warning: Deployment d1 has been pending for 1h 1m; deploying without waiting for it.',
      ],
    });
  });

  it('goes ahead with a warning past a held build', () => {
    expect(runningBuildVerdict('svc_1', [row('d1', 'held', 2)], now)).toEqual({
      kind: 'go',
      warnings: [
        'Warning: Deployment d1 is held by a plan; deploying without waiting for it.',
      ],
    });
  });

  it('waits for a fresh build even when a stuck one is also in progress', () => {
    expect(
      runningBuildVerdict(
        'svc_1',
        [row('d2', 'pending', 2), row('d1', 'running', 90)],
        now,
      ),
    ).toEqual({ kind: 'wait', deploymentId: 'd2' });
  });

  it("ignores a preview's builds, a Cron service's runs and another Service's runs listed beside it", () => {
    expect(
      runningBuildVerdict(
        'svc_1',
        [
          row('d3', 'running', 1, { previewDeploymentId: 'prv_1' }),
          row('d2', 'running', 1, { cronRun: { at: 'x' } }),
          row('d1', 'running', 1, { applicationId: null }),
        ],
        now,
      ),
    ).toEqual({ kind: 'go', warnings: [] });
  });
});
