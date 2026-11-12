import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { checkCatalogue, encodeCatalogue } from 'cloudgate-template-check';
import type { Template } from 'cloudgate-template-check';

import type { Command, CommandContext } from '../command.js';
import { isDockerMissing } from '../docker.js';
import type { DockerRun } from '../docker.js';
import { CliError, usageError } from '../errors.js';
import { EXIT } from '../exit-codes.js';
import { templateFoldersAt } from '../template-folders.js';
import { prepareStack } from '../try-stack.js';
import type { TryDomain, TryStack } from '../try-stack.js';

/** How long a whole run may take, image pulls included (spec #5). */
const RUN_MINUTES = 10;

/** How often a Domain that has not answered yet is asked again. */
const PROBE_EVERY_MS = 2_000;

/** How long one probe waits for an answer before it counts as none. */
const PROBE_WAIT_MS = 10_000;

/**
 * `cloudgate template try <template folder>`: starts a Template's compose
 * part on this computer's Docker the way an Instance would, checks that
 * each Domain answers, and removes everything (spec #5). No Instance and no
 * login: the check, the values and the compose file preparation are the
 * backend's own code, bundled in, so `try` cannot drift from an Instance.
 *
 * The Template check runs first, and a Template it would hide is refused
 * with its reason. Only the compose part runs; a Template without one has
 * nothing to try. Once anything has started, {@link TryRun.tearDown} is the
 * one way out, after a pass and after a fail alike.
 */
export const templateTry: Command = {
  name: 'template try',
  group: 'TEMPLATES',
  summary: "Start a template's compose part on local Docker",
  help: `Start a template's compose part on this computer's Docker.

USAGE
  cloudgate template try <template folder>

  Checks the template as template check does, and stops (exit 1) with the
  reason if Cloudgate would hide it. Then makes its values as setup does (an
  ask input takes its default, or a sample that fits its format or
  pattern), lays out the compose part as a Server's stack folder, publishes
  each Domain's container port on a free 127.0.0.1 port, and runs
  docker compose up --wait. Each Domain is asked at
  http://localhost:<port><path> every 2 seconds until it answers anything
  but a 5xx, for up to ${RUN_MINUTES} minutes in all.

  Prints ✓ <service>:<port><path> for each Domain that answered, or
  ✗ <service>:<port><path>: <last status or "no answer">, and exits 1 if any
  failed. Afterwards the stack is always removed with its volumes
  (docker compose down --volumes --remove-orphans), and its folder deleted.
  A template with no compose part has nothing to try and exits 0.

  Needs Docker with Compose v2 or newer. Makes no request to an Instance.
`,
  options: {},
  maxPositionals: 1,
  async run(context) {
    const [given] = context.positionals;
    if (given === undefined) {
      throw usageError(
        'cloudgate template try needs a template folder',
        'Run cloudgate template try --help.',
      );
    }
    const template = checkedTemplate(resolve(context.cwd, given));
    if (template.composeFile === null) {
      context.out.data(`${template.id}: no compose part, nothing to try\n`);
      return EXIT.ok;
    }

    const project = `cg-try-${template.id}-${randomBytes(4).toString('hex')}`;
    const stack = await prepareStack(
      { ...template, composeFile: template.composeFile },
      project,
    );
    await requireCompose(context.docker);

    const tryRun = new TryRun(context.docker, project, writeStack(stack));
    try {
      return await tryRun.start(context, stack);
    } finally {
      await tryRun.tearDown();
    }
  },
};

/** The one Template in `folder`, as the check offers it; refused otherwise. */
function checkedTemplate(folder: string): Template {
  if (!isTemplateFolder(folder)) {
    throw usageError(
      `${folder} is not a template folder: it has no template.yaml`,
      'Give the folder of one template.',
    );
  }
  const result = checkCatalogue(
    encodeCatalogue(templateFoldersAt(folder, 'unpublished')),
    { cloudgateVersion: __CLOUDGATE_CHECK_VERSION__ },
  );
  if (!result.ok) throw new CliError(result.reason, EXIT.failed);
  const [hidden] = result.hidden;
  if (hidden) {
    throw new CliError(`${hidden.id}: ${hidden.reason}`, EXIT.failed);
  }
  return result.offered[0];
}

function isTemplateFolder(folder: string): boolean {
  try {
    return statSync(join(folder, 'template.yaml')).isFile();
  } catch {
    return false;
  }
}

/** Refuses, naming what to install, a computer without Docker Compose v2. */
async function requireCompose(docker: DockerRun): Promise<void> {
  let answer;
  try {
    answer = await docker(['compose', 'version', '--short']);
  } catch (error) {
    if (!isDockerMissing(error)) throw error;
    throw new CliError(
      'cloudgate template try needs Docker, and there is no docker command here',
      EXIT.failed,
      'Install Docker (https://docs.docker.com/get-docker/), with Compose v2 or newer.',
    );
  }
  const major = Number(/^v?(\d+)\./.exec(answer.stdout.trim())?.[1]);
  if (answer.code !== 0 || major < 2) {
    throw new CliError(
      'cloudgate template try needs Docker Compose v2 or newer, for docker compose up --wait',
      EXIT.failed,
      'Install the Docker Compose plugin (https://docs.docker.com/compose/install/).',
    );
  }
}

/** Writes `stack` into a new temporary folder; its `code/` folder. */
function writeStack(stack: TryStack): string {
  const root = mkdtempSync(join(tmpdir(), 'cloudgate-try-'));
  const code = join(root, 'code');
  mkdirSync(code);
  writeFileSync(join(code, 'docker-compose.yml'), stack.composeFile);
  writeFileSync(join(code, '.env'), stack.env);
  for (const [path, text] of Object.entries(stack.files)) {
    const file = join(root, 'files', path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return code;
}

/**
 * One run of a Template's stack, and the one place it is torn down: whatever
 * ends the run, {@link tearDown} removes the project with its volumes and
 * deletes the folder, once.
 */
class TryRun {
  private tornDown = false;

  constructor(
    private readonly docker: DockerRun,
    private readonly project: string,
    /** The stack's `code/` folder, inside the temporary folder. */
    private readonly code: string,
  ) {}

  private compose(...args: string[]) {
    return this.docker(['compose', '-p', this.project, ...args], {
      cwd: this.code,
    });
  }

  /** Starts the stack and judges each Domain: exit 0, or 1 if any failed. */
  async start(
    { out, fetch, now, sleep }: CommandContext,
    stack: TryStack,
  ): Promise<typeof EXIT.ok | typeof EXIT.failed> {
    const deadline = now().getTime() + RUN_MINUTES * 60_000;
    out.note(`Starting ${this.project} on the local Docker…`);
    const up = await this.compose('up', '--wait');
    if (up.code !== 0) {
      throw new CliError(
        `docker compose up failed:\n${(up.stderr || up.stdout).trimEnd()}`,
        EXIT.failed,
      );
    }

    const why = new Map<TryDomain, string>(
      stack.domains.map((domain) => [domain, 'no answer']),
    );
    while (why.size > 0) {
      for (const domain of [...why.keys()]) {
        const answer = await probe(fetch, domain);
        if (answer === null) why.delete(domain);
        else why.set(domain, answer);
      }
      if (why.size === 0 || now().getTime() + PROBE_EVERY_MS > deadline) break;
      await sleep(PROBE_EVERY_MS);
    }

    for (const domain of stack.domains) {
      const name = `${domain.service}:${domain.port}${domain.path}`;
      const failed = why.get(domain);
      out.data(failed === undefined ? `✓ ${name}\n` : `✗ ${name}: ${failed}\n`);
    }
    return why.size === 0 ? EXIT.ok : EXIT.failed;
  }

  /** Removes the project with its volumes, then its folder. Runs once. */
  async tearDown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    try {
      await this.compose('down', '--volumes', '--remove-orphans');
    } finally {
      rmSync(dirname(this.code), { recursive: true, force: true });
    }
  }
}

/**
 * Asks a Domain once, without following a redirect: null when it answered
 * anything but a 5xx, otherwise the status, or "no answer".
 */
async function probe(
  fetch: typeof globalThis.fetch,
  domain: TryDomain,
): Promise<string | null> {
  try {
    const response = await fetch(
      `http://localhost:${domain.hostPort}${domain.path}`,
      { redirect: 'manual', signal: AbortSignal.timeout(PROBE_WAIT_MS) },
    );
    await response.body?.cancel();
    return response.status >= 500 ? String(response.status) : null;
  } catch {
    return 'no answer';
  }
}
