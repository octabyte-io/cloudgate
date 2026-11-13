---
name: plan
description: "Cloudgate's starting point for anything new. Load it before writing code or giving design advice. Use it whenever the user wants the product to do something it doesn't do yet: \"I want people to be able to…\", \"thinking about letting…\", \"what would we need to decide?\", \"let's plan…\". Use it for both large and small features, including a small, fully specified UI addition the user wants written up as a spec or ticket. Also use it when they ask to prototype or compare options for how a new screen or interaction should look, or when they point to a plan map, a question issue or `/plan --all` by number. The skill researches the code, asks the user each open decision, then publishes an approved spec issue with tickets on GitHub. Don't use it for broken behaviour, errors or slowness (`/fix`), for adjusting existing polish, for building approved tickets (`/build`), or for code review, pure research or explaining past decisions."
---

`/plan` takes a rough idea to a `spec` issue and its tickets, approved together. The user owns every **decision**; you own every **fact**. Look facts up yourself, put decisions to the user, and wait for each answer.

Three ways in:

- **A rough idea** (most runs): steps 1 to 6 below.
- **A `plan` map or `question` issue** (a number or link): read [`LARGE.md`](LARGE.md), section "Work one question".
- **`/plan --all`**: read [`LARGE.md`](LARGE.md), section "Run every ready question".

## 1. Research first

Before asking anything, read what bears on the idea: the code it touches, `CONTEXT.md` (use its terms, and its _Avoid_ words never), the ADRs in `docs/adr/` for that area, and the existing screens or modules it extends. Fetch outside docs where a fact is needed (a provider's API, a library's limit), from the primary source.

Keep what you find in the session; it goes on the spec or the ticket it informs. A finding never gets its own branch, file or issue.

Done when every question you are about to ask is one only the user can answer: nothing on the list is a fact you could have looked up.

## 2. Check the size

- **Small or medium** (most features): one session can hold the whole plan. Continue with step 3. Nothing goes on GitHub until step 6.
- **Large**: more than one session can hold, because decisions hang on decisions not yet reachable, or the work spans several areas that each need their own round of questions. Read [`LARGE.md`](LARGE.md), section "Chart the map", and follow it instead of steps 3 to 6.

Tell the user which size you chose and why, in one line. If they disagree, switch.

A request to "just prototype X" is small: go to step 3 and build the prototype as the first question.

## 3. Ask the open decisions

Work the decisions as a tree: some only make sense once others are settled. Each round, ask only the questions whose prerequisites are already answered, at most three, numbered. Every question uses plain words (short sentences, no jargon a newcomer would look up, a domain term only once explained) and this layout:

```markdown
### Q1 · <plain title>

<the question, in one or two sentences>

- **a)** <option>
- **b)** <option>

**Example:** <a real-world case that makes it concrete: a named Project, Service, Server or screen the user can picture, and what each option would mean for it>

**Recommend: <letter>.** <why, in a sentence or two>

---

### Q2 · <plain title>
...

---

**Reply** with one line, e.g. `1a, 2b`, or "as recommended".
```

Give lettered options whenever the answer is a choice; an open question ("what should the limit be?") has none, and its recommendation names a value. Findings that set up the questions (what research turned up) go above the first question, kept short.

Then stop and wait for the user's reply. Their answer is the only answer: never answer a question yourself, never proceed on "my recommendation stands", and never treat silence as agreement. If they reply "as recommended", that is their answer to the questions in that round only.

When a question is "how should this look" or "how should this behave", build a prototype and ask the user to react to it: read [`PROTOTYPE.md`](PROTOTYPE.md).

Recompute after each answer: settled decisions unlock new questions, and some answers make others moot. Done when no open decision is left and nothing has been silently assumed.

## 4. Record decisions as they are made

Right after the answer that settles it, not batched at the end:

- **A new or changed term** goes into `CONTEXT.md`: bold term, one or two sentences on what it _is_, and an `_Avoid_:` line naming the words it replaces. Domain words only; no implementation detail.
- **A decision with a real trade-off** becomes an ADR: hard to reverse, surprising to a future reader without context, and chosen over a genuine alternative. All three, or skip it. File `docs/adr/NNNN-<the-decision-as-a-sentence>.md`, next free number; a title and a paragraph saying the context, the decision and why is enough.

If a decision contradicts an existing ADR, say so to the user and record a new ADR that supersedes it; never edit the old one silently.

## 5. Draft the spec and tickets together

Show both in the chat in one message, and ask the user to approve them together. Iterate until they do. Their approval covers what you publish in step 6; a change after approval is shown again.

**The spec** (one issue, label `spec`):

```markdown
## Problem
<the problem, from the user's point of view>

## Solution
<the solution, from the user's point of view>

## User stories
1. As a <actor>, I want <capability>, so that <benefit>.

## Implementation decisions
<modules built or changed and their interfaces, schema changes, API contracts, notable interactions;
each decision and the research finding behind it>

## Testing decisions
<the seams the tests go through (prefer existing seams, as high as possible, as few as possible),
which behaviour each covers, and similar tests already in the tree to copy>

## Out of scope
<what this spec deliberately leaves out>
```

Name things, never locate or write them. Name the existing components and modules the change reuses (`CopyButton`, the Server facts card) and, under Testing decisions, the existing tests to copy by file name (`copy-button.test.tsx`): `/build` needs both. Name only tests that follow `CODING_STANDARDS.md` §1.7 (doubles at system boundaries only); the builder copies what you name, including its mistakes. Leave out directory paths, line numbers, props and code, which go stale before the ticket is built. The one code exception is a snippet a prototype settled (a state shape, a reducer), trimmed to the part that carries the decision.

**The tickets** (sub-issues of the spec): thin vertical slices, each complete through schema, API, UI and tests, demoable on its own, and sized for one agent session. Any prefactoring ("make the change easy") is its own ticket, first. A wide mechanical refactor (a rename or retype that breaks every call site at once) is the one exception to vertical slices: expand (add the new form beside the old), migrate in batches with a ticket each, then contract (delete the old form) once no caller remains.

```markdown
## What to build
<the end-to-end behaviour this ticket makes work, from the user's point of view>

## Acceptance criteria
- [ ] <checkable criterion>

## Live acceptance
<only when a criterion needs a real server: the walk to run on it>
```

Each ticket gets one label: `agent` (an agent can build it end to end) or `human` (it needs accounts, secrets, payment, or a check on a real server that only a person can do). In the draft, list each ticket's blockers by ticket title, so the user can check the order.

When a decision states a rule ("anything that starts containers"), find every code path the rule covers by searching the code, and list them in the ticket; the builder implements the list, not the rule. Before showing the draft, check it: every user story is covered by some ticket, every ticket's criteria are checkable, and no ticket depends on one listed after it.

## 6. Publish

Only after approval. Create the spec, then the tickets in blocker-first order as its sub-issues, then the blocking links, as [`GITHUB.md`](GITHUB.md) describes. Commit any `CONTEXT.md` and ADR changes on `main` with a message naming the spec.

End with the spec's title and link, each ticket's title, link and label, and the next step: `/build <spec number>`.
