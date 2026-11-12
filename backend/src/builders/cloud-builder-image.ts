/**
 * The Cloudgate builder image every hosted cloud build starts from
 * (ADR-0047): CodeBuild on AWS, Cloud Build on Google. One image holds every
 * build tool — `pack`, `nixpacks`, `railpack`, and docker with buildx — so a
 * Dockerfile, buildpacks, Nixpacks or Railpack build behaves the same on both
 * clouds. There is no buildkit cache in it.
 *
 * **This is the one place the version is named.** The cloud-build code pulls
 * {@link CLOUD_BUILDER_IMAGE}, and `.github/workflows/builder-image.yml` reads
 * {@link CLOUD_BUILDER_IMAGE_VERSION} from this file to tag what it publishes,
 * so the two cannot disagree. The image is built from
 * `deploy/builder-image/image/`.
 *
 * **Moving it.** Change the image in `deploy/builder-image/image/` and bump the
 * version here in the same commit. A published version is never overwritten:
 * the workflow labels each image with the git tree of its build context, and
 * refuses a changed context under a version that is already published, so an
 * image a deploy already used cannot change underneath it.
 *
 * Plain erasable TypeScript with no imports, on purpose: the workflow runs this
 * file with Node's type stripping, outside the backend's build.
 */
export const CLOUD_BUILDER_IMAGE_VERSION = '1.2.0';

/** Where the workflow publishes the image (GitHub Container Registry). */
export const CLOUD_BUILDER_IMAGE_REPOSITORY =
  'ghcr.io/octabyte-io/cloudgate-builder';

/** The pinned reference a cloud build runs. */
export const CLOUD_BUILDER_IMAGE = `${CLOUD_BUILDER_IMAGE_REPOSITORY}:${CLOUD_BUILDER_IMAGE_VERSION}`;
