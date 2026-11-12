# When the bug won't go red

The test you wrote passes, or fails for the wrong reason. The cause is somewhere you have not looked. Build a **feedback loop** first; theories come after.

## Build a loop

A loop is one command that drives the bug's code path and checks the user's exact symptom. Try, roughly in this order:

1. A test at a lower or higher seam than the first one.
2. `curl` against a running backend (`npm run start` in `backend/`, with the scratch Postgres the e2e lane uses).
3. The CLI (`cli/`) with a fixture input, diffing its output against what the report says it should be.
4. A Playwright script against `next dev` that drives the screen and checks the DOM, console or network.
5. A captured request or payload from the report, saved and replayed through the code path on its own.
6. `git bisect run` with the loop, when the bug appeared between two known commits.

Then tighten it: make it fast (seconds), deterministic (pin time, seed randomness, stub the network at the boundary), and sharp (check the symptom, not "didn't crash"). A flaky bug needs a higher reproduction rate, not a clean repro: run the trigger 100 times and raise the rate until it is debuggable.

## Minimise

With the loop red, cut inputs, steps and data one at a time, re-running after each cut, until every remaining piece is needed. The minimal case becomes the regression test.

## Hypothesise, then probe

List three to five ranked causes, each with the prediction that would prove it ("if it is X, then changing Y makes it go away"). Show the list to the user before testing: they may know which one it is. Then test one at a time, changing one variable per probe.

Tag every temporary log with one prefix, such as `[DEBUG-fix]`, so a single search removes them all before landing. For a performance bug, measure a baseline first and compare against it; logs rarely show where time goes.

## Redact

Commands, logs and captured requests carry secrets. Write `<REDACTED>` in place of every token, password and private address in anything you show the user, comment on an issue, or commit.

## When no loop is possible

Stop and say so: what you tried, and what would make it reproducible (access to the environment, a redacted log or HAR file, the exact version). Do not move on to a fix without a loop that went red.

Back to step 3 of [`SKILL.md`](SKILL.md) once the loop is red.
