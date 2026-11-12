# Live acceptance on the Claude Code host

A spec's live acceptance runs on **this machine**, the one this Claude Code session runs on. It is the **platform host** of a throwaway Cloudgate stack built from the `main` you just merged, and every Environment in the walk uses the Deploy target `{ kind: 'platform-host' }`. Where a spec or ticket says "the VPS walk recipe" or "a real Server", read it as this machine. No VPS, and no SSH to any other machine.

Write every recipe, credential and log for the walk to the scratchpad directory, never the repo.

## 1. Preflight

Record what already exists before you change anything, so cleanup removes only what the walk made:

- `docker info --format '{{.Swarm.LocalNodeState}}'`, `docker network ls`, `docker ps -a --format '{{.Names}}'`, whether `/etc/cloudgate` exists, and which of ports 80, 443 and 8080 are listening.
- Free memory. A full e2e run and the walk stack do not run at the same time.

No reachable Docker daemon means the walk is not runnable here: record every live criterion as not runnable, with that reason, and go back to step 6 of [`SKILL.md`](SKILL.md).

## 2. Prepare the platform host

Do what Cloudgate's own Server setup does, read from `backend/src/servers/server-setup.ts` rather than retyped from memory: Swarm, the attachable `cloudgate-network` overlay, and Traefik under the platform root. Skip each piece that preflight found already present. When Swarm is inactive, `docker swarm init --advertise-addr 127.0.0.1` is the single-node form. When ports 80/443 are taken by something the walk does not own, stop and report the walk as not runnable; never stop a process or container you did not start.

## 3. Start the stack

- A Postgres container named `cloudgate-live-<spec>` on a free port. Address it only by that name: other projects' containers share the same image.
- `backend/.env` copied to the scratchpad with `DATABASE_URL`, a free `PORT` and `TRUSTED_ORIGINS` pointing at the console port; migrate with `npm run db:migrate`.
- The backend (`npm run start`) and the console (`npx next dev -p <free port>`) as background jobs.
- An owner account created through the API with a generated password kept in the scratchpad.

## 4. Walk

Drive each criterion through the product's own surface, in the order the spec lists them:

- **HTTP** is the default: the console's `/backend/...` API with the owner's session cookie, and `docker service inspect` / `docker service ps` for what landed on Swarm.
- **A Domain answers**: the generated sslip.io host resolves to a public IP this machine may not have, so ask Traefik directly with `curl --resolve <host>:80:127.0.0.1 http://<host>/`.
- **The browser**: when `claude-in-chrome` reports a connected browser, use it for console-only proofs. Without one, prove the flow through the API the page calls, and record the criterion as passed through the API, unproven in a browser.
- **Not runnable here**: a proof that needs a second machine (a remote Server over SSH, a multi-node Swarm), a publicly reachable port (an HTTP-01 certificate, an inbound webhook from a third party), a GPU, or a credential the user has not given in this run. Record each with its reason and move on.

A criterion is **passed** only on observed evidence (a command's output, a response body, an inspect field). Keep that evidence for the ticket's closing comment.

## 5. Clean up

Remove what the walk created and nothing else: the Services, containers and volumes the walk deployed, the stack's background jobs, the `cloudgate-live-<spec>` container, and, only if preflight found them absent, the overlay network, Traefik, `/etc/cloudgate` and Swarm (`docker swarm leave --force`). The walk is done when a second preflight matches the first.
