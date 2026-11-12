# On the Hosted instance a cloud Service builds in its cloud's own build service, and a Self-hosted instance keeps building on its platform host

Status: accepted, answering "Where AWS/GCP Services build on the Hosted instance". Amended by #1366 (Stack VM permissions, ADR-0070): since the Hosted and the Self-hosted permissions versions differ by the build actions alone, a later need of both modes is added as two versions, one over each (AWS policy 4 over 2 for Self-hosted and 5 over 3 for Hosted; Google role 7 over 5 and 8 over 6), so a Self-hosted Cloud account is still never asked for a build service. A newer version is then not always a wider one: whether a version makes the build identity is read from the version table (`makesBuildIdentity`), never from a `>=` on its number.

Today a cloud Service's build, and the copy of a ready-made image, runs in the build slot on the platform host, and a build Server is refused so that no cloud credential reaches a Server. The Hosted instance's platform host only manages, so it cannot build customers' images. **Decided: with hosted mode on, a cloud Service builds in AWS CodeBuild or Google Cloud Build inside the customer's own Cloud account, both clouds at launch; a Self-hosted instance keeps building on its platform host, as today.** The build place is chosen by the instance, with hosted mode at startup, never per Service. So one cloud Service has two build paths in the code, and that is deliberate.

- **The platform host still fetches the source.** It checks out every source type as it does today, zips it and uploads it to a bucket in the customer's account, where the build reads it. Git tokens never leave Cloudgate, and neither cloud's own git integration is used. CodeBuild keeps one stored credential per provider for the whole account, and Cloud Build's `gitSource` has no credential field.
- **A ready-made image is copied by a cloud build on the Hosted instance**, not pulled and pushed through the shared platform host. A private registry's password goes to that build only through the cloud's secret store, never as a plain-text variable, and is removed afterwards. A Self-hosted instance keeps its copy on its platform host.
- **The build identity is one per Cloud account, made by the customer's setup step** (the AWS setup template, the Google setup script), never by Cloudgate. It only reads its source, pushes to repositories carrying the Cloud account's tag and writes build logs, and it is never the deploy role, because the customer's build steps run with its credentials. The AWS permissions boundary on what Cloudgate itself makes stays as narrow as ADR-0032 set it. On Google, the setup script is also the only thing that can give the identity its project log-writer grant.
- **Every build starts from one Cloudgate builder image**, pinned by version and holding every build tool (`pack`, `nixpacks`, `railpack` with buildx), so each build kind behaves the same on both clouds. Starting, watching and stopping a build are API calls. OpenTofu makes only the standing pieces (ADR-0030).

## Consequences

- Cloudgate's role gains the build actions, a new permissions version, so a Cloud account re-runs setup once before its first hosted cloud deploy. Self-hosted Cloud accounts are not asked to.
- One Service's build can push into another Service's repository in the same Cloud account. It is the same customer's account, and that is accepted. On Google it reaches every repository in the project, since Artifact Registry gives an IAM condition no resource name to hold it to Cloudgate's; the project is Cloudgate's own.
- Builds start without the platform host's buildkit cache, so first builds are slower than on a Self-hosted instance.
- A fresh AWS account runs one CodeBuild build at a time by default, so deploys in one Cloud account can wait in CodeBuild's queue. Cloudgate's deploy timeout must not count that wait.

## Considered and rejected

- **A customer Server as the build Server for a cloud Service.** It would put a cloud push credential on a Server, against the rule that keeps it on the platform host, and would force a Server on a customer who runs only in a cloud.
- **No cloud deploys on the Hosted instance at launch.** It stays the fallback for a cloud whose build path is not ready in time, not the plan.
- **One build identity per Service.** On AWS it needs the permissions boundary widened, which raises the ceiling on every role Cloudgate makes, to fence Services of one customer's account from each other.
- **Cloning inside the build.** It would send a git token into the customer's account for each build and need a clone step per git provider.
- **The cloud's build service on a Self-hosted instance too.** It would make every existing Self-hosted Cloud account re-run setup before its next deploy, for a platform host that is allowed to build.
