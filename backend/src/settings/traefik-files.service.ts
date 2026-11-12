import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { quote } from 'shell-quote';
import { Scalar, isMap, parse, parseDocument, stringify } from 'yaml';
import type { YAMLMap } from 'yaml';
import {
  REMOTE_CLOUDGATE_DIRECTORY,
  cloudgateDirectoryOn,
} from '../common/config/cloudgate-directory';
import { ACCESS_LOG_ROTATION_NOTE } from '../common/config/access-log-note';
import {
  carriesRequestMetrics,
  withRequestMetrics,
} from '../common/config/request-metrics';
import { encodeBase64 } from '../docker/docker.utils';
import { indexPathFor } from '../monitoring/access-log.index';
import { execOnServer } from '../remote/exec-dispatch';
import { RemoteExecService } from '../remote/remote-exec.service';
import { TRAEFIK_YAML_PARSE_OPTIONS } from '../traefik/traefik-writer.service';
import {
  accessLogAgedBackupsCommand,
  accessLogPathUnder,
  accessLogShiftCommand,
  accessLogSizeCommand,
  traefikConfigFromRead,
  traefikConfigReadCommand,
} from './access-log-rotation';
import { DNS_CHALLENGE_RESOLVER } from './dns-challenge.schema';
import { withDnsChallengeResolver } from './dns-challenge.utils';
import {
  REDACTED_SECRET,
  assertTraefikYaml,
  carriesPrivateKey,
  isYamlFile,
  redactHtpasswdUsers,
  restoreRedactedUsers,
  withheldFileRefusal,
  withheldReason,
} from './traefik-file.utils';

/**
 * Base directory of the Traefik installation, as a **function of the machine
 * that holds it** rather than a string.
 *
 * A real provider so tests can point the platform-host branch at a temp dir;
 * its default is {@link mainTraefikDirectory}.
 *
 * **What broke first, and why the provider's shape is part of the fix rather
 * than a detail after it.** This token carried a `string`, produced by a
 * `useFactory` that `SettingsModule` calls **once**, at module construction. A
 * value computed once cannot answer a per-Server question at all — and every
 * Server-scoped branch of {@link TraefikFilesService} asks one, baking that one
 * string into a command sent over SSH: `execRemote(serverId, ['cat', …])`, an
 * `echo … | base64 -d > …`, and the `root_dir=` of the remote directory walk.
 * So with `CLOUDGATE_DIRECTORY` set, each named `{localRoot}/traefik/…` on a
 * host where `serverSetupCommand` created `/etc/cloudgate/traefik`:
 * `readMainConfigOn` read nothing, and `toggleRequests` answered **404 "No
 * Traefik configuration on this server"** for a Server that has one.
 *
 * **Rejected: dropping the token and calling {@link mainTraefikDirectory} at
 * each site.** That is the shape every other converted tree took
 * (`deployment-engine.paths.ts`), and it is wrong *here* because this seam is
 * load-bearing for the local branch: `writeMainConfig`, `readConfig` and
 * `rotateAccessLog` reach a real filesystem with `fs`, so without an injectable
 * root every test of them writes into this host's actual
 * `CLOUDGATE_DIRECTORY`. A function-valued provider keeps that seam and answers
 * the machine — and `useValue` is now the *correct* registration where
 * `useFactory` was before, since the function reads the validated env at call
 * time, which is later still.
 */
export const MAIN_TRAEFIK_DIR = Symbol('MAIN_TRAEFIK_DIR');

/** What {@link MAIN_TRAEFIK_DIR} provides: the Traefik root on one machine. */
export type TraefikDirectoryOn = (serverId?: string | null) => string;

/**
 * The Traefik tree for the machine that holds it: this process's root, or the
 * Server the command is sent to, whose tree `serverSetupCommand` laid out.
 *
 * The `serverId` is the machine the *file* is on, which for every caller is the
 * `serverId` on the request — a Traefik config read off a Server is that
 * Server's, and its absence is the platform host (ADR-0008).
 *
 * Named without the `…On` suffix `applicationsDirectoryOn` and its five
 * siblings carry, deliberately: `dynamicTraefikDirectory(serverId)` — the other
 * half of this same tree, interpolated in the same expressions — has taken a
 * machine under that name, and the suffix exists there to tell a
 * converted helper from the no-argument spelling it replaced. There is no
 * no-argument spelling of this tree to tell it from.
 */
export const mainTraefikDirectory: TraefikDirectoryOn = (serverId) =>
  `${cloudgateDirectoryOn(serverId)}/traefik`;

/**
 * The dynamic directory **as Traefik sees it**: the bind *target*, which is this
 * literal on every machine whatever the host tree is rooted at.
 *
 * `deploy/install.sh` mounts this instance's relocatable
 * `{CLOUDGATE_DIR}/traefik/dynamic` *at* this path, `serverSetupCommand` mounts
 * a Server's identically (there the source is the same literal, so the mount is
 * the identity), and `TraefikSetupService` reproduces both. The static config
 * the installer and the setup script write points `providers.file.directory`
 * here for the same reason.
 *
 * So a path in a *config file Traefik reads* does not fork per machine, and
 * this is the one expression of it — the mount target and every path derived
 * from it cannot drift apart.
 */
export const TRAEFIK_CONTAINER_DYNAMIC_DIR = `${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic`;

/**
 * The access-log location `toggleRequests` writes is a fixed literal rather
 * than derived from baseDir, and it is **right** to keep it out.
 *
 * This docblock said the path "does follow CLOUDGATE_DIRECTORY" and was
 * wrong in both directions at once, which is why it now states the measurement
 * rather than the intent. The value goes into `accessLog.filePath` in
 * `traefik.yml`, and the process that reads it is **Traefik inside its
 * container**, where the only place the dynamic directory exists is the bind
 * target {@link TRAEFIK_CONTAINER_DYNAMIC_DIR}. So:
 *
 * - it does not fork on the Server the config is written to, which is what the
 *   rest of this file was converted to do; and
 * - it must not follow `CLOUDGATE_DIRECTORY` on the platform host either. It
 *   did, so on a relocated install the toggle wrote a `filePath` naming a
 *   directory that does not exist inside the container — Traefik either fails
 *   to open it or writes into its own throwaway layer, and either way no reader
 *   (`rotateAccessLog`, `LogCleanupService`, the request-analytics reader, all
 *   of which look at the bind *source*) ever sees a line.
 *
 * Where the identical-looking {@link TraefikFilesService.accessLogPath} differs
 * is which side of that mount it is on: it is the **host** path this process
 * renames with `fs`, so it is baseDir-derived and platform-host only. The two
 * are the same file and only the same string when the local root is
 * `/etc/cloudgate`.
 *
 * `deploy/install.sh` and `deploy/traefik/traefik.yml.example` write this same
 * literal at install time, which is what makes `haveActivateRequests` read a
 * fresh install as already on rather than the first toggle rewriting a file
 * that was already right. (`serverSetupCommand` no longer writes an access log
 * at all: a new remote Server is provisioned with it off, ADR-0027.)
 */
const ACCESS_LOG_FILE = `${TRAEFIK_CONTAINER_DYNAMIC_DIR}/access.log`;

/**
 * The `accessLog.fields` a Server's Traefik is given (ADR-0055): every request
 * header dropped except User-Agent, so the file on the customer's disk keeps
 * the visitor's browser and none of the cookies, tokens or other headers a
 * request carried. `defaultMode: drop` is Traefik's own default for headers
 * and is written anyway, so the block says what it does without the reader
 * knowing that.
 */
export const SERVER_ACCESS_LOG_FIELDS = {
  headers: { defaultMode: 'drop', names: { 'User-Agent': 'keep' } },
} as const;

/** The Traefik this platform runs (traefik-setup.service.ts recreates it). */
export const TRAEFIK_CONTAINER_NAME = 'cloudgate-traefik';

/**
 * What the `api` block says about itself, for whoever reads traefik.yml next.
 * Written and removed by the dashboard switch, so a hand-edit of it
 * survives exactly until that switch is next used — the same bargain
 * `dynamic/cloudgate.yml` strikes with **Assign domain**.
 */
const DASHBOARD_API_NOTE = [
  'Written by Settings \u2192 Traefik \u2192 Publish the dashboard on 8080.',
  '`insecure: true` is that dashboard: port 8080, no password on it. Turning',
  'the switch off removes this block and unpublishes the port.',
]
  .map((line) => ` ${line}`)
  .join('\n');

/**
 * When the access log gets rotated, and how many generations survive it.
 *
 * 100 MiB is Traefik's own `log.maxSize` default, so the access log gets the
 * budget Traefik would have given it if it could rotate the thing itself. Three
 * backups because they exist to be *there* after an incident, not to be read by
 * the console — the request-analytics reader only ever reads the live file, and
 * `AccessLogWindow.retainedFrom` is how it admits that.
 *
 * **Why this service rotates it at all.** The direction was to
 * configure Traefik's own rotation. Traefik 3.6.7 has none for the access log:
 * `traefik --help` offers `accesslog.filepath`, `.format`, `.bufferingsize`,
 * `.filters.*`, `.fields.*`, `.addinternals` and `.otlp.*`, and
 * `maxsize`/`maxage`/`maxbackups`/`compress` exist only under `log`, the
 * *application* log, which is a different file. Traefik's own docs point at the
 * only mechanism it does have: "Traefik close and reopen its log files,
 * assuming they're configured, on receipt of a USR1 signal." Rejected: logrotate
 * on the host — this codebase generates and owns traefik.yml, so a host-level
 * unit would be invisible to it and undiscoverable from here. What the file
 * itself says about this is `ACCESS_LOG_ROTATION_NOTE`
 * (`common/config/access-log-note.ts`), which names this constant; it used to
 * restate the whole paragraph above in the file, and was cut back to the
 * installer's four lines so every writer emits the same bytes.
 */
export const ACCESS_LOG_MAX_BYTES = 100 * 1024 * 1024;
export const ACCESS_LOG_BACKUPS = 3;

/**
 * How long a Server's older access-log files are kept after they last changed
 * (ADR-0057): visitor IPs and paths for about a month on a quiet Server, which
 * the size limit alone would keep for years. A constant, like the two above —
 * per-Server limits are deferred, not rejected.
 */
export const ACCESS_LOG_MAX_AGE_DAYS = 30;

/**
 * Whether this host has a Traefik main config at all, and — only if it does —
 * whether request logging is switched on in it.
 */
export interface RequestLoggingStatus {
  present: boolean;
  enabled: boolean;
}

/**
 * The outcome of a request-logging toggle: whether traefik.yml was rewritten,
 * and whether Traefik must be restarted for that write to take effect.
 */
export interface ToggleRequestsResult {
  written: boolean;
  restartRequired: boolean;
}

/** What one `rotateAccessLog` did, or declined to do. */
export interface AccessLogRotation {
  rotated: boolean;
  /** Size of the live log when it was looked at. */
  bytes: number;
  /** Where the log was moved to, when it was moved. */
  backup?: string;
  /**
   * Whether Traefik was successfully told to reopen. False after a rotation
   * means Traefik is still appending to the backup.
   */
  reopened?: boolean;
}

/** One node of the tree {@link TraefikFilesService.readDirectory} answers. */
export interface TreeDataItem {
  id: string;
  name: string;
  type: 'file' | 'directory';
  children?: TreeDataItem[];
  /**
   * Present only on a file the console will not open, and says why: it holds
   * private-key material (`traefik-file.utils.ts`). Listed rather than
   * omitted, so the tree still tells an operator the file is there.
   */
  withheld?: string;
}

/** The tree with every withheld file marked, on either branch of the walk. */
function markWithheld(nodes: TreeDataItem[]): TreeDataItem[] {
  return nodes.map((node) => {
    if (node.type === 'directory') {
      return { ...node, children: markWithheld(node.children ?? []) };
    }
    const reason = withheldReason(node.id);
    return reason ? { ...node, withheld: reason } : node;
  });
}

/**
 * The raw Traefik file surface behind the settings routes: the main
 * traefik.yml, named dynamic configs, arbitrary files under the Traefik
 * directory (local or over SSH), and the access-log toggle. Distinct from
 * TraefikWriterService, which persists generated FileConfig objects — this
 * service moves operator-authored YAML strings verbatim.
 */
@Injectable()
export class TraefikFilesService {
  constructor(
    private readonly remoteExec: RemoteExecService,
    @Inject(MAIN_TRAEFIK_DIR) private readonly baseDir: TraefikDirectoryOn,
  ) {}

  private mainConfigPath(serverId?: string | null): string {
    return path.join(this.baseDir(serverId), 'traefik.yml');
  }

  /**
   * The two operator-authored files this service owns by name,
   * `dynamic/cloudgate.yml` and `dynamic/middlewares.yml`.
   *
   * No machine, and not an unconverted site: both readers and both writers of
   * these are `fs` calls in this process, reached only by the four routes that
   * take no `serverId` at all. An Application's dynamic config on a Server is
   * `TraefikWriterService`'s `dynamicTraefikConfigPath`, which does take one.
   */
  private dynamicConfigPath(appName: string): string {
    return path.join(this.baseDir(null), 'dynamic', `${appName}.yml`);
  }

  /**
   * Read and write paths alike are confined to the Traefik directory
   * (deployment-logs precedent).
   *
   * **Confined to the Traefik directory *of the machine addressed*, and
   * getting that wrong in either direction is a defect.** The check ran against
   * the local root for both branches, so the by-path routes refused every path
   * that exists on the Server they address — `/etc/cloudgate/traefik/…`, the
   * only tree `serverSetupCommand` creates — which is why the escape hatch
   * could not be used to work around the rest of this ticket either.
   *
   * Rejected: admitting **either** root on either branch, which is the one-line
   * fix and is a second copy of the same defect wearing a security hat. On the
   * platform-host branch that would admit `/etc/cloudgate/traefik/…` to `fs`
   * calls in this process — a tree that on a relocated install belongs to
   * nothing here — and on the Server branch it would admit this instance's own
   * layout to a `cat` on someone else's machine. One root per machine, and the
   * machine is the one the command is going to.
   */
  private validatePath(filePath: string, serverId?: string | null): void {
    const baseDir = this.baseDir(serverId);
    const resolved = path.resolve(filePath);
    if (
      filePath.includes('../') ||
      filePath.includes('..\\') ||
      !filePath.startsWith('/') ||
      !(resolved === baseDir || resolved.startsWith(`${baseDir}/`))
    ) {
      throw new BadRequestException('Invalid path');
    }
  }

  /** The main traefik.yml — this host's own, which is what the four routes
   * that take no `serverId` mean (see {@link readMainConfigOn} for the rest). */
  readMainConfig(): string | null {
    const configPath = this.mainConfigPath(null);
    if (fs.existsSync(configPath)) {
      return fs.readFileSync(configPath, 'utf8');
    }
    return null;
  }

  /**
   * Overwrites the main traefik.yml (see {@link readMainConfig}), and refuses
   * YAML Traefik could not start from before anything is written
   * ({@link assertTraefikYaml}).
   */
  writeMainConfig(traefikConfig: string): void {
    assertTraefikYaml(traefikConfig, this.mainConfigPath(null), 'static');
    fs.mkdirSync(this.baseDir(null), { recursive: true });
    fs.writeFileSync(this.mainConfigPath(null), traefikConfig, 'utf8');
  }

  /**
   * readMainConfig for one Server: the platform host when no serverId is
   * given, otherwise that Server's traefik.yml over SSH.
   */
  // `string | null`, not `string | undefined`: the DTO hands the platform host
  // through as an explicit `null` now rather than 400ing on it, and every
  // dispatch below is `execByServer`'s truthiness test, which already read the
  // two the same way.
  private readMainConfigOn(serverId?: string | null): Promise<string | null> {
    return serverId
      ? this.readConfigInPath(this.mainConfigPath(serverId), serverId)
      : Promise.resolve(this.readMainConfig());
  }

  /** writeMainConfig for one Server (see readMainConfigOn). */
  private async writeMainConfigOn(
    traefikConfig: string,
    serverId?: string | null,
  ): Promise<void> {
    if (!serverId) {
      this.writeMainConfig(traefikConfig);
      return;
    }
    await this.writeTraefikConfigInPath(
      this.mainConfigPath(serverId),
      traefikConfig,
      serverId,
    );
  }

  /** One named file under this host's `dynamic/`, or null when it is absent. */
  readConfig(appName: string): string | null {
    const configPath = this.dynamicConfigPath(appName);
    if (fs.existsSync(configPath)) {
      return fs.readFileSync(configPath, 'utf8');
    }
    return null;
  }

  /**
   * Writes one named file under this host's `dynamic/`, refusing YAML the file
   * provider would drop.
   */
  writeConfig(appName: string, traefikConfig: string): void {
    assertTraefikYaml(
      traefikConfig,
      this.dynamicConfigPath(appName),
      'dynamic',
    );
    fs.mkdirSync(path.dirname(this.dynamicConfigPath(appName)), {
      recursive: true,
    });
    fs.writeFileSync(this.dynamicConfigPath(appName), traefikConfig, 'utf8');
  }

  /**
   * The two questions both console file routes ask before touching a file: is
   * the path inside this machine's Traefik directory (400), and is it one the
   * console withholds because it holds private-key material (403).
   */
  private assertConsoleMayOpen(
    pathFile: string,
    serverId?: string | null,
  ): void {
    this.validatePath(pathFile, serverId);
    const withheld = withheldReason(pathFile);
    if (withheld) throw new ForbiddenException(withheld);
  }

  /**
   * A file by path as the console may see it: `GET /settings/traefik/file`,
   * which both the Settings → Traefik Files tree and an Application's Advanced
   * → Traefik configuration card read.
   *
   * A file that holds private-key material is refused (403) **before** it is
   * read, so on a Server the key never crosses the SSH connection; one whose
   * name did not announce it but whose contents are a PEM key is refused after.
   * Everything else comes back with its htpasswd entries redacted
   * ({@link redactHtpasswdUsers}). {@link readConfigInPath} stays the raw read
   * this service's own parsers use.
   */
  async readFileForConsole(
    pathFile: string,
    serverId?: string | null,
  ): Promise<string | null> {
    this.assertConsoleMayOpen(pathFile, serverId);

    const content = await this.readConfigInPath(pathFile, serverId);
    if (content === null) return null;
    if (carriesPrivateKey(content)) {
      throw new ForbiddenException(withheldFileRefusal(pathFile));
    }
    return redactHtpasswdUsers(content, pathFile);
  }

  /**
   * `POST /settings/traefik/file`: the write half of
   * {@link readFileForConsole}, and every check it implies.
   *
   * - A withheld file is refused (403): a hand edit of `acme.json` can corrupt
   *   every certificate Traefik issued.
   * - A `.yml`/`.yaml` is parsed first and refused with the parser's line when
   *   it is not YAML Traefik can load — as `traefik.yml` when it is this
   *   machine's static file, which is the same case reached by path.
   * - An htpasswd entry still reading `<redacted>`, which is what a read of the
   *   file served, gets back the secret the file on disk holds for it
   *   ({@link restoreRedactedUsers}), so saving a file opened here never
   *   replaces a password with the marker.
   */
  async writeFileFromConsole(
    pathFile: string,
    traefikConfig: string,
    serverId?: string | null,
  ): Promise<void> {
    this.assertConsoleMayOpen(pathFile, serverId);

    if (isYamlFile(pathFile)) {
      const isStatic = path.resolve(pathFile) === this.mainConfigPath(serverId);
      assertTraefikYaml(
        traefikConfig,
        pathFile,
        isStatic ? 'static' : 'dynamic',
      );
    }

    // The stored file is read only when there is a marker to resolve: on a
    // Server that read is an SSH round trip, and a file that cannot be read
    // holds nothing to keep, which the restore refuses by name.
    const content = traefikConfig.includes(REDACTED_SECRET)
      ? restoreRedactedUsers(
          traefikConfig,
          await this.readConfigInPath(pathFile, serverId).catch(() => null),
          pathFile,
        )
      : traefikConfig;
    await this.writeTraefikConfigInPath(pathFile, content, serverId);
  }

  /** Reads a file by path in the Traefik directory; over SSH on a Server. */
  async readConfigInPath(
    pathFile: string,
    serverId?: string | null,
  ): Promise<string | null> {
    this.validatePath(pathFile, serverId);
    const configPath = path.join(pathFile);

    if (serverId) {
      // `validatePath` above confines the path; it does not constrain the
      // *characters* in it, so a name like `…/dynamic/a$(id).yml` resolves
      // inside `baseDir` and passes. That is the same orthogonality
      // `mount.dto.ts` records — the confinement rule and
      // the shell rule do not subsume each other. Argv rather than a
      // `quote()` at this site: this `cat` of a path is one of the
      // two shapes that actually shipped a bug, and the joining is
      // `execRemote`'s.
      const { stdout } = await this.remoteExec.execRemote(serverId, [
        'cat',
        configPath,
      ]);
      if (!stdout) return null;
      return stdout;
    }
    if (fs.existsSync(configPath)) {
      return fs.readFileSync(configPath, 'utf8');
    }
    return null;
  }

  /** Writes a file by path in the Traefik directory; over SSH on a Server. */
  async writeTraefikConfigInPath(
    pathFile: string,
    traefikConfig: string,
    serverId?: string | null,
  ): Promise<void> {
    this.validatePath(pathFile, serverId);
    const configPath = path.join(pathFile);

    if (serverId) {
      await this.remoteExec.execAsyncRemote(
        serverId,
        // The double quotes this used to carry were never a fix: `$` and a
        // backtick substitute a command inside them. The payload itself
        // is base64 in transit, which is what that encoding is for.
        `echo "${encodeBase64(traefikConfig)}" | base64 -d > ${quote([configPath])}`,
      );
      return;
    }
    fs.writeFileSync(configPath, traefikConfig, 'utf8');
  }

  /**
   * The directory as a tree: an iterative local walk, or the JSON-emitting
   * shell script over SSH. A directory that does not exist is an empty tree on
   * both arms.
   */
  async readDirectory(
    dirPath: string,
    serverId?: string | null,
  ): Promise<TreeDataItem[]> {
    if (serverId) {
      const { stdout } = await this.remoteExec.execAsyncRemote(
        serverId,
        remoteReadDirectoryScript(dirPath),
      );
      return markWithheld(JSON.parse(stdout) as TreeDataItem[]);
    }

    const stack = [dirPath];
    const result: TreeDataItem[] = [];
    const parentMap: Record<string, TreeDataItem[]> = {};

    while (stack.length > 0) {
      const currentPath = stack.pop();
      if (!currentPath) continue;

      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(currentPath, { withFileTypes: true });
      } catch (error) {
        // A host whose setup has not created the tree yet threw ENOENT here,
        // which answered 500 and left `/requests` saying it "could not tell".
        // An absent directory is an empty tree — which is what the
        // remote walk below already answers, since its glob matches nothing —
        // and the console reads an empty tree as "no Traefik here".
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const currentDirectoryResult: TreeDataItem[] = [];

      for (const item of items) {
        const fullPath = path.join(currentPath, item.name);
        if (item.isDirectory()) {
          stack.push(fullPath);
          const directoryItem: TreeDataItem = {
            id: fullPath,
            name: item.name,
            type: 'directory',
            children: [],
          };
          currentDirectoryResult.push(directoryItem);
          parentMap[fullPath] = directoryItem.children as TreeDataItem[];
        } else {
          currentDirectoryResult.push({
            id: fullPath,
            name: item.name,
            type: 'file',
          });
        }
      }

      if (parentMap[currentPath]) {
        parentMap[currentPath].push(...currentDirectoryResult);
      } else {
        result.push(...currentDirectoryResult);
      }
    }
    return markWithheld(result);
  }

  /**
   * Sets `certificatesResolvers.letsencrypt.acme.email` in this host's
   * traefik.yml, and throws when that block is missing — and the DNS-01
   * resolver's email too, when this host has one.
   *
   * {@link TRAEFIK_YAML_PARSE_OPTIONS} carries why the `parse` below may not
   * inherit the library's `logLevel`, and why this is the weakest of the four
   * sites it covers and got the option anyway.
   */
  updateLetsEncryptEmail(newEmail: string | null): void {
    if (!newEmail) return;
    const configContent = this.readMainConfig();
    if (configContent === null) {
      throw new Error("Invalid Let's Encrypt configuration structure.");
    }
    const config = parse(configContent, TRAEFIK_YAML_PARSE_OPTIONS) as {
      certificatesResolvers?: Record<
        string,
        { acme?: { email?: string } } | undefined
      >;
    };
    const resolvers = config?.certificatesResolvers;
    if (resolvers?.letsencrypt?.acme) {
      resolvers.letsencrypt.acme.email = newEmail;
    } else {
      throw new Error("Invalid Let's Encrypt configuration structure.");
    }
    // The DNS-01 resolver copied this email when it was written, so it
    // follows it: two resolvers on one machine registering two ACME accounts
    // under two addresses is a state nobody chose.
    const dns = resolvers[DNS_CHALLENGE_RESOLVER]?.acme;
    if (dns) dns.email = newEmail;
    this.writeMainConfig(stringify(config));
  }

  /**
   * Writes the DNS-01 resolver into one machine's `traefik.yml` beside
   * `letsencrypt`, or removes it when `provider` is null; see
   * {@link withDnsChallengeResolver} for the block's shape.
   *
   * Writing needs a traefik.yml and 404s without one, as the dashboard's `api`
   * write does; removing from a machine that has none is already done.
   */
  async writeDnsChallengeResolver(
    provider: string | null,
    serverId?: string | null,
  ): Promise<void> {
    const mainConfig = await this.readMainConfigOn(serverId);
    if (!mainConfig) {
      if (provider === null) return;
      throw new NotFoundException('No Traefik configuration on this server');
    }
    await this.writeMainConfigOn(
      withDnsChallengeResolver(mainConfig, provider),
      serverId,
    );
  }

  /**
   * Whether request logging is on: `present` says whether this host has a
   * traefik.yml at all, so "logging is off" and "there is no Traefik
   * installation here" stop being the same answer.
   *
   * The **widest-open** of the four sites {@link TRAEFIK_YAML_PARSE_OPTIONS}
   * covers, and the reason it is: this route is ADR-0013's named
   * any-authenticated-user carve-out, so the parse below is reachable on demand
   * by any signed-in member of any organization.
   */
  async haveActivateRequests(
    serverId?: string | null,
  ): Promise<RequestLoggingStatus> {
    const config = await this.readMainConfigOn(serverId);
    if (!config) return { present: false, enabled: false };
    return { present: true, enabled: accessLogOn(config) };
  }

  /**
   * Adds or removes the accessLog block. accessLog lives in traefik.yml —
   * Traefik's *static* configuration, read once at process start, unwatched by
   * the file provider that watches `dynamic/`. So the write alone changes
   * nothing that is running: the result reports the owed restart rather than
   * performing it, because dropping every connection on 80 and 443 is not a
   * side effect of ticking a box (POST /settings/traefik/reload stays the named
   * action).
   *
   * A host with no traefik.yml is refused (404) rather than answered `false`,
   * so it is never mistaken for "logging is off".
   *
   * On a **Server** the block also tells Traefik to drop every request header
   * except User-Agent ({@link SERVER_ACCESS_LOG_FIELDS}, ADR-0055). The
   * platform host's block is left as it was: its headers are outside the Requests work.
   * The restart a Server's write is owed is `RequestLoggingService`'s, which
   * performs it in the same request; this method only writes.
   */
  async toggleRequests(
    enable: boolean,
    serverId?: string | null,
  ): Promise<ToggleRequestsResult> {
    const mainConfig = await this.readMainConfigOn(serverId);
    if (!mainConfig) {
      throw new NotFoundException('No Traefik configuration on this server');
    }

    // A Document rather than parse/stringify, so that the rotation note can sit
    // on the block it is about — and, incidentally, so that comments the
    // operator wrote survive the toggle, which parse/stringify dropped.
    //
    // **Deliberately no `logLevel`**, unlike this file's two `parse` calls.
    // Measured on yaml 2.9.0: `parseDocument` prettifies `doc.warnings` and
    // hands them back on the document, and only `parse` iterates them into
    // `log.warn` — so this call has no diagnostic channel to close and passing
    // {@link TRAEFIK_YAML_PARSE_OPTIONS} here would assert a property the
    // library does not have. `traefik-yaml-warning-echo.spec.ts` holds
    // the case that would notice if that ever changed.
    const doc = parseDocument(mainConfig);

    if (enable) {
      // `createNode` first, because `set` with a plain object stores it verbatim
      // and a `commentBefore` put on *that* is serialised as another config key.
      // The note then goes on the pair's **key**, not on the value: on the value
      // it renders indented underneath `accessLog:` rather than above it, and a
      // plain string key has nowhere to carry a comment at all.
      doc.set(
        'accessLog',
        doc.createNode({
          filePath: ACCESS_LOG_FILE,
          format: 'json',
          bufferingSize: 100,
          ...(serverId ? { fields: SERVER_ACCESS_LOG_FIELDS } : {}),
        }),
      );
      const key = new Scalar('accessLog');
      key.commentBefore = ACCESS_LOG_ROTATION_NOTE;
      const pair = (doc.contents as YAMLMap).items.find(
        (item) => String(item.key) === 'accessLog',
      );
      if (pair) pair.key = key;
    } else {
      doc.delete('accessLog');
    }

    await this.writeMainConfigOn(doc.toString(), serverId);
    return { written: true, restartRequired: true };
  }

  /**
   * Adds or removes traefik.yml's `api` block, so that publishing port 8080
   * puts something behind it.
   *
   * The dashboard is two facts on two sides of the container boundary: the
   * published port, which `TraefikSetupService` recreates the container to
   * change, and `api` in the **static** config, which is what makes Traefik
   * listen on 8080 at all. Only the first was ever written, so the switch
   * opened a port that answered a connection reset. This is the other half, and
   * it is called from the same toggle: the recreate that follows is the restart
   * static configuration needs, so nothing else is owed here — unlike
   * {@link toggleRequests}, which writes and then reports the owed restart
   * because ticking a box does not drop every connection on 80 and 443.
   *
   * `insecure: true` is what a dashboard on a published port *is* — it is the
   * unauthenticated one, which is what the switch warns about at length in
   * those words — and it is removed again when the switch goes off, so the
   * dashboard does not stay listening inside the container for everything else
   * on the Cloudgate network.
   *
   * A `Document` rather than parse/stringify, for {@link toggleRequests}'s
   * reasons.
   *
   * A host with no traefik.yml is refused on the way **on** only. Refusing it
   * both ways took away the one direction that always used to work: 8080 would
   * stay published on a host whose config cannot be edited to answer on it,
   * with no way back. Off has no `api` block to remove there, which is the
   * state the caller asked for, so off is simply done.
   */
  async toggleDashboardApi(
    enable: boolean,
    serverId?: string | null,
  ): Promise<void> {
    const mainConfig = await this.readMainConfigOn(serverId);
    if (!mainConfig) {
      if (!enable) return;
      throw new NotFoundException('No Traefik configuration on this server');
    }

    const doc = parseDocument(mainConfig);

    if (enable) {
      doc.set('api', doc.createNode({ dashboard: true, insecure: true }));
      const key = new Scalar('api');
      key.commentBefore = DASHBOARD_API_NOTE;
      // `isMap` rather than the cast the identical line in `toggleRequests`
      // makes: `doc.contents` is nullable, and new code here type-checks as if
      // `strict` (CODING_STANDARDS §4). The `set` above has made it a map in
      // every reachable case, so the guard costs a branch and asserts nothing.
      // Narrowed off an `unknown` local because narrowing `doc.contents` itself
      // keeps its `ParsedNode` half, and a key that has just been built has no
      // source range for that half to demand.
      const contents: unknown = doc.contents;
      const pair = isMap(contents)
        ? contents.items.find((item) => String(item.key) === 'api')
        : undefined;
      if (pair) pair.key = key;
    } else {
      doc.delete('api');
    }

    await this.writeMainConfigOn(doc.toString(), serverId);
  }

  /**
   * Writes request metrics into one machine's `traefik.yml` — the loopback
   * `metrics` entryPoint and `metrics.prometheus` on it, the same block every
   * provisioning writer emits (`common/config/request-metrics.ts`, ADR-0027).
   *
   * Static configuration, like {@link toggleRequests}'s: the write alone changes
   * nothing that is running, and the Traefik restart that makes it take effect
   * is the caller's (`POST /settings/traefik/request-metrics` requests it behind
   * the restart gate). A machine with no traefik.yml is refused (404), as the
   * access-log toggle refuses one. Idempotent: enabling twice writes the same
   * bytes.
   */
  async enableRequestMetrics(serverId?: string | null): Promise<void> {
    const mainConfig = await this.readMainConfigOn(serverId);
    if (!mainConfig) {
      throw new NotFoundException('No Traefik configuration on this server');
    }
    await this.writeMainConfigOn(withRequestMetrics(mainConfig), serverId);
  }

  /**
   * Whether **the platform host's** traefik.yml carries request metrics. A
   * local file read, so it is cheap enough for every read of the host's state;
   * a Server's state is the stored `server.requestMetricsEnabled` instead (see
   * `RequestMetricsService`).
   */
  platformCarriesRequestMetrics(): boolean {
    const config = this.readMainConfig();
    return config !== null && carriesRequestMetrics(config);
  }

  /**
   * The access log as **this host** has it, not as the config literal spells
   * it: the source side of the bind mount, which is where `fs` can rename it.
   * {@link ACCESS_LOG_FILE} is the target side and the two are one file — see
   * that constant for why only one of them follows `CLOUDGATE_DIRECTORY`.
   */
  private accessLogPath(): string {
    return accessLogPathUnder(this.baseDir(null));
  }

  /**
   * Rotate the access log, so that "the file" the request-analytics reader walks
   * is bounded.
   *
   * Traefik cannot do this itself — see `ACCESS_LOG_MAX_BYTES` for what its
   * 3.6 configuration does and does not offer. What it does offer is SIGUSR1,
   * which closes and reopens `accessLog.filePath`, so rotation is: move the file
   * aside, then signal. In that order, deliberately — between the rename and the
   * signal Traefik keeps writing to the renamed file, which is the backup, so
   * those lines are kept rather than dropped on the floor.
   *
   * Size-gated, because SIGUSR1 is not free: it makes Traefik drop and reopen a
   * log handle, and doing that on a schedule regardless of size would churn the
   * file for nothing.
   *
   * The platform host's log, with `fs`. A Server's is {@link rotateAccessLogOn}:
   * the same rules over SSH. This docblock used to say a remote log is "written
   * but never read", so rotating one "would be rotating a file nothing looks
   * at" — true of the reader (no request-analytics query takes a serverId) and
   * beside the point, because the reason to rotate is the disk, not the reader.
   * A Server with the log on writes ~800 B a request until its disk fills.
   */
  async rotateAccessLog(): Promise<AccessLogRotation> {
    const logPath = this.accessLogPath();
    if (!fs.existsSync(logPath)) return { rotated: false, bytes: 0 };

    const bytes = fs.statSync(logPath).size;
    if (bytes <= ACCESS_LOG_MAX_BYTES) return { rotated: false, bytes };

    // Oldest first, so nothing is overwritten before it has been shifted.
    fs.rmSync(`${logPath}.${ACCESS_LOG_BACKUPS}`, { force: true });
    for (let n = ACCESS_LOG_BACKUPS - 1; n >= 1; n -= 1) {
      if (fs.existsSync(`${logPath}.${n}`)) {
        fs.renameSync(`${logPath}.${n}`, `${logPath}.${n + 1}`);
      }
    }
    const backup = `${logPath}.1`;
    fs.renameSync(logPath, backup);
    // The hour index's offsets are into the file that just moved. The reader
    // notices on its own, but leaving a dead index on disk for it to load and
    // discard is pointless work and a confusing artefact next to the log.
    fs.rmSync(indexPathFor(logPath), { force: true });

    return { rotated: true, bytes, backup, reopened: await this.reopenLogs() };
  }

  /**
   * {@link rotateAccessLog} on one Server, over SSH: the same size gate,
   * the same generations shifted oldest first, the same rename-then-SIGUSR1
   * order, sent to that Server's Traefik.
   *
   * Only when the Server's traefik.yml has `accessLog` on, parsed exactly as
   * {@link haveActivateRequests} parses it. A Server with the log off answers
   * after that one read and nothing is written to it — the log-off Server is
   * every Server provisioned by this version, and the reason this exists is
   * the ones from before it, and any an operator turned back on with
   * `POST /settings/traefik/requests`. Rejected: switching those logs off
   * instead, which is a Traefik restart on every Server nobody asked for.
   *
   * The path is the Server's Traefik root's `dynamic/access.log`, the file
   * `accessLog.filePath` names: `serverSetupCommand` bind-mounts that directory
   * at the same path inside the container, so on a Server the two sides of the
   * mount are one string. No hour index to remove, unlike the host's — nothing
   * builds one for a Server's log.
   *
   * A Server with no traefik.yml — added and never set up — is passed over
   * the same way, quietly, as the platform host's read passes over a missing
   * file. The read is not `haveActivateRequests`' for that reason: its `cat`
   * exits non-zero for a missing file just as the exec does for an
   * unreachable Server, so a never-set-up Server was logged as skipped on
   * every cron run. This read reports absence explicitly
   * ({@link traefikConfigReadCommand}).
   *
   * Rejects when the Server cannot be reached or a step fails; the caller
   * (`ServerAccessLogUpkeepService`) logs that by Server name and moves on.
   */
  async rotateAccessLogOn(serverId: string): Promise<AccessLogRotation> {
    const { stdout: read } = await this.remoteExec.execAsyncRemote(
      serverId,
      traefikConfigReadCommand(this.mainConfigPath(serverId)),
    );
    const config = traefikConfigFromRead(read);
    if (!config || !accessLogOn(config)) return { rotated: false, bytes: 0 };

    const logPath = accessLogPathUnder(this.baseDir(serverId));
    const { stdout } = await this.remoteExec.execAsyncRemote(
      serverId,
      accessLogSizeCommand(logPath),
    );
    const bytes = Number(stdout.trim()) || 0;
    if (bytes <= ACCESS_LOG_MAX_BYTES) return { rotated: false, bytes };

    await this.remoteExec.execAsyncRemote(
      serverId,
      accessLogShiftCommand(logPath, ACCESS_LOG_BACKUPS),
    );
    return {
      rotated: true,
      bytes,
      backup: `${logPath}.1`,
      reopened: await this.reopenLogs(serverId),
    };
  }

  /**
   * Deletes a Server's older access-log files last changed more than
   * {@link ACCESS_LOG_MAX_AGE_DAYS} ago, and answers the paths it deleted.
   *
   * Not gated on the Server's traefik.yml, unlike {@link rotateAccessLogOn}:
   * a Server that turned logging off keeps its older files, and this is what
   * clears them (ADR-0057). One program whatever is there, so a Server with
   * nothing to delete costs one exec. The live file is never named
   * ({@link accessLogAgedBackupsCommand}).
   *
   * Rejects when the Server cannot be reached; the caller
   * (`ServerAccessLogUpkeepService`) logs that by Server name and moves on.
   */
  async deleteAgedAccessLogsOn(serverId: string): Promise<string[]> {
    const logPath = accessLogPathUnder(this.baseDir(serverId));
    const { stdout } = await this.remoteExec.execAsyncRemote(
      serverId,
      accessLogAgedBackupsCommand(
        logPath,
        ACCESS_LOG_BACKUPS,
        ACCESS_LOG_MAX_AGE_DAYS * 24 * 60,
      ),
    );
    return stdout.split('\n').filter((line) => line !== '');
  }

  /**
   * SIGUSR1 to Traefik: close and reopen the log files.
   *
   * Traefik runs either standalone (`cloudgate-traefik`) or as a swarm task
   * (`cloudgate-traefik.1.<task-id>`), so the container is resolved by name
   * filter rather than addressed directly — LogCleanupService's approach, which
   * this now shares with it.
   *
   * A false answer means the rename happened and Traefik was not told: it keeps
   * appending to the backup, and the console sees no new requests until Traefik
   * is restarted. Worth reporting rather than swallowing.
   *
   * On the machine the log is on — the platform host, or a Server —
   * through `execOnServer`, which keeps the host's two calls exactly what they
   * were: the pipeline as a string, the signal as argv.
   */
  private async reopenLogs(serverId?: string | null): Promise<boolean> {
    try {
      const { stdout } = await execOnServer(
        this.remoteExec,
        serverId,
        `docker ps -q --filter "name=${TRAEFIK_CONTAINER_NAME}" --filter "status=running" | head -n 1`,
      );
      const containerId = stdout.trim();
      if (!containerId) {
        console.error('Traefik container not found, skipping log reopen');
        return false;
      }
      // Argv, so the signal never goes through a local shell at all — the id
      // above came off `docker ps` rather than from a caller, so this is the
      // review saving rather than a fix. The `docker ps … | head -n 1`
      // that produced it stays a string: a pipeline has no argv.
      await execOnServer(this.remoteExec, serverId, [
        'docker',
        'exec',
        containerId,
        'kill',
        '-USR1',
        '1',
      ]);
      return true;
    } catch (error) {
      console.error('Could not signal Traefik to reopen its logs:', error);
      return false;
    }
  }
}

/**
 * Whether a traefik.yml has the access log on: an `accessLog` block naming a
 * file. The one reading {@link TraefikFilesService.haveActivateRequests},
 * {@link TraefikFilesService.rotateAccessLogOn} and the Requests page's
 * per-Server read (`ServerAccessLogService`, "logging off") all use.
 */
export function accessLogOn(config: string): boolean {
  const parsedConfig = parse(config, TRAEFIK_YAML_PARSE_OPTIONS) as {
    accessLog?: { filePath: string };
  };
  return !!parsedConfig?.accessLog?.filePath;
}

/** The remote readDirectory walk: prints the tree under `root_dir` as JSON. */
const remoteReadDirectoryScript = (dirPath: string) => `
process_items() {
    local parent_dir="$1"
    local __resultvar=$2

    local items_json=""
    local first=true
    for item in "$parent_dir"/*; do
        [ -e "$item" ] || continue
        process_item "$item" item_json
        if [ "$first" = true ]; then
            first=false
            items_json="$item_json"
        else
            items_json="$items_json,$item_json"
        fi
    done

    eval $__resultvar="'[$items_json]'"
}

process_item() {
    local item_path="$1"
    local __resultvar=$2

    local item_name=$(basename "$item_path")
    local escaped_name=$(echo "$item_name" | sed 's/"/\\"/g')
    local escaped_path=$(echo "$item_path" | sed 's/"/\\"/g')

    if [ -d "$item_path" ]; then
        # Is directory
        process_items "$item_path" children_json
        local json='{"id":"'"$escaped_path"'","name":"'"$escaped_name"'","type":"directory","children":'"$children_json"'}'
    else
        # Is file
        local json='{"id":"'"$escaped_path"'","name":"'"$escaped_name"'","type":"file"}'
    fi

    eval $__resultvar="'$json'"
}

root_dir=${dirPath}

process_items "$root_dir" json_output

echo "$json_output"
			`;
