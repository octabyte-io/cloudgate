'use strict';

/**
 * Everything `test/jest-e2e.json` and `test/jest-db.json` share. Each of them
 * is now three keys — a `preset` pointing here, its own `rootDir`, and its own
 * `testRegex` — and nothing else.
 *
 * **Why this file exists.** The two configs used to spell out fourteen keys
 * each and eight of them byte for byte: `transform`, `transformIgnorePatterns`,
 * `testTimeout`, `logHeapUsage`, `workerIdleMemoryLimit`, `maxWorkers`,
 * `moduleFileExtensions` and `testEnvironment`, plus a `resolver`, a
 * `globalSetup`/`globalTeardown` pair and a `reporters` list that differed only
 * by how far `<rootDir>` sat from `test/`. Nothing kept them in step, and the
 * two facts that matter to a reader of `docs/testing.md` were both
 * coincidences waiting to lapse: `npm run test:db` takes the same machine-wide
 * lock only because it lists the same `globalSetup`, and it is covered by the
 * stall watchdog only because it lists the same `reporters`. A
 * transform or a reporter added to one config would have silently missed the
 * other.
 *
 * **What this does not remove.** The unit `jest` block in `package.json` is
 * deliberately *not* on this preset — it must not inherit `globalSetup`, and
 * jest offers no way to take part of a preset — so five of the keys below are
 * still spelled a second time there, byte for byte: `moduleFileExtensions`,
 * `testEnvironment`, `testTimeout`, `transform` and `transformIgnorePatterns`,
 * plus a `resolver` naming the same file by a `<rootDir>`-relative path. The
 * drift this file prevents is therefore between the two Docker configs only;
 * between here and the unit config it is still live, and a
 * `transformIgnorePatterns` entry added for a new ESM dependency still has to
 * be added twice. `backend/README.md` says so where it prices the rest of
 * these settings.
 *
 * **And now the `globalSetup`/`globalTeardown`/`reporters` triple is
 * spelled there too — differently, which is the point.** The unit config arms
 * the same stall watchdog through the same reporter, so leaving it uncovered
 * was a real hole (a hung `npx jest` was unbounded and silent); but it cannot
 * take this preset's hooks, whose whole job is the shared Postgres and the
 * machine-wide lock. So it names `utils/unit-global-setup.ts` and
 * `utils/unit-global-teardown.ts`, and it names this same
 * `utils/heartbeat-reporter.js` with a `{ lane: 'unit' }` option so the two
 * runs cannot write one another's heartbeat file. The residual drift is
 * therefore *four* facts wide rather than five, and the fourth is not
 * duplication that could be removed: `test/utils/unit-lane-watchdog.spec.ts`
 * holds it instead of a shared spelling.
 *
 * **Why JavaScript and not a `jest-preset.json`.** The paths. Jest resolves a
 * preset's own `resolver`/`globalSetup`/`reporters` values against the
 * *consuming* config's `rootDir`, so a `<rootDir>`-relative spelling cannot
 * serve both — `jest-e2e.json` roots at `test/` and `jest-db.json` at
 * `backend/`, because each one's `testRegex` is written against its own root.
 * `__dirname` is the fix: an absolute path is the same path from either root,
 * and this file always sits beside the things it names. The alternative was to
 * move both configs onto one `rootDir`, which changes which tree jest crawls
 * for tests under a config the whole suite runs through — a bigger change than
 * the duplication it removes.
 *
 * **Each `preset` names this file, extension and all.** Jest appends
 * `jest-preset` to a `preset` only when the resolved value is *relative*; a
 * `<rootDir>` token expands to an absolute path, which jest then resolves
 * verbatim — so `"preset": "<rootDir>"` fails with *Preset … not found
 * relative to rootDir* rather than finding this file beside it.
 *
 * **`maxWorkers` and `workerIdleMemoryLimit` are load-bearing values, not
 * tidiness.** `backend/README.md` and `docs/testing.md` price both: without
 * the recycle one worker reached V8's 4288 MB ceiling and OOMed at suite 109
 * of 114, and `utils/worker-budget.js` sizes the worker count to the machine's memory
 * on the strength of that recycle. Do not remove the limit to make a run
 * faster.
 */

const { join } = require('node:path');
const { e2eWorkers } = require('./utils/worker-budget');

/** A path beside this file, absolute, so it reads the same from either root. */
const here = (relative) => join(__dirname, relative);

module.exports = {
  moduleFileExtensions: ['js', 'mjs', 'json', 'ts', 'tsx'],
  testEnvironment: 'node',
  testTimeout: 60000,
  transform: {
    '^.+\\.(t|j)sx?$': 'ts-jest',
    '^.+\\.(m|c)js$': [
      'ts-jest',
      {
        diagnostics: false,
        tsconfig: {
          allowJs: true,
          module: 'commonjs',
          esModuleInterop: true,
          target: 'es2022',
          skipLibCheck: true,
        },
      },
    ],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!.*\\.mjs$)(?!.*(@noble|nanostores|jose|kysely|octokit|universal-user-agent|universal-github-app-jwt|before-after-hook|@react-email|ai|@ai-sdk|ai-sdk-ollama|@workflow)[+/@])',
  ],
  resolver: here('octokit-resolver.js'),
  // The shared Postgres and the machine-wide lock. Listing it here is what
  // makes `npm run test:db` take that lock by construction rather than by
  // both configs happening to name the same file.
  globalSetup: here('utils/global-setup.ts'),
  globalTeardown: here('utils/global-teardown.ts'),
  // Likewise the stall watchdog: it is armed from `globalSetup` and reads the
  // heartbeat this reporter writes, so the pair has to travel together.
  reporters: ['default', here('utils/heartbeat-reporter.js')],
  // A cheap password hash for every test file: better-auth's scrypt was a
  // fifth to a third of an auth-heavy suite. The file says what it matches.
  setupFiles: [here('utils/cheap-password-hash.ts')],
  logHeapUsage: true,
  workerIdleMemoryLimit: '1.5GB',
  // As many as the machine has room for, up to 4, or CLOUDGATE_E2E_WORKERS:
  // `utils/worker-budget.js` says why and how it is measured.
  maxWorkers: e2eWorkers(),
};
