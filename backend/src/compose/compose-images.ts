import { removeImagesOn } from '../common/teardown-steps';
import type { ImageRelease, UnreclaimedImages } from '../common/teardown-steps';
import type { Compose } from '../db/schema';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { parseComposeFile } from './compose-file';

/**
 * The images a Compose stack's own build leaves on its Server, and the delete
 * that reclaims them (ADR-0016's and ADR-0018's non-goal lists: the last
 * artifact on them that can be named).
 *
 * **What was leaking.** `deployCompose` runs
 * `docker compose -p ${appName} … up -d --build` and `ComposeService.remove`
 * runs `docker compose -p ${appName} down`, which has no `--rmi`: an image per
 * `build:` service, kept for ever under a name no row referred to any more.
 * `built-image.ts` took the Application's `${appName}:latest`; this is the
 * same claim about the same kind of artifact.
 *
 * **What the images are called, and the three answers rather than one.**
 * `${appName}:latest` was derivable from a column. A compose stack's images are
 * not: `docker compose build` names an image after the *compose project* and the
 * *service*, and a service may pin `image:` itself. Measured on **Docker 29.3.1
 * / Compose v5.1.1**, against `docker compose -p cg-probe-stack build` over a
 * three-service project:
 *
 * - `build:` and no `image:` → **`cg-probe-stack-web:latest`**, which is
 *   `${project}-${service}` with Docker's implicit `:latest`. The project is
 *   `appName` here and doubly so: `createComposeCommand` passes
 *   `-p ${appName}` and `getCreateComposeEnvFileCommand` writes
 *   `COMPOSE_PROJECT_NAME=${appName}` into the `.env` beside it. **These are
 *   reclaimed.**
 * - `build:` **and** `image: my-own-name:7` → **`my-own-name:7`**. The platform
 *   ran the build; the operator chose the name. **Not reclaimed**, on exactly
 *   `built-image.ts`' reason for the docker-source arm: `builtImageName` answers the
 *   operator's own `dockerImage` there, so reclaiming it would `docker image rm`
 *   a reference the operator picked — possibly one every other stack on the host
 *   is running, possibly a registry reference they push to. That is a
 *   **refusal with the measurement** rather than a ticket, which is how the
 *   buildkit cache was closed: the fact is recorded so the next reader does not
 *   re-open it as unfinished work.
 * - only `image:` → nothing was built.
 *
 * Two whole stacks are refused for the same reason and are named here so
 * neither reads as an oversight. A **`stack`**-type stack builds nothing:
 * `createComposeCommand` emits `docker stack deploy -c … --prune
 * --with-registry-auth`, which has no build phase, so a `build:` section in
 * such a file is inert. And a stack carrying **`compose.command`** has replaced
 * the entire `docker` subcommand — that column is documented as *"the
 * operator's own replacement for these arguments"* — so neither the project
 * name nor whether a build happens at all is Cloudgate's to know, and guessing
 * `${appName}-${service}` there could name an image belonging to a different
 * project.
 *
 * The service name is interpolated verbatim rather than sanitized, and that is
 * measured too: `cg-probe-two-Web.Three` was attempted and Docker refused the
 * tag — *"invalid tag … repository name must be lowercase"* — so a service name
 * that would not make a legal reference means the build itself failed and there
 * is nothing to reclaim. Nothing here has to reproduce Compose's normalization,
 * because Compose does not do any.
 *
 * **Where this runs, and the trap the earlier reclaims both recorded.**
 * `ComposeService.remove`, in ADR-0016's slot — after the presence refusal,
 * before the row. Doing it in `common/service-cascade.ts` *alone* would reclaim
 * a stack's images when its **Project** is deleted and not when the stack
 * itself is, which is where a rule drifts rather than where it holds. The
 * cascade is **not** covered here and the cost of covering it is stated rather
 * than hidden: `listCascadeChildren` would have to carry each compose child's
 * `composeType`, `command`, `sourceType` and `composePath` — the per-cascade
 * `select` on the compose table that H-87 deliberately dropped — and, for a
 * git-sourced child, issue one `cat` per stack **before** the teardown's
 * `rm -rf` destroys the project directory. So a Project delete still leaves a
 * stack's built images behind, and ADR-0018's list says so.
 *
 * A plain function taking its collaborator rather than a provider, on
 * `applications/built-image.ts`' and `patch/patch-repo-clone.ts`' precedent.
 * There is no build-host question: `deployCompose` execs every step on
 * `compose.serverId`, and `DeploymentsService.findCompose` hard-codes
 * `buildServerId: null` for exactly that reason — a stack builds where it runs.
 */

/** The compose row slice this reclamation reads. */
export interface ComposeBuiltImageOwner {
  appName: string;
  composeType: Compose['composeType'];
  /** The operator's replacement for the whole `docker` subcommand, or `''`. */
  command: string;
  /** `null` is the platform host (ADR-0008). */
  serverId: string | null;
}

/**
 * The tags this stack's own build left on its Server, in file order.
 *
 * Answers `[]` rather than throwing for content it cannot read, which is the
 * one place this file fails open on purpose: the file is read for this and
 * nothing else, a stack whose file will not parse has usually never built, and
 * a delete that raised because a stack's YAML is broken would be the orphan rule inverted
 * — *"a dead server must not make deletion impossible"* applied to a dead file.
 * `ComposeService.loadServices` is where an unreadable file earns a refusal,
 * because there the file *is* the answer.
 */
export function composeBuiltImageTags(
  owner: ComposeBuiltImageOwner,
  content: string,
): string[] {
  if (owner.composeType !== 'docker-compose') return [];
  if (owner.command.trim() !== '') return [];

  let spec: ReturnType<typeof parseComposeFile>;
  try {
    spec = parseComposeFile(content);
  } catch {
    return [];
  }
  const services = spec?.services;
  if (!services) return [];

  return Object.entries(services).flatMap(([name, service]) => {
    // `build` absent: the service pulls. `image` present: the operator named
    // the output, so the platform may not remove it. Both are the refusals the
    // module docblock measures.
    if (!service?.build) return [];
    if (service.image) return [];
    return [`${owner.appName}-${name}:latest`];
  });
}

/**
 * Drops this stack's built images and answers with the ones it could not.
 *
 * One machine, so one turn of {@link removeImagesOn} — which owns every clause
 * of the removal and is shared with the Application's and the preserved tag's
 * reclamations rather than restated: one command per tag so a batch cannot read
 * as wholly reclaimed, the first real failure ending the turn with the
 * unattempted tags reported beside it, `--force` because a `Shutdown` task
 * still references the image for several seconds after a teardown, and nothing
 * throwing, because a leftover image is disk rather than ADR-0008's unmanaged
 * container.
 *
 * No `checkServerAccess`, for `reclaimBuiltImages`' stated reason: this id is
 * `compose.serverId`, a real foreign key into `server` authorized by
 * `checkServerAccess` on the only paths that write it, and it is the same id
 * `remove` has been execing the teardown against all along. Gating it here and
 * not there would be a second rule for one column.
 */
export async function reclaimComposeBuiltImages(
  remoteExec: RemoteExecService,
  owner: ComposeBuiltImageOwner,
  content: string,
  release: ImageRelease,
): Promise<UnreclaimedImages[]> {
  const images = composeBuiltImageTags(owner, content);
  if (images.length === 0) return [];
  return removeImagesOn(remoteExec, owner.serverId, images, release);
}
