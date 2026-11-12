import {
  cloudgateDirectoryOn,
  localCloudgateDirectory,
} from '../common/config/cloudgate-directory';

/**
 * The platform tree on the host this process runs on, rooted at
 * CLOUDGATE_DIRECTORY. Functions rather than constants because the root is
 * only known once the validated env is published — see localCloudgateDirectory.
 *
 * A build dispatched to a Server writes under REMOTE_CLOUDGATE_DIRECTORY on
 * that host instead, and {@link cloudgateDirectoryOn} is the one statement of
 * that fork. `logsDirectoryOn` used to be the only helper here that
 * asked it — it writes it out no longer — and `applicationsDirectoryOn`,
 * then `patchReposDirectoryOn`, `schedulesDirectoryOn`, `composeDirectoryOn`,
 * `volumeBackupsDirectoryOn` and `volumeBackupLockPathOn`, and
 * {@link fileMountsDirectoryOnRunServer} followed.
 * **Every tree named on this page now asks it**, which is the state this page set
 * out for and the reason the worklist that used to live here is gone.
 *
 * **Two of them answer for two different machines, and the pair is the page's
 * one real subtlety.** `{root}/applications/{appName}` spans two hosts on an
 * install with a dedicated build Server: the `code` half is written, read and
 * reclaimed on the **build host** ({@link applicationsDirectoryOn}), and the
 * `files` half is written and bind-mounted on the **run** Server
 * ({@link fileMountsDirectoryOnRunServer}). Two names rather than one helper
 * called with two ids, because the bodies are indistinguishable and the roots
 * are the same literal until an operator sets `CLOUDGATE_DIRECTORY` — so a site
 * that reached for the wrong one would be invisible exactly the way every
 * defect this page records was.
 *
 * **The local spelling of a converted tree is deleted rather than kept**, which
 * is this page's own lesson: `patchReposDirectory`,
 * `schedulesDirectory`, `composeDirectory`, `volumeBackupsDirectory` and
 * `volumeBackupLockPath` are all gone, because every caller of each now passes
 * a machine and a surviving no-argument export would be a helper with no
 * correct call site left — the same trap a later site could fall into.
 *
 * **One no-argument export survives, and it is not a leftover.**
 * {@link logsDirectory} has **no caller in `src/` at all** since the
 * fork moved into `logsDirectoryOn`; what still imports it is
 * `test/deployments/log-retention.e2e-spec.ts` and
 * `test/common/cloudgate-directory.spec.ts`, both using it as a name for the
 * local root. It is named here rather than deleted quietly because the rule
 * above would delete it and the tests that spell the local root through it are
 * not this change's.
 *
 * **`applicationsDirectory` was the second, and it was deleted with its last
 * caller.** It was kept as "the mount source spelling", on the argument that
 * `{applicationsDirectory()}/{appName}/files` is a bind source resolved by
 * *neither* this process nor the build host and therefore by neither answer
 * `cloudgateDirectoryOn` gives. The first half of that is right and the
 * conclusion was wrong: a bind **source** is a path in a *host* filesystem, so
 * the machine that answers it is the one whose daemon resolves it — the **run**
 * Server, which is `cloudgateDirectoryOn`'s remote answer reached with a
 * different id, not a third root. Its three callers ask
 * {@link fileMountsDirectoryOnRunServer} now. The half that genuinely resolves
 * to neither root is the bind **target**, one directory over: Traefik reads
 * `accessLog.filePath` inside its own container, so it is a fixed
 * literal rather than a fork.
 */

/**
 * The applications tree, for the machine that holds it: this process's root, or
 * the Server the build was dispatched to, whose tree `serverSetupCommand` laid
 * out.
 *
 * `logsDirectoryOn`'s shape, deliberately down to the name, because it is the
 * same question about the same pair of roots and a second spelling of it is how
 * the eight helpers on this page came to disagree in the first place. The
 * `serverId` every one of its callers passes is the **build host** —
 * `buildHostServerId`'s answer — because all of them name the `code` half of
 * the tree, which is what the clone, the `drop` unpack and the build write
 * (`CONTEXT.md`'s *Build host*, ADR-0018). The `files` half of the same tree is
 * on the **run** Server and is {@link fileMountsDirectoryOnRunServer}, which is
 * a second name rather than a second id passed here for the reason this file's
 * header gives.
 *
 * **Five call sites converted together** (this helper first landed and
 * deliberately flipped nothing), **and a sixth was found later**. The original set
 * is the tree's two *writers* — `DeploymentEngineService`'s `codeDirectory` and
 * `ApplicationsService.uploadDrop` — and its three *destroyers*:
 * `ApplicationsService.remove`, `common/service-cascade.ts`'s application arm
 * and `preview-deployments/preview-teardown.ts`'s `previewCodeDirectory`.
 *
 * The sixth is `PatchService.generateApplyPatchesCommand`'s application arm,
 * and it is the one site of this defect that is a **live failure rather than a
 * misplaced directory**. It is a second *writer* into the tree, which the first
 * enumeration missed because it went looking for the paths a Delete names: the
 * block `mkdir -p`s and `base64 -d >`s each patched file under
 * `{root}/applications/{appName}/code` on the build host, so with
 * `CLOUDGATE_DIRECTORY` set and a dedicated build Server it wrote beside the
 * clone rather than into it — and because `mkdir -p` succeeds, `set -e` never
 * fired and the build read the *unpatched* tree and went green. It takes the
 * machine as a parameter rather than deriving it, for the reason that method's
 * docblock gives: `findParentService` projects the run Server and no
 * `buildServerId`, so the only derivation available here would have been
 * confidently wrong.
 * Converting the destroyers alone would have written the tree under one root
 * and `rm -rf`'d it from another — moving the leak rather than closing it,
 * which is exactly what ADR-0018 records `uploadDrop` doing for the *machine*
 * half of the same question, and the reason the flip is one commit rather than
 * five.
 *
 * **What `test/applications/source-tree-roots.e2e-spec.ts` holds, and what it
 * structurally cannot see.** It holds the original **five** to each other, by
 * taking each removal's expectation from the engine's own clone dispatch rather
 * than from the file's own opinion: a root that forks between that writer and
 * any of those destroyers reds it, whichever of the two is wrong. What it
 * cannot see is a **writer no Delete names.** It drives a deploy and a delete,
 * so a site reached only by some other program — the patch block above is the
 * instance — emits nothing for it to read, and the suite measured **8/8
 * green** with that site reverted to the local root. This paragraph used to end
 * *"so a sixth call site resolving the root differently fails there"*; that was
 * falsified four commits later in its own batch and is corrected here rather
 * than left as a reference a reader would draw the wrong conclusion from
 * (§1.2). What does close the class is a census rather than a suite:
 * `test/coding-standards/platform-root-call-sites.spec.ts` enumerates every
 * expression in `src/` that resolves this tree's root *without* a machine and
 * makes each one say why it is local — which is the enumeration the first pass needed and
 * did not have, because it went looking for the paths a Delete names.
 */
export const applicationsDirectoryOn = (serverId?: string | null) =>
  `${cloudgateDirectoryOn(serverId)}/applications`;

/**
 * A cloud `static` site's Deployment's upload folder,
 * `{root}/applications/{appName}/uploads/{deploymentId}`, always on the
 * platform host (`null`): its build slot copies `publish` here and its
 * Cloud run uploads from here, in this process, then removes it.
 */
export const staticUploadDirectory = (appName: string, deploymentId: string) =>
  `${applicationsDirectoryOn(null)}/${appName}/uploads/${deploymentId}`;

/**
 * A hosted cloud build's folder,
 * `{root}/applications/{appName}/cloud-builds/{deploymentId}`, always on the
 * platform host (`null`): its build slot copies the checkout to its `code/`,
 * and its Cloud run zips that here, in this process, uploads the zip and
 * removes the folder.
 */
export const cloudBuildDirectory = (appName: string, deploymentId: string) =>
  `${applicationsDirectoryOn(null)}/${appName}/cloud-builds/${deploymentId}`;

/**
 * For an Application or a managed database: the directory a Service's **file
 * mounts** are materialized in and bind-mounted from,
 * `{root}/applications/{appName}/files`, on the machine that runs the workload.
 *
 * **What broke first.** This was `applicationsDirectory()`, i.e.
 * {@link localCloudgateDirectory}, for every machine alike, and it was
 * *deliberately* left that way on the argument that a
 * bind-mount source is resolved by neither this process nor the build host and
 * so by neither answer {@link cloudgateDirectoryOn} gives. That reasoning
 * stopped one step early. A bind **source** is a path in a *host* filesystem,
 * so the machine that answers it is the machine whose daemon resolves it: the
 * **run** Server. That is the remote root, `serverSetupCommand`'s tree, and not
 * a third one. (The bind **target** is the half that really does resolve to
 * neither root — Traefik reads `accessLog.filePath` inside its container, which
 * is why that one is a fixed literal.)
 *
 * So with `CLOUDGATE_DIRECTORY` set, a file mount on a Service running on a
 * Server wrote its config file under a root nothing on that machine owns. It
 * did not *fail*: `getCreateFileCommand` opens with `mkdir -p`, the daemon was
 * handed the same string and mounted it, and the container came up correct —
 * and nothing reclaimed that tree, because the Delete's `rm -rf` names
 * `{applicationsDirectoryOn(buildHostServerId)}/{appName}` on the **build
 * host**. ADR-0018's `unreclaimedArtifacts` shape, one root over.
 *
 * **That second half is closed, and it is a fourth call site here** rather
 * than a wider `rm -rf` one directory up: `common/teardown-steps.ts`'
 * `reclaimFileMounts` asks this helper for the path it removes *and* the path
 * it reports, so a destroyer cannot name a tree the writer does not write. It
 * is reached by `ApplicationsService.remove` and `common/service-cascade.ts`'
 * cascade — the two deletes that destroy a Service row — in ADR-0016's
 * post-refusal slot rather than in their teardown arrays, because nothing
 * re-materializes a file mount and an early removal would strip a live
 * Application. `preview-teardown.ts` is deliberately **not** a fifth: nothing
 * writes `{preview.appName}/files`, which that file establishes rather than
 * assumes.
 *
 * The `serverId` is the **run** Server and never `buildHostServerId`'s answer:
 * `MountsService`' `parent.serverId` (`findParentService` projects
 * `SERVICE_TABLES[…].serverId`, which is the column the file write already
 * dispatches to), `application.serverId` in `mechanize.ts` (the column
 * `DeploymentEngineService.deploy` opens the daemon connection on), and a
 * managed database's own `serverId`. It is a **name of its own** rather than
 * {@link applicationsDirectoryOn} called with a different id, because those two
 * bodies are indistinguishable and, until an operator sets
 * `CLOUDGATE_DIRECTORY`, so are their answers.
 *
 * **Three call sites converted together, with the `appName` folded in**,
 * which is ADR-0018's rule stated for roots one machine over, **and a fourth
 * was added — the tree's first *destroyer*.** The
 * *writer* is `MountsService.baseFilesPath`'s application arm (and its own
 * `remove`'s `rm -rf`), the *destroyer* is `common/teardown-steps.ts`'
 * `reclaimFileMounts`, and the *consumers* are `mechanize.ts`'s
 * `buildServiceSettings` and `databases/common/database-spec.ts`, both through
 * `docker.utils.ts`' `generateFileMounts`. They agreed today only by all three
 * spelling the same wrong root, so converting any one alone would have written
 * the file under one root and mounted a directory Docker minted under the
 * other. The `{appName}/files` join moved in here from the three of them for
 * the same reason `resolveRepoPath` holds the patch-repo set: what keeps sites
 * from disagreeing is there being one expression, not a rule that they agree.
 *
 * `test/mounts/file-mount-source-roots.e2e-spec.ts` holds the writer and both
 * consumers to each other by taking each mount source's expectation from the
 * write's own dispatched command, so a fork between them reds whichever half is
 * wrong. `test/applications/application-delete-machines.e2e-spec.ts` holds the
 * destroyer to the writer the same way, and it is the file that can see the
 * half a shared expression cannot: *which machine was asked*.
 */
export const fileMountsDirectoryOnRunServer = (
  runServerId: string | null | undefined,
  appName: string,
) => `${applicationsDirectoryOn(runServerId)}/${appName}/files`;

/** Deployment logs live under {logsDirectory()}/{appName}/{deploymentId}.log
 * on the build server. */
export const logsDirectory = () => `${localCloudgateDirectory()}/logs`;

/** logsDirectory for the host that runs the build: this one, or the Server the
 * work was dispatched to, whose tree the setup script laid out. The fork
 * itself is {@link cloudgateDirectoryOn}, rather than written out
 * here — this was the one helper on the page that had it. */
export const logsDirectoryOn = (serverId?: string | null) =>
  `${cloudgateDirectoryOn(serverId)}/logs`;

/**
 * One owner's deployment-log directory, `{logsDirectoryOn(serverId)}/{appName}`,
 * on the machine that wrote it.
 *
 * The one expression for both halves of ADR-0018's rule: the writers —
 * `DeploymentsService.initializeLog` for an Application or a Compose stack,
 * `BackupRunRecorderService.start` for a schedule, a database backup and a volume
 * backup — create their logs under it, and `common/teardown-steps.ts`'
 * `reclaimDeploymentLogs` removes it when the row that names the owner is
 * deleted. `serverId` is whatever the writer asked: `buildHostServerId`'s
 * answer for an Application, `compose.serverId` for a stack, the run target
 * for the other three.
 */
export const deploymentLogsDirectoryOn = (
  serverId: string | null | undefined,
  appName: string,
) => `${logsDirectoryOn(serverId)}/${appName}`;

/**
 * The compose tree, for the machine that holds the stack — a compose project
 * tree lives at `{composeDirectoryOn(serverId)}/{appName}/code`, with its file
 * mounts beside it at `.../{appName}/files`.
 *
 * **What broke first.** This was `composeDirectory()`, i.e.
 * {@link localCloudgateDirectory}, for every machine alike, while every one of
 * its call sites is interpolated into a command sent to the stack's own Server.
 * So on an install with `CLOUDGATE_DIRECTORY` set, a stack deployed to a Server
 * cloned into a root `serverSetupCommand` never laid out there, and the
 * `docker compose -f` that follows named a file under it.
 *
 * The `serverId` is `compose.serverId`, which for a stack is **both** answers
 * at once: `ComposeService.findCompose` hard-codes `buildServerId: null`, so
 * `buildHostServerId` falls through to the run Server and a stack has one
 * machine rather than the Application's two. That is why this helper takes the
 * column directly where {@link applicationsDirectoryOn} takes
 * `buildHostServerId`'s answer, and why a stack's file mounts need no sibling
 * of {@link fileMountsDirectoryOnRunServer}: the daemon that resolves
 * `{composeDirectoryOn}/{appName}/files` as a `volumes:` source is the daemon
 * on the machine `MountsService` wrote the file to, so this one helper already
 * answers for the writer and the mount at once.
 *
 * **All nine call sites converted together**, which is ADR-0018's rule
 * stated for roots. The tree's *writers* are
 * `DeploymentEngineService.deployCompose`'s clone and `MountsService`'s
 * `baseFilesPath`; its *destroyer* is `compose/compose-directory.ts`'
 * `reclaimComposeDirectory`, an `rm -rf` on the project directory that was
 * `composeTeardownCommand`'s last statement once; and its *readers* are `getComposeFilePath`,
 * `removeComposeContainersCommand`, `composeStartCommand`'s `up`,
 * `getBuildComposeCommand`'s project path, `ComposeService`'s own `stop`, and
 * `PatchService.generateApplyPatchesCommand`. `MountsService.remove`'s `rm -rf`
 * of one file mount is a tenth *artifact* and not a tenth call site: it asks
 * `baseFilesPath` for the same one expression the write asks, which is why that
 * mount cannot be written under one root and removed from another — this list
 * named it as a site of its own until a census counted the
 * invocations instead of re-reading the prose.
 *
 * Converting fewer than all nine would have written the tree under one root and
 * `rm -rf`'d it from another — moving the leak rather than closing it.
 * `test/compose/compose-tree-roots.e2e-spec.ts` holds **eight of the nine** to
 * each other, by taking the teardown's and the start's expectations from
 * `deployCompose`'s own clone dispatch: it drives a deploy, a file-mount write
 * and removal, a Start, a Stop, a Remove containers, a teardown and a Project
 * delete. The ninth is `PatchService.generateApplyPatchesCommand`'s compose arm,
 * which it does not drive — so, like its source-tree sibling above, it can only
 * read programs a test dispatches, and a tenth site of that shape would pass
 * it. See {@link applicationsDirectoryOn} for why that limit is stated rather
 * than claimed away, and the census named there for what holds the class shut.
 */
export const composeDirectoryOn = (serverId?: string | null) =>
  `${cloudgateDirectoryOn(serverId)}/compose`;

/**
 * The volume-backup staging tree, for the machine the volume is on — a tarball
 * is staged under `{volumeBackupsDirectoryOn(serverId)}/…` before its rclone
 * upload, and downloaded back into it by a restore.
 *
 * **What broke first.** This was `volumeBackupsDirectory()`, i.e.
 * {@link localCloudgateDirectory}, while both call sites are baked into scripts
 * `execRclone` sends to the Service's own Server. The staging directory is a
 * `docker run -v` bind source and an rclone destination, and both of those
 * *create* what is missing, so with `CLOUDGATE_DIRECTORY` set the effect was
 * not a failure but a tree minted on the Server under a root nothing on that
 * machine owns, reclaimed by nothing — the `unreclaimedArtifacts` shape
 * ADR-0018 is about, one directory along.
 *
 * The `serverId` is the Service's own — `ServiceParent.serverId`, i.e. the
 * **run** Server and never a build host, because a Docker volume is an object
 * on the machine that runs the workload mounting it.
 *
 * **Both call sites converted together**: `VolumeBackupsService.run`
 * writes the tarball there and its own `removeStagedTarball` deletes it on the
 * failure path, and `buildVolumeRestoreScript` downloads into it and `rm`s what
 * it extracted. The two do not share a leaf — the backup stages under
 * `{appName}` and the restore under `{volumeName}` — which is a pre-existing
 * asymmetry this conversion deliberately preserves rather than quietly
 * normalises, since changing where a tarball lands is a different ticket from
 * changing which root it lands under.
 */
export const volumeBackupsDirectoryOn = (serverId?: string | null) =>
  `${cloudgateDirectoryOn(serverId)}/volume-backups`;

/**
 * The prefix of the per-**volume** lock file that serializes every operation
 * which mutates a volume: a backup of it (turn-off or not), a restore of it,
 * and Remove containers on a compose stack that backs it up. Keyed by volume
 * rather than by service — `volume-lock.ts` owns both the key and
 * the preamble that takes it.
 *
 * **The thing to establish before converting this, established**. A lock
 * whose path two callers compute differently is not a lock, so the first
 * question was whether the three takers already disagreed — which would have
 * been a hole in the volume lock's serialization rather than a wrong root. They did not,
 * and the reason is structural rather than lucky: all three reach the path
 * through `volume-lock.ts`' `volumeLockPathFor` and nothing else in the product
 * spells it, so there is one expression; and all three scripts are dispatched
 * to the same machine, because a backup and a restore go to
 * `ServiceParent.serverId` and Remove containers to `compose.serverId`, which
 * for the compose rows that can share a volume are the same column of the same
 * row. So the lock holds as written, and this conversion is a root fix and not a
 * concurrency fix.
 *
 * **What the wrong root did cost is the one place on this page where it was
 * not merely a misplaced directory.** The staging trees above are created by
 * whatever writes them; a lock file is not. `exec 9>"$LOCK_PATH"` does not
 * create its parent, so with `CLOUDGATE_DIRECTORY` set, every backup, restore
 * and Remove containers dispatched to a Server aborted in its own preamble —
 * and on a host with no `flock`, the `mkdir` fallback turned the same missing
 * directory into the *busy* branch, so the route answered **409 "volume is
 * busy"** about a lock nobody held, for ever. That is why this helper is in the
 * same commit as the two above rather than deferred behind them.
 */
export const volumeBackupLockPathOn = (serverId?: string | null) =>
  `${cloudgateDirectoryOn(serverId)}/volume-backup-lock`;

/**
 * The schedules tree, for the machine that runs the schedule —
 * `server`/`cloudgate-server` schedules materialize their script under
 * `{schedulesDirectoryOn(serverId)}/{appName}/script.sh`.
 *
 * **What broke first.** This was `schedulesDirectory()`, i.e.
 * {@link localCloudgateDirectory}, for every machine alike, while all three of
 * its call sites are baked into commands sent to the schedule's own Server. So
 * on an install with `CLOUDGATE_DIRECTORY` set, a `server` schedule's
 * `mkdir -p` created a tree under a root `serverSetupCommand` never laid out on
 * that host and the cron then `bash -c`'d a `script.sh` there.
 *
 * The `serverId` is `ScheduleTarget.serverId` — the named Server for a `server`
 * schedule, `null` (the platform host, ADR-0008) for a `cloudgate-server` one.
 * The two container types materialize nothing, so they never reach this.
 *
 * **All three call sites converted together**, and the middle one is why
 * this set is not merely a leak: `buildScriptMaterializationCommand` writes the
 * script, `buildScriptRemovalCommand` destroys it, and
 * `buildScheduleScriptRunCommand` *runs* it. A root that forked between the
 * writer and the runner would be a schedule failing every night, or — where the
 * local root happens to exist on the Server too — one running a stale script no
 * update had reached.
 *
 * **The no-argument spelling is gone rather than kept**, as every one on this
 * page now is: every caller was
 * `scheduling/schedules/schedule-commands.ts` and all of them now pass a
 * machine. `test/scheduling/schedule-script-roots.e2e-spec.ts` holds the three
 * to each other by taking the run's and the removal's expectations from the
 * create's own dispatch.
 */
export const schedulesDirectoryOn = (serverId?: string | null) =>
  `${cloudgateDirectoryOn(serverId)}/schedules`;

/**
 * The patch-repos tree, for the machine that holds the clone — browsable source
 * clones live under
 * `{patchReposDirectoryOn(serverId)}/{application|compose}/{appName}`.
 *
 * **What broke first, and it is the one instance of this defect that was
 * captured live.** This was `patchReposDirectory()`, i.e.
 * {@link localCloudgateDirectory}, for every machine alike. A live run set
 * `CLOUDGATE_DIRECTORY` and produced a delete report whose
 * `unreclaimedArtifacts` entry named `{configuredRoot}/patch-repos/application/
 * web-app` as a directory *on a remote build Server* — a path
 * `serverSetupCommand` never created there, so `ensureRepo`'s clone landed
 * under a root that does not exist on the builder, both read routes looked for
 * it there, and the Delete's `rm -rf` and `cleanRepos`' glob named it too.
 *
 * The `serverId` is the machine that holds *that entity's* clone, which is the
 * **build host** for an Application (`buildHostServerId`) and the run Server
 * for a Compose stack — `PatchRepoService.findEntity` is the one statement of
 * that fork and carries why the compose arm is not an inconsistency.
 * `cleanRepos` passes the Server the operator named instead, because it globs
 * that whole tree rather than one entity's clone.
 *
 * **All five call sites converted together**, which is ADR-0018's rule
 * stated for roots: `PatchRepoService.ensureRepo` writes the clone, and
 * `patch-repo-clone.ts`'s `removePatchRepoStep` and
 * `PatchRepoService.cleanRepos` destroy it, so converting either half alone
 * would have cloned under one root and `rm -rf`'d another — moving the leak
 * rather than closing it. The two read routes are in the set for
 * `resolveRepoPath`'s own reason: one expression, so none of the five can
 * disagree about which directory a patch applies to.
 *
 * **The no-argument spelling is gone rather than kept**, as every one on this
 * page now is: every caller was in `patch/` and every one
 * of them now passes a machine, so what survived would be an export with no
 * correct call site. `test/patch/patch-repo-roots.e2e-spec.ts` holds the set to
 * each other by taking the removal's expectation from `ensureRepo`'s own
 * dispatch, and it drives all five — the writer, both read routes, the removal
 * and `cleanRepos`' glob — which makes it the widest of the three root suites.
 * What holds the five is still `resolveRepoPath` rather than
 * the suite: there are exactly **two** invocations of this helper in `src/`,
 * that function and `cleanRepos`, so five sites cannot disagree because four of
 * them do not compute the path at all. A sixth site spelling its own root would
 * be as invisible here as the patch block was to the source-tree suite — see
 * {@link applicationsDirectoryOn}, whose sentence claiming otherwise was
 * corrected.
 */
export const patchReposDirectoryOn = (serverId?: string | null) =>
  `${cloudgateDirectoryOn(serverId)}/patch-repos`;
