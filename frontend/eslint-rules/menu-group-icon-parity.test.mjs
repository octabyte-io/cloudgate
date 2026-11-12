import { RuleTester } from "eslint";
import { afterAll, describe, it } from "vitest";

import rule from "./menu-group-icon-parity.mjs";

// `RuleTester` drives whatever test runner it is handed; without this it falls
// back to its own describe/it shims and every case collapses into one opaque
// pass or failure.
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run("menu-group-icon-parity", rule, {
  valid: [
    // The shape the fix asked for: the container menu's lifecycle group, whole.
    {
      code: `const x = (
        <Menu.Group label={name}>
          <Menu.Item icon="term" onClick={shell}>Open a shell</Menu.Item>
          <Menu.Item icon="eye" onClick={inspect}>Inspect it</Menu.Item>
          <Menu.Item icon="play" onClick={start}>Start</Menu.Item>
          <Menu.Item icon="refresh" onClick={restart}>Restart</Menu.Item>
          <Menu.Item icon="stop" onClick={stop}>Stop</Menu.Item>
        </Menu.Group>
      );`,
    },
    // The other legitimate direction, and there are three of these in the tree.
    // A group that uses no icons at all is not a group missing them.
    {
      code: `const x = (
        <Menu.Group label="Without waiting">
          <Menu.Item destructive onClick={kill}>Kill</Menu.Item>
          <Menu.Item destructive onClick={remove}>Remove</Menu.Item>
        </Menu.Group>
      );`,
    },
    // One row cannot disagree with itself.
    {
      code: `const x = (
        <Menu.Group label={row.name}>
          <Menu.Item icon="pencil" onClick={rename}>Rename</Menu.Item>
        </Menu.Group>
      );`,
    },
    // A row outside any group. The invariant's boundary is the group, and the
    // avatar menu's sign-out row sits after a separator on purpose.
    {
      code: `const x = (
        <Menu trigger={t}>
          <Menu.Group label={name}>
            <Menu.Item icon="user">Account</Menu.Item>
          </Menu.Group>
          <Menu.Separator />
          <Menu.Item icon="back" destructive>Sign out</Menu.Item>
        </Menu>
      );`,
    },
    // A dynamic glyph. Whether it is set is a runtime fact, so the group is
    // skipped whole rather than guessed at.
    {
      code: `const x = (
        <Menu.Group label="Organizations">
          <Menu.Item icon={each.glyph}>{each.name}</Menu.Item>
          <Menu.Item>Something else</Menu.Item>
        </Menu.Group>
      );`,
    },
    // A spread can carry `icon` and nothing here can see it.
    {
      code: `const x = (
        <Menu.Group label="Organizations">
          <Menu.Item icon="net">One</Menu.Item>
          <Menu.Item {...rest}>Two</Menu.Item>
        </Menu.Group>
      );`,
    },
    // Two groups, each consistent on its own terms — which is the whole point
    // of scoping the invariant to the group: the container menu is exactly this.
    {
      code: `const x = (
        <Menu trigger={t}>
          <Menu.Group label={name}>
            <Menu.Item icon="play">Start</Menu.Item>
            <Menu.Item icon="stop">Stop</Menu.Item>
          </Menu.Group>
          <Menu.Separator />
          <Menu.Group label="Immediately">
            <Menu.Item destructive>Kill</Menu.Item>
          </Menu.Group>
        </Menu>
      );`,
    },
    // Rows built in a `.map()`, all of them iconed. The generic walk is what
    // reaches these — `org-switcher` and `scope-identity` are both this shape.
    {
      code: `const x = (
        <Menu.Group label="Organizations">
          {rows.map((each) => (
            <Menu.Item key={each.id} icon="net">{each.name}</Menu.Item>
          ))}
          <Menu.Item icon="cog">Settings</Menu.Item>
        </Menu.Group>
      );`,
    },
    // `MenuRow` is the same row outside a menu and is not governed here: it has
    // no group to be consistent with.
    {
      code: `const x = (
        <div>
          <MenuRow icon="branch" chevron>Source</MenuRow>
          <MenuRow>Domains</MenuRow>
        </div>
      );`,
    },
  ],

  invalid: [
    // The original defect, in the shape it shipped in: four glyphs and a bare Stop.
    {
      code: `const x = (
        <Menu.Group label={name}>
          <Menu.Item icon="term">Open a shell</Menu.Item>
          <Menu.Item icon="eye">Inspect it</Menu.Item>
          <Menu.Item icon="play">Start</Menu.Item>
          <Menu.Item icon="refresh">Restart</Menu.Item>
          <Menu.Item>Stop</Menu.Item>
        </Menu.Group>
      );`,
      errors: [
        {
          messageId: "mixedIcons",
          data: { iconed: 4, bare: 1, total: 4 },
          line: 7,
        },
      ],
    },
    // The mistake the other way round: one glyph in a group that uses none.
    // Reported on the iconed row, because that is the smaller set.
    {
      code: `const x = (
        <Menu.Group label="Without waiting">
          <Menu.Item destructive>Kill</Menu.Item>
          <Menu.Item destructive>Remove</Menu.Item>
          <Menu.Item icon="trash" destructive>Prune</Menu.Item>
        </Menu.Group>
      );`,
      errors: [{ messageId: "mixedBare", line: 5 }],
    },
    // A tie goes to the bare rows: with nothing to break it, the group is read
    // as one that uses icons, since that is the direction of the console.
    {
      code: `const x = (
        <Menu.Group label={name}>
          <Menu.Item icon="play">Start</Menu.Item>
          <Menu.Item>Stop</Menu.Item>
        </Menu.Group>
      );`,
      errors: [{ messageId: "mixedIcons" }],
    },
    // `icon={undefined}` is a bare row written the long way, not a dynamic one.
    {
      code: `const x = (
        <Menu.Group label={name}>
          <Menu.Item icon="play">Start</Menu.Item>
          <Menu.Item icon="refresh">Restart</Menu.Item>
          <Menu.Item icon={undefined}>Stop</Menu.Item>
        </Menu.Group>
      );`,
      errors: [{ messageId: "mixedIcons", line: 5 }],
    },
    // The bare spelling of both components, so importing `MenuItem` and
    // `MenuGroup` directly is not a way round the rule.
    {
      code: `const x = (
        <MenuGroup label={name}>
          <MenuItem icon="play">Start</MenuItem>
          <MenuItem>Stop</MenuItem>
        </MenuGroup>
      );`,
      errors: [{ messageId: "mixedIcons" }],
    },
    // The bare row inside a `.map()`, which is where the next one will be
    // written — the walk has to reach it to report it.
    {
      code: `const x = (
        <Menu.Group label="Organizations">
          <Menu.Item icon="net">Primary</Menu.Item>
          <Menu.Item icon="net">Secondary</Menu.Item>
          {rows.map((each) => (
            <Menu.Item key={each.id}>{each.name}</Menu.Item>
          ))}
        </Menu.Group>
      );`,
      errors: [{ messageId: "mixedIcons" }],
    },
    // Two groups, two independent mistakes, two reports.
    {
      code: `const x = (
        <Menu trigger={t}>
          <Menu.Group label={name}>
            <Menu.Item icon="play">Start</Menu.Item>
            <Menu.Item>Stop</Menu.Item>
          </Menu.Group>
          <Menu.Group label="Immediately">
            <Menu.Item icon="zap">Kill</Menu.Item>
            <Menu.Item>Remove</Menu.Item>
          </Menu.Group>
        </Menu>
      );`,
      errors: [
        { messageId: "mixedIcons", line: 5 },
        { messageId: "mixedIcons", line: 9 },
      ],
    },
  ],
});
