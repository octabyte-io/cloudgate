# Changelog

The Cloudgate CLI's own changes, published to npm as `@octabyte-io/cloudgate`. A server change a CLI feature needs gets its own entry in the root `CHANGELOG.md` as well.

## Unreleased

## 0.0.2-beta.2

### `cloudgate template pack`: the release's catalogue.zip, built by Cloudgate's own builder

`cloudgate template pack <folder> <out> [--revision <sha>]` builds the `catalogue.zip` a `cg-templates` release publishes (ADR-0072) from a template folder or a folder of template folders, so CI publishes with the same builder Cloudgate's check reads.

- **Checked before it is written.** It runs `template check`'s check on the zip first. If the zip is refused as a whole, or any template would be hidden (each printed as `✗ <id>: <reason>`), it writes nothing and exits 1, saying `<out>` was not written. A folder holding no template is refused the same way, since an empty release would take every template away from every install.
- **What it writes.** One `catalogue.json` index and `templates/<id>/…` per template, leaving the website's `index.md` and `screenshots/` out. It prints `✓ <id>` for each template packed, then `✓ Packed <n> templates into <out>`.
- **One revision.** `--revision <sha>` is the revision every template is published at, usually the release's commit; without it, `unpublished`.

### `cloudgate template check`: a template checked as Cloudgate will read it

`cloudgate template check <path>` runs Cloudgate's own Template check on a `catalogue.zip`, one template folder, or a folder of template folders, and needs no Instance and no key. It prints `✓ <id>` for each template Cloudgate would offer and `✗ <id>: <reason>` for each it would hide, and exits 1 if any is hidden or the catalogue is refused as a whole. The check is the backend's own, bundled into the CLI, so it is the Cloudgate version the CLI was built with that judges; `cg-templates` CI runs it on every pull request.

- **A folder is checked as the catalogue.zip it would be packed into** (ADR-0072). The website's `index.md` and `screenshots/` beside a template's files are skipped; any other file a template does not have (a `notes.txt`, a second compose file, a script under `files/`, a config file its `template.yaml` does not list) refuses the whole catalogue, naming the file, and exits 1.
- **A `catalogue.json`**, the format before ADR-0072, is refused with a message naming `catalogue.zip`.

## 0.0.2-beta.1

### `cloudgate logout`: the key deleted on the Instance, and the login forgotten here

`cloudgate logout [--instance <url> | --all]` deletes this computer's key on the Instance, then forgets the login. Without a flag it logs out of the Instance the folder would use (the Folder link's, else the current one); `--instance` names another, and `--all` logs out of every saved Instance.

- **This computer is always left clean.** When the Instance can't be reached (or refuses the delete), the login is still forgotten, and the run says `Error: its key was not deleted on <instance>: …` with a hint to delete it in the console, and exits 1. With `--all` the other Instances are still logged out of.
- **A key that had already ended** (it ran out, or was deleted in the console) is a clean logout: forgotten, exit 0.
- **Older Instances too.** `logout` is the one command that works against an Instance older than this CLI supports.
- **Not with `CLOUDGATE_KEY`.** That key is never saved, so there is nothing to log out of; `logout` refuses with exit 2 rather than delete a key a CI job may share. Delete it in the console, or unset the variable to log out of a saved login.
- **Not logged in** to the Instance is exit 0, "nothing to do".
- Needs an Instance that lets a key delete itself (this release's server change); an older one refuses the delete, which is reported as above.

### `cloudgate logs`: a Service's Runtime log, or a Deployment log

`cloudgate logs` prints the last 100 lines of the Service's Runtime log, what it writes while it runs; `-n/--lines <1–10000>` changes how many, and `-f/--follow` keeps printing new lines until Ctrl-C (exit 130). The Service is found the shared way: flags, `CLOUDGATE_*`, then the nearest link. Text only, no `--json`: log lines go to stdout and nothing else does, so it pipes into `grep`.

- **On a Server and in a Cloud account alike.** A Service on a Server (or on the Instance's own host) is read from its Swarm service's log, `-n` lines in all even when it runs several tasks. One in a Cloud account is read from its log group, from the last few minutes, and from the last hour when those hold fewer than `-n` lines (an hour is as far back as the Instance reads one, so a Service quiet for longer prints fewer; on Google Cloud, what the Instance has read since it first watched the Service); with `-f` it is read again every two seconds, each line printed once.
- **`--deployment [id]`** prints a Deployment log instead: the tail of the one `[id]` names, or of the Service's latest Deployment, and exits 1 when there is none. With `-f` it follows that Deployment from its first line and ends by itself when the Instance says it finished, though the log stream never closes; it then says how it ended (`Deployment <id> done`, or `failed`) and exits 0, since it reports and does not judge. This is the command `deploy` names after a Ctrl-C.
- An Application's Runtime log only: another kind of Service is refused with exit 1, pointing at the console (a Compose stack's Deployment logs can still be read with `--deployment`).
- `-n` outside 1–10000, or an id without `--deployment`, is wrong use: exit 2.

### `cloudgate deploy` refuses or asks before an upload that would surprise someone

- **Applications only.** A Compose stack or a Database is refused, naming its kind (`Error: shop-stack is a Compose stack; cloudgate deploy uploads to Applications only`), exit 1.
- **A git or image source is switched only on a yes.** In a terminal it asks once, showing the current source: `api builds from github octabyte-io/shop. Deploying this folder switches it to uploaded files. Continue?`; no uploads nothing and exits 1. With no terminal it refuses with exit 2 naming `--switch-source`, which is the yes in CI. A Service already on uploaded files, or a new one with no source chosen yet, asks nothing.
- **A source the Project config's file owns is refused every time**, `--switch-source` or not: when the Project config is kept in a repository and names a repository as the Service's source, its next plan would put that back, so the entry must become `managed: console` first. A repository-kept config that could not be read is refused the same way (`… could not be read, so whether it names api's source is not known`), rather than uploaded past unseen. A config Cloudgate keeps is rewritten by the upload itself, as by any console change, so that Service is asked about like any git source.
- **It never uploads during a build.** When the Service has a Deployment pending or running, it prints `waiting for Deployment <id> to finish` and waits, then uploads; if a build starts between the check and the upload, the Instance's refusal is waited out the same way. It goes ahead without waiting, with a warning naming it, past a Deployment held by a plan or pending or running for more than 60 minutes. Ctrl-C while waiting exits 130 with nothing uploaded.
- **An unlinked folder in a terminal** is asked the `link` questions, linked (`✓ Linked ./ to …`), then deployed. With no terminal it still refuses naming the first missing flag, and it never creates a Service.

### `cloudgate deploy`: upload a folder, start a Deployment, follow it to its end

`cloudgate deploy [folder]` in a linked folder uploads the folder as it is on disk, starts a Deployment of its Service, prints the Deployment log as it is written, and exits 0 only if the Deployment ends done.

- **Where it goes.** The same target lookup as `link` (flags, `CLOUDGATE_*`, the nearest link); `--env <name|id>` deploys the same Config name in another Environment. No confirmation for any Environment, production included. One line says where, before anything is uploaded: `Deploying ./ to api in staging of Project shop on cloudgate.octabyte.app`.
- **Which folder.** The one holding the nearest `.cloudgate/`, never the subfolder you stand in; `[folder]` names another (and its own link, if it has one, picks the Service); with no link, the current folder. It lands at the build root.
- **Files left out.** `.git/` and `.cloudgate/` always; anything any `.gitignore` in the folder lists, whether or not it is a repository; anything a `.cloudgateignore` lists (same syntax, applied on top, so its `!` brings back what a `.gitignore` left out); and `.env` and `.env.*` except `.env.example`, with one line naming them and pointing at `cloudgate vars set` (`!.env` in a `.cloudgateignore` brings one back). Uncommitted and untracked files nothing ignores are included, `node_modules` has no rule of its own, and `cloudgate.yaml` is uploaded like any file and never read. Symlinks are left out with a warning naming them; file modes are not kept.
- **Size.** It always says how many files and how big; above 100 MB it warns, names the five biggest folders, and goes on.
- **Upload, then deploy.** Two calls. If the second fails, it says the files are uploaded and to run `cloudgate deploy` again, and exits 1.
- **The wait.** It follows the Deployment log on stdout and asks the Instance for the Deployment's status alongside, so it ends when the Deployment is done, failed or cancelled even though the log stream itself never closes. Done exits 0 (`✓ Deployment <id> done in 1m 42s`); failed or cancelled exits 1.
- **`--detach`** prints the Deployment, its status and its page in the console, and exits 0 once it is queued; `--detach --json` prints the same as one JSON object for scripts.
- **Ctrl-C** stops watching only (exit 130): the build goes on, and it prints `cloudgate logs --deployment <id> -f` and where in the console to cancel it.
- A role that may not deploy gets the Instance's 403 and the "ask an owner" hint, exit 1.

### `cloudgate status`: one Service's whole picture

`cloudgate status [--json]` prints the Service and its kind, its Environment, Project and Instance, its state (`running`, `stopped`, … as the console shows it), where its source comes from (uploaded files, a git repository, an image), its Domains and its latest Deployment (id, status, how long ago). It finds the Service the shared way: flags, `CLOUDGATE_*`, then the nearest link.

- **It reports and does not judge.** It exits 0 whenever it could read the facts, also for a stopped Service or one whose last Deployment failed. A refused read gets the usual error and hint, and exit 1.
- **`--json`** prints the same facts as one object (`instance`, `organization`, `project`, `environment`, `service`, `state`, `source`, `domains`, `latestDeployment`), with nothing else on stdout.
- **Every kind.** An Application or a Compose stack shows its Domains and its latest Deployment; a database shows the image it runs, and has no Domains or Deployment of its own to show. A plain git URL is never printed, since it may hold a credential.
- **No value is printed.** The reads keep only the fields `status` shows, so a Service's variables and a database's password never reach the terminal.

### `cloudgate vars`: a Service's own variables, set by name and never shown

`cloudgate vars list`, `vars set KEY=VALUE […]`, `vars set KEY` and `vars unset KEY […]` reach the Service's own runtime variables in the Environment `--env` or the Folder link picks. No value is ever printed, not even back in a refusal of a misused `KEY=VALUE`, which quotes it as `KEY=…`.

- **`vars list`** prints each name with `linked to <service>.<output>` for a name wired to an Output, or `set`. `--json` prints entries with `name` and `linkedTo` (`"db.url"` or `null`), and nothing else on stdout.
- **`vars set KEY=VALUE`** splits each pair at its first `=`, so a value may hold `=`. It changes only the keys it names, so two people setting different keys never overwrite each other.
- **`vars set KEY`** asks for the value with hidden typing in a terminal, and otherwise reads it from stdin (`printf %s "$STRIPE_KEY" | cloudgate vars set STRIPE_KEY`), dropping one last line break. An empty stdin, or a terminal with `--no-input` or `CI`, is refused with exit 2, so a secret never needs to be in your shell history.
- **A name wired to an Output is refused** with exit 1, naming its Output (`Error: DATABASE_URL is linked to db.url …`). Change the link in the Project config.
- **Nothing redeploys.** Each change ends with "Run cloudgate deploy to pick it up."
- **Applications only.** Any other kind of Service is refused, naming its kind. The Environment's and Project's shared variables, build arguments and build secrets stay in the console. There is no `vars get` or `pull`.

### `cloudgate login`, saved Instances, `instance list` and `instance use`

`cloudgate login [--instance <url>]` logs in through the browser: it prints `Open <instance>/device and enter the code  WDJB-MJHT`, you check the code in the console on any device (so it works over SSH) and approve, and this computer gets a Personal key that ends 90 days after login. It needs a server with the device login (see the root `CHANGELOG.md`).

- **Which Instance.** `--instance`, then `CLOUDGATE_INSTANCE`, then `https://cloudgate.octabyte.app`. The Instance is checked before anything is asked or saved, as every command does. A login made becomes the current Instance.
- **Where the key goes.** The system keychain (`@napi-rs/keyring`, the package's one dependency, optional and native). Where there is none (a server over SSH, a container), a `credentials.json` at mode 0600 in the settings folder, with a one-line notice saying so. The rest (which Instances, the current one, each login's email and key end) is in `instances.json` beside it, never a key.
- **Logging in again** on the same Instance replaces that login, and the key it replaces is deleted on the Instance once the new one is minted.
- **A denied or expired code** exits 3 and saves nothing. The CLI never starts a login by itself.
- **Several Instances.** One login per Instance, saved by address. `cloudgate instance list [--json]` shows them and marks the current one with `*`; it asks no Instance. `cloudgate instance use <url>` makes one current, and refuses with exit 3, naming the login to run, an Instance you are not logged in to.
- **Which Instance a command uses** is now `--instance`, `CLOUDGATE_INSTANCE`, the nearest Folder link, the current Instance, then the hosted one. With `CLOUDGATE_KEY` set the current Instance and saved logins are ignored, and the key is never saved.
- **`whoami`** reads a saved login; `--json` reports `keyFrom: "login"` for it (`"env"` for `CLOUDGATE_KEY`).
- **An ended login.** A saved key the Instance no longer accepts (it ran out, or was deleted in the console) is forgotten, and the command exits 3 with `Error: your login to <instance> has ended` and `Run: cloudgate login --instance <instance>`.

### `cloudgate link` and `cloudgate unlink`: a folder tied to one Service

`cloudgate link` saves a Folder link in `.cloudgate/link.json` and adds `.cloudgate/` to `.gitignore`, so the commands to come (`deploy`, `status`, `logs`, `vars`) need no flags in that folder. `cloudgate unlink` deletes it.

- **What a link holds.** The Instance address, the Organization, Project and default Environment ids, and the Service's Config name rather than its id, so `--env production` reaches the same Service in another Environment. Display names are kept for printing only. The Project config is never changed.
- **In a terminal**, `link` asks for the Organization (skipped when you are in only one), the Project, the Environment and the Service, skipping any a flag answers. The Project whose config is kept in this folder's git repository, at or above the folder, is listed first. It asks before replacing a link.
- **With no terminal, or with `--yes`**, it asks nothing: a missing value is refused with exit 2, naming its flag and variable (`Error: no Project. Pass --project or set CLOUDGATE_PROJECT.`). Replacing an existing link needs `--yes`.
- **It never creates a Service.** An Environment with none, or a name that matches none, is refused and points to the console.
- **Picking the Service.** `--org`, `--project`, `--env` and `--service` (or `CLOUDGATE_ORG`, `_PROJECT`, `_ENV`, `_SERVICE`), then the nearest link at or above the current folder. A flag wins over its variable, and both win over the link. Each value is tried as an id, then as a name ignoring case; a Service by its Config name. A name two share is refused, naming their ids. In a monorepo each folder's own link wins. These flags are accepted only on `link` (and, as they land, `deploy`, `status`, `logs` and `vars`).
- **Which Instance, with a link.** The nearest link's Instance comes after `--instance` and `CLOUDGATE_INSTANCE`. A flag or variable naming a different Instance from the link is refused with exit 2, naming both. With no `CLOUDGATE_KEY`, a linked folder's commands refuse with exit 3 and name the `cloudgate login --instance …` to run.
- **`unlink` makes no request.** It removes the link this folder uses, its own or the nearest above, needs no key, and says nothing changed on the Instance. Unlinking an unlinked folder exits 0.
- **Another Organization than your default.** Every request about a target names its Organization (`x-organization-id`). A refusal because you are not a member of it says to check `--org`, `CLOUDGATE_ORG` or the link.

### The CLI checks an Instance before it sends your key

Before any request that carries a key, every command asks the address the public "this is a Cloudgate" question, without the key. Anything else at the address is refused with exit 1 (`Error: <url> is not a Cloudgate`), and it never sees the key.

- **Addresses.** An address without a scheme gets `https://`, and only the origin is kept, so `cloud.acme.dev` and a console URL pasted from the address bar both work. `Using instance` prints the address as kept.
- **Plain `http://` is refused** with exit 2 before anything is sent, except for `localhost` and `127.0.0.1`. `--allow-http` allows it for any host, on any command.
- **Version compatibility.** The CLI carries the lowest server version it works with (0.1.0, the first with the routes its commands call). An older Instance is refused with exit 1, naming its version and the one the CLI needs. A newer Instance is fine.
- **Redirects are not followed**, so a key is never carried to another address.

### `cloudgate whoami` with a Personal key from `CLOUDGATE_KEY`

`CLOUDGATE_KEY=… npx @octabyte-io/cloudgate whoami` prints the Instance, your email, the Organization in use and when your key ends. `--json` prints the same as one JSON object, adding `keyFrom` (`"env"` for `CLOUDGATE_KEY`).

- **Which Instance.** `--instance`, then `CLOUDGATE_INSTANCE`, then `https://cloudgate.octabyte.app`. Every run names it on stderr as `Using instance <url>`. The key is never saved.
- **Output you can pipe.** Data goes to stdout; everything else goes to stderr. Colour only in a terminal, and never with `NO_COLOR` or `--no-color`. No spinner outside a terminal or with `CI` set.
- **Errors.** An Instance's refusal prints `Error: <message>` on stderr, plus one hint line when the CLI knows a fix. With `--json`, stdout stays empty on error.
- **Exit codes.** 0 it worked, 1 it failed or was refused, 2 wrong use or input missing with no one to ask, 3 not logged in or the key was refused, 130 Ctrl-C.
- **Node 22 or newer.** An older Node is refused with a message naming both versions.

### A notice when a newer CLI is on npm

In a terminal, when npm has a newer `@octabyte-io/cloudgate` than the one running, the CLI says so on stderr after the command's own output, with the command to update:

```
A new version is out: 0.4.0 (you have 0.3.2).
Update: npm install -g @octabyte-io/cloudgate@latest
```

- **At most once a day.** npm is asked at most once every 24 hours and the notice is shown at most once every 24 hours. Both times are kept in `update-check.json` in the CLI's settings folder: `CLOUDGATE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cloudgate/` (default `~/.config/cloudgate/`) on Linux and macOS and `%APPDATA%\cloudgate\` on Windows.
- **Never in CI or a pipe.** Silent, and npm is not asked, when `CI` is set, when stdout or stderr is not a terminal, or when `CLOUDGATE_NO_UPDATE_NOTIFIER` is set.
- **npm's version only.** The comparison is with npm's `latest`, or with `next` as well when you already run a prerelease (the command then says `@next`); never with the Instance's version.
- **Never in the way.** npm is asked while the command runs; when the command finishes first the question is dropped and asked again next time. A failed check is silent and never changes the exit code. There is no self-update and no `upgrade` command.
