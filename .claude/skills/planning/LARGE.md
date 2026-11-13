# Large features: the map

A large feature is planned over several sessions, one question per session, on a **map**: a `plan` issue whose sub-issues are `question` issues. Everything in `SKILL.md` about research, the question shape, waiting for answers and recording decisions applies here unchanged.

## Chart the map

1. **Name the destination**: one round of questions (SKILL.md step 3) to pin down what the finished spec must make possible. The destination fixes the scope, so settle it first.
2. **Survey the open decisions breadth-first**: list every decision you can see, without going deep on any. For each, ask: can I phrase it as one precise question now? That is the test, not whether it can be answered now.
   - Yes: it becomes a `question` issue, even if it is blocked.
   - No (fog: you can tell something is coming, but not what yet): it goes in the map's "Not yet specified" list. One fuzzy patch may later become several questions, or none.
   - Beyond the destination: it goes in "Out of scope".
3. **Show the user the map and its questions** in the chat, and wait for approval.
4. **Publish**: the map (label `plan`), then each question as its sub-issue (label `question`), then the blocking links between questions, as [`GITHUB.md`](GITHUB.md) describes.
5. **Stop.** Charting is the whole session; answer nothing. End with the map's link and the questions ready now (nothing blocking them), by title.

The map body:

```markdown
## Destination
<one or two lines: what the finished spec must make possible>

## Decisions so far
<one line per closed question: [its title](link): the answer's gist>

## Not yet specified
<fog: decisions you can tell are coming but cannot phrase yet>

## Out of scope
<work ruled out of this feature, and why>
```

A question issue body:

```markdown
## Question
<the decision this resolves, in plain words>

## Context
<what research found that bears on it, with sources>
```

## Work one question

Given a map or a question (number or link):

1. Read the map. If given only a map, take the first open question that nothing open blocks and nobody is assigned to.
2. **Claim it** before any work: assign it to the user driving the session. The assignee is the claim; another session skips an assigned question.
3. Research it (SKILL.md step 1), then ask it in the question shape (SKILL.md step 3), with follow-up rounds as needed until it is settled. Wait for every answer.
4. Record any term or ADR (SKILL.md step 4).
5. Post the answer as a comment on the question, close it as completed, and add its line to the map's "Decisions so far".
6. Update the map: turn any fog the answer has made phraseable into new question issues (and remove it from "Not yet specified"); close as "Not planned" any question the answer moved past the destination, with a line in "Out of scope".
7. If no open question is left, write the spec and tickets (SKILL.md steps 5 and 6) from the map's decisions, then close the map. Otherwise end with the next ready question's title and link.

Never settle more than one question per session; the user may be working another one in parallel.

## Run every ready question

`/planning --all` (optionally with a map number): find every open, unassigned `question` whose blockers are all closed, show the list, then start one background agent per question, each in its own worktree. Prompt each with:

> Run the `planning` skill on question #<n> ("Work one question" in `LARGE.md`). You cannot talk to the user. Whenever the skill would ask the user anything, end your turn with the full question in the skill's question shape. The main session will reply with the user's answer; continue from there. Never answer your own question. When the question is closed, end with `QUESTION DONE` and the decision in one line.

When an agent's turn ends with a question, show it to the user exactly as written and send their reply back to that agent. You relay; you never answer for them, and you never reply "as recommended" unless the user said those words to that question. When an agent finishes, check for questions it unblocked and start them the same way.

End with each question's title, link and decision, and the questions still waiting and what they wait on.
