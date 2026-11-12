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
import type { ExitCode } from '../exit-codes.js';
import { abortOf } from '../stopping.js';
import { templateFoldersAt } from '../template-folders.js';
import { prepareStack } from '../try-stack.js';
import type { TryDomain, TryStack } from '../try-stack.js';

/** How long a whole run may take, image pulls included, unless `--timeout` says (spec #5). */
const RUN_MINUTES = 10;

/**
 * How often a Domain that has not answered yet is asked again, and how often
 * a running `docker compose up` is held against the time limit.
 */
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
  cloudgate template try <template folder> [--timeout <minutes>]

  Checks the template as template check does, and stops (exit 1) with the
  reason if Cloudgate would hide it. Then makes its values as setup does (an
  ask input takes its default, or a sample that fits its format or
  pattern), lays out the compose part as a Server's stack folder, publishes
  each Domain's container port on a free 127.0.0.1 port, and runs
  docker compose up --wait. Each Domain is asked at
  http://localhost:<port><path> every 2 seconds until it answers anything
  but a 5xx.

  Prints ✓ <service>:<port><path> for each Domain that answered, or
  ✗ <service>:<port><path>: <last status or "no answer">, and exits 1 if any
  failed. When up fails, a Domain never passes or the time runs out, it
  prints docker compose ps --all and docker compose logs --no-color for the
  stack first. Afterwards the stack is always removed with its volumes
  (docker compose down --volumes --remove-orphans), and its folder deleted;
  Ctrl-C removes it too, and exits 130. A template with no compose part has
  nothing to try and exits 0.

  Needs Docker with Compose v2 or newer. Makes no request to an Instance.

FLAGS
  --timeout <minutes>  How long the whole run may take, image pulls
                       included, before it stops and exits 1 (default ${RUN_MINUTES}).
`,
  options: { timeout: { type: 'string' } },
  maxPositionals: 1,
  async run(context) {
    const [given] = context.positionals;
    if (given === undefined) {
      throw usageError(
        'cloudgate template try needs a template folder',
        'Run cloudgate template try --help.',
      );
    }
    const minutes = runMinutes(context.values.timeout);
    const deadline = context.now().getTime() + minutes * 60_000;
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

    const tryRun = new TryRun(context, project, writeStack(stack), {
      deadline,
      minutes,
    });
    // Ctrl-C stops the run rather than the process, so the stack is still
    // torn down; a second Ctrl-C ends the process at once (`main.ts`).
    const unlisten = context.interrupts.listen(() => tryRun.interrupt());
    try {
      return await tryRun.start(stack);
    } finally {
      try {
        await tryRun.tearDown();
      } finally {
        unlisten();
      }
    }
  },
};

/** `--timeout`: a number of minutes above 0; wrong use otherwise. */
function runMinutes(given: string | boolean | undefined): number {
  if (given === undefined) return RUN_MINUTES;
  const minutes =
    typeof given === 'string' && /^\d+(\.\d+)?$/.test(given)
      ? Number(given)
      : 0;
  if (minutes > 0) return minutes;
  throw usageError(
    `--timeout needs a number of minutes above 0, not "${String(given)}"`,
    'Run cloudgate template try --help.',
  );
}

function minutesText(minutes: number): string {
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

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
 * ends the run (a pass, a fail, the time limit, Ctrl-C), {@link tearDown}
 * removes the project with its volumes and deletes the folder, once.
 *
 * The time limit and Ctrl-C stop the run through one signal, which ends a
 * `docker compose up` still pulling and a probe still waiting. The deadline
 * is read from the run's own clock between waits, so a test's clock drives
 * it.
 */
class TryRun {
  private tornDown = false;
  private readonly stop = new AbortController();
  /** Why the run was stopped; the first reason wins. */
  private stopped: 'timeout' | 'interrupt' | undefined;
  /**
   * Settles when the run is stopped. One for the whole run, raced at every
   * wait, rather than a listener added per wait (Node warns past ten).
   */
  private readonly whenStopped = abortOf(this.stop.signal);

  constructor(
    private readonly context: CommandContext,
    private readonly project: string,
    /** The stack's `code/` folder, inside the temporary folder. */
    private readonly code: string,
    private readonly limit: { deadline: number; minutes: number },
  ) {}

  /** Ctrl-C: the run stops where it is, and is torn down. */
  interrupt(): void {
    this.halt('interrupt');
  }

  private halt(why: 'timeout' | 'interrupt'): void {
    this.stopped ??= why;
    this.stop.abort();
  }

  private compose(args: string[], signal?: AbortSignal) {
    return this.context.docker(['compose', '-p', this.project, ...args], {
      cwd: this.code,
      signal,
    });
  }

  /** Starts the stack and judges each Domain: exit 0, 1 if any failed, 130 on Ctrl-C. */
  async start(stack: TryStack): Promise<ExitCode> {
    const { out, fetch } = this.context;
    out.note(`Starting ${this.project} on the local Docker…`);
    const up = await this.untilStopped(
      this.compose(['up', '--wait'], this.stop.signal),
    );
    if (this.stopped === 'interrupt') return this.interrupted();
    if (this.stopped === 'timeout') {
      await this.printState();
      throw new CliError(
        `docker compose up did not finish within ${minutesText(this.limit.minutes)}`,
        EXIT.failed,
        'Give the run more time with --timeout <minutes>.',
      );
    }
    if (up.code !== 0) {
      await this.printState();
      throw new CliError(
        `docker compose up failed:\n${(up.stderr || up.stdout).trimEnd()}`,
        EXIT.failed,
      );
    }

    const why = new Map<TryDomain, string>(
      stack.domains.map((domain) => [domain, 'no answer']),
    );
    while (why.size > 0 && this.stopped === undefined) {
      for (const domain of [...why.keys()]) {
        const answer = await probe(fetch, domain, this.stop.signal);
        if (this.stopped === 'interrupt') break;
        if (answer === null) why.delete(domain);
        else why.set(domain, answer);
      }
      if (why.size > 0) await this.wait(PROBE_EVERY_MS);
    }
    if (this.stopped === 'interrupt') return this.interrupted();

    for (const domain of stack.domains) {
      const name = `${domain.service}:${domain.port}${domain.path}`;
      const failed = why.get(domain);
      out.data(failed === undefined ? `✓ ${name}\n` : `✗ ${name}: ${failed}\n`);
    }
    if (why.size === 0) return EXIT.ok;
    await this.printState();
    return EXIT.failed;
  }

  /**
   * Waits for `work`, holding it against the time limit meanwhile: past the
   * deadline the run is stopped, which ends `work`, and `work` is still
   * waited for, so nothing is torn down under a `docker` still running.
   */
  private async untilStopped<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    void work.then(
      () => (settled = true),
      () => (settled = true),
    );
    while (!settled && this.stopped === undefined) {
      await Promise.race([work, this.wait(PROBE_EVERY_MS)]);
    }
    return work;
  }

  /** Waits `ms`, or less when the deadline or Ctrl-C comes first. */
  private async wait(ms: number): Promise<void> {
    const { now, sleep } = this.context;
    const left = this.limit.deadline - now().getTime();
    if (left > 0)
      await Promise.race([sleep(Math.min(ms, left)), this.whenStopped]);
    if (now().getTime() >= this.limit.deadline) this.halt('timeout');
  }

  private interrupted(): ExitCode {
    this.context.out.note(`Stopped. Removing ${this.project}…`);
    return EXIT.interrupted;
  }

  /**
   * What Compose says of the project, for a run that failed: every
   * container, stopped ones too (`--all`: a Template that crashes on boot
   * has none running), then their logs.
   */
  private async printState(): Promise<void> {
    for (const args of [
      ['ps', '--all'],
      ['logs', '--no-color'],
    ]) {
      const said = await this.compose(args);
      this.context.out.note(
        `docker compose ${args.join(' ')}:\n${(said.stdout + said.stderr).trimEnd()}`,
      );
    }
  }

  /** Removes the project with its volumes, then its folder. Runs once. */
  async tearDown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    try {
      await this.compose(['down', '--volumes', '--remove-orphans']);
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
  stop: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetch(
      `http://localhost:${domain.hostPort}${domain.path}`,
      {
        redirect: 'manual',
        signal: AbortSignal.any([stop, AbortSignal.timeout(PROBE_WAIT_MS)]),
      },
    );
    await response.body?.cancel();
    return response.status >= 500 ? String(response.status) : null;
  } catch {
    return 'no answer';
  }
}
