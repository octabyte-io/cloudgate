import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A stand-in `docker` that answers `docker login` the way a registry behind
 * htpasswd does, on a real `PATH`, so the probe is *run* rather than
 * read (H-95's argument, `test/utils/docker-daemon-stub.ts`).
 *
 * What a string assertion cannot see here is the two properties the route is
 * for: that the password reaches `docker` on **stdin** and nowhere else, and
 * that the login writes into a throwaway `DOCKER_CONFIG` which is gone
 * afterwards. So every invocation records its argv, its `DOCKER_CONFIG` and
 * the bytes it read into {@link DockerLoginStub.calls}, and a test asserts on
 * what the program actually did.
 *
 * The refusal is the line docker 29.3.1 printed for a wrong password against
 * `registry:2` with `REGISTRY_AUTH=htpasswd` (measured on the
 * `i476-registry` container), with the host swapped for the one asked about —
 * which is what the daemon does too.
 */
export interface DockerLoginStub {
  /** Prepend to `PATH`. */
  binDir: string;
  /** Every `docker` invocation so far, oldest first. */
  calls(): DockerLoginCall[];
  /** Removes the stub's directory. */
  remove(): void;
}

export interface DockerLoginCall {
  argv: string;
  dockerConfig: string;
  stdin: string;
}

export const dockerLoginRefusal = (host: string): string =>
  `Error response from daemon: login attempt to http://${host}/v2/ failed with status: 401 Unauthorized`;

/**
 * `user`/`password` are the one pair the stub's registry accepts. Baked into the
 * script text (single-quoted, and the tests use plain values) rather than read
 * from the environment, so the program under test cannot influence them.
 */
export function installDockerLoginStub(accepts: {
  user: string;
  password: string;
}): DockerLoginStub {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-login-stub-')),
  );
  const binDir = path.join(root, 'bin');
  const log = path.join(root, 'calls');
  fs.mkdirSync(binDir);
  fs.writeFileSync(log, '');

  // One record per call, fields separated by a unit separator and records by a
  // record separator, so a value with a newline in it cannot forge a record.
  const script = `#!/bin/sh
if [ "$1" != login ]; then
	echo "docker stub: unexpected invocation: $*" >&2
	exit 127
fi
server=$2
user=$4
password=$(cat)
printf '%s\\037%s\\037%s\\036' "$*" "$DOCKER_CONFIG" "$password" >> '${log}'
if [ "$user" = '${accepts.user}' ] && [ "$password" = '${accepts.password}' ]; then
	mkdir -p "$DOCKER_CONFIG"
	printf '{"auths":{"%s":{}}}' "$server" > "$DOCKER_CONFIG/config.json"
	echo "Login Succeeded"
	exit 0
fi
echo "Error response from daemon: login attempt to http://$server/v2/ failed with status: 401 Unauthorized" >&2
exit 1
`;
  fs.writeFileSync(path.join(binDir, 'docker'), script, { mode: 0o755 });

  return {
    binDir,
    calls: () =>
      fs
        .readFileSync(log, 'utf8')
        .split('\x1e')
        .filter(Boolean)
        .map((record) => {
          const [argv, dockerConfig, stdin] = record.split('\x1f');
          return { argv, dockerConfig, stdin };
        }),
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
