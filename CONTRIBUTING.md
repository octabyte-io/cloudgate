# Contributing to Cloudgate

Thanks for helping. Bug reports, feature ideas and pull requests are all welcome.

## Reporting a bug or suggesting a feature

Open an issue with the **Bug report** or **Feature request** form. For a bug, the most useful
things are the steps to reproduce it, what you expected, what happened instead, and your Cloudgate
version. Security problems go through `SECURITY.md`, never a public issue.

## Making a change

1. **Set up** the workspace as `README.md` describes ("Local setup").
2. **Read before you write.** `CONTEXT.md` is the glossary: use its terms in code, UI text and
   tests. `docs/adr/` records the architecture decisions; read the ones that touch your area.
   `CODING_STANDARDS.md` is what review checks.
3. **Test first, and run what you touched.** Add or change a test that fails without your change,
   then make it pass. Run the test files your change touches, not the whole suite —
   `docs/testing.md` has the commands and the reasons.
4. **Check before you push:** `pnpm -r run typecheck` and `pnpm -r run lint`.
5. **Open a pull request** that says what changed and why, and links the issue it closes. Keep one
   change per pull request. Commit messages state what is now true (`CODING_STANDARDS.md` §1.3).

## Labels

Issues carry a few labels, so it is clear what each one is and who can pick it up. GitHub's own
features do the rest: sub-issues link a spec to its tickets, "blocked by" records order, the
assignee is whoever is working on it, and closing as "Not planned" or "Duplicate" says why it
closed.

| Label | Meaning |
| --- | --- |
| `bug` | Something is broken. The bug form sets it. |
| `enhancement` | A feature idea, before it is planned. The feature form sets it. |
| `question` | One open decision inside a large feature's plan. |
| `plan` | The plan of a large feature, whose questions are its sub-issues. |
| `spec` | An approved spec; its tickets are its sub-issues. |
| `agent` | A ticket ready to build, small and fully specified. |
| `human` | A ticket only a maintainer can do (accounts, secrets, a check on a real server). |
| `needs-info` | Waiting on whoever reported it. |
| `documentation` | Docs only. |
| `good first issue` | A good place to start. |
| `help wanted` | Contributions especially welcome. |

## Contribution terms

Cloudgate is licensed under the Elastic License 2.0, and OctaByte also runs it as a hosted service.
For your contribution to be usable in both, we ask you to agree to these terms once. On your first
pull request a bot will ask you to reply with one sentence; after that, you are never asked again.

By submitting a contribution to Cloudgate (code, documentation or anything else, through a pull
request or otherwise), you agree that:

1. **It is yours to give.** You wrote it, or you otherwise have the right to submit it under these
   terms. If your employer has rights to it, they have allowed you to submit it.
2. **You keep the copyright.** Nothing here transfers ownership of your contribution.
3. **OctaByte may use it in any way.** You grant OctaByte a permanent, worldwide, non-exclusive,
   royalty-free and irrevocable license to use, copy, modify, distribute, sublicense and relicense
   your contribution, under the Elastic License 2.0 or any other terms, including as part of
   OctaByte's hosted service.
4. **Patents.** You grant OctaByte, and everyone who receives Cloudgate, a license under any patent
   you can license that your contribution would otherwise infringe, on the same terms.
5. **No warranty.** Your contribution is provided as is, and you are not expected to support it.

To agree, reply to the bot on your pull request with exactly:

> I have read the contribution terms in CONTRIBUTING.md and I agree to them

## License

Cloudgate, including your contribution once merged, is distributed under the
[Elastic License 2.0](LICENSE).
