# Deploying Cloudgate on a server

Cloudgate installs **natively** on one Ubuntu 24.04 host: Node processes under systemd, Postgres on the box, Docker and a Swarm of one, and a Traefik container it owns. There is no Dockerfile for Cloudgate itself and no compose file — it deploys containers, it does not ship as one.

What broke on a real install is written down here as well as what worked: see [Known broken on a native install](#5-known-broken-on-a-native-install) and [Traps that cost real time](#9-traps-that-cost-real-time).

---

## 1. What you need

| | |
|---|---|
| Host | Ubuntu 24.04, **2 vCPU / 4 GB / 40 GB** is enough and was what this was proved on |
| Access | root over SSH |
| Ports open inbound | 22, 80, 443, 3000, 4000 |
| DNS | none required — `sslip.io` resolves `<name>.<ip>.sslip.io` to `<ip>`, which is how deployed apps were reached |
| Outbound | `get.docker.com`, `nodejs.org`, the npm registry, Docker Hub, `api.github.com` (which Cloudgate version is the latest), `github.com` (the Cloudgate version itself, the OpenTofu and provider releases, [§7](#opentofu-and-the-providers), and the Template catalogue, [below](#the-template-catalogue)), and GitHub's release-download host, `release-assets.githubusercontent.com`, which a release download redirects to |

Check the host has no cloud firewall in front of it before you start. A provider-level block on 3000/4000 looks exactly like a broken install:

```bash
python3 -m http.server 3000 &   # then curl http://<host>:3000/ from your laptop
```

## 2. Install

One command, as root, on the host:

```bash
curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh | sudo sh
```

That is the repository's root `install.sh`. It installs a **Cloudgate version** (ADR-0082): one
tested version of Cloudgate, `vX.Y.Z`, published as a prebuilt tarball on the GitHub Release for
its tag once its E2E run was green. Nothing is cloned and nothing is built on the host. The script:

1. checks the host is Ubuntu 24.04 on amd64;
2. finds the version: the one `CLOUDGATE_VERSION` names, or else the latest one published (the
   highest `vX.Y.Z` among the repository's releases; the CLI's `cli-v*` releases are never one);
3. downloads `cloudgate-<X.Y.Z>-linux-amd64.tar.gz` and its `.sha256`, and stops, having changed
   nothing, when the download does not match the published checksum or the version has no release;
4. unpacks it into `/opt/cloudgate.next` and hands over to that version's `deploy/install.sh`,
   which does the install and puts the version in place at `/opt/cloudgate` just before it
   migrates the database and restarts both units.

To install a particular version, name it through `sudo` (`v0.3.0` and `0.3.0` both work):

```bash
curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh \
  | sudo CLOUDGATE_VERSION=v0.3.0 sh
```

The public host is, in order: `CLOUDGATE_PUBLIC_HOST` if you set it, the one the last install on
this host was given, and on a first install the host's public IPv4 address as `api.ipify.org`
sees it. To name it:

```bash
curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh \
  | sudo CLOUDGATE_PUBLIC_HOST=<public ip or hostname> sh
```

Every other variable in the environment, `HOSTED_MODE` and its inputs included, reaches
`deploy/install.sh` as it was. `CLOUDGATE_REF` is refused: the install never installs a branch.
`API_PORT` must stay 4000, because a version's console was built to reach its API there; the
install refuses any other value before it changes anything.

The same install by hand, which is all the one command does:

```bash
cd /root
curl -fsSLO https://github.com/octabyte-io/cloudgate/releases/download/v0.3.0/cloudgate-0.3.0-linux-amd64.tar.gz
curl -fsSLO https://github.com/octabyte-io/cloudgate/releases/download/v0.3.0/cloudgate-0.3.0-linux-amd64.tar.gz.sha256
sha256sum -c cloudgate-0.3.0-linux-amd64.tar.gz.sha256
mkdir /opt/cloudgate.next
tar -xzf cloudgate-0.3.0-linux-amd64.tar.gz -C /opt/cloudgate.next --no-same-owner
CLOUDGATE_PUBLIC_HOST=<public ip or hostname> bash /opt/cloudgate.next/deploy/install.sh
```

The tarball has no directory of its own around it: unpack it into an empty one. The version ends
up at `/opt/cloudgate` wherever it was unpacked — the unit files in `deploy/systemd/` hardcode that
path — and `deploy/install.sh` refuses to run from anything that is not a Cloudgate version (it
has a `VERSION` file at its top). A host whose `/opt/cloudgate` is still a git checkout, from an
install made before versions were published, is switched over: the checkout is moved aside and kept
([§7](#7-upgrades)). Anything else already at `/opt/cloudgate` is refused, with nothing changed.

`CLOUDGATE_PUBLIC_HOST` is the only required input. It becomes the API address both env files carry (`CLOUDGATE_API_URL`), which the console reads when it starts; changing it later is an edit to those files and a restart ([§3](#3-why-the-console-and-the-api-share-one-hostname)).

`deploy/install.sh` is one file, and it does the whole thing: base packages, Node from `nodejs.org` (checksum-verified), Docker, `swarm init`, the `cloudgate-network` overlay, Postgres with a generated role, nixpacks, OpenTofu and its providers, the Session Manager plugin, the `cloudgate` service user, `/etc/cloudgate`, the env files, the version put in place, migrations, `traefik.yml`, the Traefik container, two systemd units, and ufw. It needs no `build-essential`, no `python3`, no pnpm and no swap file: the version arrives with the backend and console built and node-pty compiled.

**It takes no subcommands.** `install.sh install` and `install.sh update` do not exist — it is one idempotent script, and re-running it is the update path (see [Upgrades](#7-upgrades)).

### What it prints

Progress as `==> Downloading Cloudgate 0.3.0`, `==> Docker`, `==> Cloudgate 0.3.0`, `==> Database migrations` and so on, then a verification block. This is what a good install ends with:

```
==> Verification
{"status":"ok"}
{"open":true}
console /sign-up: 200
traefik  :80    : 404  (404 = listening)
swarm: active
network: overlay attachable=true
traefik: true traefik:v3.6.7

==> Done. Open http://<host>:3000/sign-up — the first account owns the instance.
Secrets are in /etc/default/cloudgate-secrets (mode 0600); the same three are also in
/etc/default/cloudgate-backend. Back up both — docs/deploy.md §8. Without
APP_ENCRYPTION_SECRET every encrypted column is permanently unreadable.
```

`404` from Traefik on port 80 is the success case: it is listening and has no route for a bare IP yet.

### Claim the instance

Open `http://<host>:3000/sign-up`. **The first account created owns the instance**, and sign-up closes behind it — `GET /auth/sign-up-open` flips to `{"open":false}` and stays there. Everyone after that arrives by invitation.

With no `MAIL_PROVIDER` configured nothing is emailed. Invitations are still usable: the Members screen gives you a copyable `/accept-invitation/<id>` link to send by hand.

### Register the host as a Server

Cloudgate can deploy to the machine it runs on, but the Servers screen is where SSH keys, the setup script, Docker/Swarm inspection and the terminal live. Add the host as a Server pointing at its own address, with an SSH key Cloudgate generates. Re-running the setup script against an already-provisioned host is safe — it was run three times and stayed byte-identical, same Traefik container id and start time.

Two things to know:

- Services deployed to "this host" carry `serverId: null`, not the Server's id. The Server row is an inventory record, not the deploy target.
- The audit reports `isDockerGroupMember: false` and that is **correct**, not a failure: the backend runs as root and reaches the Docker socket by being root.

### Building from source, for developers

The install only installs a published Cloudgate version. To run a branch or an unreleased fix on
a host, build a version tarball from it yourself and install that by hand. Build on an Ubuntu
24.04 amd64 machine with Node 24.19.0 (the one `deploy/install.sh` installs) and pnpm, in a fresh
clone made for it: `deploy/version-tarball.sh` replaces every `node_modules` in the tree.

```bash
sudo apt-get install -y build-essential python3   # node-pty compiles from source
git clone --branch <branch> https://github.com/octabyte-io/cloudgate.git cloudgate-build
cd cloudgate-build && corepack enable
bash deploy/version-tarball.sh ../out
```

It runs `pnpm install`, both builds and a production `node_modules` with node-pty compiled, and
writes `cloudgate-<version>-linux-amd64.tar.gz` and its `.sha256` to `../out`, `<version>` being
`backend/package.json`'s. Copy both to the host and install them as in the by-hand install above.
The console it builds reaches its API at `127.0.0.1:4000`; for another `API_PORT`, change
`BACKEND_INTERNAL_ORIGIN` in `deploy/version-tarball.sh` and the refusal in `deploy/install.sh`
together. The traps of building:

- **`pnpm install`, never `--prod`, never `--ignore-scripts`, for the build.** `--prod` omits `@nestjs/cli` and `next`, and `--ignore-scripts` skips the node-pty compile. The script installs the production tree afresh after building, for exactly that reason.
- **node-pty has no Linux prebuild** and compiles with node-gyp, so `build-essential` and `python3` are required where you build. The script refuses to pack without `pty.node`. (Do not check for `spawn-helper`: that target only exists on macOS.)
- ## 3. Why the console and the API share one hostname

**They must.** This is the single most important configuration fact on the page, and getting it wrong produces a console that signs you in, serves REST perfectly, and then shows a dead screen wherever anything is live.

Cloudgate has six WebSocket gateways — deployment logs, container logs, container terminal, host terminal, server setup, and docker stats. A browser **cannot set headers on a WebSocket**, so those six authenticate by **cookie alone**. The session cookie is host-only: `useSecureCookies: false` and no `domain` attribute. Cookies ignore the port but not the host.

So:

- `http://<host>:3000` (console) and `http://<host>:4000` (API) — **one host, two ports.** The cookie set by the API is sent on the WebSocket dialled at `ws://<host>:4000`. All six gateways carry frames. Verified: all six, in a real browser, cross-origin, cookie-only.
- `console.example.com` and `api.example.com` — **two hosts.** Once the backend trusts the console's origin (a stock install does not — see [below](#a-console-domain-is-a-second-hostname-and-a-stock-install-refuses-sign-in-on-it)), sign-in works and REST works. Every live feed opens and closes silently, and nothing on screen tells you why.

`CLOUDGATE_API_URL` in `/etc/default/cloudgate-console` is what sets this. The console reads it **when it starts**, not when it is built, and hands it to every page (ADR-0082): one build serves any address, and changing it is a restart:

```bash
systemctl restart cloudgate-console
```

A console with no `CLOUDGATE_API_URL`, or one that does not start with `http://` or `https://`, does not start at all: `journalctl -u cloudgate-console` shows a sentence naming the variable. It used to fall back to `http://localhost:4000`, which made every operator's browser dial its own machine.

The Cloudgate CLI needs the same origin for its log streams, so the backend advertises it too: `CLOUDGATE_API_URL` in `/etc/default/cloudgate-backend`, which the install script writes with the same value, is what the public `GET /settings/about` answers as `apiUrl`. Move the API and you change both files and restart both units.

### A console domain is a second hostname, and a stock install refuses sign-in on it

Settings → Instance → **Console domain** writes the console's routers into `dynamic/cloudgate.yml`, and with Let's Encrypt Traefik has a real certificate within seconds — so `https://console.example.com` answers. **Every sign-in there is then refused `403 INVALID_ORIGIN`**. better-auth lets a browser in only from an origin it trusts: `BETTER_AUTH_URL`'s own, the ones `TRUSTED_ORIGINS` names, and the ones an owner has added under **Trusted origins** — and the installer leaves `TRUSTED_ORIGINS` empty on purpose. The Console domain card says this before the save, and the **Console routing** card under it says whether the saved domain's origin is trusted yet; the backend works that out from the same three lists the refusal uses.

Two separate things stand between that hostname and a working console:

1. **Trust its origin** — scheme and host, as the browser sends it (`https://console.example.com`). Either under Settings → Single sign-on → **Trusted origins**, from the address the console already works on, which takes effect at once and needs an enterprise licence; or, without one, in `TRUSTED_ORIGINS` in `/etc/default/cloudgate-backend`, followed by `systemctl restart cloudgate-backend`. Sign-in and every ordinary screen then work there.
2. **The live screens need the API on the same hostname**, for the cookie reason above: set `CLOUDGATE_API_URL` in `/etc/default/cloudgate-console` to an API address on it and `systemctl restart cloudgate-console`; no rebuild is needed. The routers the Console domain card writes send the hostname to the console only; nothing routes the API there, so on a stock install the live screens stay blank on the console domain even once sign-in works.

Cloudgate does not trust the console domain on save, and that is the installer's reasoning rather than an omission: doing the first without the second is exactly "a console that signs you in and then shows no logs", and the backend cannot see whether you have done the second.

**The console is a proxy in front of the API, whether or not you think of it as one.** `/api/auth/*` and `/backend/*` are Next *rewrites*, and a rewrite to an external destination is a server-side proxy: the browser never opens a socket to the API for those paths, this process does. That is why the install ships `TRUST_PROXY=loopback` and why the console forwards the browser's address in `x-forwarded-for` — without both, every console user's session records the host's own address and they all share one sign-in rate-limit budget. The console reaches the API over loopback (`BACKEND_INTERNAL_ORIGIN`), so that traffic never touches the public interface. If you put a reverse proxy in front of the console, route `/api/auth/*` and `/backend/*` at the API directly rather than through the console: the console **replaces** whatever chain it receives with its own peer, which on the topology above is the correct rule and behind another proxy would overwrite that proxy's chain with its address. The Hosted instance is the one exception the install sets up itself: Traefik is in front there, so `HOSTED_MODE=true` writes `CONSOLE_TRUSTED_PROXY` (the docker_gwbridge subnet Traefik reaches the console from) into `/etc/default/cloudgate-console`, and a request from inside that range keeps the single address Traefik appended; anything else is still replaced.

### If you will not accept a plaintext session cookie

Both ports are plain HTTP, so on a public address the session cookie crosses the internet in clear. The install does not fix this — see [Security posture](#4-security-posture-read-this-before-a-public-address). The way to run it safely without changing anything is to **not publish 3000 and 4000 at all**, and reach them through an SSH tunnel:

```bash
# on the host: bind the two units to loopback, and drop the ufw rules
ufw delete allow 3000
ufw delete allow 4000

# from your laptop, one tunnel, both ports — note they must be the SAME
# local hostname, for exactly the cookie reason above
ssh -N -L 3000:127.0.0.1:3000 -L 4000:127.0.0.1:4000 root@<host>
```

Then browse `http://localhost:3000`, and install with `CLOUDGATE_PUBLIC_HOST=localhost`. One hostname (`localhost`), two ports, cookie carried, all six gateways working — and nothing on the wire. Ports 80 and 443 stay published, because that is where the applications you deploy are served.

The alternative — a TLS-terminating reverse proxy in front of both ports on one hostname — also works and is more convenient for a team, but it is not part of the verified install and Cloudgate's own Traefik cannot do it for you (see the [Traefik contract](#6-the-traefik-contract)).

---

## 4. Security posture, read this before a public address

Three facts, plainly. None is a misconfiguration you can correct in the install; all three are properties of what is being installed.

**The session cookie is not `Secure` and crosses the internet in clear.** Both the console and the API are plain HTTP. Anyone on the path has the session. Use the SSH tunnel above, or a private network, or accept it knowingly.

**The backend runs as root, and root is the honest choice.** It shells out to `docker`, `git`, `ssh`, `nixpacks`, `rclone` and `tail`, writes `/etc/cloudgate`, and forks ptys. A service user in the `docker` group would gain nothing — **membership of the `docker` group is equivalent to root**, because you can mount the host filesystem into a container you control. Running as a non-root user in the `docker` group is the same power with more `EACCES` on container-written files.

**The firewall the install turns on does not cover anything Cloudgate publishes later.** The last thing `install.sh` does before it verifies is enable ufw with OpenSSH, 80, 443, 3000 and 4000 allowed and Swarm's cluster ports denied, which reads as a backstop for every other port on the box. It is not one. ufw is not in the path of a Docker publish: Docker writes its own `iptables` rules and they are evaluated first, so a container port Docker publishes is reachable from the internet while `ufw status` still shows the port is not allowed. That is not a theory about the ruleset — on the verified run a Postgres service was given `externalPort: 5433` from the console and, from a laptop across the internet, `nc -z <host> 5433` connected and an authenticated `psql -h <host> -p 5433` query returned, while `ufw status` listed nothing for 5433 and `ss -ltn` on the host reported `0.0.0.0:5433` and `[::]:5433`. What the console tells you when you set that field is the accurate account: Cloudgate adds no allowlist and no firewall rule, and the password is the only protection. ufw does not quietly supply the missing one.

So giving a database an external port is a decision to put it on the internet, and it has to be made on those terms. If one genuinely must be reachable from off the host, the restriction has to go somewhere Docker's rules do not precede: the `DOCKER-USER` chain, which Docker consults before its own published-port rules and never rewrites,

```bash
# reachable from one address; everything else is dropped before Docker's rules run
iptables -I DOCKER-USER -p tcp --dport 5433 '!' -s 203.0.113.7 -j DROP
```

or a firewall in front of the box entirely — the provider-level one from [What you need](#1-what-you-need), which is upstream of every rule on the host and is the only one of the two that survives a reboot without `iptables-persistent`. The third option, and the one the run took, is to publish nothing: leave the external port empty and reach the database through the host, over Cloudgate's own container terminal or `docker exec` on an SSH session. Removing the port was proved to close it — nothing listening, refused from the laptop. Neither firewall remedy was exercised on that run.

One that **was** true and is worth knowing anyway, because it decided where the secrets live: any authenticated member could read any file under `/etc/cloudgate`, the local SSH private key included. The `/listen-deployment` gateway took a caller-supplied `logPath` and tailed it with no entitlement check; on the verified run the whole 3 389-byte private key arrived in one frame, 38 ms after the socket opened, to a caller with no entitlement to it. The socket is now addressed by deployment id and authorized through the same per-service check the HTTP log read uses, so the only file it will open is one a deployment row the caller is entitled to points at (ADR-0007).

That finding is still why **`/etc/default/cloudgate-backend` is not under `CLOUDGATE_DIRECTORY`.** It holds the database password, `BETTER_AUTH_SECRET` and `APP_ENCRYPTION_SECRET`, and the argument for keeping them out of the platform directory does not depend on that one socket: it is where every path-taking read, present and future, is aimed. Keep it at `/etc/default/`, mode 0600.

Two more that the verified run found in the journal, **both since closed**, and worth knowing because they are the reason to keep treating it carefully:

- Every request's headers were written to the journal, so `x-api-key` **and the session cookie** were in it in clear, on every request. Those three headers are now redacted; every other header still reads.
- Every backup, restore and prune passed the destination's secret access key in `argv`, so a failure wrote it to the journal. Credentials now reach rclone through the environment, and a failure that echoes one is masked before it is logged.

`journalctl -u cloudgate-backend` is no longer a credential store by construction, but it is still the place every diagnostic ends up. Treat it as sensitive.

---

## 5. Known broken on a native install

Every item the verified run found here has since been fixed. The table records what was wrong, what
the fix was, and — where it matters — what the fix does *not* reach, because two of them only take
effect on a host provisioned after the fix.

| What | What was wrong, and where it stands |
|---|---|
| **The local Server's terminal** | `serverId=local` resolved the *default gateway* — the datacentre router, not this host — and timed out, because `getDockerHost()` assumed the backend runs in a container. It now asks whether this process is actually containerised and answers the loopback address when it is not, and the fleet screen offers the shell rather than leaving it reachable only from a hand-built URL. **Read [ADR-0010](adr/0010-host-shell-authorizes-by-organization-role.md) before you hand anyone an account**: fixing this turned up that the branch authenticated and gated on nothing else, so any signed-in member of any organization could take a root shell on this host. It now requires owner or admin. |
| **`letsencrypt` certificates** | `traefik.yml` defined no ACME resolver, so Traefik fell back to a self-signed certificate and served the app anyway — a working HTTPS URL every browser refuses, with the only statement of the cause in a container log. All three provisioning paths now write the resolver. **Only on a host provisioned after this fix**: the guard skips when `traefik.yml` already exists. **Verified end to end on a reinstalled host** — Let's Encrypt issued a real certificate for an `sslip.io` hostname (`acme.json` 0 B → 15,996 B, account status `valid`, issuer `CN = YR1`, 90-day validity) and `curl https://…` answers 200 **without `-k`**. Note what that run could *not* read: `docker logs cloudgate-traefik` showed the attempt nowhere, because the shipped `traefik.yml` configured `accessLog` and no `log:` section at all, so Traefik 3 stayed at its default `ERROR` level and a healthy instance was 0 bytes. All three provisioning paths now write `log: level: INFO` — again **only on a host provisioned after the fix**; [section 6](#6-the-traefik-contract) has the one-time edit for an existing one. |
| **HTTPS domains on plain HTTP** | Every HTTPS domain named a `redirect-to-https` middleware that nothing defined, so Traefik dropped the router and `http://` 404'd instead of redirecting. All three paths now write `dynamic/middlewares.yml` defining it. This one **does** repair an existing host on a re-run, because its guard is its own file. |
| **The Requests screen** | `traefik.yml` configured no `accessLog`, so `/requests` was permanently empty. Provisioning now writes the block — at the one moment doing so restarts nothing, since it runs before Traefik starts. **Only on a host provisioned after this fix**; on an existing one, use the screen's own **Turn on request logging** button, which still costs a Traefik restart. |
| **Settings → Console domain** | Wrote `dynamic/cloudgate.yml` pointing at `http://cloudgate:4000` — a container a native install does not have, on the API port rather than the console's — so the assigned hostname 502'd. The upstream is now resolved from `CLOUDGATE_CONSOLE_URL`, then `CLOUDGATE_PUBLIC_HOST` + `CONSOLE_PORT`, then `BETTER_AUTH_URL` (which the installer already writes). |
| **Settings → the instance's two restart controls** | The update check queried an image that was never published, and swallowed the 404 so a missing repository and "you are current" were the same answer — it reported "Nothing newer was found". It now names the failure. What that leaves on this install is worth stating exactly, because the row used to claim more than holds: **Update and restart** is *withheld* here rather than pressed — a check that did not complete leaves nothing to update to, so the console turns the button off and prints that sentence as the reason beside it, and `POST /settings/update-server` answers 503 to anyone who calls it directly. **Restart Cloudgate** used to 500 with `Resource type not found` and advise trying again; it now refuses with a 409 that names the install — no Docker service or container here, restart `cloudgate-backend` and `cloudgate-console` with systemctl — and the danger zone says the same thing before you press it. **Self-updating a native install is still out of scope**: use [Upgrades](#7-upgrades). |
| **Creating an Application in the console** | There was no create flow; Applications had to be created with `POST /applications`. The Environment's Services panel now offers **Add an Application** alongside the other three. |
| **Deleting a Server** | Every service row's `serverId` was `onDelete: cascade`, so removing a machine from the inventory silently deleted Cloudgate's record of every Application, Compose stack and database on it while the containers kept running. The delete now refuses with a 409 naming them. A tie held only as `buildServerId` still deletes — that one is `set null`, so it is not data loss. |
| **Restoring a volume into a compose stack** | The restore refuses while any container still references the volume — Docker counts an exited one, and `docker volume rm` refuses regardless of `--force` — and the instructions it printed said to stop the service. For a `docker-compose` stack Stop runs `docker compose stop`, which leaves the containers `Exited` and still holding the volume, so the refusal survived the Stop button and the only control that removed them was Delete, which destroys the stack's Cloudgate record with them. Completing a restore needed a shell on the host. That stack type now has a third lifecycle action, **Remove containers**, between Stop and Delete: `docker compose rm --stop --force`, which leaves the project network, the project directory, the volumes and the Cloudgate row intact, so the round trip is Remove containers → restore → Start. The refusal names that control instead of "stop all containers/services". Applications and Swarm stacks do not need that action, though an Application's Stop is not the whole answer either: Swarm keeps the exited task containers of a service scaled to zero, each still referencing the volume, so the restore removes those itself once the service runs no replica, and refuses on any other container, naming whose it is. See [ADR-0011](adr/0011-remove-containers-is-a-third-lifecycle-rung.md). |

One thing on that list is still true and is not a bug: **ufw does not filter a published container port** — see [section 4](#4-security-posture-read-this-before-a-public-address).

The full list was `.project/vps-deploy/FINDINGS.md` (in git history at `c8e9bdfb`) — 40 findings, and the wave that closed them made **46** fixes. Every one of those fixes was then re-verified on a real box; the per-issue verdict and what the verification run itself found are under `.project/vps-verify/`, in git history at `c8e9bdfb`.

**Never press these**, on a host you care about:

- `/settings/maintenance` → **Prune everything** and **Run every cleanup**
- `/settings/instance` → **Update and restart**, **Restart Cloudgate**, **Empty the build queue**
- `DELETE /cluster/nodes/{nodeId}` — on a single-node install that is the only Swarm node, and removing it destroys everything on the box

---

## 6. The Traefik contract

Cloudgate owns three things on the host. Nothing else may take them.

1. **The container `cloudgate-traefik`**, on the `cloudgate-network` overlay.
2. **Ports 80 and 443** (TCP and UDP 443 for HTTP/3). If anything else is listening there, deployed applications have nowhere to be served.
3. **The directory `/etc/cloudgate/traefik/dynamic`**, which Traefik watches.

The static configuration is `/etc/cloudgate/traefik/traefik.yml`. It is **byte-identical to what the product's own `createTraefikConfig()` writes, plus the `accessLog:` block at the end**, deliberately: registering the host as a Server runs that script, which skips the file when it already exists. Keep them identical, or whichever ran first silently wins. The one difference is ADR-0027's: a remote Server is provisioned with its access log off, because the Requests screen reads the platform host's log and nothing reads a remote one. `dynamic/middlewares.yml` — which defines the `redirect-to-https` every HTTPS domain names — is the second such file, written by the same three paths and pinned by the same test (`backend/test/servers/server-setup.spec.ts`).

Write `traefik.yml` **before** starting the container. Start the container first and Docker creates a *directory* at the bind-mount source, after which Traefik fails on config and every retry fails identically until you delete a directory you did not know you had made.

**A hand-written dynamic file must not be called `cloudgate.yml`.** That name belongs to the console-domain feature, and clearing the console domain deletes the file — yours included.

Two ways a domain reaches an application, and they behave differently:

- **Applications** get a file in `dynamic/`, rewritten in the same request that saves the domain. Traefik's file provider watches that directory, so the host starts or stops being served within a second. The Domains screens used to say it waited for the next Deployment; they now say what happens.
- **Docker Compose stacks** are routed by **container labels** instead, injected into the converted compose file. Nothing appears in `dynamic/` for them, and the labels only take effect on a redeploy — so the Converted tab shows the new labels while the hostname still 404s until you deploy.
- **Swarm stacks** get a file in `dynamic/` like an Application, named `compose+<appName>.yml`, rewritten when a domain is saved and again on every deploy. Swarm keeps `deploy.labels` on the service rather than its containers, and Traefik's `docker` provider reads containers only, so the labels earlier versions wrote there never routed anything; a deploy now takes them out of the converted file. A Swarm stack last deployed before this change is routed from its next domain edit or deploy.

Pin the version anyway. Both provisioning paths now read one exported `TRAEFIK_VERSION`, defaulting to 3.6.7, so they can no longer disagree the way they did — registering a Server used to install 3.5.0 and any later settings change silently recreated the same container at 3.6.7. Setting `TRAEFIK_VERSION` in `/etc/default/cloudgate-backend` is still what pins the running container across all three.

### Request metrics, and why they are on loopback

`metrics:` and the `metrics` entryPoint are Traefik's per-service request counters, which Cloudgate reads as each Service's Error rate (ADR-0027) over `docker exec` into `cloudgate-traefik`. The entryPoint listens on `127.0.0.1:8082` **inside the container**, and that is a tenant-isolation requirement: on `:8082` any container on `cloudgate-network` could read every Service's counters. Do not move it, and do not put `metrics.prometheus` on the dashboard's `traefik` entryPoint. A host installed before this has neither; **Enable request metrics** (Settings → Traefik for this host, a Server's Settings tab for a Server) writes the same block and restarts Traefik behind the usual restart confirmation.

### Traefik has two logs, and only one of them is a file

`accessLog:` is the per-request log, a file in `dynamic/` that Cloudgate rotates itself (Traefik 3 has no rotation settings of its own). `log:` is Traefik's **own** log — startup, provider reloads, and every ACME attempt with what Let's Encrypt answered — and it goes to stdout, so `docker logs cloudgate-traefik` is how you read it and Docker's log driver owns retention.

Traefik 3 defaults that second log to level `ERROR`, and until a later fix no provisioning path wrote a `log:` section at all. A healthy instance therefore said nothing: `docker logs cloudgate-traefik` was 0 bytes from install onwards, and "never attempted a certificate" and "attempted one and it worked" were the same observation. The access log cannot stand in for it — the HTTP challenge is answered before the router chain, so a challenge that demonstrably succeeded leaves no `acme-challenge` line in `access.log`.

**On a host provisioned before that fix you have to add it by hand**, because all three writers skip `traefik.yml` when it already exists. This is *static* config, read once at process start, so it costs a Traefik restart — the same caveat the `accessLog` toggle carries:

```bash
# top-level key, so the end of the file is as good as anywhere
printf 'log:\n  level: INFO\n' >> /etc/cloudgate/traefik/traefik.yml
docker restart cloudgate-traefik
docker logs cloudgate-traefik | head    # non-empty from here on
```

`INFO`, not `DEBUG`: `INFO` is where lego's `Obtaining bundled SAN certificate` and `Testing certificate renew` lines are, at startup-and-events volume rather than per-request volume.

**Every container Cloudgate creates is capped at 30 MB of logs** — the `json-file` driver, `max-size=10m`, `max-file=3`. That is Traefik, every deployed Application, every managed database, the forward-auth proxy, **and now the containers a Compose stack creates**. Those last were the gap, and they are the ones an Organization controls the log volume of: `docker compose up` creates them from that Organization's own file, so the cap's enumeration — a `grep` over `backend/src` for `createService|createContainer` — could not see them and they ran on Docker's stock unbounded driver. Measured on a live host before the fix: three compose containers at `"Config":{}` beside an Application container and Traefik at `10m` × `3`. They are capped now by a `logging:` block Cloudgate writes into the **converted** compose file — the copy it owns, visible on the stack's Converted tab — for both `docker-compose` and `stack` rows; your own compose file is never rewritten. One residual is deliberate: **a service that declares its own `logging:` block keeps it whole, an unbounded one included**, because the key being there is your statement about it, and a merge would half-override a driver you chose on purpose. Nothing set a ceiling before, and an ACME retry loop against a misconfigured domain is exactly the shape that fills a disk once the log above is on — as is a database refusing one authentication per retry, or a misconfigured oauth2-proxy in a Swarm restart loop. Override with `CONTAINER_LOG_MAX_SIZE` and `CONTAINER_LOG_MAX_FILE` in `/etc/default/cloudgate-backend` (and in the installer's environment, which writes those same two keys into that file); a new value applies to the **next** container created, so changing Traefik's takes `docker rm -f cloudgate-traefik` and a re-run of `install.sh`, and changing a compose stack's takes the next deploy of that stack. The cap is set per container on purpose — rewriting the operator's `/etc/docker/daemon.json` is not the installer's business, and reversing that was considered and rejected.

---

## 7. Upgrades

**Not the console's update button** — it cannot work here. Settings shows when a newer Cloudgate
version is out, and the command to install it.

```bash
curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh | sudo sh
```

The one-command install is the upgrade too. It installs the latest Cloudgate version, or the one
`CLOUDGATE_VERSION=vX.Y.Z` names, with the public host the last install was given:

1. It downloads the version and checks its sha256, changing nothing if it does not match.
2. It unpacks it into `/opt/cloudgate.next` and re-runs the install from there. Every step is
   guarded, so on an upgraded host they find their work done and move on.
3. Just before the migrations, the version is put in place: the old `/opt/cloudgate` is moved
   aside, the new one renamed into its place, and the old one deleted. The units run the old
   version until then, and a run that stops before this point leaves the installed version whole.
4. It migrates the database with the version's own `drizzle-kit`, and restarts both units.

**A run on the version already installed downloads nothing**: it re-runs the installed version's
own `deploy/install.sh`, which moves nothing, applies no migration and restarts both units. That
is the way to repair a host whose packages or files someone changed.

Read the version's "What to do on upgrade" lines in `CHANGELOG.md` before you upgrade. Versions
only move forward: a version's migrations cannot be undone, so installing an older version over a
newer one is not supported, and the install does not keep the previous version.

By hand, the same thing is the by-hand install in [§2](#2-install) with the new version's
tarball, and `CLOUDGATE_PUBLIC_HOST` set to the value the install was given.

**Migrate, never push.** `drizzle-kit push` writes columns with no journal row; the next migrate then hits an already-applied `ALTER TABLE` and exits 1 with nothing on stdout or stderr.

Secrets are read back from `/etc/default/cloudgate-secrets` rather than regenerated, which is exactly right for an upgrade: a new `APP_ENCRYPTION_SECRET` would make every encrypted column permanently unreadable, and a new `PGPW` would leave `DATABASE_URL` disagreeing with a Postgres role the script will not touch. The Packages and Postgres steps hand apt only the packages actually missing, print `Required packages are installed ✅` when none are, and so cannot upgrade `curl`, `git` or `openssl` on the way past. An older install kept its secrets in `/root/cloudgate-live-test/env`, a verification run's scratch directory; the first run after that fix migrates the three keys to `/etc/default/cloudgate-secrets`, renames the old file `.migrated`, and prints that it did. **The rule this establishes is worth stating on its own: the instance's identity is `/etc/default/cloudgate-*`.** Keep those files and a reinstall is the same instance, with the same signing secrets and the same session cookies still valid. To reinstall as a genuinely *new* instance, remove `/etc/default/cloudgate-backend`, `/etc/default/cloudgate-console` and `/etc/default/cloudgate-secrets` **and** drop the `cloudgate` database — the secrets and the rows they key have to go together, and keeping either one alone gets you a half-migrated instance rather than a fresh one.

**A host installed from a git checkout.** Until versions were published, the install cloned the repository into `/opt/cloudgate` and built it there. The next run of the one command switches such a host over by itself. The checkout holds no `VERSION`, so the run installs the latest version (or the one `CLOUDGATE_VERSION` names) as on a new host, reusing the public host from `/etc/default/cloudgate-console`. Where step 3 above would delete the old `/opt/cloudgate`, it moves the checkout to `/opt/cloudgate.checkout-<date>` instead (`.checkout-<date>.2` if one was moved there already that day) and keeps it, `node_modules` and `.next` included. `/etc/default/cloudgate-*` and the database are the instance's identity and are kept, so sessions and encrypted values still work after the switch. The run prints where the checkout went and that it can be deleted: nothing runs from it any more, so once anything of yours in it (changes nobody pushed, say) is kept elsewhere, `rm -rf` it. A `/opt/cloudgate` that is neither a checkout nor a Cloudgate version is refused, with nothing changed: move it aside yourself. A host from then also keeps the `/swapfile`, `build-essential` and `python3` the build needed; the install no longer creates or uses any of them and leaves them as they are.

A queued deployment survives a restart, as a Cloud run does. The build queue is in memory, so the Deployment rows are what survive, and start-up settles them: a build still `pending` is queued again, oldest first, and Cancel reaches it as it reaches any waiting build, but one that cannot show what it was queued as (a build of a preview deleted in the meantime, or one recorded before Cloudgate kept that) ends `error` rather than being built as a guess; a build still `running` was cut off part-way, ends `error` with "Cut off by a Cloudgate restart before this build finished", and is never run again by itself — deploy it again; a build `held` for a plan stays held. That is why both units are `Restart=always`: `on-failure` was chosen only because `always` would have papered over the queue orphaning a build, and a restart no longer orphans one. A `systemctl stop` still stops the service.

### OpenTofu and the providers

A Cloud account's resources are made by **OpenTofu** ([ADR-0030](adr/0030-a-cloud-accounts-resources-are-made-by-opentofu-a-servers-by-the-deploy-engine.md)), and `install.sh` installs it with the providers Cloud runs use: `hashicorp/aws` for AWS, and `hashicorp/google` for Google Cloud, which makes every Google resource, the Memorystore instance included (ADR-0030, as amended). That is about **255 MB of downloads** — `tofu` (~35 MB), `hashicorp/aws` (~180 MB) and `hashicorp/google` (~41 MB) — and the providers unpack to about **980 MB** on disk (AWS's 843 MB, Google's 138 MB; the linux_amd64 artefacts of OpenTofu 1.13.1, AWS 6.69.1 and Google 8.8.0, measured when the pin moved to 8.8.0). All land in `/usr/local/share/cloudgate/opentofu/` (`bin/tofu`, and the provider mirror under `providers/`), never in `/usr/local/bin`, so a `tofu` of your own is left alone. Every install has all of them, whichever clouds its Cloud accounts are on; a run uses only its own cloud's. The script writes `OPENTOFU_VERSION`, `OPENTOFU_BINARY`, `OPENTOFU_PROVIDER_MIRROR`, `AWS_PROVIDER_VERSION` and `GOOGLE_PROVIDER_VERSION` into `/etc/default/cloudgate-backend`.

- **All are pinned, with checksums, by the Cloudgate version.** `OPENTOFU_VERSION` and `OPENTOFU_SHA256` at the top of `install.sh` (OpenTofu 1.10 or later, amd64 only — the script stops on any other `uname -m`); each provider's version and checksums in `deploy/opentofu/.terraform.lock.hcl`, from the OpenTofu registry. A provider zip whose sha256 is not in its block of that lock file is refused, and `tofu init` checks the unpacked provider against it again.
- **A Cloud run never downloads anything.** The CLI config it runs with names that mirror as the only place providers come from — there is no direct registry fallback.
- **A re-run is a no-op when both are already at their pins**, and downloads only the one that moved otherwise. Re-running `install.sh` is the upgrade for these too.
- **Versions move forward only, and only by a Cloudgate change.** A state written by a newer OpenTofu or provider is refused by an older one, so do not override `OPENTOFU_VERSION` downward, and do not install an older Cloudgate version across one that moved either pin once a Cloud run has used it. Moving a provider is `tofu init` (or `tofu providers lock`) in `deploy/opentofu/` after changing `versions.tf.json`, plus its line in `install.sh` and its constant in `backend/src/cloud-accounts/tofu/tofu-environment.ts` — `backend/test/cloud-accounts/opentofu-pins.spec.ts` fails until all four agree. Then regenerate `deploy/opentofu/schemas/` — each provider's schema trimmed to the types Cloudgate's definitions write, and the ECS container's fields of the pinned `@aws-sdk/client-ecs`, which native settings are checked against offline ([ADR-0044](adr/0044-native-adds-settings-to-what-cloudgate-generates-never-resources.md) rule 5): with `OPENTOFU_BINARY` and `OPENTOFU_PROVIDER_MIRROR` from `backend/test/cloud-accounts/moto/install-opentofu.sh <dir> aws google`, run `pnpm opentofu:schemas` in `backend/`. The pin test fails while a schema's version is not the pin's, and `backend/test/cloud-accounts/provider-schemas.spec.ts` while a schema misses a type a definition writes (or holds one none does) or the ECS fields are not the pinned SDK's. A state records the provider that wrote it and that provider's version, and one written by a newer AWS or Google provider is refused, naming it.
- **The states have a database login of their own.** `install.sh` creates `cloudgate_state` (its password is `STATEPW` in `/etc/default/cloudgate-secrets`) and, after every `db:migrate`, grants it `deploy/opentofu/state-login.sql`: OpenTofu's `states` table in the `infrastructure_state` schema and nothing else, so `tofu` can never read Cloudgate's own tables. It creates nothing either — the migrations make the schema and table. A by-hand upgrade runs that file too, after migrating: `su - postgres -c "psql -q -v ON_ERROR_STOP=1 -d cloudgate" < deploy/opentofu/state-login.sql`.
- **Never Terraform's binary.** OpenTofu and the provider run unmodified, as separate programs — the licence reasons are in ADR-0030.

---

## 8. Backing up the instance itself

Cloudgate backs up *what you deploy* — databases to S3, volumes to S3. Nothing backs up **Cloudgate**. Four things, and all four are needed:

| | Why |
|---|---|
| **The Postgres database `cloudgate`** | every Project, Environment, Application, domain, Server, destination, backup schedule and audit row — and every **Infrastructure state**, in its `infrastructure_state` schema |
| **`/etc/default/cloudgate-backend`** | `APP_ENCRYPTION_SECRET`, `BETTER_AUTH_SECRET`, `DATABASE_URL`, `INFRASTRUCTURE_STATE_DATABASE_URL` |
| **`/etc/default/cloudgate-secrets`** | the same secrets (`STATEPW` among them), as `install.sh` reads them back on an upgrade — the `tar` below already globs `/etc/default/cloudgate-*`, so it needs no change |
| **`/etc/cloudgate`** | the Traefik static and dynamic configuration, the SSH keys, per-application build state |

```bash
su - postgres -c 'pg_dump -Fc cloudgate' > /root/cloudgate-$(date -u +%FT%TZ).dump
tar -czf /root/cloudgate-etc-$(date -u +%FT%TZ).tar.gz /etc/cloudgate /etc/default/cloudgate-*
```

Keep those off the host. They contain the whole instance.

> **Losing `APP_ENCRYPTION_SECRET` makes every encrypted column permanently unreadable.**
> SSH keys, registry tokens, database passwords and destination credentials are AES-256-GCM at rest, keyed by `HMAC-SHA256(APP_ENCRYPTION_SECRET, "cloudgate:db-encryption:v1")`. ADR-0006 is explicit that there is **no fallback key chain**: the key derives from that one dedicated secret alone — not from `BETTER_AUTH_SECRET`, and with no older key to fall back to. Decryption failure throws; it does not fail open. A database restored without its matching secret is a database of ciphertext.

**The instance backup holds the Infrastructure states.** What OpenTofu knows of each cloud Service and Environment network lives in the same database, in the `infrastructure_state` schema, encrypted whole by OpenTofu under a key derived from `APP_ENCRYPTION_SECRET` (`"cloudgate:infrastructure-state:v1"`, [ADR-0036](adr/0036-cloudgate-owns-the-infrastructure-state.md)). The `pg_dump` above takes it with everything else, and the same rule holds: a state restored without its secret cannot be read, and its runs fail naming it. There is no separate state file to keep.

**Restoring an older dump leaves the states behind the cloud.** Anything a Cloud run made after the dump was taken is in AWS but in no restored state. Nothing is lost or made twice: the next plan of each Service and network searches AWS by Cloudgate's tags and shows what it finds at an address it would create as **adopt** rather than create, and what no state wants as "found in AWS, in no state", for you to remove by hand.

To restore onto a fresh host: run `install.sh` first, then stop both units, restore the four things above **including both `/etc/default` files**, and start the units. Do not let the fresh install's generated secrets stay in place.

---

## 9. Traps that cost real time

**`CLOUDGATE_API_URL` names the API on the browser's hostname.** It is read when the console starts, so changing it is a restart. The symptom of a wrong one is not an error — it is a console that works until you look at anything live.

**Migrate, never push.** See [Upgrades](#7-upgrades). The failure is silent and the recovery is manual.

**ufw does not filter Docker's published ports.** Docker writes its own `iptables` rules ahead of ufw's chain, so a database port published from the console is reachable from the internet even though `ufw status` does not list it — verified from a laptop across the internet on the run. Never use ufw as the reason a published port is safe; what does work is in [Security posture](#4-security-posture-read-this-before-a-public-address).

**Keep `CLOUDGATE_DIRECTORY` at `/etc/cloudgate` on a host `install.sh` set up — and the reason is Traefik, not the backend**. This paragraph used to say that `deployment-engine.paths.ts` resolves the *local* directory for application, compose and volume-backup paths even for commands dispatched to a Server over SSH. That stopped being true over a run of later fixes, which converted every tree on that page to `cloudgateDirectoryOn` — each now asks the Server the path is for, and `backend/test/coding-standards/platform-root-call-sites.spec.ts` is the census that keeps a new local root from arriving unexplained. The backend's root is relocatable, and is meant to be.

What pins it is the `traefik.yml` that `install.sh` writes. Its `providers.file.directory`, `certificatesResolvers.letsencrypt.acme.storage` and `accessLog.filePath` are read by **Traefik inside its container**, where the dynamic directory exists only at the bind *target* — the fixed literal `/etc/cloudgate/traefik/dynamic`, on this host and on every Server alike. The installer writes all three through `$CLOUDGATE_DIR`, so they are correct only while it is that literal. Relocate the root and the file provider watches a directory the container does not have — `dynamic/middlewares.yml` never loads, so `redirect-to-https` is undefined and plain HTTP 404s again — `acme.json` lands in the container's throwaway layer and every Traefik recreate re-issues into Let's Encrypt's rate limit, and the access log is written where nothing that reads it ever looks. Note the bind *source* does follow `$CLOUDGATE_DIR`; it is the config file's own paths that do not, which is why the failure is silent rather than a missing mount.

**The console build is the memory peak.** On a 4 GB box, stop both units first to reclaim ~600 MB. `--max-old-space-size` bounds the V8 heap and not Turbopack's Rust allocations, so it helps and is not the fix; `next build --webpack` is.

**A nightly Docker prune is on by default.** `/settings/maintenance` shows it: `docker system prune` at 23:50, plus the builder cache. It never touches volumes. If your build cache mattering is news to you, that is where it went.

**`$CLOUDGATE_DIRECTORY/ssh` is `0700` and root-owned, and holds the auto-generated local-access key pair.** That is the directory the platform-host terminal writes its key into. Nothing used to create it — `ssh-keygen` will not make a parent for an explicit `-f` path — so on a stock install the first "Open a shell" on the local Server closed `4502`. Both `install.sh` and the backend now create it, and the mode is not cosmetic: anything readable under `/etc/cloudgate` is readable by any authenticated caller. If you relocated `CLOUDGATE_DIRECTORY` after installing, the backend makes it on first use.

```bash
ls -ld /etc/cloudgate/ssh     # drwx------ root root
```

**Re-running the installer no longer upgrades system packages, and it used to.** The Packages step was the one step with no guard, so the documented upgrade path ran `apt-get update` and `apt-get install` over `curl`, `git`, `openssl`, `build-essential` and `rclone` every time and printed nothing about it — on the run that found this, curl moved `8.5.0-2ubuntu10.11 → .12` on a production host. Both apt steps are guarded now and hand apt only what is genuinely missing. If you are on a host that was installed before that fix, its packages have already moved; nothing here rolls them back.

---

## 10. Operating it

```bash
systemctl status cloudgate-backend cloudgate-console
journalctl -u cloudgate-backend -f          # remember: this contains credentials
curl -s http://127.0.0.1:4000/settings/health
docker service ls; docker ps
```

**How many browser legs are being dropped.** Every realtime socket — the terminals, the log
streams, the setup run, the stats feed — is pinged every 45 seconds, and a peer that misses a pong
is terminated. That reap is the one teardown with no other trace, so it writes its own line:

```bash
journalctl -u cloudgate-backend | grep -c 'Reaped socket:'
journalctl -u cloudgate-backend --since '1 hour ago' | grep 'Reaped socket:'
```

The count is the number, and the second command says what was reaped and for whom. A count that
climbs steadily is a proxy or load balancer dropping the browser leg of a socket while holding the
upstream one — the failure the 45-second ping exists to notice, and the one that used to leave a
`docker stats` subprocess spawning every 1.3 seconds for a tab nobody had open. It is **not** users
closing tabs: a clean close emits no line at all, deliberately, so this grep stays countable. The
verb is its own for the same reason — `grep -c 'Refused socket:'` remains the count of connect-time
denials and no reap joins it.

`/settings/health` is the only unauthenticated one. **`/settings/infrastructure-health` is
admin-guarded and answers 401 to a bare curl** — reach it with an API key belonging to an owner or
admin, or read the same two checks on `/settings/instance`:

```bash
curl -s -H "x-api-key: <owner or admin key>" http://127.0.0.1:4000/settings/infrastructure-health
```

`/settings/instance` is the same two health checks on screen, plus the version and the SSH key. `/settings/maintenance` is Docker's disk usage and the prune controls. `/monitoring` is the live host and per-container stats — collection is **off** until you enable it, and the field that switches it on is a non-empty `metricsConfig.server.token`.

Both units are `Restart=always`, so a crash restarts and so does an exit nobody asked for; `systemctl stop` still stops them. They used to be `Restart=on-failure`, so the counts that follow were taken under it. Across the first ten-session run neither unit restarted once. Across the ten-session **fix-verification** run the console still never restarted and the backend restarted **twice**, both for the same reason and both deliberate: at the time, stopping Postgres under a running backend made it `exit(1)` on an unhandled `pg` pool error, so a routine `systemctl restart postgresql@16-main` took the API down with it.

**Both halves of that are now closed, and the counter above is history rather than current behaviour.** One fix gave the pool an `error` listener, so the process no longer exits; another changed the unit's `Requires=postgresql.service docker.service` to `Wants=`, so systemd no longer propagates the database's stop to the API either. It was two independent mechanisms and it needed two fixes. Line 4's `After=` is unchanged, so boot ordering still holds. The same now goes for `systemctl restart docker`: it degrades deployments rather than stopping the API.

**A `docker-compose` stack now comes back by itself after `systemctl restart docker` or a host reboot**. It did not before, and the asymmetry was the finding: on a rebooted host all six Swarm services reconverged with fresh task ids and all four non-Swarm containers stayed `exited` carrying `RestartPolicy=no` — the container count went 11 before, 5 at 15 s, 7 at 75 s, and stayed at 7 until they were started by hand. Cloudgate injected no `restart:` key, so a compose container inherited whatever the author's file said, which was usually nothing. It now writes `restart: unless-stopped` into the **converted** compose file — the copy Cloudgate owns, visible on the stack's Converted tab — for every service that does not declare a `restart:` of its own; your own compose file is never rewritten. Three things follow, all deliberate: a service that declares `restart:` keeps it and is your business, `restart: no` included; `unless-stopped` and not `always`, so a stack you press **Stop** on stays stopped across a daemon restart instead of coming back while Cloudgate still reads it as stopped; and a `stack`-type row gets nothing, because `docker stack deploy` ignores `restart:` and warns about it on every deploy while Swarm already reconciles its own tasks from `deploy.restart_policy`'s default `condition: any`.

**Which command demonstrates that, and which one proves nothing.** Use `systemctl stop postgresql` — the meta unit that both `After=` and `Wants=` name. On Ubuntu 24.04 `postgresql@16-main.service` carries `PartOf=postgresql.service`, and `PartOf=` propagates a stop *downward* only: stopping the meta unit stops the cluster with it, while stopping the *instance* unit leaves the meta unit `active` and reaches no dependent of it at all. So `systemctl stop postgresql@16-main` would not have taken the API down even before the unit change, and a passing result there says nothing about the fix. It is still the right command for the other half — the cluster really stops and the pool's connection really dies, which is the pool listener's path and why it is the command named in the paragraph above.

```bash
systemctl show cloudgate-backend -p NRestarts   # NRestarts=2 at the end of the run
systemctl show cloudgate-console -p NRestarts   # NRestarts=0
```

Restarting the database no longer needs a drain — requests in flight still fail, and the next one succeeds once Postgres is accepting connections again. Nothing else in either run moved the counter — not three Nixpacks builds, three Dockerfile builds, ten Compose deployments, twelve backup runs or five restores.

### The Template catalogue

The Templates screen reads the official **Template catalogue**, the newest release of
[`octabyte-io/cg-templates`](https://github.com/octabyte-io/cg-templates), with nothing to set
(ADR-0062, ADR-0072). `CLOUDGATE_TEMPLATES_URL` in `/etc/default/cloudgate-backend` names the
catalogue's one `catalogue.zip` and defaults to
`https://github.com/octabyte-io/cg-templates/releases/latest/download/catalogue.zip`. Only the
backend fetches it: from `github.com`, which redirects to GitHub's release-download host,
`release-assets.githubusercontent.com`. Open both outbound, or neither and set one of these:

- **A mirror.** Set `CLOUDGATE_TEMPLATES_URL` to the http or https address of your own copy of a
  release's `catalogue.zip`, on a network that blocks GitHub. Copy the release asset as it is: the
  zip is checked whole, and one holding anything a template does not (a website's `index.md` or
  `screenshots/`, a stray file) is refused. A mirror still serving a release's old
  `catalogue.json` is refused with "The catalogue is a catalogue.json, the format before ADR-0072;
  this Cloudgate reads a catalogue.zip", and the last good copy kept until it serves the zip.
- **Off.** `CLOUDGATE_TEMPLATES_URL=off` turns templates off, and the Templates screen says so.

The backend checks for a newer release at most once an hour, and only when someone opens the
Templates screen; it keeps the last good copy in the database and serves it, with its age, while
the catalogue cannot be reached. A file over 10 MB, or one that is not a catalogue zip, is refused
whole and the last good copy kept. Restart `cloudgate-backend` after changing the setting.

**`CLOUDGATE_TEMPLATES_BASE_URL` is no longer read** (ADR-0066). The `template.toml` reader it fed
is gone. While it is still set and `CLOUDGATE_TEMPLATES_URL` is not, templates are off, and the
startup log and the Templates screen say what to do: set `CLOUDGATE_TEMPLATES_URL`, or remove the
old setting to use the official catalogue. Stacks set up from old templates keep running.

### Locked out

**A forgotten password needs a mail sender, and nothing else resets it.** `/forgot-password` emails a link, and with `MAIL_PROVIDER` unset (the install default) the backend gives better-auth no sender, so every request is refused and the screen says so. No console screen sets another account's password, an owner's included — so on a fresh install, where the owner is the only account, the way back in is to configure mail on the host. In `/etc/default/cloudgate-backend`:

```bash
MAIL_PROVIDER=smtp                  # or resend, with RESEND_API_KEY=… instead of the SMTP_* keys
MAIL_FROM_ADDRESS=cloudgate@example.com
SMTP_SERVER=smtp.example.com
SMTP_PORT=587
SMTP_USERNAME=…
SMTP_PASSWORD=…
```

then `systemctl restart cloudgate-backend` and ask for the link again. Invitation emails start being sent from the same moment.

**A lost second factor has no console path either.** On `/2fa`, a backup code works in place of the authenticator app. Without either, nobody can turn two-step verification off for another account from the console; whoever has the host can, with the same two writes better-auth's own "turn off" makes:

```bash
su - postgres -c "psql -d cloudgate" <<'SQL'
UPDATE "user" SET two_factor_enabled = false WHERE email = 'person@example.com';
DELETE FROM two_factor WHERE user_id = (SELECT id FROM "user" WHERE email = 'person@example.com');
SQL
```

The next sign-in with that email and password goes straight in, and the person can turn two-factor on again from Settings → Account.

## 11. The Hosted instance

### The Stripe webhook endpoint

Stripe tells the Hosted instance about payments only through one webhook endpoint, made by hand in the Stripe Dashboard (Developers > Webhooks), in each Stripe account the instance uses: test mode for staging, live mode for production. Point it at `https://<console domain>/backend/billing/webhook`, put its signing secret in `STRIPE_WEBHOOK_SECRET`, and subscribe it to **exactly** these events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.deleted`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `customer.subscription.pending_update_expired`
- `subscription_schedule.released`
- `subscription_schedule.completed`
- `subscription_schedule.canceled`
- `subscription_schedule.aborted`
- `charge.dispute.created`

**An event left out is never sent, and nothing fails.** Without `customer.subscription.pending_update_expired` an unpaid Bought Server purchase is never dropped; without `charge.dispute.created` no dispute reaches the Operators. **An event added is refused** with a 400, which Stripe retries for days before disabling the endpoint. The list is the backend's `HANDLED_EVENT_TYPES` (`backend/src/cloud/billing/stripe-webhook-events.ts`), and a test fails when the two disagree, so a release that handles a new event changes this list and its changelog says to subscribe to it.

On every start the Hosted instance reads its endpoints from Stripe and logs a warning from `StripeWebhookEndpointCheck` naming each event an endpoint pointing at `/billing/webhook` is missing or has extra, a disabled endpoint, or no such endpoint at all. A key that cannot read webhook endpoints is a warning too, never a refusal to start.

### The firewall in front

`install.sh` closes 3000/4000 with ufw, but nothing it does stops a provider-level port being open. Put the provider's own firewall (a Hetzner Cloud Firewall, for one) in front of the box and admit **22, 80 and 443** only. With [automatic updates](#automatic-updates) port 22 must accept GitHub's hosted runners, so keep SSH to keys only.

### Upgrading by hand

Take a backup first, then run the one command with `HOSTED_MODE=true`; every other input is read back from `/etc/default/cloudgate-hosted`. A run without `HOSTED_MODE=true` stops, because that file exists. `CLOUDGATE_VERSION` names the version:

```bash
systemctl start cloudgate-backup.service
curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh \
  | sudo HOSTED_MODE=true CLOUDGATE_VERSION=v0.3.0 sh
```

Read the version's "What to do on upgrade" lines in `CHANGELOG.md` before you do: a version that handles a new Stripe event says to subscribe the webhook to it.

Once the box has `cloudgate-update` (a Hosted install writes it), `sudo cloudgate-update v0.3.0` does the same in one step: it refuses a tag with no published release before anything else, takes the backup, runs that tag's own `install.sh` with `HOSTED_MODE=true` and `CLOUDGATE_VERSION`, and checks `/opt/cloudgate/VERSION` reads `0.3.0` afterwards. It is what [automatic updates](#automatic-updates) run.

### Automatic updates

Each Cloudgate version reaches the Hosted instance by itself once it is published ([ADR-0081](adr/0081-the-hosted-instance-is-upgraded-by-a-green-version-tag-over-a-key-that-can-run-only-the-updater.md), [ADR-0082](adr/0082-the-install-downloads-a-prebuilt-release-tarball-published-only-after-a-green-e2e-run-and-runs-it-natively.md)):

1. `git tag v0.3.0 && git push origin v0.3.0` starts `E2E (release)`.
2. When that run ends green, **Publish Cloudgate version** (`.github/workflows/publish-version.yml`) builds the version's tarball, boots it, and puts it and its `.sha256` on the tag's GitHub Release.
3. Its last job starts `.github/workflows/deploy-hosted.yml` on `main`, passing the tag and the commit E2E tested. That run checks the tag is on `main` and still names that commit, then checks the version with `deploy/hosted-release-gate.sh`: the tag must be `backend/package.json`'s version, and every "What to do on upgrade" line in its `CHANGELOG.md` section must read "nothing.". Anything else stops the run and names the lines.
4. It SSHes to the box as `cloudgate-deploy`, whose key runs only `/usr/local/sbin/cloudgate-update` (`deploy/hosted-update.sh`). In its own unit, `cloudgate-update.service`, so a dropped connection cannot cut it off, that refuses a tag with no published release, takes a B2 backup, installs the published tarball with the tag's own `install.sh`, and checks `/opt/cloudgate/VERSION` is the tag.
5. It waits until `https://<hostname>/backend/settings/about` reports the new version in hosted mode.

A version that stopped at step 3: do what its lines ask, then run **Deploy the Hosted instance** by hand (Actions > Run workflow) with the tag and `manual_steps_done` ticked, leaving `tested_sha` empty. Running it by hand also deploys a version again. With no `tested_sha` the run checks instead that the tag's release carries its tarball. Either way only a published version is installed: a tag whose E2E or publish run was red has no release, and the box refuses it before its backup.

The deploy is a dispatch rather than a `workflow_run` on the publish workflow because the publish workflow is itself started by `workflow_run`: its run carries the default branch's name and commit, not the tag's, so a `workflow_run` on it could not tell which version to deploy.

**Setting it up, once.** On your laptop make a key used for nothing else:

```bash
ssh-keygen -t ed25519 -f cloudgate-deploy -N '' -C cloudgate-deploy
```

On the box, as root, give its public half to the access script. It makes the `cloudgate-deploy` user, its forced-command key and its one sudoers line, and prints the two values below. Running it again with another key rotates the key.

```bash
bash /opt/cloudgate/deploy/hosted-update-access.sh "$(cat cloudgate-deploy.pub)"   # the .pub copied to the box
```

In GitHub, Settings > Environments > New environment `hosted`. Under deployment branches and tags allow **`main` only**: the publish workflow dispatches the deploy on `main`, never on the tag, and a by-hand run is started on `main` too. Then add:

| Name | Kind | Value |
|---|---|---|
| `HOSTED_SSH_HOST` | secret | the box's address, as the access script printed it |
| `HOSTED_SSH_PRIVATE_KEY` | secret | the whole `cloudgate-deploy` private key file |
| `HOSTED_SSH_KNOWN_HOSTS` | secret | the `HOSTED_SSH_KNOWN_HOSTS` line the access script printed; with sshd on another port, write the host as `[address]:port` |
| `HOSTED_URL` | variable | `https://<CLOUDGATE_HOSTNAME>` |
| `HOSTED_SSH_PORT` | variable | only when sshd is not on 22 |

The Stripe, Resend, Turnstile and B2 inputs never go to GitHub. A failed upgrade leaves the box on the version the failure reached; `journalctl -u cloudgate-update.service` on the box says why, and the backup the run took first is in B2.

## What has not been verified

- **A Cloudgate version installed on a host.** The install's download, checksum, staging, hand-over and switching a checkout over are driven by `backend/test/deploy/one-command-install.spec.ts` with GitHub and systemd stubbed, and the publish workflow boots each tarball against an empty database before publishing it. Nobody has yet installed or upgraded a real host from a published version, or switched a real checkout over; every host run recorded below built from a checkout.
- **A second Server.** Everything here is one host deploying to itself. The remote-Server path is exercised only as far as registering this host and running its setup script over SSH.
- **A teardown that *keeps* the secrets file.** [Upgrades](#7-upgrades) documents the rule in both directions — a fresh install generates the three keys, and a preserved `/etc/default/cloudgate-secrets` **reproduces the same instance**, with the same signing secrets and the same session cookies still valid. Only three quarters of that are read: an **upgrade** was proved to reuse the three keys byte-identically (with four-day-old encrypted columns still decrypting), and a **teardown that removes the file** was proved to inherit nothing — three fresh fingerprints, none equal to the pre-teardown values, and zero occurrences of the migration line. **Nobody has torn the host down while keeping the file.** That is one teardown and two installs, and it is the only thing that closes the claim's last quarter.
- **Mail.** `MAIL_PROVIDER` was left unset throughout. Invitations were tested through the copyable link.
- **An enterprise licence.** SSO, custom roles, forward auth and white-labelling show gated states. The audit log works without one.
- **A clean rebuild from this document alone — and each fix-verification run has left this *less* discharged than the one before, not more.** All three runs tore the host down in place and reinstalled onto it, which discharges most of this but not the part that matters most for a genuinely fresh box: the guarded steps early-exit because the teardown is over SSH rather than a provider reimage, and they are exactly the steps that fetch from a third party and verify what they get. In the first run there were **four**: **swap creation, Node's `nodejs.org` download and `SHASUMS256.txt` checksum, the `get.docker.com` installer, and the `nixpacks.com` installer**. The second run made it **five**, because the apt guard makes the apt steps early-exit **by design** — `ensure_packages postgresql` printed `Required packages are installed ✅` where the previous run had actually executed `apt-get install postgresql`. **The third run measured six**, and the sixth is the **base package list** (`ca-certificates curl wget git jq openssl unzip build-essential python3 rclone`): `Required packages are installed ✅` appears **twice** in that install log, while `apt-get install`, `Installed:`, `get.docker.com`, `nixpacks.com/install.sh`, `mkswap` and `fallocate` appear **zero** times. (`nodejs.org` appears four times in that log and is *not* the installer — it is node-gyp fetching headers for the node-pty build, which reads the other way: the native module really was compiled on the box.) **So the number is a property of the run's control group, not of the code.** The second run deliberately `apt-get remove`d `unzip` before tearing the host down, which made its base apt call execute; the third deliberately left the package set alone, so the base list early-exited there too. Read the count as *how many third-party acquisition steps did this particular teardown decline to exercise* and it is stable; read it as a property of `install.sh` and it will keep moving. That is the fix working exactly as intended, and the cost is that **the Postgres acquisition path is unverified too — and so is the base list's**. Do not read the apt guard's confirmation as narrowing this gap; it widens it, and a genuinely fresh box remains the only thing that can close it. **The corollary matters more than the count:** the apt guard's *other* half — that the guard **installs only what is missing** — is evidenced by the second run's removed-`unzip` control and by the third run's own second install (149 s, zero `Installed:` lines, `/var/lib/apt/lists` untouched — see [Upgrades](#7-upgrades)), and **not at all** by a teardown whose packages were left alone. A reader who takes “six early-exit” as strengthening the apt guard has it backwards: the claim that the guard installs the missing package gets *weaker* with every guard that merely holds. Everything else on this page was re-exercised from empty: `/etc/cloudgate` and both Traefik files, the env files, the Postgres role and database, freshly generated secrets, the service user, `swarm init` (a new node id), the overlay network, the Traefik container, `pnpm install` into an empty tree, `db:migrate` against an empty database, both builds, both units, and ufw from a reset. Note also that a truly fresh box needs repository access before it reaches any of this — see [Install](#2-install).
