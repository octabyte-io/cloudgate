import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SocketLike } from '../src/deployment-log-stream.js';
import type { Prompter } from '../src/prompt.js';
import { run } from '../src/run.js';

/**
 * `cloudgate deploy`, driven as a CI job drives it, against an Instance that
 * `fetch` and the socket double answer. What the built command does against
 * the real backend is the CLI e2e suite's walk (`backend/test/cli/`).
 */

const neverAsked: Prompter = {
  choose: () => Promise.reject(new Error('asked a question')),
  confirm: () => Promise.reject(new Error('asked a question')),
  secret: () => Promise.reject(new Error('asked a question')),
};

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
    env: { CLOUDGATE_KEY: 'cg_secret', CLOUDGATE_INSTANCE: 'cloud.acme.dev' },
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
      'Uploading 2 changed files, 18 B (0 unchanged)…\n',
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
      'Uploading 3 changed files, 25 B (0 unchanged)…\n',
    );
  });

  it('uploads [folder] when one is named, saying which', async () => {
    mkdirSync(join(folder, 'dist'));
    writeFileSync(join(folder, 'dist', 'app.js'), '1');

    const result = await deploy(['dist', ...TARGET, '--detach']);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Deploying ./dist/ to api in staging');
    expect(result.stderr).toContain(
      'Uploading 1 changed file, 1 B (0 unchanged)…\n',
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

    it('in an unlinked folder, asks the link questions, saves the link, and deploys', async () => {
      const { prompter, questions } = answering(true);
      const result = await deploy(['--detach'], { terminal: prompter });

      expect(questions).toEqual(['Project', 'Environment', 'Service']);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        '✓ Linked ./ to api in staging of Project shop on cloud.acme.dev\n',
      );
      expect(
        JSON.parse(
          readFileSync(join(folder, '.cloudgate', 'link.json'), 'utf8'),
        ),
      ).toMatchObject({
        instance: 'https://cloud.acme.dev',
        organizationId: 'org_1',
        projectId: 'prj_1',
        environmentId: 'env_1',
        serviceConfigName: 'api',
      });
      expect(result.applies).toHaveLength(1);
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
        'Uploading 1 changed file, 16 B (1 unchanged)…\n',
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
        'Uploading 0 changed files, 0 B (2 unchanged, 1 deleted)…\n',
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
      expect(result.stderr).toContain('Uploading 2 files, 18 B…\n');
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
      expect(result.stderr).toContain('Uploading 2 files, 18 B…\n');
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

    it('warns about an upload over 100 MB by the bytes it sends, not the size of the folder', async () => {
      writeFileSync(join(folder, 'big.bin'), '');
      truncateSync(join(folder, 'big.bin'), 101_000_000);

      const unchanged = await deploy([...TARGET, '--detach'], {
        buildHost: { 'big.bin': SHA.big, 'package.json': SHA.packageJson },
      });
      expect(unchanged.code).toBe(0);
      expect(unchanged.stderr).not.toContain('more than 100 MB');
      expect(unchanged.stderr).toContain(
        'Uploading 1 changed file, 16 B (2 unchanged)…\n',
      );

      const changed = await deploy([...TARGET, '--detach'], {
        buildHost: { 'index.js': SHA.index, 'package.json': SHA.packageJson },
      });
      expect(changed.code).toBe(0);
      expect(changed.stderr).toContain(
        'Warning: this upload is 101.0 MB, more than 100 MB.',
      );
      expect(changed.stderr).toContain(
        'Uploading 1 changed file, 101.0 MB (2 unchanged)…\n',
      );
    });

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
