import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ForgetRequest,
  ForgottenInstance,
  GoogleCredential,
  TofuApplyOutcome,
  TofuApplyRequest,
  TofuCredential,
  TofuFailure,
  TofuPlanOutcome,
  TofuRunRequest,
  TofuRunSignal,
  TofuShow,
  TofuStateOutcome,
  TofuStateReadRequest,
} from '../cloud.port';
import { renderDefinition } from '../definitions/tofu-json';
import type { StateProjection, TofuStateShow } from './state-show';
import {
  OPENTOFU_VERSION,
  opentofuCliConfig,
  PINNED_PROVIDERS,
  pinsFor,
  providerDirectory,
  stateEncryption,
} from './tofu-environment';
import type { PinnedProvider } from './tofu-environment';

/** The two pinned files `deploy/opentofu/` holds, written into each working folder. */
const VERSIONS_FILE = 'versions.tf.json';
const LOCK_FILE = '.terraform.lock.hcl';

/** The providers a run of each cloud requires (the Google Cloud spec, ADR-0030). */
const AWS_PROVIDERS: readonly PinnedProvider[] = ['aws'];
export const GOOGLE_PROVIDERS: readonly PinnedProvider[] = ['google'];

/** How a message names each provider. */
const PROVIDER_NAMES: Record<PinnedProvider, string> = {
  aws: 'AWS provider',
  google: 'Google provider',
};

const PLAN_FILE = 'cloudgate.tfplan';
const CLI_CONFIG_FILE = 'cloudgate.tfrc';
const OVERRIDE_FILE = 'moto_override.tf.json';
/**
 * A Google run's credential configuration, for `GOOGLE_APPLICATION_CREDENTIALS`.
 * Exported for the Google adapter, whose configuration reads its run's token
 * from this same file, by this name, in the folder `tofu` runs in.
 */
export const GOOGLE_CREDENTIAL_FILE = 'google-credential.json';

export interface TofuRunnerOptions {
  /** `OPENTOFU_BINARY` from the install; unset means OpenTofu is not installed. */
  readonly binary: string | undefined;
  /** `OPENTOFU_PROVIDER_MIRROR` from the install. */
  readonly providerMirror: string | undefined;
  /** The state login's URL, `INFRASTRUCTURE_STATE_DATABASE_URL`. */
  readonly stateDatabaseUrl: string | undefined;
  readonly appEncryptionSecret: string;
  /** The checkout's `deploy/opentofu/`, holding the pins. */
  readonly pinsDirectory: string;
  /** Where working folders are made; the system's temporary folder by default. */
  readonly workRoot?: string;
  /**
   * The moto lane's alone, never the product's: an OpenTofu override
   * file written beside the definition, which merges into its `aws`
   * provider block to point every endpoint at moto. The definition itself
   * is the generated one, byte for byte.
   */
  readonly providerOverride?: Record<string, unknown>;
  /**
   * How long an apply waits before planning and applying again when AWS
   * refused to read back what it had just made ({@link tagsNotYetApplied});
   * {@link TAG_RETRY_DELAY_MS} by default. Tests make it short.
   */
  readonly tagRetryDelayMs?: number;
  /**
   * How long making a state's workspace waits before trying again when the
   * `pg` backend's shared creation key was taken ({@link selectWorkspace});
   * {@link CREATION_LOCK_RETRY_DELAY_MS} by default. Tests make it short.
   */
  readonly creationLockRetryDelayMs?: number;
}

/**
 * The wait before planning and applying again when AWS had not yet applied a
 * new resource's tags to its permissions. On a live walk the same read was
 * allowed minutes later; IAM's own word for it is seconds, and the plan made
 * again spends more than that refreshing besides.
 */
export const TAG_RETRY_DELAY_MS = 30_000;

/**
 * How long a step that locks the state (plan, apply, untaint, state rm)
 * waits for the lock (ADR-0036 §4). Not for a state held by another
 * run — the Cloud run pool never starts two runs of one state, so that is a
 * stray process, and it still fails, as `lock-held`, once the wait is up —
 * but for the one advisory key OpenTofu's `pg` backend shares across every
 * state in the schema: its Lock takes the workspace-creation key beside the
 * state's own, and a run creating another state's workspace holds that key
 * for the moment it writes the empty state. OpenTofu retries its lock at 1,
 * 3 and 7 seconds within this wait.
 */
const STATE_LOCK_TIMEOUT = '-lock-timeout=10s';

/**
 * How many times a run tries to make its state's workspace when the `pg`
 * backend's shared creation key is taken, and the wait between tries.
 * `workspace select -or-create` takes that key with no wait of its own: no
 * `-lock-timeout` reaches it.
 */
const WORKSPACE_ATTEMPTS = 3;
export const CREATION_LOCK_RETRY_DELAY_MS = 1_000;

/**
 * The runs of this process making a workspace, one after another: two of
 * them at once would each take the `pg` backend's one creation key. A
 * plan's or apply's own lock takes that key too, and waits it out
 * ({@link STATE_LOCK_TIMEOUT}); another Cloudgate process on the same
 * database is what {@link WORKSPACE_ATTEMPTS} is for.
 */
let workspaceCreations: Promise<unknown> = Promise.resolve();

function oneWorkspaceCreationAtATime<T>(work: () => Promise<T>): Promise<T> {
  const turn = workspaceCreations.then(work, work);
  workspaceCreations = turn.catch(() => undefined);
  return turn;
}

interface StepResult {
  code: number | null;
  /** Everything printed, stdout and stderr, for classifying a failure. */
  printed: string;
  /** stdout alone, for a command whose output is data (`show -json`). */
  stdout: string;
}

/**
 * Runs `tofu` for the cloud adapters, and for nothing else (the AWS spec, "What
 * runs where"): the one place in the backend that spawns it, shared by
 * both clouds (the Google Cloud spec, ADR-0030). Only a run's credential differs by
 * cloud; everything below holds for both.
 *
 * - **A working folder per run**, made `0700` under the temporary folder and
 *   deleted when the run ends, however it ends. It holds the definition, the
 *   two pin files — narrowed to its own cloud's providers, so an AWS run
 *   neither needs nor names a Google one — the CLI config and the saved
 *   plan, which OpenTofu encrypts — and, on a Google run, the credential
 *   configuration file (`0600`), which the Google provider reads only from
 *   a file. Nothing else secret is written to it.
 * - **Secrets through the environment otherwise**: the state login
 *   (`PG_CONN_STR`), the state key (`TF_ENCRYPTION`), an AWS key, the path
 *   of a Google credential file and every `TF_VAR_`. The child gets no other
 *   variable of the backend's environment, and its home is the working
 *   folder; on AWS the instance metadata service is off, and on Google
 *   `GOOGLE_APPLICATION_CREDENTIALS` is always set, so the provider can never
 *   fall back to the host's own identity.
 * - **Providers from the mirror only**: the CLI config has no `direct {}`,
 *   `init` runs with `-lockfile=readonly`, and before any of that the run
 *   checks the installed OpenTofu and provider are this checkout's pins, so a
 *   mismatch fails before anything changes and names what to do.
 * - **The lock is waited for briefly** ({@link STATE_LOCK_TIMEOUT}), only to
 *   ride out the `pg` backend's shared workspace-creation key, and never
 *   forced; making a state's workspace is retried on that key too
 *   ({@link selectWorkspace}).
 * - **Ending from outside** follows the Cloud run pool's two-step signal
 *   (`CloudRunSignal`): its interrupt sends `tofu` one SIGINT, which
 *   `tofu` treats as "stop and save the state", and nothing more; its kill —
 *   which the pool sends 5 minutes later if the run has not ended — SIGKILLs
 *   the whole process group, `tofu` and its provider. `tofu` runs in its own
 *   group (`detached`) for that kill.
 * - **Shutdown**: on SIGTERM the pool interrupts every run (the unit is
 *   `KillMode=mixed`, so that interrupt is the only one `tofu` gets; a second
 *   would make it abandon the state). {@link whenIdle} resolves once every
 *   running `tofu` has exited, and sends nothing itself.
 *
 * One run at a time is the Cloud run pool's to enforce; the runner
 * never runs two steps of one run in parallel.
 */
export class TofuRunner {
  private readonly running = new Set<Promise<unknown>>();

  constructor(private readonly options: TofuRunnerOptions) {}

  plan(request: TofuRunRequest<TofuCredential>): Promise<TofuPlanOutcome> {
    return this.track(async () => {
      const result = await this.run(request, 'plan');
      return result.ok ? { ok: true, show: result.show } : result;
    });
  }

  apply(request: TofuApplyRequest<TofuCredential>): Promise<TofuApplyOutcome> {
    return this.track(() => this.run(request, 'apply'));
  }

  destroy(
    request: TofuApplyRequest<TofuCredential>,
  ): Promise<TofuApplyOutcome> {
    return this.track(() => this.run(request, 'destroy'));
  }

  /**
   * What the state holds, as its cloud's `project` makes it:
   * `init`, `workspace list`, and — only when the state's workspace exists,
   * since selecting a missing one would make it — `workspace select` and
   * `show -json` of the state. Nothing takes the lock or writes. The state
   * as `tofu` prints it never leaves this method: only the projection does,
   * which each adapter names for its own cloud (`aws/state-resources.ts`,
   * `gcp/state-resources.ts`).
   */
  stateResources<Resource>(
    request: TofuStateReadRequest<TofuCredential>,
    project: StateProjection<Resource>,
  ): Promise<TofuStateOutcome<Resource>> {
    return this.track(() => this.readState(request, project));
  }

  /** Resolves once no `tofu` is running — what shutdown waits on. */
  async whenIdle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running]);
    }
  }

  private track<T>(work: () => Promise<T>): Promise<T> {
    const promise = work();
    this.running.add(promise);
    const forget = () => this.running.delete(promise);
    promise.then(forget, forget);
    return promise;
  }

  private async run(
    request: TofuApplyRequest<TofuCredential>,
    kind: 'plan' | 'apply' | 'destroy',
  ): Promise<TofuApplyOutcome> {
    const providers = providersFor(request.credential);
    const install = await this.checkInstall(providers);
    if (install) return install;
    const binary = this.options.binary as string;

    const folder = await mkdtemp(
      join(this.options.workRoot ?? tmpdir(), 'cloudgate-tofu-'),
    );
    try {
      await this.prepare(folder, request);
      const env = this.environment(folder, request);
      const scrub = scrubber(Object.values(request.variables ?? {}));
      const onLine = request.onLine;
      const interruption = new Interruption(request.signal);
      // The last failed step as `tofu` printed it, for reading more than
      // `classify` keeps: whether an apply failed on AWS's tag race.
      let lastFailed: StepResult | null = null;
      const step = async (
        args: string[],
        stream: boolean,
      ): Promise<StepResult | TofuFailure> => {
        if (interruption.happened) return interruption.failure();
        const result = await runStep(binary, args, {
          cwd: folder,
          env,
          onLine: stream && onLine ? (line) => onLine(scrub(line)) : undefined,
          interruption,
        });
        if (interruption.happened) return interruption.failure();
        if (result.code !== 0) {
          lastFailed = result;
          const failure = classify(result, request.stateId, providers);
          const command = args[0];
          return {
            ...failure,
            message: scrub(failure.message),
            ...(command === 'plan' || command === 'apply'
              ? { failedAt: command }
              : {}),
          };
        }
        return result;
      };
      const planAndShow = async (): Promise<TofuShow | TofuFailure> => {
        const planned = await step(
          [
            'plan',
            '-input=false',
            '-no-color',
            STATE_LOCK_TIMEOUT,
            `-out=${PLAN_FILE}`,
            ...(kind === 'destroy' ? ['-destroy'] : []),
            // An address is ours (`aws/definitions/`, `gcp/definitions/`), never the operator's.
            ...(request.targets ?? []).map((address) => `-target=${address}`),
            ...(request.replaces ?? []).map((address) => `-replace=${address}`),
          ],
          true,
        );
        if (isFailure(planned)) return planned;
        const shown = await step(
          ['show', '-json', '-no-color', PLAN_FILE],
          false,
        );
        if (isFailure(shown)) return shown;
        return withoutVariables(shown.stdout);
      };
      const applyPlan = () =>
        step(
          ['apply', '-input=false', '-no-color', STATE_LOCK_TIMEOUT, PLAN_FILE],
          true,
        );

      const init = await step(
        ['init', '-input=false', '-no-color', '-lockfile=readonly'],
        true,
      );
      if (isFailure(init)) return init;
      // The state is the workspace of its id: made empty on its first run,
      // when it then adopts by tag. `--` because an id may start with `-`.
      const workspace = await this.selectWorkspace(
        request.stateId,
        step,
        interruption,
      );
      if (isFailure(workspace)) return workspace;
      if (request.forget && kind !== 'plan') {
        const forgot = await this.forget(request.forget, step);
        if (forgot) return forgot;
      }
      const show = await planAndShow();
      if (isFailure(show)) return show;
      if (kind === 'plan') return { ok: true, show, outputs: {} };

      const refusal = request.beforeApply?.(show) ?? null;
      if (refusal) return refusal;
      let applied = await applyPlan();
      if (
        kind === 'apply' &&
        isFailure(applied) &&
        applied.reason === 'failed'
      ) {
        const race = tagsNotYetApplied(
          (lastFailed as StepResult | null)?.printed ?? '',
          providers,
        );
        if (race) {
          applied = await this.applyAgain(race, applied, show, {
            step,
            planAndShow,
            applyPlan,
            interruption,
            log: (line) => onLine?.(scrub(line)),
          });
        }
      }
      if (isFailure(applied)) return applied;
      const output = await step(['output', '-json', '-no-color'], false);
      if (isFailure(output)) return output;
      return { ok: true, show, outputs: outputValues(output.stdout) };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  /**
   * `workspace select -or-create` for the run's state, one run of this
   * process at a time, tried {@link WORKSPACE_ATTEMPTS} times while the
   * `pg` backend's shared creation key is taken. Selecting or making
   * a workspace changes nothing in the cloud, so trying again is safe.
   */
  private async selectWorkspace(
    stateId: string,
    step: (
      args: string[],
      stream: boolean,
    ) => Promise<StepResult | TofuFailure>,
    interruption: Interruption,
  ): Promise<StepResult | TofuFailure> {
    const delayMs =
      this.options.creationLockRetryDelayMs ?? CREATION_LOCK_RETRY_DELAY_MS;
    for (let attempt = 1; ; attempt++) {
      const selected = await oneWorkspaceCreationAtATime(() =>
        step(['workspace', 'select', '-or-create=true', '--', stateId], false),
      );
      if (
        !isFailure(selected) ||
        selected.reason !== 'state-backend-busy' ||
        attempt === WORKSPACE_ATTEMPTS
      ) {
        return selected;
      }
      await interruption.pause(delayMs * attempt);
    }
  }

  /**
   * The one second attempt an apply gets when AWS refused to read back what
   * it had just made because the new resource's tags had not yet reached
   * its permissions (the deploy role reaches it only by `aws:ResourceTag`,
   * ADR-0036). The race is waited out, never granted away: the run says why
   * in its log, waits, lifts the taint `tofu` put on each such resource (it
   * was made; only its read back failed, and replacing it would race
   * again), then plans and applies again, streaming as the first attempt
   * did. The plan made again may only finish what the first one, which
   * `beforeApply` accepted, set out to do. `beforeApply` itself is not asked
   * again: against what the Apply approved, a half-applied plan always reads
   * as a different one. Anything more, or a second failure of any kind,
   * ends the run.
   */
  private async applyAgain(
    race: TagRace,
    first: TofuFailure,
    applied: TofuShow,
    run: {
      step: (
        args: string[],
        stream: boolean,
      ) => Promise<StepResult | TofuFailure>;
      planAndShow: () => Promise<TofuShow | TofuFailure>;
      applyPlan: () => Promise<StepResult | TofuFailure>;
      interruption: Interruption;
      log: (line: string) => void;
    },
  ): Promise<StepResult | TofuFailure> {
    const delayMs = this.options.tagRetryDelayMs ?? TAG_RETRY_DELAY_MS;
    const seconds = Math.max(1, Math.round(delayMs / 1000));
    const after = `planning and applying again in ${seconds} second${seconds === 1 ? '' : 's'}`;
    run.log(
      race.addresses.length === 1
        ? `AWS had not yet applied the new ${race.kinds[0]}'s tags to its permissions, so reading it back was refused; ${after}`
        : `AWS had not yet applied the tags of the new ${wordList(race.kinds)} to its permissions, so reading them back was refused; ${after}`,
    );
    await run.interruption.pause(delayMs);
    if (run.interruption.happened) return run.interruption.failure();

    const state = await run.step(['show', '-json', '-no-color'], false);
    if (isFailure(state)) return state;
    const tainted = taintedAddresses(
      JSON.parse(state.stdout || '{}') as ShownState,
      race.addresses,
    );
    for (const address of tainted) {
      const untainted = await run.step(
        ['untaint', STATE_LOCK_TIMEOUT, '--', address],
        true,
      );
      if (isFailure(untainted)) return untainted;
    }

    const again = await run.planAndShow();
    if (isFailure(again)) return again;
    const beyond = changesBeyond(applied, again);
    if (beyond) {
      run.log(
        `The plan made again would also ${beyond}, which the plan being applied did not, so it was not applied`,
      );
      return first;
    }
    return run.applyPlan();
  }

  /**
   * Takes the instances of `forget.resource` the definition no longer keys
   * out of the state: reads the state, tells the caller of each, and
   * `state rm`s them, all before the plan, so the plan never destroys them.
   */
  private async forget(
    forget: ForgetRequest,
    step: (
      args: string[],
      stream: boolean,
    ) => Promise<StepResult | TofuFailure>,
  ): Promise<TofuFailure | null> {
    const shown = await step(['show', '-json', '-no-color'], false);
    if (isFailure(shown)) return shown;
    const found = instancesOf(
      JSON.parse(shown.stdout || '{}') as ShownState,
      forget,
    );
    if (found.length === 0) return null;
    try {
      await forget.before(found);
    } catch (error) {
      return {
        ok: false,
        reason: 'failed',
        message: `Nothing was changed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const removed = await step(
      [
        'state',
        'rm',
        STATE_LOCK_TIMEOUT,
        '--',
        ...found.map((one) => one.address),
      ],
      true,
    );
    return isFailure(removed) ? removed : null;
  }

  private async readState<Resource>(
    request: TofuStateReadRequest<TofuCredential>,
    project: StateProjection<Resource>,
  ): Promise<TofuStateOutcome<Resource>> {
    const providers = providersFor(request.credential);
    const install = await this.checkInstall(providers);
    if (install) return install;
    const binary = this.options.binary as string;
    const folder = await mkdtemp(
      join(this.options.workRoot ?? tmpdir(), 'cloudgate-tofu-'),
    );
    try {
      await this.prepare(folder, request);
      const env = this.environment(folder, request);
      const interruption = new Interruption(undefined);
      const step = async (
        args: string[],
      ): Promise<StepResult | TofuFailure> => {
        const result = await runStep(binary, args, {
          cwd: folder,
          env,
          interruption,
        });
        return result.code === 0
          ? result
          : classify(result, request.stateId, providers);
      };

      const init = await step([
        'init',
        '-input=false',
        '-no-color',
        '-lockfile=readonly',
      ]);
      if (isFailure(init)) return init;
      const listed = await step(['workspace', 'list']);
      if (isFailure(listed)) return listed;
      const workspaces = listed.stdout
        .split('\n')
        .map((line) => line.replace(/^\*/, '').trim());
      if (!workspaces.includes(request.stateId)) {
        return { ok: true, resources: [] };
      }
      const selected = await step([
        'workspace',
        'select',
        '--',
        request.stateId,
      ]);
      if (isFailure(selected)) return selected;
      const shown = await step(['show', '-json', '-no-color']);
      if (isFailure(shown)) return shown;
      const state = JSON.parse(shown.stdout || '{}') as TofuStateShow;
      return { ok: true, resources: project(state) };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  /**
   * The installed OpenTofu and the run's providers against this checkout's
   * pins, before anything runs: a run never downloads code, so a
   * missing or wrong one is the install's to fix.
   */
  private async checkInstall(
    providers: readonly PinnedProvider[],
  ): Promise<TofuFailure | null> {
    const { binary, providerMirror, stateDatabaseUrl } = this.options;
    const mismatch = (message: string): TofuFailure => ({
      ok: false,
      reason: 'install-mismatch',
      message: `${message} Re-run install.sh.`,
    });
    if (!binary || !existsSync(binary)) {
      return mismatch(
        `OpenTofu ${OPENTOFU_VERSION} is not installed${binary ? ` at ${binary}` : ''}.`,
      );
    }
    const found = await installedVersion(binary);
    if (found !== OPENTOFU_VERSION) {
      return mismatch(
        `The installed OpenTofu is ${found ?? 'unreadable'}, and this Cloudgate runs OpenTofu ${OPENTOFU_VERSION}.`,
      );
    }
    const missing = providers.find(
      (provider) => !providerMirror || !hasProvider(providerMirror, provider),
    );
    if (missing) {
      return mismatch(
        `The ${providerName(missing)} is not in the provider mirror${providerMirror ? ` ${providerMirror}` : ''}.`,
      );
    }
    if (!stateDatabaseUrl) {
      return mismatch(
        'The Infrastructure state login (INFRASTRUCTURE_STATE_DATABASE_URL) is not set.',
      );
    }
    return null;
  }

  private async prepare(
    folder: string,
    request: Pick<TofuRunRequest<TofuCredential>, 'definition' | 'credential'>,
  ) {
    const pins = pinsFor(
      {
        versions: await readFile(
          join(this.options.pinsDirectory, VERSIONS_FILE),
          'utf8',
        ),
        lock: await readFile(
          join(this.options.pinsDirectory, LOCK_FILE),
          'utf8',
        ),
      },
      providersFor(request.credential),
    );
    await writeFile(join(folder, VERSIONS_FILE), pins.versions);
    await writeFile(join(folder, LOCK_FILE), pins.lock);
    await writeFile(
      join(folder, 'main.tf.json'),
      renderDefinition(request.definition),
      { mode: 0o600 },
    );
    if (this.options.providerOverride) {
      await writeFile(
        join(folder, OVERRIDE_FILE),
        JSON.stringify(this.options.providerOverride),
        { mode: 0o600 },
      );
    }
    await writeFile(
      join(folder, CLI_CONFIG_FILE),
      opentofuCliConfig(this.options.providerMirror as string),
      { mode: 0o600 },
    );
    if (isGoogle(request.credential)) {
      await writeFile(
        join(folder, GOOGLE_CREDENTIAL_FILE),
        request.credential.credentialConfiguration,
        { mode: 0o600 },
      );
    }
  }

  private environment(
    folder: string,
    request: Pick<TofuRunRequest<TofuCredential>, 'credential' | 'variables'>,
  ): NodeJS.ProcessEnv {
    const variables = Object.fromEntries(
      Object.entries(request.variables ?? {}).map(([name, value]) => [
        `TF_VAR_${name}`,
        value,
      ]),
    );
    return {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      // A home of its own, so no `~/.aws`, `~/.terraformrc` or plugin cache
      // of the service user's is read.
      HOME: folder,
      TF_CLI_CONFIG_FILE: join(folder, CLI_CONFIG_FILE),
      TF_IN_AUTOMATION: '1',
      TF_INPUT: '0',
      PG_CONN_STR: this.options.stateDatabaseUrl,
      TF_ENCRYPTION: stateEncryption(this.options.appEncryptionSecret),
      ...credentialEnvironment(folder, request.credential),
      ...variables,
    };
  }
}

function isGoogle(credential: TofuCredential): credential is GoogleCredential {
  return 'credentialConfiguration' in credential;
}

function providersFor(credential: TofuCredential): readonly PinnedProvider[] {
  return isGoogle(credential) ? GOOGLE_PROVIDERS : AWS_PROVIDERS;
}

/** `AWS provider 6.69.1`, or `Google provider 8.8.0`. */
function providerName(provider: PinnedProvider): string {
  return `${PROVIDER_NAMES[provider]} ${PINNED_PROVIDERS[provider]}`;
}

/** How a run's provider finds its cloud's credential (the Google Cloud spec). */
function credentialEnvironment(
  folder: string,
  credential: TofuCredential,
): NodeJS.ProcessEnv {
  if (isGoogle(credential)) {
    return {
      GOOGLE_APPLICATION_CREDENTIALS: join(folder, GOOGLE_CREDENTIAL_FILE),
    };
  }
  return {
    AWS_ACCESS_KEY_ID: credential.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credential.secretAccessKey,
    ...(credential.sessionToken
      ? { AWS_SESSION_TOKEN: credential.sessionToken }
      : {}),
    AWS_EC2_METADATA_DISABLED: 'true',
  };
}

/**
 * The run's side of the two-step signal: the interrupt reaches whichever
 * step's `tofu` is running (or stops the next one starting), the kill its
 * process group. Each step's child registers itself while it runs.
 */
class Interruption {
  killed = false;
  private child: { pid: number } | null = null;

  constructor(private readonly signal: TofuRunSignal | undefined) {
    signal?.onInterrupt(() => {
      if (this.child) signalProcess(this.child.pid, 'SIGINT');
      this.wake?.();
    });
    signal?.onKill(() => {
      this.killed = true;
      // The negative pid is the group: `tofu` and the provider it started.
      if (this.child) signalProcess(-this.child.pid, 'SIGKILL');
      this.wake?.();
    });
  }

  /** Ends a {@link pause} early. */
  private wake: (() => void) | null = null;

  /** Waits `ms` between steps, or less when the run is ended meanwhile. */
  pause(ms: number): Promise<void> {
    if (this.happened) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  get happened(): boolean {
    return this.signal?.interrupted ?? false;
  }

  attach(pid: number) {
    this.child = { pid };
  }

  detach() {
    this.child = null;
  }

  failure(): TofuFailure {
    return {
      ok: false,
      reason: 'interrupted',
      message: this.killed
        ? 'The run was interrupted, and OpenTofu and its provider were killed when they had not stopped in time.'
        : 'The run was interrupted; OpenTofu stopped and saved the state.',
    };
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH: it exited between the decision and the signal.
  }
}

function runStep(
  binary: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    onLine?: (line: string) => void;
    interruption: Interruption;
  },
): Promise<StepResult> {
  return new Promise((resolve) => {
    let printed = '';
    let stdout = '';
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) options.interruption.attach(child.pid);
    const out = lineSplitter(options.onLine);
    const err = lineSplitter(options.onLine);
    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      printed += text;
      out.push(text);
    });
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      printed += text;
      err.push(text);
    });
    const finish = (code: number | null, extra = '') => {
      options.interruption.detach();
      out.end();
      err.end();
      resolve({ code, printed: printed + extra, stdout });
    };
    child.on('error', (error) => finish(null, `\n${error.message}`));
    // `tofu` itself has stopped: there is nothing left to kill, even while a
    // last line is still on its way through the pipes.
    child.on('exit', () => options.interruption.detach());
    child.on('close', (code) => finish(code));
  });
}

/**
 * What a run prints, as the Deployment log may hold it (the AWS spec
 * "Variables": values are `sensitive`, plans and logs show names only).
 * OpenTofu already prints a sensitive value as `(sensitive value)`, which
 * reads here as "(sensitive)"; and should a provider's error quote one,
 * every value handed to the run as a variable — each line of a value on
 * several, as a PEM is — is replaced with "(sensitive)" too. Values shorter
 * than {@link SCRUBBED_MIN_LENGTH} are left to OpenTofu's own mask: blanking
 * every `1` or `on` would garble the log without hiding anything.
 */
/** `tofu show -json` of a state: only what {@link instancesOf} reads. */
interface ShownState {
  values?: {
    root_module?: {
      resources?: {
        address?: string;
        mode?: string;
        type?: string;
        name?: string;
        index?: unknown;
        tainted?: boolean;
        values?: Record<string, unknown> | null;
      }[];
    };
  } | null;
}

/** The instances of `forget.resource` whose key is not among `keep`. */
function instancesOf(
  state: ShownState,
  forget: ForgetRequest,
): ForgottenInstance[] {
  const text = (value: unknown) =>
    typeof value === 'string' && value !== '' ? value : null;
  return (state.values?.root_module?.resources ?? [])
    .filter(
      (one) =>
        one.mode === 'managed' &&
        `${one.type}.${one.name}` === forget.resource &&
        typeof one.index === 'string' &&
        !forget.keep.includes(one.index) &&
        typeof one.address === 'string',
    )
    .flatMap((one) => {
      const arn = text(one.values?.arn);
      return arn
        ? [
            {
              address: one.address!,
              arn,
              region: text(one.values?.region),
              domainName: text(one.values?.domain_name),
            },
          ]
        : [];
    });
}

export function scrubber(values: readonly string[]): (line: string) => string {
  const pieces = [
    ...new Set(
      values
        .flatMap((value) => value.split(/\r?\n/))
        .filter((piece) => piece.length >= SCRUBBED_MIN_LENGTH),
    ),
  ].sort((a, b) => b.length - a.length);
  return (line) => {
    let scrubbed = line.replace(/\(sensitive value\)/g, SCRUBBED);
    for (const piece of pieces) scrubbed = scrubbed.split(piece).join(SCRUBBED);
    return scrubbed;
  };
}

/** How a value reads where a run's output would have printed it. */
export const SCRUBBED = '(sensitive)';

/** The shortest value {@link scrubber} replaces. */
export const SCRUBBED_MIN_LENGTH = 4;

/** Calls `onLine` once per whole line, holding a partial one until it ends. */
function lineSplitter(onLine?: (line: string) => void) {
  let partial = '';
  return {
    push(text: string) {
      if (!onLine) return;
      const lines = (partial + text).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) onLine(line.replace(/\r$/, ''));
    },
    end() {
      if (onLine && partial) onLine(partial);
      partial = '';
    },
  };
}

/**
 * What a failed step's words say happened, in the operator's terms; a
 * provider the mirror lacks is named by the run's cloud's first provider.
 */
export function classify(
  result: StepResult,
  stateId: string,
  providers: readonly PinnedProvider[],
): TofuFailure {
  const printed = result.printed;
  const firstError =
    /Error: (.+)/.exec(printed)?.[1]?.trim() ??
    printed.trim().split('\n').pop() ??
    'OpenTofu exited without saying why';
  // Before the lock-held test: the `pg` backend reports its shared creation
  // key, taken beside every state's own, as a failure to lock this state.
  if (/already locked for workspace creation/i.test(printed)) {
    return {
      ok: false,
      reason: 'state-backend-busy',
      message: `OpenTofu's state backend stayed busy making another Infrastructure state while this run waited to lock Infrastructure state ${stateId}. Nothing was changed; try again.`,
    };
  }
  if (/Error acquiring the state lock/.test(printed)) {
    return {
      ok: false,
      reason: 'lock-held',
      message: `Another run is using this state (Infrastructure state ${stateId}). Try again when it has finished.`,
    };
  }
  if (/decryption failed|error loading state/i.test(printed)) {
    return {
      ok: false,
      reason: 'unreadable-state',
      message: `Cloudgate cannot read Infrastructure state ${stateId}: ${firstError}. Nothing was changed, and the state is left as it is.`,
    };
  }
  if (
    /dependency lock file|not found in any of the\s+search locations/.test(
      printed,
    )
  ) {
    return {
      ok: false,
      reason: 'install-mismatch',
      message: `The installed ${PROVIDER_NAMES[providers[0]]} is not the ${PINNED_PROVIDERS[providers[0]]} this Cloudgate pins (${firstError}). Re-run install.sh.`,
    };
  }
  return { ok: false, reason: 'failed', message: firstError };
}

/** What {@link tagsNotYetApplied} found: the resources, and their kinds as the AWS provider names them. */
export interface TagRace {
  /** Each resource's address, e.g. `aws_codebuild_project.build`. */
  readonly addresses: readonly string[];
  /** Each kind once, e.g. `CodeBuild Project`. */
  readonly kinds: readonly string[];
}

/**
 * Whether a failed apply failed only because AWS had not yet applied a new
 * resource's tags to its permissions. The deploy role reaches most
 * of what it makes only through `aws:ResourceTag` (the setup template,
 * ADR-0036), and the AWS provider reads a resource back the moment its
 * create returns, before IAM has caught up with the tag the create put on
 * it. Every error printed must be that one shape: the provider's
 * `reading <kind> (<id>)` refused as AccessDenied, "not authorized to
 * perform", on a resource whose `Creating...` this same apply printed.
 * Anything else (another error beside it, a refused read of something the
 * apply did not create, a Google run) is `null`, and fails as it always has.
 */
export function tagsNotYetApplied(
  printed: string,
  providers: readonly PinnedProvider[],
): TagRace | null {
  if (!providers.includes('aws')) return null;
  // With colour off `tofu` draws no box, but a line may still carry one.
  const lines = printed
    .split('\n')
    .map((line) => line.replace(/\r$/, '').replace(/^[│╷╵] ?/, ''));
  const starts = lines.flatMap((line, at) =>
    /^Error: /.test(line) ? [at] : [],
  );
  if (starts.length === 0) return null;
  const creating = new Set(
    lines.flatMap((line) => /^(\S.*): Creating\.\.\.$/.exec(line)?.[1] ?? []),
  );
  const addresses: string[] = [];
  const kinds: string[] = [];
  for (const [n, start] of starts.entries()) {
    const block = lines.slice(start, starts[n + 1] ?? lines.length);
    const kind = /^Error: reading (.+?) \(/.exec(block[0])?.[1];
    const address = block
      .map((line) => /^\s*with (.+),$/.exec(line)?.[1])
      .find((found) => found !== undefined);
    const refused =
      /AccessDenied/.test(block[0]) &&
      /not authorized to perform/.test(block[0]);
    if (!kind || !address || !refused || !creating.has(address)) return null;
    if (!addresses.includes(address)) addresses.push(address);
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return { addresses, kinds };
}

/** Which of `addresses` the state holds as tainted. */
function taintedAddresses(
  state: ShownState,
  addresses: readonly string[],
): string[] {
  return (state.values?.root_module?.resources ?? []).flatMap((one) =>
    one.tainted === true &&
    typeof one.address === 'string' &&
    addresses.includes(one.address)
      ? [one.address]
      : [],
  );
}

/** A plan's resource changes that change something: each address's actions. */
function changesOf(show: TofuShow): Map<string, string> {
  const changes = (show.resource_changes ?? []) as {
    address?: unknown;
    change?: { actions?: string[] };
  }[];
  return new Map(
    changes.flatMap((one): [string, string][] => {
      const actions = one.change?.actions ?? [];
      return typeof one.address === 'string' &&
        actions.some((action) => action !== 'no-op' && action !== 'read')
        ? [[one.address, actions.join('-')]]
        : [];
    }),
  );
}

/**
 * What `again` changes that `first` did not change at the same address in
 * the same way, as words (`create aws_iam_role.extra`), or `null` when
 * `again` only finishes what `first` set out to do.
 */
function changesBeyond(first: TofuShow, again: TofuShow): string | null {
  const allowed = changesOf(first);
  const beyond = [...changesOf(again)]
    .filter(([address, actions]) => allowed.get(address) !== actions)
    .map(([address, actions]) => `${actions} ${address}`);
  return beyond.length === 0 ? null : beyond.join('; ');
}

/** `a`, `a and b`, `a, b and c`. */
function wordList(words: readonly string[]): string {
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

async function installedVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn(binary, ['version', '-json'], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(stdout) as { terraform_version?: unknown };
        resolve(
          typeof parsed.terraform_version === 'string'
            ? parsed.terraform_version
            : null,
        );
      } catch {
        resolve(null);
      }
    });
  });
}

function hasProvider(mirror: string, provider: PinnedProvider): boolean {
  try {
    return readdirSync(providerDirectory(mirror, provider)).some((name) =>
      name.startsWith(`terraform-provider-${provider}`),
    );
  } catch {
    return false;
  }
}

/**
 * The plan as the reader reads it, less `variables`: OpenTofu prints every
 * variable's value there in clear, sensitive or not, with no mask beside it,
 * and the default certificate's key is one of them. Values inside resources
 * stay, behind the `*_sensitive` masks the plan reader honours.
 */
function withoutVariables(json: string): TofuShow {
  const show = JSON.parse(json) as TofuShow;
  delete show.variables;
  return show;
}

function outputValues(json: string): Record<string, unknown> {
  const outputs = JSON.parse(json || '{}') as Record<
    string,
    { value?: unknown }
  >;
  return Object.fromEntries(
    Object.entries(outputs).map(([name, output]) => [name, output.value]),
  );
}

function isFailure<T extends object>(
  value: T | TofuFailure,
): value is TofuFailure {
  return 'ok' in value && value.ok === false;
}
