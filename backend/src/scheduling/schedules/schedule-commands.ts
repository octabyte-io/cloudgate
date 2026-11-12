import { quote } from 'shell-quote';
import { ownerOnlyDirectoryCommand } from '../../common/files/owner-only';
import { encodeBase64 } from '../../docker/docker.utils';
import { schedulesDirectoryOn } from '../../deployment-engine/deployment-engine.paths';

// Pure command builders for user schedules — script materialization and
// execution — kept free of DB and exec concerns so unit tests can pin the
// literals.

/**
 * The directory a schedule's script.sh (and nothing else) lives in, on the
 * machine that runs it.
 *
 * Every command below interpolates this path, and the four verbs it reaches are
 * `mkdir -p`, `chmod`, `mv -f` and `rm -rf` — so each word carrying it goes
 * through `quote()` (the rule and what it is defending are on
 * `builders/build-strategy.ts`'s `BuildStrategy`). `appName` is held to
 * `APP_NAME_REGEX` at the mint since the same issue, which makes the quoting
 * here defence in depth rather than the only thing standing between the column
 * and an `rm -rf` on the schedule's Server.
 *
 * **`serverId` is a required parameter, and being required *is* the
 * verification** (`previewCodeDirectory` is the precedent). This
 * resolved `localCloudgateDirectory()` for every machine, so a `server`
 * schedule materialized, ran and removed its script under a root
 * `serverSetupCommand` never created on that Server. It is
 * `ScheduleTarget.serverId` — the named Server, or `null` for the platform host
 * (ADR-0008) — and every builder below takes it rather than deriving it, so the
 * three of them cannot answer differently for one schedule. Defaulting it was
 * rejected: the default would be the local root, which is the bug.
 */
export const scheduleScriptPath = (
  appName: string,
  serverId: string | null,
): string => `${schedulesDirectoryOn(serverId)}/${appName}`;

/**
 * Write the schedule's script base64-encoded to
 * `{schedulesDirectoryOn(serverId)}/{appName}/script.sh`, executable, with the
 * PID / Schedule ID echo header prepended so runs can report their PID.
 *
 * The **writer** of the set {@link scheduleScriptPath} describes, so its
 * `serverId` is the one the runner and the removal must also be given.
 */
export const buildScriptMaterializationCommand = (
  schedule: {
    scheduleId: string;
    appName: string;
    // Nullable *and* optional: the caller is a pre-insert value
    // object built from the DTO, where an omitted script is undefined rather
    // than the column's null.
    script?: string | null;
  },
  serverId: string | null,
): string => {
  const fullPath = scheduleScriptPath(schedule.appName, serverId);
  const scriptWithPid = `echo "PID: $$ | Schedule ID: ${schedule.scheduleId}"\n${schedule.script || ''}`;
  const encodedContent = encodeBase64(scriptWithPid);
  // Written beside the target and moved onto it, never onto it directly:
  // `mv` inside one directory is atomic on POSIX, so a materialization that
  // dies half-way leaves the previous script.sh exactly as it was instead of
  // truncated or gone. The old shape opened with `rm -f script.sh`, which
  // meant a failed write destroyed a working script while the row went on
  // claiming one. `set -e` so a failed mkdir cannot reach the mv.
  //
  // The directory is `0700`: the script is operator-authored and is
  // where a token for a `curl` goes, and it used to sit `0755` under directories
  // the console's `cloudgate` user could walk. Only root runs it, and the
  // closed directory rather than the file's mode is what keeps the `+x`.
  const tmpPath = quote([`${fullPath}/script.sh.tmp`]);
  return `
	 	 set -e
	 	 ${ownerOnlyDirectoryCommand(fullPath)}
		 echo "${encodedContent}" | base64 -d > ${tmpPath}
		 chmod +x ${tmpPath}
		 mv -f ${tmpPath} ${quote([`${fullPath}/script.sh`])}
	`;
};

/** Drop the schedule's script directory, on
 * the machine {@link buildScriptMaterializationCommand} wrote it on. */
export const buildScriptRemovalCommand = (
  appName: string,
  serverId: string | null,
): string => `rm -rf ${quote([scheduleScriptPath(appName, serverId)])}`;

export interface ScheduleCommandScriptOptions {
  /** Command echoing the target container id (container-search helpers). */
  containerSearch: string;
  shellType: string;
  /** The user's command, docker-exec'd in the target container. */
  command: string;
  /** Log file the run appends progress to (the deployment record's). */
  logPath: string;
}

/**
 * The shell variable `schedule.command`'s value arrives in, and the reason it
 * has a name of its own rather than travelling under a name of the operator's.
 *
 * `build-env.ts`' `CG_BUILD_ENV_<n>` is the precedent and the argument is the
 * same one, minus the part that does not apply: a holder keeps
 * operator-*chosen* names out of a shell where `PATH` and `LD_PRELOAD` are
 * live. Here there is only ever one value and no operator-chosen name at all,
 * so the holder is a fixed literal — which also means it is valid against
 * `RemoteExecService`'s `ENV_NAME` by construction rather than by luck.
 */
export const SCHEDULE_COMMAND_HOLDER = 'CG_SCHEDULE_COMMAND';

/**
 * A schedule run's program, plus the environment the values it references
 * travel in.
 *
 * The two are returned together, and that is the point: a builder that emitted
 * the program and left the caller to remember the environment would run the
 * schedule with an unset holder — an empty command, exit 0, a green run and
 * nothing done. `build-env.ts`' `CarriedBuildEnv` pairs them for the same
 * reason.
 */
export interface ScheduleRunProgram {
  /** The shell program, referencing {@link SCHEDULE_COMMAND_HOLDER}. */
  program: string;
  /**
   * Holder → value, for `RemoteExecOptions.env` / `ExecOptions.env`. Empty for
   * a script run, which has no value to keep off its command line — and an
   * empty environment leaves that branch on the transport it has always used
   * (ADR 0015).
   */
  env: Record<string, string>;
}

/**
 * Application/compose schedules: docker exec the command in the target
 * container, logging each step into the deployment's log file. The container
 * search is embedded in the script rather than made over the docker API first
 * (the buildBackupScript precedent).
 *
 * **`command` is not a word of this program at all, and that replaced
 * the `quote()` once put on it.** It travels in
 * {@link SCHEDULE_COMMAND_HOLDER} — `RemoteExecOptions.env`, which
 * `RemoteExecService` sends as `export` lines on the SSH channel — and the
 * program references the holder, which the remote shell expands. The quoting
 * finding still explains why the value cannot simply be interpolated: it used
 * to be wrapped in the script's own `'…'`, so a `'` in the column ended the
 * quoting and the rest ran **on the host** instead of inside the container,
 * past the owner-or-admin gate that a host-running schedule carries and a
 * container one does not (`SchedulesService.checkAccess`). `quote()` closed
 * that; never-carry closes it and the journal echo together, and it is what ADR
 * 0015's *a mask is the second-choice answer* bullet asks for in place of a
 * fifth elision pattern.
 *
 * **What never-carry buys here, exactly.** `ExecError` captures the program, and
 * pino writes it six times over (`common/logging/error-payloads.ts`), so a
 * container command holding `PGPASSWORD=…` or a `curl -H "Authorization: …"`
 * was journalled by every failed run — and every failed run, because the
 * `|| { … exit 1; }` below turns the operator's own non-zero exit into a failed
 * exec. None of the four masking patterns reaches a bare container command: it
 * is not base64, not a PEM, not `printf %s | docker login`, not URL userinfo.
 * Now there is nothing in the program to elide.
 *
 * **What it does not buy, stated because the build accepted the same
 * residual.** The host shell expands the holder into `docker`'s argv, so the
 * value is in the host's process table for the life of the exec — exactly as
 * `--env KEY"=$CG_BUILD_ENV_0"` puts a build variable into nixpacks' argv. That
 * is unavoidable for a program `docker exec` must receive as an argument, it is
 * no worse than before, and it is not what was leaking: the process table is
 * transient and local, the journal is durable and central.
 *
 * `"$…"` and not `${quote([…])}`: `quote()` escapes the `$`, which is the whole
 * mechanism, and the double quotes are what keep a command with spaces one
 * word. Semantics are preserved, as they were under `quote()` — the value is
 * still one `-c` argument, so a pipeline or a `&&` inside it works exactly as
 * before.
 *
 * **The log echo keeps the command verbatim, deliberately.** It expands the
 * holder, so the deployment log reads byte-for-byte what it read before. That
 * is not a hole in the classification: `DeploymentsService.resolveLogServer`
 * reaches a schedule run's log through `scheduleRunServer`, which calls
 * `SchedulesService.findOne` — `checkRowAccess(ctx, row, 'read')`, the same
 * predicate that answers `GET /schedules/:id` with the column in clear. The log
 * reader is the column reader, and the log file sits on the host that is about
 * to run the command anyway, which is the far end ADR 0006 does not claim to
 * defend. The echo is also load-bearing: it is how an operator sees what a run
 * that failed *last night* ran, which the row cannot answer once the command
 * has been edited.
 *
 * `< /dev/null` on the exec, because an environment moves the program onto the
 * remote shell's stdin (`RemoteExecService`'s `buildEnvScript`) and a step that
 * reads stdin there eats the rest of the script and exits 0. `docker exec`
 * without `-i` does not read stdin, so this is what keeps that true of a
 * program somebody appends a step to — `DeploymentEngineService.deploy` carries
 * the same redirect for the same reason.
 *
 * `logPath` is `quote()`d at all six redirects. It *is* a deployment log —
 * addressed by its deployment, never by a path a caller supplies
 * (`CONTEXT.md`), and composed from `logsDirectoryOn()`, a
 * `generateAppName('schedule')` appName and a nanoid — and that sentence is why
 * it used to be bare, which is the argument H-12 killed: a charset (or a mint)
 * three modules away is only ever right for the context it was written for, and
 * nothing in this file links the two. **The quoting is the defence and the mint
 * stands behind it** (`builders/build-strategy.ts`). `quote()` rather than
 * H-12's `"…"` because no `assertShellSafePath` guards this sink, so double
 * quotes would leave `$(…)` live; an already-safe path comes out unchanged, so
 * the pinned literals did not move.
 *
 * `containerSearch` stays bare — it is a command by contract, not a value, and
 * `CONTAINER_ID=$(…)` is the contract. That contract was broken by its builder
 * when this was written: `backups/commands/utils.ts`'s
 * `getComposeContainerCommand` interpolated the schedule's `serviceName` into
 * `--filter "label=com.docker.compose.service=${serviceName}"`, and
 * `serviceName` is a bare `z.string()` in `schedule.dto.ts` — double quotes do
 * not stop `$(…)`. **Closed by H-35**, which `quote()`s every label word in
 * that helper, so both of its callers get it. Left on the record because the
 * bare `containerSearch` here only reads as safe once you know that.
 */
export const buildScheduleCommandScript = ({
  containerSearch,
  shellType,
  command,
  logPath,
}: ScheduleCommandScriptOptions): ScheduleRunProgram => {
  const log = quote([logPath]);
  const held = `"$${SCHEDULE_COMMAND_HOLDER}"`;
  const shell = quote([shellType]);
  return {
    env: { [SCHEDULE_COMMAND_HOLDER]: command },
    program: `
	CONTAINER_ID=$(${containerSearch})

	if [ -z "$CONTAINER_ID" ]; then
		echo "❌ Error: Container not found" >> ${log};
		exit 1;
	fi

	set -e
	echo "Running command: docker exec $CONTAINER_ID" ${shell} -c ${held} >> ${log};
	docker exec $CONTAINER_ID ${shell} -c ${held} >> ${log} 2>> ${log} < /dev/null || {
		echo "❌ Command failed" >> ${log};
		exit 1;
	}
	echo "✅ Command executed successfully" >> ${log};
	`,
  };
};

/**
 * Server/cloudgate-server schedules: run the materialized script.sh, teeing
 * its output into the deployment's log file. No PID is captured, so both hosts
 * share this one wrapper.
 *
 * `logPath` is `quote()`d for the reason {@link buildScheduleCommandScript}
 * gives at length: it is machine-made today, and a mint two modules away is not
 * what a reader of *this* line can check (H-34). The script path was already
 * quoted, so this is the last bare word in the file.
 *
 * The `serverId` is the schedule's, and it is here so that the file this runs
 * is the file {@link buildScriptMaterializationCommand} wrote — a
 * *runner* under the other root is the arm of that defect that fails nightly
 * rather than leaking, and `logPath` already arrives resolved for the same
 * machine through `logsDirectoryOn`.
 */
export const buildScheduleScriptRunCommand = (
  appName: string,
  logPath: string,
  serverId: string | null,
): string => {
  const fullPath = scheduleScriptPath(appName, serverId);
  const log = quote([logPath]);
  return `
	set -e
	echo "Running script" >> ${log};
	bash -c ${quote([`${fullPath}/script.sh`])} 2>&1 | tee -a ${log} || {
		echo "❌ Command failed" >> ${log};
		exit 1;
	  }
	echo "✅ Command executed successfully" >> ${log};
	`;
};
