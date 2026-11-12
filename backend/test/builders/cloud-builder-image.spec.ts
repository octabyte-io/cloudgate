import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLOUD_BUILDER_IMAGE,
  CLOUD_BUILDER_IMAGE_REPOSITORY,
  CLOUD_BUILDER_IMAGE_VERSION,
} from '../../src/builders/cloud-builder-image';
import {
  PACK_RELEASES,
  PACK_VERSION,
  packRunImagePull,
} from '../../src/builders/pack-install';

const dockerfile = readFileSync(
  join(__dirname, '../../../deploy/builder-image/image/Dockerfile'),
  'utf8',
);

const smoke = readFileSync(
  join(__dirname, '../../../deploy/builder-image/smoke/smoke.sh'),
  'utf8',
);

/** The value of `ARG <name>=<value>` in the builder image's Dockerfile. */
function dockerfileArg(name: string): string | undefined {
  return new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(dockerfile)?.[1];
}

/**
 * Every hosted cloud build (ADR-0047) starts from one Cloudgate builder
 * image, pinned by version. `.github/workflows/builder-image.yml` publishes it
 * under this constant's tag, and the cloud-build code pulls the same reference,
 * so a version is named in one place.
 */
describe('CLOUD_BUILDER_IMAGE', () => {
  it('is pinned to an exact version, never a floating tag', () => {
    expect(CLOUD_BUILDER_IMAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CLOUD_BUILDER_IMAGE).toBe(
      `${CLOUD_BUILDER_IMAGE_REPOSITORY}:${CLOUD_BUILDER_IMAGE_VERSION}`,
    );
  });

  it('is published to the repository the workflow pushes to', () => {
    expect(CLOUD_BUILDER_IMAGE_REPOSITORY).toBe(
      'ghcr.io/octabyte-io/cloudgate-builder',
    );
  });

  // The Heroku and Paketo builds run the same `pack` in the cloud as on a
  // Server, checked against the same checksums, so moving one moves both.
  it('carries the pack version a Server build installs, with its checksums', () => {
    expect(dockerfileArg('PACK_VERSION')).toBe(PACK_VERSION);
    expect(dockerfileArg('PACK_SHA256_AMD64')).toBe(PACK_RELEASES.amd64.sha256);
    expect(dockerfileArg('PACK_SHA256_ARM64')).toBe(PACK_RELEASES.arm64.sha256);
  });

  it('pins every image it is built from by digest', () => {
    const froms = dockerfile.match(/^FROM .*$/gm) ?? [];
    expect(froms.length).toBeGreaterThan(0);
    for (const from of froms) {
      expect(from).toMatch(/^FROM \S+:\S+@sha256:[0-9a-f]{64}( AS \S+)?$/);
    }
  });

  // The smoke check's buildpacks build pulls the run image as a hosted Heroku
  // build does, so a pass on the socket shape (a containerd image store, as
  // on the GitHub runner) says the real program passes there too.
  it('smoke-checks buildpacks with the run-image pull the Heroku program runs', () => {
    const pull = smoke.indexOf(packRunImagePull('heroku/builder:24'));

    expect(pull).toBeGreaterThan(-1);
    expect(pull).toBeLessThan(smoke.indexOf('pack build cg-smoke-buildpacks'));
  });
});
