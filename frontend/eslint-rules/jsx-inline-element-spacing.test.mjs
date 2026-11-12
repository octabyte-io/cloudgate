import { RuleTester } from "eslint";
import { afterAll, describe, it } from "vitest";

import rule from "./jsx-inline-element-spacing.mjs";

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

ruleTester.run("jsx-inline-element-spacing", rule, {
  valid: [
    // The guard itself. This is what the 283 correct sites look like.
    {
      code: `const x = (
        <p>
          Runs <code>system prune</code>{" "}
          — everything in the list below
        </p>
      );`,
    },
    // Both on one line: the space is on the text node's last line, so it
    // survives. This is the asymmetry the design system's rule 3 is about.
    { code: `const x = <p>Runs <code>system</code> prunes now</p>;` },
    // Punctuation after the element. A space here would be the defect.
    {
      code: `const x = (
        <p>
          Deletes <strong>3 Servers</strong>
          , with every Environment of this Organization.
        </p>
      );`,
    },
    // The \`(<a>#26</a>)\` case, in the shape it actually ships in.
    {
      code: `const x = (
        <p>
          see (
          <a href="https://example.test/issues/27">
            #26
          </a>
          ), so the readiness check is how you find out.
        </p>
      );`,
    },
    // Block-level neighbour: the whitespace is invisible either way.
    {
      code: `const x = (
        <p>
          Your password
          <span className="block">was changed 4 days ago</span>
          and is still valid.
        </p>
      );`,
    },
    // A block-level tag, whatever its classes say.
    {
      code: `const x = (
        <div>
          intro
          <p>body</p>
          outro
        </div>
      );`,
    },
    // Flex/grid parent: the children are separate items and the gap does the
    // spacing. sign-in-form.tsx's "or" separator.
    {
      code: `const x = (
        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
        </div>
      );`,
    },
    // A component renders who-knows-what; guessing at its display would be a
    // false positive factory.
    {
      code: `const x = (
        <p>
          Status <Badge>running</Badge>
          since yesterday
        </p>
      );`,
    },
    // Nothing rendered before the boundary, so nothing to collide with.
    {
      code: `const x = (
        <p>
          text <span className="h-px" />
          more text
        </p>
      );`,
    },
    // The neighbour is an expression, not an element.
    {
      code: `const x = (
        <p>
          text {value}
          more text
        </p>
      );`,
    },
    // Trailing whitespace-only text: nothing follows to collide with.
    {
      code: `const x = (
        <p>
          Runs <code>system</code>
        </p>
      );`,
    },
    // Nearly every className in this codebase is a `cn(...)` call. The tokens
    // inside it still have to be read, or `grid`/`block` go invisible.
    {
      code: `const x = (
        <p>
          gutter <span className={cn("grid flex-none", done && "bg-ok")}>4</span>
          changed lines
        </p>
      );`,
    },
    {
      code: `const x = (
        <p>
          gutter <span className={\`\${base} block\`}>4</span>
          changed lines
        </p>
      );`,
    },
    // A neighbour whose edge is an expression: unknowable, so not guessed at.
    // Measured on the tree — guessing costs two false positives and catches
    // nothing.
    {
      code: `const x = (
        <p>
          Deleting <strong>{describe(count, "Server")}</strong>
          cannot be undone
        </p>
      );`,
    },
    // The following text starts with an em dash, not an alphanumeric.
    {
      code: `const x = (
        <p>
          Runs <code>system prune</code>
          — everything in the list below
        </p>
      );`,
    },

    // ---- The second predicate: the space is in the source ----------

    // Multi-line and the space is there, but no entity in the node. 77 of the
    // 83 sites measured look like this and every one of them keeps its
    // space in the bundle.
    {
      code: `const x = (
        <p>
          Runs <code>system</code> prunes — everything in the list
          below except volumes.
        </p>
      );`,
    },
    // An entity, but the node is one line: nothing to strip.
    {
      code: `const x = <p>Runs <code>system</code> prunes, somebody&rsquo;s data.</p>;`,
    },
    // An entity and more lines, but no space on the closing tag's own line —
    // that is the first predicate's shape, and here the text it would join is
    // punctuation, so neither fires.
    {
      code: `const x = (
        <p>
          Deletes <strong>3 Servers</strong>
          , with every Environment of this Organization&rsquo;s.
        </p>
      );`,
    },
    // The guard already in place. The text node's own leading whitespace now
    // faces a newline, and the {" "} stands between it and the element, so
    // neither predicate has a boundary to look at.
    {
      code: `const x = (
        <p>
          <code>DOCKER_CONFIG=/root/.docker</code>{" "}
          is appended only when this stack&rsquo;s own variables do not
          mention the name.
        </p>
      );`,
    },
    // An interpolation followed by a one-line text node: nothing to strip,
    // entity or not (the predicate was widened past elements, not past this).
    {
      code: `const x = <p>{count} of this Organization&rsquo;s providers</p>;`,
    },
    // Flex parent: the gap does the spacing, entity or not.
    {
      code: `const x = (
        <div className="flex items-center gap-3">
          <strong>one host</strong> — the machine Cloudgate&rsquo;s
          own agent runs on
        </div>
      );`,
    },
  ],

  invalid: [
    // The issue's own example.
    {
      code: `const x = (
        <p>
          Runs <code>system</code>
          prunes — everything in the list below
        </p>
      );`,
      output: `const x = (
        <p>
          Runs <code>system</code>{" "}
          prunes — everything in the list below
        </p>
      );`,
      errors: [{ messageId: "joined", data: { joined: "systemprunes" } }],
    },
    // \`on localhostkeeps running\`, which reached a real screen.
    {
      code: `const x = (
        <p>
          on <code>localhost</code>
          keeps running after you close this
        </p>
      );`,
      output: `const x = (
        <p>
          on <code>localhost</code>{" "}
          keeps running after you close this
        </p>
      );`,
      errors: [{ messageId: "joined", data: { joined: "localhostkeeps" } }],
    },
    // \`This is the staticconfig.\` — the one the DOM detector caught.
    {
      code: `const x = (
        <p>
          This is the <strong>static</strong>
          config.
        </p>
      );`,
      output: `const x = (
        <p>
          This is the <strong>static</strong>{" "}
          config.
        </p>
      );`,
      errors: [{ messageId: "joined", data: { joined: "staticconfig" } }],
    },
    // The last rendered character comes from a nested element.
    {
      code: `const x = (
        <p>
          see <a href="#"><code>ports.controller.ts</code></a>
          can create a Port
        </p>
      );`,
      output: `const x = (
        <p>
          see <a href="#"><code>ports.controller.ts</code></a>{" "}
          can create a Port
        </p>
      );`,
      errors: [
        { messageId: "joined", data: { joined: "ports.controller.tscan" } },
      ],
    },
    // Two inline elements with only a newline between them: same collision,
    // no text node in the middle to read it off.
    {
      code: `const x = (
        <p>
          <code>a</code>
          <code>b</code>
        </p>
      );`,
      output: `const x = (
        <p>
          <code>a</code>{" "}
          <code>b</code>
        </p>
      );`,
      errors: [{ messageId: "joined", data: { joined: "ab" } }],
    },
    // A digit on one side is still a collision.
    {
      code: `const x = (
        <p>
          Deleting <em>4</em>
          Servers cannot be undone
        </p>
      );`,
      output: `const x = (
        <p>
          Deleting <em>4</em>{" "}
          Servers cannot be undone
        </p>
      );`,
      errors: [{ messageId: "joined", data: { joined: "4Servers" } }],
    },
    // Inside a fragment, and with a class list that says nothing about display.
    {
      code: `const x = (
        <>
          the <span className={cn("font-mono", tone)}>deploy pipeline</span>
          starts being refused
        </>
      );`,
      output: `const x = (
        <>
          the <span className={cn("font-mono", tone)}>deploy pipeline</span>{" "}
          starts being refused
        </>
      );`,
      errors: [{ messageId: "joined", data: { joined: "pipelinestarts" } }],
    },

    // ---- The second predicate: the space is in the source ----------
    //
    // Six sites in the tree, all measured off the shipped bundle. Four of them
    // are below, one per distinct reason the first predicate could not see it.

    // The `systemprunes` site, and the one the first predicate comes closest to
    // catching: it reads the source as already correct, because it is.
    {
      code: `const x = (
        <p>
          Runs <code>system</code> prunes — everything in the list below
          except volumes, which are still somebody&rsquo;s data.
        </p>
      );`,
      output: `const x = (
        <p>
          Runs <code>system</code>{" "}
          prunes — everything in the list below
          except volumes, which are still somebody&rsquo;s data.
        </p>
      );`,
      errors: [
        { messageId: "entityStripped", data: { joined: "systemprunes" } },
      ],
    },
    // `one host— the machine`. An em dash, so the alphanumeric filter would
    // skip it — and it is still a defect, because the author typed the space
    // on the closing tag's own line. This is why the second predicate carries
    // no such filter.
    {
      code: `const x = (
        <p>
          it reaches <strong>one host</strong> — the machine Cloudgate runs
          on. A remote Server&rsquo;s history is the card below.
        </p>
      );`,
      output: `const x = (
        <p>
          it reaches <strong>one host</strong>{" "}
          — the machine Cloudgate runs
          on. A remote Server&rsquo;s history is the card below.
        </p>
      );`,
      errors: [{ messageId: "entityStripped", data: { joined: "host—" } }],
    },
    // `rooton the machine`. An interpolation at the element's edge, which the
    // first predicate declines to guess at — it needs the character to know
    // whether the space mattered. This one does not, so the message shows the
    // expression instead of guessing what it renders.
    {
      code: `const x = (
        <p>
          You are <code>{session.username}</code> on the machine Cloudgate
          itself runs on, and nothing you run is in Cloudgate&rsquo;s record.
        </p>
      );`,
      output: `const x = (
        <p>
          You are <code>{session.username}</code>{" "}
          on the machine Cloudgate
          itself runs on, and nothing you run is in Cloudgate&rsquo;s record.
        </p>
      );`,
      errors: [
        {
          messageId: "entityStripped",
          data: { joined: "{session.username}on" },
        },
      ],
    },
    // A numeric character reference is a character reference. The transform has
    // the same decoding to do either way.
    {
      code: `const x = (
        <p>
          The <strong>Ports</strong> columns come from the host&#8217;s whole
          container listing, which did not answer.
        </p>
      );`,
      output: `const x = (
        <p>
          The <strong>Ports</strong>{" "}
          columns come from the host&#8217;s whole
          container listing, which did not answer.
        </p>
      );`,
      errors: [
        { messageId: "entityStripped", data: { joined: "Portscolumns" } },
      ],
    },

    // ---- …whatever the text follows ---------------------------------
    //
    // The build does not look at the left-hand neighbour, so neither does the
    // second predicate. This is the stopped Server's card as it shipped,
    // "more than 2 daysold": an interpolation, not an element, before the text.
    {
      code: `const x = (
        <p>
          Each one is deleted once it is more than {days}{" "}
          {days === 1 ? "day" : "days"} old, by the retention cleanup that goes on
          running, and the Server&rsquo;s Telemetry tab reads all of them.
        </p>
      );`,
      output: `const x = (
        <p>
          Each one is deleted once it is more than {days}{" "}
          {days === 1 ? "day" : "days"}{" "}
          old, by the retention cleanup that goes on
          running, and the Server&rsquo;s Telemetry tab reads all of them.
        </p>
      );`,
      errors: [
        {
          messageId: "entityStripped",
          data: { joined: '{days === 1 ? "day" : "days"}old,' },
        },
      ],
    },
    // A component on the left, which the first predicate declines to judge
    // because it cannot see what it renders. This one was a *valid* case until
    // the predicate was widened, on that reasoning — but the author typed the
    // space, so whatever `Badge` renders, the space was wanted and the build
    // still drops it.
    {
      code: `const x = (
        <p>
          Status <Badge>running</Badge> since yesterday, and it&rsquo;s
          still running now.
        </p>
      );`,
      output: `const x = (
        <p>
          Status <Badge>running</Badge>{" "}
          since yesterday, and it&rsquo;s
          still running now.
        </p>
      );`,
      errors: [{ messageId: "entityStripped", data: { joined: "runningsince" } }],
    },
  ],
});
