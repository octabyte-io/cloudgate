import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

import cloudgate from "./eslint-rules/index.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Rule 3 of `docs/design-system.md`, which the codebase has paid for seven
  // times as a convention. `react/jsx-child-element-spacing` detects the
  // same mechanism but cannot tell a stripped space you wanted from one you
  // needed — 27 reports on this tree, nearly all intentional — so this is the
  // local rule with the DOM detector's alphanumeric predicate instead.
  //
  // It carries a second predicate, for the shape the first could not
  // describe: the source has the space and the build drops it anyway, because
  // the text node also carries an HTML entity — after any neighbour, not only
  // an element. Measured on the bundle, not reasoned — see the rule's
  // header.
  {
    files: ["**/*.{jsx,tsx}"],
    plugins: { cloudgate },
    rules: { "cloudgate/jsx-inline-element-spacing": "error" },
  },
  // A `Menu.Item` with no `icon` in a group whose other rows have one
  // does not reserve the glyph column, so its label sits 25px left of theirs.
  // A rule and not a convention because the defect is invisible in the source —
  // the Server's container menu shipped four iconed rows and a bare Stop, and
  // the cause was that the icon map had no stop glyph, so the author of the
  // bare row had no fifth choice to make. The next row added to any group would
  // be written the same way, by someone not comparing it to its siblings.
  //
  // It does not pick a direction: a group that uses no icons at all is correct
  // and there are three of those. The rendered half of the gate — that the
  // glyphs are *there*, not merely consistent — lives in the two
  // `ContainerActions` tests.
  {
    files: ["**/*.{jsx,tsx}"],
    plugins: { cloudgate },
    rules: { "cloudgate/menu-group-icon-parity": "error" },
  },
  // `CopyButton` composes its own accessible name as `Copy the ${label}`,
  // so the prop takes the noun — and eleven of its twenty-eight call sites
  // passed a sentence instead, which a screen reader read out as "Copy the Copy
  // backup codes" on a live install. A rule and not a convention for the reason
  // the ratio shows: eleven authors wrote the obvious thing, because every
  // other label-ish prop in this tree names the control rather than the value
  // and nothing at the call site reveals the wrapper. Seventeen correct
  // neighbours did not prevent any of the eleven, so they will not prevent a
  // twelfth.
  //
  // Agreement is not correctness, so this is one half of the gate: the name the
  // component actually composes is pinned by rendering one in
  // `copy-button.test.tsx`. `tsx` only — the rule's own fixtures quote the
  // forbidden shape as example data.
  {
    files: ["**/*.tsx"],
    plugins: { cloudgate },
    rules: { "cloudgate/copy-button-label-is-a-noun": "error" },
  },
  // CODING_STANDARDS §1.2: cite the symbol, never the line, when a reference
  // crosses a file. Measured rather than assumed, which is why it is a rule and
  // not a convention — a sample of ten of the 49 `file.ts:NN` references this
  // tree carried found essentially none landing on the symbol it named, and
  // three were outright false (H-103, H-106, H-112). A sweep converted all 49; the
  // rule is what holds the count at zero, since a sweep leaves nothing behind
  // it. `.project/` records and same-file references are exempt — both are
  // §1.2's own carve-outs, and the rule's header says why neither is a
  // courtesy.
  //
  // `{ts,tsx}` and not `mjs`: the local rules and their fixtures quote the
  // forbidden shape as example data, and a rule that reports its own
  // documentation is a rule people turn off.
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { cloudgate },
    rules: { "cloudgate/no-cross-file-line-reference": "error" },
  },
  // CODING_STANDARDS §1.1: `CONTEXT.md`'s glossary binds UI copy and test names,
  // and its Avoid column for Deployment is `release, build`. Re-reading the
  // glossary is demonstrably not the mechanism — the same sentence was found
  // shipped in the deployment log and restated in three console screens, written
  // by an author who had `CONTEXT.md` open — so the rule is what makes it stick.
  //
  // The boundary is §1.1's own: strings, not comments. Hence three node types
  // and no `Line`/`Block` — JSX body text is a `JSXText`, not a `Literal`, which
  // is why a `Literal`-only rule misses the Phases card entirely.
  //
  // The article anchor is what keeps it off the *verb*, which is sanctioned
  // everywhere: `CONTEXT.md:28` defines a Deployment as "one attempt to build and
  // release a specific application version", and `deployments-screen.tsx`,
  // `deployment-row.tsx` and `deploy-button.tsx` all use it that way correctly.
  //
  // Seed it with the glossary's other Avoid rows as they are paid down
  // (`team|workspace|tenant` for Organization, `app|workload` for Application,
  // `host|node|machine` for Server); only this one has been paid down.
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...[
          "JSXText[value=/RE/i]",
          "Literal[value=/RE/i]",
          "TemplateElement[value.raw=/RE/i]",
        ].map((selector) => ({
          selector: selector.replace(
            "RE",
            "\\b(a|an|the|this|that|its|their|previous|last|new|next|failed|one)\\s+([a-z]+\\s+)?releases?\\b",
          ),
          message:
            "CONTEXT.md: a Deployment is not a release (CODING_STANDARDS §1.1). Third-party and licence-key senses need an eslint-disable with a reason.",
        })),
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
