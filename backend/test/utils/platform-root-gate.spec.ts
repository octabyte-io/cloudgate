import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  cloudgateDirectoryOn,
  REMOTE_CLOUDGATE_DIRECTORY,
} from '../../src/common/config/cloudgate-directory';
import { TEST_PLATFORM_ROOT, separatePlatformRoot } from './platform-root';

/**
 * **Every lane runs with the platform host's root distinct from a Server's**.
 *
 * The gate is one call in each lane's `globalSetup`, and what it holds is the
 * suites found green only because the two roots were one string.
 * Deleting that call would not red anything: every one of those suites takes
 * its expectation from the machine now, so they pass under
 * either root, and the class they were fixed for would come back unseen with
 * the next test to spell `/etc/cloudgate` for the platform host. So the gate
 * gets a test of its own, and this is it.
 *
 * **Read off the three configs, then run the hook each one names**, the device
 * `unit-lane-watchdog.spec.ts` uses and for its reason: a `globalSetup` path is
 * not evidence of what the module behind it does. The two Docker configs take
 * theirs through `test/jest-preset.js`, so a third config added on that preset
 * is covered without an edit here, and one added beside it is not — which is
 * why the list below is a list of configs rather than of hooks.
 *
 * The doubles are the harness's own modules and nothing else (§1.7 allows a
 * `jest.mock` of a test util): `./test-postgres` so the e2e hook takes no
 * machine-wide lock and starts no container from a unit run, and
 * `./stall-watchdog` so no five-minute timer is armed inside this worker.
 */

const backendRoot = join(__dirname, '..', '..');

interface JestConfig {
  preset?: string;
  rootDir?: string;
  globalSetup?: string;
}

/** A `<rootDir>` path, against the directory that config's `rootDir` names. */
function resolveIn(configDir: string, config: JestConfig, value: string) {
  return value.replace('<rootDir>', join(configDir, config.rootDir ?? '.'));
}

/** The `globalSetup` a config names, directly or through its preset. */
function configuredGlobalSetup(configPath: string): string {
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as
    JestConfig | { jest: JestConfig };
  const config = 'jest' in raw ? raw.jest : raw;
  const configDir = dirname(configPath);
  if (config.globalSetup) {
    return resolveIn(configDir, config, config.globalSetup);
  }
  if (!config.preset) {
    throw new Error(`${configPath} names neither a globalSetup nor a preset`);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const preset = require(resolveIn(configDir, config, config.preset)) as {
    globalSetup?: string;
  };
  if (!preset.globalSetup) {
    throw new Error(`${config.preset} names no globalSetup`);
  }
  return preset.globalSetup;
}

/** Runs a `globalSetup` with the machine-wide doubles in place. */
async function runGlobalSetup(hookPath: string): Promise<void> {
  let hook: ((globalConfig?: unknown) => unknown) | undefined;
  try {
    jest.isolateModules(() => {
      jest.doMock('./stall-watchdog', () => ({ armStallWatchdog: jest.fn() }));
      jest.doMock('./test-postgres', () => ({
        ...jest.requireActual<Record<string, unknown>>('./test-postgres'),
        acquireE2eLock: jest.fn(() => Promise.resolve()),
        releaseE2eLock: jest.fn(),
        startSharedPostgres: jest.fn(() =>
          Promise.resolve({ adminUrl: 'postgresql://unused' }),
        ),
        rememberSharedPostgres: jest.fn(),
        createTemplateDatabase: jest.fn(() => Promise.resolve()),
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      hook = (require(hookPath) as { default: typeof hook }).default;
    });
  } finally {
    jest.dontMock('./stall-watchdog');
    jest.dontMock('./test-postgres');
  }
  // Outside `isolateModules`, whose callback is synchronous.
  await hook?.({});
}

describe('backend/test/utils/platform-root.ts — every lane runs with two roots', () => {
  describe('separatePlatformRoot', () => {
    it('sets the test root when nothing is configured', () => {
      const env: NodeJS.ProcessEnv = {};

      expect(separatePlatformRoot(env)).toBe(TEST_PLATFORM_ROOT);
      expect(env.CLOUDGATE_DIRECTORY).toBe(TEST_PLATFORM_ROOT);
    });

    it("replaces a configured root that is a Server's, however it is spelled", () => {
      for (const spelling of [
        '/etc/cloudgate',
        '/etc/cloudgate/',
        ' /etc/cloudgate ',
      ]) {
        const env: NodeJS.ProcessEnv = { CLOUDGATE_DIRECTORY: spelling };

        expect(separatePlatformRoot(env)).toBe(TEST_PLATFORM_ROOT);
      }
    });

    it('keeps a configured root that already differs, so a run can choose its own', () => {
      const env: NodeJS.ProcessEnv = { CLOUDGATE_DIRECTORY: '/srv/elsewhere' };

      expect(separatePlatformRoot(env)).toBe('/srv/elsewhere');
      expect(env.CLOUDGATE_DIRECTORY).toBe('/srv/elsewhere');
    });
  });

  describe.each([
    ['package.json (the unit lane)', join(backendRoot, 'package.json')],
    ['test/jest-e2e.json', join(backendRoot, 'test', 'jest-e2e.json')],
    ['test/jest-db.json', join(backendRoot, 'test', 'jest-db.json')],
  ])('%s — the two platform roots', (_name, configPath) => {
    const saved = { ...process.env };

    beforeEach(() => {
      delete process.env.CLOUDGATE_DIRECTORY;
    });

    afterEach(() => {
      // The e2e hook also publishes the doubled Postgres URL; none of it may
      // outlive this test.
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    });

    it("leaves the platform host's root distinct from a Server's", async () => {
      await runGlobalSetup(configuredGlobalSetup(configPath));

      expect(cloudgateDirectoryOn(null)).not.toBe(
        cloudgateDirectoryOn('any-server'),
      );
      expect(cloudgateDirectoryOn('any-server')).toBe(
        REMOTE_CLOUDGATE_DIRECTORY,
      );
    });
  });
});
