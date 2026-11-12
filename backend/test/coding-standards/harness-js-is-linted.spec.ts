import { execFileSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import tseslint from 'typescript-eslint';

/**
 * Linting the harness JS, the half of it that is a property rather than a
 * config edit.
 *
 * The harness has three hand-written CommonJS files — `test/octokit-resolver.js`
 * (both Docker configs' `resolver`), `test/utils/heartbeat-reporter.js` (every
 * e2e run's reporter, and the source of the heartbeat the stall watchdog reads)
 * and `test/jest-preset.js` (everything those two configs share). Until
 * this gate **nothing linted any of them**, and by two independent mechanisms:
 *
 * - `package.json`'s `scripts.lint` globbed `{ts,tsx}`, so eslint was never
 *   handed the files at all; and
 * - had it been handed them it would have refused — `projectService: true` with
 *   no `allowJs` in `tsconfig.json` answers `Parsing error: … was not found by
 *   the project service`.
 *
 * So the fix is two edits that only work together: `js` in the glob, and a last
 * `files: ['**\u002F*.js']` block in `eslint.config.mjs` that extends
 * `disableTypeChecked` and turns `projectService` off. **Either one alone is
 * worse than neither.** Growing the glob without the block turns three
 * silently-unlinted files into three parse errors and reds `pnpm lint`; adding
 * the block without the glob leaves a block that matches nothing, which is the
 * state this repo was in for the whole life of the two older files and is
 * invisible, because a config block that matches no file cannot fail.
 *
 * **And the block's position is load-bearing, which is the part a reader has no
 * way to see.** ESLint flat config is ordered: the block above it re-enables
 * `@typescript-eslint/no-floating-promises` and `no-unsafe-argument` with no
 * `files` key of its own, so it applies to *every* file, these three included.
 * `disableTypeChecked` therefore has to come *after* it. Move the `.js` block
 * up by one and those two rules load against a file that has no type
 * information, which is not a soft failure — the rule throws out of eslint and
 * the run dies. `eslint.config.mjs` says all of this in a comment, and a
 * comment is exactly what a later reorder will not read.
 *
 * **Why this is a jest test and not an eslint rule.** It is a property of the
 * lint configuration itself, so nothing inside that configuration can hold it —
 * `route-permissions.spec.ts`' and `describe-names.spec.ts`' argument, one
 * level further out. And it is asserted against the config **ESLint actually
 * resolves**, through `calculateConfigForFile`, rather than against the text of
 * `eslint.config.mjs`: a text assertion on block order would pass a rename,
 * fail a harmless reformat, and say nothing about what a file is really linted
 * with. The two regressions this exists for are those two edits coming apart,
 * and each is checked where it can be observed rather than where it is written.
 *
 * **Why eslint is asked in a child process.** `eslint.config.mjs` is ESM, and
 * ESLint reaches it with a dynamic `import()` — which inside a jest test
 * environment is `TypeError [ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG]: A
 * dynamic import callback was invoked without --experimental-vm-modules`. The
 * flag is not on this workspace's unit config and must not be added for one
 * spec, so the ESLint API is asked from a plain node process instead, in
 * `backend/`, and hands back JSON. The typescript-eslint import below has no
 * such trouble: the property — *every rule `disableTypeChecked` names* — is
 * read here, and only *what eslint resolved* comes from the child.
 *
 * What this does **not** assert is that the three files are free of lint
 * findings; that is `pnpm lint`'s job, and repeating it here would be a second,
 * slower copy of it. What it asserts is that they *parse* and that no rule
 * crashes on them, which is the failure both regressions produce.
 */

const backendRoot = join(__dirname, '..', '..');

/**
 * The harness's `.js` files, frozen. Discovering them would make this file
 * unable to fail on the thing worth failing on: a fourth one joins the glob and
 * the resolved config by itself, and would be asserted about correctly while
 * `eslint.config.mjs`' comment — which names all three and counts them — went
 * quietly wrong. That is the exact rot this gate was written over; the comment
 * said "the only two" in the very change that added the third. So a new one is
 * added here by hand, and adding it says the comment was read.
 */
const HARNESS_JS: readonly string[] = [
  'test/jest-preset.js',
  'test/octokit-resolver.js',
  'test/utils/heartbeat-reporter.js',
];

/** The two scripts that are the only way eslint is ever handed a file here. */
const LINT_SCRIPTS: readonly string[] = ['lint', 'lint:fix'];

/**
 * `backend/eslint.config.mjs`, which once `ignores`d itself and which no
 * glob in `package.json` reached — the workspace's lint globs root at
 * `{src,apps,libs,test}` and this file sits above all four. It is the file that
 * turns lint on for {@link HARNESS_JS}, so it is the last file that should have
 * been exempt from it, and `prettier --check` reded on it from before this gate.
 */
const LINT_CONFIG = 'eslint.config.mjs';

/** The script that is the only way prettier is ever handed a file here. */
const FORMAT_SCRIPT = 'format';

/* ------------------------------------------------------------------ *
 * 1. What the lint scripts reach.
 * ------------------------------------------------------------------ */

function packageScripts(): Record<string, string> {
  const parsed = JSON.parse(
    readFileSync(join(backendRoot, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  return parsed.scripts;
}

/**
 * **Every** quoted pattern a script hands its tool, not just the first.
 *
 * It was the first until the config file was added, which is a shape this file
 * could not have expressed: one glob cannot reach both
 * `{src,apps,libs,test}/**` and a file at the workspace root, so both lint
 * scripts now pass two patterns and `format` passes three. Reading only the
 * first would have said the config file is unreachable while eslint was linting
 * it.
 */
function scriptGlobs(script: string): string[] {
  const command = packageScripts()[script];
  const globs = [...(command ?? '').matchAll(/"([^"]+)"/g)].map(
    ([, glob]) => glob,
  );
  if (globs.length === 0) {
    throw new Error(`no quoted glob in scripts.${script}: ${command}`);
  }
  return globs;
}

const globCache = new Map<string, readonly string[]>();

/**
 * What a glob expands to under `backend/`, as files. The scripts quote the
 * pattern so that eslint expands it rather than the shell; `globSync` is the
 * same brace-and-`**` semantics, and expanding it is the only way to answer
 * *does this glob reach that file* without restating the glob.
 */
function reaches(glob: string): readonly string[] {
  const cached = globCache.get(glob);
  if (cached) return cached;
  const found = globSync(glob, { cwd: backendRoot })
    .map((match) => match.split('\\').join('/'))
    .sort();
  globCache.set(glob, found);
  return found;
}

/** Every file a script's patterns reach between them. */
function reachedBy(script: string): readonly string[] {
  return [
    ...new Set(scriptGlobs(script).flatMap((glob) => reaches(glob))),
  ].sort();
}

/* ------------------------------------------------------------------ *
 * 2. What eslint resolves for those files — asked out of process.
 * ------------------------------------------------------------------ */

interface ResolvedConfig {
  /** Rule name → severity, as eslint normalizes it: 0, 1 or 2. */
  readonly rules: Record<string, number>;
  readonly projectService: boolean;
}

interface Probe {
  readonly configs: Record<string, ResolvedConfig>;
  readonly lint: {
    /** A rule that throws comes out of `lintFiles` as an exception. */
    readonly threw: string | null;
    readonly fatal: readonly string[];
    readonly linted: readonly string[];
  };
}

/** Run in `backend/` by plain node — see the docblock on why not in-process. */
const PROBE = `
const { relative } = require('node:path');
const { ESLint } = require('eslint');

const files = JSON.parse(process.env.HARNESS_JS);
const eslint = new ESLint({ cwd: process.cwd() });
const severity = (entry) => {
  const level = Array.isArray(entry) ? entry[0] : entry;
  return { off: 0, warn: 1, error: 2 }[level] ?? level;
};

(async () => {
  const configs = {};
  for (const file of files) {
    const config = await eslint.calculateConfigForFile(file);
    const rules = {};
    for (const [rule, entry] of Object.entries(config.rules || {})) {
      rules[rule] = severity(entry);
    }
    configs[file] = {
      rules,
      projectService: Boolean(
        config.languageOptions &&
          config.languageOptions.parserOptions &&
          config.languageOptions.parserOptions.projectService,
      ),
    };
  }

  const lint = { threw: null, fatal: [], linted: [] };
  try {
    const results = await eslint.lintFiles(files);
    const at = (result) => relative(process.cwd(), result.filePath);
    lint.linted = results.map(at);
    lint.fatal = results.flatMap((result) =>
      result.messages
        .filter((message) => message.fatal)
        .map((message) => at(result) + ': ' + message.message),
    );
  } catch (error) {
    lint.threw = error && error.message ? error.message : String(error);
  }

  process.stdout.write(JSON.stringify({ configs, lint }));
})().catch((error) => {
  process.stderr.write(String((error && error.stack) || error));
  process.exit(1);
});
`;

const probed = new Map<string, Probe>();

/**
 * Cached per file set, because each call is a node process that loads ESLint
 * and resolves a flat config — about a second, and the config file asks the
 * same three questions of a second file.
 */
function probe(files: readonly string[]): Probe {
  const key = files.join('|');
  const cached = probed.get(key);
  if (cached) return cached;
  const answer = JSON.parse(
    execFileSync(process.execPath, ['-e', PROBE], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, HARNESS_JS: JSON.stringify(files) },
      maxBuffer: 32 * 1024 * 1024,
    }),
  ) as Probe;
  probed.set(key, answer);
  return answer;
}

/** Every rule `disableTypeChecked` turns off — the set that must be off here. */
function typeAwareRules(): string[] {
  const config = tseslint.configs.disableTypeChecked as {
    rules?: Record<string, unknown>;
  };
  return Object.keys(config.rules ?? {}).sort();
}

/* ------------------------------------------------------------------ *
 * 3. The property.
 * ------------------------------------------------------------------ */

/*
 * §1.7's second escape, and for its stated reason: the unit under test is a
 * committed artefact rather than a symbol — `backend/eslint.config.mjs` plus
 * the two `package.json` scripts that hand it files — so the path *is* the name
 * of the unit, verbatim, as `deploy/install.sh` is for `server-setup.spec.ts`
 * (`describe-names.spec.ts`).
 */
describe('backend/eslint.config.mjs — the .js block and the glob that feeds it', () => {
  /** Regression one: `js` falling back out of either script's glob. */
  it('is handed all three of them by both lint scripts', () => {
    const missed = Object.fromEntries(
      LINT_SCRIPTS.map((script) => {
        const globbed = reachedBy(script);
        return [script, HARNESS_JS.filter((file) => !globbed.includes(file))];
      }),
    );

    expect(missed).toEqual({ lint: [], 'lint:fix': [] });
  });

  it('has no .js file under the lint glob that is not one of the three', () => {
    const globbed = reachedBy('lint').filter((file) => file.endsWith('.js'));

    expect(globbed).toEqual([...HARNESS_JS]);
  });

  /**
   * Regression two: the `.js` block reordered above the one that re-enables the
   * two type-aware rules. Every rule `disableTypeChecked` names must resolve to
   * severity 0 on each of the three, which is true only while the block sits
   * last; reordered, `no-floating-promises` and `no-unsafe-argument` come back
   * at severity 1 and this lists them by file.
   */
  it('resolves every type-aware rule to off on each of them', () => {
    const rules = typeAwareRules();
    const enabled = Object.entries(probe(HARNESS_JS).configs).flatMap(
      ([file, config]) =>
        rules
          .filter((rule) => (config.rules[rule] ?? 0) !== 0)
          .map((rule) => `${file}: ${rule} at ${config.rules[rule]}`),
    );

    expect({ enabled, checked: rules.length > 50 }).toEqual({
      enabled: [],
      checked: true,
    });
  });

  /**
   * `disableTypeChecked` only sets rules. Without `projectService: false` the
   * parser still demands a project for the file and the parse error stands, so
   * this is the other half of the same block and can fail on its own.
   */
  it('asks the parser for no TypeScript project for any of them', () => {
    const demanded = Object.entries(probe(HARNESS_JS).configs)
      .filter(([, config]) => config.projectService)
      .map(([file]) => file);

    expect(demanded).toEqual([]);
  });

  /**
   * Both regressions observed rather than inferred, because what they actually
   * produce is a parse error and a rule crash — and both of those land at
   * `pnpm lint` time rather than here unless something asks.
   */
  it('parses all three with no rule crashing on them', () => {
    expect(probe(HARNESS_JS).lint).toEqual({
      threw: null,
      fatal: [],
      linted: [...HARNESS_JS],
    });
  });
});

/*
 * §1.7's second escape again, on the same terms as the block above: the unit
 * under test is `backend/eslint.config.mjs` itself, so the path is the name.
 */
describe('backend/eslint.config.mjs — the config file is itself checked', () => {
  /**
   * The finding. It `ignores`d itself and the workspace's globs could not have
   * reached it anyway, so the one file that turns lint on for
   * {@link HARNESS_JS} was checked by nothing at all — and `prettier --check`
   * reded on it, at two double-quoted strings, from before this gate touched it.
   *
   * Asserted per script rather than as one list, because the lesson is that
   * the two scripts can lose a pattern independently: `lint` is the CI gate and
   * `lint:fix` is the loop, and a fix loop that cannot see this file cannot fix
   * it.
   */
  it('is handed to eslint by both lint scripts and to prettier by format', () => {
    const missed = [...LINT_SCRIPTS, FORMAT_SCRIPT].filter(
      (script) => !reachedBy(script).includes(LINT_CONFIG),
    );

    expect(missed).toEqual([]);
  });

  /**
   * The other half, and the coupling named with it: deleting the self-`ignores`
   * **alone** is worse than leaving it in. `projectService: true` with no
   * `allowJs` in `tsconfig.json` answers `Parsing error: … was not found by the
   * project service`, so `pnpm lint` would go from silently skipping this file
   * to failing on it — measured by making exactly that edit and nothing else.
   * The `files: ['**\u002F*.mjs']` block is what stops that, and this is where
   * it is observed rather than asserted from the config's text.
   */
  it('parses with no rule crashing on it, and asks for no TypeScript project', () => {
    const { configs, lint } = probe([LINT_CONFIG]);

    expect(lint).toEqual({ threw: null, fatal: [], linted: [LINT_CONFIG] });
    expect(configs[LINT_CONFIG].projectService).toBe(false);
  });

  /**
   * And the block's position, for this file as for the three above: the block
   * that re-enables `no-floating-promises` and `no-unsafe-argument` carries no
   * `files` of its own, so a `disableTypeChecked` block moved above it loads
   * two type-aware rules against a file with no type information — which is not
   * a soft failure but a rule throwing out of eslint.
   */
  it('resolves every type-aware rule to off on it', () => {
    const rules = typeAwareRules();
    const config = probe([LINT_CONFIG]).configs[LINT_CONFIG];
    const enabled = rules.filter((rule) => (config.rules[rule] ?? 0) !== 0);

    expect({ enabled, checked: rules.length > 50 }).toEqual({
      enabled: [],
      checked: true,
    });
  });

  /**
   * The `.mjs` block is separate from the `.js` one on purpose — that one's
   * `no-require-imports: 'off'` is a concession to the harness's hand-written
   * CommonJS and an ESM config file has no `require` to excuse — so the
   * concession must not have leaked across. This is the assertion that would
   * red if the two blocks were folded together for tidiness.
   */
  it('does not inherit the harness CommonJS block’s require exemption', () => {
    const config = probe([LINT_CONFIG]).configs[LINT_CONFIG];

    expect(config.rules['@typescript-eslint/no-require-imports']).not.toBe(0);
  });
});
