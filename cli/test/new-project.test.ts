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

import type { Prompter } from '../src/prompt.js';
import { run } from '../src/run.js';

/**
 * "Create a new Project" at a first `cloudgate deploy` in a folder with no
 * link, in a terminal (spec #14, ADR-0080), against an Instance `fetch`
 * answers. The harness of the CLI e2e suite has no terminal, so what is
 * asked is held here; what the starter config does on the real backend is
 * that suite's walk (`backend/test/cli/`).
 */

/** The starter config, as a person reads it in the new Project folder. */
const STARTER = `# This Project's config. Cloudgate keeps it; this file is your working copy.
# Add your apps under services, then run cloudgate deploy here: it shows
# the plan, applies it on a yes, and builds each app from its folder.
version: 1
services:
  # An app built from a subfolder of this folder names it as its source:
  # web:
  #   kind: web
  #   source: { folder: apps/web }
`;

/** One question asked, and the default it offered. */
interface Asked {
  question: string;
  choices?: string[];
  default?: number | string;
}

/**
 * A terminal's answers, by question: an index for a pick, a yes/no, or the
 * texts typed, one per time it is asked. A pick with no answer takes the
 * first choice; a text with none takes its default.
 */
function scripted(answers: Record<string, number | boolean | string[]> = {}) {
  const asked: Asked[] = [];
  const typed = new Map<string, number>();
  const prompter: Prompter = {
    choose: (question, choices, options) => {
      asked.push({
        question,
        choices: choices.map((choice) =>
          choice.note ? `${choice.label} (${choice.note})` : choice.label,
        ),
        ...(options?.default !== undefined ? { default: options.default } : {}),
      });
      const answer = answers[question];
      return Promise.resolve(typeof answer === 'number' ? answer : 0);
    },
    confirm: (question) => {
      asked.push({ question });
      return Promise.resolve(answers[question] !== false);
    },
    text: (question, options) => {
      asked.push({
        question,
        ...(options?.default !== undefined ? { default: options.default } : {}),
      });
      const texts = answers[question];
      const count = typed.get(question) ?? 0;
      typed.set(question, count + 1);
      const answer = Array.isArray(texts) ? texts[count] : undefined;
      if (answer !== undefined) return Promise.resolve(answer);
      if (options?.default !== undefined)
        return Promise.resolve(options.default);
      return Promise.reject(new Error(`no answer for ${question}`));
    },
    secret: () => Promise.reject(new Error('asked a secret')),
  };
  return { prompter, asked, questions: () => asked.map((one) => one.question) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SERVERS = [
  {
    serverId: 'srv_build',
    name: 'builder',
    serverType: 'build',
    ipAddress: '203.0.113.9',
    boughtServer: null,
  },
  {
    serverId: 'srv_1',
    name: 'web-1',
    serverType: 'deploy',
    ipAddress: '203.0.113.10',
    boughtServer: null,
  },
  {
    serverId: 'srv_new',
    name: 'web-2',
    serverType: 'deploy',
    ipAddress: '203.0.113.11',
    boughtServer: { stage: 'provisioning' },
  },
];

const CLOUD_ACCOUNTS = [
  {
    cloudAccountId: 'cla_1',
    name: 'Acme AWS',
    cloud: 'aws',
    cloudId: '123456789012',
  },
];

interface Options {
  /** `GET /servers`, or the status it is refused with. */
  servers?: unknown[] | number;
  /** `GET /cloud-accounts`, or the status it is refused with. */
  cloudAccounts?: unknown[] | number;
  /** Names `POST /projects` refuses as taken. */
  taken?: string[];
  /** `POST /projects` refused with this, before anything is made. */
  projectRefusal?: Response;
  /** `POST /environments` refused with this. */
  environmentRefusal?: Response;
  /** `POST /projects/:id/config/plans` refused with this. */
  plansRefusal?: Response;
  terminal: Prompter;
}

let root: string;
let folder: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cloudgate-new-project-'));
  folder = join(root, 'storefront');
  mkdirSync(folder);
  writeFileSync(join(folder, 'package.json'), '{}');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The Instance's state across runs: what was made, and the config. */
function instance() {
  const made = {
    projects: [] as unknown[],
    environments: [] as unknown[],
    plans: [] as unknown[],
    uploads: 0,
    deployments: 0,
  };
  let configText = 'version: 1\nservices: {}\n';
  let configVersion = 1;
  const projects = [{ projectId: 'prj_old', name: 'shop' }];
  const environments: { environmentId: string; name: string }[] = [];

  async function deploy(options: Options) {
    const out = { stdout: '', stderr: '' };
    const respond = (url: string, init: RequestInit): Response => {
      const path = url.replace('https://cloud.acme.dev/backend', '');
      const method = init.method ?? 'GET';
      const body = () => JSON.parse(init.body as string) as unknown;
      if (path === '/settings/about') {
        return json({
          product: 'cloudgate',
          version: '0.2.0',
          apiUrl: 'https://api.cloud.acme.dev',
        });
      }
      if (path === '/organizations')
        return json([{ id: 'org_1', name: 'Shop Inc' }]);
      if (path === '/projects' && method === 'GET') return json(projects);
      if (path === '/projects' && method === 'POST') {
        const { name } = body() as { name: string };
        if (options.projectRefusal) return options.projectRefusal;
        if (options.taken?.includes(name)) {
          return json(
            {
              statusCode: 409,
              message:
                'A Project with this name already exists in your organization',
            },
            409,
          );
        }
        made.projects.push(body());
        projects.push({ projectId: 'prj_new', name });
        return json({ projectId: 'prj_new', name, env: 'SECRET=1' }, 201);
      }
      if (path === '/servers') {
        const servers = options.servers ?? SERVERS;
        return typeof servers === 'number'
          ? json({ statusCode: servers, message: 'refused' }, servers)
          : json(servers);
      }
      if (path === '/cloud-accounts') {
        const accounts = options.cloudAccounts ?? CLOUD_ACCOUNTS;
        return typeof accounts === 'number'
          ? json({ statusCode: accounts, message: 'refused' }, accounts)
          : json(accounts);
      }
      if (path === '/environments' && method === 'POST') {
        if (options.environmentRefusal) return options.environmentRefusal;
        made.environments.push(body());
        environments.push({ environmentId: 'env_new', name: 'production' });
        return json(
          {
            environmentId: 'env_new',
            name: 'production',
            projectId: 'prj_new',
            warnings: [],
          },
          201,
        );
      }
      if (path === '/environments?projectId=prj_new') return json(environments);
      if (path === '/projects/prj_new/config' && method === 'GET') {
        return json({
          projectId: 'prj_new',
          location: {
            kind: 'cloudgate',
            text: configText,
            version: configVersion,
          },
        });
      }
      if (path === '/projects/prj_new/config/plans' && method === 'POST') {
        if (options.plansRefusal) return options.plansRefusal;
        made.plans.push(body());
        // The new Environment has nothing in it, and the text no app.
        configText = (body() as { text: string }).text;
        configVersion += 1;
        return json(
          {
            stored: true,
            plans: environments.map((one) => ({
              planId: 'pln_1',
              environmentId: one.environmentId,
              status: 'unchanged',
              steps: [],
              notes: [],
              results: null,
            })),
          },
          201,
        );
      }
      if (path === '/environments/env_new/config/sources') {
        return json({ keptIn: 'cloudgate', readable: true, services: [] });
      }
      if (/\/drop/.test(path)) made.uploads += 1;
      if (/\/deployments$/.test(path) && method === 'POST')
        made.deployments += 1;
      return new Response(null, { status: 599 });
    };
    const code = await run({
      argv: ['deploy'],
      env: { CLOUDGATE_KEY: 'cg_secret', CLOUDGATE_INSTANCE: 'cloud.acme.dev' },
      cwd: folder,
      prompter: options.terminal,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stderrIsTTY: true,
      stdout: (text) => (out.stdout += text),
      stderr: (text) => (out.stderr += text),
      fetch: (input, init) =>
        Promise.resolve(respond(input as string, init ?? {})),
      openSocket: () => {
        throw new Error('opened a log stream');
      },
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
      interrupts: { listen: () => () => undefined },
      now: () => new Date('2026-11-13T12:00:00Z'),
    });
    return { code, ...out };
  }

  return { deploy, made };
}

/** Picks "Create a new Project", the last choice after Project shop. */
const CREATE = { Project: 1 };

describe('createProjectHere', () => {
  it('asks the name, defaulting to the folder’s, and once where its apps run; creates the Project, Environment production on that Server and the starter config, and links the folder as its Project folder', async () => {
    const shop = instance();
    const terminal = scripted(CREATE);

    const result = await shop.deploy({ terminal: terminal.prompter });

    expect(result.stderr).not.toContain('Error');
    expect(result.code).toBe(0);
    expect(terminal.asked).toEqual([
      { question: 'Project', choices: ['shop', 'Create a new Project'] },
      { question: 'Project name', default: 'storefront' },
      {
        question: 'Where do its apps run?',
        // Only deploy Servers that are ready, then Cloud accounts.
        choices: ['web-1 (203.0.113.10)', 'Acme AWS (AWS 123456789012)'],
      },
    ]);
    expect(shop.made.projects).toEqual([{ name: 'storefront' }]);
    expect(shop.made.environments).toEqual([
      {
        name: 'production',
        projectId: 'prj_new',
        deployTarget: { kind: 'server', serverId: 'srv_1' },
      },
    ]);
    expect(shop.made.plans).toEqual([{ text: STARTER, version: 1 }]);
    expect(readFileSync(join(folder, 'cloudgate.yaml'), 'utf8')).toBe(STARTER);
    expect(
      JSON.parse(readFileSync(join(folder, '.cloudgate', 'link.json'), 'utf8')),
    ).toEqual({
      instance: 'https://cloud.acme.dev',
      organizationId: 'org_1',
      projectId: 'prj_new',
      environmentId: 'env_new',
      names: {
        organization: 'Shop Inc',
        project: 'storefront',
        environment: 'production',
      },
      workingCopy: {
        version: 2,
        sha256: createHash('sha256').update(STARTER).digest('hex'),
      },
    });
    expect(readFileSync(join(folder, '.gitignore'), 'utf8')).toBe(
      '.cloudgate/\n/cloudgate.yaml\n',
    );
    // A terminal's spinners sit between the lines; each line is whole.
    const lines = [
      '✓ Created Project storefront, its Environment production deploying to web-1',
      '✓ Linked ./ to the whole Project storefront, production by default, on cloud.acme.dev',
      '✓ Saved the Project config, version 2, as cloudgate.yaml',
      'Add your apps to cloudgate.yaml, then run cloudgate deploy again.',
    ];
    for (const line of lines) expect(result.stderr).toContain(`${line}\n`);
    expect(
      lines
        .map((line) => result.stderr.indexOf(line))
        .every((at, index, all) => index === 0 || at > all[index - 1]),
    ).toBe(true);
    expect(shop.made.uploads).toBe(0);
    expect(shop.made.deployments).toBe(0);
  });

  it('asks the region of a Cloud account it is given', async () => {
    const shop = instance();
    const terminal = scripted({
      ...CREATE,
      'Where do its apps run?': 1,
      'Region in Acme AWS (such as us-east-1)': ['eu-west-1'],
    });

    const result = await shop.deploy({ terminal: terminal.prompter });

    expect(result.code).toBe(0);
    expect(terminal.questions()).toEqual([
      'Project',
      'Project name',
      'Where do its apps run?',
      'Region in Acme AWS (such as us-east-1)',
    ]);
    expect(shop.made.environments).toEqual([
      {
        name: 'production',
        projectId: 'prj_new',
        deployTarget: {
          kind: 'cloud',
          cloudAccountId: 'cla_1',
          region: 'eu-west-1',
        },
      },
    ]);
    expect(result.stderr).toContain(
      '✓ Created Project storefront, its Environment production deploying to Acme AWS in eu-west-1\n',
    );
  });

  it('asks the name again when one is already used in the Organization, keeping where its apps run', async () => {
    const shop = instance();
    const terminal = scripted({
      ...CREATE,
      'Project name': ['shop', 'storefront'],
    });

    const result = await shop.deploy({
      terminal: terminal.prompter,
      taken: ['shop'],
    });

    expect(result.code).toBe(0);
    expect(terminal.asked).toEqual([
      { question: 'Project', choices: ['shop', 'Create a new Project'] },
      { question: 'Project name', default: 'storefront' },
      {
        question: 'Where do its apps run?',
        choices: ['web-1 (203.0.113.10)', 'Acme AWS (AWS 123456789012)'],
      },
      { question: 'Project name' },
    ]);
    expect(result.stderr).toContain(
      'A Project named shop is already in Shop Inc. Choose another name.\n',
    );
    expect(shop.made.projects).toEqual([{ name: 'storefront' }]);
  });

  it('refuses a caller without project: create, naming the statement, and makes nothing', async () => {
    const shop = instance();
    const terminal = scripted(CREATE);

    const result = await shop.deploy({
      terminal: terminal.prompter,
      // The role's own refusal, which names no statement and has no code.
      projectRefusal: json(
        {
          statusCode: 403,
          message: 'unauthorized to access resource "project"',
        },
        403,
      ),
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Error: creating a Project needs the project: create statement, which your role in Shop Inc does not have; nothing was created\nAsk an owner of Shop Inc for a role that has it.\n',
    );
    expect(shop.made.environments).toEqual([]);
    expect(existsSync(join(folder, '.cloudgate'))).toBe(false);
    expect(existsSync(join(folder, 'cloudgate.yaml'))).toBe(false);
  });

  it('with no Server or Cloud account to pick, refuses before asking anything else or creating anything, pointing to the console', async () => {
    const shop = instance();
    const terminal = scripted(CREATE);

    const result = await shop.deploy({
      terminal: terminal.prompter,
      // Only a build Server and one not ready; Cloud accounts not readable.
      servers: [SERVERS[0], SERVERS[2]],
      cloudAccounts: 403,
    });

    expect(result.code).toBe(1);
    expect(terminal.questions()).toEqual(['Project']);
    expect(result.stderr).toContain(
      'Error: Shop Inc has no Server or Cloud account a new Project can deploy to; nothing was created\nAdd a Server at https://cloud.acme.dev/servers or connect a Cloud account at https://cloud.acme.dev/settings/cloud-accounts, then run cloudgate deploy here again.\n',
    );
    expect(shop.made.projects).toEqual([]);
    expect(existsSync(join(folder, '.cloudgate'))).toBe(false);
  });

  it('when the Environment cannot be made, says the Project exists and how to finish or remove it', async () => {
    const shop = instance();
    const terminal = scripted({
      ...CREATE,
      'Where do its apps run?': 1,
      'Region in Acme AWS (such as us-east-1)': ['eu-west-9'],
    });

    const result = await shop.deploy({
      terminal: terminal.prompter,
      environmentRefusal: json(
        {
          statusCode: 400,
          message: 'eu-west-9 is not an AWS region Cloudgate deploys to',
        },
        400,
      ),
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Error: Project storefront was created, but not its Environment production: eu-west-9 is not an AWS region Cloudgate deploys to\nAdd an Environment to it at https://cloud.acme.dev/projects/prj_new and run cloudgate link --whole-project here, or delete it at https://cloud.acme.dev/projects/prj_new/settings.\n',
    );
    expect(existsSync(join(folder, '.cloudgate'))).toBe(false);
    expect(existsSync(join(folder, 'cloudgate.yaml'))).toBe(false);
  });

  it('when the starter config cannot be stored, says the Project and its Environment exist and how to finish or remove them', async () => {
    const shop = instance();
    const terminal = scripted(CREATE);

    const result = await shop.deploy({
      terminal: terminal.prompter,
      plansRefusal: json({ statusCode: 500, message: 'database gone' }, 500),
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Error: Project storefront and its Environment production were created, but this folder was not linked to them: database gone\nRun cloudgate link --whole-project --project storefront here to finish, or delete the Project at https://cloud.acme.dev/projects/prj_new/settings.\n',
    );
    expect(existsSync(join(folder, '.cloudgate'))).toBe(false);
  });

  it('asks before replacing a cloudgate.yaml already here, and creates nothing when told no', async () => {
    writeFileSync(join(folder, 'cloudgate.yaml'), 'version: 1\n# mine\n');
    const shop = instance();
    const replace =
      'cloudgate.yaml is already here. Replace it with a starter for the new Project?';
    const terminal = scripted({ ...CREATE, [replace]: false });

    const result = await shop.deploy({ terminal: terminal.prompter });

    expect(result.code).toBe(1);
    expect(terminal.questions()).toEqual(['Project', replace]);
    expect(result.stderr).toContain(
      'Kept cloudgate.yaml. No Project was created.\n',
    );
    expect(shop.made.projects).toEqual([]);
    expect(readFileSync(join(folder, 'cloudgate.yaml'), 'utf8')).toBe(
      'version: 1\n# mine\n',
    );
  });

  it('replaces a cloudgate.yaml already here with the starter on a yes', async () => {
    writeFileSync(join(folder, 'cloudgate.yaml'), 'version: 1\n# mine\n');
    const shop = instance();
    const terminal = scripted(CREATE);

    const result = await shop.deploy({ terminal: terminal.prompter });

    expect(result.code).toBe(0);
    expect(readFileSync(join(folder, 'cloudgate.yaml'), 'utf8')).toBe(STARTER);
    // Asked once, before anything was made; not again when linking.
    expect(
      terminal.questions().filter((one) => one.includes('cloudgate.yaml')),
    ).toHaveLength(1);
  });

  it('a deploy with the starter unchanged plans nothing and builds nothing', async () => {
    const shop = instance();
    await shop.deploy({ terminal: scripted(CREATE).prompter });

    const again = await shop.deploy({ terminal: scripted().prompter });

    expect(again.stderr).not.toContain('Error');
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('production: no changes\n');
    expect(again.stderr).toContain('Nothing to change.\n');
    expect(again.stderr).toContain(
      'No app in the Project config is built from this folder.\n',
    );
    expect(shop.made.projects).toHaveLength(1);
    expect(shop.made.uploads).toBe(0);
    expect(shop.made.deployments).toBe(0);
  });
});
