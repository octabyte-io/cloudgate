# Changelog

## Unreleased

### The server reports version 0.2.0, the first that takes an upload of only the changed files

`backend/package.json`, and so `GET /settings/about`, `GET /settings/version` and the update check, now say `0.2.0`. It is the first version with `POST /applications/:id/drop/compare` and `POST /applications/:id/drop/apply` (spec #10): compare takes the folder's file list with the SHA-256 of each file and answers which files the build host lacks or holds different, plus how many are unchanged and how many it will delete. Apply takes the list and a zip of only those files, builds the new tree beside the current one, and swaps it in only once every file matches. A tree that changed since the comparison is refused with 409 `UPLOAD_CONFLICT` and the previous tree is left as it was. Both routes refuse during a build as `/drop` does. `cloudgate deploy` uses them from `0.2.0` on and sends the full `/drop` upload to an older Instance, so it still works against `0.1.0`. `POST /applications/:id/drop` is unchanged.

**What to do on upgrade**: nothing.

### Deploy an app straight from the templates website, with no server and no account yet

The public templates website's "Deploy <app>" buttons now land on the console's **Get started** page, `/get-started?template=<id>`, a three-step wizard for someone who has never used a deployment tool (ADR-0073, amending ADR-0065 for the wizard only). Every step lives in the address (`template`, `path=buy|own`, `server`, `step`, `env`), so it survives Stripe Checkout, a bank's 3D Secure page and a reload.

- **Signing up on the way.** A visitor with no session is sent to sign in; *Create an account* keeps where they were going. On the Hosted instance following the confirmation link now signs the person in (better-auth's `autoSignInAfterVerification`) and lands them back on the wizard. Only the first, unconfirmed follow signs anyone in, and a confirmation link that would land on another site is refused at sign-up and at resend with 403 `INVALID_CALLBACK_URL`, in every mode.
- **Choosing a server.** A Ready Server the Organization already has is offered first. Otherwise: **Get a server from Cloudgate** (recommended; a Bought Server with a suggested size and the nearest place, on the Hosted instance where buying is offered) or **Use my own server** (the address, a key made on the spot, the one command that puts it on the server, then *Connect my server*, which is the confirmed press that starts the Setup run, ADR-0058). Members without `server: ['create']` are told to ask an owner or admin. With no plan, the own-server path starts the Starter Free trial in Checkout first; buying a Server starts it itself (ADR-0071).
- **Deploying.** The app's asked values, then Deploy, which makes a new Project named after the app with a `production` Environment on that Server and sets the template up with `autoApply`. Cloudgate applies its Plan by itself, as the person who set it up, once the Server is Ready and set up, and only when the Plan holds nothing but that setup's creates; anything else is left for a person to review. The wizard follows it to a success screen with **Open <app>**, the address, and the next step: add your own domain for https, since the free sslip.io address is plain http. A refused Apply says why rather than waiting for ever.
- **API.** `POST /templates/setup` takes `autoApply: true` (refused for a repository-kept config). `GET /environments/:environmentId/pending-setups` lists each setup's `autoApply` (`waiting` and what for, `applying`, `applied`, `refused` and why). `POST /billing/checkout`, `POST /bought-servers` and `POST /bought-servers/:id/finish-paying` take an optional `returnTo`, a path on the console's own origin that Stripe returns to with `checkout=success` or `checkout=cancelled`. An auto-Apply is recorded in the audit trail as `POST /environments/:environmentId/plan/apply` with `metadata.autoApply`.
- A template setup whose Environment has no Server now links to the wizard.
- Every "Contact us" an Enterprise or billed-by-agreement Organization meets now names `support@octabyte.io`, and the Hosted Enterprise card links to it.

**What to do on upgrade**: nothing. Migration `0222_pending-setup-auto-apply` adds three nullable columns to `pending_setup`.

### The Template catalogue is one catalogue.zip, checked whole, and a mirrored catalogue.json is refused

Each `cg-templates` release now publishes one `catalogue.zip`, a folder per template beside a small index, in place of the `catalogue.json` that held every template's files and logo in one document and would have outgrown its 10 MB cap (ADR-0072, amending ADR-0062; #1403). Nothing else about reading it changes: one fixed release, checked at most once an hour, the last good copy kept and served while the address cannot be reached.

- **The default address is new.** `CLOUDGATE_TEMPLATES_URL` defaults to `https://github.com/octabyte-io/cg-templates/releases/latest/download/catalogue.zip`. The hosts it needs are the same, `github.com` and `release-assets.githubusercontent.com`.
- **A mirror must serve `catalogue.zip`.** A `CLOUDGATE_TEMPLATES_URL` that still serves a release's `catalogue.json` is refused with "The catalogue is a catalogue.json, the format before ADR-0072; this Cloudgate reads a catalogue.zip". Copy the release's zip as it is published.
- **The zip is checked whole before anything in it is read**, in memory and never written to disk. One that holds anything a template does not (a website's `index.md` or `screenshots/`, a stray file, a config file of a kind the ADR does not list or that its `template.yaml` does not name), an unsafe path, a symlink, an encrypted entry, more than 20,000 entries or more than 50 MB unpacked is refused as a whole, and the screen keeps the last good copy and names the reason. A template inside a sound zip that this instance cannot read is still hidden alone.
- **Saved copies are dropped once on upgrade.** They held the old format, which this Cloudgate cannot read; migration `0221_drop-format-1-catalogue-copies` deletes them, and the next time someone opens the Templates screen the catalogue is fetched again, as on a fresh install. Until that fetch succeeds there is no copy to fall back on, so an unreachable catalogue answers 502 or 504 rather than an old list.

**What to do on upgrade**: nothing, if `CLOUDGATE_TEMPLATES_URL` is unset or `off`. If it names a mirror, mirror the release's `catalogue.zip` and point the setting at it in `/etc/default/cloudgate-backend`, then restart `cloudgate-backend` (`docs/deploy.md`, "The Template catalogue").

### The Hosted instance sells Bought Servers, paid monthly in advance and deleted when unpaid

On the Hosted instance an Organization can buy a Server from Cloudgate (ADR-0071, #1387). Servers gains **Buy a Server**, a page with a world map of every Location, the Locations sorted by distance from a position worked out in the browser from its time zone and never sent, the sizes for the chosen Location (any size not sold there greyed out), optional backups and extra storage (10 GB to 10 TB), and a summary with the monthly price, the exact amount charged today and the dates it covers, the terms checkbox and **Buy**. Each price is the provider's USD list price (plus IPv4 for a Server) times one plus the **Server markup**, rounded up to a whole dollar, or to a multiple of $5 above $100.

- **Paying first.** Buy charges in advance on the Organization's Hosted plan invoice (an Attached Organization's go on its Paying Organization's), with 3D Secure on the first Server and prepaid cards refused. In the Free trial the Server is charged on its own invoice up to the trial's end; with no plan and no Free trial left it is charged in the same Checkout as Starter; a full Server count adds one Add-on to the same charge. Only once the payment succeeds is the machine made, and Cloudgate then runs the first Setup run by itself (ADR-0058, amended). The Server shows **Waiting for payment**, **Creating**, **Setting up**, then **Ready**; deploys to it are refused, and the Deploy target and run Server pickers grey it out, until it is Ready.
- **Never paying for nothing.** A machine or Volume the provider refuses twice is refunded in full and the owner emailed. Every stage resumes after a restart from what is stored, and a new hourly job resumes anything left mid-stage and settles a charge a restart cut off.
- **Changes** on the Server's settings: backups on or off, extra storage grown (never shrunk; the filesystem is grown for you), and size up or down (the machine is powered off while it changes; the disk is never grown). A costlier change is charged at once; a cheaper one credits the next invoice. A change the provider refuses twice is refunded and the Server left as it was.
- **Delete** deletes the machine, its backups, its storage and its addresses, and credits the unused part of the month. The record stays as **Deleted**.
- **Unpaid, suspended or lapsed.** A failed invoice for Bought Servers sets a deletion date 7 days later; a suspension, 7 days after it; a lapse deletes them at once; a cancel is warned 7 days before. Each comes with emails and a red "Due for deletion on <date>" bar, costlier changes are refused while it shows, and paying the invoice or lifting the suspension cancels it. The deletion credits nothing.
- **Operators** get a Bought Servers section: each Bought Server's real margin at the day's ECB rate, the Server markup (default 20%) and margin floor (default 10%), a reprice action (a rise starts 30 days later, a fall at once, with an email to each owner), power off and on with a required reason, *Forward abuse report* with a 24-hour deadline, and the machines no Bought Server owns, found hourly and never deleted automatically. ADR-0050 is amended to name these writes; none gives anyone access to a machine.

**New optional settings** (hosted mode only; without both tokens *Buy a Server* is not offered and its routes answer 404): `HETZNER_EUR_API_TOKEN` (the account that makes machines), `HETZNER_USD_API_TOKEN` (a read-only token on the empty USD account that supplies prices) and `BOUGHT_SERVER_REVERSE_DNS_DOMAIN` (each machine's reverse DNS is set to `<server id>.<domain>`; unset, the Operator page warns). The backend now reaches `api.hetzner.cloud` and, for the Operator page's exchange rate, `www.ecb.europa.eu`.

**What to do on upgrade**: nothing on a Self-hosted instance. On the Hosted instance, subscribe the Stripe webhook endpoint to `customer.subscription.pending_update_expired` and `charge.dispute.created` as well (the full list is in `docs/deploy.md` §11, and on every start the Hosted instance now reads its endpoints from Stripe and logs a warning naming any event one is missing or has extra), and set the settings above in `/etc/default/cloudgate-backend` when you are ready to sell.

### Templates come from the official Template catalogue and are set up as a Plan; the `template.toml` system is gone

Templates now work on a fresh install with nothing set. The Templates screen reads the official **Template catalogue**, [`octabyte-io/cg-templates`](https://github.com/octabyte-io/cg-templates), whose first release holds 20 starter apps: Activepieces, Automatisch, Baserow, Cal.com, Chatwoot, Ghost, Gitea, Immich, listmonk, Matomo, Mattermost, Metabase, n8n, Nextcloud, Outline, Plausible Analytics, Umami, Uptime Kuma, Vaultwarden and WordPress. A Template is an ordinary Project config (`cloudgate.yaml`) with a `template.yaml` beside it, so setting one up is an ordinary **Plan** you review and Apply (ADR-0062 to ADR-0066).

- **The catalogue.** `CLOUDGATE_TEMPLATES_URL` names the catalogue file and defaults to `https://github.com/octabyte-io/cg-templates/releases/latest/download/catalogue.zip` (ADR-0072), so the backend now reaches `github.com` and GitHub's release-download host (`release-assets.githubusercontent.com`) by default. Point it at your own mirror's `catalogue.zip` (http or https), or set it to `off`, which turns templates off with the coded 503 `TEMPLATES_CATALOGUE_NOT_CONFIGURED` and says so on the screen. The last good copy is kept in the database and checked for a newer release at most once an hour, only when someone opens the Templates screen. While GitHub cannot be reached the screen keeps that copy and says how old it is; with no copy yet, `GET /templates` answers 502 or 504, never an empty list. A file over 10 MB, or one that is not a valid catalogue, is refused and the old copy kept. A template this instance cannot read, or that needs a newer Cloudgate, is hidden and the rest still listed.
- **`GET /templates` answers `{ templates, copy }`** instead of a bare list: each Template with its logo, tags, links (website, docs, source), the app's version, its catalogue revision and where it can run (`runsOn`: a Server, and each cloud that can make every entry), and `copy` with when it was fetched and checked and why the last check kept it. `GET /templates/tags` is unchanged. The catalogue cards show all of it, with a mark such as "Runs on a Server or in a cloud".
- **Setting one up.** `GET /templates/:templateId/setup?projectId=` is the form: the template's asked values, and each Environment with whether it can take the template and why not (greyed out in the console). `POST /templates/setup` (`service: ['create']`) takes the template, an existing Project and Environment or a new Project with its Deploy target, a setup name, the asked values and each compose Domain's host. It asks every statement its Apply will ask first (`domain: ['create']` with Domains, `volume: ['create']` with files, `deployment: ['create']`, and `project`/`environment: ['create']` for a new Project), makes each generated value once from a cryptographically secure source, and keeps them encrypted on the Environment as a **Pending setup**, with a **Setup record** on the Project naming the template, its revision and the Config names it made. Parts are named `<setup name>-<part>` (`ghost-app`, `ghost-db`), and a clash renames the setup as a whole (`ghost-2`). No Agent can set a template up.
- **The Plan.** On a Cloudgate-kept config, setup adds the renamed entries and opens the Environment's Plan, which says how each value is made (`generated (base64, 32 bytes)`, `asked`) and never shows one, and creates the compose part as a console-managed stack: `create compose stack ghost-app, from the Ghost template`. Apply writes each value into its Service's own `env`, and makes the compose stack, its `.env`, its encrypted file mounts and its Domains in one step that leaves nothing behind if it fails. In a Cloud Environment that step makes the stack, its `.env` and its file mounts, and the Domains are added after it, once the Cloud run has made the Stack VM their load balancer rule reaches. A host taken since setup refuses the Plan, and again before Apply writes anything. Dismissing the Plan drops the Pending setup; a newer plan carries its entries forward.
- **Where it runs.** On a Server each compose Domain starts on a generated sslip.io host you may replace. In a Cloud Environment the compose part runs on its own Stack VM (ADR-0070), at the template's minimum size or `medium`, priced on the plan line; you type each Domain's host and the form shows the DNS record it needs. A template whose values need an own `web`'s URL is not offered where that `web` gets no generated host.
- **Repository-kept configs.** Setup shows the renamed YAML to paste into `cloudgate.yaml`, touches nothing in the repository, and the next push's Plan creates the parts from the Pending setup by Config name and kind. A part renamed in the paste gets nothing, and the plan notes the values left unused.
- **New Project from a template** makes a Project with a Cloudgate-kept config and a `production` Environment on the Deploy target picked, then sets up into it. Dismissing its Plan leaves an empty Project, as the form says.
- **Other Environments.** A plan holds a setup's parts back together, with a note, in an Environment where the template was not set up; setting it up there reuses the Config names and makes only that Environment's values, hosts and stack.
- **Pending setups on the Environment.** `GET /environments/:environmentId/pending-setups` (`environment: ['read']`) lists them, every secret as present only, and the Services tab shows them with Cancel, `DELETE /environments/:environmentId/pending-setups/:pendingSetupId` (`environment: ['update']`). One unused for 30 days is dropped, leaving a note on the Environment for 30 days more.
- **Checking a template**: `cloudgate template check` in the CLI runs this same Template check, and `cg-templates` CI runs it on every pull request (see `cli/CHANGELOG.md`).

**Removed, with no converter.** The Dokploy-style `template.toml` format, its `meta.json`/`blueprints/` reader, and paste-your-own templates are gone. So are `POST /templates/preview`, `POST /templates/process` and `POST /templates/deploy`, which now answer 404, and the console's review step. A template written in the old format has to be written again as a `cg-templates` folder; how is in that repository's README.

**`CLOUDGATE_TEMPLATES_BASE_URL` is no longer read.** An install that still sets it, and does not set `CLOUDGATE_TEMPLATES_URL`, starts normally with templates off, so a mirror you chose is never silently swapped for GitHub. The startup log and the Templates screen say: "`CLOUDGATE_TEMPLATES_BASE_URL` is no longer read. Set `CLOUDGATE_TEMPLATES_URL`, or remove the old setting to use the official catalogue."

**Stacks already set up from old templates keep running, untouched.** They are ordinary Compose stacks with no link to the reader.

**What to do on upgrade**: nothing, if you never set `CLOUDGATE_TEMPLATES_BASE_URL` and the backend may reach GitHub. Otherwise remove the old setting, or set `CLOUDGATE_TEMPLATES_URL` to a mirror of `catalogue.zip` or to `off`, in `/etc/default/cloudgate-backend`, and restart `cloudgate-backend` (`docs/deploy.md`, "The Template catalogue").

### A Stack VM resizes, grows its data disk and is replaced only on a plan line

A Compose stack's Stack VM (ADR-0070) now changes only through its Environment's plan, on AWS and Google Cloud alike (#1368):

- **Resize.** A new `size`, or a machine type its `native.aws`/`native.gcp` sets (a console-managed stack: its size on the stack page), is a change line that says it restarts the Stack VM, with the old and new monthly price: "analytics Stack VM: t3.small (2 vCPU, 2 GB) → t3.medium (2 vCPU, 4 GB), restarts the Stack VM" and "analytics Stack VM cost: about $19.40 → about $36.05 a month". An entry with no `size` keeps the machine it was made on.
- **Data disk.** A disk grown on the stack page is a change line, grown in place with no restart and priced; the Apply's Cloud run grows its filesystem through the tunnel. A smaller size is refused, naming the stack. A plan that would shrink a disk grown by hand in the cloud, or delete the data disk in a change, fails its read with the size it is and the fix.
- **Replace VM.** Each cloud's Ubuntu 24.04 image is now one pinned build (`deploy/opentofu/stack-vm.json`: `ubuntu_aws`, `ubuntu_gcp`), beside the Docker Engine and compose plugin pins. A made Stack VM keeps the image and pins it was made with, and its first boot's user data is never changed in place. Once Cloudgate's pins move, the plan offers a "replace VM" line naming each pin's old and new value; applied, it is planned with `-replace`, keeps the data disk and its volumes in the same zone, records the new image and pins, and deploys the stack onto the new Stack VM.

### Stop, Start and Restart of a Compose stack on its Stack VM, and whether the VM runs

On a stack that runs on its own Stack VM (ADR-0070), **Stop** (`POST /compose/:id/stop`) runs `docker compose stop` through the cloud's tunnel and then stops the VM through the cloud's API (EC2 `StopInstances`, Compute Engine `instances.stop`), so a stopped stack pays only for its disk. **Start** starts the VM, waits until its tunnel answers, then runs `docker compose start` on the containers its Stop stopped, as they were. **Restart** (`POST /compose/:id/restart`, new, `deployment: ['create']`) runs `docker compose restart` and never touches the VM; the console offers it beside Stop for a stack on a Stack VM. `GET /compose/:id/stack-vm` reads whether the VM runs from its cloud (`running`, `starting`, `stopping`, `stopped`, `gone`, `not-made`, or `unknown` with the cloud's words), and the stack page's facts card shows it. A Deployment of a stack whose Stack VM is stopped is refused with **409** "…'s Stack VM is stopped: start it first, then deploy". A Deployment, Stop, Start or Restart of a stack whose Stack VM no Apply has made yet (a console-made stack before its Environment's next plan) is refused up front with **409** "…'s Stack VM is not made yet: the Environment's next plan makes it once applied, and nothing runs on it until then". The Containers tab offers no per-container control on a Stack VM, whose containers the stack's Restart restarts. A frozen Organization's Stack VMs keep running: nothing stops them, and Stop is refused like any other write (ADR-0052). The permissions are the ones Cloud accounts already gained for Stack VMs.

### Cloud accounts gain the permissions a Stack VM needs: AWS policy versions 4 and 5, Google role versions 7 and 8

A Compose stack in a Cloud account runs on its own Stack VM, reached through the cloud's tunnel (ADR-0070), so Cloudgate's role needs more. Accounts connected from now on get it from their setup; accounts connected before are told exactly what to add. Neither instance is asked for a build service it does not use (ADR-0047): the versions fork by instance mode.

- **AWS**: a Self-hosted instance generates and checks **policy version 4** (version 2 and the Stack VM statements), the Hosted instance **version 5** (version 3 and the same). They are a second managed policy on the deploy role, `cloudgate-deploy-stack-vm-<cloud account id>`, held to Cloudgate's mark like the rest:
  - Session Manager: `ssm:StartSession` only to instances carrying the Cloud account's `cloudgate:cloud-account` tag, with the `AWS-StartSSHSession` or `AWS-StartPortForwardingSession` document; `TerminateSession`/`ResumeSession` only on the deploy role's own sessions (`session/cloudgate-*`); `DescribeInstanceInformation`, `GetConnectionStatus`.
  - EC2: `RunInstances` and `CreateVolume` only with the tag (the launch's root volume, network interface and public image, and the network's tagged subnet and security group, as part of it); start, stop, reboot, terminate, modify, attach, detach, delete, grow and the final snapshot only on what carries it; `CreateTags` only inside those creates.
  - Data Lifecycle Manager: the daily snapshot policy, made with the tag and changed or deleted only where it carries it.
  - IAM: the Stack VM's role and its snapshots' role, and its instance profile, under a path of their own, `/cloudgate/stack-vm/`, made with the tag, holding only `AmazonSSMManagedInstanceCore` and `AWSDataLifecycleManagerServiceRole` (no inline policy), passed only to EC2 and DLM. The task roles' permissions boundary is unchanged.
  - SSM: Canonical's public Ubuntu image parameter (`/aws/service/canonical/ubuntu/*`).
- **Google Cloud**: a Self-hosted instance's **role version 7** (version 5 and the Stack VM group), the Hosted instance's **version 8** (version 6 and the same): `compute.instances.*` for the Stack VM, `compute.disks.*` for its data disk, `compute.resourcePolicies.*` and `compute.snapshots.*` for its daily snapshots and final snapshot, `compute.zoneOperations.get`, `compute.machineTypes.get`, `compute.routers.*` for the network's Cloud NAT, `iap.tunnelInstances.accessViaIAP`, and the IAP API (`iap.googleapis.com`) turned on. Its own service account and firewall rule are the role's existing `iam.serviceAccounts` and `compute.firewalls` permissions. Scoped as the rest of the role: to the project, which is Cloudgate's own (ADR-0041).
- **"Check now" on an existing account names the gap**: "… They are the Stack VM permissions (…), which version 4 adds. Update the role from the Cloud account's new setup template, which adds them as the managed policy cloudgate-deploy-stack-vm-<id>, then Check now", and on Google Cloud the same with "Run the Cloud account's new setup script in Cloud Shell, which updates the role and turns on IAP's API, then Check now". The Cloud accounts list shows the account's permissions as out of date, with the actions missing.
- **A plan refuses a Stack VM in an account with the gap**, on both clouds, naming the entry, the account, the version it was checked at, every missing action (or permission and API) and the fix. Nothing else in such an account is refused.

**What to do for an existing Cloud account**: on AWS, download the new CloudFormation template from Settings > Cloud accounts and update the account's stack with it (or add the `cloudgate-deploy-stack-vm-<id>` managed policy from the plain JSON to the deploy role); on Google Cloud, run the new setup script in Cloud Shell. Then Check now.

### Changing an Application's port moves its Domains on the old port

Changing an Application's port (`PATCH /applications/:id`, or an Apply that changes a `web`'s `port`) on a Server or the platform host now moves every one of its Domains that was on the old port to the new one and rewrites their routing in the same request, so they no longer answer 502 until each is edited (ADR-0068). A Domain on any other port is left where it is. The answer carries `domainPortMove` (`from`, `to`, the Domains `moved` and those `left`, each by host), and the console says it: "2 Domains moved to port 3900; api.example.com stays on 8080." on the new Container port card (Advanced > Routing) and on the Apply's change line. A routing write that fails refuses the whole change, leaving the port and its Domains as they were. Unaffected: Applications in a Cloud account, bucket and Compose Domains, previews, and Uptime checks.

### Hosted: one Organization that pays for itself per person

On the Hosted instance, "New organization" (`POST /organizations`, paid for by itself) refuses someone who already owns an Organization that pays for itself, **403 `ORGANIZATION_LIMIT`**, with "You already own Northwind, and a person can own one Organization that pays for itself" (ADR-0059). The open Organization's owners and admins also get "On Business, Northwind can pay for more Organizations" Attached Organizations they own and the Instance organization do not count, invites and membership are not limited, and "Add an Organization to this plan" is unaffected. `GET /organizations/creation` says the same before anyone clicks, with how many they own and, for owners and admins, where to go: Settings > Organizations reads "You own 1 of 1 you can own yourself. Attached ones you own do not count.", and the greyed-out "New organization" there and in the switcher points at "Add an Organization to <Organization>'s plan" when the open Organization is on Business or Enterprise, otherwise "See plans".

### Hosted: every member of an Attached Organization sees its Billing page

`GET /billing/attached-plan`, which any member may read, answers who pays for an Attached Organization, the room left on that plan and the Organization's own use, and nothing about Stripe, invoices, the plan's size or the other Organizations on it. The Billing page draws the "Paid by" card from it, so a plain member sees it too, with no plan or Add-ons buttons; the Billing page of an Organization that pays for itself stays an owner's or admin's. A detached Organization's own Checkout is refused with **403 `ORGANIZATION_LIMIT`** while its owner owns another Organization that pays for itself, and "Stop paying for it" works while the Paying Organization is frozen.

### Self-hosted: one Organization unless the Instance organization has a valid license

Without a valid Enterprise license on the Instance organization, `POST /organizations` refuses a new Organization once one exists, **403 `ORGANIZATION_LIMIT`**, with "Without an Enterprise license this instance allows one Organization. Add a license under Settings > License" to the Instance organization's owners and admins and "…The instance's administrators can add a license" to everyone else (ADR-0059). No other Organization's license counts, and the owner-or-admin check still comes first. An instance that already has more than one keeps them all and keeps working; only a new one is refused, and Settings > Organizations says once that the instance is over the free version's limit. "More than one Organization" is the seventh licensed feature on Settings > License, and "Creating more Organizations" joins what stops when a license lapses. `GET /organizations/creation` answers whether a create would be accepted and why not, which the console uses to grey out "New organization" in Settings > Organizations and the switcher.

### `install.sh` has a hosted path, and the Hosted instance's session cookie is Secure

`HOSTED_MODE=true bash deploy/install.sh` installs the Hosted instance. It refuses to start, naming every one missing, until the hostname (`CLOUDGATE_HOSTNAME`), `SITE_URL`, the Stripe keys and price ids, the Resend sender and key, the Turnstile keys and the first staff account's details are given; the first run keeps them in `/etc/default/cloudgate-hosted`, so a re-run needs only `HOSTED_MODE=true`, and a run without it on a hosted box refuses.

- **One hostname on HTTPS.** Traefik serves it with a Let's Encrypt certificate (`dynamic/hosted.yml`, from the backend's `hosted-traefik-config` command): the six WebSocket gateway paths and the Gateway's `/ai/` to the API, everything else to the console, plain HTTP redirected.
- **3000 and 4000 are closed**, open only on `docker_gwbridge` for Traefik.
- **The Instance organization is made by `create-instance-organization`** after the backend starts, instead of the first sign-up owning the instance; a re-run skips it once an owner exists.
- **The session cookie is `Secure`** (`__Secure-better-auth.session_token`) in hosted mode; Self-hosted is unchanged, as is the Self-hosted install.

### On the Hosted instance sign-up asks for a Cloudflare Turnstile check, and a confirmation email goes to an address at most once every 5 minutes

In hosted mode the public sign-up form shows Cloudflare's Turnstile widget, and `POST /api/auth/sign-up/email` without its token is refused **400 `MISSING_RESPONSE`**, with one Cloudflare does not accept **403 `VERIFICATION_FAILED`**, before any account is made or email sent (better-auth's captcha plugin). An invited sign-up is not asked: its invitation authorises it. A confirmation email — on sign-up, from "Send the link again" and to the new address on a change of email — goes to the same address at most once every 5 minutes; a resend within that window answers **429 `CONFIRMATION_EMAIL_LIMITED`** and sends nothing, on top of the existing 3-per-10-seconds limit per IP.

- **Settings**: a hosted boot now also refuses to start without `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`. `GET /auth/sign-up-open` carries `turnstileSiteKey` in hosted mode.
- **Self-hosted**: unchanged; no widget, no token asked for, no site key sent.

### The database remembers the instance mode, and a start that disagrees refuses

The first start records the Instance's mode (`hosted` or `self-hosted`) in a single row (`recorded_instance_mode`, migration `0190`); an existing Self-hosted instance records `self-hosted` on its first start after the upgrade, and nothing else changes for it. Any later start whose `HOSTED_MODE` disagrees with the record refuses to start, naming both — "This Instance's recorded mode is hosted, but its setting says self-hosted (HOSTED_MODE unset)…" — so an `install.sh` re-run that drops the setting cannot turn the Hosted instance into a Self-hosted one with an open platform host (ADR-0049).

- **Changing mode on purpose** is a hand-run command on the platform host: `node dist/commands/set-instance-mode.js --mode <hosted|self-hosted>` (or `pnpm --filter backend set-instance-mode -- --mode …`), needing only `DATABASE_URL`. Then set `HOSTED_MODE` to match and restart. Exit 0 changed (or already that mode), 1 refused with nothing written, 2 usage.
- **Turning hosted on refuses while any Service has the platform host as its place** (no Server and no Cloud account), listing each by kind, name, id, Organization, Project and Environment (ADR-0053). Turning self-hosted on has no such check.

### On the Hosted instance an Operator page lists every Organization's account facts

In hosted mode an owner or admin of the Instance organization — a person, never an Agent — finds **Settings > Operator**, listing each Organization's name, creation date, owner email, member count (people only), plan and Stripe status, Servers and Cloud Environments used against its counts, and whether it is Enterprise. Nothing from inside a Project is shown: no Services, env values, logs, Server addresses or shells. There is no impersonation, `/admin/*` stays locked, and viewing is not audited.

- **API**: `GET /operator/organizations` (Operators only; anybody else 403 "Only an owner or admin of the Instance organization can use the Operator page", an Agent key 403 `AGENT_NOT_ALLOWED_HERE`) and `GET /operator/access` → `{ operator }` for any signed-in person, which the console asks before offering the page.
- **Self-hosted**: both routes answer 404 and the console has no Operator section.

### On the Hosted instance the paid features come with Enterprise, not a license key

In hosted mode SSO, SCIM, custom roles and forward auth ask whether the Organization is **Enterprise** — the marker an Operator sets on its billing row (`subscription.enterprise`, formerly `is_enterprise_cloud`) — and a stored license key unlocks nothing. A Self-hosted instance is unchanged: its license key decides, and the marker is ignored.

- **Refusal**: 403 **`ENTERPRISE_REQUIRED`**, "SSO, SCIM, custom roles and forward auth come with Enterprise. Contact us…", where self-hosted still answers "Valid enterprise license required". `GET /license/status` answers `licensed` from the marker, and `GET /sso/show-sign-in` is on once any Organization is Enterprise.
- **No license key on the Hosted instance**: `GET`/`PATCH /license/settings`, `POST /license/activate`, `/validate` and `/deactivate` answer 404 **`NO_LICENSE_KEY_ON_HOSTED`**. The console's License screen shows Enterprise with "Contact us" (a link to the branding's support URL when one is set) instead of the key, and every locked paid feature says the same.
- **Install-wide features are on**: white-labelling, parallel builds and parallel cloud runs need no license in hosted mode; instance authority still decides who changes them.
- **An Enterprise Organization's allowance is its hand-set counts** (`enterprise_servers`, `enterprise_cloud_environments`, migration `0187`), whatever its Stripe status; `allowance.plan` reads `enterprise`, a full count refuses with `ALLOWANCE_FULL` "Contact us to raise its counts", and checkout answers `PLAN_ALREADY_HELD`.

### On the Hosted instance an AWS cloud Service builds in CodeBuild in its Cloud account

With hosted mode on, a cloud Service on AWS (a `web`, Worker, Private web service or Cron service with a git, git provider or `drop` source) is no longer built on the platform host. The platform host checks the source out as before; the Deployment's Cloud run zips the checkout without its `.git` (so no git token leaves Cloudgate), uploads it to the Environment's source bucket, and builds and pushes in the Environment's CodeBuild project from the pinned Cloudgate builder image, as the Cloud account's build identity.

- **The log is live**: the build's lines are copied into the Deployment log as CodeBuild writes them.
- **Cancel and Stop the run stop the CodeBuild build**, and the zip is removed from the bucket however the build ends.
- **Time queued in CodeBuild does not count against the Cloud run time limit**, so a second deploy in an account that runs one build at a time is not failed while it waits.
- **A Cloud account set up before permissions version 3** is refused before anything is checked out: "Re-run the Cloud account's setup, then deploy again".
- **A network made before cloud builds** has no CodeBuild project yet: the deploy says so, and the network's next plan makes it.
- The builder image is `1.2.0`: `1.1.0` added `docker-credential-ecr-login`, and `1.2.0` is built on Debian (glibc) rather than Alpine, so a Railpack build can run the `mise` it downloads.
- **A Heroku or Paketo build pulls its builder's run image first**, on a Server too, so a daemon with the containerd image store (docker 29.4) keeps every layer of it and pack can export the app, where it failed with "image with reference heroku/heroku:24 was found but does not provide the specified platform".

A Self-hosted instance still builds on the platform host.

### On the Hosted instance a ready-made image is copied by a build in its Cloud account

With hosted mode on, a cloud Service on AWS or Google Cloud deployed from a ready-made image (`source: { image: … }`) is no longer pulled, inspected or pushed on the platform host. The build slot pulls nothing; the Deployment's Cloud run starts one short CodeBuild or Cloud Build build, as the Cloud account's build identity, from the same pinned builder image, that pulls the image (for `linux/amd64` on Cloud Run), pushes it to the Service's own repository and says what it is. Its log lines, Cancel, Stop, the time limit and the queue wait behave as for a built image.

- **A private registry's password goes only through the cloud's secret store**: it is written for that one Deployment as an SSM Parameter Store SecureString (`/cloudgate/build/<Cloud account>/<Deployment>/registry-password`, read by CodeBuild as a `PARAMETER_STORE` build variable) or a Secret Manager secret (`cloudgate-build-<Cloud account key>-<Deployment>`, which only the build identity may read, named in the build's `availableSecrets`). The start call names where it is, never the value; it is in no zip and no plain-text variable, and it is deleted once the build has ended, whether it succeeded or failed.
- **On AWS the build identity may read its own Cloud account's build parameters** (`ssm:GetParameters` on `parameter/cloudgate/build/<Cloud account>/*`), added to the version 3 setup template's build identity. On Google Cloud nothing changes in setup: Cloudgate grants the reader on each secret with role version 1's `secretmanager.secrets.setIamPolicy`.

A Self-hosted instance keeps pulling and pushing a ready-made image on its platform host, as before.

### On the Hosted instance a Google Cloud Service builds in Cloud Build in its project

The same, on Google Cloud: with hosted mode on, the Deployment's Cloud run zips the checkout without its `.git`, uploads it to the Environment's source bucket, and starts one Cloud Build build in the Service's region from the pinned Cloudgate builder image, as the Cloud account's build identity, which signs in to Artifact Registry with its own token to push.

- **The log is live**: the build logs to Cloud Logging only (`CLOUD_LOGGING_ONLY`, the one option a build run as its own service account can both use and read while it runs), and its lines are copied into the Deployment log as they come, and for a few seconds after the build ends, since Cloud Logging shows an entry late.
- **Cancel and Stop the run cancel the Cloud Build build**, the zip is removed however the build ends, and time queued in Cloud Build does not count against the Cloud run time limit.
- **An image of another CPU than x86 fails the build before anything is pushed.**
- **A Cloud account set up before role version 6** is refused before anything is checked out: "Re-run the Cloud account's setup, then deploy again".

### Hosted billing sells one plan and Add-ons, and never switches a Server off

The Hosted instance's catalogue is the monthly Hosted plan (`HOSTED_PLAN_PRICE_ID`: 3 Servers and 3 Cloud Environments) and the monthly Add-on (`ADD_ON_PRICE_ID`: one more of each). The legacy, hobby and startup tiers, annual prices and their `BASE_PRICE_*`, `LEGACY_PRODUCT_*`, `HOBBY_*` and `STARTUP_*` settings are gone.

- **`POST /billing/checkout` takes `{ addOns }`** and answers `{ sessionId, addOns }`, the quantity raised to cover the Servers already held beyond 3. It refuses with **503 `CHECKOUT_NOT_CONFIGURED`** naming an unset price, and **409 `PLAN_ALREADY_HELD`** when the Organization has the plan. **`POST /billing/add-ons`** (`{ addOns }`, same floor) replaces `POST /billing/upgrade`. `GET /billing/products` answers `{ includes, plan, addOn }` with each price.
- **The allowance** is `3 + addOns` while the plan is granted (`active`, `trialing` or `past_due`) and 0 without it. `GET /billing/subscription` answers `addOns`, `allowance`, `usage` and `minimumAddOns` in place of `serversQuantity`. Server create refuses with **403 `PLAN_REQUIRED`** ("Choose a plan…") or **403 `ALLOWANCE_FULL`** pointing at the Add-on, and `GET /billing/can-create-server` carries the same `code` and `message`.
- **No webhook event changes a Server's status any more**, and deleting a Server reapplies nothing: a lowered count or an ended subscription refuses only the next addition.
- Stripe's return links go to the console's `/settings/billing`.

### The server reports version 0.1.0, the one the Cloudgate CLI needs

`backend/package.json`, and so `GET /settings/about`, `GET /settings/version` and the update check, now say `0.1.0`, where every server so far said `0.0.1`. The Cloudgate CLI refuses an Instance older than `0.1.0`, which has none of the routes below that its commands call.

### A Personal key may delete itself, and no other key

`DELETE /users/me/api-keys/:id` now accepts a Personal key when `:id` is that key's own id, so `cloudgate logout` can delete the key it holds. It is the one exception to the interactive-session rule for key management.

- **Only itself.** A key naming any other key, its owner's included, is refused with 403 as before, and creating or listing keys still needs the console session, so a key still cannot rotate itself out of a revocation.
- **Once deleted it is an unknown key**: the next request with it answers a bare 401, and neither that answer nor the server's log lines for it carry the key's value. The delete is in the audit trail as any other.

### The container-logs socket can read a tail and end: `follow=false`

`/docker-container-logs` takes `follow=false`, which leaves `--follow` off its `docker logs`: the socket sends the tail and then closes with `4014` (the output ended), as it does when a followed container stops. The Cloudgate CLI's `logs` without `-f` reads a Server's Runtime log this way. Without the parameter, or with `follow=true`, the socket follows as before, and the console is unchanged; any other value is refused with `4000`.

### No upload during a build: `POST /applications/:id/drop` answers 409 while one is in progress

An upload starts by deleting the Application's code folder on the build host, the very tree a build reads, so the console or a second terminal could pull it from under a running build. The upload route now refuses with **409 `DEPLOYMENT_IN_PROGRESS`**, naming the Deployment, while a build of that Application is pending or running, and changes nothing: neither the files nor the source.

- **Only the Application's own builds count.** A preview's builds and a Cron service's runs read no uploaded tree and do not block it.
- **A held build does not block it**, and neither does one pending or running for more than 60 minutes, which is taken as stuck; `cloudgate deploy` goes ahead past those with a warning, and draws its line at the same minute.

### Which Services the Project config gives a repository: `GET /environments/:id/config/repository-sources`

Answers `{ keptIn, readable, services: [{ configName, provider, repository }] }` for the Project config as that Environment reads it (a Cloudgate-kept text, or a repository-kept file on the Environment's Config branch): `keptIn` is `cloudgate`, `repository` or `null` for no config, and each listed Service is one whose entry names a repository (`github`, `gitlab`, `bitbucket`, `gitea`, or `git` with its URL) as its source. A `managed: console` entry, an image source or no `source` lists nothing. A file that cannot be read now, or does not parse, answers `readable: false` and lists nothing. Never the config's text. Gated by `environment: read`, like the config copy. `cloudgate deploy` reads it to refuse an upload a repository-kept file would undo.

### One Deployment's status and times: `GET /deployments/:id`

`GET /deployments/:deploymentId` answers `{ deploymentId, status, createdAt, startedAt, finishedAt }`: the status is `pending`, `running`, `done`, `error` (failed), `cancelled` or `held`, and the times are ISO 8601, `startedAt` and `finishedAt` null until they happen. The Cloudgate CLI asks it while it follows a Deployment log, whose stream never closes when the Deployment finishes, to know when to stop.

- **Visible to whoever may read the Deployment's log**, through the same gate, and answered 404 `Deployment not found` for an unknown id and for another Organization's Deployment alike.
- **Only those fields.** The row's log path on the build host and its other columns are not in the answer.
- The schemas of this answer, of the deploy body and of the upload's fields now live in `api-schemas`, which the CLI shares; the routes' requests and answers are unchanged.

### An Application's own variables are set and unset by name, and listed without values: `/applications/:id/variables`

`PATCH /applications/:id/variables` takes `{ set: { KEY: value }, unset: [KEY] }` and changes those keys alone in the Application's own runtime variables. `GET` on the same path lists every name, each with the Output it is wired to (`linkedTo: { source, output }`) or `null`. Neither ever answers with a value, not even a masked one; both answer `{ variables: [{ name, linkedTo }] }`. The Cloudgate CLI's `vars` uses these and never `GET /applications/:id` or `PATCH :id/environment`.

- **Every other key stays as it was**, with its comments, quoting and order. Two changes to different keys at the same moment both land: the row is locked while it is read and written, where a whole-text write would put back what the other replaced.
- **A wired name still takes no typed value.** Setting one is refused with 409 `VARIABLE_IS_LINKED`, naming its Output, as `PATCH :id/environment` refuses it. Unsetting one is refused the same way, since its value is the link's.
- **Unsetting a name that is not set** is refused with 404 `VARIABLE_NOT_SET`, so a typo is not reported as removed. Nothing changes.
- **It is a console Save.** A new name joins the Service's entry in a Cloudgate-kept Project config, and a repository-kept one refuses it with a pointer to the file, as for any other variable write. Nothing is deployed.
- **Names are what dotenv reads as a key** (letters, digits, `_`, `.`, `-`). A value the stored text cannot hold exactly is refused rather than stored changed.

### `cloudgate login`: a code approved in the console gives the CLI a Personal key

The Cloudgate CLI logs in through the browser (the device flow): it asks for a code, the person opens `<console>/device`, checks the code and approves it, and the polling CLI is handed a Personal key that ends 90 days after login. It shows in the person's Personal keys, named for the computer (`cloudgate on <host>`), and is deleted there like any other.

- **A key, never a session.** No session token is handed out and no new kind of credential exists, so a CLI login never counts as an interactive session: what needs one (managing keys, two-step verification, changing the email) still refuses the CLI's key.
- **The new `/device` screen** asks for the code (filled in from the link), shows it back, and approves or denies it. Signed out, it sends you to sign in first and back.
- **Only a signed-in person binds a code.** better-auth 1.6.33's own code request took a user id from an unauthenticated body and stored it, so a code could be bound to someone before they saw it. That route and better-auth's own token route are closed; the CLI's are `POST /auth/device/code` (which takes no fields) and `POST /auth/device/token` (which answers `AUTHORIZATION_PENDING`, `SLOW_DOWN`, `EXPIRED_TOKEN`, `ACCESS_DENIED` or `INVALID_GRANT` as a 400's `code`, then the key once). A code is bound to whoever first looks it up signed in, and only they can approve or deny it.
- **A Personal key cannot approve a login**, so a key cannot mint its successor: the lookup, approve and deny answer 403 `INTERACTIVE_SESSION_REQUIRED` to `x-api-key`.
- **Logging in again replaces the old key.** The poll may name the key a previous login on that computer holds; it is deleted once the new one is minted, and only when it is the approving person's own. Both are in the audit trail.
- **A new table**, `device_code` (migration `0185_device-code`), holds the codes waiting to be approved; one nobody finished is removed when it ends.

### A Personal key may name the Organization it acts in: `x-organization-id`

A request made with a Personal key may name its Organization in an `x-organization-id` header. The key acts there when its owner is a member, with their role in it. Without the header it acts in the owner's default Organization, as before. The Cloudgate CLI sends it for a Folder link's Organization, so a folder linked in a non-default Organization keeps working.

- **A non-member is refused.** Naming an Organization the key's owner is not a member of answers 403 with `code: "NOT_ORGANIZATION_MEMBER"`, and the same for an id that names no Organization at all.
- **Log streams stay open.** A WebSocket opened with the header keeps its Organization at every lease renewal, where it used to be cut as "acting in a different organization" outside the default one.
- **Console sessions are unchanged.** A cookie still acts in the Organization chosen in the console; the header is read only with a Personal key.

### Any address can be asked whether it is a Cloudgate: `GET /settings/about`

`GET /settings/about` answers with no credential: `{ product: "cloudgate", version, apiUrl }`. The Cloudgate CLI asks it before it sends a key anywhere, and refuses an address that does not answer it, or an Instance older than it supports.

- **The server version is public here.** It is the one number the CLI needs to refuse an Instance it cannot work with, before it fails halfway through a command. `GET /settings/version` and the runtime inventory still need a session.
- **`apiUrl` is the API's own origin**, where WebSockets are dialled, since the console proxies none. It comes from the new `CLOUDGATE_API_URL` in `/etc/default/cloudgate-backend`, which `deploy/install.sh` now writes with the same value as the console's `NEXT_PUBLIC_API_URL`; re-running the install script sets it on an existing install. It is null when unset, and the CLI's log streams will need it.
- **It reads neither the database nor Docker**, so it answers while either is down.

### An uploaded source of several MB builds

Uploading a zip to an Application with the file-upload source used to fail once its files came to more than about 96 KiB, on a single-box install and on every Cloud-account Service as well as on a Server. A real project folder now lands on the build host whole, and its Deployment builds as before. File modes and symlinks are still not kept.

### A Personal key can read who it is and when it ends: `GET /users/me/whoami`

`GET /users/me/whoami` answers the caller's email, the Organization the request acts in, and the Personal key the request was made with: its id, name, first characters and end (`expiresAt`, or null for a key that never ends). A console session gets `key: null`. The Cloudgate CLI's `whoami` reads it.

- **Only the calling key.** Listing keys stays refused to a key. This route names the one key the request carries, and never another of the person's keys.

### Exact sizes on Google Cloud: a native Cloud SQL tier, Memorystore node type or Cloud Run limit wins over `size`

On a Google Cloud Environment you can now name a machine that no `size` reaches. Set `settings.tier` on `"google_sql_database_instance.database"`, `node_type` on `"google_memorystore_instance.cache"`, or a `web`'s `template.containers.resources.limits` `cpu` or `memory` on `"google_cloud_run_v2_service.service"`. The native value wins on Google Cloud, and the entry's `size` still counts on every other Deploy target, so the same file gives a Server `size`'s caps. The rules are the same as on AWS.

- **The size line names both.** It reads `pg-1 medium → db-perf-optimized-N-4 (4 vCPU, 32 GB), set by native`. The CPU and memory are shown for a custom shape (`db-custom-4-16384`), a shared-core machine, and the `db-n1-standard`, `db-n1-highmem` and `db-perf-optimized-N` tiers. Any other tier is named alone, and Google judges it at the Cloud run. If native sets only one Cloud Run limit, the line marks that half: `medium → 2 CPU (native) / 2 GB`.
- **The usual move warning applies.** A native tier move still warns that the instance restarts, and a native node-type move still warns that connections may drop.
- **Taking it out never shrinks the machine to the smallest.** With a `size`, the machine falls back to the size's tier, and the line reads `→ size (db-g1-small)`. With no `size`, it stays where it is and is the console's again. A `web` with no `size` keeps the limits native gave it.
- **The Database page refuses a tier or node type that the config sets natively**, and names the path that sets it.

### Exact sizes on AWS: a native class, node type or Fargate CPU and memory wins over `size`

On an AWS Environment you can now name a machine that no `size` reaches. Set `instance_class` on `"aws_db_instance.database"`, `node_type` on `"aws_elasticache_replication_group.cache"`, or the task's `cpu` or `memory` on `"aws_ecs_task_definition.service"`. The native value wins on AWS, and the entry's `size` still counts on every other Deploy target, so the same file gives a Server `size`'s caps.

- **The size line names both.** It reads `pg-1 medium → db.r7g.xlarge (4 vCPU, 32 GB), set by native`. The CPU and memory are shown when Cloudgate's committed class table knows the class. A class not in the table is named alone, and AWS judges it at the Cloud run. If native sets only one half of a Fargate pair, the line marks that half: `medium → 2 vCPU (native) / 2 GB`.
- **The usual move warning applies.** A native class move still warns that the instance restarts, and a native node-type move still warns that connections may drop.
- **Taking it out never shrinks the machine to the smallest.** With a `size`, the machine falls back to the size's class, and the line reads `→ size (db.t4g.small)`. With no `size`, it stays where it is and is the console's again.
- **The Database page refuses a class or node type that the config sets natively**, and names the path that sets it.

### `native.gcp` applied on Cloud SQL and Memorystore: a `postgres` and a `redis`

On a Google Cloud Environment, the `native.gcp` block of a `postgres` on Cloud SQL and of a `redis` on Memorystore is now laid over what Cloudgate writes, planned, applied and run, by the same rules as a `web`'s. Cloud SQL's `settings` is merged one field at a time, so `settings.maintenance_window` or `settings.insights_config` keeps Cloudgate's machine, network and backups. Its `settings.database_flags` list replaces Cloudgate's whole list. Memorystore's `engine_configs` is merged one key at a time, so `"google_memorystore_instance.cache".engine_configs.maxmemory-policy: allkeys-lru` replaces Cloudgate's `noeviction` and keeps any other key. All of `settings.ip_configuration` stays locked.

- **Point-in-time recovery.** `settings.backup_configuration.point_in_time_recovery_enabled: false` turns it off on Cloud SQL. The plan marks the change with the two restarts Google makes. Taking the key out turns it back on.
- **Settings the console owned.** Cloud SQL's backup count on the Backups tab (`settings.backup_configuration.backup_retention_settings.retained_backups`), and Memorystore's high availability (`replica_count`) and backup days (`automated_backup_config.retention`) on the Database page, can now be set natively, and the native value wins. While the config sets one, the page refuses to change it and names the path that sets it. Applying the plan writes the value to the page too. If you take the key out, the value stays where it is and is the page's again, as on AWS.
- **A replace that would lose data is refused.** A native change that OpenTofu would carry out by replacing the Cloud SQL or Memorystore instance is refused, naming each native path, by the same rule as on AWS.
- **Stored with the Service.** As on a `web`: the plan compares the file against the block its last Apply saved, and every Cloud run applies the saved block. A stored block holding a value that has since been locked fails the run and names the value. A value only Google can judge fails the run and names the native path Google refused.

### `native.aws` applied on RDS and ElastiCache: a `postgres`, a `mysql` and a `redis`

On an AWS Environment, the `native.aws` block of a `postgres` or `mysql` on RDS and of a `redis` on ElastiCache is now laid over what Cloudgate writes, planned, applied and run, by the same rules as a `web`'s. For example, `"aws_elasticache_parameter_group.valkey8".parameter` sets the cache's `maxmemory-policy`. The parameter group is named by the family your `version` runs. Its `parameter` list replaces Cloudgate's whole list, which is `noeviction`.

- **Settings the console owned.** These were edited only on the cloud Database page: storage (`allocated_storage`), its ceiling (`max_allocated_storage`), Multi-AZ (`multi_az`) and backup days (`backup_retention_period`) on RDS, and the replica (`num_cache_clusters`, `automatic_failover_enabled`, `multi_az_enabled`) and snapshot days (`snapshot_retention_limit`) on ElastiCache. Each can now be set natively, and the native value wins. While the config sets one, the Database page refuses to change it and names the path that sets it. Applying the plan writes the value to the page too. If you take the key out, the value stays where it is and is the page's again. The plan line reads `50 → console (50)` and nothing is reset.
- **A replace that would lose data is refused.** A native change that OpenTofu would carry out by replacing the RDS instance or the replication group is refused, naming each native path. Cloudgate reads this from the cloud plan's own actions, so no setting needs to be listed in advance.
- **Stored with the Service.** As on a `web`: the plan compares the file against the block its last Apply saved. Every Cloud run, including a Delete's, applies the saved block. A stored block holding a value that has since been locked fails the run and names the value. A value only AWS can judge fails the run and names the native path AWS refused.

### `native.gcp` applied on Cloud Run: a `web`, including closing its `run.app` address

On a Google Cloud Environment, the `native.gcp` block of a `web` entry is now laid over what Cloudgate writes for the Service, planned, applied and deployed. For example, you can set the Cloud Run service's `template.max_instance_request_concurrency` and `template.timeout`, the container's `resources.cpu_idle: false`, `resources.startup_cpu_boost` and its probes, and the backend service's `security_policy`, `iap`, `log_config` and `timeout_sec`.

- **How values combine with Cloudgate's.** As on AWS: `template` is merged one field at a time, `annotations` one key at a time, and a real list such as `template.volumes` or the repository's `cleanup_policies` replaces Cloudgate's whole list. Cloudgate's own `lifecycle` settings stay, and every string is written exactly as you typed it.
- **The container.** `"google_cloud_run_v2_service.service".template.containers` is one object, merged into the Service's one container, which keeps its image, port and variables. A `liveness_probe` you add sits beside them.
- **Closing `run.app`.** `ingress: INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER` closes the Service's `run.app` address. The plan says `run.app address closes: only Domains and this Environment reach it`, and warns when the Service has no Domain, since nothing outside the Environment would then reach it. Once deployed, the Deployment log no longer says the Service answers at its `run.app` address, and the address is no longer shown as its generated Domain. Taking the line out opens the address again on the next deploy.
- **The plan, the stored block and Drift** work as on AWS: each value is its own native line in the file's spelling; applying saves the block with the Service, which every deploy and Drift check lays, so a hand change to an open setting reads as Drift against the merged definition; and a stored block holding a value since locked fails that Service's Deployment, naming it, with nothing changed in Google Cloud.

### `native.aws` applied on S3 and CloudFront: a `bucket` and a `static` site

On an AWS Environment, the `native.aws` block of a `bucket` or `static` entry is now laid over what Cloudgate writes, planned, applied and checked for Drift, the same way as a `web`'s. Each value is its own native line in the step, the block is saved with the bucket or site when the plan is applied, and every Cloud run and Drift check applies it.

- **A bucket.** Its encryption (`"aws_s3_bucket_server_side_encryption_configuration.bucket".rule`) is open. So is its CORS (`"aws_s3_bucket_cors_configuration.bucket".cors_rule`), while its page trusts a browser origin. The origins stay the page's: each rule you write gets them, and a rule that sets `allowed_origins` is refused. The bucket's name, `bucket_namespace` and `force_destroy` are locked. Block Public Access and the ownership controls are locked whole. So are the provider's inline twins of those settings on `aws_s3_bucket`: `policy`, `acl`, `grant` and `cors_rule`. `replication_configuration` is locked too, because it runs as an IAM role and copies every file to another bucket.
- **A static site.** On `"aws_cloudfront_distribution.site"`, `price_class`, `http_version` and the cache behavior are open, except the behavior's origin and function. The origin, `aliases`, `viewer_certificate` and `enabled` are locked. `custom_error_response` is locked while the config's `spa` is set, and is yours to write when `spa` is off. The Origin Access Control, the CloudFront function and the bucket policy are locked whole. The site's own bucket takes the same settings as a bucket's, apart from CORS.
- **A replace that would lose files is refused.** If OpenTofu would carry out a native change as a replace of the bucket, the plan's AWS read fails and names the path, such as `uploads.native.aws."aws_s3_bucket.bucket".<setting>: refused - OpenTofu would replace the bucket for it, losing every file in it`. Every setting the current provider replaces a bucket for (`object_lock_enabled`, the name) is already locked, so this guards against a provider release that adds one. Apply waits until the read succeeds. The same holds for a static site's own bucket.

### Every native setting is classed: more Google addresses, and settings locked by the existing rules

Every address Cloudgate generates and every provider argument a `native.aws` or `native.gcp` block may set is now classed as locked, with a reason, or open. A provider upgrade can no longer open a new argument by accident. What that turned up:

- **More addresses on Google Cloud.** A Worker may name its `google_cloud_run_v2_worker_pool.service`, with its container written as one object under `template.containers` as a `web`'s is, and its repository and account. A `bucket` may name `google_storage_bucket.bucket`, and a `static` site `google_storage_bucket.site` and `google_compute_backend_bucket.site`. Their grants, the bucket's own account and its key slots are locked whole. An Existing database's endpoint addresses are refused whole too. As on every kind but a `web`, nothing of their `native.gcp` is applied yet.
- **The Environment network's addresses** (`aws_lb.network`, `google_compute_url_map.network`, …) are refused with the reason: the Environment network has no native block.
- **Newly locked, by the rules the lock lists already follow:**
  - `tags` on every Google address, since IAM conditions and organization policies read them;
  - Cloud SQL's `settings.data_api_access`, which reaches the database from outside the Environment network, and its connector, replication and final-backup settings;
  - a worker pool's `scaling`, which Stop and Start own, and a Cloud Run service's `template.sandboxes`;
  - deletion protection and "what a destroy does" wherever AWS has them (the log group, task definition, ECS service, distribution and RDS automated backups);
  - an S3 bucket's inline encryption (`server_side_encryption_configuration`, the twin of its own resource), and its website, object lock, versioning and requester-pays settings, as on a Cloud Storage bucket (its other inline twins and its replication are under the S3 entry above);
  - RDS's directory and IAM logins, ElastiCache's other login, TLS, cluster-mode and network settings;
  - the ECS container's `privileged`, `repositoryCredentials`, `firelensConfiguration`, `environmentFiles`, `credentialSpecs` and the fields naming other containers.

`aws_service_discovery_service.service` stays locked whole. Everything else that was open stays open.

### A renamed cloud resource never breaks a `native.aws` or `native.gcp` block

The addresses that `native.aws` and `native.gcp` name, such as `"aws_ecs_service.service"`, are now a promise. Every address the cloud definitions generate, for each kind on each cloud, is in a committed list. If a later Cloudgate renames one, it also records the old name with its new one. A file that still uses the old address plans exactly as it would with the new one. The plan warns, naming both addresses, so you can update the file when you choose. A block that names both the old and the new address is refused, because they are the same resource. No address has been renamed so far.

### Swarm settings in the console on a described Service

On a Service the Project config describes, the console's Swarm settings page now treats the seven `native.docker` settings (`Labels`, `HealthCheck`, `RestartPolicy`, `UpdateConfig`, `RollbackConfig`, `StopGracePeriod` and `Ulimits`) as owned by the config:

- **Config kept by Cloudgate:** saving one of them rewrites the entry's `native.docker` in the stored config, only the settings you changed, and records the Save as an applied plan. A value set back to the kind's default is taken out of the file rather than written, so the file holds only what you chose. The next plan finds nothing to change.
- **Config kept in a repository:** saving one of them is refused, with a pointer to the file and branch where it is changed, as for every other setting the config owns. On the page those seven cards are turned off with the same pointer and are left out of the Save.
- Placement, networks, published ports, the service mode and the replica count stay editable in the console on every Service, and are never written to the file. A `managed: console` Service's Swarm settings save as before.

The locked values are still refused on every Save.

### `native.aws` applied on ECS: a `web`, a Worker, a Private web service and a Cron service

On an AWS Environment, the `native.aws` block of a `web`, `worker`, `web-private` or `cron` entry is now laid over what Cloudgate writes for the Service, planned, applied and deployed. For example, you can set the ECS service's `health_check_grace_period_seconds`, `enable_execute_command`, `deployment_maximum_percent`, `deployment_minimum_healthy_percent` and `deployment_circuit_breaker`.

- **How values combine with Cloudgate's.** A plain value replaces Cloudgate's. A block the provider allows once is merged one field at a time, so `"aws_lb_target_group.service".health_check.path` keeps Cloudgate's `matcher`. A map is merged one key at a time. A real list replaces Cloudgate's whole list. Cloudgate's own `lifecycle` settings stay. Every string is written exactly as you typed it, and a `${…}` in it is never read as a reference.
- **The container.** `"aws_ecs_task_definition.service".container_definitions` is one object in ECS's spelling, such as `healthCheck` and `stopTimeout`. It is merged into the Service's one container, which keeps its image, ports, secrets and log configuration.
- **The plan.** Each value is its own line in the Service's change, marked native, in the file's spelling: `native.aws."aws_ecs_service.service".health_check_grace_period_seconds: default (none) → 60`. If you take a key out, the line shows the Cloudgate default it returns to. The AWS lines read AWS with the native values in place, so Drift is a hand change measured against the merged definition.
- **Stored with the Service.** Applying a plan saves the block with the Service's settings. The next plan compares the file against that saved block, and every deploy, Domain change and Drift check applies it. A stored block holding a value that has since been locked fails that Service's Deployment and names the value, and nothing in AWS is changed. A value only AWS can judge, such as a grace period AWS rejects, fails the Deployment and names the native path AWS refused.

### Google Cloud settings in the Project config: `native.gcp`, checked on every plan

A described entry can now carry a `native.gcp` block beside `native.docker` and `native.aws`. It is keyed by the full OpenTofu address the plan's cloud lines show and holds that resource's provider arguments in the provider's own spelling. A `web` may name `google_artifact_registry_repository.service`, `google_service_account.service`, `google_cloud_run_v2_service.service`, `google_compute_region_network_endpoint_group.service` and `google_compute_backend_service.service`. A `web-private` may name the first three. A `postgres` may name `google_sql_database_instance.database`, `google_sql_database.database` and `google_sql_user.user`, and a `redis` may name `google_memorystore_instance.cache`. The Cloud Run container is `"google_cloud_run_v2_service.service".template.containers`, written as one object. `version` stays `1`.

Every plan checks the block, on every Deploy target, with the same check `native.aws` uses. So a typo shows on a Docker or AWS plan rather than on the first deploy to Google Cloud. Each address is checked against the committed schema of the pinned `hashicorp/google` provider. You never write the provider. A refusal names the full path and a reason. These are refused:

- an address the entry's kind does not make, and every address of an Existing database;
- the per-variable secret addresses and the per-Domain certificate addresses, whole;
- every OpenTofu meta-argument;
- an argument the pinned provider does not have, naming the provider version Cloudgate runs, and a value of the wrong type;
- a locked setting. The location, region, project, `labels` (and Cloud SQL's `user_labels`), and the `description` that carries Cloudgate's mark are locked on every address. So are all deletion protection, everything Cloudgate keeps in its own `ignore_changes` or sets outside the plan, `invoker_iam_disabled`, `default_uri_disabled`, and the backend service's `enable_cdn` and `cdn_policy`. The service account, the serverless NEG, the Cloud SQL database and the Cloud SQL user are locked whole.
- a Cloud Run `ingress` that widens reach. A `web` may keep `INGRESS_TRAFFIC_ALL` or set `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`, which closes its `run.app` address while its Domains still answer. A `web-private` stays `INGRESS_TRAFFIC_INTERNAL_ONLY`.

Every other argument is open, including Cloud SQL's `settings.tier`, `database_flags` and `backup_configuration`, Memorystore's `node_type`, `replica_count` and `engine_configs`, and the Cloud Run container's `resources` and probes. On a Server or AWS the block is only checked. What Google Cloud does with a `web`'s block is under "`native.gcp` applied on Cloud Run" above; on every other kind a valid block still plans no change.

### AWS settings in the Project config: `native.aws`, checked on every plan

A described entry can now carry a `native.aws` block beside `native.docker`. It is keyed by the full OpenTofu address the plan's cloud lines show, such as `"aws_ecs_service.service"` or `"aws_db_instance.database"`, and holds that resource's `hashicorp/aws` arguments in the provider's own spelling. The ECS container is `"aws_ecs_task_definition.service".container_definitions`, written as one object in ECS's camelCase. `version` stays `1`.

Every plan checks the block, on every Deploy target, so a typo shows on a Docker staging plan rather than on the first deploy to AWS. The check uses the provider schema and ECS container fields committed with Cloudgate, so it needs no network. A refusal names the full path and a reason, for example `api.native.aws."aws_db_instance.database".publicly_accessible: refused - locked: …`. These are refused:

- an address the entry's kind does not make, or does not make right now (`aws_iam_role_policy.buckets` with no bucket linked);
- the per-Domain and per-variable addresses, whole;
- every OpenTofu meta-argument (`lifecycle`, `depends_on`, `count`, `for_each`, `provider`, `provisioner`, `connection`);
- an argument the pinned provider does not have, naming the provider version Cloudgate runs, and a value of the wrong type;
- a key in the container object that ECS does not have, which the provider would otherwise drop without a word;
- a locked setting. `tags` and `region` are locked on every address, and the rest follow one AWS lock list. `aws_service_discovery_service.service` (a `web-private`'s) is locked whole for now.

A deprecated argument is planned with a warning that names its path. On a Server or Google Cloud the block is only checked; what AWS does with it is in the next section.

### Swarm settings in the Project config: `native.docker`

A described entry in the Project config can now carry a `native.docker` block that holds its Swarm settings on a Server: `Labels`, `HealthCheck`, `RestartPolicy`, `UpdateConfig`, `RollbackConfig`, `StopGracePeriod` and `Ulimits`. Keys and values are written exactly as the Docker Engine API takes them, with durations in nanoseconds, so you can paste a value from `docker service inspect` without changing it. Each value is laid over Cloudgate's defaults for the kind one field at a time. For example, setting only `UpdateConfig.Delay` keeps `FailureAction: rollback` on an Application and `stop-first` on a database. The block works on `web`, `web-private`, `worker`, `static`, `postgres`, `mysql` and `redis` entries. A `cron` and a `bucket` take only some of the seven, as the next section says. `version` stays `1`.

Every plan checks the block on every Deploy target. A key outside the seven, a key that is never allowed (`Privileged`, `CapAdd`, `Mounts`, `Networks`, `EndpointSpec`, `Mode`, `Placement`, `Resources`), any CPU or memory setting (use `size` for those) and any locked value are refused. The refusal names the full path and gives a reason, for example `api.native.docker.Labels."traefik.http.routers.x": refused - …`. Each change shows as its own line under the Service's change, marked native. Applying it writes the Service's Swarm settings, and the next Deployment runs them.

**Before you upgrade, check described Services that have custom Swarm settings.** The config now owns these seven settings whether or not the block is written. A key that is left out means Cloudgate's default for the kind, not the value that was saved. So if a described Service has non-default Swarm settings saved and its entry has no `native.docker` block, its next plan shows each setting going back to its default (`→ default (none)`), and applying that plan resets them. Before you apply that first plan, run the Generator to write your current values into `native.docker`. If you can't, copy them from the Service's Swarm settings into the block by hand. Placement, networks, published ports, the service mode and the replica count are still managed only in the console.

### The Generator writes Swarm settings into `native.docker`

A generated Project config now carries each Service's Swarm settings, so its first plan still changes nothing. When every Environment saves the same value for one of the seven settings, the Generator writes it under `native.docker`, in Docker's spelling. It writes only what differs from Cloudgate's default for the kind, so a Service with only default Swarm settings gets no `native` block. When the Environments save different values for one of the seven, the Service is listed `managed: console`, with a comment naming the setting, for example `RestartPolicy`. The Generator never picks one Environment's value. A saved value that the plan would refuse, such as a database saved `start-first`, also keeps the Service `managed: console`, with the refusal in the comment. Placement, networks, published ports, the service mode and the replica count are never written.

### `native.docker` on a Cron service and a bucket

A `cron` entry's `native.docker` takes `Labels`, `StopGracePeriod` and `Ulimits`. Applying a plan writes them to the Cron service, and each run that starts after that gets them. A run already going keeps the settings it started with. `StopGracePeriod` is how long a run has to clean up when Cancel, Stop, its `timeout` or a Delete stops it. A `bucket` entry's `native.docker` takes `Labels` only. Applying a change to them redeploys the bucket's Garage on its Server with the new labels. Labels on both follow the same locked namespaces as every other Service (`traefik.*`, `com.docker.*`, `io.cloudgate.*`).

Every other key is refused by its full path, with the reason:

- **On a `cron`:** `HealthCheck`, because a run is judged by its exit code; `RestartPolicy`, because a run is never retried; `UpdateConfig` and `RollbackConfig`, because a run is a one-off job with no copies to update or roll back.
- **On a `bucket`:** `HealthCheck`, `RestartPolicy`, `UpdateConfig`, `RollbackConfig`, `StopGracePeriod` and `Ulimits`. Garage is Cloudgate's pinned image, and Cloudgate keeps how it starts, stops, updates and restarts, so that every Service linking the bucket can reach it and its files stay intact.

The console's Swarm settings save refuses the same four keys for a Cron service, and a run fails before it starts if the Cron service's saved Swarm settings still hold one of them. The error names the setting and its value. Cloudgate does not strip it. **Before you upgrade, check your Cron services' Swarm settings.** If one has a health check, a restart policy, an update config or a rollback config saved, clear it, or that Cron service's runs will fail.

Only the keys a kind takes are the config's. On a Cron service a repository-kept config describes, the console's Swarm settings page turns off `Labels`, the stop grace period and `Ulimits` with the pointer to the file, and leaves the other four editable. On a Cloudgate-kept config, saving one of those three rewrites the entry's `native.docker`. The Generator writes a Cron service's three and a Server bucket's `Labels`, and never a key the kind refuses.

### Swarm settings: the locked values

A Service's Swarm settings now follow one list of locked values, which the console's save and the deploy both read:

- **Labels** in `traefik.*` and `com.docker.*` are still refused. Labels in `io.cloudgate.*` are now refused too, because that namespace is kept for marks Cloudgate writes itself.
- **A database** (Postgres, MySQL, MariaDB, MongoDB, Redis, libSQL) must update and roll back `stop-first`.
- **Restart condition** must be `none`, `on-failure` or `any`. **Update and rollback order** must be `stop-first` or `start-first`. **Failure action** must be `pause`, `continue` or `rollback`.

Cloudgate does not strip or rewrite a value that breaks this list. A Service that already has one saved will fail its next Deployment, and the error names the setting and the value. Change it in the Service's Swarm settings and deploy again.

### Agents and the MCP endpoint

An Organization can now have **Agents**: members an AI tool acts as, each with a role (Reader or Operator), grants to the Projects, Environments and Services it may reach, and its own **agent keys**. An Agent connects to the MCP endpoint at your console's address followed by `/mcp`, with `Authorization: Bearer <agent key>`, and every call it makes is a row in the audit log, allowed or refused. Create one in the Agents section of Settings; its Connect panel has the configuration for each supported client.

The endpoint's limits — the rate budgets, coalescing, the build queue, what the mask cannot hide, the protocol revisions, the deadline, the log window and the `Origin` refusal — are in `docs/connecting-an-agent.md`.

### I have a script that uses an API key today. What do I do?

**Nothing, if the script calls Cloudgate's API.** Your key is now called a *personal key*. It keeps working exactly as before: same authority, same expiry, no rate limit. Two things changed around it:

- **A key can no longer manage keys.** Creating, listing or deleting keys now needs a signed-in session in the console. If your script minted or rotated keys using a key, do that step in the console instead. This is what makes deleting a key actually revoke it.
- **New keys expire in 90 days by default.** Choose *Never* explicitly if a job needs it. Existing keys are unchanged.

**If the "script" is an AI agent**, don't give it a personal key: it would act as you with everything you can do. Create an **Agent** in the Organization, give it a role, and point the agent at the MCP endpoint with an agent key. A personal key is refused there.
