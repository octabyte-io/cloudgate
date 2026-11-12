# syntax=docker/dockerfile:1
#
# The Cloudgate builder image (ADR-0047): every hosted cloud build, in
# CodeBuild on AWS and Cloud Build on Google, starts from this one image, so a
# Dockerfile, buildpacks, Nixpacks or Railpack build behaves the same on both
# clouds. It holds docker with buildx, `pack`, `nixpacks` and `railpack`, and no
# buildkit cache.
#
# Published by .github/workflows/builder-image.yml under the version pinned in
# backend/src/builders/cloud-builder-image.ts. Any change to this directory
# needs that version bumped in the same commit: the workflow refuses to publish
# a changed image under a version that is already published.
#
# Everything is pinned: both images by digest, each tool by version and by the
# sha256 of its release tarball, so a rebuild cannot pick up a different tool
# and a tampered download fails the build. pack's pins are the ones a Server
# build installs (backend/src/builders/pack-install.ts); a unit test
# (backend/test/builders/cloud-builder-image.spec.ts) keeps them equal.
# Railpack's checksums are the ones in its release's checksums.txt. Nixpacks
# publishes no checksums, so its two were taken from the release downloads
# when they were pinned.
#
# The base is glibc (Debian), not Alpine. A build runs what its tools download
# while it builds, and those are glibc binaries: `railpack prepare` fetches the
# `mise` its railpack version pins (jdx/mise's `linux-x64` / `linux-arm64`
# asset), which on musl fails with `fork/exec /tmp/railpack/mise/mise-<version>:
# no such file or directory`. Alpine's gcompat cannot run it (no `__res_init`),
# and a musl mise placed where railpack looks would hold for one railpack
# version only, while a build installs the version its Service names
# (railpack.strategy.ts). The Servers these build programs were written for
# are glibc too. docker comes from the official docker image, whose binaries
# are static: dockerd, the CLI, buildx, runc and the `dind` wrapper are copied
# from it as they are.
#
# Two ways to reach a docker daemon, one per cloud:
#   - Cloud Build runs each step with the worker's docker socket mounted, so
#     docker, pack, nixpacks and railpack use it as they are.
#   - CodeBuild runs the build *in* this container (privileged mode), with no
#     daemon, so the build starts one first with `cloudgate-start-dockerd`.

FROM docker:29.9.2-dind-alpine3.24@sha256:9e79b879b177fbd72c34376a3dd3d91747da5db49e1f560f76aea59561471977 AS docker

# Debian 13 (trixie), slim.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

ARG TARGETARCH

ARG PACK_VERSION=0.40.9
ARG PACK_SHA256_AMD64=dc0ee1e931cf8a106d7555a01a214864f9acb60b77adf15d69b74df4404758e9
ARG PACK_SHA256_ARM64=091ccb213823656c727731537ef8f1000eb4dc3ec61641506653e7f9d6da0c5e

ARG NIXPACKS_VERSION=1.39.0
ARG NIXPACKS_SHA256_AMD64=055828d808645ee63bff61fda87b1022e12ce3902d0748c8751505883ad7353a
ARG NIXPACKS_SHA256_ARM64=6a10c16b39e7fd773e4ec744b08e56fbf142a635c414ab84f5714cb736cb4892

ARG RAILPACK_VERSION=0.15.4
ARG RAILPACK_SHA256_AMD64=459d86f5a9d8698bee8c7be4f224a305f51158fe5f44eb528255dfd568e4eaf1
ARG RAILPACK_SHA256_ARM64=035856398a88894a7e57dbea44e8c88aacca33a86900d3b8c7750216b424806f

LABEL org.opencontainers.image.source="https://github.com/octabyte-io/cloudgate" \
      org.opencontainers.image.title="Cloudgate builder" \
      org.opencontainers.image.description="Docker with buildx, pack, nixpacks and railpack: the image every hosted Cloudgate cloud build starts from."

# bash: the build programs are bash (Railpack's is run with `bash -c`).
# git: Nixpacks and Railpack read a source's git metadata when it is there.
# unzip: the source arrives as a zip in the customer's bucket.
# amazon-ecr-credential-helper (`docker-credential-ecr-login`): a CodeBuild
# build pushes to its Service's ECR repository as the Cloud account's build
# identity, the helper reading the build's own container credentials;
# no token of Cloudgate's is handed in.
# iptables, iproute2, kmod, pigz, xz-utils: what a nested dockerd uses for its
# networks, the `modprobe` stand-in below and layer compression, as the
# docker:dind image carries them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      amazon-ecr-credential-helper bash ca-certificates curl git iproute2 \
      iptables kmod pigz unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*

# The docker CLI and buildx; dockerd with containerd's runc shim, runc,
# docker-init and docker-proxy; the `dind` wrapper `cloudgate-start-dockerd`
# runs dockerd through; and the image's `modprobe` stand-in, since a nested
# daemon asks for modules a container cannot load.
COPY --from=docker \
     /usr/local/bin/containerd-shim-runc-v2 /usr/local/bin/ctr \
     /usr/local/bin/dind /usr/local/bin/docker /usr/local/bin/docker-init \
     /usr/local/bin/docker-proxy /usr/local/bin/dockerd \
     /usr/local/bin/modprobe /usr/local/bin/runc \
     /usr/local/bin/
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/

# Each tool's release tarball for this arch, refused unless its sha256 is the
# pinned one, and only the binary kept. nixpacks and railpack publish static
# musl builds only, which run as they are on glibc.
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
RUN case "$TARGETARCH" in \
      amd64) pack_asset="pack-v${PACK_VERSION}-linux.tgz"; pack_sha="$PACK_SHA256_AMD64"; \
             nixpacks_target=x86_64-unknown-linux-musl; nixpacks_sha="$NIXPACKS_SHA256_AMD64"; \
             railpack_target=x86_64-unknown-linux-musl; railpack_sha="$RAILPACK_SHA256_AMD64" ;; \
      arm64) pack_asset="pack-v${PACK_VERSION}-linux-arm64.tgz"; pack_sha="$PACK_SHA256_ARM64"; \
             nixpacks_target=aarch64-unknown-linux-musl; nixpacks_sha="$NIXPACKS_SHA256_ARM64"; \
             railpack_target=arm64-unknown-linux-musl; railpack_sha="$RAILPACK_SHA256_ARM64" ;; \
      *) echo "The Cloudgate builder image is built for amd64 and arm64, not '${TARGETARCH}'." >&2; exit 1 ;; \
    esac; \
    fetch() { \
      curl -fsSL --retry 3 -o /tmp/tool.tgz "$1"; \
      echo "$2  /tmp/tool.tgz" | sha256sum -c -; \
      tar -xzf /tmp/tool.tgz -C /usr/local/bin "$3"; \
      rm -f /tmp/tool.tgz; \
    }; \
    fetch "https://github.com/buildpacks/pack/releases/download/v${PACK_VERSION}/${pack_asset}" "$pack_sha" pack; \
    fetch "https://github.com/railwayapp/nixpacks/releases/download/v${NIXPACKS_VERSION}/nixpacks-v${NIXPACKS_VERSION}-${nixpacks_target}.tar.gz" "$nixpacks_sha" nixpacks; \
    fetch "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-${railpack_target}.tar.gz" "$railpack_sha" railpack; \
    chmod 0755 /usr/local/bin/pack /usr/local/bin/nixpacks /usr/local/bin/railpack

# Railpack's build frontend has to be the same version as the CLI that wrote
# the plan (`BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v$RAILPACK_VERSION`),
# so the version the image carries is in its environment for the build to read.
ENV RAILPACK_VERSION=${RAILPACK_VERSION} \
    NIXPACKS_VERSION=${NIXPACKS_VERSION} \
    PACK_VERSION=${PACK_VERSION}

COPY --chmod=0755 start-dockerd.sh /usr/local/bin/cloudgate-start-dockerd

# A daemon started in this container keeps its images and layers on a volume,
# as the docker:dind image declares: overlayfs cannot stack its layers on the
# container's own overlay root (`mount source: "overlay" … invalid argument`).
VOLUME /var/lib/docker

# A tool that cannot start (a wrong-arch or broken binary, a docker binary the
# base cannot run, buildx missing) fails the image build, not the first
# customer's deploy.
RUN docker --version \
 && dockerd --version \
 && runc --version \
 && docker buildx version \
 && command -v docker-credential-ecr-login \
 && pack --version \
 && nixpacks --version \
 && railpack --version

# No daemon at start: Cloud Build mounts its own socket. A build runs its own
# commands, and CodeBuild's starts the daemon with `cloudgate-start-dockerd`.
ENTRYPOINT []
CMD ["bash"]
