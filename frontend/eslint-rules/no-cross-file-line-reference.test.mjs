import { RuleTester } from "eslint";
import { afterAll, describe, it } from "vitest";

import rule from "./no-cross-file-line-reference.mjs";

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
  },
});

/**
 * The fixtures are plain JS with the real comments on top, because the rule
 * reads comment *tokens* and never the AST below them — so the cheapest parser
 * that produces the right token stream is the honest one to test against, and a
 * `.ts` filename on JS source is exactly what the same-file case needs.
 */
ruleTester.run("no-cross-file-line-reference", rule, {
  valid: [
    // What the rule asks for, and what all 49 converted sites now look like:
    // the symbol, which costs a reader one grep and cannot rot.
    {
      filename: "compose-source.ts",
      code: `/**
 * The five sourceTypes \`composeSourceTypeEnum\` declares in
 * \`backend/src/db/schemas/compose.schema.ts\`.
 */
const x = 1;`,
    },
    // §1.2's same-file carve-out: "line numbers are still fine inside one
    // file's own docblock where the distance is small enough to be checked at a
    // glance." The reader sees the drift on the same screen as the citation.
    {
      filename: "compose.utils.ts",
      code: `/** The throw is at \`compose.utils.ts:151\`, twelve lines down. */
const x = 1;`,
    },
    // Same, through a full path — the basename is what the carve-out turns on,
    // so the leading directory must not defeat it.
    {
      filename: "/Users/x/cloudgate/frontend/src/lib/design/status.ts",
      code: `// The table below and \`src/lib/design/status.ts:51\` are one thing.
const x = 1;`,
    },
    // §1.2's other carve-out: \`.project/\` records are "pinned to a commit by
    // construction", so a line number in one is a fact about a commit rather
    // than a claim about HEAD. Repointing it would make it less true.
    {
      filename: "fleet-aside.tsx",
      code: `/** The count is recorded at \`.project/vps-verify-3/FINDINGS.md\` and
 * derived in \`.project/frontend-phases/x09/probe.ts:44\`.
 */
const x = 1;`,
    },
    // A cited file in a nested \`.project/\` path.
    {
      filename: "kinds.ts",
      code: `// See \`docs/../.project/phases/12/harness.mjs:9\`.
const x = 1;`,
    },
    // Not a comment. A \`file.ts:NN\` in a string is a stack frame, a fixture or
    // a log line, and §1.2 is a rule about comments.
    {
      filename: "trace.ts",
      code: `const frame = "at compose.service.ts:318";`,
    },
    // Not a source file. \`eslint.config.mjs\` cites \`CONTEXT.md:28\` for the
    // glossary's own definition of Deployment, and a Markdown document has no
    // symbol to name instead.
    {
      filename: "guard.ts",
      code: `// \`CONTEXT.md:28\` defines a Deployment as one attempt to build.
const x = 1;`,
    },
    // A version, a port, a time — a colon-then-digits that is not a citation.
    {
      filename: "client.ts",
      code: `// better-auth 1.6.23 on localhost:3000 at 09:41.
const x = 1;`,
    },
  ],

  invalid: [
    // The plain cross-package case: 48 of the 49 looked like this.
    {
      filename: "container-log.tsx",
      code: `/**
 * Done inline (\`database-service.ts:194\`). So pressing Deploy on the tab
 * beside this one does nothing here.
 */
const x = 1;`,
      errors: [
        {
          messageId: "crossFile",
          data: { reference: "database-service.ts:194" },
          line: 2,
          column: 18,
          endColumn: 41,
        },
      ],
    },
    // A \`Line\` comment, which is where the two \`advanced-runtime-card.tsx\`
    // references lived. Block and Line both, per §1.2 — the rule is about the
    // claim, not the syntax carrying it.
    {
      filename: "advanced-runtime-card.tsx",
      code: `// the row's own columns like Postgres does (\`mongo.service.ts:71\`).
const x = 1;`,
      errors: [
        {
          messageId: "crossFile",
          data: { reference: "mongo.service.ts:71" },
          line: 1,
          column: 47,
        },
      ],
    },
    // A leading directory is part of the citation and has to survive into the
    // message: \`docker/docker.utils.ts:18\` was the heaviest of the 49, at
    // seven sites, and reporting it as a bare basename would hide which of the
    // two \`docker.utils.ts\` files it meant.
    {
      filename: "variables.tsx",
      code: `/** (\`docker/docker.utils.ts:18\`) maps over the service's own blob. */
const x = 1;`,
      errors: [
        {
          messageId: "crossFile",
          data: { reference: "docker/docker.utils.ts:18" },
        },
      ],
    },
    // Two in one comment, which \`instance-runtime-rows.ts\` and
    // \`fleet-aside.tsx\` both had. One report each, so fixing one does not
    // silence the other.
    {
      filename: "instance-runtime-rows.ts",
      code: `/**
 * \`install.sh:33\` and \`server-setup.ts:36\` read the same variable, and
 * \`server-setup.ts:83\` pins the Docker version.
 */
const x = 1;`,
      errors: [
        { messageId: "crossFile", data: { reference: "server-setup.ts:36" } },
        { messageId: "crossFile", data: { reference: "server-setup.ts:83" } },
      ],
    },
    // A range — \`auth.config.ts:415-441\` in \`lib/auth/client.ts\`. Reported
    // once, on its first half: two reports for one citation would read as two
    // problems.
    {
      filename: "client.ts",
      code: `/** The plugin list mirrors the server's (\`auth.config.ts:415-441\`). */
const x = 1;`,
      errors: [
        { messageId: "crossFile", data: { reference: "auth.config.ts:415" } },
      ],
    },
    // The exemptions are per citation, not per comment: a \`.project/\` record
    // beside a live one must not launder the live one.
    {
      filename: "converted-plan.ts",
      code: `/**
 * Sized in \`.project/vps-verify-3/probe.ts:12\`; the throw is at
 * \`compose.utils.ts:151\`.
 */
const x = 1;`,
      errors: [
        { messageId: "crossFile", data: { reference: "compose.utils.ts:151" } },
      ],
    },
    // A \`.tsx\` and an \`.mjs\` are cited here too, and both rot the same way.
    {
      filename: "remove-containers-modal.tsx",
      code: `// the Maintenance card sends none (\`maintenance-cleanup-card.tsx:122\`).
const x = 1;`,
      errors: [
        {
          messageId: "crossFile",
          data: { reference: "maintenance-cleanup-card.tsx:122" },
        },
      ],
    },
    {
      filename: "page.tsx",
      code: `// forwarded by \`server/forward.mjs:64\`.
const x = 1;`,
      errors: [
        { messageId: "crossFile", data: { reference: "server/forward.mjs:64" } },
      ],
    },
  ],
});
