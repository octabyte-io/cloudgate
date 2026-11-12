/**
 * `copy-button-label-is-a-noun` — the one thing every `CopyButton` call site has
 * to agree on, held by a machine.
 *
 * `CopyButton` composes the control's accessible name itself: idle it says
 * `Copy the ${label}`, and a clipboard rejection says
 * `Could not copy the ${label}. …`. So the prop is a **noun** — its own doc says
 * *"What is being copied — 'password', 'connection string'"* — and a site that
 * passes a sentence gets the verb twice. Eleven of twenty-eight sites did, and a
 * screen reader read the backup-codes dialog out as **"Copy the Copy backup
 * codes"** on a live install, with the failure line reading "Could not copy the
 * Copy the SCIM token".
 *
 * The argument for a rule rather than the eleven fixes alone is the ratio: the
 * mistake is the *natural* one to make, because every other label-ish prop in
 * this tree names a control rather than a value, and nothing at the call site
 * shows what the component will wrap around it. Seventeen sites were right and
 * eleven were wrong by writing the obvious thing, so the twelfth is a matter of
 * time — and no amount of correct neighbours prevents it, which is exactly the
 * shape a census gate is for.
 *
 * **What it does not prove.** Agreement is not correctness: twenty-eight sites
 * all saying `Copy the …` agreed too. The name the component actually composes
 * is pinned by rendering one — `copy-button.test.tsx` asserts
 * `Copy the backup codes` on a real button — and this rule holds the call sites
 * to the shape that test proves right. Neither half is sufficient alone.
 *
 * **No `\b` after `copy`.** A word boundary would let `Copying the key` through,
 * and that is the same defect with a different suffix; the plain prefix is both
 * simpler and stricter, and no noun in this tree begins with the letters.
 *
 * Reported on the *attribute value* rather than the element, so the report lands
 * under the string a reader has to change. A label assembled elsewhere and
 * handed in as a variable is out of reach here and deliberately not chased: the
 * rule reads literals, which is what all twenty-eight sites pass.
 */

/** §404's shape: the component's own verb, repeated by the call site. */
const LEADING_VERB = /^\s*copy/iu;

/**
 * The literal text an attribute value would start with, or `null` when the rule
 * cannot see it (a bare identifier, a call, a template opening on `${…}`).
 *
 * A conditional and a `||` fall-through are walked into rather than skipped,
 * because a site that got one arm wrong is a site with the defect on screen half
 * the time.
 *
 * @param {import("estree").Node | null | undefined} node
 * @returns {{ node: import("estree").Node, text: string }[]}
 */
function leadingText(node) {
  if (!node) return [];
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string"
        ? [{ node, text: node.value }]
        : [];
    case "JSXExpressionContainer":
      return leadingText(node.expression);
    case "TemplateLiteral":
      // The first quasi only: it is the whole of what a reader hears first, and
      // `Copy the ${role} join command` is how the one template site read.
      return node.quasis.length > 0 && node.quasis[0].value.raw !== ""
        ? [{ node, text: node.quasis[0].value.raw }]
        : [];
    case "ConditionalExpression":
      return [
        ...leadingText(node.consequent),
        ...leadingText(node.alternate),
      ];
    case "LogicalExpression":
      return [...leadingText(node.left), ...leadingText(node.right)];
    default:
      return [];
  }
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "require a noun rather than a sentence for a CopyButton's label, since the component composes the verb itself",
      recommended: true,
    },
    schema: [],
    messages: {
      repeatedVerb:
        '`CopyButton` builds its accessible name as `Copy the ${label}`, so a label of "{{label}}" is announced "Copy the {{label}}" and its failure reads "Could not copy the {{label}}.". Pass the noun only — "backup codes", not "Copy backup codes".',
    },
  },

  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "label") {
          return;
        }
        const element = node.parent;
        if (
          element?.type !== "JSXOpeningElement" ||
          element.name.type !== "JSXIdentifier" ||
          element.name.name !== "CopyButton"
        ) {
          return;
        }

        for (const { node: at, text } of leadingText(node.value)) {
          if (!LEADING_VERB.test(text)) continue;
          context.report({
            node: at,
            messageId: "repeatedVerb",
            data: { label: text },
          });
        }
      },
    };
  },
};

export default rule;
