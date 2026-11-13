# Writing to GitHub

Issues, labels, sub-issues and blocking links for `/planning`. Use the GitHub MCP tools (`mcp__github__*`) where the session has them, otherwise `gh`.

## Labels

`/planning` uses five of the repo's eleven labels: `plan` (a map), `question` (one open decision on a map), `spec` (an approved spec), `agent` and `human` (a ticket's builder). Every ticket carries exactly one of `agent` or `human`. If a label is missing from the repo, stop and tell the user rather than creating it or publishing unlabelled issues.

## Order of creation

Issues need ids before they can point at each other, so publish in passes:

1. The parent (the spec or the map).
2. Each child, blocker-first, created as a sub-issue of the parent: `issue_write` with `parent_issue_number`, or `gh issue create` followed by `gh api repos/{owner}/{repo}/issues/<parent>/sub_issues -f sub_issue_id=<child id>`. A sub-issue link takes the child's **id**, not its number.
3. The blocking links, once every child exists.

## Blocking links

Use GitHub's native issue dependencies, so the order shows in GitHub's own UI:

```bash
gh api repos/{owner}/{repo}/issues/<blocked number>/dependencies/blocked_by -X POST -F issue_id=<blocker id>
```

`GET` on the same path lists an issue's blockers. If no tool in the session reaches this endpoint, add a `Blocked by #<n>` line to the blocked issue's body instead, and tell the user which links still need adding by hand.

## Refer by title

In everything the user reads, name an issue by its title wrapping its link, never by a bare `#42`.
