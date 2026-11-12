import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import {
  cloudgateDirectoryOn,
  REMOTE_CLOUDGATE_DIRECTORY,
} from '../../src/common/config/cloudgate-directory';
import {
  buildScheduleCommandScript,
  buildScheduleScriptRunCommand,
  buildScriptMaterializationCommand,
  buildScriptRemovalCommand,
  SCHEDULE_COMMAND_HOLDER,
  scheduleScriptPath,
} from '../../src/scheduling/schedules/schedule-commands';
import {
  expectQuotedInCommand,
  expectValueIsInert,
  INERT_VALUE,
  SEPARATOR_PAYLOAD,
  SHELL_PAYLOAD,
} from '../utils/shell-safety';

// The pure command builders that write, remove and run a schedule's script.
// They are the one place the on-disk shape of a schedule's script.sh is
// decided, so the literals are pinned here rather than only through the
// service's e2e.

const appName = 'schedule-abc123';

/**
 * The directory every builder below is called for with `serverId: null`, which
 * is the platform host (ADR-0008) — so its root is this process's
 * CLOUDGATE_DIRECTORY, asked of the machine rather than spelled. It was
 * the literal `/etc/cloudgate` until then, which is a Server's root and was
 * right here only while the variable was unset.
 */
const scriptDirectory = `${cloudgateDirectoryOn(null)}/schedules/${appName}`;

/**
 * The app name the shell-safety assertions below feed in.
 *
 * `appName` reaches `mkdir -p`, `chmod`, `mv -f`, `rm -rf` and the
 * `bash -c` that runs the script. It is held to `APP_NAME_REGEX` at the mint
 * since the same issue, so these are the second line of defence rather than the
 * first — which is why the payload is fed in directly here instead of through a
 * create.
 */
const injectedAppName = SHELL_PAYLOAD;

describe('scheduleScriptPath', () => {
  it('roots the schedule script directory at SCHEDULES_PATH/appName', () => {
    expect(scheduleScriptPath(appName, null)).toBe(scriptDirectory);
  });

  /**
   * The root, which is a second question and was answered wrongly until the fix:
   * the path resolved `localCloudgateDirectory()` for every machine, so a
   * `server` schedule materialized, ran and removed its script under a root
   * `serverSetupCommand` never created on that Server.
   *
   * Nothing outside this block can see that, and the reason is the whole
   * defect class: every other call in this file asks for the platform host,
   * and with `CLOUDGATE_DIRECTORY` unset the two roots are the same literal,
   * so a builder answering either one passes there. Hence the real temp
   * directory and the resolved expectations — `/etc/cloudgate` exists and is
   * writable on some development hosts, so a silent fall back would read as a
   * pass.
   */
  describe('the root it derives the directory under', () => {
    const configured = fs.realpathSync(
      fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-schedule-path-')),
    );
    const original = process.env.CLOUDGATE_DIRECTORY;

    beforeEach(() => {
      process.env.CLOUDGATE_DIRECTORY = configured;
    });

    afterEach(() => {
      if (original === undefined) delete process.env.CLOUDGATE_DIRECTORY;
      else process.env.CLOUDGATE_DIRECTORY = original;
    });

    afterAll(() => {
      fs.rmSync(configured, { recursive: true, force: true });
    });

    it('is the Server’s own root for a schedule that runs on one', () => {
      expect(scheduleScriptPath(appName, 'srv_123')).toBe(
        `${REMOTE_CLOUDGATE_DIRECTORY}/schedules/${appName}`,
      );
    });

    // `cloudgate-server` *is* this process's machine (ADR-0008), and this is
    // the branch CLOUDGATE_DIRECTORY exists for.
    it('is this instance’s configured root for the platform host', () => {
      expect(scheduleScriptPath(appName, null)).toBe(
        `${configured}/schedules/${appName}`,
      );
    });

    /**
     * The three builders share one answer, which is what makes the set atomic:
     * the writer, the runner and the destroyer all name the same directory for
     * one `(appName, serverId)` pair, so none of them can be converted alone.
     */
    it('is the same directory for the writer, the runner and the destroyer', () => {
      const directory = scheduleScriptPath(appName, 'srv_123');

      expect(
        buildScriptMaterializationCommand(
          { scheduleId: 'sched-1', appName, script: 'apt update' },
          'srv_123',
        ),
      ).toContain(`mkdir -p ${directory}`);
      expect(
        buildScheduleScriptRunCommand(appName, '/var/log/run.log', 'srv_123'),
      ).toContain(`bash -c ${directory}/script.sh`);
      expect(buildScriptRemovalCommand(appName, 'srv_123')).toBe(
        `rm -rf ${directory}`,
      );
    });
  });
});

describe('buildScriptMaterializationCommand', () => {
  const command = buildScriptMaterializationCommand(
    { scheduleId: 'sched-1', appName, script: 'apt update' },
    null,
  );

  it('writes the script beside script.sh and moves it into place', () => {
    expect(command).toContain(`mkdir -p ${scriptDirectory}`);
    expect(command).toContain(`| base64 -d > ${scriptDirectory}/script.sh.tmp`);
    expect(command).toContain(`chmod +x ${scriptDirectory}/script.sh.tmp`);
    expect(command).toContain(
      `mv -f ${scriptDirectory}/script.sh.tmp ${scriptDirectory}/script.sh`,
    );
    // The mv is last: everything that can fail happens to the tmp file.
    expect(command.trim().split('\n').pop()!.trim()).toBe(
      `mv -f ${scriptDirectory}/script.sh.tmp ${scriptDirectory}/script.sh`,
    );
    // Without set -e a failed mkdir would go on to mv a file that is not there.
    expect(command).toContain('set -e');
  });

  it('never deletes or truncates the live script.sh', () => {
    // The old shape deleted the working script before writing its replacement,
    // so a materialization that died in between left the row advertising a
    // script the next cron tick could not run.
    expect(command).not.toContain(`rm -f ${scriptDirectory}/script.sh`);
    expect(command).not.toContain(`touch ${scriptDirectory}/script.sh`);
    expect(command).not.toContain(`base64 -d > ${scriptDirectory}/script.sh\n`);
  });

  it('prepends the PID / Schedule ID header to the base64 payload', () => {
    expect(decodePayload(command)).toBe(
      'echo "PID: $$ | Schedule ID: sched-1"\napt update',
    );
  });

  it('encodes an empty script for a schedule that carries none', () => {
    const empty = buildScriptMaterializationCommand(
      { scheduleId: 'sched-2', appName, script: null },
      null,
    );
    expect(decodePayload(empty)).toBe(
      'echo "PID: $$ | Schedule ID: sched-2"\n',
    );
  });

  it('quotes the script path it writes and moves', () => {
    expectQuotedInCommand(
      buildScriptMaterializationCommand(
        {
          scheduleId: 'sched-1',
          appName: injectedAppName,
          script: 'apt update',
        },
        null,
      ),
    );
  });
});

describe('buildScriptRemovalCommand', () => {
  it('drops the whole script directory', () => {
    expect(buildScriptRemovalCommand(appName, null)).toBe(
      `rm -rf ${scriptDirectory}`,
    );
  });

  it('quotes the script path it removes', () => {
    expectQuotedInCommand(buildScriptRemovalCommand(injectedAppName, null));
  });
});

describe('buildScheduleScriptRunCommand', () => {
  const command = buildScheduleScriptRunCommand(
    appName,
    '/var/log/run.log',
    null,
  );

  it('runs script.sh, never the tmp file the materialization moves from', () => {
    expect(command).toContain(
      `bash -c ${scriptDirectory}/script.sh 2>&1 | tee -a /var/log/run.log`,
    );
    expect(command).not.toContain('script.sh.tmp');
  });

  it('quotes the script path it runs', () => {
    expectQuotedInCommand(
      buildScheduleScriptRunCommand(
        injectedAppName,
        '/etc/cloudgate/logs/x.log',
        null,
      ),
    );
  });
});

/** The script.sh content a materialization command writes. */
function decodePayload(command: string): string {
  const match = command.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/);
  expect(match).not.toBeNull();
  return Buffer.from(match![1], 'base64').toString('utf8');
}

describe('buildScheduleCommandScript', () => {
  /**
   * The injection finding, and the reason its `quote()` was replaced rather than
   * dropped: the container command used to sit inside the script's own `'…'`,
   * so a `'` in the column ended the quoting and the rest ran **on the host**
   * — past the owner-or-admin gate a host-running schedule carries and a
   * container one does not.
   *
   * The command now is not a word of the program at all, so this asserts
   * the stronger property directly: **absence**. `expectQuotedInCommand` is
   * deliberately not used, and cannot be — it requires the value to be present
   * in some literal word so it can check the word is one word, and the whole
   * claim here is that no word carries it.
   *
   * The program's own substitutions are asserted by name for the other half of
   * that claim: three, all three authored by this builder, none of them a byte
   * the operator can write.
   */
  it("keeps a quote in the user's command out of the program entirely", () => {
    const command = `echo '; ${SHELL_PAYLOAD}`;
    const { program, env } = buildScheduleCommandScript({
      containerSearch: 'docker ps -q',
      shellType: 'sh',
      command,
      logPath: '/etc/cloudgate/logs/x.log',
    });

    expect(program).toContain('docker exec');
    expect(program).not.toContain(SHELL_PAYLOAD);
    expect(env[SCHEDULE_COMMAND_HOLDER]).toBe(command);

    // Every `$` in the program, and all of them are this file's own — the
    // command substitution that finds the container, the variable it lands in,
    // and the holder the operator's command arrives in.
    expect(program.match(/\$[({]?[A-Za-z_][A-Za-z0-9_]*/g)?.sort()).toEqual([
      '$(docker',
      '$CG_SCHEDULE_COMMAND',
      '$CG_SCHEDULE_COMMAND',
      '$CONTAINER_ID',
      '$CONTAINER_ID',
      '$CONTAINER_ID',
    ]);
  });

  /**
   * This is the whole of the command fix's first half.
   *
   * `schedule.command` is operator-authored program text that can hold
   * `PGPASSWORD=…` or a `curl -H "Authorization: …"`, and it was a word of the
   * program handed to `RemoteExecService` — so `ExecError` captured it and pino
   * wrote it six times over (`common/logging/error-payloads.ts`). None of
   * the error mask's four patterns reaches it: it is not base64, not a PEM, not
   * `printf %s | docker login` and not URL userinfo. A **container schedule
   * whose command exits non-zero** journals itself, and that is the ordinary
   * outcome rather than an edge case, because the script answers a failed
   * `docker exec` with `exit 1`.
   *
   * ADR 0015's mask-is-second-choice bullet asks for never-carry rather than a
   * fifth pattern,
   * and the never-carry `carryBuildEnv` is the shape: the value travels in
   * `RemoteExecOptions.env`, which `RemoteExecService` sends as `export` lines
   * on the SSH channel, and the program *references* a holder the remote shell
   * expands. There is nothing in the program to elide, nothing to decode, and
   * no pattern to keep correct.
   */
  it('carries the command in an environment holder rather than in the program', () => {
    const secret =
      'PGPASSWORD=hunter2 pg_dump cloudgate | curl -H "Authorization: Bearer sk-live-9f3ad2" -T - https://api.example.com';
    const { program, env } = buildScheduleCommandScript({
      containerSearch: 'docker ps -q',
      shellType: 'bash',
      command: secret,
      logPath: '/etc/cloudgate/logs/x.log',
    });

    // Not one byte of it, under any spelling: no substring of the command, no
    // base64 of it, nothing to decode.
    expect(program).not.toContain('hunter2');
    expect(program).not.toContain('sk-live-9f3ad2');
    expect(program).not.toContain(Buffer.from(secret).toString('base64'));
    expect(env).toEqual({ [SCHEDULE_COMMAND_HOLDER]: secret });

    // And the holder is referenced twice — the log echo and the exec itself —
    // double-quoted so a command with spaces stays one word, and **not**
    // `quote()`d, because `quote()` escapes the `$` that is the mechanism.
    expect(program).toContain(
      `echo "Running command: docker exec $CONTAINER_ID" bash -c "$${SCHEDULE_COMMAND_HOLDER}" >> /etc/cloudgate/logs/x.log`,
    );
    expect(program).toContain(
      `docker exec $CONTAINER_ID bash -c "$${SCHEDULE_COMMAND_HOLDER}"`,
    );
  });

  /**
   * The deployment log keeps the command **verbatim**, and that is the half of
   * the command fix that had to be preserved rather than closed.
   *
   * The echo is how an operator sees what a failed run actually ran, and — the
   * measured point — it discloses the command to *precisely* the audience
   * already entitled to it: `DeploymentsService.resolveLogServer` reaches a
   * schedule run's log through `scheduleRunServer`, which calls
   * `SchedulesService.findOne`, which is `checkRowAccess(ctx, row, 'read')` —
   * the identical predicate that answers `GET /schedules/:id` with the column
   * in clear. So the log echo is ADR 0015's permitted author echo plus the far
   * end ADR 0006 does not defend, not a widening. The echo therefore expands
   * the holder rather than losing it, which is what makes the program's bytes
   * and the log line's bytes two different questions.
   */
  it('leaves the log line for the remote shell to expand, not the program', () => {
    const { program } = buildScheduleCommandScript({
      containerSearch: 'docker ps -q',
      shellType: 'sh',
      command: 'echo hello',
      logPath: '/etc/cloudgate/logs/x.log',
    });

    // One `echo` of the header per run, and it names the shell and the flag so
    // the line reads as the argv the container was handed.
    expect(program).toContain(
      'echo "Running command: docker exec $CONTAINER_ID"',
    );
    expect(program).toContain('❌ Command failed');
    expect(program).toContain('✅ Command executed successfully');
  });

  /**
   * With an environment set, `RemoteExecService` stops sending the program as
   * the SSH `exec` request and sends it on the channel to a `sh -s` instead —
   * so the program is now on the shell's own **stdin**, and a step inside it
   * that reads stdin eats the rest of the script and exits 0 having skipped it
   * (measured under bash, `RemoteExecService`'s `buildEnvScript`).
   *
   * `docker exec` without `-i` does not read stdin, so nothing here is live
   * today. The redirect is what keeps that true of a program somebody appends a
   * step to, which is the reason `DeploymentEngineService.deploy` carries the
   * same one.
   */
  it('closes stdin on the exec so the program cannot be eaten off the channel', () => {
    const { program } = buildScheduleCommandScript({
      containerSearch: 'docker ps -q',
      shellType: 'sh',
      command: 'echo hello',
      logPath: '/etc/cloudgate/logs/x.log',
    });

    expect(program).toContain('< /dev/null');
  });
});

/**
 * H-34. `logPath` was the last bare word in this file, in ten redirects across
 * the two run-script builders, and the docblock said so on purpose: it is a
 * deployment log, composed from `logsDirectoryOn()`, a
 * `generateAppName('schedule')` appName and a nanoid, so no caller can word it.
 * That is true and is a mint two modules away — the reliance H-12 broke twice
 * over at `getCreateFileCommand` — so the word is quoted and the mint stands
 * behind it. The payload goes in directly because the claim is about the
 * builder, not about the column.
 */
describe('schedule run scripts, log path quoting', () => {
  const logPathFor = (value: string) => `/etc/cloudgate/logs/${value}/run.log`;

  it('keeps the log path in one word in every redirect a container run writes', () => {
    const build = (value: string) =>
      buildScheduleCommandScript({
        containerSearch: 'docker ps -q',
        shellType: 'sh',
        command: 'echo hello',
        logPath: logPathFor(value),
      }).program;

    // Six redirects, and the control arm makes one unquoted copy among them a
    // failure — a "some word carries it" check would pass on the first quoted
    // one and say nothing about the other five.
    expectValueIsInert(build(SEPARATOR_PAYLOAD), build(INERT_VALUE));
  });

  it('keeps the log path in one word in every redirect a script run writes', () => {
    const build = (value: string) =>
      buildScheduleScriptRunCommand(appName, logPathFor(value), null);

    expectValueIsInert(build(SEPARATOR_PAYLOAD), build(INERT_VALUE));
  });
});
