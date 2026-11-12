# A Cloud account's resources are made by OpenTofu, a Server's by the deploy engine

Status: accepted. Built in three parts: the pins and install, the runner, and the definitions.

When a Service's place is a Cloud account, Cloudgate creates, changes and destroys its cloud resources (the shared network, the load balancer, the ECS service and the rest) by writing an **OpenTofu** definition and running `tofu plan` and `tofu apply` as a separate program. When its place is a Server or the platform host, the existing deploy engine (`backend/src/deployment-engine/`) keeps doing the work, with no plan file, state or lock added. Both write the same Deployment row and log (ADR-0007, ADR-0020). Building the image, logs, Stop, Restart and the terminal are never OpenTofu's job on any target. So there are two engines on purpose, and "one tool for everything" is not something to fix.

**Why OpenTofu, and not Pulumi's automation API or direct AWS SDK calls**: it is the only one of the three that has all of these built in:

- it encrypts the whole state and the whole plan file, so ADR-0006 holds;
- its Postgres lock frees itself when the process dies, and the deployment queue is in memory, so restarts happen;
- its plan format is stable and versioned, and it reports drift.

Pulumi encrypts only the values marked secret, stores everything else as plain JSON, has a lock that can stay stuck after a crash, and its saved plan is experimental. With direct SDK calls, Cloudgate would have to build state, locking, planning, ordering, waiting and drift detection itself for every AWS resource type.

**Why the Server path stays as it is:** it already works and is tested (Traefik labels, log streaming, the terminal, Traces, Preview deployments, the ADR-0018 Delete). OpenTofu's Docker provider is small and community-run. Routing Servers through OpenTofu would add a plan, a state and a lock to the most-used path and replace none of the things OpenTofu doesn't do anyway.

**Licence rules, which a future change would otherwise be tempted to relax:**

- **Never Terraform's own binary.** From 1.6, Terraform is BSL 1.1, and that licence excludes a paid competing offering, which a paid-supported Cloudgate could be.
- **OpenTofu and its providers are run unmodified, as separate programs.** No patches and no forks. They are MPL-2.0, which is file-level copyleft, so running them unchanged puts no duty on Cloudgate's code.
- **Providers come from the OpenTofu registry** (`hashicorp/aws`, MPL-2.0).

This is not legal advice. The licences themselves are linked from the comparison above.

**Consequences:**

- The platform host carries about 215 MB of downloads: `tofu` plus the AWS provider.
- One `tofu plan` peaked at about 0.8 GB of memory, most of it the provider (measured offline with OpenTofu 1.13.1 and AWS provider 6.69.1). How many cloud runs may happen at once was decided separately: one install-wide limit, one unless the operator raises it, in a pool of their own apart from builds.
- Each Cloudgate checkout pins one OpenTofu version and one AWS provider version, with checksums, and only a Cloudgate change moves them. `install.sh` fetches and checks both, a Cloud run never downloads a provider, and versions move forward only: an older install refuses a state a newer one wrote. As built, `install.sh` puts them in a filesystem mirror, `deploy/opentofu/.terraform.lock.hcl` holds the provider's checksums, and every run uses a mirror-only CLI config and `init -lockfile=readonly`.
- **One provider, the pinned AWS one.** Nothing generated may need a second provider: the network's self-signed default certificate is made by Cloudgate and handed in as variables rather than by `hashicorp/tls`, which was never pinned.
- **Per cloud, one pinned provider set** (amended by the native settings spec, slice 6, T4; walked by hand on a live project). The rule above is per cloud: an AWS definition needs only `hashicorp/aws`, and a Google definition needs only `hashicorp/google`, pinned at **8.8.0** beside AWS's, with its checksums in the same `deploy/opentofu/.terraform.lock.hcl`. `install.sh` installs both into the same mirror, and `GOOGLE_PROVIDER_VERSION` restates the lock as `AWS_PROVIDER_VERSION` does. A Google Cloud run requires the Google provider and never AWS's, and an AWS run the reverse. Cloud Run's service-level `scaling` (`manual_instance_count`) is at `launch_stage` GA, which the live walk confirmed on 8.6.0. A pin change re-records the Google plan files from a walk. (Amended: slice 6 first pinned `hashicorp/google` at 8.6.0, because the spec's 8.8.0 was not released, with `hashicorp/google-beta` beside it at the same version, configured alike, for the Memorystore instance, whose token auth only the beta provider made. [ADR-0042](0042-a-redis-on-memorystore-has-no-password-it-is-reached-only-from-its-environments-private-network-over-tls.md) made the instance `AUTH_DISABLED`, which ended that reason, and the GA `google_memorystore_instance` of 8.8.0 has every argument Cloudgate writes and reads, so the pin moved to 8.8.0 and dropped `google-beta`. The walk of 2026-11-06 in the live project re-recorded every Google plan file on 8.8.0, and GA made the instance as written.)
- A change to the pins or to the generated definitions runs the moto lane before it merges, which re-saves the plan files the e2e suites replay (`docs/testing.md`), and is walked by hand against a real account before it ships (`docs/aws-walk-by-hand.md`). Google has no moto: a change to the Google pins or definitions is walked in a real Google Cloud project, which re-records the Google plan files the e2e suites replay (`docs/gcp-walk-by-hand.md`).
- A cloud `native` block is written with OpenTofu's argument names, not the cloud API's field names.

**What reopens this ADR:**

- an MPL-2.0 change to OpenTofu or its AWS provider;
- needing to patch either of them;
- keeping the two engines in step becoming harder than merging them.
