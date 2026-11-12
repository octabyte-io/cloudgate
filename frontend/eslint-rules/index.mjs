import copyButtonLabelIsANoun from "./copy-button-label-is-a-noun.mjs";
import jsxInlineElementSpacing from "./jsx-inline-element-spacing.mjs";
import menuGroupIconParity from "./menu-group-icon-parity.mjs";
import noCrossFileLineReference from "./no-cross-file-line-reference.mjs";

/**
 * The console's local ESLint rules.
 *
 * Flat config takes a plugin object inline, so this needs no package and no
 * entry in the lockfile — `eslint.config.mjs` imports it by path.
 *
 * @type {import("eslint").ESLint.Plugin}
 */
const plugin = {
  meta: { name: "cloudgate", version: "1.0.0" },
  rules: {
    "copy-button-label-is-a-noun": copyButtonLabelIsANoun,
    "jsx-inline-element-spacing": jsxInlineElementSpacing,
    "menu-group-icon-parity": menuGroupIconParity,
    "no-cross-file-line-reference": noCrossFileLineReference,
  },
};

export default plugin;
