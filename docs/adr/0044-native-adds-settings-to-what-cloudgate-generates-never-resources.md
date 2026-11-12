# Native adds settings to what Cloudgate generates, never resources

Status: accepted. The decisions were made separately; this ADR states them as one rule and adds nothing to them.

A Project config entry says what a Service is in the config's own words: its kind, `size`, port, variables, Domains. That language is the same on every Deploy target, so it can't say everything a target can do. An operator who needs a Docker health check, an ECS health-check grace period, a `db.r7g.xlarge` class or a Google Cloud Run service closed to `run.app` needs a way to say it in the target's own words. That way is **Native settings**: a `native` block on the entry, one block per target (`native.docker`, `native.aws`, `native.gcp`), of which only the Environment's target's block is used.

**Decided: a native block adds settings to the things Cloudgate already generates for the Service. It never adds a thing of its own, and it never takes a setting Cloudgate depends on.** Everything below follows from that sentence.

## The block

1. **Docker is a closed list of seven keys**: `Labels`, `HealthCheck`, `RestartPolicy`, `UpdateConfig`, `RollbackConfig`, `StopGracePeriod`, `Ulimits`, spelled and valued exactly as the Docker Engine API takes them. It is the home of the Swarm settings that already existed per Service, not a second copy. Placement, networks, published ports, mode and replicas stay Cloudgate's, because they name a host or differ per Environment. Any other key is refused by name, and a "never" list (`Privileged`, `CapAdd`, `Mounts`, `Networks`, `EndpointSpec`, `Mode`, `Placement`, `Resources`) gives its reason.
2. **A cloud block is keyed by full OpenTofu address** (`native.aws."aws_ecs_service.service"`, `native.gcp."google_sql_database_instance.database"`), the address the plan's cloud lines show. Only what the Service makes once can be named. What it makes per Domain or per variable belongs to those and is refused whole. An address the Service does not make, or does not make right now, is refused and named, never ignored. The local names are therefore a promise: a rename goes through a rename table (rule 10).
3. **Merge, not replace.** Cloudgate lays native over its own definition before it writes `main.tf.json` or the Swarm spec: a plain value replaces Cloudgate's; a block the provider allows once is merged field by field; a map (`Labels`, `engine_configs`, `annotations`) key by key; a real list is replaced whole, with no appending and no pointing at one item. The one container a `web` runs is written as one object in its platform's spelling (ECS `container_definitions`, Cloud Run `template.containers`) and merged into Cloudgate's container.
4. **No meta-arguments.** `lifecycle` (all of it), `depends_on`, `count`, `for_each`, `provider`, `provisioner` and `connection` are refused. They are instructions to the tool, not settings of the thing, and `ignore_changes` would let a console change live with no file showing it (ADR-0029).
5. **Checked on every plan, on every target**, against what is committed: Docker's key list, and the pinned provider schema (`tofu providers schema -json`, trimmed to the generated types and committed beside the provider lock file, a test keeping the two versions equal). A typo in `native.aws` shows on a Docker staging plan. A deprecated argument warns; one that has gone is refused, naming the provider version. A value only the target can judge fails that Service's Deployment and names the native path.

## Absent means default

6. **The config always owns its native settings, written or not.** A key that is absent, or taken out, is Cloudgate's default for the kind, merged field by field; never the last value it had, which no file would show (ADR-0029). The plan shows each native change as its own line under the Service's change, marked native and in the file's spelling, with no extra confirmation, and warns on a change Cloudgate knows takes the Service down. Two named exceptions to "back to the default", both so that deleting a line never shrinks or resets a production resource: a removed size-bearing value falls back to `size`, or with no `size` stays where it is (rule 12); a removed value of a setting the console owned stays where it is (rule 10).

## Locked settings

7. **The rule**. A native setting is locked if Cloudgate itself depends on it or it reaches beyond the Service, in five categories: (a) how Cloudgate finds and deletes what it made, (b) routing and ownership, (c) the shared network and other tenants, (d) who the Service runs as, (e) whether a resource can be reached from outside. A setting that can only hurt its own Service stays open. On top of the five:
   - **The stop-first exception.** On a database, `UpdateConfig.Order` and `RollbackConfig.Order` must be `stop-first`: two copies writing one volume lose data for good. It is the one named exception to "only hurts its own Service".
   - **Reach may be narrowed, never widened**. Closing a Google `web`'s `run.app` address (`ingress: INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`) is open; widening a Private web service is locked. This is how (e) reads on every cloud.
   - **Anything in Cloudgate's own `ignore_changes`, or set by Cloudgate outside the plan** (the copy count Stop and Start change), is locked, so a native value is never accepted and then silently not applied.
   - **`tags` / `labels`, the location and project, the mark Cloudgate writes, and deletion protection** are locked on every address.
8. **Form.** Docker is an allow-list of keys with a short deny-list of values inside them (`traefik.*`, `com.docker.*`, the reserved `io.cloudgate.*` label, and stop-first on databases). **A cloud is a deny-list**: every provider argument is open unless locked, so native stays an escape hatch for settings nobody foresaw. The per-address entries are not listed here; on AWS they include `apply_immediately` and ElastiCache's `engine`, both confirmed locked.
9. **Refused by path, never stripped.** One list per target is read in three places: the plan refuses a locked value, the console's save refuses it, and the deploy refuses it for old stored rows. The refusal names the full path in the file's spelling and a one-line reason (`native.docker.Labels."traefik.http.routers.x": refused - traefik labels can route another tenant's domain`). A locked value is never silently dropped or written over.
10. **Side rules on every cloud** (carried to Google):
    - **Settings the console owns today** (storage, multi-AZ, backup days, replicas, snapshot days) are open: native wins, the console can't change a value native sets, and removing it leaves the value where it is.
    - **A data-losing replace is refused by one rule**, not by per-setting locks: the plan refuses any native change OpenTofu would carry out as a replace of a postgres, a redis or a bucket, naming the path.
    - **A provider upgrade classifies its new settings before CI is green.** Every setting of every generated type, read from the committed schema (and, for the ECS container, the pinned `@aws-sdk/client-ecs` `ContainerDefinition`), is listed as locked with a reason or open. Unlisted fails CI.
    - **Renaming an address is guarded** by a committed snapshot of every generated address and a rename table: the config reader maps the old name forward and the plan warns.
11. **The census gate.** In `backend/test/coding-standards/`, read from the code's own lists: every `native.docker` key, every kind, every generated address and every provider setting must carry an entry (an empty entry with a reason counts), and an entry for something gone fails too. A new resource (slice 9's worker pool and job, for example) fails CI until its entries exist.

## Native and the config's own fields

12. **Native wins over size**. Docker has no native CPU or memory, since a size is already exact on a Server. On a cloud every size-bearing argument is open (`instance_class`, `node_type`, the Fargate task's and container's `cpu`/`memory`, Cloud Run `resources.limits`, Cloud SQL `tier`): native wins on that target, `size` still counts on every other, and the plan reads `pg-1 medium → db.r7g.xlarge (…), set by native`.
13. **Promotion**. A native setting becomes a config field only when it can be said the same way on every target, never because many configs use it. Once it does, the native form stays accepted and wins on its target, as with size, and the plan notes that the field exists. **Adding anything optional, a field or a Docker key, never moves the config's `version`**; only taking something away or changing a meaning does. A Docker key is admitted by a ticket that answers the Environment, tenant and lock tests, with its lock entry in the same change.
14. **No statement of its own**. Native settings are the Service's settings, so writing or applying them is checked as any change to the Service is (`service: ['update']`, and the step-by-step check for Apply). Safety comes from the locks and the plan, not from who applies.

## Rejected

- **OpenTofu override files.** They replace a nested block whole, so `health_check.path` would drop Cloudgate's `matcher`, and they accept `lifecycle`. Merging before `main.tf.json` is written gives the field-by-field rule on every target alike.
- **Passing unknown arguments through** (Pulumi's way). A typo would reach the cloud, or be dropped silently inside ECS's container JSON. Every plan checks against the committed schema instead.
- **Quietly overwriting a value** (Fly's way: apply native, then write Cloudgate's fields over it). A value the file shows but the target doesn't have is the gap ADR-0029 rules out. Locked values are refused by path.
- **Hand-written resources.** A native block that adds a resource would be something Cloudgate didn't generate, doesn't find, doesn't delete and has no lock entry for. Anything Cloudgate should make is a config field or a kind, decided on its own ticket. For the same reason Fargate Spot stays locked: unlocking it would change what Cloudgate builds, not add a setting.

## Consequences

- The Environment network (load balancer, VPC, Google's `run.app` DNS zone) has no native block, since no config entry describes it.
- Every generated address and its local name is now public. Renaming one, or adding a resource, is a census and rename-table change, not a refactor.
- Each Cloudgate upgrade that moves a provider pin carries the work of classifying that provider's new settings.
- Changes held for a maintenance window (`apply_immediately: false`), Redis OSS on AWS, Fargate Spot and a role that may change a Service but not its native settings are all out of this decision; each would be its own effort.

## What reopens this ADR

- a customer need that only a new resource beside the Service can meet, which would want a kind or a config field, not a wider native block;
- a target whose tool cannot be checked offline against a committed schema, which would leave rule 5 without a footing;
- a setting that must be locked for a reason none of the five categories covers.
