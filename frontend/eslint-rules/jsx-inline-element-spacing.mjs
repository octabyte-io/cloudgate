/**
 * `jsx-inline-element-spacing` — rule 3 of `docs/design-system.md`, enforced.
 *
 * A JSXText node whose first line is blank has that leading whitespace stripped
 * by the JSX transform, so an inline element sitting at the end of the previous
 * line loses the space after it:
 *
 *     Runs <code>system</code>
 *     prunes — everything in the list below
 *
 * renders `systemprunes`. The guard is `{" "}` after the closing tag, and this
 * codebase has shipped the defect at least seven times regardless — hence a
 * machine rather than a convention.
 *
 * The predicate is the one the runtime DOM detector in `design-system.md`
 * converged on, ported to the AST: fire **only** when the stripped whitespace
 * would join two alphanumeric characters. That is what separates a lost space
 * that matters from one nobody wanted — a comma after `</strong>`, a `)` after
 * `</a>`, a block-level neighbour, a flex row whose gap does the spacing. The
 * off-the-shelf `react/jsx-child-element-spacing` cannot tell those apart and
 * reports 27 of them on this tree, all but a handful intentional.
 *
 * ## The second shape: the space is in the source and the build drops it
 *
 * Everything above is about a space the *author* did not write. The shipped
 * production bundle was measured across all 83 sites in this tree where a text
 * node follows a closing inline element, begins with a space **on that same
 * line**, and then continues onto further lines — the shape this rule's first
 * predicate reads as already correct. 77 of them keep their space; the other 6
 * lose it, and the discriminator is total: those 6 are exactly the nodes that
 * also contain an **HTML entity** (`&rsquo;`, `&mdash;`, …). Turbopack's JSX
 * text handling drops the node's leading space when it has an entity to decode,
 * so `</code>·is appended` ships as `dockeris appended`.
 *
 * That is why this is a second predicate rather than a sixth manual fix: the
 * first predicate inspects the source for a space that is *missing*, and in all
 * six of these the source has the space, so `pnpm lint` was green on every one.
 * The second predicate below therefore looks for the opposite thing — a space
 * that is present and will not survive the build.
 *
 * It carries **no** alphanumeric test, deliberately. The alphanumeric filter
 * exists to tell a space nobody wanted from one somebody needed, and that
 * question does not arise here: the author typed the space on the closing tag's
 * own line. Its loss is always a defect, which is why `one host&mdash;` counts
 * (`one host— the machine`) where the first predicate would rightly skip it.
 *
 * ## …and it does not care what came before the text
 *
 * The measurement covered the shape after a closing *inline element*, because
 * that was the first predicate's territory, and the second predicate inherited the
 * restriction. The build does not share it: the space goes with the text node
 * whatever its left-hand neighbour is. A stopped Server's card shipped
 * **"more than 2 daysold"** past a green lint, the neighbour being
 * `{days === 1 ? "day" : "days"}` — and running Next's own SWC transform over
 * every `.tsx` in the tree (entities as written against entities decoded) found
 * eight more, every one after an interpolation: `{errorMessage(error)}Nothing`,
 * `{switchedOff.length}of`, `{descriptor.label}reads`. So the second predicate
 * reads every text node that has a left-hand sibling, whatever it is; only a
 * flex or grid parent, whose gap does the spacing, still exempts it. On this
 * tree the rule and that transform census now report the same nine sites.
 */

/**
 * HTML elements that render inline, so a collapsed space between them and the
 * next character is visible. Anything not on this list — a block-level tag, or
 * any capitalised component, whose rendering this rule cannot see — is left
 * alone.
 */
const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "dfn",
  "em",
  "i",
  "kbd",
  "label",
  "mark",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
]);

/**
 * Tailwind utilities that take an element out of the inline flow, at which
 * point the whitespace between it and its neighbour is invisible. Variant
 * prefixes (`md:`, `hover:`) are stripped before matching, so a `md:block` is
 * treated as block everywhere — a false negative, deliberately, since this rule
 * only earns its keep if a clean tree stays clean.
 */
const NON_INLINE_UTILITY =
  /^(block|inline-block|flow-root|flex|inline-flex|grid|inline-grid|table|table-\w+|contents|hidden|absolute|fixed|sticky|sr-only|float-\w+)$/;

/** Container utilities whose own `gap` supplies the spacing between children. */
const CONTAINER_UTILITY = /^(flex|inline-flex|grid|inline-grid)$/;

/**
 * Render a JSXText node's value the way the JSX transform does: lines are
 * trimmed of the whitespace that faces a newline, blank lines vanish, and what
 * survives is joined with a single space.
 *
 * This is Babel's `cleanJSXElementLiteralChild`, and it is reimplemented rather
 * than approximated because the whole rule turns on which spaces survive.
 */
function renderJSXText(raw) {
  const lines = raw.split(/\r\n|\n|\r/u);

  let lastNonEmptyLine = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (/[^ \t]/u.test(lines[i])) lastNonEmptyLine = i;
  }

  let out = "";
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].replace(/\t/gu, " ");
    if (i !== 0) line = line.replace(/^ +/u, "");
    if (i !== lines.length - 1) line = line.replace(/ +$/u, "");
    if (line) {
      if (i !== lastNonEmptyLine) line += " ";
      out += line;
    }
  }
  return out;
}

/** Does this text node's leading whitespace contain a newline, and so vanish? */
function leadingWhitespaceIsStripped(raw) {
  return /^[^\S\n\r]*[\n\r]/u.test(raw);
}

/**
 * The leading horizontal whitespace run — the space the author typed on the
 * closing tag's own line.
 */
const LEADING_SPACES = /^[^\S\r\n]+/u;

/** Leading whitespace, then real text, then (later) a line break. */
const SPACE_THEN_TEXT = /^[^\S\r\n]+[^\s]/u;

/**
 * A named, decimal or hex character reference. This is what Turbopack has to
 * decode, and decoding it is what costs the node its leading space.
 */
const HTML_ENTITY = /&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/u;

/**
 * Does the build strip a space this node's source really contains?
 *
 * Three conditions, all of them measured against the shipped bundle
 * rather than reasoned from the transform: a space on the closing tag's own
 * line, more lines after it, and an HTML entity somewhere in the node. Take any
 * one away and all 83 measured sites keep their space.
 *
 * The source text is read with `getText`, not `node.value` — the parser has
 * already decoded `&rsquo;` into `’` by then, which is precisely the evidence
 * this needs.
 */
function entityStripsLeadingSpace(raw) {
  return (
    SPACE_THEN_TEXT.test(raw) && /[\r\n]/u.test(raw) && HTML_ENTITY.test(raw)
  );
}

/**
 * Every string literal anywhere inside an expression, as class tokens.
 *
 * Most classNames here are `cn("grid flex-none", cond && "block")`, and the
 * branch that is not taken is unknowable. Taking the union errs towards
 * "not inline", which errs towards not reporting — the safe direction for a
 * rule whose whole value is that a clean tree stays clean.
 */
function collectStringTokens(node, out) {
  if (!node || typeof node.type !== "string") return;
  if (node.type === "Literal" && typeof node.value === "string") {
    out.push(...node.value.split(/\s+/u).filter(Boolean));
    return;
  }
  if (node.type === "TemplateElement") {
    out.push(...(node.value?.cooked ?? "").split(/\s+/u).filter(Boolean));
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) collectStringTokens(item, out);
    } else if (value && typeof value === "object") {
      collectStringTokens(value, out);
    }
  }
}

function classListOf(node) {
  const attributes = node.type === "JSXElement" ? node.openingElement.attributes : [];
  for (const attribute of attributes) {
    if (attribute.type !== "JSXAttribute") continue;
    if (attribute.name?.name !== "className") continue;
    const value = attribute.value;
    if (value?.type === "Literal" && typeof value.value === "string") {
      return value.value.split(/\s+/u).filter(Boolean);
    }
    if (value?.type === "JSXExpressionContainer") {
      const tokens = [];
      collectStringTokens(value.expression, tokens);
      return tokens;
    }
    return [];
  }
  return [];
}

/** Strip Tailwind variant prefixes: `md:hover:block` → `block`. */
function baseUtility(token) {
  const parts = token.split(":");
  return parts[parts.length - 1];
}

function hasUtility(node, pattern) {
  return classListOf(node).some((token) => pattern.test(baseUtility(token)));
}

/** An element whose own box participates in the inline flow of its parent. */
function isInlineElement(node) {
  if (node?.type !== "JSXElement") return false;
  const name = node.openingElement.name;
  if (name.type !== "JSXIdentifier") return false;
  if (!INLINE_TAGS.has(name.name)) return false;
  return !hasUtility(node, NON_INLINE_UTILITY);
}

/** A flex or grid container spaces its children itself; whitespace is inert. */
function isSpacedContainer(node) {
  if (node?.type !== "JSXElement") return false;
  return hasUtility(node, CONTAINER_UTILITY);
}

const UNKNOWN = Symbol("unknown");

/**
 * The characters an element renders at its edges, as far as the source can say.
 * `UNKNOWN` means an expression sits at that edge — `{app.name}` — and the rule
 * declines to guess.
 */
function edgeChar(node, side) {
  if (node.type === "JSXText") {
    const rendered = renderJSXText(node.value);
    if (!rendered) return null;
    return side === "last" ? rendered[rendered.length - 1] : rendered[0];
  }

  if (node.type === "JSXExpressionContainer") {
    // `{" "}` and `{" "}` are the guard itself, and a literal that renders
    // nothing renders nothing.
    const expression = node.expression;
    if (expression.type === "JSXEmptyExpression") return null;
    if (expression.type === "Literal" && typeof expression.value === "string") {
      const value = expression.value;
      if (!value.trim()) return null;
      return side === "last" ? value[value.length - 1] : value[0];
    }
    return UNKNOWN;
  }

  if (node.type === "JSXElement" || node.type === "JSXFragment") {
    if (node.type === "JSXElement" && node.openingElement.selfClosing) return null;
    const children = side === "last" ? [...node.children].reverse() : node.children;
    for (const child of children) {
      const char = edgeChar(child, side);
      if (char !== null) return char;
    }
    return null;
  }

  return null;
}

const ALPHANUMERIC = /^[A-Za-z0-9]$/u;

function isAlphanumeric(char) {
  return typeof char === "string" && ALPHANUMERIC.test(char);
}

/**
 * The rendered word on each side of the boundary, for a message that shows the
 * collision the way it reaches the screen.
 */
const WORD_TAIL = /[A-Za-z0-9]+(?:[._/-][A-Za-z0-9]+)*$/u;
const WORD_HEAD = /^[A-Za-z0-9]+(?:[._/-][A-Za-z0-9]+)*/u;

function trailingWord(text) {
  return WORD_TAIL.exec(text)?.[0] ?? "";
}

function leadingWord(text) {
  return WORD_HEAD.exec(text)?.[0] ?? "";
}

function renderedTail(node) {
  if (node.type === "JSXText") return trailingWord(renderJSXText(node.value));
  if (node.type === "JSXElement" || node.type === "JSXFragment") {
    for (const child of [...node.children].reverse()) {
      const tail = renderedTail(child);
      if (tail) return tail;
    }
  }
  return "";
}

function renderedHead(node) {
  if (node.type === "JSXText") return leadingWord(renderJSXText(node.value));
  if (node.type === "JSXElement" || node.type === "JSXFragment") {
    for (const child of node.children) {
      const head = renderedHead(child);
      if (head) return head;
    }
  }
  return "";
}

/**
 * The element's last rendered word, or the source of the interpolation sitting
 * at its edge when that is all there is — `{session.username}on the machine` is
 * a more useful message than `on the machine`, and unlike the first predicate
 * this one does not need to *know* the character to be sure of the defect.
 */
function tailForMessage(node, sourceCode) {
  if (node.type === "JSXExpressionContainer") return sourceCode.getText(node);
  const rendered = renderedTail(node);
  if (rendered) return rendered;
  if (node.type === "JSXElement" || node.type === "JSXFragment") {
    for (const child of [...node.children].reverse()) {
      if (child.type === "JSXExpressionContainer") return sourceCode.getText(child);
      const nested = tailForMessage(child, sourceCode);
      if (nested) return nested;
    }
  }
  return "";
}

/** The first whitespace-delimited token the stripped space would be joined to. */
function headToken(raw) {
  return /^\s*(\S+)/u.exec(raw)?.[1] ?? "";
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        'require `{" "}` after an inline element whose trailing space JSX would strip, when the stripped space would join two alphanumeric characters',
      recommended: true,
    },
    fixable: "code",
    schema: [],
    messages: {
      joined:
        'JSX strips this line-leading whitespace, so the screen reads "{{joined}}". Add {" "} after the closing tag.',
      entityStripped:
        'This text node spans lines and contains an HTML entity, so the build drops the space it begins with and the screen reads "{{joined}}". Put that space in a {" "} ahead of the text.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode;

    function check(parent) {
      if (isSpacedContainer(parent)) return;

      const children = parent.children;
      for (let i = 1; i < children.length; i += 1) {
        const previous = children[i - 1];
        const current = children[i];

        // The second shape: the space is right there in the source, on
        // the previous sibling's own line, and the build drops it anyway.
        // Checked before the inline-element and alphanumeric filters because
        // neither applies — see the header.
        if (
          current.type === "JSXText" &&
          entityStripsLeadingSpace(sourceCode.getText(current))
        ) {
          const rendered = renderJSXText(current.value);
          context.report({
            node: previous,
            messageId: "entityStripped",
            data: {
              joined: `${tailForMessage(previous, sourceCode)}${headToken(rendered)}`,
            },
            fix: (fixer) => {
              const raw = sourceCode.getText(current);
              const lead = LEADING_SPACES.exec(raw)[0];
              const indent = /[\r\n]([^\S\r\n]*)/u.exec(raw)?.[1] ?? "";
              return fixer.replaceTextRange(
                [current.range[0], current.range[0] + lead.length],
                `{" "}\n${indent}`,
              );
            },
          });
          continue;
        }

        if (!isInlineElement(previous)) continue;

        const before = edgeChar(previous, "last");
        if (!isAlphanumeric(before)) continue;

        // The common shape: text on the next line, its indentation stripped.
        if (current.type === "JSXText") {
          if (!leadingWhitespaceIsStripped(current.value)) continue;

          const rendered = renderJSXText(current.value);
          if (rendered) {
            if (!isAlphanumeric(rendered[0])) continue;
            report(previous, renderedTail(previous), leadingWord(rendered));
            continue;
          }

          // Whitespace-only, so the two elements around it are what collide.
          const next = children[i + 1];
          if (!isInlineElement(next)) continue;
          if (!isAlphanumeric(edgeChar(next, "first"))) continue;
          report(previous, renderedTail(previous), renderedHead(next));
        }
      }

      function report(node, tail, head) {
        context.report({
          node,
          messageId: "joined",
          data: { joined: `${tail}${head}` },
          fix: (fixer) => fixer.insertTextAfter(node, '{" "}'),
        });
      }
    }

    return {
      JSXElement: check,
      JSXFragment: check,
    };
  },
};

export default rule;
