---
name: ask
description: Answer a question about the Cloudgate codebase briefly and precisely, from the code itself — how something works, whether it was built, or whether it should be built and its pros and cons. Read-only. Picks the clearest form for the answer — a sentence, a table, or a self-contained HTML page laid out for that answer's shape (steps, layers, states, a comparison) when it has a flow or many parts. Detail only when asked.
disable-model-invocation: true
---

`/ask` answers a question about Cloudgate from the code, not from memory. It changes nothing: no file in the repo, no commit, no issue. The one thing it may write is an HTML page outside the repo, when a page explains better than text.

## 1. Find the answer in the repo

Every claim comes from something you read in this session: a file, an ADR in `docs/adr/`, a `CONTEXT.md` entry, a test, an issue, `git log`. Read the code path itself, not just names that sound right; a function called `refuseX` might not be called where you think. Use subagents to search wide areas in parallel when the question spans several modules.

Each kind of question has its own method:

- **"How does X work?"** Trace the real path from where it starts (a route, a button, a scheduled job) to where it ends (a row written, a container started, a message shown), step by step. Note the decision behind each surprising step: the ADR, or the docblock that explains it.
- **"Did we build X?"** Search by meaning, not only by the words in the question: the glossary term, the route, the screen, the test name, closed issues, `git log --grep`. Answer **yes**, **no** or **partly**, and for partly say exactly what exists and what is missing. A "no" needs the places you looked.
- **"Should we build X?" / "What are the pros and cons?"** First what exists today, then each real option with its pros and cons, then your recommendation and why. Check the options against the ADRs and the glossary: an option that reverses a decision says which one.

Done when every sentence you are about to write is either backed by something you read, or marked as your opinion. If the code cannot settle it (it depends on production data, or on an intent nobody wrote down), say so rather than guess.

## 2. Answer short

The reader wants the answer, not the research. Give the least that answers the question exactly, and stop. More detail comes only when they ask for it ("more", "why", "show me the code").

- **First line is the answer.** One or two sentences; someone who reads only that line knows it. No preamble, no restating the question, no "I looked at…".
- **Then only what makes it true or usable:** at most three short bullets or lines, each with its evidence (`path/to/file.ts:42`, `ADR-0052`, `CONTEXT.md` **Maintenance**). If a line would not change what the reader does or believes, cut it.
- **A "no" names where you looked**, in one line, not a paragraph.
- **Leave out** background, history, how you searched, caveats that do not change the answer, and anything the question did not ask. One line at the end may say what you left out ("Ask for the retry path if you need it.").
- **Plain words:** short sentences, the glossary's terms and never its _Avoid_ ones. Explain a Cloudgate term (Server, Service, Deployment, Frozen Organization) in a few words only when the answer would be unclear without it.
- **Opinion is labelled** ("**My view:**", "**Recommend:**") and kept to one or two sentences.

As a budget: a fact or yes/no fits in about 60 words; a comparison is one sentence plus a table of only the rows that matter; a flow is the two-sentence answer in the chat and the rest on the page. If you are over, cut detail, not the answer.

When they ask for more, answer that follow-up the same way: the new detail they asked for, not the whole answer again.

## 3. Pick the form that explains best

Choose by the shape of the answer, not by its importance:

| The answer is | Form |
|---|---|
| A yes/no, a single fact, or a few sentences | Text only |
| A comparison, pros and cons, options, or "which of these exist" | A table, with a short sentence above it |
| A flow (request → service → queue → container), layers, a state machine, or more than about five moving parts | An HTML page, plus the one-or-two-sentence answer in the chat |

For a page, read [`PAGE.md`](PAGE.md) and follow it. The page is designed for this answer's shape, not filled into a fixed template. The chat still carries the answer; the page carries the picture.

## 4. Point to what comes next

`/ask` answers; it does not act. When the answer leads somewhere, end with one line naming the step:

- the answer is "we should build this", or it surfaced a feature worth having: `/plan <the idea>`;
- the answer found something broken: `/fix <what is wrong>`;
- the answer found a security problem: private reporting, as `SECURITY.md` says, and nothing more in the chat than that it exists.

If the person then asks you to do it, that is a new request: run the named skill rather than doing the work inside `/ask`.
