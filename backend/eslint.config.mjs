// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
      // CODING_STANDARDS §1.1: `CONTEXT.md`'s glossary binds UI copy and test
      // names, and its Avoid column for Deployment is `release, build`.
      // Re-reading the glossary is demonstrably not the mechanism — a review found
      // the sentence in the deployment log written by an author who had
      // `CONTEXT.md` open — so the rule is what makes it stick.
      //
      // The boundary is §1.1's own: strings, not comments. Two node types here;
      // the frontend config carries a third (`JSXText`) for JSX body text.
      //
      // The article anchor keeps it off the *verb*, which is sanctioned
      // everywhere: `CONTEXT.md`'s own **Deployment** entry defines a Build
      // deployment as "one attempt to build and release a specific Application
      // (or compose stack) version". Quoted rather than cited by line, because
      // the line moved twice — it was `CONTEXT.md:28` when this rule landed and
      // the glossary has gained entries above it since.
      //
      // **One array.** ESLint keeps only the last declaration of a rule, so any
      // further selector (§1.6, §1.7) goes in here beside these two rather than
      // in a second `no-restricted-syntax` key.
      'no-restricted-syntax': [
        'error',
        ...['Literal[value=/RE/i]', 'TemplateElement[value.raw=/RE/i]'].map(
          (selector) => ({
            selector: selector.replace(
              'RE',
              '\\b(a|an|the|this|that|its|their|previous|last|new|next|failed|one)\\s+([a-z]+\\s+)?releases?\\b',
            ),
            // The one exemption this rule was always going to need, and it
            // only surfaced when this file stopped `ignores`ing itself:
            // the sentence *is* the rule, so the selector matches its own
            // message. A mention, not a use — exactly the escape hatch
            // CODING_STANDARDS §1.2 describes, taken here rather than by
            // rewording the message, because the message has to quote the
            // wrong phrasing to be useful to whoever trips over it.
            message:
              // eslint-disable-next-line no-restricted-syntax
              'CONTEXT.md: a Deployment is not a release (CODING_STANDARDS §1.1). Third-party and Cloudgate-image senses need an eslint-disable with a reason.',
          }),
        ),
        // CODING_STANDARDS §1.6: the backend splits the type import from the
        // value import of the same module. This is descriptive, not
        // aspirational — 224 pairs in `src` already did it against the 34
        // statements (37 specifiers, 28 files) this rule was added to sweep,
        // which is why the change that added it refused a §4 row and swept
        // instead. The frontend's convention is the *opposite* — inline `type`
        // qualifiers, by roughly two orders of magnitude, measured when this
        // rule landed — so this selector belongs to this workspace's config and
        // must never be hoisted to the root. (A precise frontend count is
        // deliberately not quoted here: it moved twice while this rule was
        // being added, and a number that rots is worse than the direction it
        // was standing in for.)
        //
        // `@typescript-eslint/consistent-type-imports` cannot express it at any
        // `fixStyle`: an inline `type X` already *is* a type import, so that
        // rule reports nothing here (verified on this tree). Hence the AST
        // shape — a value declaration carrying a type specifier.
        {
          selector:
            'ImportDeclaration[importKind="value"] > ImportSpecifier[importKind="type"]',
          message:
            "CODING_STANDARDS §1.6: split the type import out — `import { X } from 'm';` then `import type { Y } from 'm';`.",
        },
        // CODING_STANDARDS §1.7: "`should` is not used." A test name states a
        // fact — `'is reported once for that peer, and never again'`, not
        // `'should report once'`. Unlike §1.7's other half (a top-level
        // `describe` names its unit), this one is decidable from a single
        // file's AST, so it belongs here rather than in
        // `test/coding-standards/describe-names.spec.ts`, which needs `src`'s
        // symbol table and is a jest test for that reason.
        //
        // Reports exactly once on this tree, at `test/app.controller.spec.ts:18`
        // — untouched Nest scaffold, already recorded in §4, and carrying an
        // `// eslint-disable-next-line no-restricted-syntax`.
        {
          selector:
            'CallExpression[callee.name=/^(it|test|describe)$/] > Literal[value=/^\\s*should\\b/i]',
          message:
            'CODING_STANDARDS §1.7: a test name states a fact — no "should".',
        },
      ],
      // The `import { type X }` case, where the braces carry nothing but
      // types. Autofixable, unlike the selector above.
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  // The harness's hand-written CommonJS — `test/octokit-resolver.js` (both e2e
  // configs' `resolver`), `test/utils/heartbeat-reporter.js` (every e2e run's
  // reporter) and `test/jest-preset.js` (everything those two configs share),
  // the only three `.js` files under `{src,apps,libs,test}`. The preset is the
  // third and arrived with this same change: it is hand-written CommonJS for
  // the reason its own docblock gives — `__dirname`, so one set of paths reads
  // the same from either config's `rootDir` — which is exactly why it belongs
  // to this block rather than being a reason to shrink it.
  // `test/coding-standards/harness-js-is-linted.spec.ts` holds the list, so a
  // fourth one reds rather than quietly making this count wrong again.
  //
  // **They were linted by nothing at all**, and by two mechanisms at once:
  // `package.json`'s glob passed only `{ts,tsx}`, and the parser refused them
  // anyway — `projectService: true` with no `allowJs` in `tsconfig.json` gives
  // `Parsing error: … was not found by the project service`. So the glob had
  // to grow `js` *and* this block, or growing the glob would just have turned
  // silently-unlinted files into parse errors.
  //
  // **Type-aware linting is off here because on these files it checks
  // nothing.** The `allowDefaultProject` route was tried first and reported 33
  // problems over the three files — 27 `no-unsafe-*`, four `no-require-imports`
  // and two `unbound-method` — and all 33 are the same missing types: jest
  // loads all three through `require`, so CommonJS is not a style choice, and
  // their entry points are jest's own callbacks whose argument types live in
  // `@jest/reporters` — not resolvable from this workspace, since jest is a
  // devDependency and pnpm does not hoist its internals. With
  // `noImplicitAny: false` every one of those parameters is `any`, so the only
  // way to quiet the rules is a local typedef that restates jest's interface
  // from memory and is checked against nothing. None of the three has a
  // promise or an `await` in it, so the type-aware rules that would earn their
  // keep — `no-floating-promises`, `await-thenable`, `no-misused-promises` —
  // have no work here either.
  //
  // What these files do need is the untyped half, which is the half
  // `CODING_STANDARDS` binds: prettier, `no-unused-vars`, and the §1.1/§1.7
  // `no-restricted-syntax` selectors above, which apply to the operator-facing
  // strings the reporter writes. This block sits last for that reason: the
  // block above re-enables `no-floating-promises` and `no-unsafe-argument`
  // with no `files` of its own, so `disableTypeChecked` has to come after it
  // or those two rules load and throw on a file with no type information.
  // That ordering is a property rather than a convention, and
  // `test/coding-standards/harness-js-is-linted.spec.ts` asserts it off the
  // config ESLint actually resolves for these files — moving this block above
  // the one it follows reds there instead of at the next `pnpm lint`.
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      // Without this the parser still demands a project for the file and the
      // parse error stands, `disableTypeChecked` or not — it only sets rules.
      parserOptions: { projectService: false },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  // This file, which once `ignores`d itself — so the one file that turns
  // lint on for the harness `.js` files above was the one file nothing checked,
  // and `prettier --check` had reded on it for some time.
  //
  // **The two edits are coupled.** Deleting the self-`ignores` alone is *worse*
  // than leaving it:
  // `projectService: true` with no `allowJs` in `tsconfig.json` answers
  // `Parsing error: … was not found by the project service`, so `pnpm lint`
  // goes from silently skipping the file to failing on it. Verified by making
  // exactly that edit and nothing else. Hence this block, and hence the second
  // quoted pattern in `package.json`'s two lint scripts — the glob above it
  // roots at `{src,apps,libs,test}` and can never reach a file at the
  // workspace root.
  //
  // **A block of its own rather than `'**/*.mjs'` added to the one above.**
  // That block exists for the harness's hand-written **CommonJS**, and its
  // `no-require-imports: 'off'` is a concession to exactly that; an ESM config
  // file has no `require` to excuse, and folding the two together would make a
  // paragraph of prose about CommonJS cover a file that is the opposite. What
  // the two do share is the reason for `disableTypeChecked` — there is no
  // TypeScript project that contains either — and the **ordering** that goes
  // with it: this block is last for the reason the one above it is,
  // `test/coding-standards/harness-js-is-linted.spec.ts` asserts it off the
  // config ESLint really resolves, and its block now covers this file too.
  {
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false },
      // The block near the top of this file sets `commonjs` for the whole
      // workspace, which is right for `src` under Nest's CommonJS build and
      // wrong for the only `.mjs` in it.
      sourceType: 'module',
    },
  },
);
