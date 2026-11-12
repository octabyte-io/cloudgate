# A bucket on a Server is its own Garage container

Status: accepted. First built as the bucket, its Garage and its key; its Outputs, Domain, key rotation, backups and Delete rules came later. Accepted once the release lane runs Garage at its pinned image with Cloudgate's config and drives it with the very bucket, key, grant, rotation and CORS programs a Server runs, reaching it through the object-storage port's real adapter (`test/object-storage/garage.moto-spec.ts`); the walk by hand has a `web` write to its Garage bucket and a presigned URL work through the bucket's Domain (`docs/aws-walk-by-hand.md`, 7).

One Project config must deploy a `bucket` to AWS and to a Server, and nothing provides one on a Server today. **On a Server, Cloudgate runs each `bucket` as its own Garage container (`dxflrs/garage`, pinned by Cloudgate), on the Environment's Deploy target, with its files on a Docker volume**, deployed, linked and deleted like a `postgres` entry. It hands over ADR-0032's six Outputs:

- **The key** is made by Cloudgate when it makes the bucket: one Garage key with read and write on that bucket only, never owner, so it cannot change the bucket's settings. It is encrypted at rest (ADR-0006) and shown only as "set" (ADR-0019). Cloudgate keeps its own admin credential per container, which no Service sees, to create the bucket and set its browser-upload origins. Garage takes CORS only through its S3 API from a key that owns the bucket, so setting the origins uses that admin access to make a key for the one request, owner on the bucket, and deletes it as soon as the request is done; no owner key is kept.
- **Rotating the key** is a console action on the bucket, with no schedule and nothing in the config: a new key, a redeploy of every Service that links the bucket (ADR-0031's redeploy), and only then the old key's removal. If a redeploy fails, the old key stays and the action names the Service; the Services already redeployed with the new key are deployed again with the old one before the new key is removed, so nothing loses access, and a new key one of them still needs after that is removed by the next rotation that succeeds.
- **`endpoint`** is the bucket's Domain while it has one, so presigned URLs and browser uploads work as they do on S3; a plan-created bucket gets a generated Domain as a `web` does. With every Domain removed it falls back to the internal URL, and the plan notes that presigned URLs and browser uploads then stop working.
- **`region`** is always `us-east-1`, the one region Cloudgate starts Garage with, since that is what most SDKs assume when nothing is set.
- **Backups** are the existing volume backup of the bucket's volume, Cloudgate's per Environment and off until set. **Delete** follows the bucket Delete rule: a bucket holding files keeps its volume, named as left behind; an empty one loses it.

## Considered options

- **An outside S3 reached through a Destination.** Rejected: a Destination is one Organization-wide bucket for backups that Cloudgate did not make, so it cannot scope a key to one bucket or keep and delete the bucket as that rule says. Pointing at storage made by hand is the "use existing" question, not this one.
- **Not supported on a Server.** Rejected: one config would no longer deploy to both targets.
- **One storage container per Server, shared by its buckets.** Rejected for the reason Cloudgate builds no shared database servers: a shared container's lifecycle belongs to no one Service, and a Delete or upgrade of one bucket touches every other.
- **MinIO, SeaweedFS, RustFS**. MinIO is archived with no official image. RustFS has been stable only since 2026-09-16. SeaweedFS covers more of S3 but its access model is a broader IAM file; Garage's per-key-per-bucket read/write grant is ADR-0032's link exactly.
- **An internal-only `endpoint`.** Rejected: presigned URLs and browser uploads, which work on S3, would fail on every Server.

## Consequences

- **A bucket's files are in Garage's on-disk format.** Moving to another storage server later means copying every bucket's files, so the choice is hard to reverse.
- **Garage lacks versioning and bucket policies.** An app relying on either works on S3 and not on a Server; nothing in `version: 1` asks for them.
- **A bucket with a Domain is reachable from the internet**, as an S3 bucket is; every request still needs its key.
