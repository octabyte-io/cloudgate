import fs from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { RemoteExecService } from '../remote/remote-exec.service';
import { localCloudgateDirectory } from '../common/config/cloudgate-directory';

/** Where the auto-generated local-terminal SSH key lives — on this host, so
 * under CLOUDGATE_DIRECTORY. Mode 0700 and root-owned, created by
 * `setupSshKey()` below and by `deploy/install.sh`. */
export const sshDirectory = () => `${localCloudgateDirectory()}/ssh`;

/**
 * The key pair the local terminal dials with. A function, not a constant: the
 * root it sits under comes from CLOUDGATE_DIRECTORY, which `ConfigModule`
 * publishes only after every module has been imported.
 */
export const localSshKeyPath = () =>
  path.join(sshDirectory(), 'auto_generated-cloudgate-local');

/** Loopback: where "the host the platform runs on" is when the platform is
 *  running on it directly. The literal address rather than `localhost`, whose
 *  resolution order decides between 127.0.0.1 and ::1 and can land on an
 *  address sshd is not listening on. */
export const LOOPBACK_HOST = '127.0.0.1';

/** Docker's default bridge gateway, for a container whose routing table cannot
 *  be read. */
export const DEFAULT_DOCKER_BRIDGE_HOST = '172.17.0.1';

/** The files a container runtime leaves in a container's filesystem. */
const DOCKER_MARKER = '/.dockerenv';
const PODMAN_MARKER = '/run/.containerenv';
const INIT_CGROUP = '/proc/1/cgroup';
const CONTAINER_RUNTIME_IN_CGROUP = /docker|containerd|kubepods|libpod|lxc/;

/**
 * Support pieces for the "local" server terminal: the terminal SSHes into
 * the host the platform runs on, with a key it generates once.
 */
@Injectable()
export class LocalServerSetupService {
  constructor(private readonly remoteExec: RemoteExecService) {}

  /**
   * Returns the local-access private key, generating it on first use.
   *
   * **The `mkdirSync` is the whole fix.** `ssh-keygen` does not create a
   * parent for an explicit `-f` path, and nothing anywhere created this one:
   * `deploy/install.sh` made only `traefik/dynamic`, and `serverSetupCommand`'s
   * `setupMainDirectory` makes the same two on a *remote* Server. So on a stock
   * install the very first thing the fleet card can ask for — a shell on the
   * platform host — closed `4502`, and the reason it closed with was the echoed
   * `ssh-keygen` command line rather than the `No such file or directory` that
   * followed it, because a WebSocket close reason is 123 bytes.
   *
   * Here rather than at boot, which is the idiom `traefik-writer.service.ts:89`
   * and `traefik-files.service.ts:171` already use — and here it is not only
   * convention: `localCloudgateDirectory()` is a function precisely so nothing
   * is frozen at import (§2.8), so there is no boot-time moment at which the
   * right path is known. Before the `existsSync` branch, not inside it: it is
   * idempotent, and it does not change the mode of a directory already there.
   *
   * `0o700` because the private key lives in it and F-04 means anything readable
   * under this tree is readable by any authenticated caller. The umask masks
   * `mode`, and `0o700` survives the usual `022`, so an explicit `chmodSync` is
   * not warranted. `deploy/install.sh` creates it too — the installer makes a
   * fresh box right at install time, this makes an operator who relocated
   * `CLOUDGATE_DIRECTORY` right at first use, and neither covers the other.
   */
  async setupSshKey(): Promise<string> {
    const sshKeyPath = localSshKeyPath();

    fs.mkdirSync(sshDirectory(), { recursive: true, mode: 0o700 });

    if (!fs.existsSync(sshKeyPath)) {
      // Argv: the empty passphrase is an empty *word* rather than a `""`
      // a shell has to be trusted to collapse, and the key path — which follows
      // `CLOUDGATE_DIRECTORY`, so an operator's value reaches it — is a word
      // rather than a bare interpolation. `ssh-keygen` is not a shell program.
      await this.remoteExec.execFileAsync('ssh-keygen', [
        '-t',
        'rsa',
        '-b',
        '4096',
        '-f',
        sshKeyPath,
        '-N',
        '',
        '-C',
        'cloudgate-local-access',
      ]);
    }

    return fs.readFileSync(sshKeyPath, 'utf8');
  }

  /**
   * The address the local terminal should SSH to, which is always *this host* —
   * the question is only how this process reaches it.
   *
   * The branch that matters is whether the backend is itself in a container,
   * and nothing else. It used to be `NODE_ENV === 'production'`, on the
   * assumption that a production deployment is a container deployment, and
   * answered a Linux host with its default route because "the container's
   * default gateway is the Docker bridge to the host". Installed natively —
   * which `docs/deploy.md` documents as a supported install — the default route
   * is the *upstream router*: on the VPS this was found on, `172.31.1.1`, the
   * datacentre gateway. The terminal then dialled somebody else's machine and
   * timed out on the handshake, and no amount of installing the generated public
   * key locally could help.
   *
   * So: not containerised, the host is reachable at loopback, whatever
   * NODE_ENV says. Containerised, the old resolution is right and stays.
   */
  async getDockerHost(): Promise<string> {
    if (!this.isContainerised()) {
      return LOOPBACK_HOST;
    }

    if (process.platform === 'linux' && !(await this.isWSL())) {
      try {
        // The container's default gateway is the Docker bridge to the host.
        const { stdout } = await this.remoteExec.execAsync(
          "ip route | awk '/default/ {print $3}'",
        );
        const hostIp = stdout.trim();
        if (!hostIp) {
          throw new Error('Failed to get Docker host IP');
        }
        return hostIp;
      } catch {
        return DEFAULT_DOCKER_BRIDGE_HOST;
      }
    }
    return 'host.docker.internal';
  }

  /**
   * Whether this process is running inside a container.
   *
   * Four pieces of evidence, because no single one covers every runtime:
   * Docker writes `/.dockerenv` into every container it starts and Podman
   * writes `/run/.containerenv`; Kubernetes injects `KUBERNETES_SERVICE_HOST`
   * into every pod; and under cgroup v1 the init process's cgroup path names
   * the runtime. The cgroup file is the weakest — under cgroup v2 a container's
   * `/proc/1/cgroup` is a bare `0::/` that says nothing — which is why the
   * marker files are checked first rather than instead.
   *
   * Synchronous on purpose: these are `/proc` and root-directory reads that
   * never block, and an async check here would be a second await in front of
   * every terminal that opens.
   */
  private isContainerised(): boolean {
    if (fs.existsSync(DOCKER_MARKER) || fs.existsSync(PODMAN_MARKER)) {
      return true;
    }
    if (process.env.KUBERNETES_SERVICE_HOST) {
      return true;
    }
    try {
      return CONTAINER_RUNTIME_IN_CGROUP.test(
        fs.readFileSync(INIT_CGROUP, 'utf8'),
      );
    } catch {
      // No /proc/1/cgroup at all: a Mac or a BSD, neither of which is a
      // container this process could be inside.
      return false;
    }
  }

  private async isWSL(): Promise<boolean> {
    try {
      const { stdout } = await this.remoteExec.execAsync('uname -r');
      return stdout.includes('microsoft');
    } catch {
      return false;
    }
  }
}
