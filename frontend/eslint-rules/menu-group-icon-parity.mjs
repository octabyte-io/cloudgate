/**
 * `menu-group-icon-parity` — every row in one `Menu.Group` carries an `icon`, or none does.
 *
 * `Menu.Item` renders its glyph as the row's first child and the row is a flex
 * line with a gap, so a row without an `icon` does not reserve the column — its
 * label slides left by the glyph plus the gap (16px + `gap-2.25`, so 25px) and
 * sits out of line with every sibling that has one. Nothing in the component
 * can notice: `icon` is optional because groups that use no icons at all are
 * correct and there are three of them (`scope-identity`, and both destructive
 * groups of the two container menus).
 *
 * The argument for a rule rather than a convention is that the defect is
 * invisible in the source. It was found in the Server's container Actions
 * menu, where Open a shell, Inspect it, Start and Restart had `term`, `eye`,
 * `play` and `refresh` and Stop had nothing — five lines in a row, four of them
 * alike, and the diff that added Stop touched none of the other four. The cause
 * was that the icon map had no stop glyph at all, so the author of the bare row
 * had no fifth choice to make; the next row added to any group will be written
 * the same way, by someone who is not comparing it to its siblings.
 *
 * This rule states the invariant. It does not state *which* way a group should
 * go, because both are legitimate and the group decides — but it makes adding
 * the fifth bare row to four iconed ones a build error rather than a thing
 * somebody notices in a screenshot.
 *
 * **It cannot see a dynamic icon, and says nothing about a group that has one.**
 * `icon={row.glyph}` may or may not be set at runtime, and a group carrying one
 * is skipped whole — same for a row with a spread, whose props are unknowable
 * here. A rule that guessed would report a correct group, and a rule that
 * reports correct code is a rule that gets switched off. The rendered pin for
 * the group this was found in lives with the component, in
 * `ContainerActions`' own test, which is the half of the gate that says the
 * icons are *there* rather than merely that they agree.
 */

/** Both spellings the menu exports: the namespace and the bare component. */
const GROUPS = new Set(["Menu.Group", "MenuGroup"]);
const ITEMS = new Set(["Menu.Item", "MenuItem"]);

function isNode(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.type === "string"
  );
}

/** `Menu.Item` from a `JSXMemberExpression`, `MenuItem` from an identifier. */
function elementName(name) {
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") {
    const object = elementName(name.object);
    const property = elementName(name.property);
    return object === null || property === null ? null : `${object}.${property}`;
  }
  // A namespaced name (`svg:rect`) is never one of ours.
  return null;
}

/**
 * The rows this group owns, however deep.
 *
 * A generic walk and not `node.children`, because two groups in this tree build
 * their rows in a `.map()` — the rows are then inside a `JSXExpressionContainer`
 * holding an arrow function, which no JSX-child walk reaches. A nested group
 * terminates the walk: its rows are its own to be consistent about.
 */
function rowsOf(group) {
  const rows = [];
  const pending = [...group.children];

  while (pending.length > 0) {
    const node = pending.pop();
    if (!isNode(node)) continue;

    if (node.type === "JSXElement") {
      const name = elementName(node.openingElement.name);
      if (name !== null && GROUPS.has(name)) continue;
      if (name !== null && ITEMS.has(name)) rows.push(node.openingElement);
    }

    for (const key of Object.keys(node)) {
      // `parent` walks back up the tree and would never terminate.
      if (key === "parent") continue;
      const value = node[key];
      if (Array.isArray(value)) pending.push(...value);
      else if (isNode(value)) pending.push(value);
    }
  }

  return rows;
}

/** `"icon"`, `"bare"`, or `"unknown"` for a row this rule must not judge. */
function iconState(opening) {
  let icon = null;

  for (const attribute of opening.attributes) {
    if (attribute.type === "JSXSpreadAttribute") return "unknown";
    if (attribute.name?.name === "icon") icon = attribute;
  }

  if (icon === null) return "bare";

  const value = icon.value;
  // `icon="play"`.
  if (value?.type === "Literal") return typeof value.value === "string" ? "icon" : "unknown";
  if (value?.type === "JSXExpressionContainer") {
    const expression = value.expression;
    // `icon={"play"}`, and the two ways of writing "no glyph after all".
    if (expression.type === "Literal") {
      return typeof expression.value === "string" ? "icon" : "bare";
    }
    if (expression.type === "Identifier" && expression.name === "undefined") {
      return "bare";
    }
    return "unknown";
  }

  return "unknown";
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "require every Menu.Item in one Menu.Group to carry an icon, or none of them to",
      recommended: true,
    },
    schema: [],
    messages: {
      mixedIcons:
        "This row has no `icon` while {{iconed}} of its {{total}} siblings in the same `Menu.Group` do, so its label sits 25px left of theirs. Give it a glyph, or take the icons off the whole group.",
      mixedBare:
        "This row has an `icon` while {{bare}} of its {{total}} siblings in the same `Menu.Group` have none, so their labels sit 25px left of this one's. Take it off, or give every row in the group a glyph.",
    },
  },

  create(context) {
    return {
      JSXElement(node) {
        const name = elementName(node.openingElement.name);
        if (name === null || !GROUPS.has(name)) return;

        const rows = rowsOf(node).map((opening) => ({
          opening,
          state: iconState(opening),
        }));

        // One unreadable row and the group's intent is unreadable with it.
        if (rows.some((row) => row.state === "unknown")) return;

        const iconed = rows.filter((row) => row.state === "icon");
        const bare = rows.filter((row) => row.state === "bare");
        if (iconed.length === 0 || bare.length === 0) return;

        // The smaller set is the deviation, and on a tie the bare rows are —
        // reporting both halves of one mistake would make the fix look like two.
        const deviation = bare.length <= iconed.length ? bare : iconed;
        for (const row of deviation) {
          context.report({
            node: row.opening.name,
            messageId: deviation === bare ? "mixedIcons" : "mixedBare",
            data: {
              iconed: iconed.length,
              bare: bare.length,
              total: rows.length - 1,
            },
          });
        }
      },
    };
  },
};

export default rule;
