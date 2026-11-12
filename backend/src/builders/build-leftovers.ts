import { leftoverNixpacksContainerReclamation } from './strategies/nixpacks.strategy';
import { leftoverRailpackBuilderReclamation } from './strategies/railpack.strategy';

/**
 * The width of the `buildNonce` every per-build artifact name ends in, for the
 * one caller that has no nonce to measure.
 *
 * **What broke first, and why this cannot be re-derived at the call site.**
 * `leftoverRailpackBuilderReclamation` and
 * `leftoverNixpacksContainerReclamation` match a leftover by *name length*
 * rather than by prefix, because `appName` is operator-chosen and merely
 * unique: `railpack-web-*` also matches `railpack-web-2-<nonce>`, which belongs
 * to a different Application in a different FIFO group whose build may be in
 * flight (the residual hazard). Inside a build the width comes from
 * `buildNonce.length`, so the pattern and the name cannot disagree. The
 * **delete** has no nonce — there is no build — so it has to assert the width,
 * and this is the one place it is asserted.
 *
 * `DeploymentEngineService.deploy` mints `buildNonce: nanoid()`, so the fact
 * behind the number is nanoid's default id length.
 * `test/builders/build-leftovers.spec.ts` pins it against `nanoid()` itself
 * rather than against 21, which is §1.7's *expected values come from an
 * independent source*: if that default ever moves, the spec reds here instead
 * of the delete quietly matching nothing.
 *
 * **Rejected: making the engine export the width.** `nanoid()` is called inline
 * in `deploy` and the nonce reaches a builder through `BuildCommandInput`, so
 * pinning it *there* would mean a constant in `deployment-engine` that the
 * builders import — pointing `builders` at the module that consumes it. The
 * dependency runs the other way (`DeploymentEngineService` imports
 * `getBuildProgram`), and a test can hold the equality without inverting it.
 */
export const BUILD_NONCE_LENGTH = 21;

/**
 * Every artifact a *killed* build of this Application can have left on its
 * build host, swept in one program.
 *
 * **What broke.** `09cbf5f` reclaims a leftover buildx builder in the **next**
 * build of the same Application, and a follow-up does the same for the
 * container `nixpacksStrategy`'s `publishDirectory` branch copies out of. Both
 * therefore *bound* their leak at one leftover per Application rather than
 * closing it: an Application that is killed mid-build and never built again
 * keeps a buildkit container plus its state volume, or a `Created` container
 * holding a writable layer, for as long as the row exists. Both of those
 * docblocks name the delete as where the residual belongs, and this is the
 * program the delete sends — `applications/build-leftovers.ts`'
 * `reclaimBuildLeftovers` is what sends it.
 *
 * **The same generated shell, not a second statement of the rule.** The
 * matching rule is the load-bearing part — a length rather than a
 * prefix, quoted prefix with bare wildcards, no `awk`, no `read` loop — and it
 * has already been wrong once. So this composes the two existing programs at
 * {@link BUILD_NONCE_LENGTH} rather than rebuilding either pattern, which is
 * `rollbacks/preserved-images.ts`' lesson as `common/teardown-steps.ts` cites
 * it: two copies of a rule that has been wrong once is how it goes wrong again.
 *
 * **Both sweeps for every Application, with no dispatch on `buildType`.** The
 * obvious economy is to send railpack's sweep only to a `railpack` Application
 * and nixpacks' only to one with a `publishDirectory`, and it is wrong for the
 * reason `nixpacksStrategy` does not condition its own sweep on that column:
 * `buildType`, `publishDirectory` and `sourceType` are all
 * `PATCH /applications/:id` columns, so an Application that built with railpack
 * yesterday and reads `dockerfile` today still has yesterday's builder, and the
 * delete is the last chance anything has to name it. Conditioning on the
 * current row would miss exactly the leftovers only the delete can reach. The
 * cost of being wrong the other way is one `docker buildx ls` and one
 * `docker ps -a` that match nothing.
 *
 * One program rather than two so that a delete costs one round trip per build
 * host — `applications/built-image.ts`' grouping, for its stated reason.
 */
export function buildLeftoverReclamation(appName: string): string {
  return [
    leftoverRailpackBuilderReclamation(appName, BUILD_NONCE_LENGTH),
    leftoverNixpacksContainerReclamation(appName, BUILD_NONCE_LENGTH),
  ].join('\n');
}
