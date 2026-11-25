# A repository holding both cloudgate.yaml and cloudgate.yml uses cloudgate.yaml and says so

Status: accepted. Replaces the refusal of a branch holding both names from #1344; [ADR-0029](0029-the-project-config-is-the-one-record-of-what-a-project-runs-and-the-console-edits-it.md) is unchanged.

A move of the Project config into a repository with no path looks for `cloudgate.yaml`, then `cloudgate.yml`, and stores the name it finds as the Project's one path. Until now a Config branch holding both names refused the move (`CONFIG_PATH_AMBIGUOUS`), so an operator with a stray copy had to delete one file before Cloudgate would read either. `.yaml` and `.yml` are one format, and `.yaml` is the name Cloudgate writes everywhere else.

## Decision

- **Both names on a branch: `cloudgate.yaml` is used.** The move preview says that `cloudgate.yml` is also on that branch and is not read, so nobody edits the file Cloudgate ignores.
- **Still found once, at the move, and stored.** No read after the move falls back from one name to the other, so a `.yml` committed later never becomes the config. This is what keeps the choice inside ADR-0029: there is still one record and one path.
- **Different names on different branches are still refused.** A Project stores one path, so `main` holding only `cloudgate.yaml` and `staging` holding only `cloudgate.yml` cannot both be read; `CONFIG_PATH_AMBIGUOUS` stays for that case.
- **A named path always wins.** This applies only to a move with no path.

## Consequences

The same rule, `.yaml` first, `.yml` when it is the only one, `.yaml` with a note when both are there, is used by the CLI for a Project folder's working copy, so the file reads the same in a repository and in a folder.
