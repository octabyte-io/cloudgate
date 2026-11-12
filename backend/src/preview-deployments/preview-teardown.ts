import path from 'node:path';
import { asc, eq, inArray } from 'drizzle-orm';
import { application } from '../applications/application.schema';
import {
  applicationServicePresence,
  removeApplicationDirectoryStep,
  removeTraefikConfigStep,
} from '../applications/application-ops';
import { builtImageTag } from '../applications/built-image';
import { buildLeftoverReclamation } from '../builders/build-leftovers';
import { isCloudService } from '../common/cloud-service-host-work';
import {
  awaitImageRelease,
  removeImagesOn,
  runTeardownSteps,
} from '../common/teardown-steps';
import type {
  TeardownReport,
  TeardownStep,
  UnreclaimedArtifact,
} from '../common/teardown-steps';
import type {
  OrphanedWorkload,
  WorkloadPresence,
} from '../common/workload-presence';
import type { DrizzleDB } from '../db/drizzle.module';
import { buildHostServerId } from '../deployment-engine/build-host';
import { applicationsDirectoryOn } from '../deployment-engine/deployment-engine.paths';
import { execOnServer } from '../remote/exec-dispatch';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { TraefikWriterService } from '../traefik/traefik-writer.service';
import { previewDeployment } from './preview-deployment.schema';

/**
 * What a preview deployment leaves on the fleet, and where.
 *
 * A preview is a whole deployment of the pull request's branch under its own
 * `appName` beside production: `PreviewDeploymentsService.deployPreview` builds
 * it through the ordinary engine, spreading the parent Application's row over
 * `{ appName: preview.appName, branch: preview.branch }`. So it leaves four of
 * the machine-side artifacts an Application leaves, on the same two machines —
 * the Swarm service and the Traefik router for its host
 * (`dynamic/{preview.appName}.yml`) on `application.serverId`, and the source
 * tree under `{applicationsDirectoryOn(buildHostServerId)}/{preview.appName}`
 * plus the `{preview.appName}:latest` its build tagged on the build host
 * — and `preview.appName` is the only thing that names any of them.
 *
 * **Four of them and not all five**, because an Application also
 * leaves the `files` half of that same tree, on the **run** Server: nothing in
 * the product writes `{preview.appName}/files`, which
 * {@link previewTeardownSteps} establishes rather than assumes, and ADR-0021 is
 * the rule that settled it.
 *
 * **This file exists because `preview_deployment.applicationId` is
 * `onDelete: 'cascade'` and nothing on any delete path named a preview at
 * all.** `ApplicationsService.remove` and `common/service-cascade.ts` each ran
 * their teardown against the *parent's* `appName`, so deleting an Application,
 * an Environment or a Project dropped every preview row in one statement and
 * left every preview's Swarm service running. Per ADR-0008 a container that
 * resolves to no Service is *unmanaged* and is reached through machine-level
 * `docker:read` — "where there is no Service to ask about" — so after unmanaged
 * containers were opened up that statement moved every preview container of the
 * deleted tree from private-to-one-organization to readable and actable by
 * every organization on the host. That is exactly the earlier finding, and
 * "deleting a Project is one click" makes the bulk path the likely one.
 *
 * Plain exported functions and not an `@Injectable()`, which is
 * `rollbacks/preserved-images.ts`'s decision one table along and for the same
 * reason: `PreviewDeploymentsService` injects `ApplicationsService`, so a
 * provider here would make `applications`, `projects` and `environments` reach
 * `PreviewDeploymentsModule` through a `forwardRef` knot for what is one select
 * and four shell words. `common/service-cascade.ts` is the precedent both cite.
 */

/**
 * The preview's own directory on its build host — the parent of the `code`
 * tree the clone writes, which is what an Application's own Delete removes for
 * itself.
 *
 * **It takes the build host, because the root depends on the machine**.
 * This resolved `applicationsDirectory()` — this process's own
 * `CLOUDGATE_DIRECTORY` — for every machine alike, so on an install that sets
 * the variable a preview's `rm -rf` named a directory under a root the builder
 * had never heard of, while `deployPreview` spread the parent's row into
 * `engine.deploy` and had the clone write under the same wrong root. Both
 * halves were self-consistent, which is why nothing broke and why the writer
 * and the four removals had to convert together (ADR-0018,
 * {@link cloudgateDirectoryOn}). The `serverId` is the parent Application's
 * {@link buildHostServerId} answer, which {@link PreviewTeardownTarget}
 * already carries as `buildHostId` for the step that sends the command — so
 * this makes the root and the machine one decision rather than two.
 *
 * `path.posix` and not `path.join`: this is a path on the *build host*, which
 * is a Linux box whichever platform this process runs on, and
 * `applicationsDirectoryOn()` is already a posix string. `teardown` used
 * `path.join` and would have produced `\`-separated words on a Windows
 * development host.
 */
export const previewCodeDirectory = (
  appName: string,
  buildHostId: string | null,
): string => path.posix.join(applicationsDirectoryOn(buildHostId), appName);

/**
 * The image a preview's build tagged on its build host, as the list
 * {@link removeImagesOn} takes — empty when there is no such image.
 *
 * A list rather than a string because that is the shape the shared removal
 * loop takes, and because `builtImageTag`'s `null` has to arrive as *nothing to
 * remove* rather than as a word: an asserted-away `null` here would be the
 * guess `applications/built-image.ts` refuses to make, and the arm that answers
 * it is the one whose image is the operator's own pulled `dockerImage`.
 *
 * `'github'` is the only `sourceType` a preview has — `findPreviewTargets`
 * selects on it, so no other kind of Application ever gets one — which is what
 * makes the literal a fact about the row rather than a default.
 */
const previewBuiltImages = (appName: string): string[] => {
  const tag = builtImageTag({ appName, sourceType: 'github' });
  return tag === null ? [] : [tag];
};

/**
 * One preview and the two machines that hold its artifacts.
 *
 * **Deliberately not `common/teardown-steps.ts`' `BuildHostArtifactOwner`, and
 * that is a fourth owner type on purpose** (which collapsed the other
 * three). That one carries the *two inputs* `buildHostServerId` resolves,
 * because its three reclamations each take a list of Applications and resolve
 * the build host themselves. This carries the answer **already resolved**, as
 * `buildHostId`, beside the run Server — because a preview's two machines are
 * both needed here (the `docker service rm` belongs to one and the `rm -rf`,
 * the `docker image rm` and the sweep to the other) and because {@link listApplicationPreviews} resolves
 * it in the join that reads the parent's pair, so no step in this file can
 * reach for the wrong column. `common/service-cascade.ts`' `CascadeChild`
 * declined the same pre-collapse for the opposite reason and says so:
 * `teardownStepsFor` is the place that decides which artifact wants which
 * machine, and a pre-collapsed id would hide that decision from it. Here the
 * decision is already made: the run Server holds the workload and the build
 * host holds everything the build wrote.
 */
export interface PreviewTeardownTarget {
  appName: string;
  /**
   * Where the Swarm service runs — the parent Application's `serverId`. The
   * converge, the presence probe and the `docker service rm` all belong here
   * (`applications/application-ops.ts`).
   */
  serverId: string | null;
  /**
   * Where the source tree was cloned — {@link buildHostServerId} over the
   * parent's pair. Equal to `serverId` on the single-Server install, which is
   * why aiming both steps at `serverId` stayed green everywhere it was tested.
   */
  buildHostId: string | null;
  /**
   * The parent's Cloud account, set when it runs in one. Such a parent's
   * `serverId` is `null` like the platform host's own, and no preview of it
   * has anything on any machine to remove (`cloud-preview.ts`), so it is what
   * tells the two apart.
   */
  cloudAccountId: string | null;
}

/**
 * Whether a preview's parent runs in a Cloud account, so that none of this
 * file's steps may run for it: each would follow its `null` to the platform
 * host (ADR-0053).
 */
const parentInCloud = (target: PreviewTeardownTarget): boolean =>
  isCloudService({
    name: target.appName,
    cloudAccountId: target.cloudAccountId,
  });

/**
 * Whether a preview's Swarm service is still on its run Server,
 * `applicationServicePresence`'s three-valued answer; `'absent'` for a preview
 * of an Application in a Cloud account, which has no Swarm service anywhere
 * and whose `null` would put the probe on the platform host.
 */
export function previewServicePresence(
  remoteExec: RemoteExecService,
  target: PreviewTeardownTarget,
): Promise<WorkloadPresence> {
  if (parentInCloud(target)) return Promise.resolve('absent');
  return applicationServicePresence(
    remoteExec,
    target.serverId,
    target.appName,
  );
}

/**
 * The machine steps of a preview teardown, as `common/teardown-steps.ts`'s
 * {@link TeardownStep}s the caller runs through {@link runTeardownSteps} —
 * `common/service-cascade.ts`'s `teardownStepsFor` shape and its reason: a
 * missing service must not strand the directory, so which step threw decides
 * only that step. The directory step carries a `leftBehindOnFailure` and the
 * service step does not, because the presence read answers for the second and
 * nothing answers for the first.
 *
 * **Two machines, and the run Server takes only the first step — a consistency
 * fix against a state currently refused, not a live leak.**
 * `PreviewDeploymentsService.teardown` took a single `serverId` — read off
 * `application.serverId` at both of its call sites — and used it for both
 * commands, while `deployPreview` spreads the parent row into `engine.deploy`
 * so `buildServerId` survives and decides where the clone lands. On a
 * dedicated-build-Server install the `rm -rf` would therefore run on a machine
 * that had never held the directory.
 *
 * A preview cannot reach that state today: `deployPreview` forces `registry:
 * null` and `buildRegistry: null` and previews exist only for `sourceType:
 * 'github'`, so `assertBuiltImageReachesRunServer` throws *before the
 * clone* whenever `buildServerId !== serverId`. So this half of the fix is the
 * consistency half — the parent Application's own delete and the cascade are
 * where the same defect was live, on a configuration that deploys perfectly
 * well. It is fixed here anyway because the two Servers are two, and the state
 * becomes reachable the moment a preview inherits a Registry or that refusal
 * narrows; `previewTeardownSteps` is then already right rather than newly
 * wrong.
 *
 * **All three removals go as argv, and that is the defence** (H-34).
 * Each is one program and its arguments with no pipeline, no `&&` and no redirect, so
 * `execOnServer` picks the cell — `execFileAsync` locally, where no `/bin/sh -c`
 * sees the words at all, and `execRemote` remotely, which joins with `quote()`
 * once behind its own test. The `rm -rf` reaches it through
 * `application-ops.ts`'s `removeApplicationDirectory`, which is the same three
 * words the parent Application's delete sends. `rm -rf` is why the argv is
 * worth it rather than reaching for `quote()` at the call site: a word-split
 * there deletes something else. `appName` is `generateAppName('preview-…')` over a parent held to
 * `APP_NAME_REGEX` — traced, and safe today — but that is a mint two modules
 * away and is not what makes these lines safe; the argv is.
 *
 * **The fourth step is a program rather than argv, and it is the one step
 * that could not be otherwise**. `buildLeftoverReclamation` is a `for`/`case`
 * sweep over `docker buildx ls` and `docker ps -a`, so there is no argv for it
 * to go as — `exec-dispatch.ts`'s `string` arm and §2.9's rule, with the one
 * interpolation `quote()`d inside the builders' own program and proved there by
 * executing the generated shell. So the sentence above narrows to the three
 * removals rather than losing its force: the words that delete something are
 * still argv.
 */
export function previewTeardownSteps(
  remoteExec: RemoteExecService,
  target: PreviewTeardownTarget,
): TeardownStep[] {
  // **No step for a preview of an Application in a Cloud account**, and that
  // is fail-closed rather than a leak. Its parent's `serverId` is `null`, so
  // every step below would run on the platform host (ADR-0053): a
  // `docker service rm` and a route-file removal by a name, on the machine
  // Cloudgate runs on. No such preview is made any more (`cloud-preview.ts`);
  // one made before that refusal may have left a checkout and an image of
  // its branch on the platform host, which are left there rather than reached
  // through this `null`. The row still goes.
  if (parentInCloud(target)) return [];
  return [
    {
      run: () =>
        execOnServer(remoteExec, target.serverId, [
          'docker',
          'service',
          'rm',
          target.appName,
        ]),
    },
    // The router `deployPreview` wrote for the preview's host, on the run
    // Server whose Traefik serves it — the same step, and so the same
    // `'traefik-config'` report, an Application's own delete sends for its
    // `dynamic/{appName}.yml`. Without it a closed pull request's host stays
    // advertised at a service the step above has just removed.
    //
    // **A writer built here rather than injected**, because this file is plain
    // functions for the reason its head gives: `TraefikWriterService`'s one
    // dependency is the `RemoteExecService` every caller already hands over, so
    // this is the writer the callers hold, and threading it through
    // `tearDownApplicationPreviews`' three delete services would widen three
    // signatures to pass a value this can already make. `rm -f` of a file that
    // was never written — a preview that never finished building — is the
    // outcome it wanted.
    removeTraefikConfigStep(
      new TraefikWriterService(remoteExec),
      target.serverId,
      target.appName,
    ),
    // One of the two steps that report their own failure, through the same
    // helper the parent Application's delete and the cascade use: the presence
    // read below asks the run Server about a Swarm service, so nothing else in
    // this file can see a `rm -rf` that failed on the builder.
    removeApplicationDirectoryStep(
      remoteExec,
      target.buildHostId,
      target.appName,
      // The same `buildHostId` decides the root and the machine, so a step
      // cannot name a path on one host and send the removal to another.
      previewCodeDirectory(target.appName, target.buildHostId),
    ),
    // The image the build tagged, on the machine that tagged it.
    //
    // **What was leaking.** A teardown removed the service, the tree and the
    // row and left `{preview.appName}:latest` behind — 242 MB apiece on the
    // reporter's host — and because `ensurePreview` mints a fresh `appName` per
    // pull request through `generateAppName('preview-…')`, two previews never
    // share a tag and nothing ever overwrites anything: the images accumulate
    // one per pull request, for ever, under a name no row refers to once the
    // row is gone. That is `applications/built-image.ts`' whole argument for
    // reclaiming `${appName}:latest` at the delete, arriving at the table
    // `preview_deployment.applicationId`'s cascade had already hidden once
    // — and here the disk cost is per *pull request* rather than per
    // Application.
    //
    // **`builtImageTag` and `removeImagesOn`, rather than a second spelling of
    // either.** The tag is the one the build derives, so a preview cannot come
    // to name an image the build does not produce without reddening
    // `application-delete-machines.e2e-spec.ts`' cross-assertion against
    // `builtImageName`; `sourceType: 'github'` is not a guess but the only
    // value a preview can have (`findPreviewTargets` selects on it), and the
    // `null` the docker arm answers is kept rather than asserted away, so this
    // stays right rather than becoming wrong if a preview ever inherits another
    // source. The removal is `common/teardown-steps.ts`' loop, which is what
    // makes this safe in the two ways the ticket asks for: `--force` untags an
    // image a `Shutdown` task still references, and a daemon that has no such
    // image is `imageAlreadyGone` — the outcome this wanted. It never throws,
    // so a step wrapper adds nothing but the slot in the list.
    //
    // **After the `docker service rm` above, and that ordering is the one that
    // matters.** The tag is what the Swarm service is running, so removing it
    // first would untag the live image of a preview whose service is still
    // scheduling tasks off it — `reclaimBuiltImages`' post-refusal slot for the
    // same reason, one artifact along.
    //
    // **The answer is deliberately dropped, and that is this route rather than
    // this artifact.** `removeImagesOn` reports what it could not reclaim in
    // `UnreclaimedImages`, and an image is not an `UnreclaimedArtifact` (that
    // was settled: `web-app:latest` is not a `path`), so the
    // {@link TeardownReport} these steps answer in has nowhere truthful to put
    // it. That is the same asymmetry recorded just below for the directory
    // step's `leftBehindOnFailure` on `PreviewDeploymentsService.teardown`'s
    // two callers — a webhook has no operator to tell — and widening the report
    // is a change to the field four deletes share rather than to this list.
    {
      run: () =>
        removeImagesOn(
          remoteExec,
          target.buildHostId,
          previewBuiltImages(target.appName),
          // A preview's teardown never keeps its workload on purpose: the
          // `docker service rm` above is unconditional, so the image is
          // followed until its stopping task has gone.
          awaitImageRelease(),
        ),
    },
    // **No `files` removal on the run Server, and that is established rather
    // than deferred**. `ApplicationsService.remove` and the cascade both
    // gained one, because `{root}/applications/{appName}` spans two machines
    // and the `rm -rf` above names only the builder. A preview does not, today:
    // `MountsService` addresses its write by the *parent* Service's row —
    // `findParentService` resolves one of the eight service tables and a
    // preview has no row in any of them — so the only tree it ever writes is
    // `{parent.appName}/files`. Nothing in the product writes
    // `{preview.appName}/files`, so there is nothing here to reclaim and a step
    // added on the strength of the symmetry would be a `rm -rf` at a path no
    // writer has.
    //
    // The mismatch that made it look otherwise was real:
    // `deployPreview` spread the parent row — its `mounts` included — over
    // `{ appName: preview.appName }`, so `mechanize.ts` handed the daemon a
    // bind **source** under `{preview.appName}/files` that no writer created.
    // That was a preview whose file mounts were wrong, not a preview whose
    // files were leaked.
    //
    // **It was closed without giving a preview a tree, so this stays three
    // steps and the paragraph above is now settled rather than provisional.**
    // ADR-0021 is the rule it settled on — a preview inherits its parent's
    // storage and owns only what its own `appName` names — and
    // `PreviewDeploymentsService`' `inheritedMounts` converts the parent's
    // `file` mounts into `bind`s of the parent's own files at the one boundary
    // where both names are in scope. So `{preview.appName}/files` is still a
    // path nothing in the product writes, and a fourth step here would still be
    // an `rm -rf` at a path no writer has. The alternative rejected —
    // materializing a copy — is the one that would have wanted it: a
    // `reclaimFileMounts` on `target.serverId` (the **run** Server, never
    // `target.buildHostId`, for `fileMountsDirectoryOnRunServer`'s reason), in
    // this list rather than in ADR-0016's post-refusal slot because
    // `tearDownApplicationPreviews` already runs there.
    // And the artifacts a *killed* preview build left on the same build host —
    // a railpack buildx builder plus its state volume, or a nixpacks copy-out
    // container holding a writable layer.
    //
    // **Here rather than in `common/service-cascade.ts`, which is where the
    // ticket looked for it.** The delete got `reclaimBuildLeftovers`, and
    // the gap was read off that call being filtered to
    // `serviceType === 'application'`. Widening the filter would have reached
    // nothing: a preview is not a `CascadeChild` — no `service_type`, no row in
    // the eight service tables, no `checkServiceAccess` of its own (ADR-0018) —
    // so every sweep the deletes send names the *parent's* `appName`, while
    // `deployPreview` spreads the parent's row over
    // `{ appName: preview.appName }` and a preview build's builder is
    // `railpack-{preview.appName}-{nonce}`. Since `appName` is what both sweeps
    // match on, and the parent's pattern is a prefix plus a nonce's exact
    // width, the parent's sweep can never match a preview's builder.
    //
    // This file is the home because it is the only place all four delete paths
    // meet: `tearDownApplicationPreviews` for the Application delete and both
    // cascades, and `PreviewDeploymentsService.teardown` for the
    // closed-pull-request webhook and `DELETE /preview-deployments/:id` — the
    // two commonest ways a preview goes away and the two no cascade sees. A
    // sweep added to the cascade would have closed one path of four, which is
    // where a rule drifts rather than where it holds (ADR-0018's own argument
    // about a Compose stack's clone).
    //
    // Last of the four, and by pattern rather than by name, so the ordering
    // matters: this is the one step that could touch a build still in flight,
    // and a delete that has already dropped the Swarm service and `rm -rf`'d
    // the tree the build was reading is a delete no live build survives anyway
    // — `applications/build-leftovers.ts`' argument for why the queue premise
    // the build leans on is not needed at a delete. It is also always past any
    // refusal: the Application delete and both cascades run this after their
    // presence read, and `teardown`'s two callers drop the row regardless.
    //
    // No `leftBehindOnFailure`, deliberately: a sweep exits 0 whether it
    // matched nothing or everything, so a failed exec means *the sweep did not
    // run* rather than *this artifact was left behind*, and neither a builder
    // name nor a container name is an `UnreclaimedArtifact` `path`.
    // `applications/build-leftovers.ts` carries that decision in full and the
    // build answered it the same way for `${appName}:latest`.
    {
      run: () =>
        execOnServer(
          remoteExec,
          target.buildHostId,
          buildLeftoverReclamation(target.appName),
        ),
    },
  ];
}

/**
 * Every preview of the given Applications, with the machines that hold its
 * artifacts.
 *
 * The join is what makes this readable at all: `preview_deployment` carries the
 * `appName` and no Server at all, and the two Server columns live on the parent
 * `application` row the cascade is about to destroy. So this list exists
 * exactly once — in the window between a delete deciding to proceed and the
 * rows going — which is ADR-0016's argument arriving at a second table.
 *
 * **No organization predicate, deliberately**, on
 * {@link listPreservedImages}'s reasoning: every caller has already resolved
 * these `applicationId`s through its own org-scoped read and a
 * `checkServiceAccess(…, 'delete')`, so a second one here would answer a
 * question that has been answered.
 *
 * **Nor a `checkServerAccess` on the two Server ids, and that is a difference
 * from `reclaimPreservedImages` rather than an omission.** That exposure is
 * specific to `rollback.full_context`, a plain `json` column no foreign key
 * constrains, whose ids were proved able to name another organization's rows.
 * These two ids are `application.serverId` and `application.buildServerId`:
 * real foreign keys into `server`, each authorized by `checkServerAccess` on
 * the only paths that write them (`ApplicationsService.create` and `update`),
 * and `buildServerId`'s `onDelete: 'set null'` means it cannot dangle either.
 * A gate here and none on the three teardown steps of the parent Application —
 * which have execed on this very `serverId` all along — would not be
 * consistency but a second rule for the same column.
 *
 * Ordered by `appName`, which is `unique` on the table, so the order is total
 * and a caller's report reads the same way twice. `createdAt` was the
 * alternative and buys nothing here: nothing about this list is bounded, so
 * there is no first-N for capture order to decide.
 */
export async function listApplicationPreviews(
  db: DrizzleDB,
  applicationIds: readonly string[],
): Promise<PreviewTeardownTarget[]> {
  if (applicationIds.length === 0) return [];
  const rows = await db
    .select({
      appName: previewDeployment.appName,
      serverId: application.serverId,
      buildServerId: application.buildServerId,
      cloudAccountId: application.cloudAccountId,
    })
    .from(previewDeployment)
    .innerJoin(
      application,
      eq(previewDeployment.applicationId, application.applicationId),
    )
    .where(inArray(previewDeployment.applicationId, [...applicationIds]))
    .orderBy(asc(previewDeployment.appName));

  return rows.map((row) => ({
    appName: row.appName,
    serverId: row.serverId,
    buildHostId: buildHostServerId(row),
    cloudAccountId: row.cloudAccountId,
  }));
}

/**
 * Tears down every preview of the Applications a delete is about to destroy,
 * and answers with the ones it could not confirm gone.
 *
 * **Where in the delete this runs: after the refusal, before the rows** —
 * `reclaimPreservedImages`'s slot, for `reclaimPreservedImages`'s reason, and
 * *not* as a fourth entry in `teardownStepsFor`, which is where it first looks
 * like it belongs. Those steps run before the presence read, and a Delete that
 * is then refused leaves the tree intact and tells the caller so; a preview
 * teardown there would have destroyed the live preview environments of an
 * Application the caller has just been told still exists. That is ADR-0016's
 * "a recoverable refusal turned into silent breakage" at a second artifact.
 * Before the rows because `preview_deployment.applicationId` cascades, and
 * after them `preview.appName` — the only name either artifact has — is gone.
 *
 * **It never blocks a delete, and it says what it left — running *and* on
 * disk.** The choice is
 * between naming the leak and making *forget this Application* impossible while
 * a preview's machine is down, which was settled: "a dead server must not make
 * deletion impossible", answered with a truthful response rather than a bare
 * 200 — with three acceptable answers named, of which *remove it* and
 * *say what you leave behind* are the two taken here. Refusing was rejected for
 * a second reason as well: `PreviewDeploymentsService.teardown`'s other two
 * callers — the closed-pull-request webhook and `DELETE
 * /preview-deployments/:id` — are best-effort and drop the row regardless, and
 * a webhook has no operator to answer a 409 to. Making this one caller refuse
 * where the other two do not is where the rule would drift; whether *all three*
 * should refuse is a question about `teardown` itself.
 *
 * **The presence read is on the run Server and is the same probe an
 * Application's own Delete uses.** A preview's workload is a Swarm service
 * under `preview.appName`, so `applicationServicePresence` is the question
 * already written, three-valued for `common/workload-presence.ts`'s reason: an
 * unreachable or wedged daemon must answer `'unknown'` rather than `'absent'`,
 * because `'absent'` is what says the container is gone.
 *
 * **So the read answers for one of the two steps and for nothing else, which is
 * why the other one answers for itself.** It asks the *run* Server about a
 * Swarm service; it cannot see the source tree, which is on the build host. A
 * `rm -rf` that failed there used to be caught and discarded — this returned a
 * clean `[]` and the delete answered 200 having leaked a directory it knew
 * about — so the directory step now carries its own
 * `leftBehindOnFailure` and this answers with both arrays
 * (`common/teardown-steps.ts`).
 *
 * One preview at a time and one presence read each — `tearDownCascadeChildren`'s
 * accepted cost and its stated reason: the only way to make the round trips go
 * away is to stop asking, and not asking is what left the containers running.
 * Sequential rather than concurrent because a tree's previews can sit on
 * several Servers and fanning out would open an SSH connection per preview on
 * each of them at once.
 */
export async function tearDownApplicationPreviews(
  db: DrizzleDB,
  remoteExec: RemoteExecService,
  applicationIds: readonly string[],
): Promise<TeardownReport> {
  const previews = await listApplicationPreviews(db, applicationIds);
  const orphaned: OrphanedWorkload[] = [];
  const unreclaimedArtifacts: UnreclaimedArtifact[] = [];
  for (const preview of previews) {
    // Best-effort per step — a service that was never created must not strand
    // the directory — and the directory step answers for itself, because the
    // presence read below cannot: `common/teardown-steps.ts` carries both.
    unreclaimedArtifacts.push(
      ...(await runTeardownSteps(previewTeardownSteps(remoteExec, preview))),
    );
    const presence = await previewServicePresence(remoteExec, preview);
    if (presence !== 'absent') {
      orphaned.push({
        appName: preview.appName,
        serverId: preview.serverId,
        reason: presence,
      });
    }
  }
  return { orphaned, unreclaimedArtifacts };
}
