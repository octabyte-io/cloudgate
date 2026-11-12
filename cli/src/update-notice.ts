/**
 * The update notice (CLI spec, Output conventions): when npm has a newer
 * CLI, say so on stderr with the exact command to get it.
 *
 * - **Only in a terminal.** Never when `CI` is set, when stdout or stderr is
 *   not a terminal, or with `CLOUDGATE_NO_UPDATE_NOTIFIER`; in those runs npm
 *   is not asked and the state file is not touched.
 * - **At most once a day.** npm is asked at most once every 24 hours, and the
 *   notice is shown at most once every 24 hours; both times are kept in the
 *   state file in the config folder.
 * - **npm only.** The newest version is npm's `latest` (and `next`, for
 *   someone already running a prerelease); never the Instance's version.
 * - **Never in the way.** npm is asked while the command runs. When the
 *   command is done first, the question is dropped, not waited for, and is
 *   asked again next run; every failure (npm, the network, the state file) is
 *   swallowed. No self-update, no `upgrade` command.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PACKAGE_NAME = '@octabyte-io/cloudgate';
const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A backstop for a long command; a short one drops the question sooner. */
const NPM_TIMEOUT_MS = 5000;

export interface UpdateCheckState {
  /** When npm last answered (or failed to). */
  checkedAt?: string;
  /** The newest version npm had then, and the dist-tag it came from. */
  newest?: { version: string; distTag: 'latest' | 'next' };
  /** When the notice was last shown. */
  notifiedAt?: string;
}

/** Where the state lives between runs: a file in the config folder. */
export interface UpdateStateStore {
  read(): Promise<unknown>;
  write(state: UpdateCheckState): Promise<void>;
}

/**
 * The state as `update-check.json` in the config folder (`configDir`), which
 * is created, private to the user, on the first write.
 */
export function fileUpdateStateStore(dir: string): UpdateStateStore {
  const file = join(dir, 'update-check.json');
  return {
    async read() {
      try {
        return JSON.parse(await readFile(file, 'utf8')) as unknown;
      } catch {
        return undefined;
      }
    },
    async write(state) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    },
  };
}

export interface UpdateCheckFacts {
  /** This CLI's version. */
  current: string;
  env: Record<string, string | undefined>;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  now: () => Date;
  fetch: typeof fetch;
  store: UpdateStateStore;
}

export interface UpdateCheck {
  /**
   * Called when the command is done: drops a question npm has not answered
   * yet, and gives the notice to print on stderr, if one is due. Never
   * rejects and never waits on npm.
   */
  finish(): Promise<string | undefined>;
}

/** Set means non-empty, as for `CI` and `NO_COLOR` everywhere in this CLI. */
function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

const SILENT: UpdateCheck = { finish: () => Promise.resolve(undefined) };

export function startUpdateCheck(facts: UpdateCheckFacts): UpdateCheck {
  if (
    isSet(facts.env.CI) ||
    isSet(facts.env.CLOUDGATE_NO_UPDATE_NOTIFIER) ||
    !facts.stdoutIsTTY ||
    !facts.stderrIsTTY
  ) {
    return SILENT;
  }
  const controller = new AbortController();
  const work = checkAndDecide(facts, controller.signal).catch(() => undefined);
  return {
    async finish() {
      // Whatever has already settled (a remembered answer, or npm's if it has
      // come) is used; a question still out is dropped.
      const dropped = Symbol('dropped');
      const outcome = await Promise.race([
        work,
        new Promise<typeof dropped>((resolve) =>
          setImmediate(() => resolve(dropped)),
        ),
      ]);
      if (outcome !== dropped) return outcome;
      controller.abort();
      // The abort settles `work` at once; its notice is still shown if the
      // remembered state already called for one.
      return work;
    },
  };
}

async function checkAndDecide(
  facts: UpdateCheckFacts,
  signal: AbortSignal,
): Promise<string | undefined> {
  const now = facts.now();
  let state = parseState(await quietly(() => facts.store.read()));
  let changed = false;
  if (!within(state.checkedAt, now)) {
    const newest = await askNpm(facts, signal);
    // A question dropped because the command was done is asked again next
    // run; one npm answered, or failed, counts as today's check.
    if (!signal.aborted) {
      state = { ...state, checkedAt: now.toISOString(), newest };
      if (!newest) delete state.newest;
      changed = true;
    }
  }
  const newest = state.newest;
  const due =
    newest !== undefined &&
    compareVersions(newest.version, facts.current) > 0 &&
    !within(state.notifiedAt, now);
  if (due) {
    state = { ...state, notifiedAt: now.toISOString() };
    changed = true;
  }
  if (changed) await quietly(() => facts.store.write(state));
  if (!due) return undefined;
  return (
    `\nA new version is out: ${newest.version} (you have ${facts.current}).\n` +
    `Update: npm install -g ${PACKAGE_NAME}@${newest.distTag}\n`
  );
}

/** Whether `at` is less than a day before `now`. */
function within(at: string | undefined, now: Date): boolean {
  if (at === undefined) return false;
  const then = Date.parse(at);
  return (
    Number.isFinite(then) &&
    now.getTime() - then < DAY_MS &&
    now.getTime() >= then
  );
}

/**
 * npm's newest version for this person: `latest`, and `next` too when they
 * already run a prerelease, whichever is higher. Undefined when npm cannot say.
 */
async function askNpm(
  facts: UpdateCheckFacts,
  signal: AbortSignal,
): Promise<UpdateCheckState['newest']> {
  try {
    const response = await facts.fetch(DIST_TAGS_URL, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(NPM_TIMEOUT_MS)]),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    const tags = (await response.json()) as Record<string, unknown>;
    const candidates: Array<'latest' | 'next'> = isPrerelease(facts.current)
      ? ['latest', 'next']
      : ['latest'];
    let newest: UpdateCheckState['newest'];
    for (const distTag of candidates) {
      const version = tags[distTag];
      if (typeof version !== 'string' || !parseVersion(version)) continue;
      if (!newest || compareVersions(version, newest.version) > 0) {
        newest = { version, distTag };
      }
    }
    return newest;
  } catch {
    return undefined;
  }
}

/**
 * A state file read back. Anything unexpected in it makes the whole file count
 * as never checked, so a damaged file costs one question to npm, not a notice
 * that never comes.
 */
function parseState(raw: unknown): UpdateCheckState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const { checkedAt, notifiedAt, newest } = raw as Record<string, unknown>;
  const state: UpdateCheckState = {};
  for (const [key, value] of [
    ['checkedAt', checkedAt],
    ['notifiedAt', notifiedAt],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== 'string') return {};
    state[key] = value;
  }
  if (newest !== undefined) {
    const { version, distTag } = (newest ?? {}) as Record<string, unknown>;
    if (
      typeof version !== 'string' ||
      !parseVersion(version) ||
      (distTag !== 'latest' && distTag !== 'next')
    ) {
      return {};
    }
    state.newest = { version, distTag };
  }
  return state;
}

/** Runs a state-file call, turning a throw or a rejection into `undefined`. */
async function quietly<T>(call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch {
    return undefined;
  }
}

interface Version {
  core: [number, number, number];
  prerelease: string[];
}

function parseVersion(version: string): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(
    version,
  );
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function isPrerelease(version: string): boolean {
  return (parseVersion(version)?.prerelease.length ?? 0) > 0;
}

/**
 * semver 2.0.0 precedence: positive when `a` is newer than `b`. A version that
 * does not parse is never newer.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  }
  // A version without a prerelease part is newer than one with.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    const x = left.prerelease[i];
    const y = right.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
