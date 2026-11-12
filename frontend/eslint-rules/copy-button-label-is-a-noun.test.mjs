import { RuleTester } from "eslint";
import { afterAll, describe, it } from "vitest";

import rule from "./copy-button-label-is-a-noun.mjs";

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
    // The rule reads a JSX attribute, so the fixtures have to parse as JSX.
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

/**
 * The fixtures are the real call sites, both halves: the seventeen that read
 * correctly and the eleven the rule's fix corrected. Anything else risks a rule
 * that passes its own examples and reports the tree.
 */
ruleTester.run("copy-button-label-is-a-noun", rule, {
  valid: [
    // What the prop's own doc asks for, and what all twenty-eight sites now
    // pass: the noun, which the component wraps into "Copy the …".
    { code: '<CopyButton value={password} label="password" />;' },
    { code: '<CopyButton value={uri} label="external connection string" />;' },
    { code: '<CopyButton value={codes} label="backup codes" />;' },
    // A template, which two sites use for a noun carrying an id.
    {
      code: "<CopyButton value={link} label={`invitation link for ${row.email}`} />;",
    },
    // A template opening on its expression: nothing to read, and guessing would
    // report `${role} join command` — the shape the fix left behind.
    { code: "<CopyButton value={c} label={`${role} join command`} />;" },
    // A label the rule cannot see. Deliberately not chased, and deliberately
    // not reported either: a rule that guesses is a rule people turn off.
    { code: "<CopyButton value={v} label={what} />;" },
    { code: "<CopyButton value={v} label={labelFor(row)} />;" },
    // The verb belongs to every *other* label-ish prop in the tree, which is
    // why the mistake is the natural one — `CodeWell` and `KVRow` name the
    // control, and this rule must leave them alone.
    { code: '<CodeWell content={c} label="Copy the join command" />;' },
    { code: '<KVRow label="Copy" value={v} />;' },
    // Not the attribute either: a `title` or a child saying "Copy" is a
    // different element's business.
    { code: '<CopyButton value={v} title="Copy the address" label="address" />;' },
  ],

  invalid: [
    // The site this was found on, live, by a screen reader: "Copy the Copy
    // backup codes".
    {
      code: '<CopyButton value={codes.join("\\n")} label="Copy backup codes" />;',
      errors: [
        {
          messageId: "repeatedVerb",
          data: { label: "Copy backup codes" },
          line: 1,
          column: 44,
        },
      ],
    },
    // Nine of the eleven read like this — the component's whole sentence,
    // handed back to it.
    {
      code: '<CopyButton value={storedKey} label="Copy the licence key" />;',
      errors: [
        { messageId: "repeatedVerb", data: { label: "Copy the licence key" } },
      ],
    },
    // A multi-line site with other props, which is how five of the eleven were
    // written. The report lands on the string, not the element.
    {
      code: `<CopyButton
  value={server.ipAddress}
  label="Copy the address"
  size="icon-xs"
/>;`,
      errors: [
        {
          messageId: "repeatedVerb",
          data: { label: "Copy the address" },
          line: 3,
          column: 9,
        },
      ],
    },
    // The template site: `Copy the ${role} join command`, read on its first
    // quasi.
    {
      code: "<CopyButton value={join.command} label={`Copy the ${role} join command`} />;",
      errors: [
        { messageId: "repeatedVerb", data: { label: "Copy the " } },
      ],
    },
    // Case is not the point, and neither is the suffix: no `\b` after `copy`,
    // because `Copying the key` is the same defect wearing a gerund.
    {
      code: '<CopyButton value={v} label="copy the SCIM token" />;',
      errors: [{ messageId: "repeatedVerb" }],
    },
    {
      code: '<CopyButton value={v} label="Copying the key" />;',
      errors: [{ messageId: "repeatedVerb" }],
    },
    // Leading whitespace, which is what a formatter can leave behind in a
    // template.
    {
      code: "<CopyButton value={v} label={` Copy the address`} />;",
      errors: [{ messageId: "repeatedVerb" }],
    },
    // A conditional's arms are walked into rather than skipped: a site that got
    // one arm wrong has the defect on screen half the time.
    {
      code: '<CopyButton value={v} label={fresh ? "public key" : "Copy the public key"} />;',
      errors: [
        {
          messageId: "repeatedVerb",
          data: { label: "Copy the public key" },
        },
      ],
    },
  ],
});
