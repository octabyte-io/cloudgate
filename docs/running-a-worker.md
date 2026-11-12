# Running a worker

A **Worker** is a Service that runs all the time and serves nothing: a queue consumer, a mail sender, a process that polls something and acts on it. You describe one in the Project config as `kind: worker`. On a Server it is an ordinary Application with no Domain and no preview.

---

## Describing one

A `worker` takes the same fields as a `web` except `port`:

```yaml
version: 1
services:
  mailer:
    kind: worker
    description: Sends the queued mail
    source:
      github: acme/shop
      path: /mailer
    build:
      type: dockerfile
    command: node
    args: [mailer.js]
    size: small
    env: [QUEUE_URL, SMTP_PASSWORD]
```

The fields are `source`, `build`, `command`, `args`, `size`, `env`, `build_args`, `build_secrets` and `description`. `command` is optional, as it is on a `web`. Without it, the image's own command runs.

- **`port` refuses the plan**, naming `<service>.port`. A worker listens on nothing anyone is promised. If it serves HTTP, it is a `web`.
- **There is no `replicas` field.** How many copies run is set per Environment in the console, as for any Application.
- **A `web` with no `port` is still a `web`.** Its port defaults to 3000 and it gets a Domain. Nothing turns a `web` into a `worker` except writing `kind: worker`.

## What a plan does with it

A plan that creates a `worker` creates an Application recorded as a worker and queues its first Build deployment. It gives it **no generated sslip.io Domain**, which a `web` gets.

Changing an entry's kind between `web` and `worker`, either way, is a **destroy plus a create**. The plan lists both steps, and Apply asks you to confirm the Config name. Everything Cloudgate kept for the old Service starts again, variable values included.

## What it has, and what it does not

A worker's Deployments, logs, mounts, Schedules, published ports, start and stop, and replica count work as they do for any Application.

A worker never has a **Domain** or a **preview**, either a pull request's or a requested one. Adding a Domain, turning on previews, or asking for a requested preview (over the API or through an Agent's `create_preview`) is refused with `409` and the code `KIND_TAKES_NO_DOMAIN` or `KIND_TAKES_NO_PREVIEWS`:

```
A worker takes no Domain: it serves no HTTP. To serve HTTP, change its kind to web in the Project config
```

The console's Domains and Previews tabs of a worker say the same in place of the controls.

## What "running" means for a worker

**Running means the process is up, not that it is doing its work.** A worker's Deployment succeeds, and the worker reads as healthy, when its Swarm tasks are running and, if its image sets a container `HEALTHCHECK`, that check passes. Cloudgate does not know whether the worker is taking jobs off its queue, keeping up, or stuck in a loop that never exits.

With no Domain there is no HTTP Uptime check and no Error rate for it either. If you need to know that the work is being done, give the image a `HEALTHCHECK` that tests it, such as a check that the last processed job is recent, or watch the worker's logs and the queue it reads.

## On AWS

In an Environment whose Deploy target is an AWS Cloud account, a `worker` runs on ECS Fargate. It is the same definition as a `web` on ECS, minus everything that routes traffic to it:

- **It keeps** its own ECR repository, task definition, task role, one SSM parameter per variable, CloudWatch log group, and an ECS service with Cloudgate's replica count, in the Environment network's public subnets with a public IP. Building, variables, linked buckets and logs work as they do for a `web`.
- **It has no** target group, listener rule, `load_balancer` block or Domain. The plan's AWS lines list only what it really gets.
- **Its security group lets nothing in**, and lets it reach anywhere out, so it can pull its image, read its variables, reach its databases and call the internet.

**Health on ECS is the same rule as on a Server.** If the image sets a `HEALTHCHECK`, Cloudgate copies it into the task definition at each deploy, and ECS replaces a task that fails it. With no `HEALTHCHECK`, a task counts as healthy while it is running. **Running is not the same as working**: ECS knows that the process is up, not that it is taking jobs off its queue.

A deploy succeeds when ECS's rollout completes. A command that exits at once fails the deploy, and the Deployment log quotes the stopped task's reason and its last log lines.

Stop (the running count to 0), Start, Reload, Deploy, the Runtime log, the plan's lines, drift on Check for changes, and Delete all work as they do for a `web` on ECS. Stopping still bills the Environment network, the stored images and the stored logs.

**The Environment network comes with its load balancer.** The first cloud Service in an Environment makes the whole Environment network, even when that Service is a Worker. An Environment that holds only Workers therefore still pays about **$24/month** for an idle load balancer that nothing uses: an Application Load Balancer's hourly charge, which it pays whether or not anything reaches it.

Switching an entry between `web` and `worker` on AWS is a destroy plus a create confirmed by name, as on a Server.

## On Google Cloud

In an Environment whose Deploy target is a Google Cloud account, a `worker` runs as a **Cloud Run worker pool**, Google's resource for a process that serves no requests. It is built by the same definition as a `web` on Cloud Run, minus everything that routes traffic to it:

- **It keeps** its own Artifact Registry repository, service account, one Secret Manager secret per variable, and Direct VPC egress for private ranges only on the Environment network's subnet, so it reaches the Environment's databases. Building, variables and secrets work as they do for a `web`.
- **It has no** ingress, port, URL, serverless network endpoint group, backend service or Domain. Nothing can call it. The plan's Google lines list the repository, service account, secrets and worker pool, and no load-balancer piece.
- **Its `replicas` are the worker pool's instance count.** Google's worker pool has no automatic scaling, and its CPU is always on: it bills for each instance while it runs.
- **Its size** lands on a pair a worker pool takes. Google's documented floor for CPU that is always on is 1 CPU with at least 512 MB, so a smaller size (such as `xsmall` or `small`) is rounded up, and the plan says so; it is never refused. The walk by hand confirms that floor in a real project.

**Healthy means running.** There is no probe: a Worker has no port to probe, and a Cloud Run probe can only make an HTTP, TCP or gRPC request, so it cannot run an image's `HEALTHCHECK`. Cloudgate does not copy one, writes no check from it, and a Worker counts as healthy while its instances are running. When a Service's live image has a `HEALTHCHECK`, each plan of its Environment says once, naming it, that Google Cloud does not run it; this holds for every always-running Service there, a `web` and a Worker alike. **Running is not the same as working**: Google knows that the process is up, not that it is taking jobs off its queue. Watch its Runtime log and the queue it reads.

A deploy builds and pushes the image, applies, sets the instance count to `replicas`, then waits until the worker pool's latest revision is ready and running that many instances. A revision that fails to start (a command that exits at once, say) fails the deploy, and the Deployment log quotes Google's condition message and the worker pool's last log lines.

**Stop sets the instance count to 0, and a stopped Worker bills nothing** for its worker pool, so Stop shows no "still bills" warning. Start sets the count back to `replicas`. Both are direct calls, never a Cloud run, and the definition ignores the count, so a stopped Worker never shows as drift. Reload starts a fresh revision of the same image. The Runtime log is read from Cloud Logging, the worker pool's own entries (`resource.type="cloud_run_worker_pool"`), as a `web`'s is. The plan's lines, drift on Check for changes, and Delete work as they do for a `web` on Cloud Run, and the check after a Delete looks for a leftover worker pool by its fixed name.

**The Environment network comes with its load balancer.** The first cloud Service in an Environment makes the whole Environment network, load balancer included, even when that Service is a Worker. An Environment that holds only Workers therefore still pays about **$18/month** for an idle load balancer that nothing uses: its forwarding rule's hourly charge, Google's price for a load balancer at rest, which is lower than the AWS one's $24; making it only for a `web` would change how every Environment network is made, and is left for later.

A Domain or a preview on a Worker is refused on Google Cloud as everywhere. Switching an entry between `web` and `worker` on Google Cloud is a destroy plus a create confirmed by name, as on a Server and AWS.
