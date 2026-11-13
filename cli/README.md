# Cloudgate CLI

Deploy a folder to Cloudgate from your terminal. Published to npm as `@octabyte-io/cloudgate`; the command is `cloudgate`. Needs Node 22 or newer.

```sh
npm install -g @octabyte-io/cloudgate
cloudgate login --instance cloud.acme.dev     # approve the code in the console
cloudgate whoami
CLOUDGATE_KEY=<a Personal key made in the console> cloudgate whoami   # in CI
```

`cloudgate --help` lists the commands; `cloudgate <command> --help` explains one.

## Working on it

```sh
pnpm --filter @octabyte-io/cloudgate test        # unit lane: pure rules, no server
pnpm --filter @octabyte-io/cloudgate build       # bundles dist/cloudgate.mjs
node cli/bin/cloudgate.js --help                 # run the build
```

The one e2e suite runs the built command against the backend harness:

```sh
cd backend && npx jest --config ./test/jest-e2e.json --runTestsByPath test/cli/cli.e2e-spec.ts
```

Every CLI ticket adds its walk to that suite (`backend/test/cli/cli.e2e-spec.ts`, helpers in `cli-harness.ts`) instead of adding a suite. The accepted help text locks command names, flags, variables and exit codes.

## Layout

| Path | What it is |
|---|---|
| `bin/cloudgate.js` | The launcher npm links. Refuses Node < 22, then loads the bundle. A per-platform file arriving through `optionalDependencies` (ADR 0046) is looked for here first, later. |
| `build.mjs` | esbuild: one ESM file, `api-schemas` and zod bundled, version stamped from `package.json`. `@napi-rs/keyring` stays external: the package's one runtime dependency, optional and native. The backend's Template check is bundled from its source under the alias `cloudgate-template-check`, stamped with the backend's version, and its setup values and compose file preparation (`templates/setup/cli-bundle.ts`, for `template try`) under `cloudgate-template-setup`: the two exceptions ADR-0046 allows. |
| `src/template-check.d.ts` | The hand-written declaration of that alias, as far as `template check`, `template pack` and `template try` use it, and why it is not shared through `api-schemas`. |
| `src/template-setup.d.ts` | The same for `cloudgate-template-setup`, the backend's setup values and compose file preparation (`backend/src/templates/setup/cli-bundle.ts`), which `template try` prepares a Template with. |
| `src/try-stack.ts` | `prepareStack`: a Template's compose part as an Instance's stack folder holds it (the compose file, its `.env`, `files/`), made by the backend's own code, each Domain on a free `127.0.0.1` port; and the samples an `ask` input gets (`randexp`, bundled, for a `pattern`). |
| `src/docker.ts` | `DockerRun`, the one way the CLI reaches Docker (`Invocation.docker`, the `docker` on `PATH` unless given), and `isDockerMissing`. |
| `src/template-folders.ts` | `templateFoldersAt`: a template folder, or a folder of them, read as `cg-templates` holds them, so `template check` checks a folder exactly as `template pack` packs it. |
| `src/run.ts` | One whole run, with no `process`: argv, env and streams in, exit code out. Flag parsing and dispatch. `main.ts` wires it to the process. |
| `src/commands/` | One file per command; `commands/index.ts` is the registry the overview help is built from. |
| `src/terminal.ts` | The output rule: colour, spinner, may we ask; and `requireInputs`, the missing-input refusal. |
| `src/output.ts` | The only way a command writes: `data`/`json` to stdout, `note` to stderr, `withSpinner`. |
| `src/errors.ts` | `CliError`, `refusalFromResponse` (an Instance's refusal → message, hint, exit code), `reportError`. |
| `src/exit-codes.ts` | The fixed exit codes. |
| `src/instance.ts` | `chooseInstance`, `instanceAddress` (the address rules) and `instanceEndpoints`. |
| `src/instance-check.ts` | `checkInstance`: the public "this is a Cloudgate" answer and the version floor, before any key is sent. |
| `src/server-version.ts` | `MINIMUM_SERVER_VERSION` and the semver compare. |
| `src/api-client.ts` | The hand-written client on `api-schemas`. |
| `src/http.ts` | What every request shares: `reach` (no redirect followed; "could not reach" when it never lands), `USER_AGENT`, `parseJson`, `notUnderstood`. |
| `src/stopping.ts` | Waiting and Ctrl-C: `POLL_MILLISECONDS`, `abortOf`, `withInterrupts` (a signal Ctrl-C aborts while some work runs). |
| `src/credentials.ts` | Where the key comes from: `credentialFor` (`CLOUDGATE_KEY`, else the saved login for the chosen Instance) and `endedLogin`, the refusal for a saved key an Instance no longer accepts. |
| `src/logins.ts` | `loginStore`: the saved logins and the current Instance (`instances.json`), their keys in the OS keychain (`osKeychain`) or a 0600 `credentials.json`. |
| `src/folder-link.ts` | The Folder link: `findNearestLink`, `writeLink` (with the `.gitignore` line), `removeLink`. |
| `src/target.ts` | The shared target lookup: `targetInputs` (flag → variable → link), `resolveTarget` (id, then name; asks or refuses), `TARGET_OPTIONS`. |
| `src/target-session.ts` | `connectToInstance` (the first steps every command takes), `lookUpTarget` (those plus the target), `instanceCatalog`, `chooserFor`, `describeTarget`. |
| `src/service-status.ts` | `readServiceStatus`: a Service's state, source, Domains and latest Deployment from its own kind's routes (`/applications`, `/compose`, `/postgres`, …), for `status`; `kindRefusal`, the one "Applications only" refusal `deploy`, `vars` and `logs` share. |
| `src/prompt.ts` | The terminal's questions (`Prompter`): a numbered pick, a yes/no and a hidden answer (`secret`, for `vars set KEY`), on `node:readline`. |
| `src/upload-files.ts` | Which files `deploy` uploads (`selectUploadFiles`: `.git`, `.cloudgate`, ignore files, `.env`, symlinks) and what it says about their size (`summarizeUpload`). |
| `src/ignore-rules.ts` | The `.gitignore` pattern syntax, read for `.gitignore` and `.cloudgateignore` alike. |
| `src/zip.ts` | `packUpload`: the zip the upload route reads (deflate, UTF-8 names, no Zip64). |
| `src/deploy-guards.ts` | What `deploy` checks before it uploads, as rules with no network: `sourceVerdict` (refuse, ask or go for a source switch), `runningBuildVerdict` (wait for a build in progress, or go ahead past a held or stuck one). |
| `src/deployment-watch.ts` | `watchDeployment`: follows a Deployment to its end, which `GET /deployments/:id` decides, never the stream. |
| `src/runtime-log.ts` | A Service's Runtime log (`logs`): `readServerRuntimeLog` over `/docker-container-logs` (`follow=false` without `-f`, ends on close code 4014) and `readCloudRuntimeLog` polling `GET /applications/:id/runtime-log`. |
| `src/deployment-log-stream.ts` | `deploymentLogFollower` over `/listen-deployment`, and `SocketOpener` (Node's `WebSocket` with upgrade headers). |
| `src/git-origin.ts` | The folder's `origin` repository and path, for listing its Project first in `link`. |
| `src/config-dir.ts` | `configDir`: the settings folder (`CLOUDGATE_CONFIG_DIR`, XDG, `%APPDATA%`). |
| `src/update-notice.ts` | The update notice: when it may show, the npm check, its state file. `run` starts it and prints it last. |
| `scripts/release.ts` | The release workflow's two decisions: tag against `package.json` version (and `next` or `latest`), and the version's CHANGELOG section. |

## Releasing

`.github/workflows/release-cli.yml` publishes on a `cli-v<version>` tag; there is no other way a version reaches npm.

1. On `main`, set `version` in `cli/package.json` and move the CHANGELOG's Unreleased entries under a `## <version>` heading.
2. `git tag cli-v<version> && git push origin cli-v<version>`.
3. Approve the run in the GitHub environment `npm`.

The workflow fails before publishing when the tag and `package.json` disagree or the CHANGELOG has no section for the version, and runs this package's type-check, lint and tests (not the server's e2e). It publishes by npm trusted publishing, no token, and without a provenance statement, which npm accepts only from a public repository: a version with a prerelease part (`0.2.0-beta.1`) to the `next` dist-tag, any other to `latest`. Then, and only then, it makes a GitHub Release on the tag from that CHANGELOG section, marked pre-release for `next`. Check both decisions locally with `node cli/scripts/release.ts check cli-v<version>` and `node cli/scripts/release.ts notes <version>`.

The trusted publisher on npm (package Settings) names GitHub Actions, `octabyte-io/cloudgate`, the workflow file `release-cli.yml` and the environment `npm`; renaming the workflow file breaks publishing until that is changed too.

## Decisions later commands follow

- **The Instance address is the console's**, the address a person types and pastes. REST is reached at `<instance>/backend/*`, the console's own proxy to the API. WebSockets, which the console does not proxy, go to the API's own origin, which the public answer advertises as `apiUrl` (`CLOUDGATE_API_URL` on the server; null when unset): use `checkInstance(...).endpoints.websocket`. Both mappings live only in `instanceEndpoints` (`src/instance.ts`). The e2e harness puts a small stand-in for the console's `/backend` rewrite in front of the backend, so the CLI needs no test-only flag.
- **Every command that talks to an Instance takes the same steps first**, through `connectToInstance` (`src/target-session.ts`): `chooseInstance` → `instanceAddress(url, { allowHttp })` → print `Using instance <url>` → `credentialFor` → `checkInstance({ address, fetch })`, all before its first request carrying a key (and, from `login` on, before saving one). `instanceAddress` adds `https://` to a bare address, keeps only the origin, and refuses plain `http://` except for `localhost`/`127.0.0.1` or with `--allow-http`, with **exit 2** (the address given is wrong, and nothing was asked yet). `checkInstance` asks `GET /backend/settings/about` with no key, and refuses with **exit 1** an address that does not answer it (`<url> is not a Cloudgate`) or an Instance older than `MINIMUM_SERVER_VERSION` (naming both versions). Only `logout` passes `allowOlder: true`. Compare Instance addresses only after `instanceAddress`, so a Folder link and a flag agree on spelling.
- **`--allow-http` is accepted by every command** (a global flag in `run.ts`), because every command applies the address rules. Only `login`'s help lists it, as the accepted help text does, and the refusal's hint names it. It is not `login`-only because a CI job never logs in: it runs `deploy` or `logs` with `CLOUDGATE_KEY` against an Instance on a LAN address served over plain `http://`, and that command is the one that has to be told the address is meant.
- **Redirects are never followed**, by the check or by `ApiClient` (`redirect: 'error'`): a followed redirect would carry `x-api-key` to wherever it pointed.
- **Raise `MINIMUM_SERVER_VERSION`** in the CLI release that first needs a server change, to the server version that ships it.
- **Data on stdout, everything else on stderr**, always through `Output`. A `--json` command prints its one object only after every request has succeeded, so stdout is empty on any error.
- **Every failure is a `CliError`**, reported by `reportError` as `Error: <message>`, then at most one hint line. The CLI's own refusals use the same `Error:` prefix as an Instance's, so there is one shape to grep for.
- **Branch on `code`, never on `message`.** An Instance's refusal keeps its `code` on the `CliError` (`error.code`), as `deploy` reads `DEPLOYMENT_IN_PROGRESS`. 401 exits 3; every other refusal exits 1. A 403 gets "Ask an owner of <Organization> for access." only when it carries no code (the role's refusal) or one of the `*_ACCESS_NOT_GRANTED` codes. This is the console's rule (`ApiError.isUnnamedRefusal`): a banned account or a removed member is also a 403, and no owner can fix those. Pass `organizationName` in the client's refusal context when the command knows it.
- **Never ask without a terminal.** Use `terminalMode().canAsk`. When a command cannot ask, `requireInputs` refuses with exit 2 and names the first missing flag and its variable.
- **A key from `CLOUDGATE_KEY` is never written anywhere**, and `whoami --json` reports it as `keyFrom: "env"`; a saved login's as `"login"`.
- **Saved logins live only in the `LoginStore`** (`src/logins.ts`, `CommandContext.logins`), one per Instance address as `instanceAddress` spells it. Get a key through `credentialFor`. A client from `connectToInstance` built on a saved login already forgets it on a 401 and refuses with `endedLogin` (exit 3), so no command handles an ended login itself. `logout` is the one command that does not use `connectToInstance`: it sends the saved key to `DELETE /users/me/api-keys/<its keyId>` (the one key route a key may use, on itself), then calls `logins.forget(instance)` whatever happened there.
- **`logout` always leaves this computer clean.** It checks the Instance with `allowOlder: true` (an old Instance can still end a login), deletes the key there, and forgets the login even when the Instance cannot be reached, is not a Cloudgate or refuses the delete; it then prints `Error: its key was not deleted on <instance>: …` with a hint to delete it in the console, and exits 1. A 401 means the key had already ended, which is a clean logout (exit 0). `--instance` is taken over a Folder link instead of being refused for disagreeing with it; `--all` is every saved login, carrying on past one that fails. Not logged in is exit 0, "nothing to do".
- **`logout` refuses `CLOUDGATE_KEY` (exit 2).** That key is never saved, so there is no login to forget, and deleting it on the Instance would break whatever else holds it (a CI secret): it is revoked in the console. With the variable set the run ignores saved logins, so logging out of one is refused rather than guessed at; unset it first.
- **Tests never touch a real keychain.** The unit lane passes its own `Keychain`; the e2e harness sets `CLOUDGATE_NO_KEYCHAIN=1`. That variable is an internal test and ops switch (keys go to the 0600 `credentials.json`, as on a machine with no keychain, for a box where a keychain prompt is unwanted), not a documented option: it is deliberately not in `--help` or the CHANGELOG. `@napi-rs/keyring` has no install script, so `pnpm-workspace.yaml` needs no entry for it.
- **Login is the device flow**: `POST /backend/auth/device/code`, then `POST /backend/auth/device/token` every `interval` seconds, approved at the console's `/device`. The CLI prints `<instance>/device` itself, so the link is the address it checked. Login takes `--instance`, then `CLOUDGATE_INSTANCE`, then the hosted Instance, never a link's or the current one.
- **The update notice never reaches npm in a test.** It is off without an `updateState` store in the `Invocation` (the unit lane passes none unless it tests the notice), and the e2e harness's `runCli` runs with pipes and `CLOUDGATE_NO_UPDATE_NOTIFIER=1`.
- **A command that acts on a Service starts with `lookUpTarget(context, { choose })`** (`src/target-session.ts`): the nearest Folder link, `connectToInstance` with it, then the target. It answers the Instance, the key, the link, the `Target` (`service.id`, `service.configName`, `service.kind`, …) and a client already sending `x-organization-id`. Pass `choose: chooserFor(prompter)` only when `out.mode.canAsk`; without it a missing level exits 2 naming its flag. Add `TARGET_OPTIONS` to the command's `options`, and print where it goes with `describeTarget`.
- **The link fills a level only while the levels above it are the link's too**; its Service Config name always applies. So `--env production` re-finds the linked Config name there (refusing, naming both, when it is missing), and `--project other` drops the link's Environment rather than looking an id up in the wrong Project.
- **`link` reads no existing link**, for its answers or its Instance: it is the command that replaces one.
- **No value of a variable ever comes back** (ADR 0019). `vars` reads names from `GET /applications/:id/variables` and changes keys with `PATCH` on it, never `GET /applications/:id`, whose row carries the values. A secret goes in by a hidden question in a terminal or by `context.stdin` otherwise; read stdin only when `stdin.isTTY` is false, and refuse (exit 2) a terminal that may not be asked rather than wait on it.
- **`x-organization-id`** is sent by every client `inOrganization(id)` gives, which `lookUpTarget` and the catalog use. The server refuses a non-member with 403 `NOT_ORGANIZATION_MEMBER` (`api-schemas`); `refusalFromResponse` hints at `--org`, `CLOUDGATE_ORG` and the link for it.
- **Following a Deployment** is `watchDeployment` (`src/deployment-watch.ts`) with `deploymentLogFollower` (`src/deployment-log-stream.ts`) on `checkInstance(...).endpoints.websocket`, the client's `socketHeaders()` and `context.openSocket`. It ends when `GET /deployments/:id` (`deploymentSchema` in `api-schemas`) says done, `error` (printed "failed") or cancelled, never because the stream did: `/listen-deployment` is `tail -f` and does not close. `logs --deployment -f` reuses both.
- **Ctrl-C** goes to a command only when it listens (`context.interrupts.listen`), as `deploy` does while it watches a Deployment that goes on without it; it then prints how to pick the watch up again and returns 130. With no listener, or on a second Ctrl-C, `main.ts` exits 130 at once.
- **Tests never wait on a clock**: `context.sleep` is a timer in the process and whatever the test passes in the unit lane, as `openSocket` is Node's `WebSocket` and a double there.
- **Docker is a boundary like the network.** A command runs `docker` only through `context.docker`, which the unit lane replaces as it does `fetch`; the real `docker` is walked once, in the e2e suite. `template try` tears its stack down in one place, `TryRun.tearDown` (`src/commands/template-try.ts`), so whatever ends a run reaches it: a pass, a fail, `--timeout` or Ctrl-C. The last two stop the run through one `AbortSignal`, which the Docker seam takes to end a `docker compose up` still pulling; the deadline is read from `now` between `sleep`s, so a test's clock drives it.
