# Private web services

A **private web service** is a Service that answers HTTP on its port only to other Services, never from outside. An internal API that only your own front end calls is the usual one. You write it in the Project config as `kind: web-private`:

```yaml
version: 1
services:
  api:
    kind: web-private
    port: 4000
    source:
      github: acme/api
    env: [DATABASE_URL]
```

It takes every field a `web` takes, and `port` is required, because the port is what its callers are given. A `web-private` with no `port` refuses the plan. If the Service serves nothing at all, it is a `worker`, not a `web-private`.

On a Server, and on Cloudgate's own host, a plan creates it as an Application, deployed and built the way a `web` is. What differs is how it is reached.

---

## What "private" means on a Server

Every Application on a Server joins the same overlay network, `cloudgate`. A private web service is on that network and nowhere else:

- **Any Service on that Server reaches it**, including Services of other Projects on the same Server. Private means by network alone. Cloudgate asks a caller for no token, so if the API must know who calls it, it checks that itself.
- **Nothing outside the Server reaches it.** It has no Domain, so Traefik routes nothing to it, and it publishes no port on the Server.

So Cloudgate refuses each way in from outside, from the console, the API and MCP alike:

- **A Domain.** A plan gives it no generated Domain, and adding one is refused.
- **A published port**, whether as a port on the Advanced tab or as `Ports` in its Docker Swarm endpoint spec.
- **Previews.** A preview is reached at its own Domain, so neither pull-request previews nor requested previews can be switched on, and a requested preview is refused.

With neither a Domain nor a published port, it can have no Uptime check either.

To serve it from outside, change its kind to `web` in the Project config. That plans a destroy and a create, so it is replaced, as the next section explains.

## Its internal address

Other Services reach it at its **internal address**:

```
http://<appName>:<port>
```

`<appName>` is the Service's internal name, which Cloudgate generates (for example `app-k3x9qa`). It is not its Config name. The console shows the whole address, with a copy control, in the Application card beside each of the Service's tabs and on its Domains tab, and `GET /applications/:id` and the MCP `get_service` tool answer it as `internalAddress`.

The address is a base URL with no path. Use it whole.

### Using it from another Service

Until Services can be linked in the Project config, you type the address into the variable the calling Service reads the URL from:

1. Copy the internal address from the private web service's Application card.
2. On the calling Service's Variables tab, set the variable it reads, for example `API_URL=http://app-k3x9qa:4000`, and list the name under the caller's `env:` in the config.
3. Deploy the caller.

When links arrive, the value a link hands over will be this same address, so a value typed now will not have to change.

### When the address changes

The address belongs to the Service, so it changes only when the Service is replaced:

- **A kind change** between `web` and `web-private` is a destroy plus a create, confirmed by the Service's name. The new Service has a new internal name, and so a new address. A `web` that becomes a `web-private` loses its Domains with it.
- **A rename in the config** is also a destroy plus a create.

After either, copy the new address into each caller's variable.

A change to `port` keeps the Service and changes only the port in the address.

## In a Cloud account

### On AWS

In an Environment whose Deploy target is an AWS Cloud account, a `web-private` runs on ECS Fargate. It is the same definition as a `web` on ECS, with private DNS in place of the load balancer:

- **It keeps** its own ECR repository, task definition, task role, one SSM parameter per variable, CloudWatch log group, and an ECS service with Cloudgate's replica count, in the Environment network's public subnets. Building, variables, linked buckets and logs work as they do for a `web`.
- **It has no** target group, listener rule, `load_balancer` block or Domain. A Domain, a published port and previews are refused, as on a Server.
- **Its security group lets in only its `port`, over TCP, and only from the Environment network's own VPC range** (`10.80.0.0/16`), where every `web`, worker and Cron run of the Environment sits. The public load balancer is not a source, so nothing outside the Environment reaches it, the internet included.

#### Its address on AWS

Other Services of the same Environment reach it at:

```
http://<Config name>.cloudgate.internal:<port>
```

For the `api` above, that is `http://api.cloudgate.internal:4000`. Unlike on a Server, the host is the entry's **Config name**, not a generated internal name, so the address is known before the first deploy. The console shows it, with a copy control, in the Application card and on the Domains tab, and the API and MCP answer it as `internalAddress`.

Because the Config name is a DNS label here, a `web-private` on AWS whose Config name ends in a hyphen (`api-`) is refused at plan, naming the entry, before anything is made. Rename it without the trailing hyphen. Every other Config name is already a valid label.

It is a base URL used whole, exactly as on a Server: type it into the caller's variable (`API_URL=http://api.cloudgate.internal:4000`) and never split it into a host and a port. When links arrive, the value a link hands over will be this same address.

The address resolves only inside the Environment network. Services of another Environment, even in the same AWS account and region, cannot resolve or reach it: each Environment network has its own namespace on its own VPC.

#### How the name resolves

Each Environment network holds one **private DNS namespace**, `cloudgate.internal`, made with AWS Cloud Map on the network's VPC:

- **The first plan that creates a `web-private` in the network adds the namespace** to the network's step, at about **$0.50/month** (the private hosted zone Cloud Map makes for it). A later `web-private` does not add it again.
- **It stays after the last `web-private` is gone**, so a later one does not make and unmake it, and it is removed only with the Environment network itself.
- The network's plan and its drift read show it like the network's other resources, and when the network's record is lost, its next plan takes the namespace back into Cloudgate's record by its tags, as it does them.

Each `web-private` has its own **discovery service** in that namespace, named after its Config name, which ECS fills with one `A` record per task. A Delete of the `web-private` removes its discovery service and leaves the namespace.

#### Two things to know about DNS

- **With no `HEALTHCHECK`, a task is listed before it listens.** ECS lists only healthy tasks, and a task with no container health check counts as healthy as soon as it is running, which can be a few seconds before the server inside it accepts connections. Callers can see brief connection errors right after a deploy. Give the image a `HEALTHCHECK` that tests the port; Cloudgate copies it into the task definition at each deploy, and ECS then lists a task only once that check passes.
- **For a few seconds after a deploy, a caller can still reach an old task.** The records live for 10 seconds, so a caller's resolver can hand out the address of a task that is being stopped until its cache expires. Retry a failed call once, or keep connections short, if that matters.

Health, Deploy, Stop, Start, the Runtime log, the plan's lines, drift on Check for changes, and Delete work as they do for a worker on ECS (`docs/running-a-worker.md`, "On AWS"). Stopping still bills the Environment network, the namespace, the stored images and the stored logs.

Switching an entry between `web`, `web-private` and `worker` on AWS is a destroy plus a create confirmed by name, as on a Server, so a public Service never quietly becomes private, or the reverse.

The deploy role needs policy version 2 of the setup template for this: Cloud Map's namespace and services, and making the Route 53 hosted zone a private namespace needs, allowed only when Cloud Map makes it for the role (`aws:ViaAWSService`), so the role makes no hosted zone of its own and deletes none. A Cloud account whose role was checked at version 1 shows **permissions out of date**, naming the actions it lacks; update the role from the new template and check it again.

### On Google Cloud

In an Environment whose Deploy target is a Google Cloud account, a `web-private` runs on Cloud Run. It is the same definition as a `web` on Cloud Run, with internal-only ingress in place of the load balancer:

- **It keeps** its own Artifact Registry repository, service account, one Secret Manager secret per variable, and a Cloud Run service with its copy range. Building, variables and logs work as they do for a `web`.
- **Its ingress is `INTERNAL_ONLY`**, with Cloud Run's invoker check off, so callers send no token. Only calls from the Environment network's own VPC are let in; the internet, your laptop and other Environments get a 404.
- **It has no** serverless NEG, backend service or Domain. A Domain, a published port and previews are refused, as on a Server and AWS.

#### Its address on Google Cloud

Other Services of the same Environment (`web`s, Workers and Cron runs alike) reach it at its own Cloud Run URL:

```
https://<service>-<project number>.<region>.run.app
```

`<service>` is the name Cloudgate gave its Cloud Run service (`cloudgate-…`), so the address is known only once its first deploy has applied. Cloudgate reads it from the service's `urls` and shows it, with a copy control, in the Application card and on the Domains tab; the API and MCP answer it as `internalAddress`. Google also lists an older form of the same address, `https://<service>-<hash>-<region code>.a.run.app`; it reaches the same service the same way, but use the one Cloudgate shows.

It is a base URL used whole: type it into the caller's variable (`API_URL=https://cloudgate-…-123456789012.europe-west1.run.app`) and never split it. It is HTTPS on port 443, on Google's certificate, whatever `port` the container listens on. A `web-private` has no Output yet, so the caller types it.

**A new one answers 404 from inside for a few minutes.** For about 1.5 to 3.5 minutes after a `web-private` is first made, callers inside the Environment get the same 404 an outside caller gets, then 200 for good: Google is still rolling out its settings. The deploy does not wait for it. Allow a few minutes before treating a 404 from a caller as a failure.

#### How the name resolves

Each Environment network that has needed one holds a **private DNS zone for `run.app`** (ADR-0045), made with Cloud DNS on the network's VPC, whose `*.run.app` and `run.app` records point at `private.googleapis.com` (`199.36.153.8`–`199.36.153.11`). Every Service already sends private ranges into the network, and the network's subnet has Private Google Access on, so the call reaches Cloud Run as internal. No Service's egress changes and no Cloud NAT is made.

- **The first plan that creates a `web-private` in the network adds the zone** to the network's step, as "Private DNS zone `run.app`: create, for this Environment's Private web services, about $0.20/month". A later `web-private` does not add it again.
- **It stays after the last `web-private` is gone**, and is removed only with the Environment network itself. The network's plan and its drift read show it like the network's other resources.
- **Inside the Environment, every `*.run.app` lookup goes through Private Google Access**, including calls to your own public `web`s and to other projects' Cloud Run services. Those still work: a public service answers from inside the Environment as from outside.

No image `HEALTHCHECK` is copied: a Cloud Run probe is HTTP, TCP or gRPC only, and the plan notes it once, as for a `web` on Cloud Run. Health, Deploy, Stop, Start, the Runtime log, the plan's lines, drift on Check for changes and Delete work as they do for a `web` on Cloud Run. Stopping still bills the Environment network, the zone and the stored images.

Switching an entry between `web`, `web-private` and `worker` on Google Cloud is a destroy plus a create confirmed by name, as on a Server and AWS.
