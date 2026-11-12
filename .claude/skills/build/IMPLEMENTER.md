# Implementer brief

The prompt `/build` gives each implementer agent, with `<n>` and `<spec>` filled in. Send it as written.

---

You are building ticket #<n> of spec #<spec> in Cloudgate, in your own git worktree branched from `main`. Before anything else, `git merge --ff-only main`: a new worktree can start from the last pushed commit rather than local `main`, and miss tickets landed since. Then `pnpm install --frozen-lockfile` at its root, since a fresh worktree has no dependencies. Read the ticket and the spec in full, with their comments, before writing anything (the GitHub MCP tools where the session has them, otherwise `gh issue view`). Read `CLAUDE.md`, the `CONTEXT.md` terms the ticket uses, the ADRs in `docs/adr/` for the area you touch, and `CODING_STANDARDS.md` §1.7 (tests). For console work, also read `frontend/AGENTS.md` and `frontend/docs/design-system.md`; the design system wins over any other design guidance.

**Build test first, one slice at a time.** For each behaviour in the ticket's acceptance criteria:

1. Write one test at the seam the spec's Testing decisions name (or the highest seam that reaches the behaviour): an e2e spec through the Nest app for backend behaviour, a co-located `*.test.ts(x)` for frontend logic. Name it as a fact (`'refuses a second Domain on the same port'`), never `should`. Take expected values from the spec or a worked example, never recomputed the way the code computes them. Replace only system boundaries (SSH, Docker, the network, mail, payment APIs), through DI overrides as the tree already does.
2. Run it and see it fail for the reason you expect.
3. Write the least code that makes it pass, and see it pass.

Then the next behaviour. Refactor only once the ticket's tests are green, and only inside what the ticket touches.

**Run only the test files your change touches**: `cd backend && npx jest --runTestsByPath <files>` (add `--config ./test/jest-e2e.json` for an e2e spec), `cd frontend && npx vitest run <files>`. Run the changed package's `npm run typecheck` and `npx eslint <changed files>` before you finish. The full suites are the orchestrator's, run once at the end; do not run them. A suite you did not touch that goes red is not yours until it is red alone.

**Stay in the ticket.** What the ticket's criteria need, and the prefactoring that makes it easy, nothing more. Something outside the ticket that you think should change goes in your final message, not in the code.

**Commit** in your worktree, one commit per coherent step, each message in the repo's style (`CODING_STANDARDS.md` §1.3):

```
<area>: <what is now true, as a fact> (#<n>)

<why, in a sentence or two>
```

Do not push, do not merge into `main`, and do not write to GitHub; the orchestrator lands your commits and closes the ticket.

**Finish** with one of:

- `TICKET DONE`, then: your worktree path and branch, your commits (hash and subject), each acceptance criterion with the test that proves it, the commands you ran and their results, and anything you noticed outside the ticket.
- `TICKET BLOCKED`, then: what stops you (a missing decision, a blocker that is not actually closed, a criterion that contradicts an ADR or the code), what you tried, and what would unblock it. Commit nothing half-done.
