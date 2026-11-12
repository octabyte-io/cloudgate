import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/** The backend whose Template check and setup the CLI bundles (`build.mjs`). */
const backend = (path: string) =>
  fileURLToPath(new URL(`../backend/${path}`, import.meta.url));
const { version: checkVersion } = JSON.parse(
  readFileSync(backend('package.json'), 'utf8'),
) as { version: string };

/**
 * The CLI's own fast lane: pure rules, no server (CLI spec, Testing
 * Decisions). What the built command does against an Instance is the one CLI
 * e2e suite's job, in `backend/test/cli/`.
 *
 * `source` resolves `api-schemas` to its TypeScript, as the bundle does
 * (`build.mjs`), so a test never reads a stale `dist/`. It goes on the ssr
 * environment, where node tests resolve: the top-level `resolve.conditions`
 * feeds only the client one. The rest of the list is Vite's own server
 * default, which setting it would otherwise replace.
 *
 * `cloudgate-template-check` is the backend's Template check read from its
 * source, as the bundle reads it, so the CLI's test runs the real check;
 * `cloudgate-template-setup` is its setup values and compose file
 * preparation, the same way.
 */
export default defineConfig({
  resolve: {
    alias: {
      'cloudgate-template-check': backend('src/templates/check/index.ts'),
      'cloudgate-template-setup': backend('src/templates/setup/cli-bundle.ts'),
    },
  },
  ssr: {
    resolve: {
      conditions: ['source', 'module', 'node', 'development|production'],
    },
  },
  define: {
    __CLOUDGATE_VERSION__: JSON.stringify('0.0.0-test'),
    __CLOUDGATE_CHECK_VERSION__: JSON.stringify(checkVersion),
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
