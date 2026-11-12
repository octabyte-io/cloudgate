# Cloudgate owns the infrastructure state, in its own database, and nobody reads it raw

Status: accepted. Built in parts: the state, its login and the runner; the run pool; recovery by tag; the resource list and Rebuild from the cloud.

OpenTofu needs a record of what it made in a Cloud account ([ADR-0030](0030-a-cloud-accounts-resources-are-made-by-opentofu-a-servers-by-the-deploy-engine.md)). That record, the **Infrastructure state**, is Cloudgate's: Cloudgate stores it, locks it, encrypts it and repairs it. It is never the operator's file, never in their bucket, and never handed to them. It holds secrets, such as a database password in a task definition, so ADR-0006 and ADR-0019 bind it.

**1. One state per Service and per Environment network.** Each Service in a Cloud account has its own state, holding its listener rule, target group, security group, certificate and the rest. Each **Environment network** has one, holding the network and the load balancer. One broken state never blocks another's deploy. A Service's run never opens another state: after the network is applied, Cloudgate saves the network's ids (not secrets) in its own tables and passes them in. A state is removed only once everything in it is destroyed, so a Delete that could not finish keeps its state, and Retry still knows what is left.

**2. It lives in Cloudgate's own database, behind its own login.** OpenTofu's `pg` backend, in a schema of its own, `infrastructure_state`. Cloudgate's migrations create the schema and tables (`skip_*_creation`), so `tofu` creates nothing. `tofu` connects with a **separate database login** that can reach only that schema, because `tofu` and its provider are the least trusted code on the host. `install.sh` and the upgrade path create that login, `cloudgate_state`, and after every migration grant it `deploy/opentofu/state-login.sql`: OpenTofu's table and its sequence, nothing in `public`, no `CREATE`. Beside the state, a row in Cloudgate's own tables names its owner (a Service or an Environment network) and the OpenTofu and provider versions that last wrote it.

**3. Nobody reads a raw state.** Not through the console, the API or MCP; not an Agent, not an owner (ADR-0019). What a person sees is a **resource list** on the Service or the Environment network: type, the cloud's id, region and tags, never a setting's value. It needs `service: ['read']` for a Service's state and `environment: ['read']` for a network's. Someone leaving Cloudgate finds every resource by its tags.

**4. One run per state, and no force-unlock.** Cloudgate never starts two **Cloud runs** on one state: two runs of one Service never overlap, and a run that changes the Environment network holds back every other run in that Environment. OpenTofu's Postgres advisory lock is only the safety net. A run waits briefly for it (`-lock-timeout=10s` on plan, apply, untaint and `state rm`), and retries making its state's workspace a few times, but only to ride out the one key OpenTofu's `pg` backend shares across every state in the schema: each state's lock also takes the backend's workspace-creation key (the negated FNV-32 of `infrastructure_state\0states`), and a run making another state's workspace holds it for that moment, so two runs on *different* states used to fail on each other at random (a per-state schema would not help, because advisory keys span the whole database). A state that is genuinely held — which, since Cloudgate never overlaps two runs of one state, can only be a stray process — still fails once the wait is up ("another run is using this state"), and is never forced. If the shared key outlasts the wait, the run fails in its own words, as the state backend being busy, not as another run on this state. The lock frees itself when its run's connection closes, so it can never outlive its run, and there is no force-unlock to build or to misuse. A saved plan made before the state changed is refused at Apply.

**5. A run cut off part-way is never re-run by itself**. A Cloud run is a child of the backend on the platform host. On SIGTERM the backend waits for `tofu`, which finishes or cancels the calls in flight and saves the state; the unit's `TimeoutStopSec=5min` bounds it. A run still `running` at start-up ends as `error`, saying a restart cut it off. Re-running it could loop on a host that ran out of memory, and would spend money from a plan nobody looked at. The next deploy's plan shows what was already made.

**6. Everything made is tagged, and every plan recovers by tag.** Four tags (ids only, never names or secrets): `cloudgate:cloud-account`, `cloudgate:environment`, `cloudgate:state`, `cloudgate:address`, plus a readable `Name`. The first three are the provider's `default_tags`; `cloudgate:address` differs per resource, so it and the `Name` go in each resource's own tags, and every taggable resource still carries all four. Every plan also searches the account by the state's tag and compares:

- found, at an address the plan would create: shown as **adopt** (OpenTofu import), so nothing is made twice;
- found, but no line wants it: named as "found in the account, in no state", left for the operator to remove;
- in the state but gone from AWS: ordinary drift, made again;
- the row missing: the plan starts empty and adopts by tag;
- the row unreadable (corrupt, or `APP_ENCRYPTION_SECRET` changed): never written over quietly. The run fails, naming the state. **Rebuild from the cloud** (`service: ['update']`, or `environment: ['update']`, confirmed by name) discards the row and plans an adopt-by-tag.

**On Google Cloud the mark is the fixed name, plus labels where Google takes them** (amended by the Google Cloud spec; walked live).
- Google refuses `:` in a label key. So the first three tags become the labels `cloudgate-cloud-account`, `cloudgate-environment` and `cloudgate-state`, valued by each id's 12-character key.
- `cloudgate:address` has no twin, because each thing's fixed name, `cloudgate-<key>[-<part>]`, already says which address it is, and Google never lets that name change.
- A `description` names the full ids where the kind has one.
- The walk confirmed which kinds keep the labels: the global address, the Cloud Run service, the Artifact Registry repository, each secret, the Certificate Manager certificate, map and map entry, and the Cloud SQL instance (as `settings.user_labels`).
- Networks, subnets, firewall rules, proxies, URL maps, network endpoint groups, backend services and service accounts take none at the pinned provider. Each plan and each Delete finds these by name prefix instead.
- The global forwarding rules could take labels at 8.6.0, but the definition does not set them yet, so they too are found by name.
- What Google itself makes for a database carries no label of Cloudgate's: its Private Service Connect addresses and forwarding rules (`sca-auto-…`), and Cloud SQL's private DNS zone. They go with the instance, and the walk saw each of them go. The label search after an Environment's Delete therefore names only what kept a label.

What a tag search cannot find is checked by id. An IAM role (each Service's task role, [ADR-0032](0032-a-bucket-hands-over-the-same-outputs-on-every-target-and-on-a-cloud-its-access-is-the-services-own-role.md)) is never found by one, nor is a resource that carries no tag (an association, a policy attachment): the resource list marks each "not findable by tag". The network interfaces AWS makes are in no state at all; a Delete looks for them by the security groups the state holds ([ADR-0038](0038-a-cloud-delete-that-cannot-finish-keeps-its-row.md)). **No history** is kept: the `pg` backend holds only the latest state, recovery by tag is the way back even when every copy is lost, and each old copy would be one more copy of the secrets.

## The deliberate exception to ADR-0006

The state is **not** stored as `enc:v1:` values. It is encrypted by OpenTofu's own whole-state and plan-file encryption: `aes_gcm`, `enforced = true`, with a key derived from `APP_ENCRYPTION_SECRET` under its own label, `cloudgate:infrastructure-state:v1`. The key reaches `tofu` only through `TF_ENCRYPTION`, never a file, and each run's working folder is deleted when the run ends. As ADR-0006 requires, there is one dedicated secret and no fallback key.

**Why the exception:** using `enc:v1:` would mean an HTTP state backend of Cloudgate's own, and with it a lock that frees itself when its holder dies. That lock is one of the main reasons OpenTofu was chosen (ADR-0030). A future change that "brings the state in line with ADR-0006" by writing its own backend gives that up, and must not.

## Consequences

- The instance backup holds every state. Restoring an older `pg_dump` leaves the states behind the cloud; item 6 repairs that on the next plan. `docs/deploy.md` §8 says so.
- Changing `APP_ENCRYPTION_SECRET` makes every state unreadable, and each needs **Rebuild from the cloud**.
- A Cloud run whose `tofu` hangs while alive holds its state as long as it lives; what ends it is settled: the install-wide Cloud run time limit (60 minutes by default) sends one interrupt and a kill 5 minutes later, as does Stop the run, so a lock never outlives its run by more than the time limit plus 5 minutes.

**What reopens this ADR:** OpenTofu dropping the `pg` backend or its encryption, a need for state history (an audit rule, say), or a second tool that must read the same state.
