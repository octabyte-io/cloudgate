---
name: fix
description: "Cloudgate's bug workflow: reproduce with a failing test, fix, land on `main`, close the issue. Load this skill BEFORE you investigate, read code or answer, whenever the user describes Cloudgate misbehaving, even casually or as a \"why does…\" question. That covers a 500 or stack trace, a crash, a wrong or `undefined` value, a setting that won't save, a false status or diff, a check that says something is down when it isn't, a regression (\"worked last week\", \"broke after the release\"), or a page or command that got slow. It also covers any `bug` issue number. Don't diagnose it inline; this skill does the diagnosis. Don't use it for new features, polish or taste requests, or questions about behaviour that was chosen on purpose. Those go to `/plan`. Explanations of how something works get answered directly. Security holes go to `SECURITY.md`, never a public issue."
---

`/fix` turns a bug into a commit on `main` and a closed issue. The order is fixed: **red first** (a test that fails because of the bug), then the fix, then green. A fix without a test that was red is a guess.

## 1. Read the report

Given an issue number, read the issue, its comments and labels, and assign it to the user driving the session: the assignee is the claim. Given a description, work from that.

If it describes a security vulnerability (one user reaching another Organization's data, a secret leaking, an auth bypass), stop. Say it belongs in private reporting (`SECURITY.md`), and keep the details out of any public issue or commit message.

## 2. Bug or design question?

Before writing code, find what the expected behaviour is written down as: a test, an ADR in `docs/adr/`, a `CONTEXT.md` entry, `frontend/docs/design-system.md`, a docblock, or the issue's own steps against how the product is documented to work.

- **The code breaks a written expectation**, or does something no one could have meant (a crash, wrong data, a 500, a lost write): a bug. Carry on.
- **The code does what was decided**, and the report wants it to behave differently: a design question, not a bug. Stop, tell the user in two or three lines what was decided and where (the ADR, the docblock, the glossary line), and hand it to `/plan` with what you found. On an issue, swap `bug` for `enhancement` and leave a comment saying why.
- **Nothing settles it**, and reasonable people could want either behaviour: ask the user once, in `/plan`'s question layout, whether to fix it toward a stated behaviour or hand it to `/plan`. Wait for the answer.

## 3. Reproduce: go red

Write a test that fails because of the bug, at the highest seam that reaches it (`CODING_STANDARDS.md` §1.7): an e2e spec through the Nest app for a backend behaviour, a co-located `*.test.ts(x)` for frontend logic. Name it as a fact the system should hold (`'keeps the trailing line when …'`), never `should`.

Run it and watch it go red **on the reported symptom**, not on a nearby failure. A test that fails for a different reason is a different bug.

If a red test does not come within a few tries, the cause is not where you thought: read [`DIAGNOSE.md`](DIAGNOSE.md) and build a feedback loop before guessing at causes.

If it cannot be reproduced here at all (it needs a real Server, a cloud account, or data only the reporter has), say what you tried. On an issue, add `needs-info` and comment with what is established and the specific facts still needed from the reporter (the exact steps, the version, the redacted log lines), then stop.

Done when one command, already run, shows the test red on the user's symptom.

## 4. Fix: go green

Fix the cause, not the symptom the test happens to check. Keep the change to what the bug needs; a refactor you would like to make is a separate commit or a `/plan`.

**Look for the same mistake elsewhere.** Search for the pattern that caused the bug (the same call, the same assumption, the same missing check). If it is in more than one place, the deliverable is a **census test** that fails the build for every site, including the next one someone adds, rather than fixes at the sites you happened to find. `CODING_STANDARDS.md` §1.7 ("One mistake at N sites") sets the three rules: enumerate from the producer's own declarations, assert both directions, and see the gate go red on the defect before landing it.

Then run the tests the change touches, as `docs/testing.md` says: the files, not the suite (`npx jest --runTestsByPath …` or `npx vitest run <file>`), plus the changed package's own `npm run typecheck` and `npx eslint <changed files>` (the frontend's typecheck runs `next typegen` first; a bare `tsc` there fails on generated types). The new test is now green, and so is everything it shares a file with.

A red or stalled suite you did not touch is not yours until it is red alone: re-run it by itself first. Exit code 124 is a stalled run, and `ran out of memory` is a resource problem, not a red test.

To compare against the code before your change, use `git worktree add` or `git show HEAD:<file>`, not `git stash`: worktrees share one stash list, and a parallel session's stash can be popped by yours.

Done when the new test is green, the touched files' tests and the type check pass, and the original symptom no longer reproduces.

## 5. Land and close

Check the diff against the parts of `CODING_STANDARDS.md` and the ADRs that cover the files you changed, and remove any debug logging.

Commit on top of the latest `main` (`git pull --rebase origin main`), one commit for the fix and its test, with a message that names the cause, not only the symptom:

```
<area>: <what was wrong, as a fact>

<the cause in a sentence or two, and how the test pins it>

Fixes #<n>
```

Push to `main`. If the session is told to work on a named branch, push there instead and say the fix still needs landing.

Close the issue as completed with a comment naming the commit, the cause in a sentence, and the test that now guards it. End with the same three lines for the user.

If the fix turned out to change behaviour beyond the bug, or contradicts an ADR, stop before pushing: show the user what changes and why, and wait.
