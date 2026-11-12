---
name: build
description: Build an approved spec's tickets onto `main`, one background agent per ready ticket, test first; then the full suites, live acceptance, a review, push, and close the tickets and the spec. Give it a spec or ticket number, or nothing to build every ticketed spec in turn.
disable-model-invocation: true
---

`/build` turns the tickets `/plan` published into commits on `main`. You orchestrate: implementer agents write the code, you land it, check it and close the issues. History stays linear, and work lands on `main` directly, with no feature branch and no pull request.

GitHub reads and writes go through the GitHub MCP tools where the session has them, otherwise `gh`.

## 1. Pick what to build

- **A spec number**: that spec and its tickets.
- **A ticket number**: that ticket alone; find its parent spec (its sub-issue parent) for context.
- **Nothing**: the **spec queue**. Every open issue labelled `spec` that has sub-issues, oldest first, except that a spec blocked by another open spec waits for it. A `spec` with no sub-issues is not ticketed yet: leave it out and name it in the end report. A spec whose tickets are all closed still goes in, so steps 5 to 8 run and close it.

Show the user the list (number, title, open tickets) and start without waiting. A queue runs one spec at a time, steps 2 to 8 each, every spec starting from the `main` the last one left.

## 2. Read the task graph

Read the spec and every ticket in full, with their comments. The tickets are a graph, not a list: a ticket's blockers are its native "blocked by" dependencies (`gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by`; the MCP `issue_read` result's `issue_dependencies_summary` gives the count), or a `Blocked by #<n>` line in its body where the links could not be made.

A ticket is **held** when it is labelled `human` or `needs-info`, or assigned to anyone but the user driving the session. No agent takes a held ticket, and every ticket it blocks waits behind it. The **frontier** is every open, unheld `agent` ticket whose blockers are all **done**: closed, or landed on local `main` earlier in this run (tickets close only at step 7, so a ticket blocked by one built in the same run starts once its blocker lands).

Note the commit `main` is on now; the review in step 6 covers everything after it.

## 3. Build the frontier

For each frontier ticket, assign it to the user (the claim), then start one implementer agent: `isolation: "worktree"` from the current `main`, `run_in_background: true`, prompted with [`IMPLEMENTER.md`](IMPLEMENTER.md) and the ticket's number. Start the whole frontier in one message so the agents run in parallel. Keep the prompt to pointers (the spec and ticket numbers, the seams the spec names); the agent reads the issues itself.

## 4. Land each ticket as it finishes

When an agent reports `TICKET DONE`, land its commits on local `main`:

1. In its worktree, rebase its branch onto `main`; then fast-forward `main` to it. Never a merge commit.
2. A conflict is two intents meeting. Read both sides' commits and tickets, keep both where they fit, and where they cannot, keep the one this spec asked for and say so in the end report. Never drop someone else's change to make a rebase go through, and never abort the rebase to dodge a conflict.
3. Re-run the test files the conflicted or rebased files touch, from `main`.

Then recompute the frontier: a ticket the landed one unblocked starts at once (step 3). An agent that reports `TICKET BLOCKED` keeps its ticket open: comment on it with what blocked it, unassign it, and treat it as held.

Done when no agent is running and the frontier is empty.

## 5. Run the full suites, once

From `main`, run every lane the spec's changes reach, as `docs/testing.md` describes, one at a time (they share a machine-wide lock), with no implementer running alongside and no outer `timeout` of your own (the lanes' watchdog ends a stalled run with 124):

| Lane | Command |
|---|---|
| backend unit | `cd backend && npx jest` |
| backend database | `cd backend && pnpm test:db` (Docker) |
| backend e2e | the **related suites** only (Docker): every `test/<area>/**/*.e2e-spec.ts` for each `src/<area>/` the spec changed, plus every e2e spec it added or changed, run as `npx jest --config ./test/jest-e2e.json --runTestsByPath <files>`. Not `--findRelatedTests`: every e2e spec imports the whole app, so it selects all of them. The full lane (over 350 suites) is CI's |
| frontend | `cd frontend && npx vitest run` |
| CLI | `cd cli && npx vitest run` |
| each changed package | `npm run typecheck` and `npm run lint` (the backend's need `NODE_OPTIONS=--max-old-space-size=8192`; exit 134 is the default heap running out) |

A single red suite is usually the known flake: re-run it alone with `--runTestsByPath` before believing it. A worker that `ran out of memory` is a resource problem, and exit code **124** is a stalled run; re-run either alone. A suite red alone is real, unless it is red on the commit noted in step 2 as well: then it is not this spec's, so record it in the end report as a `/fix` candidate and move on. Fix the rest with one implementer agent and re-run the red lanes until green.

If Docker is not available and the spec changed the backend, the database and e2e lanes cannot run here. Stop before pushing and tell the user, rather than landing untested backend work.

**Live acceptance.** If the spec or a ticket has a `## Live acceptance` section, run it now by [`LIVE-ACCEPTANCE.md`](LIVE-ACCEPTANCE.md). It is done when every live criterion is recorded as passed, failed, or not runnable here, with the reason.

## 6. Review, then fix

Review everything since the commit noted in step 2, along two axes, in two agents started in parallel so neither colours the other:

- **Standards**: the diff against `CODING_STANDARDS.md`, the ADRs in `docs/adr/` that cover the changed areas, `CONTEXT.md`'s terms (an _Avoid_ word in new code, copy or test names), and `frontend/docs/design-system.md` for console changes. Each finding cites the rule it breaks.
- **Spec**: the diff against the spec and its tickets. What was asked and is missing or partial, what was built but not asked for, and what looks built but wrong. Each finding quotes the line it measures against.

Show both reports side by side, unmerged. Fix every finding in one implementer agent (or say why a finding is wrong), land it as in step 4, and re-run the tests it touched.

## 7. Push and close

`git pull --rebase origin main` (re-run the touched tests if anything came in), then `git push origin main`.

Close each ticket as completed with a comment naming its commits and what now shows it works (the test, or the live evidence). A ticket with a live criterion that failed or was not runnable stays open, with a comment naming each such criterion and why. Close the spec with its last ticket, with a comment listing the tickets and commits. Leave the spec open while any ticket is held or open, and say which.

## 8. Clean up and report

Remove every implementer worktree and its branch.

End with one report for the whole run: each spec and ticket closed (title, link, commits), each one held, blocked or still open and why, each live criterion not passed, any conflict where one side's intent was kept over the other's, and, for a queue, the specs left out as not yet ticketed.
