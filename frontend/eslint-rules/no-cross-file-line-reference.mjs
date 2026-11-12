/**
 * `no-cross-file-line-reference` — CODING_STANDARDS §1.2, enforced.
 *
 * §1.2's rule: **cite the symbol, never the line, when a reference crosses a
 * file — and especially when it crosses a package.** `ComposeService.removeContainers`
 * costs a reader one grep and cannot rot. A `file.ts:NN` costs the same grep,
 * *plus* the work of noticing it is lying.
 *
 * The argument for a machine rather than a convention is in §1.2 and it is
 * measured, not reasoned. Three of these were found wrong in a single phase
 * (H-103, H-106, H-112): a modal cited a method at line 318 that was at **374
 * in the commit that wrote the reference** — wrong on day one, not drift — and
 * two more cited a line for behaviour that had just been deleted, so they were
 * not stale but false. A sample of ten of the 49 references in `src` found
 * essentially none landing on the symbol it named: blank lines, a `);`
 * mid-expression, a docblock's own `*`. A sweep converted all 49; this rule is
 * what holds the count at zero, because a one-off sweep leaves the tree right
 * and nothing keeping it there.
 *
 * Two exemptions, both §1.2's own, and neither is a courtesy:
 *
 * - **Same file.** "Line numbers are still fine inside one file's own docblock
 *   where the distance is small enough to be checked at a glance." A reference
 *   whose cited basename is the containing file's own basename is therefore
 *   allowed — the reader can see the drift on the same screen as the citation.
 * - **`.project/` paths.** Those records are "pinned to a commit by
 *   construction": a phase record describes the tree as it was, so a line
 *   number in one is a fact about a commit rather than a claim about HEAD, and
 *   repointing it at a moved symbol would make it *less* true.
 *
 * Scanned over comment tokens only — `Block` and `Line`. §1.2 is a rule about
 * comments, and a `file.ts:NN` inside a string literal is a stack frame, a test
 * fixture or a log line, none of which this rule has anything to say about.
 *
 * The escape hatch is an inline `eslint-disable-next-line` with a one-line
 * reason, for a reference that genuinely cannot be resolved to a symbol. It
 * should be rare, and each one is a small admission worth reading.
 */

import path from "node:path";

/**
 * A cited path ending in a line number, with as much leading path as the
 * comment carries.
 *
 * The leading `[A-Za-z0-9_.\-/]*\/` is not decoration — it is what makes the
 * `.project/` exemption checkable, since the exemption is a property of the
 * *directory* and the basename alone cannot see it. It also swallows the
 * `docker/` in `docker/docker.utils.ts:18`, which is how those references are
 * actually written here.
 *
 * The trailing group stops at the first line number, so a range
 * (`auth.config.ts:415-441`) matches on its first half and is reported once.
 */
const REFERENCE =
  /(?:[A-Za-z0-9_.\-/]*\/)?([A-Za-z0-9_.-]+\.(?:ts|tsx|mjs)):(\d+)/gu;

/** §1.2 exempts these explicitly: pinned to a commit by construction. */
const PINNED_DIRECTORY = ".project/";

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "require a symbol rather than a line number when a comment references another file (CODING_STANDARDS §1.2)",
      recommended: true,
    },
    schema: [],
    messages: {
      crossFile:
        "`{{reference}}` cites a line in another file. Cite the symbol instead — `ComposeService.removeContainers`, not `compose.service.ts:318` (CODING_STANDARDS §1.2). A stale line number is worse than none: a reader who follows it lands on plausible-looking code and draws a conclusion from the wrong function.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode;
    // `path.basename` and not a slash split, because the filename arrives
    // platform-shaped from the CLI and `<input>` when a RuleTester case gives
    // none — neither of which can equal a cited `*.ts`, so both fall through
    // to reporting, which is the safe direction.
    const own = path.basename(context.filename ?? "");

    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          if (comment.type !== "Block" && comment.type !== "Line") continue;

          REFERENCE.lastIndex = 0;
          let match;
          while ((match = REFERENCE.exec(comment.value)) !== null) {
            const [cited, basename] = match;
            if (cited.includes(PINNED_DIRECTORY)) continue;
            if (basename === own) continue;

            // Offset from the comment's own start: `comment.value` drops the
            // opening `/*` or `//`, so the two characters go back on to land
            // the report under the reference rather than on the whole block.
            const start = comment.range[0] + 2 + match.index;
            context.report({
              loc: {
                start: sourceCode.getLocFromIndex(start),
                end: sourceCode.getLocFromIndex(start + cited.length),
              },
              messageId: "crossFile",
              data: { reference: cited },
            });
          }
        }
      },
    };
  },
};

export default rule;
