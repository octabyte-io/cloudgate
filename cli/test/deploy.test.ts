import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SocketLike } from '../src/deployment-log-stream.js';
import { writeLink } from '../src/folder-link.js';
import type { Prompter } from '../src/prompt.js';
import { run } from '../src/run.js';
import { hashText } from '../src/working-copy.js';

/**
 * `cloudgate deploy`, driven as a CI job drives it, against an Instance that
 * `fetch` and the socket double answer. What the built command does against
 * the real backend is the CLI e2e suite's walk (`backend/test/cli/`).
 */

const neverAsked: Prompter = {
  choose: () => Promise.reject(new Error('asked a question')),
  confirm: () => Promise.reject(new Error('asked a question')),
  secret: () => Promise.reject(new Error('asked a question')),
  text: () => Promise.reject(new Error('asked a question')),
};

/** One question a {@link scripted} prompter was asked. */
interface Asked {
  question: string;
  choices?: string[];
  default?: number;
}

/**
 * A terminal's answers, by question: the index picked, or a yes/no. A
 * question it has no answer for picks the first choice, or says yes.
 */
function scripted(answers: Record<string, number | boolean> = {}) {
  const asked: Asked[] = [];
  const prompter: Prompter = {
    choose: (question, choices, options) => {
      asked.push({
        question,
        choices: choices.map((choice) => choice.label),
        ...(options?.default !== undefined ? { default: options.default } : {}),
      });
      const answer = answers[question];
      return Promise.resolve(typeof answer === 'number' ? answer : 0);
    },
    confirm: (question) => {
      asked.push({ question });
      return Promise.resolve(answers[question] !== false);
    },
    secret: () => Promise.reject(new Error('asked a secret')),
    text: () => Promise.reject(new Error('asked for text')),
  };
  return { prompter, asked, questions: () => asked.map((one) => one.question) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const deployment = (status: string, extra: Record<string, unknown> = {}) => ({
  deploymentId: 'dpl_7Hq2Xc',
  status,
  createdAt: '2026-11-03T12:00:00.000Z',
  startedAt: '2026-11-03T12:00:05.000Z',
  finishedAt: null,
  ...extra,
});

/** A log stream that never closes by itself, like `/listen-deployment`. */
function neverClosingSocket(frames: string[]) {
  const opened: { url: string; headers: Record<string, string> }[] = [];
  let closedByCli = false;
  const open = (url: string, headers: Record<string, string>): SocketLike => {
    opened.push({ url, headers });
    const listeners: Record<string, ((event: { data: unknown }) => void)[]> =
      {};
    setImmediate(() => {
      for (const data of frames)
        for (const listener of listeners.message ?? []) listener({ data });
    });
    return {
      addEventListener: (type: string, listener: () => void) => {
        (listeners[type] ??= []).push(listener);
      },
      close: () => {
        closedByCli = true;
      },
    } as SocketLike;
  };
  return { open, opened, closed: () => closedByCli };
}

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cloudgate-deploy-'));
  writeFileSync(join(folder, 'index.js'), 'console.log(1);\n');
  writeFileSync(join(folder, 'package.json'), '{}');
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const TARGET = [
  '--org',
  'Shop Inc',
  '--project',
  'shop',
  '--env',
  'staging',
  '--service',
  'api',
];

interface Options {
  /** What `GET /deployments/:id` answers, one per ask; the last repeats. */
  statuses?: Record<string, unknown>[];
  /** Answers `POST /applications/:id/deployments`. */
  trigger?: () => Response;
  frames?: string[];
  /** Ctrl-C after this many asks of the Deployment. */
  interruptAfter?: number;
  /** What each `GET /applications/app_1/deployments` answers; the last repeats. */
  builds?: Record<string, unknown>[][];
  /** What each upload answers; the last repeats. Accepted by default. */
  uploadAnswers?: (() => Response)[];
  /** `GET /applications/app_1`; a new Application by default. */
  application?: Record<string, unknown>;
  /** Run in a terminal, answering through this. */
  terminal?: Prompter;
  /** `GET /environments/env_1/config/repository-sources`; a Cloudgate-kept config naming none by default. */
  repositorySources?: Record<string, unknown>;
  /** The version `GET /settings/about` reports; `0.2.0` by default. */
  version?: string;
  /**
   * The files on the build host, path to SHA-256, which compare compares the
   * list with and a successful apply replaces with it. Empty by default.
   */
  buildHost?: Record<string, string>;
  /** What each apply answers; the last repeats. Applied by default. */
  applyAnswers?: (() => Response)[];
  /** `GET /projects/prj_1/config`'s location; a Cloudgate-kept config by default. */
  configLocation?: Record<string, unknown>;
  /** Variables beside the key and the Instance. */
  env?: Record<string, string>;
}

/** One `POST /applications/app_1/drop/apply`, as the Instance received it. */
interface Applied {
  files: { path: string; sha256: string }[];
  /** The zip's entry names, from its central directory. */
  zipped: string[];
  dropBuildPath: unknown;
}

/** The entry names of a zip, read from its central directory. */
function zipNames(zip: Buffer): string[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    names.push(zip.toString('utf8', cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

async function listOf(
  form: FormData,
): Promise<{ path: string; sha256: string }[]> {
  return JSON.parse(await (form.get('files') as Blob).text()) as {
    path: string;
    sha256: string;
  }[];
}

async function deploy(argv: string[], options: Options = {}) {
  const out = { stdout: '', stderr: '' };
  const statuses = options.statuses ?? [
    deployment('running'),
    deployment('done', { finishedAt: '2026-11-03T12:01:47.000Z' }),
  ];
  const uploads: FormData[] = [];
  const compares: { path: string; sha256: string }[][] = [];
  const applies: Applied[] = [];
  /** The bytes of each zip the Instance received, full uploads and applies alike. */
  const sent: number[] = [];
  const buildHost = new Map(Object.entries(options.buildHost ?? {}));
  let applied = 0;
  let asked = 0;
  let listed = 0;
  let uploaded = 0;
  let interrupt: (() => void) | undefined;
  const socket = neverClosingSocket(options.frames ?? ['[build] step\n']);
  const respond = async (url: string, init: RequestInit): Promise<Response> => {
    const path = url.replace('https://cloud.acme.dev/backend', '');
    const method = init.method ?? 'GET';
    if (path === '/settings/about') {
      return json({
        product: 'cloudgate',
        version: options.version ?? '0.2.0',
        apiUrl: 'https://api.cloud.acme.dev',
      });
    }
    if (path === '/organizations')
      return json([{ id: 'org_1', name: 'Shop Inc' }]);
    if (path === '/projects')
      return json([{ projectId: 'prj_1', name: 'shop' }]);
    if (path === '/environments?projectId=prj_1')
      return json([{ environmentId: 'env_1', name: 'staging' }]);
    if (path === '/environments/env_1') {
      return json({
        environmentId: 'env_1',
        name: 'staging',
        services: [
          {
            serviceType: 'application',
            serviceId: 'app_1',
            name: 'Shop API',
            configName: 'api',
          },
        ],
      });
    }
    if (path === '/applications/app_1') {
      // A new Application by default: GitHub, no repository chosen yet.
      return json(
        options.application ?? {
          applicationId: 'app_1',
          sourceType: 'github',
          env: 'S=1',
        },
      );
    }
    if (path === '/projects/prj_1/config') {
      return json({
        projectId: 'prj_1',
        location: options.configLocation ?? {
          kind: 'cloudgate',
          text: 'version: 1\n',
          version: 1,
        },
      });
    }
    if (path === '/environments/env_1/config/repository-sources') {
      return json(
        options.repositorySources ?? {
          keptIn: 'cloudgate',
          readable: true,
          services: [],
        },
      );
    }
    if (method === 'GET' && path === '/applications/app_1/deployments') {
      const builds = options.builds ?? [[]];
      const next = builds[Math.min(listed, builds.length - 1)];
      listed += 1;
      return json(next);
    }
    if (method === 'POST' && path === '/applications/app_1/drop') {
      const answers = options.uploadAnswers ?? [];
      const answer = answers[Math.min(uploaded, answers.length - 1)];
      uploaded += 1;
      if (answer) {
        const response = answer();
        if (!response.ok) return response;
      }
      uploads.push(init.body as FormData);
      sent.push(((init.body as FormData).get('zip') as Blob).size);
      return json({ applicationId: 'app_1', sourceType: 'drop', env: 'S=1' });
    }
    if (method === 'POST' && path === '/applications/app_1/drop/compare') {
      const files = await listOf(init.body as FormData);
      compares.push(files);
      const listed = new Set(files.map((file) => file.path));
      return json({
        missing: files
          .filter((file) => buildHost.get(file.path) !== file.sha256)
          .map((file) => file.path),
        unchanged: files.filter(
          (file) => buildHost.get(file.path) === file.sha256,
        ).length,
        deleted: [...buildHost.keys()].filter((path) => !listed.has(path))
          .length,
      });
    }
    if (method === 'POST' && path === '/applications/app_1/drop/apply') {
      const form = init.body as FormData;
      const files = await listOf(form);
      sent.push((form.get('zip') as Blob).size);
      applies.push({
        files,
        zipped: zipNames(
          Buffer.from(await (form.get('zip') as Blob).arrayBuffer()),
        ),
        dropBuildPath: form.get('dropBuildPath'),
      });
      const answers = options.applyAnswers ?? [];
      const answer = answers[Math.min(applied, answers.length - 1)];
      applied += 1;
      if (answer) {
        const response = answer();
        if (!response.ok) return response;
      }
      buildHost.clear();
      for (const file of files) buildHost.set(file.path, file.sha256);
      return json({ applicationId: 'app_1', sourceType: 'drop', env: 'S=1' });
    }
    if (method === 'POST' && path === '/applications/app_1/deployments') {
      return options.trigger?.() ?? json(deployment('pending'), 201);
    }
    if (path === '/deployments/dpl_7Hq2Xc') {
      const next = statuses[Math.min(asked, statuses.length - 1)];
      asked += 1;
      if (asked === options.interruptAfter) interrupt?.();
      return json(next);
    }
    return new Response(null, { status: 599 });
  };
  const code = await run({
    argv: ['deploy', ...argv],
    env: {
      CLOUDGATE_KEY: 'cg_secret',
      CLOUDGATE_INSTANCE: 'cloud.acme.dev',
      ...options.env,
    },
    cwd: folder,
    prompter: options.terminal ?? neverAsked,
    stdinIsTTY: options.terminal !== undefined,
    stdoutIsTTY: options.terminal !== undefined,
    stderrIsTTY: options.terminal !== undefined,
    stdout: (text) => (out.stdout += text),
    stderr: (text) => (out.stderr += text),
    fetch: (input, init) => respond(input as string, init ?? {}),
    openSocket: socket.open,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    interrupts: {
      listen: (listener) => {
        interrupt = listener;
        return () => (interrupt = undefined);
      },
    },
    now: () => new Date('2026-11-03T12:00:00Z'),
  });
  return {
    code,
    ...out,
    uploads,
    compares,
    applies,
    sent,
    buildHost: Object.fromEntries(buildHost),
    socket,
  };
}

describe('cloudgate deploy', () => {
  it('uploads the folder, starts a Deployment, prints its log and exits 0 when it is done', async () => {
    const result = await deploy(TARGET);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      'Deploying ./ to api in staging of Project shop on cloud.acme.dev\n',
    );
    expect(result.stderr).toContain(
      // The bytes the zip sent, not the 18 B of the files in it.
      `Uploading 2 changed files, ${result.sent[0]} B (0 unchanged)…\n`,
    );
    expect(result.stderr).toContain('Deployment dpl_7Hq2Xc queued\n');
    expect(result.stderr).toContain('✓ Deployment dpl_7Hq2Xc done in 1m 42s\n');
    // The log is the data: on stdout.
    expect(result.stdout).toBe('[build] step\n');
    // A new Application's build host holds nothing, so every file is sent,
    // zipped, landing at the build root.
    expect(result.applies).toEqual([
      {
        files: [
          { path: 'index.js', sha256: expect.any(String) as string },
          { path: 'package.json', sha256: expect.any(String) as string },
        ],
        zipped: ['index.js', 'package.json'],
        dropBuildPath: '/',
      },
    ]);
    // The stream was dialled on the API's own origin with the key, and
    // closed once the Deployment was done, though it never closed itself.
    expect(result.socket.opened).toEqual([
      {
        url: 'wss://api.cloud.acme.dev/listen-deployment?deploymentId=dpl_7Hq2Xc',
        headers: expect.objectContaining({
          'x-api-key': 'cg_secret',
          'x-organization-id': 'org_1',
        }) as Record<string, string>,
      },
    ]);
    expect(result.socket.closed()).toBe(true);
  });

  it('exits 1 for a failed Deployment and for a cancelled one', async () => {
    const failed = await deploy(TARGET, {
      statuses: [
        deployment('error', { finishedAt: '2026-11-03T12:00:47.000Z' }),
      ],
    });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(
      'Error: Deployment dpl_7Hq2Xc failed after 42s',
    );

    const cancelled = await deploy(TARGET, {
      statuses: [deployment('cancelled')],
    });
    expect(cancelled.code).toBe(1);
    expect(cancelled.stderr).toContain(
      'Error: Deployment dpl_7Hq2Xc was cancelled',
    );
  });

  it('with --detach, exits 0 once queued, printing the Deployment and where to see it', async () => {
    const result = await deploy([...TARGET, '--detach'], {
      statuses: [deployment('running')],
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      'Deployment  dpl_7Hq2Xc\nStatus      pending\nConsole     https://cloud.acme.dev/applications/app_1/deployments\n',
    );
    expect(result.socket.opened).toEqual([]);
  });

  it('with --detach --json, prints one JSON object and nothing else on stdout', async () => {
    const result = await deploy([...TARGET, '--detach', '--json']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      deploymentId: 'dpl_7Hq2Xc',
      status: 'pending',
      consoleUrl: 'https://cloud.acme.dev/applications/app_1/deployments',
    });
  });

  it('refuses --json without --detach with exit 2, before anything is uploaded', async () => {
    const result = await deploy([...TARGET, '--json']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Error: --json goes with --detach');
    expect(result.uploads).toEqual([]);
  });

  it('on Ctrl-C stops watching only: says how to follow and cancel it, and exits 130', async () => {
    const result = await deploy(TARGET, {
      statuses: [deployment('running')],
      interruptAfter: 2,
    });

    expect(result.code).toBe(130);
    expect(result.stderr).toContain(
      'Stopped watching. The build goes on.\n' +
        '  Follow it:  cloudgate logs --deployment dpl_7Hq2Xc -f\n' +
        '  Cancel it:  https://cloud.acme.dev/applications/app_1/deployments\n',
    );
    expect(result.socket.closed()).toBe(true);
  });

  it('says the files are uploaded when starting the Deployment fails, and exits 1 with the shared 403 hint', async () => {
    const result = await deploy(TARGET, {
      trigger: () =>
        json({ statusCode: 403, message: 'You may not deploy here' }, 403),
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'The files are uploaded, but no Deployment started: run cloudgate deploy again.\n',
    );
    expect(result.stderr).toContain(
      'Error: You may not deploy here\nAsk an owner of Shop Inc for access.\n',
    );
  });

  it('names the .env files and symlinks it leaves out', async () => {
    writeFileSync(join(folder, '.env'), 'SECRET=1');
    writeFileSync(join(folder, '.env.local'), 'SECRET=2');
    writeFileSync(join(folder, '.env.example'), 'SECRET=');
    symlinkSync(join(folder, 'index.js'), join(folder, 'main.js'));

    const result = await deploy([...TARGET, '--detach']);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      'Left out .env and .env.local. Use cloudgate vars set for secrets.\n',
    );
    expect(result.stderr).toContain(
      'Warning: left out main.js, a symlink; an upload keeps no symlinks.\n',
    );
    expect(result.stderr).toContain(
      `Uploading 3 changed files, ${result.sent[0]} B (0 unchanged)…\n`,
    );
  });

  it('uploads [folder] when one is named, saying which', async () => {
    mkdirSync(join(folder, 'dist'));
    writeFileSync(join(folder, 'dist', 'app.js'), '1');

    const result = await deploy(['dist', ...TARGET, '--detach']);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Deploying ./dist/ to api in staging');
    expect(result.stderr).toContain(
      `Uploading 1 changed file, ${result.sent[0]} B (0 unchanged)…\n`,
    );
  });

  it('refuses with exit 1, uploading nothing, when the Project config kept in a repository could not be read', async () => {
    const result = await deploy(TARGET, {
      repositorySources: {
        keptIn: 'repository',
        readable: false,
        services: [],
      },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Error: the Project config is kept in a repository and could not be read',
    );
    expect(result.uploads).toEqual([]);
  });

  describe('a build already in progress', () => {
    const build = (status: string, createdAt = '2026-11-03T11:58:00.000Z') => ({
      deploymentId: 'dpl_before',
      status,
      createdAt,
      applicationId: 'app_1',
      previewDeploymentId: null,
      cronRun: null,
    });

    it('says it is waiting, once, and uploads only after the build has finished', async () => {
      const result = await deploy([...TARGET, '--detach'], {
        builds: [
          [build('pending')],
          [build('running')],
          [build('running')],
          [build('done')],
        ],
      });

      expect(result.code).toBe(0);
      expect(
        result.stderr.match(/waiting for Deployment dpl_before to finish\n/g),
      ).toHaveLength(1);
      expect(result.applies).toHaveLength(1);
    });

    it('waits and uploads again when the upload is refused because a build started meanwhile', async () => {
      const result = await deploy([...TARGET, '--detach'], {
        builds: [[], [build('running')], [build('done')]],
        applyAnswers: [
          () =>
            json(
              {
                statusCode: 409,
                message: 'Deployment dpl_before is running',
                code: 'DEPLOYMENT_IN_PROGRESS',
              },
              409,
            ),
          () => json({}),
        ],
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        'A build started meanwhile.\nwaiting for Deployment dpl_before to finish\n',
      );
      // The refused apply, then a fresh comparison and the apply after the wait.
      expect(result.compares).toHaveLength(2);
      expect(result.applies).toHaveLength(2);
    });

    it('goes ahead with a warning past a build running for more than 60 minutes', async () => {
      const result = await deploy([...TARGET, '--detach'], {
        builds: [[build('running', '2026-11-03T10:30:00.000Z')]],
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        'Warning: Deployment dpl_before has been running for 1h 30m; deploying without waiting for it.\n',
      );
      expect(result.stderr).not.toContain('waiting for Deployment');
      expect(result.applies).toHaveLength(1);
    });
  });

  describe('in a terminal', () => {
    const answering = (confirmed: boolean) => {
      const questions: string[] = [];
      const prompter: Prompter = {
        choose: (question) => {
          questions.push(question);
          return Promise.resolve(0);
        },
        confirm: (question) => {
          questions.push(question);
          return Promise.resolve(confirmed);
        },
        secret: () => Promise.reject(new Error('asked a secret')),
        text: () => Promise.reject(new Error('asked a question')),
      };
      return { prompter, questions };
    };

    it('asks once before switching a git source, and uploads nothing on no', async () => {
      const { prompter, questions } = answering(false);
      const result = await deploy(TARGET, {
        terminal: prompter,
        application: {
          applicationId: 'app_1',
          sourceType: 'github',
          owner: 'octabyte-io',
          repository: 'shop',
        },
      });

      expect(questions).toEqual([
        'api builds from github octabyte-io/shop. Deploying this folder switches it to uploaded files. Continue?',
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Nothing was uploaded.\n');
      expect(result.applies).toEqual([]);
    });

    it('in an unlinked folder, asks which Project, then one app or the whole Project, defaulting to one app, then the Environment and Service; saves a one-Service link and deploys', async () => {
      const terminal = scripted();
      const result = await deploy(['--detach'], {
        terminal: terminal.prompter,
      });

      expect(terminal.asked).toEqual([
        { question: 'Project', choices: ['shop', 'Create a new Project'] },
        {
          question: 'One app or the whole Project?',
          choices: ['One app', 'The whole Project'],
          default: 0,
        },
        { question: 'Environment', choices: ['staging'] },
        { question: 'Service', choices: ['api'] },
      ]);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        '✓ Linked ./ to api in staging of Project shop on cloud.acme.dev\n',
      );
      expect(
        JSON.parse(
          readFileSync(join(folder, '.cloudgate', 'link.json'), 'utf8'),
        ),
      ).toEqual({
        instance: 'https://cloud.acme.dev',
        organizationId: 'org_1',
        projectId: 'prj_1',
        environmentId: 'env_1',
        serviceConfigName: 'api',
        names: {
          organization: 'Shop Inc',
          project: 'shop',
          environment: 'staging',
          service: 'api',
        },
      });
      expect(existsSync(join(folder, 'cloudgate.yaml'))).toBe(false);
      expect(result.applies).toHaveLength(1);
      expect(result.stderr.match(/Using instance/g)).toHaveLength(1);
    });

    it('offers a Project whose config is kept in a repository for one app only, saying why', async () => {
      const terminal = scripted();
      const result = await deploy(['--detach'], {
        terminal: terminal.prompter,
        configLocation: {
          kind: 'repository',
          repository: 'octabyte-io/shop-config',
          path: 'deploy/cloudgate.yaml',
        },
      });

      expect(terminal.questions()).toEqual([
        'Project',
        'Environment',
        'Service',
      ]);
      expect(result.stderr).toContain(
        "Project shop's config is kept in the repository octabyte-io/shop-config at deploy/cloudgate.yaml, so this folder deploys one app of it, not the whole Project.\n",
      );
      expect(result.code).toBe(0);
      expect(result.applies).toHaveLength(1);
    });

    it('with a target flag, asks only the levels the flags leave, as before', async () => {
      const terminal = scripted();
      const result = await deploy(['--env', 'staging', '--detach'], {
        terminal: terminal.prompter,
      });

      expect(terminal.asked).toEqual([
        { question: 'Project', choices: ['shop'] },
        { question: 'Service', choices: ['api'] },
      ]);
      expect(result.code).toBe(0);
    });

    it('with a CLOUDGATE_ target variable, asks only the levels it leaves, as before', async () => {
      const terminal = scripted();
      const result = await deploy(['--detach'], {
        terminal: terminal.prompter,
        env: { CLOUDGATE_PROJECT: 'shop' },
      });

      expect(terminal.questions()).toEqual(['Environment', 'Service']);
      expect(result.code).toBe(0);
    });
  });

  describe('uploading only what changed', () => {
    // `sha256sum` of each content, the independent source of the fingerprints.
    const SHA = {
      index: 'b603d946eb2b396ca4ecf65c223daff659dbe6f1cfeac235b7c61d3ba6964cae', // 'console.log(1);\n'
      packageJson:
        '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', // '{}'
      old: 'cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4', // 'old'
      big: '653db61125cf65c74d6128fd78cbeb257ce2bb86dbdb7eedb141e8e164bf97c5', // 101,000,000 zero bytes
    };
    const conflictSaying = (message: string) => () =>
      json({ statusCode: 409, message, code: 'UPLOAD_CONFLICT' }, 409);
    const conflict = conflictSaying(
      'The files on the build host changed since they were compared, so the upload was not applied',
    );
    const failedApply = conflictSaying(
      'The upload could not be applied on the build host: it could not be reached, or the apply stopped part-way',
    );

    it('uploads only the one changed file, saying how many were unchanged', async () => {
      const result = await deploy([...TARGET, '--detach'], {
        buildHost: { 'index.js': SHA.old, 'package.json': SHA.packageJson },
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        `Uploading 1 changed file, ${result.sent[0]} B (1 unchanged)…\n`,
      );
      expect(result.compares).toEqual([
        [
          { path: 'index.js', sha256: SHA.index },
          { path: 'package.json', sha256: SHA.packageJson },
        ],
      ]);
      expect(result.applies).toEqual([
        {
          files: [
            { path: 'index.js', sha256: SHA.index },
            { path: 'package.json', sha256: SHA.packageJson },
          ],
          zipped: ['index.js'],
          dropBuildPath: '/',
        },
      ]);
      expect(result.uploads).toEqual([]);
    });

    it('counts a file deleted locally as deleted, and the build host no longer holds it', async () => {
      const result = await deploy([...TARGET, '--detach'], {
        buildHost: {
          'index.js': SHA.index,
          'package.json': SHA.packageJson,
          'old.js': SHA.old,
        },
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        `Uploading 0 changed files, ${result.sent[0]} B (2 unchanged, 1 deleted)…\n`,
      );
      expect(result.applies.map((apply) => apply.zipped)).toEqual([[]]);
      expect(result.buildHost).toEqual({
        'index.js': SHA.index,
        'package.json': SHA.packageJson,
      });
    });

    it('with --full, uploads every file through the full upload and compares nothing', async () => {
      const result = await deploy([...TARGET, '--detach', '--full'], {
        buildHost: { 'index.js': SHA.index, 'package.json': SHA.packageJson },
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        `Uploading 2 files, ${result.sent[0]} B…\n`,
      );
      expect(result.compares).toEqual([]);
      expect(result.applies).toEqual([]);
      expect(result.uploads).toHaveLength(1);
    });

    it('falls back to the full upload on an Instance older than 0.2.0, with no error and no question', async () => {
      // 0.1.0 is MINIMUM_SERVER_VERSION, so the Instance is still accepted;
      // the terminal's prompter fails the run if anything is asked.
      const result = await deploy([...TARGET, '--detach'], {
        version: '0.1.0',
        terminal: neverAsked,
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        `Uploading 2 files, ${result.sent[0]} B…\n`,
      );
      expect(result.stderr).not.toContain('Error');
      expect(result.compares).toEqual([]);
      expect(result.uploads).toHaveLength(1);
    });

    it('compares again once when the apply answers a conflict, then deploys', async () => {
      const result = await deploy([...TARGET, '--detach'], {
        applyAnswers: [conflict, () => json({})],
      });

      expect(result.code).toBe(0);
      // The Instance's own sentence, since it alone knows the cause.
      expect(result.stderr).toContain(
        'The files on the build host changed since they were compared, so the upload was not applied; comparing again.\n',
      );
      expect(result.compares).toHaveLength(2);
      expect(result.applies).toHaveLength(2);
      expect(result.stderr).toContain('Deployment dpl_7Hq2Xc queued\n');
    });

    it('fails with exit 1, starting no Deployment, when the apply answers a conflict a second time, saying why', async () => {
      const result = await deploy([...TARGET, '--detach'], {
        applyAnswers: [conflict, failedApply],
      });

      expect(result.code).toBe(1);
      expect(result.compares).toHaveLength(2);
      expect(result.applies).toHaveLength(2);
      expect(result.stderr).toContain(
        'Error: The upload could not be applied on the build host: it could not be reached, or the apply stopped part-way\n' +
          'It was compared and refused twice. Run cloudgate deploy again, or cloudgate deploy --full to send every file.\n',
      );
      // Nothing says the build host's files were left as they were: a
      // connection lost after the swap answers the same.
      expect(result.stderr).not.toContain('nothing was changed');
      expect(result.stderr).not.toContain('queued');
    });

    it('warns about an upload over 100 MB by the bytes it sends, not the size of its files', async () => {
      writeFileSync(join(folder, 'big.bin'), '');
      truncateSync(join(folder, 'big.bin'), 101_000_000);

      // Unchanged, so not sent at all.
      const unchanged = await deploy([...TARGET, '--detach'], {
        buildHost: { 'big.bin': SHA.big, 'package.json': SHA.packageJson },
      });
      expect(unchanged.code).toBe(0);
      expect(unchanged.stderr).not.toContain('more than 100 MB');
      expect(unchanged.stderr).toContain(
        `Uploading 1 changed file, ${unchanged.sent[0]} B (2 unchanged)…\n`,
      );

      // Sent, but 101 MB of zeros zips to a fraction of one.
      const compressible = await deploy([...TARGET, '--detach'], {
        buildHost: { 'index.js': SHA.index, 'package.json': SHA.packageJson },
      });
      expect(compressible.code).toBe(0);
      expect(compressible.sent[0]).toBeLessThan(1_000_000);
      expect(compressible.stderr).not.toContain('more than 100 MB');
      expect(compressible.stderr).toContain(
        `Uploading 1 changed file, ${(compressible.sent[0] / 1000).toFixed(1)} kB (2 unchanged)…\n`,
      );

      // Sent, and nothing to squeeze out of it.
      writeFileSync(join(folder, 'big.bin'), randomBytes(101_000_000));
      const incompressible = await deploy([...TARGET, '--detach'], {
        buildHost: { 'index.js': SHA.index, 'package.json': SHA.packageJson },
      });
      expect(incompressible.code).toBe(0);
      const megabytes = `${(incompressible.sent[0] / 1_000_000).toFixed(1)} MB`;
      expect(incompressible.stderr).toContain(
        `Warning: this upload is ${megabytes}, more than 100 MB.`,
      );
      expect(incompressible.stderr).toContain(
        `Uploading 1 changed file, ${megabytes} (2 unchanged)…\n`,
      );
    }, 60_000);

    it('lists --full in cloudgate deploy --help', async () => {
      const result = await deploy(['--help']);

      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^ {2}--full {2,}\S/m);
    });
  });

  it('refuses a [folder] that is not a folder with exit 2', async () => {
    const result = await deploy(['nowhere', ...TARGET]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Error: nowhere is not a folder');
  });
});

/**
 * A root deploy in a **Project folder** (ADR-0080): the plan step of
 * `cloudgate config plan`, then the whole folder uploaded to each app whose
 * config entry names a subfolder of it, built from that subfolder.
 */
describe('cloudgate deploy in a Project folder', () => {
  const TEXT = [
    'version: 1',
    'services:',
    '  web:',
    '    kind: web',
    '    source:',
    '      folder: apps/web',
    '  worker:',
    '    kind: worker',
    '    source:',
    '      folder: apps/worker',
    '  api:',
    '    kind: web',
    '    source:',
    '      github: acme/api',
    '  db:',
    '    kind: postgres',
    '  legacy:',
    '    kind: mongo',
    '    managed: console',
    '',
  ].join('\n');

  const SOURCES = [
    { configName: 'web', kind: 'web', source: 'folder', folder: 'apps/web' },
    {
      configName: 'worker',
      kind: 'worker',
      source: 'folder',
      folder: 'apps/worker',
    },
    { configName: 'api', kind: 'web', source: 'repository', folder: null },
    { configName: 'db', kind: 'postgres', source: 'none', folder: null },
    { configName: 'legacy', kind: 'mongo', source: 'console', folder: null },
  ];

  const SERVICES = [
    ['application', 'app_web', 'web'],
    ['application', 'app_wrk', 'worker'],
    ['application', 'app_api', 'api'],
    ['postgres', 'pg_1', 'db'],
    ['mongo', 'mg_1', 'legacy'],
  ].map(([serviceType, serviceId, configName]) => ({
    serviceType,
    serviceId,
    name: configName,
    configName,
  }));

  /** Every file of the folder an upload keeps, as each app is sent it. */
  const WHOLE_FOLDER = [
    '.gitignore',
    'apps/web/index.js',
    'apps/worker/main.js',
    'shared/lib.js',
  ];

  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cloudgate-project-deploy-'));
    writeLink(root, {
      instance: 'https://cloud.acme.dev',
      organizationId: 'org_1',
      projectId: 'prj_1',
      environmentId: 'env_1',
      workingCopy: { version: 3, sha256: hashText(TEXT) },
      names: {
        organization: 'Shop Inc',
        project: 'shop',
        environment: 'staging',
      },
    });
    const files: Record<string, string> = {
      'cloudgate.yaml': TEXT,
      '.gitignore': '.cloudgate/\n/cloudgate.yaml\n',
      'apps/web/index.js': 'require("../../shared/lib");\n',
      'apps/worker/main.js': 'require("../../shared/lib");\n',
      'shared/lib.js': 'module.exports = {};\n',
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  interface ProjectOptions {
    /** The steps the plan finds in staging; none by default. */
    steps?: Record<string, unknown>[];
    sources?: Record<string, unknown>[];
    /** `GET /deployments/:id` per Deployment, one per ask; the last repeats. */
    statuses?: Record<string, Record<string, unknown>[]>;
    /** `GET /applications/:id/deployments` per app, one per ask; the last repeats. */
    builds?: Record<string, Record<string, unknown>[][]>;
    /** The Project config's version in Cloudgate; the copy's (3) by default. */
    version?: number;
    cwd?: string;
    /** Run in a terminal, answering through this. */
    terminal?: Prompter;
    /** Variables beside the key. */
    env?: Record<string, string>;
  }

  async function deployProject(argv: string[], options: ProjectOptions = {}) {
    const out = { stdout: '', stderr: '' };
    /** Each apply, by app: the files listed and the build path sent. */
    const applies: { app: string; files: string[]; dropBuildPath: unknown }[] =
      [];
    const started: string[] = [];
    const appliedPlans: unknown[] = [];
    const dismissedPlans: unknown[] = [];
    const sentPlans: unknown[] = [];
    const asked = new Map<string, number>();
    const listed = new Map<string, number>();
    let configText = TEXT;
    let configVersion = options.version ?? 3;
    const socket = neverClosingSocket(['[build] step\n']);
    const steps = options.steps ?? [];
    const plan = (status: string) => ({
      planId: 'pln_1',
      environmentId: 'env_1',
      status,
      steps,
      notes: [],
      results:
        status === 'applied'
          ? steps.map((step) => ({ ...step, status: 'applied', message: null }))
          : null,
    });
    const respond = async (
      url: string,
      init: RequestInit,
    ): Promise<Response> => {
      const path = url.replace('https://cloud.acme.dev/backend', '');
      const method = init.method ?? 'GET';
      if (path === '/settings/about') {
        return json({
          product: 'cloudgate',
          version: '0.2.0',
          apiUrl: 'https://api.cloud.acme.dev',
        });
      }
      if (path === '/organizations')
        return json([{ id: 'org_1', name: 'Shop Inc' }]);
      if (path === '/projects')
        return json([{ projectId: 'prj_1', name: 'shop' }]);
      if (path === '/environments?projectId=prj_1')
        return json([{ environmentId: 'env_1', name: 'staging' }]);
      if (path === '/projects/prj_1/config' && method === 'GET') {
        return json({
          projectId: 'prj_1',
          location: {
            kind: 'cloudgate',
            text: configText,
            version: configVersion,
          },
        });
      }
      if (path === '/projects/prj_1/config/plans' && method === 'POST') {
        const body = JSON.parse(init.body as string) as { text: string };
        sentPlans.push(body);
        // Nothing to change stores the text at once; the same text again
        // keeps the version.
        if (steps.length === 0 && body.text !== configText) {
          configText = body.text;
          configVersion += 1;
        }
        return json({ stored: steps.length === 0, plans: [plan('open')] }, 201);
      }
      if (path === '/environments/env_1/plan/dismiss' && method === 'POST') {
        dismissedPlans.push(JSON.parse(init.body as string));
        return json(plan('dismissed'));
      }
      if (path === '/environments/env_1/plan/apply' && method === 'POST') {
        appliedPlans.push(JSON.parse(init.body as string));
        configVersion += 1;
        return json(plan('applied'));
      }
      if (path === '/environments/env_1') {
        return json({
          environmentId: 'env_1',
          name: 'staging',
          services: SERVICES,
        });
      }
      if (path === '/environments/env_1/config/sources') {
        return json({
          keptIn: 'cloudgate',
          readable: true,
          services: options.sources ?? SOURCES,
        });
      }
      const app = /^\/applications\/([^/]+)\/(.+)$/.exec(path);
      if (app && method === 'GET' && app[2] === 'deployments') {
        const builds = options.builds?.[app[1]] ?? [[]];
        const count = listed.get(app[1]) ?? 0;
        listed.set(app[1], count + 1);
        return json(builds[Math.min(count, builds.length - 1)]);
      }
      if (app && method === 'POST' && app[2] === 'drop/compare') {
        const files = await listOf(init.body as FormData);
        return json({
          missing: files.map((file) => file.path),
          unchanged: 0,
          deleted: 0,
        });
      }
      if (app && method === 'POST' && app[2] === 'drop/apply') {
        const form = init.body as FormData;
        applies.push({
          app: app[1],
          files: (await listOf(form)).map((file) => file.path),
          dropBuildPath: form.get('dropBuildPath'),
        });
        return json({ applicationId: app[1], sourceType: 'drop' });
      }
      if (app && method === 'POST' && app[2] === 'deployments') {
        started.push(app[1]);
        return json(deployment('pending', { deploymentId: `dpl_${app[1]}` }));
      }
      const watched = /^\/deployments\/(.+)$/.exec(path);
      if (watched) {
        const id = watched[1];
        const statuses = options.statuses?.[id] ?? [
          deployment('running', { deploymentId: id }),
          deployment('done', {
            deploymentId: id,
            finishedAt: '2026-11-03T12:01:47.000Z',
          }),
        ];
        const count = asked.get(id) ?? 0;
        asked.set(id, count + 1);
        return json(statuses[Math.min(count, statuses.length - 1)]);
      }
      return new Response(null, { status: 599 });
    };
    const code = await run({
      argv: ['deploy', ...argv],
      env: { CLOUDGATE_KEY: 'cg_secret', ...options.env },
      cwd: options.cwd ?? root,
      prompter: options.terminal ?? neverAsked,
      stdinIsTTY: options.terminal !== undefined,
      stdoutIsTTY: options.terminal !== undefined,
      stderrIsTTY: options.terminal !== undefined,
      stdout: (text) => (out.stdout += text),
      stderr: (text) => (out.stderr += text),
      fetch: (input, init) => respond(input as string, init ?? {}),
      openSocket: socket.open,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
      interrupts: { listen: () => () => undefined },
      now: () => new Date('2026-11-03T12:00:00Z'),
    });
    return {
      code,
      ...out,
      applies,
      started,
      sentPlans,
      appliedPlans,
      dismissedPlans,
      socket,
    };
  }

  it('uploads the whole folder to each app built from a subfolder, builds each from it, and prints one line per app', async () => {
    const result = await deployProject([], {
      cwd: join(root, 'apps', 'web'),
    });

    expect(result.stderr).not.toContain('Error');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('staging: no changes\n');
    expect(result.applies).toEqual([
      { app: 'app_web', files: WHOLE_FOLDER, dropBuildPath: 'apps/web' },
      { app: 'app_wrk', files: WHOLE_FOLDER, dropBuildPath: 'apps/worker' },
    ]);
    expect(result.started).toEqual(['app_web', 'app_wrk']);
    expect(result.stderr).toContain(
      'Deploying ../../ to web in staging of Project shop on cloud.acme.dev, built from apps/web\n',
    );
    expect(result.stderr).toContain(
      [
        '✓ web: Deployment dpl_app_web done in 1m 42s',
        '✓ worker: Deployment dpl_app_wrk done in 1m 42s',
        '- api: skipped, built from a repository',
        '- db: skipped, a database',
        '- legacy: skipped, console-managed',
        '',
      ].join('\n'),
    );
    // Each Deployment's log, followed in turn.
    expect(result.socket.opened.map((one) => one.url)).toEqual([
      'wss://api.cloud.acme.dev/listen-deployment?deploymentId=dpl_app_web',
      'wss://api.cloud.acme.dev/listen-deployment?deploymentId=dpl_app_wrk',
    ]);
  });

  it('refuses a subfolder that is not in the Project folder, naming the app, before the plan is sent or anything uploaded', async () => {
    // The working copy's worker now builds from a folder no one made.
    writeFileSync(
      join(root, 'cloudgate.yaml'),
      TEXT.replace('folder: apps/worker', 'folder: apps/jobs'),
    );
    const result = await deployProject(['--yes'], {
      steps: [
        {
          action: 'change',
          configName: 'worker',
          kind: 'worker',
          serviceType: 'application',
          serviceId: 'app_wrk',
          name: 'worker',
          fields: [
            {
              field: 'source',
              from: { folder: 'apps/worker' },
              to: { folder: 'apps/jobs' },
            },
          ],
        },
      ],
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Error: worker builds from apps/jobs, which is not a folder in this Project folder',
    );
    expect(result.sentPlans).toEqual([]);
    expect(result.appliedPlans).toEqual([]);
    expect(result.applies).toEqual([]);
    expect(result.started).toEqual([]);
  });

  it('with --service, deploys that one app only', async () => {
    const result = await deployProject(['--service', 'worker']);

    expect(result.code).toBe(0);
    expect(result.applies).toEqual([
      { app: 'app_wrk', files: WHOLE_FOLDER, dropBuildPath: 'apps/worker' },
    ]);
    expect(result.started).toEqual(['app_wrk']);
    expect(result.stderr).toContain(
      '✓ worker: Deployment dpl_app_wrk done in 1m 42s\n',
    );
    expect(result.stderr).not.toContain('skipped');
  });

  it('with --service, refuses an app not built from this folder, uploading nothing', async () => {
    const result = await deployProject(['--service', 'api']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Error: api is not built from this Project folder (built from a repository)',
    );
    expect(result.applies).toEqual([]);
  });

  it('with --detach, stops once every build is queued, printing each', async () => {
    const result = await deployProject(['--detach']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'Service  Deployment   Status\nweb      dpl_app_web  pending\nworker   dpl_app_wrk  pending\n',
    );
    expect(result.socket.opened).toEqual([]);
  });

  it('exits 1 when one build fails, after following the others to their end', async () => {
    const result = await deployProject([], {
      statuses: {
        dpl_app_web: [
          deployment('error', {
            deploymentId: 'dpl_app_web',
            finishedAt: '2026-11-03T12:00:47.000Z',
          }),
        ],
      },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      '✗ web: Deployment dpl_app_web failed after 42s; its log: cloudgate logs --deployment dpl_app_web\n✓ worker: Deployment dpl_app_wrk done in 1m 42s\n',
    );
  });

  it('waits for an app’s own running build before uploading to it', async () => {
    const before = {
      deploymentId: 'dpl_before',
      createdAt: '2026-11-03T11:58:00.000Z',
      applicationId: 'app_wrk',
      previewDeploymentId: null,
      cronRun: null,
    };
    const result = await deployProject(['--detach'], {
      builds: {
        app_wrk: [
          [{ ...before, status: 'running' }],
          [{ ...before, status: 'done' }],
        ],
      },
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      'waiting for Deployment dpl_before to finish\n',
    );
    expect(result.started).toEqual(['app_web', 'app_wrk']);
  });

  it('in an unlinked folder in a terminal, "The whole Project" makes it a Project folder as link --whole-project does, then deploys it whole', async () => {
    rmSync(join(root, '.cloudgate'), { recursive: true });
    rmSync(join(root, 'cloudgate.yaml'));
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    const terminal = scripted({ 'One app or the whole Project?': 1 });
    const result = await deployProject([], {
      terminal: terminal.prompter,
      env: { CLOUDGATE_INSTANCE: 'cloud.acme.dev' },
    });

    expect(terminal.questions()).toEqual([
      'Project',
      'One app or the whole Project?',
      'Environment',
    ]);
    expect(result.stderr).not.toContain('Error');
    expect(result.code).toBe(0);
    expect(readFileSync(join(root, 'cloudgate.yaml'), 'utf8')).toBe(TEXT);
    expect(
      JSON.parse(readFileSync(join(root, '.cloudgate', 'link.json'), 'utf8')),
    ).toEqual({
      instance: 'https://cloud.acme.dev',
      organizationId: 'org_1',
      projectId: 'prj_1',
      environmentId: 'env_1',
      names: {
        organization: 'Shop Inc',
        project: 'shop',
        environment: 'staging',
      },
      // Downloaded at 3; the plan step sent it back unchanged, which keeps 3.
      workingCopy: { version: 3, sha256: hashText(TEXT) },
    });
    expect(result.stderr).toContain(
      '✓ Saved the Project config, version 3, as cloudgate.yaml\n',
    );
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n.cloudgate/\n/cloudgate.yaml\n',
    );
    expect(result.stderr).toContain(
      '✓ Linked ./ to the whole Project shop, staging by default, on cloud.acme.dev\n',
    );
    expect(result.stderr.match(/Using instance/g)).toHaveLength(1);
    expect(result.applies.map((applied) => applied.dropBuildPath)).toEqual([
      'apps/web',
      'apps/worker',
    ]);
    expect(result.started).toEqual(['app_web', 'app_wrk']);
  });

  it('in an unlinked folder in a terminal, keeps a cloudgate.yaml already there when told to, linking and uploading nothing', async () => {
    rmSync(join(root, '.cloudgate'), { recursive: true });
    writeFileSync(join(root, 'cloudgate.yaml'), 'version: 1\n# mine\n');
    const replace =
      'cloudgate.yaml has edits not sent to Cloudgate. Replace them with the Project config, version 3?';
    const terminal = scripted({
      'One app or the whole Project?': 1,
      [replace]: false,
    });
    const result = await deployProject([], {
      terminal: terminal.prompter,
      env: { CLOUDGATE_INSTANCE: 'cloud.acme.dev' },
    });

    expect(terminal.questions()).toEqual([
      'Project',
      'One app or the whole Project?',
      'Environment',
      replace,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Kept cloudgate.yaml. Nothing changed.\nNothing was uploaded.\n',
    );
    expect(readFileSync(join(root, 'cloudgate.yaml'), 'utf8')).toBe(
      'version: 1\n# mine\n',
    );
    expect(existsSync(join(root, '.cloudgate'))).toBe(false);
    expect(result.applies).toEqual([]);
  });

  describe('its plan step, as config plan runs it', () => {
    const change = {
      action: 'change',
      configName: 'web',
      kind: 'web',
      fields: [{ field: 'command' }],
    };

    it('with no terminal and no --yes, refuses a plan with changes, exit 2, dismisses it and uploads nothing', async () => {
      const result = await deployProject([], { steps: [change] });

      expect(result.code).toBe(2);
      expect(result.stdout).toContain('  ~ web (web) change command\n');
      expect(result.stderr).toContain(
        'Error: nothing was applied: applying the plan needs a yes',
      );
      expect(result.appliedPlans).toEqual([]);
      expect(result.dismissedPlans).toEqual([{ planId: 'pln_1' }]);
      expect(result.applies).toEqual([]);
    });

    it('with --yes, applies it, then builds', async () => {
      const result = await deployProject(['--yes'], { steps: [change] });

      expect(result.code).toBe(0);
      expect(result.appliedPlans).toEqual([
        { planId: 'pln_1', confirmDestroy: [], confirmUpgrade: [] },
      ]);
      expect(result.stderr).toContain('✓ Applied the plan in staging');
      expect(result.started).toEqual(['app_web', 'app_wrk']);
    });

    it('with --yes, refuses a plan that destroys a Service, exit 2, dismisses it and uploads nothing', async () => {
      const result = await deployProject(['--yes'], {
        steps: [{ action: 'destroy', configName: 'api', kind: 'web' }],
      });

      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        'Error: the plan destroys api in staging, which --yes alone never does; nothing was applied',
      );
      expect(result.dismissedPlans).toEqual([{ planId: 'pln_1' }]);
      expect(result.applies).toEqual([]);
    });

    it('refuses a copy the Project config has moved on from, exit 1, and uploads nothing', async () => {
      const result = await deployProject(['--yes'], { version: 4 });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'Error: cloudgate.yaml is version 3 of the Project config, which has changed in Cloudgate since; nothing was sent',
      );
      expect(result.applies).toEqual([]);
    });
  });

  it('refuses a [folder] in a Project folder, which is deployed whole, exit 2', async () => {
    const result = await deployProject(['apps/web']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      'Error: a Project folder is deployed whole, not a folder in it',
    );
    expect(result.applies).toEqual([]);
  });
});
