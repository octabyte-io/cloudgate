# Connecting an Agent

An **Agent** is a member of an Organization that an AI tool acts as. It has a role (Reader or Operator), reaches only the Projects, Environments and Services it has been granted, and connects to Cloudgate over MCP with an **agent key**. Every call it makes is one row in the audit log, allowed or refused.

Create an Agent in the console, in the Agents section of Settings. Its key is shown once. The console's **Connect** panel gives the configuration for each MCP client it supports, and that panel is the only place those snippets live: this page does not repeat them. What it does cover is what the endpoint expects and the limits it answers by, so you can plan around them before an agent runs into one.

**You arrange the Agent's repository access, outside Cloudgate.** An Agent that pushes a fix and then asks for a Requested preview of its branch needs write access to the repository the Application builds from, and nothing in Cloudgate gives it that: its grant reaches Cloudgate's Projects, Environments and Services, never your git provider. Give the AI tool its own access there, scoped as you see fit. It is the step easiest to forget, because nothing in Cloudgate asks for it.

**An Agent reads a Service's health and never configures it.** `get_service_health` answers what the Service's Health tab shows: its Uptime checks, its Error rate or why it is unavailable, its Error-rate threshold, and its open and most recently closed Incidents. `get_service` and `get_environment` carry the open Incidents too. No tool adds, edits, turns off or removes an Uptime check or an Error-rate threshold, whatever the Agent's role, so an Agent cannot silence an Incident. A check's keyword and header value are never in an answer, only whether one is set, and neither is anything a probed app answered.

**An Agent reads a Project's config and its plans, asks for a plan, and never applies one.** `get_project_config` answers the Project's config as the Project keeps it, on the Project's grant; `get_plan` answers an Environment's open plan, or its latest, and `request_plan` asks for a fresh one, the console's Check for changes, both on the Environment's grant and open to a Reader. A plan it asks for replaces the Environment's open plan, as yours would. No tool applies or dismisses a plan, whatever the Agent's role, so an Agent can tell you what would change but changes nothing: you apply it in the console. The config's text reaches the Agent as written, comments included, with the Project's own stored secrets masked, so keep credentials out of it.

**An Agent operates an AI model as the Application it is, and never calls it here.** `deploy_service`, `start_service`, `stop_service` and the read tools reach an AI model exactly as any Application; no tool creates, deletes or calls one, and none reads its Token spend. `get_service` on an AI model carries `aiModel`: its `runtime`, its `model`, the `gpus` it reserves and its `endpoint`, the OpenAI-compatible base URL on Cloudgate's `/ai` path that a client calls through the gateway with a caller Agent's key. `aiModel` is `null` on every other Service, and `endpoint` is `null` while the platform host URL is not set. The AI model's upstream secret is never in an answer, not even whether there is one.

Every number on this page is a constant in the code, with no setting. `backend/test/coding-standards/connecting-an-agent-docs.spec.ts` reads each one from the constant that decides it and fails if the two disagree.

---

## The endpoint

**Address:** your console's address followed by `/mcp`. It is the same origin you open the console on, whether that is the bare host and port or a console domain. There is no Traefik entry for it and nothing to enable: after an upgrade the endpoint exists and answers 401 until an Agent has a key.

**Header:** the agent key, as a bearer token:

```
Authorization: Bearer <agent key>
```

That is the whole of authentication. No OAuth discovery is served, so no client starts a sign-in flow Cloudgate cannot finish.

What the endpoint refuses before any tool runs:

| Request | Answer |
|---|---|
| An unknown, revoked or disabled key | 401, no audit row (there is no Agent to name) |
| A **personal key** | 401, "This endpoint takes an agent key, and this is a personal key." A personal key acts as you, with everything you can do; it is for scripts calling the REST API, never for an agent. |
| An expired agent key | 401 naming the day it expired, and an audit row |
| A suspended Agent | 403, and an audit row. A suspended Agent spends no rate limit. |
| Anything but `POST` | 405. `GET` and `DELETE` are the older transport's session operations, and the endpoint keeps no session. |
| A body that is not `application/json` | 415 |

An agent key works here and nowhere else: the same key is refused on the REST API and on the console's sign-in routes.

## Limits

### Rate limits

Each Agent has two budgets, shared by every key it holds:

- **Reads**: 120 a minute, with a burst of 60.
- **Writes**: 10 a minute, with a burst of 5.

The write tools are `deploy_service`, `start_service`, `stop_service`, `cancel_deployment`, `create_preview`, `extend_preview`, `redeploy_preview`, `delete_preview` and `request_plan`; every other tool spends the read budget. Each budget refills continuously, so an Agent that has used its burst gets a call back every few seconds rather than waiting for the minute to turn over.

A call over budget is answered **HTTP 429** with a `Retry-After` header in whole seconds, and spends nothing. It writes a `refused` audit row with reason `rate-limit`. It carries no "this is an access decision" sentence, because waiting will change the answer.

An Agent that keeps hitting the limit is a loop, not a busy agent. The first 429 after an hour with no 429 raises the **Agent rate limited** Notification to the channels that subscribe to it; later ones inside that stretch are counted on the Agent's row in the console ("Rate-limited N times in the last hour") rather than notified again.

The budgets are counted in the backend's memory. A restart refills them.

### Coalescing

`deploy_service` is safe to call twice. If a Deployment of the same Service is **still waiting in the queue**, a second call answers that Deployment's id with `coalesced: true` and queues nothing. A `deploy` on a queued `redeploy` turns it into a deploy.

That is the whole of it, and the edges matter:

- **A build that is already running is not joined.** A new Deployment is queued behind it, because the running one read its source when it started.
- **A restart keeps the queue.** The queue is held in memory, but a backend restart queues its waiting Deployments again at start-up, before it answers anything, so a deploy after a restart joins one of those as it would have before. A build that was running is cut off, ends `error`, and is not joined.
- Two deploys arriving at the same instant can both queue. The write budget is what bounds that.
- Deploys from the console and from git webhooks never coalesce. They queue every request, as they always have.

### One build at a time per Server without a licence

Without a licence, each Server builds one Deployment at a time, and every other build on it waits in the queue as `pending`. An agent that deploys three Services on one Server gets three ids straight away and three builds in sequence, so it should poll `list_deployments` rather than assume a queued build has started.

With a licence, the platform host builds as many Deployments at once as its builds concurrency setting allows. That setting applies to the host only.

### What the mask cannot hide

Every tool result, deployment logs included, passes through one mask before the agent sees it. It replaces every **stored secret** reachable from what the tool is about — environment variables, build arguments, registry and git credentials, database passwords, backup destination keys — with `••••••`.

It cannot hide:

- **What a build prints that Cloudgate never stored.** A token the build fetches or generates, then echoes, reaches the agent as printed.
- **An encoded copy** of a stored value, such as the value after the build has encoded or escaped it.
- **A value shorter than 6 characters.** Masking those would eat ordinary words.

The other side of that rule: a stored value of 6 characters or more is masked **wherever it appears**, ordinary words included. A build argument `NODE_ENV=production` masks every "production" in the log. If an agent reports a log full of `••••••`, look for a short, common word stored as a secret.

Don't let builds print secrets, and treat anything an Agent can read as readable by whoever runs that agent.

### Protocol revisions

The endpoint serves these MCP revisions:

- **2026-era**: `2026-07-28`, with its per-request envelope.
- **2025-era**: `2025-11-25`, `2025-06-18`, `2025-03-26`, over Streamable HTTP.

A 2025-era request naming any revision older than `2025-03-26`, including `2024-11-05` and its HTTP+SSE transport, is refused with 400 and JSON-RPC error -32602 listing the served revisions. A 2026-era request naming a revision the endpoint does not serve gets 400 and -32022. Both write a `refused` audit row with reason `unsupported-revision`.

Every answer is `application/json`. There is no event stream, no `Mcp-Session-Id`, and nothing to keep sticky behind a load balancer. One quirk of the 2025-era transport survives: a 2025-era request must still send an `Accept` header naming both `application/json` and `text/event-stream`, or it is answered 406, even though the answer is never a stream. MCP clients that speak those revisions already send it.

Dropping a revision from this list is announced in the release notes. It is never a side effect of a library upgrade.

### The deadline

A tool call gets 30 seconds. One that runs past it is answered with the `failed` outcome, "The call did not finish within 30 seconds and was abandoned", and an audit row, well before the console's proxy would cut the connection. **The work itself is not stopped**: whatever the tool started carries on on the Server.

The write tools are built to answer inside that:

- `deploy_service` answers as soon as the build is queued. Poll `list_deployments` for its status.
- `create_preview` and `redeploy_preview` answer as soon as the preview's build is queued, with its `deploymentId`. Poll `get_preview` or `list_deployments`, and read the build with `read_deployment_log`.
- `delete_preview` answers at once with `expired: true` and touches no Server: the expiry sweep tears the preview down afterwards, and once its copy is gone the preview answers not found.
- `start_service` and `stop_service` on an Application or a database answer `requested` as soon as Swarm has been given the new replica count. That is not the same as running, or stopped: the Service has not converged yet, and may not. Poll `get_service` or `get_environment`.
- `start_service` and `stop_service` on a **Compose** cannot answer early. `docker compose` and `docker stack` have no detached start or stop, so the tool runs the command to the end, as the console's buttons do. A stack that takes longer than 30 seconds answers `failed` while the command finishes on its own. Read that `failed` as "check the status", not as "nothing happened".

### The log window

`read_deployment_log` answers the last 100 lines of an Application's or Compose's Deployment log unless it asks for another number, and never more than 500. A request for more is answered at 500, not refused. A window larger than 1 MiB, which a build printing progress bars can reach well inside that line count, answers a failure asking for fewer lines.

There is no follow and no streaming: an agent watching a build polls. The logs of a schedule's or a backup's run are not readable through it, and answer exactly as an unknown id does.

### Requests carrying an Origin header

Any request with an `Origin` header is refused with 403, before the key is even read. MCP clients send none; a browser always does, and has no business calling this endpoint with a bearer key. There is no allow-list to keep in step with the console's trusted origins, which also closes off DNS rebinding.

If a proxy you put in front of Cloudgate adds `Origin`, it has to stop doing so for `/mcp`.

## Reading what an Agent did

Every call writes one audit-log row: the tool, the outcome (`succeeded`, `refused` or `failed`), and for a refusal the reason (`permission`, `grant`, `rate-limit`, `suspended`, `credential-expired`, `unsupported-revision`, `unknown-tool`, `batch-refused`). A call whose arguments the tool does not accept is `failed` with reason `invalid-arguments`, and spends nothing from the budget. A batch of calls (JSON-RPC batching, which only the oldest served revision has) is refused as a whole when any call in it is refused: that call's row names why, and every call that therefore never ran has a `batch-refused` row and spends nothing. The Agent's row in the console links to its entries, and to its refused ones on their own. A `failed` answer that no tool explains in its own words names the audit entry holding the detail, which the agent itself is never shown.

`create_preview` and `extend_preview` also leave the row the same request leaves over the REST API, beside the call's: the preview's `create` with its branch and expiry, or its `update` with the new expiry. So does a `create_preview` refused because the Application already holds as many Requested previews as its limit allows: a second `failed` row, with reason `preview-limit`, the limit and how many it holds. That refusal tells the agent to delete one or wait for one to expire, and carries no "this is an access decision" sentence, because either frees a slot: a deleted preview is expired at once, and its slot comes back once its teardown finishes, as an expired one's does.
