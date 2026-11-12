# A redis on Memorystore has no password; it is reached only from its Environment's private network, over TLS

Status: accepted. Part of "Redis on Memorystore". Found in the live walk. Built in `backend/src/cloud-accounts/gcp/definitions/memorystore-definition.ts`.

The spec had a `redis` on Memorystore for Valkey made with **token auth** (`TOKEN_AUTH`). Google makes the token with the instance, the provider does not expose it, and Cloudgate's Cloud run was to read it after the apply and hand it out as the `password` Output. The walk made the instance, then the read failed: `Permission 'memorystore.authTokens.list' denied`. That permission is **not grantable**. `gcloud iam list-testable-permissions` on the project and on the instance does not list it, and no predefined role holds it, not even `roles/owner`. Only the project owner's own key could read the token. So a custom role cannot hold what the read needs, and a `redis` on Memorystore could not be wired.

**Decided:** the instance is made with **`authorization_mode = AUTH_DISABLED`**. It keeps TLS (`SERVER_AUTHENTICATION`) with its own CA.

- Its `url` is `rediss://<host>:6379`, with no userinfo. `ca` stays the instance's own CA. Its `password` Output has no value: a variable linked to it is left unset, never set empty, as for a bucket's key on a cloud ([ADR-0032](0032-a-bucket-hands-over-the-same-outputs-on-every-target-and-on-a-cloud-its-access-is-the-services-own-role.md)).
- The Cloud run reads no token, and the Google client port has no call for one. Nothing is stored for one.
- The plan line for its create says it has no password and that only this Environment's private network reaches it, over TLS.

**What keeps others out instead.** The instance is reached only through its Private Service Connect endpoint. That endpoint sits in the Environment's own VPC, which is peered with nothing: each Environment has its own network on Google Cloud. The egress rule `psc-redis-ports` lets that network reach the endpoint's subnet on Redis's ports. So only that Environment's Services can connect, and always over TLS. AWS reaches ElastiCache the same way: from the Environment VPC's subnets, not per Service.

**Why not token auth.** Cloudgate cannot read the token. Asking the operator to read it by hand and paste it in would make the one Project config deploy differently on Google Cloud, and it would have to be done again whenever Google rotates the token.

**Why not IAM auth** (`IAM_AUTH`, with `memorystore.instances.connect`). The app would have to fetch a short-lived access token for itself and send it as the password, refreshing it before it expires. That is no plain `url`. The same Project config would then not deploy unchanged on a Server, on AWS and on Google Cloud, which is the slice's main promise.

**Why not wait** for Google to make `memorystore.authTokens.list` grantable. There is no date for it, and a `redis` on Memorystore would be unusable until then.

**Consequences.**

- **Any Service in the same Environment can connect**, wired to the `redis` or not, because no password stops it. That is the cost of this choice, and the plan line and `docs/linking-a-database.md` say so.
- A Service in another Environment, or anything outside Google Cloud, cannot reach the instance: no network route leads to it.
- Nothing was released with `TOKEN_AUTH` (the release gate on the stored Google plans still held), so no instance needs to move. `authorization_mode` stays in `ignore_changes`: Cloudgate never changes it on a made instance.

**What reopens this ADR:**

- Google making `memorystore.authTokens.list` (or a token read) grantable to a custom role. Token auth would then give the same plain `url`, now with a password;
- an Environment network on Google Cloud that is shared or peered with anything else, which would widen who can reach the instance.
