import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeLink } from '../src/folder-link.js';
import type { FolderLink } from '../src/folder-link.js';
import { run } from '../src/run.js';

/**
 * A **Project folder** (ADR-0080) driven as whole runs, the way
 * `status.test.ts` drives a command, against an Instance that `fetch` stands
 * in for: what a terminal is asked. What the built CLI does against a real
 * Instance, with no terminal, is the CLI e2e suite's walk.
 */

const instance = 'https://cloud.acme.dev';
const now = new Date('2026-11-03T12:00:00Z');

const DOWNLOADED = 'version: 1\nservices: {}\n';
const CURRENT =
  'version: 1\nservices:\n  web:\n    kind: web\n    source:\n      folder: apps/web\n';

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

const rootLink: FolderLink = {
  instance,
  organizationId: 'org_1',
  projectId: 'prj_1',
  environmentId: 'env_s',
  workingCopy: { version: 3, sha256: sha256(DOWNLOADED) },
  names: { organization: 'Shop Inc', project: 'shop', environment: 'staging' },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const routes: Record<string, unknown> = {
  '/settings/about': {
    product: 'cloudgate',
    version: '9.9.9',
    apiUrl: 'https://api.cloud.acme.dev',
  },
  '/organizations': [{ id: 'org_1', name: 'Shop Inc' }],
  '/projects': [{ projectId: 'prj_1', name: 'shop' }],
  '/environments?projectId=prj_1': [
    { environmentId: 'env_s', name: 'staging' },
  ],
  '/environments/env_s': {
    environmentId: 'env_s',
    name: 'staging',
    services: [
      {
        serviceType: 'application',
        serviceId: 'app_1',
        name: 'Shop web',
        configName: 'web',
      },
    ],
  },
  '/projects/prj_1/config': {
    projectId: 'prj_1',
    location: {
      kind: 'cloudgate',
      text: CURRENT,
      textHash: 'x',
      version: 5,
      updatedAt: now.toISOString(),
      movedOutOf: null,
    },
  },
  '/applications/app_1': {
    applicationId: 'app_1',
    name: 'Shop web',
    applicationStatus: 'idle',
    sourceType: 'drop',
  },
  '/applications/app_1/domains': [],
  '/applications/app_1/deployments': [],
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cloudgate-project-folder-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** One run in `cwd`, in a terminal that answers `answers` in order. */
async function inTerminal(
  argv: string[],
  answers: { choose?: number[]; confirm?: boolean[] } = {},
  cwd = root,
) {
  const out = { stdout: '', stderr: '' };
  const asked: string[] = [];
  const choose = [...(answers.choose ?? [])];
  const confirm = [...(answers.confirm ?? [])];
  const code = await run({
    argv,
    env: { CLOUDGATE_KEY: 'cg_secret', CLOUDGATE_INSTANCE: instance },
    cwd,
    prompter: {
      choose: (question, choices) => {
        asked.push(`${question}: ${choices.map((c) => c.label).join(', ')}`);
        const answer = choose.shift();
        return answer === undefined
          ? Promise.reject(new Error(`asked ${question}`))
          : Promise.resolve(answer);
      },
      confirm: (question) => {
        asked.push(question);
        const answer = confirm.shift();
        return answer === undefined
          ? Promise.reject(new Error(`asked ${question}`))
          : Promise.resolve(answer);
      },
      secret: () => Promise.reject(new Error('asked a secret')),
      text: () => Promise.reject(new Error('asked a question')),
    },
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderrIsTTY: true,
    stdout: (text) => (out.stdout += text),
    stderr: (text) => (out.stderr += text),
    fetch: (input) => {
      const path = (input as string).slice(`${instance}/backend`.length);
      const body = routes[path];
      return Promise.resolve(
        body === undefined
          ? json({ statusCode: 404, message: 'Not found' }, 404)
          : json(body),
      );
    },
    now: () => now,
  });
  return { code, ...out, asked };
}

const savedLink = () =>
  JSON.parse(
    readFileSync(join(root, '.cloudgate', 'link.json'), 'utf8'),
  ) as FolderLink;

describe('config pull', () => {
  it('replaces an unedited copy and the recorded version without asking', async () => {
    writeLink(root, rootLink);
    writeFileSync(join(root, 'cloudgate.yaml'), DOWNLOADED);

    const result = await inTerminal(['config', 'pull']);

    expect(result.code).toBe(0);
    expect(result.asked).toEqual([]);
    expect(readFileSync(join(root, 'cloudgate.yaml'), 'utf8')).toBe(CURRENT);
    expect(savedLink().workingCopy).toEqual({
      version: 5,
      sha256: sha256(CURRENT),
    });
  });

  it('asks before replacing an edited copy, and keeps it on no', async () => {
    writeLink(root, rootLink);
    writeFileSync(join(root, 'cloudgate.yaml'), `${DOWNLOADED}# mine\n`);

    const result = await inTerminal(['config', 'pull'], { confirm: [false] });

    expect(result.code).toBe(0);
    expect(result.asked).toEqual([
      'cloudgate.yaml has edits not sent to Cloudgate. Replace them with the Project config, version 5?',
    ]);
    expect(readFileSync(join(root, 'cloudgate.yaml'), 'utf8')).toBe(
      `${DOWNLOADED}# mine\n`,
    );
    expect(savedLink().workingCopy?.version).toBe(3);
  });

  it('replaces an edited copy on yes', async () => {
    writeLink(root, rootLink);
    writeFileSync(join(root, 'cloudgate.yaml'), `${DOWNLOADED}# mine\n`);

    const result = await inTerminal(['config', 'pull'], { confirm: [true] });

    expect(result.code).toBe(0);
    expect(readFileSync(join(root, 'cloudgate.yaml'), 'utf8')).toBe(CURRENT);
    expect(savedLink().workingCopy?.version).toBe(5);
  });

  it('writes the copy at the Project folder, from a subfolder of it', async () => {
    writeLink(root, rootLink);
    const sub = join(root, 'apps', 'web');
    mkdirSync(sub, { recursive: true });

    const result = await inTerminal(['config', 'pull'], {}, sub);

    expect(result.code).toBe(0);
    expect(readFileSync(join(root, 'cloudgate.yaml'), 'utf8')).toBe(CURRENT);
    expect(existsSync(join(sub, 'cloudgate.yaml'))).toBe(false);
  });

  it('refuses in a folder linked to one Service, exit 2', async () => {
    writeLink(root, {
      instance,
      organizationId: 'org_1',
      projectId: 'prj_1',
      environmentId: 'env_s',
      serviceConfigName: 'web',
      names: { ...rootLink.names, service: 'web' },
    });

    const result = await inTerminal(['config', 'pull']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      'Error: this folder is linked to the Service web of Project shop, not to a whole Project',
    );
    expect(existsSync(join(root, 'cloudgate.yaml'))).toBe(false);
  });

  it('refuses in a folder with no link, exit 2', async () => {
    const result = await inTerminal(['config', 'pull']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      'Error: this folder is not in a Project folder',
    );
    expect(result.stderr).toContain('cloudgate link --whole-project');
  });
});

describe('link --whole-project', () => {
  it('asks the Organization, Project and Environment, never a Service', async () => {
    const result = await inTerminal(['link', '--whole-project'], {
      choose: [0, 0],
    });

    expect(result.code).toBe(0);
    expect(result.asked).toEqual(['Project: shop', 'Environment: staging']);
    expect(savedLink()).toEqual({
      ...rootLink,
      workingCopy: { version: 5, sha256: sha256(CURRENT) },
    });
  });

  it('asks before replacing a cloudgate.yaml already here, and changes nothing on no', async () => {
    writeFileSync(join(root, 'cloudgate.yaml'), 'mine\n');

    const result = await inTerminal(
      ['link', '--whole-project', '--project', 'shop', '--env', 'staging'],
      { confirm: [false] },
    );

    expect(result.code).toBe(0);
    expect(result.asked).toEqual([
      'cloudgate.yaml has edits not sent to Cloudgate. Replace them with the Project config, version 5?',
    ]);
    expect(readFileSync(join(root, 'cloudgate.yaml'), 'utf8')).toBe('mine\n');
    expect(existsSync(join(root, '.cloudgate'))).toBe(false);
  });

  it('refuses --service with --whole-project, exit 2', async () => {
    const result = await inTerminal([
      'link',
      '--whole-project',
      '--service',
      'web',
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      'Error: --whole-project links no Service, so it takes no --service',
    );
  });
});

describe('in a Project folder', () => {
  it('status asks for the Service the link does not name', async () => {
    writeLink(root, rootLink);

    const result = await inTerminal(['status'], { choose: [0] });

    expect(result.code).toBe(0);
    expect(result.asked).toEqual(['Service: web']);
    expect(result.stdout).toContain('web (Application)');
  });
});
