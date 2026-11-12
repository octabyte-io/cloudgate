// Bundles the CLI into one file, `dist/cloudgate.mjs`, which
// `bin/cloudgate.js` loads (ADR 0046).
//
// Everything is bundled, `api-schemas` and zod included, but the keychain
// (`external` below), so the published package's one runtime dependency is
// that optional native module, and `npx @octabyte-io/cloudgate` still works
// where it does not install. The `source` condition makes esbuild read
// `api-schemas` from its TypeScript rather than its CommonJS `dist/`, so zod is
// bundled once, as ESM.
//
// The version is stamped in from package.json, so `--version` cannot disagree
// with what npm published.
//
// `cloudgate template check` carries the backend's own Template check, bundled
// from its source (`src/template-check.d.ts` says why it is not shared through
// `api-schemas`), with the backend version it is that Cloudgate's check of.
// That source is CommonJS that reads `require` and `__dirname`, which an ES
// module bundle does not have, so the banner gives it both. Nest's optional
// `class-transformer` and `class-validator` are required lazily, never on the
// check's path, and are left out rather than installed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);
const { version: checkVersion } = JSON.parse(
  readFileSync(new URL('../backend/package.json', import.meta.url), 'utf8'),
);

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/cloudgate.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  conditions: ['source'],
  // The keychain is native code, a prebuilt binary per platform that cannot be
  // bundled: it stays a package, the CLI's one optional dependency, loaded on
  // first use (`osKeychain` in src/logins.ts) and skipped where it is absent.
  external: ['@napi-rs/keyring', 'class-transformer', 'class-validator'],
  alias: {
    'cloudgate-template-check': fileURLToPath(
      new URL('../backend/src/templates/check/index.ts', import.meta.url),
    ),
  },
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      "const __dirname = __fileURLToPath(new URL('.', import.meta.url));",
    ].join('\n'),
  },
  define: {
    __CLOUDGATE_VERSION__: JSON.stringify(version),
    __CLOUDGATE_CHECK_VERSION__: JSON.stringify(checkVersion),
  },
  legalComments: 'none',
  logLevel: 'warning',
});
