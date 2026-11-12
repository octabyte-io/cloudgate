import { quote } from 'shell-quote';

/**
 * The `pack` release the Heroku and Paketo builders install when the build
 * Server has none. Pinned, with its checksums, so every Server builds
 * with the same CLI and a tampered or truncated download is refused rather
 * than run as root. Moving it is a three-line change: the version and the two
 * `.sha256` files published beside the release's assets.
 */
export const PACK_VERSION = '0.40.9';

/** The two Linux assets of {@link PACK_VERSION}, keyed by `uname -m`'s answer. */
export const PACK_RELEASES = {
  amd64: {
    asset: `pack-v${PACK_VERSION}-linux.tgz`,
    sha256: 'dc0ee1e931cf8a106d7555a01a214864f9acb60b77adf15d69b74df4404758e9',
  },
  arm64: {
    asset: `pack-v${PACK_VERSION}-linux-arm64.tgz`,
    sha256: '091ccb213823656c727731537ef8f1000eb4dc3ec61641506653e7f9d6da0c5e',
  },
} as const;

const PACK_INSTALL_DOCS =
  'https://buildpacks.io/docs/for-platform-operators/how-to/integrate-ci/pack/';

/**
 * Installs `pack` on the build Server when it is not already on the PATH —
 * the opening lines of the Heroku and Paketo programs.
 *
 * **What broke.** Both builders ran `pack build …` and nothing anywhere put
 * `pack` on a Server: not `deploy/install.sh`, not `serverSetupCommand`, not the
 * build. Every Heroku and Paketo deploy on a fresh install failed in a second
 * with `/bin/sh: 12: pack: not found`.
 *
 * **Why on demand, in the build, rather than in the installer or Server
 * setup.** It is the one place that covers everywhere a build runs: the platform
 * host, a remote build Server, and a Server registered before this change,
 * which Server setup will never run on again. It is also what Railpack already
 * does (`railpack.strategy.ts`), so an operator who picks either CNB builder
 * pays the download once, on the first build, and one who never does pays
 * nothing. An operator-installed `pack` is used as it is — the guard is
 * `command -v`, the same as the installer's nixpacks line.
 *
 * **Why not `curl … | sh` the way Railpack does.** `pack` publishes no install
 * script, only release tarballs with a `.sha256` beside each, so this downloads
 * the pinned tarball for the build Server's arch and refuses it unless its sha256 is
 * the one pinned in {@link PACK_RELEASES}. The build runs as root (docs/deploy.md
 * — "The backend runs as root"; a Server's SSH user defaults to `root`), so
 * `/usr/local/bin` is writable and is on a non-login shell's PATH; a non-root
 * SSH user gets the failure sentence below naming that write.
 *
 * **No command substitution, on purpose.** The arch is matched with
 * `uname -m | grep`, and the scratch file is named by `buildNonce` instead of
 * `mktemp`, so the snippet adds no `$(…)` — the per-strategy injection tests
 * (`expectQuotedInCommand`) keep counting zero and still notice a first one.
 * The nonce is per build, so two concurrent builds cannot share a file.
 *
 * `builderLabel` is Cloudgate-authored ("Heroku" / "Paketo"), and appears only
 * inside the echoed sentences.
 */
export function packInstallation(
  builderLabel: string,
  buildNonce: string,
): string {
  const tarball = quote([`/tmp/cg-pack-${buildNonce}.tgz`]);
  const failed = `❌ ${builderLabel} build failed: it builds with pack, which is not installed on this build Server`;
  return [
    'if ! command -v pack >/dev/null 2>&1; then',
    `  echo "> Installing pack v${PACK_VERSION}, which ${builderLabel} builds run, please wait…" ;`,
    '  cg_pack_asset= ;',
    "  if uname -s | grep -qx Linux && uname -m | grep -qxE 'x86_64|amd64'; then",
    `    cg_pack_asset=${PACK_RELEASES.amd64.asset} ; cg_pack_sha256=${PACK_RELEASES.amd64.sha256} ;`,
    "  elif uname -s | grep -qx Linux && uname -m | grep -qxE 'aarch64|arm64'; then",
    `    cg_pack_asset=${PACK_RELEASES.arm64.asset} ; cg_pack_sha256=${PACK_RELEASES.arm64.sha256} ;`,
    '  fi',
    '  if [ -z "$cg_pack_asset" ]; then',
    `    echo "${failed}, and Cloudgate installs pack only on Linux amd64 or arm64. Install pack v${PACK_VERSION} on the Server (${PACK_INSTALL_DOCS}), or pick another builder." ;`,
    '    exit 1;',
    '  fi',
    `  { curl -fsSL -o ${tarball} "https://github.com/buildpacks/pack/releases/download/v${PACK_VERSION}/$cg_pack_asset" &&`,
    `    echo "$cg_pack_sha256  "${tarball} | sha256sum -c - &&`,
    `    tar -xzf ${tarball} -C /usr/local/bin pack ; } || {`,
    `    rm -f ${tarball} ;`,
    `    echo "${failed}, and installing pack v${PACK_VERSION} failed — downloading it from github.com/buildpacks/pack, checking its sha256, or writing it to /usr/local/bin (the output above says which)." ;`,
    '    exit 1;',
    '  }',
    `  rm -f ${tarball} ;`,
    `  echo "pack v${PACK_VERSION} is now installed." ;`,
    'fi',
  ].join('\n');
}

/**
 * Pulls the run image `builder` names before `pack build` pulls the builder:
 * the line after {@link packInstallation} in the Heroku and Paketo programs.
 *
 * **What broke.** On a daemon with the containerd image store (docker 29.4,
 * the GitHub runner's, where the builder image's socket smoke check runs as a
 * Cloud Build step would), the second of two images that share a layer is
 * kept without that layer's blob. pack pulls the builder, then the run image
 * (which shares the builder's base layers), and exports the app by `docker
 * save`-ing the run image, which that daemon refuses: "image with reference
 * heroku/heroku:24 was found but does not provide the specified platform
 * (linux/amd64)". A run image pulled first keeps every blob, and pack's own
 * pull of it is then a no-op. docker 29.9 keeps both, and there the pull is
 * one pack would make anyway.
 *
 * **The run image is the builder's own**, read off the registry by `pack
 * builder inspect` (which pulls nothing) rather than named here, so a
 * Service's `herokuVersion` gets its version's run image. The first of
 * `run_images` is the one pack picks with no mirror configured.
 *
 * **Best effort.** A builder that cannot be read, or a pull that fails, falls
 * through to `pack build`, which then succeeds or fails on its own terms and
 * says why. No command substitution and no `read` (see
 * {@link packInstallation}): the name travels down a pipe into `xargs`, and
 * `pack` reads `/dev/null`, not the program's stdin.
 *
 * `builder` is the `--builder` word as the program passes it, already quoted.
 */
export function packRunImagePull(builder: string): string {
  return [
    // The builder word stands outside the double quotes, where its own
    // quoting holds.
    `echo "> Pulling the run image of" ${builder} "before the builder itself, so the daemon keeps every layer pack exports on…" ;`,
    `pack builder inspect ${builder} --output json </dev/null 2>/dev/null | sed -n '/"run_images"/,/]/s/^ *"name": *"\\([^"]*\\)".*/\\1/p' | head -n 1 | xargs -r docker pull || true`,
  ].join('\n');
}
