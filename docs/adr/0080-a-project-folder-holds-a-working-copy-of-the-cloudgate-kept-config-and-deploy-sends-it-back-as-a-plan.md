# A Project folder holds a working copy of the Cloudgate-kept config, and deploy sends it back as a plan

Status: accepted.

A **Folder link** tied one folder to one Service. A monorepo root wants to be linked as the whole Project instead: it holds `cloudgate.yaml` and one `cloudgate deploy` there builds every app beneath it. ADR-0029 allows exactly one Project config, kept in Cloudgate or in a repository, and rules out any copy Cloudgate works from.

**The config stays kept in Cloudgate; the file in a Project folder is a working copy, never a third place.** `cloudgate link` downloads it and remembers which version it downloaded. `cloudgate deploy` at the root sends the whole file back as an ordinary plan (the whole-YAML edit), and is refused when Cloudgate's config changed since that download, telling the person to pull first. Cloudgate never reads the folder's copy except when it is sent, and never falls back to it, so ADR-0029 holds unchanged and the console keeps editing the config.

**Each app gets the whole folder.** A root deploy uploads the whole Project folder to every app it builds, and each app builds from its own subfolder, the way a repository source builds from its `path`. Apps in a monorepo import shared code beside them; uploading only their own subfolder would break those builds. The cost, the same files sent once per app, is left to the upload of only changed files.

**A root deploy applies its own plan.** In a terminal it shows the plan and asks before applying; a destroy is still confirmed by typing the Service's name. Without a terminal it refuses unless given `--yes`, and `--yes` alone never destroys a Service.

**Which apps, and from which subfolder, is said in the config.** An app built from the Project folder names its subfolder as its source (`source: { folder: apps/web }`), the same in every Environment and so the config's (ADR-0029). A root deploy builds only those; an app built from a repository or an image, and every database, is left alone and listed as not from this folder. Nothing is guessed from a name.

**Only a Cloudgate-kept config can have a Project folder.** Choosing an existing Project whose config is kept in a repository is refused, naming the repository; moving it into Cloudgate stays the console's move, with its preview, because it changes how every member edits it.

**The working copy is the person's, never committed.** `link` adds `cloudgate.yaml` to `.gitignore` beside `.cloudgate/`, so a copy in git can never pass for a repository-kept config or go stale there; each person gets a fresh one from `link`.

## Considered options

- **The folder's file as a third place where the config is kept**, with the console refusing config edits as it does for a repository-kept config. Rejected: Cloudgate cannot read a folder on demand, so it would learn of changes only when someone deploys, and every other member of the Project would lose the console as a way to edit it.
- **Upload only each app's own subfolder.** Rejected for shared code, above.
- **Send the plan and stop**, leaving Apply to the console. Rejected: two places and two commands for one change, with nothing gained for safety since destroys are confirmed by name either way.
