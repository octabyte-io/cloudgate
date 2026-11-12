import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { quote } from 'shell-quote';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import {
  awaitComposeWorkloadAbsent,
  COMPOSE_PRESENCE_TYPES,
  COMPOSE_SETTLE_BUDGET_MS,
  COMPOSE_SETTLE_POLL_MS,
  composeDirectoryProbeCommand,
  composeLifecycleCommand,
  composePresenceCommand,
  composeStartCommand,
  createComposeCommand,
  COMPOSE_ENV_VARIABLE,
  COMPOSE_STACK_ENV_VARIABLE,
  getBuildComposeCommand,
  getBuildComposeProgram,
  getComposeFilePath,
  getCreateComposeEnvFileCommand,
  parseComposeFile,
  readComposeDirectoryPresence,
  readComposeWorkloadPresence,
  removeComposeContainersCommand,
  writeComposeFileCommand,
} from '../../src/compose/compose.utils';
import type { SettleClock } from '../../src/compose/compose.utils';
import { updateComposeSchema } from '../../src/compose/dto/compose.dto';
import type { DeployableComposeSource } from '../../src/compose/compose.types';
import { composeTeardownCommand } from '../../src/compose/compose.utils';
import { composeTypeEnum } from '../../src/compose/compose.schema';
import { runProbe } from '../utils/docker-daemon-stub';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';
import {
  composeProjectPresenceProbe,
  stackPresenceProbe,
} from '../utils/workload-presence-probe';

// The compose builders in `compose.utils.ts`, as pure functions over the
// compose row (deploy path {composeDirectoryOn(serverId)}/{appName}/code,
// cloudgate-network and cloudgate-traefik). Exec is a later slice —
// these tests pin the generated shell against known literals.

const BASE_COMPOSE = `services:
  wordpress:
    image: wordpress:6
`;

const makeCompose = (
  overrides: Partial<DeployableComposeSource> = {},
): DeployableComposeSource => ({
  appName: 'wp-stack',
  composeType: 'docker-compose',
  sourceType: 'github',
  composePath: './docker-compose.yml',
  command: '',
  isolatedDeployment: false,
  env: null,
  // The platform host, so every path below is under `STACK_DIRECTORY`'s root.
  // Which root a *named* Server answers with is
  // `compose-tree-roots.e2e-spec.ts`'s subject.
  serverId: null,
  environment: { env: null, project: { env: null } },
  ...overrides,
});

/**
 * The project directory of `makeCompose`'s stack, on the machine it names: the
 * platform host, whose root is taken from that machine rather than spelled.
 * Every path in this file used to be written `/etc/cloudgate/compose/…`,
 * which is a *Server's* root and matched only while CLOUDGATE_DIRECTORY was
 * unset — the one condition under which the two roots are the same string.
 *
 * Only the root comes from `src`. The tail is a literal rather than
 * `composeDirectoryOn`, because `composeDirectoryOn` is what every builder
 * under test here composes its paths from, and an expectation rebuilt the way
 * the code builds it would follow the code out of the directory (§1.7).
 */
const STACK_DIRECTORY = `${cloudgateDirectoryOn(null)}/compose/wp-stack`;

/**
 * A compose row whose two caller-controlled strings are the injection payload.
 *
 * `composePath` is a `PATCH /compose/:id` column and `appName` a minted
 * one, and between them they reach `-f`, `-c`, `cd`, `docker stack rm`,
 * `docker network …`, a `>` redirect and `rm -rf` on the build server. The
 * count argument of `expectQuotedInCommand` names the substitutions that belong
 * to the command itself rather than to the payload.
 */
const injected = makeCompose({
  appName: SHELL_PAYLOAD,
  composePath: `./${SHELL_PAYLOAD}.yml`,
});

/**
 * The helper the whole deploy addresses the stack's file through, and the
 * subject of the `composePath` traversal fix: it `join`s `composePath` onto
 * `<composeDirectoryOn(compose.serverId)>/<appName>/code`, and `join`
 * normalises. **Three of its six callers in `src/` *write* through the result**
 * (`getCreateComposeEnvFileCommand`'s `.env`, `getBuildComposeCommand`'s
 * compose file, `composeStartCommand`'s rewrite of that file on a Start) and
 * three `cat` it (`ComposeService`'s `readComposeFile` and
 * `readClaimableOnDiskCompose`, `DeploymentEngineService.readComposeContent`),
 * so the column is a write primitive and the refusal belongs on the DTO that
 * sets it. This said "two of its four callers" and named the local
 * `composeDirectory()` since deleted with its last caller; the count was
 * redone on `compose.dto.ts` and this copy brought along, because a reader
 * following the smaller number would have concluded the write set was closed
 * (§1.2).
 *
 * The expected paths are written out below the machine's root
 * (`STACK_DIRECTORY`) rather than composed from `composeDirectoryOn`, for the
 * reason `presenceProbe` is in `compose.e2e-spec.ts`: a test that rebuilds the
 * path the way the code does would follow the code out of the directory.
 */
describe('getComposeFilePath', () => {
  const codeDirectory = `${STACK_DIRECTORY}/code`;

  it('ignores composePath for a raw stack, whose file the clone step always names docker-compose.yml', () => {
    expect(
      getComposeFilePath(
        makeCompose({ sourceType: 'raw', composePath: './deploy/other.yml' }),
      ),
    ).toBe(`${codeDirectory}/docker-compose.yml`);
  });

  it('lands a nested composePath inside the stack code directory', () => {
    // Nesting is a supported configuration, not an accident: the .env is
    // written beside the file, and `./deploy/` is asserted downstream.
    expect(getComposeFilePath(makeCompose())).toBe(
      `${codeDirectory}/docker-compose.yml`,
    );
    expect(
      getComposeFilePath(
        makeCompose({ composePath: './deploy/docker-compose.yml' }),
      ),
    ).toBe(`${codeDirectory}/deploy/docker-compose.yml`);

    for (const composePath of [
      './docker-compose.yml',
      './deploy/compose.yaml',
      './deploy/docker-compose.yml',
      'docker-compose.yml',
    ]) {
      expect(updateComposeSchema.safeParse({ composePath }).success).toBe(true);
    }
  });

  it('is refused at the DTO when composePath walks out of the code directory', () => {
    // Proved against the helper first: the escape is a real write target, not a
    // string a schema happens to dislike.
    const escape = '../../../traefik/dynamic/traefik.yml';
    expect(
      getComposeFilePath(makeCompose({ composePath: escape })).startsWith(
        `${codeDirectory}/`,
      ),
    ).toBe(false);

    for (const composePath of [
      escape,
      'deploy/../../../../etc/hosts',
      '/etc/traefik/dynamic/traefik.yml',
      '',
    ]) {
      expect(updateComposeSchema.safeParse({ composePath }).success).toBe(
        false,
      );
    }
  });
});

describe('createComposeCommand', () => {
  it('builds the docker compose up command', () => {
    expect(createComposeCommand(makeCompose())).toBe(
      'compose -p wp-stack -f ./docker-compose.yml up -d --build --remove-orphans',
    );
  });

  it('builds the docker stack deploy command', () => {
    expect(createComposeCommand(makeCompose({ composeType: 'stack' }))).toBe(
      'stack deploy -c ./docker-compose.yml wp-stack --prune --with-registry-auth',
    );
  });

  it('uses docker-compose.yml for the raw source type regardless of composePath', () => {
    expect(
      createComposeCommand(
        makeCompose({ sourceType: 'raw', composePath: './elsewhere.yml' }),
      ),
    ).toBe(
      'compose -p wp-stack -f docker-compose.yml up -d --build --remove-orphans',
    );
  });

  it('prefers the user-supplied command verbatim', () => {
    expect(
      createComposeCommand(
        makeCompose({ command: 'compose -f custom.yml up -d' }),
      ),
    ).toBe('compose -f custom.yml up -d');
  });

  it('quotes the compose path and app name in the deploy arguments', () => {
    expectQuotedInCommand(`docker ${createComposeCommand(injected)}`);
    expectQuotedInCommand(
      `docker ${createComposeCommand({ ...injected, composeType: 'stack' })}`,
    );
  });
});

// Remove containers, the lifecycle rung between Stop and Delete. Three
// of these four assertions are negative, because what this command must *not*
// do is the whole of why it is its own command: `-v` would take the volume the
// restore is trying to replace, `down` would take the network Traefik is
// attached to, and `teardownCommand`'s `rm -rf` would take the project
// directory `start` reads to bring the stack back (ADR-0011).
//
// They run on the no-lock form, which is what the volume lock promised the
// command would keep being for a project with no turn-off backup rows. The
// wrapper's own shell legitimately says `command -v flock` and `rm -rf
// "$LOCK_DIR"`, so the locked form pins the same absences on the command it
// wraps instead — see the describe below.
describe('removeComposeContainersCommand', () => {
  it('removes the project containers with --stop --force, from the project directory under env -i', () => {
    expect(removeComposeContainersCommand(null, 'wp-stack', [])).toBe(
      `cd ${STACK_DIRECTORY} && env -i PATH="$PATH" docker compose -p wp-stack rm --stop --force`,
    );
  });

  it('carries no -v, so the volume the restore is waiting on survives', () => {
    const command = removeComposeContainersCommand(null, 'wp-stack', []);
    expect(command).not.toMatch(/(^|\s)-v(\s|$)/);
    expect(command).not.toContain('--volumes');
  });

  it('is not down, so the project network Traefik is attached to survives', () => {
    expect(removeComposeContainersCommand(null, 'wp-stack', [])).not.toContain(
      ' down',
    );
    expect(removeComposeContainersCommand(null, 'wp-stack', [])).not.toContain(
      'network disconnect',
    );
  });

  it('leaves the project directory alone, so start can bring the project back', () => {
    expect(removeComposeContainersCommand(null, 'wp-stack', [])).not.toContain(
      'rm -rf',
    );
  });

  it('quotes the app name in the container removal', () => {
    expectQuotedInCommand(
      removeComposeContainersCommand(null, SHELL_PAYLOAD, ['vol-1']),
    );
  });
});

// Remove containers is the third participant in the volume lock: it
// takes the container out from under a turn-off backup that stopped it and is
// still tarring. The command it dispatches is unchanged — it is the same string
// wrapped in an acquisition — which is what these pin.
describe('removeComposeContainersCommand under the volume lock', () => {
  /** Today's command, which every locked form still has to contain verbatim. */
  const RM = `cd ${STACK_DIRECTORY} && env -i PATH="$PATH" docker compose -p wp-stack rm --stop --force`;

  it('takes no lock for a project with no turn-off backup rows', () => {
    // Byte-identical to today: the empty set is the case the primitive returns
    // untouched, and the promise the volume lock made about a project with no
    // such rows.
    expect(removeComposeContainersCommand(null, 'wp-stack', [])).toBe(RM);
    // Nothing was wrapped on the way to that: no preamble at all.
    expect(removeComposeContainersCommand(null, 'wp-stack', [])).not.toContain(
      'LOCK_PATH',
    );
  });

  it('wraps the unchanged command in a fail-fast acquisition of one volume', () => {
    const command = removeComposeContainersCommand(null, 'wp-stack', [
      'wp-data',
    ]);

    // The preamble's words are `quote()`d since H-31 — a path with nothing
    // shell-special in it is emitted bare and a message is single-quoted, and
    // `sh` strips either to the same thing. What is pinned is the volume-keyed
    // path and the busy line, not the quote character.
    // The lock is on the stack's own machine — the platform host, whose root
    // `STACK_DIRECTORY` is under too.
    expect(command).toContain(
      `LOCK_PATH=${cloudgateDirectoryOn(null)}/volume-backup-lock-wp-data`,
    );
    expect(command).toContain('flock -n 9');
    expect(command).toContain("echo 'Volume lock busy: wp-data'");
    expect(command).toContain('exit 75');
    expect(command).toContain(RM);
    // Fail-fast, not a wait: nothing here spins, because this runs inside an
    // HTTP request that would otherwise hang for the length of a tar.
    expect(command).not.toContain('sleep 5');
  });

  it('nests several volumes in the sorted order the primitive guarantees', () => {
    const command = removeComposeContainersCommand(null, 'wp-stack', [
      'wp-uploads',
      'wp-data',
      'wp-data',
    ]);

    // Deduplicated and sorted, so two callers naming the same volumes acquire
    // them in the same order and cannot deadlock against each other.
    expect(
      [...command.matchAll(/echo 'Waiting for volume lock: ([^']+)'/g)].map(
        (match) => match[1],
      ),
    ).toEqual(['wp-data', 'wp-uploads']);
    expect(command.indexOf('volume-backup-lock-wp-data')).toBeLessThan(
      command.indexOf('volume-backup-lock-wp-uploads'),
    );
    // The rm runs once, innermost — under both locks, not once per lock.
    expect(command.split(RM)).toHaveLength(2);
  });
});

// The read Delete runs between the teardown and the row. Both forms have
// to exit 0 whatever happened and name the answer on stdout, because
// `RemoteExecService` rejects on any non-zero exit and the caller has to be able
// to tell "not there" from "cannot reach the daemon" — and, since H-95, the
// third answer is emitted by the probe rather than inferred from a rejection.
/**
 * The directory Start, Stop and Remove containers `cd` into, asked about once
 * one of them has failed: absent means the stack was never deployed
 * there, and the route answers a 409 that says so instead of a bare 500.
 * Run in a real `sh`, because the contract is what the shell prints.
 */
describe('composeDirectoryProbeCommand', () => {
  const sh = (command: string) =>
    execFileSync('sh', ['-c', command], { encoding: 'utf8' });

  it('says present for a directory that is there and absent for one that is not, exiting 0 both times', () => {
    const there = mkdtempSync(join(tmpdir(), 'i442-'));
    try {
      expect(sh(composeDirectoryProbeCommand(there))).toBe('present\n');
      expect(sh(composeDirectoryProbeCommand(join(there, 'code')))).toBe(
        'absent\n',
      );
    } finally {
      rmSync(there, { recursive: true, force: true });
    }
  });

  it('quotes the directory', () => {
    expectQuotedInCommand(
      composeDirectoryProbeCommand(`/etc/cloudgate/compose/${SHELL_PAYLOAD}`),
    );
  });

  it('reads a Server it could not reach as unknown, never absent', async () => {
    expect(
      await readComposeDirectoryPresence('/x', () =>
        Promise.reject(new Error('ssh: connect refused')),
      ),
    ).toBe('unknown');
    expect(
      await readComposeDirectoryPresence('/x', () =>
        Promise.resolve('absent\n'),
      ),
    ).toBe('absent');
  });
});

describe('composePresenceCommand (H-95)', () => {
  it('asks a docker-compose project for its container ids', () => {
    expect(composePresenceCommand('wp-stack', 'docker-compose')).toBe(
      composeProjectPresenceProbe('wp-stack'),
    );
  });

  it('asks the swarm about a stack, which has no compose project to ps', () => {
    expect(composePresenceCommand('wp-stack', 'stack')).toBe(
      stackPresenceProbe('wp-stack'),
    );
  });

  it('exits zero for every answer, and never resolves a dead daemon to absent', () => {
    for (const composeType of ['docker-compose', 'stack'] as const) {
      const command = composePresenceCommand('wp-stack', composeType);
      // Three branches, three tokens, and the one that lets a row be dropped is
      // last — reached only after the daemon positively answered.
      expect(command).toContain('then echo unknown');
      expect(command).toContain('then echo present');
      expect(command).toContain('else echo absent; fi');
      // `|| true` would collapse the answers into one and hand 'present' back
      // for a daemon that is not there. `|| echo absent` was the *actual*
      // defect: it handed `absent` back for a daemon that was not there, which
      // is the direction that drops the row (H-95).
      expect(command).not.toContain('|| true');
      expect(command).not.toContain('|| echo absent');
    }
  });

  /**
   * H-95, executed. Both halves of the compose probe, run through a real
   * `/bin/sh` against a stub `docker` — because the assertions above passed on
   * the bug for as long as it existed, and a compose delete that reads a running
   * project as gone is the delete-while-running failure mode arriving without
   * an attacker.
   *
   * The `docker-compose` half is the one that needs the executed arm most: its
   * question is `[ -n "$( … )" ]`, so a daemon that cannot be reached produces
   * an *empty* substitution rather than a non-zero exit, and `[ -n "" ]` is
   * false. The command never even had a `||` to blame — the emptiness itself
   * read as `absent`.
   */
  describe('under a real shell', () => {
    const cases = [
      {
        composeType: 'docker-compose' as const,
        live: { reachable: true, projects: ['wp-stack'] },
        gone: { reachable: true, projects: [] },
      },
      {
        composeType: 'stack' as const,
        live: { reachable: true, services: ['wp-stack'] },
        gone: { reachable: true, services: [] },
      },
    ];

    for (const { composeType, live, gone } of cases) {
      const command = composePresenceCommand('wp-stack', composeType);

      it(`says present for a running ${composeType}`, () => {
        expect(runProbe(command, live).said).toBe('present');
      });

      it(`says absent for a ${composeType} a reachable daemon does not have`, () => {
        expect(runProbe(command, gone).said).toBe('absent');
      });

      it(`says unknown, not absent, for a running ${composeType} whose daemon is down`, () => {
        const ran = runProbe(command, { ...live, reachable: false });

        expect(ran.said).toBe('unknown');
        expect(ran.said).not.toBe('absent');
        expect(ran.status).toBe(0);
      });
    }
  });

  it('reads nothing but the stack it was given', () => {
    const command = composePresenceCommand('wp-stack', 'docker-compose');
    expect(command).not.toContain('--all');
    expect(command).not.toContain('docker ps');
  });

  it('quotes the app name in the presence read', () => {
    expectQuotedInCommand(composePresenceCommand(SHELL_PAYLOAD, 'stack'));

    // The `docker-compose` presence read puts its `-p <appName>` inside
    // `[ -n "$( … )" ]`, and `shell-quote` hands a whole substitution back as
    // one token whatever is in it — so the *body* of the substitution is what
    // gets parsed here. It is a command in its own right, which is the only
    // reading under which the assertion means anything.
    const presence = composePresenceCommand(SHELL_PAYLOAD, 'docker-compose');
    expectQuotedInCommand(/\$\((.*)\)/.exec(presence)?.[1] ?? null);
  });
});

/**
 * H-87. The read that turns those two commands into one verdict, and the reason
 * it no longer takes a compose type.
 *
 * The bug: `composeType` is `.optional()` in `updateComposeSchema`, so a
 * supported `PATCH {"composeType":"stack"}` on a deployed `docker-compose` row
 * made `docker stack ps` the probe. `docker stack ps` answers nothing about a
 * compose project, `readWorkloadPresence` reads "nothing" as `'absent'`, and
 * Delete answers an `'absent'` with a bare 200 and drops the row — the row-gone,
 * workload-alive state `applications.service.ts` says the teardown→verify→row
 * order makes impossible. Both halves of that order keyed off one mutable field.
 *
 * So the read asks both subsystems and takes the pessimistic answer. Every case
 * below is the same assertion from a different direction: *nothing about a
 * compose row's stored type may make a running workload read as gone.*
 */
describe('readComposeWorkloadPresence (H-87)', () => {
  type Answer = 'present' | 'absent' | 'unknown' | 'unreachable' | 'banner';

  /**
   * The daemon as the read sees it: one answer per subsystem, and a record of
   * what it was asked. `unreachable` rejects the exec the way
   * `RemoteExecService` does when it cannot reach the daemon at all; `banner` is
   * a shell that answered something that is not an answer.
   */
  const daemon = (answers: { stack: Answer; project: Answer }) => {
    const asked: string[] = [];
    const run = (command: string): Promise<string> => {
      asked.push(command);
      // `includes`, not `startsWith`: since H-95 both probes open with the
      // daemon's own reachability check, so neither starts with its question.
      const answer = command.includes('docker stack ps')
        ? answers.stack
        : answers.project;
      if (answer === 'unreachable') {
        return Promise.reject(new Error('ssh: connect ECONNREFUSED'));
      }
      if (answer === 'banner') {
        return Promise.resolve('Welcome to Ubuntu 24.04.4 LTS\n');
      }
      return Promise.resolve(`${answer}\n`);
    };
    return { run, asked: () => asked };
  };

  it('reads a running swarm stack as present, whatever the row said its type was', async () => {
    // The live fixture, measured on the host: `docker compose -p NAME ps -q` is
    // empty for a swarm stack and `docker stack ps NAME -q` names its tasks.
    // Pre-fix, a row saying `docker-compose` asked only the first and was told
    // the stack was gone.
    const box = daemon({ stack: 'present', project: 'absent' });

    expect(await readComposeWorkloadPresence('wp-stack', box.run)).toBe(
      'present',
    );
  });

  it('reads a running compose project as present, whatever the row said its type was', async () => {
    // The mirror, and the one the phase actually reproduced: a deployed
    // docker-compose project, `PATCH`ed to `stack`, then deleted.
    const box = daemon({ stack: 'absent', project: 'present' });

    expect(await readComposeWorkloadPresence('wp-stack', box.run)).toBe(
      'present',
    );
  });

  it('answers absent only when both subsystems say absent', async () => {
    const box = daemon({ stack: 'absent', project: 'absent' });

    expect(await readComposeWorkloadPresence('wp-stack', box.run)).toBe(
      'absent',
    );
  });

  it('answers present when one subsystem says so and the other cannot be reached', async () => {
    // A workload that is demonstrably there is not made less there by a second
    // question that failed.
    const box = daemon({ stack: 'present', project: 'unreachable' });

    expect(await readComposeWorkloadPresence('wp-stack', box.run)).toBe(
      'present',
    );
  });

  it('answers unknown — never absent — when a subsystem cannot be reached and the other says absent', async () => {
    // The half that could answer said "not mine". That is not "gone": the half
    // that could not answer is the one that would have said so. `unknown`
    // refuses the delete with the row intact unless the operator forces it.
    const box = daemon({ stack: 'unreachable', project: 'absent' });

    expect(await readComposeWorkloadPresence('wp-stack', box.run)).toBe(
      'unknown',
    );
  });

  it('answers unknown when both probes report an unreachable daemon (H-95)', async () => {
    // The H-95 case at this level. Neither question rejects any more — a daemon
    // that is down on a reachable Server exits 0 saying `unknown` — so this is
    // the shape the read actually sees during a `systemctl restart docker`, and
    // it must not be 'absent'. Pre-fix both halves said `absent` and this
    // answered `absent`, which is a dropped row and a live stack.
    const box = daemon({ stack: 'unknown', project: 'unknown' });

    expect(await readComposeWorkloadPresence('wp-stack', box.run)).toBe(
      'unknown',
    );
  });

  it('answers present when one subsystem says so and the other reports a dead daemon', async () => {
    const box = daemon({ stack: 'present', project: 'unknown' });

    expect(await readComposeWorkloadPresence('wp-stack', box.run)).toBe(
      'present',
    );
  });

  it('answers unknown when one subsystem says absent and the other reports a dead daemon', async () => {
    const box = daemon({ stack: 'unknown', project: 'absent' });

    expect(await readComposeWorkloadPresence('wp-stack', box.run)).toBe(
      'unknown',
    );
  });

  it('answers unknown when a shell answers neither question', async () => {
    const box = daemon({ stack: 'banner', project: 'banner' });

    expect(await readComposeWorkloadPresence('wp-stack', box.run)).toBe(
      'unknown',
    );
  });

  it('asks both subsystems about this stack and nothing else', async () => {
    const box = daemon({ stack: 'absent', project: 'absent' });

    await readComposeWorkloadPresence('wp-stack', box.run);

    expect(box.asked()).toEqual([
      composePresenceCommand('wp-stack', 'docker-compose'),
      composePresenceCommand('wp-stack', 'stack'),
    ]);
  });

  it('quotes the app name in both questions it asks', async () => {
    const box = daemon({ stack: 'absent', project: 'absent' });

    await readComposeWorkloadPresence(SHELL_PAYLOAD, box.run);

    for (const command of box.asked()) {
      // Same reading as the builder's own quoting test: for the compose half the
      // `-p <appName>` sits inside `[ -n "$( … )" ]`, and the body of the
      // substitution is the command whose words mean anything.
      const substitution = /\$\((.*)\)/.exec(command)?.[1];
      expectQuotedInCommand(substitution ?? command);
    }
  });

  it('asks about every compose type the column can hold', () => {
    // A third compose type added to the enum has to fail here rather than
    // silently ship a probe that never asks about it — which is the H-87 defect
    // with a different cause.
    expect([...COMPOSE_PRESENCE_TYPES]).toEqual([
      ...composeTypeEnum.enumValues,
    ]);
  });
});

/**
 * The `.env` bytes a deploy writes, as it carries them: in the build program's
 * environment (`CG_COMPOSE_ENV`), never its text.
 */
const envFileBytes = (compose: DeployableComposeSource): string =>
  getBuildComposeProgram(compose, BASE_COMPOSE, []).env[COMPOSE_ENV_VARIABLE];

describe('getCreateComposeEnvFileCommand', () => {
  it('writes an interpolated .env next to the compose file, from the program’s environment', () => {
    const compose = makeCompose({
      env: 'DB_PASSWORD=${{project.SHARED_SECRET}}',
      environment: {
        env: null,
        project: { env: 'SHARED_SECRET=hunter2' },
      },
    });

    const command = getCreateComposeEnvFileCommand(compose);

    // Trailing '' so the join emits the terminator the file ends on.
    expect(envFileBytes(compose)).toBe(
      [
        'APP_NAME=wp-stack',
        'COMPOSE_PROJECT_NAME=wp-stack',
        'DB_PASSWORD=hunter2',
        'DOCKER_CONFIG=/root/.docker',
        '',
      ].join('\n'),
    );
    expect(command).toContain(`touch ${STACK_DIRECTORY}/code/.env;`);
    expect(command).toContain(
      `printf '%s' "$CG_COMPOSE_ENV" > ${STACK_DIRECTORY}/code/.env;`,
    );
    // The text is what `ps` reads, so no value is in it, plain or
    // base64-encoded.
    expect(command).not.toContain('hunter2');
    expect(command).not.toContain('base64');
  });

  // The terminator is asserted on the written bytes rather than only by
  // rebuilding the expectation above, because the expectation is built from the
  // same `join` the writer uses and would follow the bug. A fourth key
  // added later has to keep this passing.
  it('terminates the last line, so a three-key .env counts as three lines', () => {
    const decoded = envFileBytes(makeCompose());

    expect(decoded.endsWith('\n')).toBe(true);
    expect(decoded.split('\n').filter(Boolean)).toEqual([
      'APP_NAME=wp-stack',
      'COMPOSE_PROJECT_NAME=wp-stack',
      'DOCKER_CONFIG=/root/.docker',
    ]);
    // What `wc -l` answers: one newline per key, none of them missing.
    expect(decoded.match(/\n/g)).toHaveLength(3);
  });

  it('places the .env beside a nested compose file', () => {
    const command = getCreateComposeEnvFileCommand(
      makeCompose({ composePath: './deploy/docker-compose.yml' }),
    );

    expect(command).toContain(`${STACK_DIRECTORY}/code/deploy/.env`);
  });

  it('quotes the path the .env write targets', () => {
    expectQuotedInCommand(getCreateComposeEnvFileCommand(injected));
  });

  /**
   * The bytes the deploy actually writes, read back with the library that
   * decides the file's keys.
   *
   * Parsing rather than matching the emitted shell is the whole point of the
   * cases below: a substring test over the command cannot tell a `DOCKER_CONFIG=`
   * assignment from a comment naming it, which is the confusion that dropped the
   * default. `decoded` comes back too, because "not duplicated" is a claim about
   * lines that a parsed object — last assignment wins — cannot make.
   */
  const writtenEnv = (compose: DeployableComposeSource) => {
    const decoded = envFileBytes(compose);
    return { decoded, parsed: parseEnv(decoded) };
  };

  it('writes the DOCKER_CONFIG default for a stack that sets no env of its own', () => {
    expect(writtenEnv(makeCompose()).parsed.DOCKER_CONFIG).toBe(
      '/root/.docker',
    );
  });

  it('writes the DOCKER_CONFIG default when the stack env names it only in a comment', () => {
    const { decoded, parsed } = writtenEnv(
      makeCompose({ env: '# DOCKER_CONFIG is set on the host\nDB_HOST=db' }),
    );

    expect(parsed.DOCKER_CONFIG).toBe('/root/.docker');
    // Asserted on the raw bytes too, not only through dotenv: the guard now asks
    // dotenv as well, so a parsed-only assertion here would be dotenv verifying
    // dotenv and could not catch the two drifting together (§1.7).
    expect(decoded.split('\n')).toContain('DOCKER_CONFIG=/root/.docker');
    // The comment is not a key, and the stack's real key survived beside the
    // default: nothing was dropped on the way to adding it.
    expect(parsed.DB_HOST).toBe('db');
  });

  it('writes the DOCKER_CONFIG default when the stack env sets a longer key containing the name', () => {
    const { parsed } = writtenEnv(
      makeCompose({ env: 'MY_DOCKER_CONFIG_PATH=/x' }),
    );

    expect(parsed.DOCKER_CONFIG).toBe('/root/.docker');
    expect(parsed.MY_DOCKER_CONFIG_PATH).toBe('/x');
  });

  it('leaves a DOCKER_CONFIG the stack set itself alone, and writes it once', () => {
    const { decoded, parsed } = writtenEnv(
      makeCompose({ env: 'DOCKER_CONFIG=/custom' }),
    );

    expect(parsed.DOCKER_CONFIG).toBe('/custom');
    expect(
      decoded.split('\n').filter((line) => line.startsWith('DOCKER_CONFIG=')),
    ).toEqual(['DOCKER_CONFIG=/custom']);
  });

  // Docker Compose reads an unquoted `.env` value with `$NAME` interpolated,
  // ` #…` cut off as a comment and quotes stripped, so a Template's stored
  // value (quoted in `compose.env`, e.g. an asked SMTP password) reached the
  // container changed: `p$ss #1` became `p`. Such a value is written in
  // double quotes with `\`, `"`, `$` and newlines escaped, which Compose
  // reads back exactly, as the Swarm path's quoted `export`s already do.
  it('quotes a value Docker Compose would otherwise interpolate, cut or unquote', () => {
    const { decoded, parsed } = writtenEnv(
      makeCompose({
        env: [
          `SMTP_PASSWORD='p$ss #1"x\\'`,
          `NOTE="it's"`,
          `MULTI="a\nb"`,
          'PLAIN=abc123+/=',
        ].join('\n'),
      }),
    );
    const lines = decoded.split('\n');

    expect(lines).toContain('SMTP_PASSWORD="p\\$ss #1\\"x\\\\"');
    expect(lines).toContain(`NOTE="it's"`);
    expect(lines).toContain('MULTI="a\\nb"');
    expect(lines).toContain('PLAIN=abc123+/=');
    expect(parsed.PLAIN).toBe('abc123+/=');
  });
});

describe('getBuildComposeCommand', () => {
  it('writes the domain-injected compose file, cds into the project and runs docker under env -i', () => {
    const command = getBuildComposeCommand(makeCompose(), BASE_COMPOSE, []);

    // The compose file is rewritten with the shared network injected.
    expect(command).toContain(
      `| base64 -d > ${STACK_DIRECTORY}/code/docker-compose.yml;`,
    );
    expect(command).toContain(`cd ${STACK_DIRECTORY}/code;`);
    expect(command).toContain(
      'env -i PATH="$PATH" HOME="$HOME" docker compose -p wp-stack -f ./docker-compose.yml up -d --build --remove-orphans 2>&1',
    );
    // Not isolated: no per-app network management.
    expect(command).not.toContain('docker network create');
    expect(command).not.toContain('docker network connect');
  });

  it('creates the isolated attachable network and connects traefik to it', () => {
    const command = getBuildComposeCommand(
      makeCompose({ isolatedDeployment: true }),
      BASE_COMPOSE,
      [],
    );

    expect(command).toContain(
      'docker network inspect wp-stack >/dev/null 2>&1 || docker network create  --attachable wp-stack',
    );
    expect(command).toContain(
      'docker network connect wp-stack $(docker ps --filter "name=cloudgate-traefik" -q) >/dev/null 2>&1',
    );
  });

  // The isolated branch creates `<appName>` and connects Traefik to it;
  // the off branch used to emit nothing, so a stack switched back off kept the
  // network and Traefik stayed attached to it until the delete. `set -e` is on
  // in this script, so every statement of the release is guarded: a missing
  // network, a Traefik already detached or a network something else still uses
  // must never fail the deploy.
  it('with isolation off, detaches Traefik from and removes a leftover isolated network once nothing else uses it', () => {
    const command = getBuildComposeCommand(makeCompose(), BASE_COMPOSE, []);

    // Local scope first: `.Containers` is complete only for a network on one
    // Server. A swarm-scoped overlay lists this node's containers alone, so
    // an empty answer there would detach Traefik from a network tasks on
    // other nodes still route over — so an overlay is never released here,
    // whatever `composeType` says now (H-87), and waits for the delete.
    expect(command).toContain(
      'if [ "$(docker network inspect -f \'{{.Scope}}\' wp-stack 2>/dev/null)" = local ] && [ -z "$(docker network inspect -f \'{{range .Containers}}{{if ne .Name "cloudgate-traefik"}}{{.Name}} {{end}}{{end}}\' wp-stack 2>/dev/null)" ]; then',
    );
    // And the disconnect only inside that guard, never ahead of it.
    expect(
      command.indexOf('docker network disconnect wp-stack'),
    ).toBeGreaterThan(command.indexOf('= local ] && [ -z'));
    expect(command).toContain(
      'docker network disconnect wp-stack cloudgate-traefik >/dev/null 2>&1 || true;',
    );
    expect(command).toContain(
      'docker network rm wp-stack >/dev/null 2>&1 || true;',
    );
    // After the deploy, which is what moves the stack's containers off it.
    expect(command.indexOf('docker network rm wp-stack')).toBeGreaterThan(
      command.indexOf('docker compose -p wp-stack'),
    );
  });

  it('with isolation on, never releases the network it just created', () => {
    const command = getBuildComposeCommand(
      makeCompose({ isolatedDeployment: true }),
      BASE_COMPOSE,
      [],
    );

    expect(command).not.toContain('docker network rm');
    expect(command).not.toContain('docker network disconnect');
  });

  it('creates an overlay network for isolated stacks and exports env for the stack deploy', () => {
    const command = getBuildComposeCommand(
      makeCompose({
        composeType: 'stack',
        isolatedDeployment: true,
        env: 'API_KEY=secret value',
      }),
      BASE_COMPOSE,
      [],
    );

    expect(command).toContain(
      'docker network create --driver overlay --attachable wp-stack',
    );
    // Stack deploys interpolate env at the shell (read off stdin, not
    // assigned in the text — see `the stack deploy's variables` below).
    expect(command).toContain(
      `printf '%s' "$CG_COMPOSE_STACK_ENV" | env -i PATH="$PATH" HOME="$HOME" sh -c 'eval "$(cat)" && exec docker stack deploy -c ./docker-compose.yml wp-stack --prune --with-registry-auth < /dev/null' 2>&1`,
    );
  });

  it('injects domain labels into the written compose file', () => {
    const written = writtenComposeFile(
      getBuildComposeCommand(makeCompose(), BASE_COMPOSE, [
        {
          host: 'blog.example.com',
          serviceName: 'wordpress',
          port: 80,
          https: false,
          uniqueConfigKey: 1,
        },
      ]),
    );

    expect(written).toContain('traefik.enable=true');
    expect(written).toContain(
      'traefik.http.routers.wp-stack-1-web.rule=Host(`blog.example.com`)',
    );
  });

  // The restart policy and the log cap are claims about the bytes on the deploy
  // target, not about a pure function: what was observed on a host was
  // `/etc/cloudgate/compose/*/ code/docker-compose.yml` carrying no `restart:`
  // and every compose container running Docker's stock unbounded log driver.
  // This is the file that write produces, so it is where those two are pinned
  // end to end.
  it('writes the restart policy and the log cap into the file that reaches the server', () => {
    const written = writtenComposeFile(
      getBuildComposeCommand(makeCompose(), BASE_COMPOSE, []),
    );

    expect(written).toContain('restart: unless-stopped');
    expect(written).toContain('driver: json-file');
    expect(written).toContain('max-size: 10m');
    // Quoted by the serializer, because a bare 3 would reach Docker as a number
    // and `--log-opt max-file` is a string option.
    expect(written).toContain('max-file: "3"');
  });

  it('writes the log cap but no restart policy for a stack deploy', () => {
    const written = writtenComposeFile(
      getBuildComposeCommand(
        makeCompose({ composeType: 'stack' }),
        BASE_COMPOSE,
        [],
      ),
    );

    // `docker stack deploy` maps `logging:` onto TaskTemplate.LogDriver and
    // ignores `restart:`, printing a warning about it into the deployment log
    // on every deploy — so injecting one and not the other is the whole point.
    expect(written).toContain('driver: json-file');
    expect(written).not.toContain('restart:');
  });

  it('writes the defaults for an isolated stack with no domains, the one shape that used to go verbatim', () => {
    const written = writtenComposeFile(
      getBuildComposeCommand(
        makeCompose({ isolatedDeployment: true }),
        BASE_COMPOSE,
        [],
      ),
    );

    expect(written).toContain('restart: unless-stopped');
    expect(written).toContain('driver: json-file');
    // Still unrouted: removing the early return must not have started joining
    // an isolated stack to anything.
    expect(written).not.toContain('traefik');
  });

  it('quotes the paths the deploy script writes and cds into', () => {
    expectQuotedInCommand(getBuildComposeCommand(injected, BASE_COMPOSE, []));
    // The stack branch carries the Compose project removal instead.
    expectQuotedInCommand(
      getBuildComposeCommand(
        { ...injected, composeType: 'stack' },
        BASE_COMPOSE,
        [],
      ),
    );
  });

  // "Applied as" is a `PATCH` away, and a Compose project and a Swarm
  // stack of the same name are different objects to Docker: Stop is
  // `docker compose stop`, which keeps `<appName>_default`, and
  // `docker stack deploy` then fails creating an overlay of that name. So the
  // deploy takes the other kind down first, found on the daemon by its own
  // label rather than by a recorded previous kind (H-87).
  it('takes a docker-compose project of this name down, network included, before a stack deploy', () => {
    const command = getBuildComposeCommand(
      makeCompose({ composeType: 'stack' }),
      BASE_COMPOSE,
      [],
    );

    const down = command.indexOf(
      'env -i PATH="$PATH" docker compose -p wp-stack down',
    );
    expect(down).toBeGreaterThan(-1);
    // Asked of the project's own label, containers and network both, so a
    // stack with neither pays two reads and logs nothing.
    expect(command).toContain(
      'docker ps -aq --filter label=com.docker.compose.project=wp-stack',
    );
    expect(command).toContain(
      'docker network ls -q --filter label=com.docker.compose.project=wp-stack',
    );
    expect(down).toBeLessThan(command.indexOf('docker stack deploy'));
    // Never `--volumes`: the stack takes the project's named volumes over.
    expect(command).not.toMatch(/compose -p wp-stack down[^;\n]*--volumes/);
  });

  it('takes a Swarm stack of this name down, and waits for its network to go, before a compose up', () => {
    const command = getBuildComposeCommand(makeCompose(), BASE_COMPOSE, []);

    const rm = command.indexOf('docker stack rm wp-stack');
    expect(rm).toBeGreaterThan(-1);
    expect(command).toContain(
      'docker network ls -q --filter label=com.docker.stack.namespace=wp-stack',
    );
    expect(rm).toBeLessThan(command.indexOf('docker compose -p wp-stack -f'));
    // The wait has an end, and says which step it gave up on.
    expect(command).toMatch(/Swarm stack wp-stack .*still/);
  });

  it('leaves the other kind alone when a custom deploy command decides what is deployed', () => {
    for (const composeType of COMPOSE_PRESENCE_TYPES) {
      const command = getBuildComposeCommand(
        makeCompose({ composeType, command: 'compose up -d' }),
        BASE_COMPOSE,
        [],
      );
      expect(command).not.toContain('docker stack rm');
      expect(command).not.toContain(' down');
    }
  });

  it('replaces an isolated bridge left by a compose deploy with the overlay a stack needs', () => {
    const command = getBuildComposeCommand(
      makeCompose({ composeType: 'stack', isolatedDeployment: true }),
      BASE_COMPOSE,
      [],
    );

    const release = command.indexOf('= local ] && [ -z');
    expect(release).toBeGreaterThan(
      command.indexOf('docker compose -p wp-stack down'),
    );
    expect(release).toBeLessThan(
      command.indexOf('docker network create --driver overlay'),
    );
  });
});

describe('composeTeardownCommand', () => {
  it('quotes the app name in the teardown', () => {
    expectQuotedInCommand(composeTeardownCommand(null, SHELL_PAYLOAD, true));
  });

  // The project directory holds the stack's file mounts and its Trace
  // store's data, and this program runs ahead of the presence refusal, so a
  // 409 answered with both erased. `compose-directory.ts` removes it after
  // the refusal instead.
  it('leaves the project directory alone', () => {
    expect(composeTeardownCommand(null, 'wp-stack', false)).not.toContain(
      'rm -rf',
    );
  });

  // H-87's other half. The teardown used to branch on the row's `composeType`
  // exactly as the probe did, so one `PATCH` aimed it at the wrong daemon
  // subsystem — where it failed inside the caller's `catch` and was never seen,
  // and then the probe that exists to catch that asked the same wrong question.
  // Fixing only the probe leaves a delete that never attempts the right
  // teardown.
  it('takes both the swarm stack and the compose project down, so no stored type can misaim it', () => {
    const command = composeTeardownCommand(null, 'wp-stack', false);

    expect(command).toContain('docker stack rm wp-stack');
    expect(command).toContain(
      'env -i PATH="$PATH" docker compose -p wp-stack down',
    );
    // The other subsystem's teardown is a verified no-op, not an assumed one:
    // on the host, `docker stack rm` at a compose project and `docker compose
    // down` at a swarm stack both exit 0 having touched nothing, because the
    // two match different labels.
    expect(command).toContain('docker network disconnect wp-stack');
  });

  // `docker compose down` removes only `<appName>_default`: the isolated
  // network is declared `external: true`, so it outlived every delete. It goes
  // after both takedowns (nothing is left on it), and tolerates its absence — a stack that was never isolated has none.
  it("removes the stack's own isolated network after the takedowns, tolerating its absence", () => {
    const command = composeTeardownCommand(null, 'wp-stack', false);

    expect(command).toContain(
      'docker network rm wp-stack >/dev/null 2>&1 || true;',
    );
    const removal = command.indexOf('docker network rm wp-stack');
    expect(removal).toBeGreaterThan(
      command.indexOf('docker network disconnect wp-stack'),
    );
    expect(removal).toBeGreaterThan(command.indexOf('docker stack rm'));
    expect(removal).toBeGreaterThan(
      command.indexOf('docker compose -p wp-stack down'),
    );
  });

  it('passes --volumes only when asked, and only to the half that has the flag', () => {
    // `docker stack rm` has no volume flag — a stack's volumes are the nodes' —
    // so `deleteVolumes` stays on the compose half.
    expect(composeTeardownCommand(null, 'wp-stack', true)).toContain(
      'docker compose -p wp-stack down --volumes',
    );
    expect(composeTeardownCommand(null, 'wp-stack', false)).not.toContain(
      '--volumes',
    );
  });
});

/**
 * `POST /compose/:id/start`, and the create site the log cap lost for a wave
 * (H-98).
 *
 * `up -d` creates containers, so Start is a kind-3 create site
 * (`common/config/container-logs.ts`) and the restart policy applies to it
 * too — and it was the one create site in `backend/src` that read neither. It
 * ran over the *stored* converted file and regenerated nothing, so every stack
 * whose file was written before those two defaults came back from a Start with
 * `RestartPolicy=no` and an uncapped log driver. On the host that was all four
 * product-created compose stacks: `restart:` 0 times and `logging:` 0 times in
 * every stored file, and one row A/B'd minutes apart gave `restart=no` /
 * `{"Type":"json-file","Config":{}}` after Start against
 * `restart=unless-stopped` / `10m × 3` after Deploy.
 *
 * The other half of every assertion here is what Start still must *not* do
 * (ADR-0011): it is a lifecycle rung, not a deploy.
 */
describe('composeStartCommand (H-98)', () => {
  /** The converted file as a deploy before the log cap left it on disk. */
  const PRE_WAVE = `services:
  wordpress:
    image: wordpress:6
  db:
    image: mariadb:11
`;

  const UP = `cd ${STACK_DIRECTORY}/code && env -i PATH="$PATH" docker compose -p wp-stack -f ./docker-compose.yml up -d`;

  const CAP = { 'max-size': '10m', 'max-file': '3' };

  /** The file the command writes back, decoded out of its own `base64 -d`. */
  const rewritten = (command: string) => {
    const encoded = /echo "([^"]+)" \| base64 -d/.exec(command)?.[1] ?? '';
    const yaml = Buffer.from(encoded, 'base64').toString('utf-8');
    return { yaml, services: parseComposeFile(yaml)?.services ?? {} };
  };

  it('re-applies both platform defaults to the file on disk before bringing the project up', () => {
    const command = composeStartCommand(makeCompose(), PRE_WAVE);

    // The file it writes is the file `-f` names, on the path
    // `getComposeFilePath` composes — not a neighbour of it. Asserted before the
    // bytes so that a Start which re-injects nothing fails by saying so.
    expect(command).toContain(
      `| base64 -d > ${getComposeFilePath(makeCompose())} &&`,
    );
    expect(command).toContain(UP);

    const { services } = rewritten(command);
    for (const name of ['wordpress', 'db']) {
      expect(services[name].restart).toBe('unless-stopped');
      expect(services[name].logging).toEqual({
        driver: 'json-file',
        options: CAP,
      });
    }
  });

  it('makes the up conditional on the write, not merely sequenced after it', () => {
    const command = composeStartCommand(makeCompose(), PRE_WAVE);

    // `;` would run `up -d` over a half-written compose file — H-96's lesson one
    // module over, where a `;` in place of a trap left an app at 0 replicas.
    expect(command).toContain(` && cd ${STACK_DIRECTORY}/code`);
    expect(command.indexOf('base64 -d')).toBeLessThan(command.indexOf('up -d'));
  });

  it('leaves the command exactly as it was when the file already carries both defaults', () => {
    // The whole population since the log cap: one Deploy has already written
    // both keys, so a Start must not rewrite the file at all. This is also what
    // keeps the author's own comments and key order intact for every stack
    // deployed since.
    const deployed = getBuildComposeCommand(makeCompose(), PRE_WAVE, []);
    const onDisk = writtenComposeFile(deployed);

    expect(composeStartCommand(makeCompose(), onDisk)).toBe(UP);
  });

  it('keeps a service that declared its own logging or restart whole (K-6)', () => {
    const authored = `services:
  wordpress:
    image: wordpress:6
    logging:
      driver: json-file
  db:
    image: mariadb:11
    restart: "no"
`;

    const { services } = rewritten(
      composeStartCommand(makeCompose(), authored),
    );

    // Presence is the author's statement; absence is the product's default. An
    // unbounded `logging:` stays unbounded and a deliberate `no` stays `no` —
    // both confirmed-correct behaviour, not gaps for this route to close.
    expect(services.wordpress.logging).toEqual({ driver: 'json-file' });
    expect(services.db.restart).toBe('no');
    // The keys each service did *not* declare are still defaulted.
    expect(services.wordpress.restart).toBe('unless-stopped');
    expect(services.db.logging).toEqual({ driver: 'json-file', options: CAP });
  });

  it('adds no restart key for a stack-shaped row (K-6)', () => {
    // Start never reaches this branch — a swarm stack is (re)started by
    // `docker stack deploy` and `ComposeService.start` has no such command — but
    // the type gate belongs to `applyComposeDefaults` and must not become
    // symmetrical here by accident: `docker stack deploy` prints "Ignoring
    // unsupported options: restart" on every deploy.
    const { yaml, services } = rewritten(
      composeStartCommand(makeCompose({ composeType: 'stack' }), PRE_WAVE),
    );

    expect(yaml).not.toContain('restart:');
    expect(services.wordpress.logging).toEqual({
      driver: 'json-file',
      options: CAP,
    });
  });

  it('regenerates nothing else: no build, no clone, no domains, no env file', () => {
    const command = composeStartCommand(makeCompose(), PRE_WAVE);

    // Routing `start` through the deploy path is the other way to close H-98 and
    // is rejected in writing: a guard must not buy its coverage by redefining
    // the verb it guards. These absences are that decision.
    expect(command).not.toContain('--build');
    expect(command).not.toContain('--remove-orphans');
    expect(command).not.toContain('stack deploy');
    expect(command).not.toContain('git');
    expect(command).not.toContain('.env');
    expect(command).not.toContain('docker network');
    expect(command).not.toContain('traefik');
    expect(command).not.toContain('rm -rf');
  });

  it('hands a file that parses to nothing straight to up -d', () => {
    // `start` on a stack that was never deployed reads `''` off the server. The
    // `up -d` fails on its own and names the missing file; a rewrite here would
    // create a file out of nothing and name the wrong problem.
    expect(composeStartCommand(makeCompose(), '')).toBe(UP);
    expect(
      composeStartCommand(makeCompose(), '# nothing but a comment\n'),
    ).toBe(UP);
  });

  it('reads the log ceiling from the env on every call rather than at import', () => {
    const { services } = rewritten(
      composeStartCommand(makeCompose(), PRE_WAVE, {
        CONTAINER_LOG_MAX_SIZE: '50m',
        CONTAINER_LOG_MAX_FILE: '5',
      }),
    );

    expect(services.wordpress.logging).toEqual({
      driver: 'json-file',
      options: { 'max-size': '50m', 'max-file': '5' },
    });
  });

  it('quotes the app name and the compose path it interpolates', () => {
    // `-p`, `-f`, the `cd` and the `>` redirect, all off two caller-set columns.
    // The file's own bytes go through base64, so the payload can only
    // reach the shell through those four words.
    expectQuotedInCommand(composeStartCommand(injected, PRE_WAVE));
  });

  it('writes bytes through base64 rather than through the shell', () => {
    // A compose file contains quotes, `$`, newlines and backticks by nature, so
    // the file's bytes never appear as shell words — the same shape
    // `getBuildComposeCommand` writes with, and now literally the same builder.
    const command = writeComposeFileCommand('/tmp/x.yml', 'a: `b`\n');

    expect(command).toBe(
      `echo "${Buffer.from('a: `b`\n').toString('base64')}" | base64 -d > /tmp/x.yml`,
    );
    // No trailing `;`: the caller decides whether what follows is conditional on
    // the write, and for `start` it is.
    expect(command.endsWith(';')).toBe(false);
  });
});

/**
 * The settle poll a stack delete runs between the teardown and the refusal
 * (H-99).
 *
 * `remove()` tears the stack down and then asks whether it is gone, in that
 * order and for the reason a delete must never read a running project as
 * gone. For a `stack` row the teardown is `docker stack
 * rm`, which returns the moment the daemon *accepts* the removal, while `docker
 * stack ps <name> --quiet` keeps naming tasks in `Shutdown` for several seconds
 * — so the probe answered `present` about the removal the same request had just
 * issued and the caller got a 409. Measured on the host, 3 trials of 3: `409` at
 * t+0, `409` at t+3, `200` at t+6/t+7. A `stack`-type compose could not be
 * deleted on the first attempt, ever.
 *
 * The clock is a seam so that exhausting fifteen seconds costs microseconds —
 * `awaitConvergence`'s argument, one module over.
 */
describe('composeLifecycleCommand', () => {
  it('runs a verb on the project by its name, from its directory, with nothing of the platform environment', () => {
    for (const verb of ['stop', 'restart', 'start'] as const) {
      expect(composeLifecycleCommand(makeCompose(), verb)).toBe(
        `cd ${STACK_DIRECTORY} && env -i PATH="$PATH" docker compose -p wp-stack ${verb}`,
      );
    }
  });

  it('roots a stack on its Stack VM under a Server-style root, never the platform host', () => {
    const command = composeLifecycleCommand(
      makeCompose({ composeId: 'cmp_1', cloudAccountId: 'ca_1' }),
      'start',
    );
    expect(command).toBe(
      `cd ${cloudgateDirectoryOn('stack-vm:cmp_1')}/compose/wp-stack && env -i PATH="$PATH" docker compose -p wp-stack start`,
    );
  });

  it('quotes the minted project name wherever it lands', () => {
    expectQuotedInCommand(composeLifecycleCommand(injected, 'stop'));
  });
});

describe('awaitComposeWorkloadAbsent (H-99)', () => {
  /**
   * A daemon that answers a scripted sequence, one entry per presence *read*
   * (each read asks both subsystems), and a clock whose `sleep` is the only
   * thing that moves `now`.
   */
  const daemon = (answers: ('present' | 'absent' | 'unknown')[]) => {
    const reads: string[] = [];
    let elapsed = 0;
    const slept: number[] = [];
    const run = (command: string): Promise<string> => {
      reads.push(command);
      // Two probes per read: the answer is indexed by read, not by probe.
      const answer =
        answers[Math.min(answers.length - 1, (reads.length - 1) >> 1)];
      return Promise.resolve(`${answer}\n`);
    };
    const clock: SettleClock = {
      now: () => elapsed,
      sleep: (ms) => {
        slept.push(ms);
        elapsed += ms;
        return Promise.resolve();
      },
    };
    return { run, clock, slept, readCount: () => reads.length / 2 };
  };

  it('answers absent on the first read, having slept for nothing', async () => {
    // The happy path — a compose project the teardown really removed — costs
    // exactly what it did before this poll existed.
    const box = daemon(['absent']);

    expect(
      await awaitComposeWorkloadAbsent('wp-stack', box.run, box.clock),
    ).toBe('absent');
    expect(box.readCount()).toBe(1);
    expect(box.slept).toEqual([]);
  });

  it('waits for a stack whose tasks are still shutting down, then answers absent', async () => {
    // The finding itself: `present`, `present`, then gone. Pre-fix the first of
    // those three answers was the whole read and the delete was refused.
    const box = daemon(['present', 'present', 'absent']);

    expect(
      await awaitComposeWorkloadAbsent('wp-stack', box.run, box.clock),
    ).toBe('absent');
    expect(box.readCount()).toBe(3);
    expect(box.slept).toEqual([COMPOSE_SETTLE_POLL_MS, COMPOSE_SETTLE_POLL_MS]);
  });

  it('still refuses when the budget runs out with the workload there', async () => {
    // A timeout that expires must not become an `absent`: the delete's property
    // is that Cloudgate never drops a row while a workload it cannot see might
    // be running, and a spent stopwatch is not evidence of a removal.
    const box = daemon(['present']);

    expect(
      await awaitComposeWorkloadAbsent('wp-stack', box.run, box.clock),
    ).toBe('present');
    expect(box.slept.reduce((sum, ms) => sum + ms, 0)).toBe(
      COMPOSE_SETTLE_BUDGET_MS,
    );
    // It stops at the budget rather than one poll past it.
    expect(box.readCount()).toBe(
      COMPOSE_SETTLE_BUDGET_MS / COMPOSE_SETTLE_POLL_MS + 1,
    );
  });

  it('never sleeps past the budget on the last poll', async () => {
    const box = daemon(['present']);

    await awaitComposeWorkloadAbsent('wp-stack', box.run, box.clock, 2_500);

    expect(box.slept).toEqual([1_000, 1_000, 500]);
  });

  it('does not re-ask an unknown: a dead transport settles into nothing', async () => {
    // `unknown` is the daemon or the SSH connection failing to answer at all,
    // and the refusal it produces already says the actionable thing — *delete
    // again when the server is reachable*. Re-asking it would multiply a connect
    // timeout by the poll count and turn a delete against a Server that is gone
    // into a minutes-long request.
    const box = daemon(['unknown', 'absent']);

    expect(
      await awaitComposeWorkloadAbsent('wp-stack', box.run, box.clock),
    ).toBe('unknown');
    expect(box.readCount()).toBe(1);
    expect(box.slept).toEqual([]);
  });

  it('asks both subsystems on every read it makes', async () => {
    // The poll wraps the read rather than replacing it, so H-87's "it asks both,
    // unconditionally" survives being polled.
    const box = daemon(['present', 'absent']);

    await awaitComposeWorkloadAbsent('wp-stack', box.run, box.clock);

    expect(box.readCount()).toBe(2);
  });
});

/**
 * A Compose's `.env` and a stack's variables carry every generated
 * secret and the operator's own values, and a deploy program's text is what
 * any local user reads out of `ps` for as long as the deploy runs. So they
 * travel in the program's environment, as a traced Compose's converted file
 * does, and the platform host's cap on one environment string is
 * named before `exec` rather than met as E2BIG.
 */
describe('getBuildComposeProgram', () => {
  const SECRETS = {
    API_KEY: 'sk-live-9f3ad2',
    DB_PASSWORD: `p@ss w'rd $HOME \`id\` $(id)`,
  };
  const withSecrets = (overrides: Partial<DeployableComposeSource> = {}) =>
    makeCompose({
      env: Object.entries(SECRETS)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
      ...overrides,
    });

  it.each(['docker-compose', 'stack'] as const)(
    'puts no variable value in a %s deploy program’s text, which ps can read',
    (composeType) => {
      const program = getBuildComposeProgram(
        withSecrets({ composeType }),
        BASE_COMPOSE,
        [],
      );

      for (const value of Object.values(SECRETS)) {
        expect(program.command).not.toContain(value);
        expect(program.command).not.toContain(quote([value]));
        // Nor inside a base64 payload the program decodes.
        for (const [payload] of program.command.matchAll(
          /[A-Za-z0-9+/=]{16,}/g,
        )) {
          expect(
            Buffer.from(payload, 'base64').toString('utf-8'),
          ).not.toContain(SECRETS.API_KEY);
        }
      }
      expect(program.env[COMPOSE_ENV_VARIABLE]).toContain(
        `API_KEY=${SECRETS.API_KEY}\n`,
      );
      expect(COMPOSE_STACK_ENV_VARIABLE in program.env).toBe(
        composeType === 'stack',
      );
    },
  );

  /**
   * The stack deploy line run under a real `sh`, against a `docker` that
   * records its argv and environment: the variables have to reach `docker
   * stack deploy`'s environment — it is what interpolates the file — and
   * nothing else of the caller's may.
   */
  describe('the stack deploy’s variables', () => {
    let bin: string;
    beforeEach(() => {
      bin = mkdtempSync(join(tmpdir(), 'cg-stack-env-'));
      writeFileSync(
        join(bin, 'docker'),
        `#!/bin/sh\nprintf '%s\\n' "$@" > ${quote([join(bin, 'argv')])}\nenv > ${quote([join(bin, 'env')])}\n`,
        { mode: 0o755 },
      );
    });
    afterEach(() => rmSync(bin, { recursive: true, force: true }));

    const runDeployLine = (compose: DeployableComposeSource) => {
      const program = getBuildComposeProgram(compose, BASE_COMPOSE, []);
      const line = program.command
        .split('\n')
        .find((l) => l.includes('stack deploy -c'));
      expect(line).toBeDefined();
      execFileSync('sh', ['-c', line ?? ''], {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          HOME: '/nonexistent',
          LEAKED_FROM_HOST: 'x',
          ...program.env,
        },
      });
      return {
        env: parseEnv(readFileSync(join(bin, 'env'))),
        argv: readFileSync(join(bin, 'argv'), 'utf-8'),
      };
    };

    it('gives docker stack deploy every variable, byte for byte, under a clean environment', () => {
      const { env, argv } = runDeployLine(
        withSecrets({ composeType: 'stack' }),
      );

      expect(env.API_KEY).toBe(SECRETS.API_KEY);
      expect(env.DB_PASSWORD).toBe(SECRETS.DB_PASSWORD);
      expect(env.HOME).toBe('/nonexistent');
      // `env -i` still holds: neither the host's environment nor the payload
      // variable itself reaches the stack.
      expect(env.LEAKED_FROM_HOST).toBeUndefined();
      expect(env[COMPOSE_STACK_ENV_VARIABLE]).toBeUndefined();
      expect(env[COMPOSE_ENV_VARIABLE]).toBeUndefined();
      expect(argv.split('\n').filter(Boolean)).toEqual([
        'stack',
        'deploy',
        '-c',
        './docker-compose.yml',
        'wp-stack',
        '--prune',
        '--with-registry-auth',
      ]);
    });

    it('deploys a stack with no variables of its own', () => {
      const { argv } = runDeployLine(makeCompose({ composeType: 'stack' }));

      expect(argv).toContain('deploy');
    });

    // `env NAME=value` took any name; a shell's `export` takes only a shell
    // name, and `docker stack deploy` interpolates only those — so a key such
    // as `a.b` is left out, said so in the log, and does not fail the deploy.
    it('leaves out a key that is not a shell name, and says so', () => {
      const compose = makeCompose({
        composeType: 'stack',
        env: 'service.port=80\nAPI_KEY=k',
      });
      const { env } = runDeployLine(compose);

      expect(env.API_KEY).toBe('k');
      expect(env['service.port']).toBeUndefined();
      expect(
        getBuildComposeProgram(compose, BASE_COMPOSE, []).command,
      ).toContain('service.port is not a shell variable name');
    });
  });

  // The platform host runs the program with `execAsync`, and Linux caps one
  // `NAME=value` string at exec at 32 pages (MAX_ARG_STRLEN). A Server takes
  // the environment over `sh -s`'s stdin and has no such cap.
  describe('an environment string the platform host cannot exec', () => {
    const big = (bytes: number) => `BLOB=${'x'.repeat(bytes)}`;

    it('fails a platform-host deploy with a .env over 128 KiB, naming both sizes', () => {
      expect(() =>
        getBuildComposeProgram(
          makeCompose({ env: big(140 * 1024) }),
          BASE_COMPOSE,
          [],
        ),
      ).toThrow(/^The Compose's \.env is 141 KiB; the limit is 128 KiB/);
    });

    it('names a stack’s variables when they are what is over', () => {
      // 100 KiB in the `.env`, but quoted for the shell every `&` is `\&`.
      const compose = makeCompose({
        composeType: 'stack',
        env: `BLOB=${'&'.repeat(100 * 1024)}`,
      });

      expect(() => getBuildComposeProgram(compose, BASE_COMPOSE, [])).toThrow(
        /^The Compose's stack variables are 201 KiB; the limit is 128 KiB/,
      );
    });

    it('carries a .env just under the cap', () => {
      const program = getBuildComposeProgram(
        makeCompose({ env: big(120 * 1024) }),
        BASE_COMPOSE,
        [],
      );

      expect(
        Buffer.byteLength(
          `${COMPOSE_ENV_VARIABLE}=${program.env[COMPOSE_ENV_VARIABLE]}`,
        ),
      ).toBeLessThan(128 * 1024);
    });

    it('puts no cap on a deploy to a Server', () => {
      const program = getBuildComposeProgram(
        makeCompose({ serverId: 'server-1', env: big(140 * 1024) }),
        BASE_COMPOSE,
        [],
      );

      expect(program.env[COMPOSE_ENV_VARIABLE]).toContain(big(140 * 1024));
    });
  });
});

/** The compose file `getBuildComposeCommand` base64-writes onto the server. */
function writtenComposeFile(command: string): string {
  const write = command
    .split('\n')
    .find((line) => line.includes(`base64 -d > ${STACK_DIRECTORY}/code/`));
  const encoded = /echo "([^"]+)" \| base64 -d/.exec(write ?? '')?.[1] ?? '';
  return Buffer.from(encoded, 'base64').toString('utf-8');
}
