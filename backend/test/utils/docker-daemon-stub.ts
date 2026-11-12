import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A stand-in `docker` CLI on a real `PATH`, for the presence probes of the cascade fix —
 * the tests that have to answer *"what does this string actually do in a
 * shell?"* rather than *"what does this string look like?"* (H-95).
 *
 * A string-shape assertion cannot see H-95. The bug was
 * `<question> >/dev/null 2>&1 && echo present || echo absent`, where `||`
 * swallows `Cannot connect to the Docker daemon` exactly as it swallows `no such
 * service`, so a stopped or wedged daemon printed `absent` at exit 0 while the
 * workload kept running. Every `toBe('… && echo present || echo absent')`
 * assertion in the tree **passed on that**, and so did every unit test of
 * `readWorkloadPresence`, because the mapping from `absent` to `'absent'` was
 * never the broken half — the shell was. H-94 hit the same wall from the
 * injection side and drew the same conclusion: where the question is what a
 * program does, the test has to run the program. This is the arrangement that
 * lets it, without a Docker daemon on the machine running the suite.
 *
 * Mode is baked into the script text rather than read from the environment on
 * purpose: the compose half of the probe runs `env -i PATH="$PATH" docker
 * compose …`, which strips every variable but `PATH`, so a stub reading
 * `$H95_MODE` would silently fall back to its default there and the compose arm
 * of every test would prove nothing.
 */
export interface DockerDaemonStub {
  /**
   * Whether the daemon answers at all. `false` makes **every** invocation —
   * `docker version` included — fail the way a stopped, wedged or restarting
   * dockerd does: exit 1 with `Cannot connect to the Docker daemon` on stderr,
   * verbatim from docker 29.7.2 on the X-run host. This is the arm the probes
   * used to read as `absent`.
   */
  reachable: boolean;
  /** Swarm objects the daemon knows, for `docker service inspect` / `docker stack ps`. */
  services?: string[];
  /** Compose projects with running containers, for `docker compose -p … ps --quiet`. */
  projects?: string[];
  /** Named volumes on this node, for `docker volume inspect`. */
  volumes?: string[];
  /** What `docker info --format '{{.Swarm.Nodes}}'` prints: the swarm's node count. */
  swarmNodes?: number;
}

const shellList = (values: string[]) => values.join(' ');

/** The stub as POSIX `sh`. Exported so a failure can be read rather than guessed at. */
export const dockerDaemonStubScript = ({
  reachable,
  services = [],
  projects = [],
  volumes = [],
  swarmNodes = 1,
}: DockerDaemonStub): string => `#!/bin/sh
REACHABLE=${reachable ? 1 : 0}
KNOWN='${shellList(services)}'
PROJECTS='${shellList(projects)}'
VOLUMES='${shellList(volumes)}'
SWARM_NODES=${swarmNodes}

if [ "$REACHABLE" != 1 ]; then
	echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2
	exit 1
fi

case "$1" in
version)
	exit 0
	;;
service)
	# docker service inspect NAME
	for known in $KNOWN; do
		[ "$known" = "$3" ] && exit 0
	done
	echo "Error: no such service: $3" >&2
	exit 1
	;;
stack)
	# docker stack ps NAME --quiet
	for known in $KNOWN; do
		[ "$known" = "$3" ] && { echo "task-id"; exit 0; }
	done
	echo "Nothing found in stack: $3" >&2
	exit 1
	;;
compose)
	# docker compose -p NAME ps --quiet — exit 0 with no ids for a project the
	# daemon does not have, which is what the real CLI does and the reason the
	# probe tests it with [ -n "$( … )" ] rather than on exit status.
	for project in $PROJECTS; do
		[ "$project" = "$3" ] && { echo "444d9d36df9e"; exit 0; }
	done
	exit 0
	;;
volume)
	# docker volume inspect NAME — node-local, like the real one.
	for known in $VOLUMES; do
		[ "$known" = "$3" ] && exit 0
	done
	echo "Error response from daemon: get $3: no such volume" >&2
	exit 1
	;;
info)
	# docker info --format '{{.Swarm.Nodes}}'
	echo "$SWARM_NODES"
	exit 0
	;;
esac
echo "docker stub: unexpected invocation: $*" >&2
exit 127
`;

export interface ProbeRun {
  /** What the probe said, trimmed — the token `readWorkloadPresence` reads. */
  said: string;
  /** The probe's exit status. Must be 0 for every answer, or the exec rejects. */
  status: number | null;
  stderr: string;
  /**
   * Everything in the probe's working directory afterwards, captured before the
   * directory is removed — so a test can assert that a payload created nothing.
   * Returning the path instead would hand back a directory that no longer
   * exists, and `existsSync` on it would pass for the wrong reason.
   */
  created: string[];
}

/**
 * Runs `command` under a real `/bin/sh` with {@link dockerDaemonStubScript}
 * shadowing `docker`, in an empty working directory.
 *
 * `PATH` is the stub directory followed by the real one, not the stub alone:
 * the compose half of the probe needs `env` and the shell needs its builtins'
 * neighbours, and a `PATH` missing them would make the probe fail for a reason
 * the test did not intend — which is the mistake that makes an executed proof
 * weaker than the string assertion it replaced. `alsoLink` adds programs a
 * payload needs in order to be *able* to fire (H-92/H-94's `touch`), so that an
 * assertion about it not firing means something.
 */
export const runProbe = (
  command: string,
  stub: DockerDaemonStub,
  alsoLink: string[] = [],
): ProbeRun => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-probe-')),
  );
  try {
    const binDir = path.join(root, 'bin');
    const cwd = path.join(root, 'cwd');
    fs.mkdirSync(binDir);
    fs.mkdirSync(cwd);

    const dockerPath = path.join(binDir, 'docker');
    fs.writeFileSync(dockerPath, dockerDaemonStubScript(stub), { mode: 0o755 });

    for (const program of alsoLink) {
      const resolved = spawnSync('/bin/sh', ['-c', `command -v ${program}`], {
        encoding: 'utf8',
      }).stdout.trim();
      if (!resolved) throw new Error(`the executed shell needs ${program}`);
      fs.symlinkSync(resolved, path.join(binDir, program));
    }

    const ran = spawnSync('/bin/sh', ['-c', command], {
      cwd,
      encoding: 'utf8',
      env: { PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}` },
    });

    return {
      said: ran.stdout.trim(),
      status: ran.status,
      stderr: ran.stderr,
      created: fs.readdirSync(cwd),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};
