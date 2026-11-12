# A bucket hands over the same Outputs on every target, and on a cloud its access is the Service's own role

Status: accepted. The Outputs were first built on a Server, then on AWS, with the task role's access. Accepted once the release lane applies the task role's bucket access against moto and shows a hand change to it as Drift (`moto-lane.moto-spec.ts`), and the walk by hand has a `web` write and read its bucket on AWS with the key variables unset and on a Server with its key (`docs/aws-walk-by-hand.md`, 5e and 7). **Amended:** on Google Cloud a bucket's access is its own key, as on a Server, not the Service's identity.

A `web` called `api` reads and writes files in a `bucket` called `uploads`, and one Project config must deploy it to an AWS Environment and to a Server. On a Server the bucket is a self-hosted S3-compatible server, which only knows access keys. On AWS a task can get short-lived credentials from its own IAM role, with no key at all.

**A bucket hands out six Outputs (ADR-0031), the same names on every target:**

| Output | On AWS | On a Server | On Google Cloud |
|---|---|---|---|
| `name` | the bucket's real name, Cloudgate's | the same | the same, `cloudgate-<service key>-<8 random>` |
| `region` | the Environment's region | `us-east-1`, the one region the server accepts (ADR-0037) | `auto` |
| `endpoint` | `https://s3.<region>.amazonaws.com` | the bucket's Domain while it has one, else the server's internal URL (ADR-0037) | `https://storage.googleapis.com` |
| `access_key_id`, `secret_access_key` | **no value** | the bucket's key | the bucket's HMAC key |
| `path_style` | `"false"` | `"true"` | `"true"` |

There is no default Output and no `url`, because no SDK reads one. Every Output is a secret, as ADR-0031 says. A key is encrypted at rest (ADR-0006) and shown only as "set" (ADR-0019).

**On a cloud, access is the linked Service's own identity.** On AWS, Cloudgate makes one task role per Service. A variable linked to an Output that has no value on this target is **left unset**, and the plan says "on AWS the task's role gives access". With the variable unset, the SDK's default credential chain falls back to the task role, so `{ AWS_ACCESS_KEY_ID: uploads.access_key_id }` works on both targets.

**On Google Cloud, access is the bucket's own key.** The S3 SDK cannot use a Cloud Run service's own identity, which only Google's client libraries read, so the rule above would break an S3 SDK app on Google and with it "one config, unchanged". Google gives an S3-style (HMAC) key only to a service account and scopes it by that account's IAM, so each bucket gets **its own service account**, holding `roles/storage.objectUser` on that one bucket and nothing else, and **one HMAC key**, shared by every Service that links the bucket, as on a Server. The linking Service's own service account gets no access to the bucket: the key is the one way in. Rotation copies a Server: a console action makes a new key, redeploys every linking Service, then turns the old key off and deletes it. The key and the bucket's service account are always destroyed by the bucket's Delete, even when the bucket itself is kept for its files.

**A link is the access.** A Service that links any Output of a bucket gets read and write on that bucket only: get, put, delete and list its objects, and multipart uploads. It never gets the bucket's settings (policy, CORS, versioning, deleting it), and never a bucket it did not link. Any number of Services may link one bucket. On a Server they share **one key per bucket**, so an Output stays a property of its source, as ADR-0031 requires. There is no read-only link, because `version: 1` has no place to say it.

## Considered options

- **An IAM user and access key per bucket, on AWS too.** Rejected: the key never expires, it lives in the task definition and in state, a leaked key works from anywhere, and the deploy role would need `iam:CreateUser` and `iam:CreateAccessKey`. Its one advantage is that apps which pass keys to their S3 client by hand keep working. That is not worth a long-lived secret on every AWS bucket.
- **A key per linking Service on a Server.** Rejected: an Output's value would then depend on who links it, which breaks ADR-0031, and a Service linking two buckets would get two keys for one SDK client. The cost of a key per bucket is that you cannot revoke one Service without changing the key for every Service that uses it.
- **On Google, the Service's own service account and no key** (this ADR's first rule). Rejected by the amendment: an S3 SDK app fails on Google, so one config no longer deploys unchanged.
- **On Google, the key and also the Service's own identity.** Rejected by the amendment: two ways in, two things to revoke, and the second serves only apps that already cannot run on AWS or a Server.
- **One task role per Environment.** Rejected: every Service could reach every bucket in the Environment.

## Consequences

- **On Google a bucket's key is a long-lived secret** in the bucket's encrypted Infrastructure state (ADR-0036), which already holds a Cloud SQL password. The deploy role needs `roles/storage.hmacKeyAdmin`, which `storage.admin` does not include. Whether newer S3 SDKs' default checksums work against Cloud Storage is checked by the Google walk; if they fail, the plan notes, on Google, that `AWS_REQUEST_CHECKSUM_CALCULATION` and `AWS_RESPONSE_CHECKSUM_VALIDATION` should be `when_required`.
- **The Output names are part of `version: 1`.** Renaming or removing one needs a new config version.
- **An Output may have no value on a target.** A bucket's key on a cloud is one case (a redis's `ca` on a Server, is another). For a bucket's key, the plan does not refuse the link: it notes that the variable is left unset.
- **An app that passes keys to its S3 client by hand breaks on AWS** (not on Google, where the key has a value). The plan's note warns about it. Such an app has to let its SDK find credentials by itself.
- **The deploy role creates IAM roles.** Slice 3's permission table gains `iam:CreateRole`, `iam:PutRolePolicy`, `iam:DeleteRolePolicy`, `iam:DeleteRole`, `iam:TagRole` and `iam:PassRole` (with `iam:PassedToService = ecs-tasks.amazonaws.com`). They are limited to a `/cloudgate/` path and name prefix and fenced by a required permissions boundary, so Cloudgate cannot make a role stronger than the boundary. The exact policy and its connect check belong to slice 3's map.
- **A presigned URL made with task-role credentials** stops working when those credentials expire, even if its own expiry is later.
- **Key rotation on a Server** is a console action, decided with the bucket server (ADR-0037).
