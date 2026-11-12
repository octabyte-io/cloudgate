import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable, Optional } from '@nestjs/common';
import { quote } from 'shell-quote';
import { parse, stringify } from 'yaml';
import { cloudgateDirectoryOn } from '../common/config/cloudgate-directory';
import {
  OWNER_ONLY_FILE_MODE,
  replaceOwnerOnlyFileCommand,
  replaceOwnerOnlyFileSync,
  writeOwnerOnlyFileCommand,
  writeOwnerOnlyFileSync,
} from '../common/files/owner-only';
import { encodeBase64 } from '../docker/docker.utils';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import type { FileConfig } from './config/file-types';
import { certificateConfigName } from './config/names';

/**
 * Directory Traefik's file provider watches (mounted by server setup) — on the
 * host that Traefik runs on. This instance's own, under CLOUDGATE_DIRECTORY,
 * unless the config is being written to a Server over SSH, where the tree is
 * the one serverSetupCommand created.
 *
 * **The fork is {@link cloudgateDirectoryOn} rather than written out here, and
 * that is the whole of what changed about this line.** It read
 * `serverId ? REMOTE_CLOUDGATE_DIRECTORY : localCloudgateDirectory()`, which is
 * that function's body — the same answer, spelled a second time. The earlier
 * finding was that eight helpers came to disagree about these two roots by each
 * spelling the choice itself, and this one being *right* is not the property
 * that keeps it right: it was the sibling half of the pair
 * `TraefikFilesService`' `mainTraefikDirectory` got wrong, in a different
 * module, and the disagreement this fixed was visible inside a single service
 * because of it. Rejected: leaving it alone because it already forks — one
 * expression is what makes "both halves of the Traefik tree answer the same
 * question" a fact about the code rather than about two docblocks.
 */
export const dynamicTraefikDirectory = (serverId?: string | null) =>
  `${cloudgateDirectoryOn(serverId)}/traefik/dynamic`;

/** Per-certificate directories under the watched dir. */
export const certificatesDirectory = (serverId?: string | null) =>
  `${dynamicTraefikDirectory(serverId)}/certificates`;

/**
 * One certificate's own directory below {@link certificatesDirectory}, which
 * holds its PEM pair and, for a certificate an earlier version wrote, its
 * {@link legacyCertificateConfigPath}.
 */
export const certificateDirectory = (
  certificatePath: string,
  serverId?: string | null,
): string => path.join(certificatesDirectory(serverId), certificatePath);

/**
 * The dynamic-config file that routes at one Application, on the host Traefik
 * runs on: `{dynamicTraefikDirectory(serverId)}/{appName}.yml`.
 *
 * Exported, and the reason is that a *delete* has to name it. The
 * removal of this file is one of an Application's three machine teardown steps
 * and the only thing in the product that removes it, no presence read covers
 * it, and a failure of it leaves a public hostname advertised at a backend that
 * is gone — so the delete's answer carries `{ kind: 'traefik-config', … path }`
 * (`common/teardown-steps.ts`'s `UnreclaimedArtifact`). The path in that answer
 * has to be *this* expression rather than a second copy of it: a report naming
 * a path the removal never attempted is worse than no report, because an
 * operator acts on it.
 *
 * {@link TraefikWriterService.configPath} delegates here rather than the other
 * way round, so the writer, the reader, the removal and the report are one
 * statement (§1.4).
 */
export const dynamicTraefikConfigPath = (
  appName: string,
  serverId?: string | null,
) => path.join(dynamicTraefikDirectory(serverId), `${appName}.yml`);

/**
 * Where a custom certificate's `tls.certificates` fragment lives on the machine
 * Traefik runs on: `dynamic/certificate+<certificatePath>.yml`.
 *
 * **At the top of `dynamic/`, not in the certificate's own directory.**
 * It was `dynamic/certificates/<certificatePath>/certificate.yml`, and
 * `traefik:v3.6.7`'s file provider loads the tree under `dynamic/` at each
 * reload but puts its watch on `dynamic/` alone ("ignore sub-dir",
 * `pkg/provider/file/file.go`; measured). A certificate's directory is
 * new with every certificate (`certificatePath` is minted per row), and an edit
 * rewrites files inside it, so neither a new certificate nor new material was
 * served until something unrelated raised a reload. The PEM pair stays in that
 * directory, which is `0700` and swept at boot
 * (`common/files/owner-only-trees.service.ts`); only the fragment moved, and it
 * names the pair by the same paths as before.
 *
 * `+` is outside `APP_NAME_REGEX`, so no Application's `{appName}.yml` can take
 * the name, as with `compose+<appName>` and `ai-gateway+<appName>`. That old
 * path is {@link legacyCertificateConfigPath}.
 */
export const certificateConfigPath = (
  certificatePath: string,
  serverId?: string | null,
): string =>
  dynamicTraefikConfigPath(certificateConfigName(certificatePath), serverId);

/**
 * Where an earlier version wrote a certificate's fragment,
 * `dynamic/certificates/<certificatePath>/certificate.yml`, which Traefik reads
 * at a reload but never reloads for. The next save of that certificate
 * removes it once {@link certificateConfigPath} is in place, and a Delete
 * removes it with the directory, then raises a reload of its own (see
 * `removeCertificate`), so a machine an earlier version wrote to is corrected
 * certificate by certificate. Until then it is still served: a reload loads it,
 * and Traefik has reloaded since it was written.
 */
export const legacyCertificateConfigPath = (
  certificatePath: string,
  serverId?: string | null,
): string =>
  path.join(certificateDirectory(certificatePath, serverId), 'certificate.yml');

/**
 * The options every `parse` of a Traefik config file passes, and the whole of
 * why.
 *
 * **What broke first, one module over.** `yaml`'s `parse` was found defaulting
 * `logLevel` to `'warn'`: `parse` ends with
 * `doc.warnings.forEach(w => log.warn(doc.options.logLevel, w))`, `log.warn` is
 * `process.emitWarning`, and with no application `warning` listener anywhere in
 * the tree Node's own default handler formats it onto process **stderr**. The
 * warning is prettified — the same `prettifyError(source, lineCounter)` an
 * error gets — so it carries the offending source line plus a caret, and the
 * document still *parses*, so no exception exists at any point and
 * `AllExceptionsFilter`, `capMessage` and `elideEncodedPayloads` are all
 * downstream of a path that never reaches them. That was closed at
 * `parseComposeFile` and the general lesson recorded in ADR 0015 — *a library's
 * own diagnostic channel is an echo site*. It did not reach here, because that
 * sweep was keyed on `encryptedText` columns and Traefik config is a file on a
 * disk.
 *
 * **The audience question answers *narrower*, and that is recorded rather than
 * used to skip this.** ADR 0015's third consequence asks two things of an echo:
 * who can see it, and is that the audience the value already has. The sink is
 * this process's own stderr; its only reader operates the Cloudgate host, and
 * the product serves it to nobody — `isPlatformContainerName` refuses the
 * platform's own containers on every container-addressed route. That
 * reader can already `cat` every file involved and holds `APP_ENCRYPTION_SECRET`
 * and every Server's SSH key. So **none of these four sites is the
 * confidentiality escalation that one was**: there the bytes' authoritative home
 * was an `encryptedText` column and the echo put them in a store the column
 * type exists to keep them out of, whereas a Traefik config has no at-rest
 * classification at all — it is plaintext on disk because Traefik has to read
 * it. Anyone re-deriving this should stop at that paragraph and not file a leak.
 *
 * **What decides each site anyway, because the decision was made per site.**
 *
 * - {@link TraefikWriterService.loadOrCreateConfig} — the *content*. Both its
 *   branches read back `dynamic/{appName}.yml`, a file Cloudgate itself writes
 *   `basicAuth.users` htpasswd entries into (`createBasicAuthMiddleware`, fed by
 *   `AppConfigService`'s bcrypt of the stored password) — and
 *   `TraefikVerifyInput.secrets` already declares those must not leave the
 *   server, cutting them out of Traefik's own error text before a message is
 *   stored or served. A second path in the same module printing that line to the
 *   journal contradicts the first.
 * - `TraefikFilesService.haveActivateRequests` — the *trigger*.
 *   `GET /settings/traefik/requests` is ADR-0013's named any-authenticated-user
 *   carve-out and its only gate is `checkServerAccess`, which returns for an
 *   absent `serverId` by design, so any signed-in member of any organization can
 *   make the instance re-print a line of its own static config into its journal
 *   on demand and without limit.
 * - `TraefikFilesService.updateLetsEncryptEmail` — the weakest, and it gets the
 *   option for consistency rather than a threat model: it reads the
 *   same `traefik.yml` as the read above, and two `parse` calls of one library
 *   disagreeing about one option in one file is worse than either answer. It is
 *   reached from `SettingsService.assignDomain`, which takes instance authority,
 *   so its author, its trigger and the journal's reader are one class of caller.
 *
 * **`parseDocument` is not an echo site, measured, and that is what bounds the
 * sweep.** It prettifies `doc.warnings` and hands them back on the document;
 * only `parse` iterates them into `log.warn`, and `parseAllDocuments` does not
 * either. So `TraefikFilesService.toggleRequests` deliberately passes nothing,
 * and adding this there would state a property the library does not have.
 *
 * **`'silent'` stays rejected on measurement** rather than on
 * documentation: it makes `parse` *return* a half-read document instead of
 * throwing. `'error'` raises the identical throw the default does — the round
 * trip is asserted either way in `test/traefik/traefik-yaml-warning-echo.spec.ts`,
 * which also holds the `parseDocument` case and falsifies its own fixtures by
 * calling the bare default on the same bytes.
 *
 * Exported and shared rather than spelled at each site for
 * {@link dynamicTraefikConfigPath}'s reason: one statement, so the four cannot
 * drift apart again the way they already did once. What makes that mechanical is
 * `test/coding-standards/yaml-parse-log-level.spec.ts`, which fails on a `parse`
 * anywhere in `src/` that inherits the default.
 */
export const TRAEFIK_YAML_PARSE_OPTIONS = { logLevel: 'error' } as const;

/** The pieces of a certificate row the writer needs to persist its files. */
export interface CertificateFiles {
  certificatePath: string;
  certificateData: string;
  privateKey: string;
  serverId?: string | null;
}

/**
 * The name every certificate's private key is written under, in its own
 * directory below {@link certificatesDirectory}.
 *
 * Exported for the one reader that must know it: the console's Traefik file
 * surface withholds this file (`settings/traefik-file.utils.ts`), and a
 * name spelled twice is a name that can be renamed once.
 */
export const CERTIFICATE_KEY_FILE = 'privkey.key';

const emptyConfig = (): FileConfig => ({ http: { routers: {}, services: {} } });

/**
 * Persists dynamic Traefik configs: local filesystem for the built-in
 * server, RemoteExecService over SSH when a serverId is given. Config
 * content itself comes from the pure generators in ./config.
 *
 * The remote branches reach a shell, so every path word they carry is worded
 * rather than interpolated (the rule is on `builders/build-strategy.ts`'s
 * `BuildStrategy`). The values reaching them are an `appName` and a
 * certificate's `certificatePath`, and the verbs they reach are `cat`, `rm -f`,
 * `rm -rf` and a `>` redirect; the double quotes the redirects already carried
 * were never enough on their own, since `$` and a backtick substitute inside
 * them too.
 *
 * Which form does the wording splits by shape: the two single commands
 * pass argv to `execRemote`, which joins them with `quote()` itself, and the two
 * `base64 -d >` writes stay strings with their own `quote()` because a redirect
 * into a file is a shell program and has no argv. The local branches hand the
 * same paths to `fs`, which is not a shell and needs none of this. A
 * certificate's fragment is `replaceOwnerOnlyFileCommand`'s `mktemp` and
 * `mv -f`, which quotes its path the same way, and its Delete is a
 * program too, since it tests for a legacy fragment on the Server.
 */
/**
 * Said by a caller writing or removing the platform host's own Traefik on
 * purpose: the console's router (`cloudgate`) and the instance-wide
 * forward-auth router, both under instance authority (ADR-0013).
 */
export const PLATFORM_OWNED = { platformOwned: true } as const;

/**
 * How a {@link TraefikWriterService.writeConfig} or
 * {@link TraefikWriterService.removeConfig} caller says whose file it is.
 */
export interface TraefikWriteOwner {
  readonly platformOwned?: true;
}

@Injectable()
export class TraefikWriterService {
  constructor(
    private readonly remoteExec: RemoteExecService,
    // Optional only so the hand-built writers in specs and in
    // `previewTeardownSteps` (which only removes) need not make one; Nest
    // always injects it, `InstanceModeModule` being global.
    @Optional() private readonly instanceMode?: InstanceMode,
  ) {}

  private configPath(appName: string, serverId?: string | null): string {
    return dynamicTraefikConfigPath(appName, serverId);
  }

  /**
   * The Application's dynamic config as the machine that serves it holds it, or
   * an empty skeleton when there is nothing there to read.
   *
   * Both branches pass {@link TRAEFIK_YAML_PARSE_OPTIONS} — see it for why a
   * `parse` of this file may not inherit the library's `logLevel`, and for the
   * measurement that the file it reads is one Cloudgate writes bcrypt htpasswd
   * entries into.
   */
  async loadOrCreateConfig(
    appName: string,
    serverId?: string | null,
  ): Promise<FileConfig> {
    const configPath = this.configPath(appName, serverId);

    if (serverId) {
      try {
        const { stdout } = await this.remoteExec.execRemote(serverId, [
          'cat',
          configPath,
        ]);
        if (!stdout) return emptyConfig();
        return (
          (parse(stdout, TRAEFIK_YAML_PARSE_OPTIONS) as FileConfig) ||
          emptyConfig()
        );
      } catch {
        return emptyConfig();
      }
    }

    if (!fs.existsSync(configPath)) return emptyConfig();
    const yamlStr = fs.readFileSync(configPath, 'utf8');
    return (
      (parse(yamlStr, TRAEFIK_YAML_PARSE_OPTIONS) as FileConfig) ||
      emptyConfig()
    );
  }

  /**
   * Writes one route file into a machine's `dynamic/`: a Server's, or the
   * platform host's when `serverId` is absent.
   *
   * **Fail-closed for the platform host on the Hosted instance (ADR-0053).**
   * A Service in a Cloud account has `serverId: null` too, so a write that
   * followed its place landed its routers in the platform host's Traefik,
   * beside the console's, where a longer `Host() && PathPrefix()` rule
   * outranks the console's own. On the Hosted instance no Service is on the
   * platform host, so the only writes there are the platform's own, and each
   * says so with {@link PLATFORM_OWNED}; any other is refused with
   * `PLATFORM_HOST_REFUSED`, whichever caller forgot to fork a cloud Service
   * away first. On a Self-hosted instance nothing changes.
   */
  async writeConfig(
    appName: string,
    config: FileConfig,
    serverId?: string | null,
    owner: TraefikWriteOwner = {},
  ): Promise<void> {
    if (!serverId && !owner.platformOwned) {
      this.instanceMode?.refusePlatformHost('services');
    }
    const configPath = this.configPath(appName, serverId);
    const yamlStr = stringify(config);

    if (serverId) {
      await this.remoteExec.execAsyncRemote(
        serverId,
        `echo "${encodeBase64(yamlStr)}" | base64 -d > ${quote([configPath])}`,
      );
      return;
    }

    fs.mkdirSync(dynamicTraefikDirectory(), { recursive: true });
    fs.writeFileSync(configPath, yamlStr, 'utf8');
  }

  /**
   * Removes one route file from a machine's `dynamic/`: a Server's, or the
   * platform host's when `serverId` is absent.
   *
   * **Fail-closed for the platform host on the Hosted instance, as
   * {@link writeConfig} is.** The file is named by whatever the caller passes,
   * and a Service in a Cloud account has `serverId: null` too, so a removal
   * that followed its place deleted the platform host's own file of that name:
   * an Application whose `appName` is `hosted` would take the Hosted
   * instance's own router file (`hosted.yml`) with it. Every caller of a
   * Service's file forks a cloud Service away first, and the platform's own
   * removals say {@link PLATFORM_OWNED}; any other is refused with
   * `PLATFORM_HOST_REFUSED`. On a Self-hosted instance nothing changes.
   */
  async removeConfig(
    appName: string,
    serverId?: string | null,
    owner: TraefikWriteOwner = {},
  ): Promise<void> {
    if (!serverId && !owner.platformOwned) {
      this.instanceMode?.refusePlatformHost('services');
    }
    const configPath = this.configPath(appName, serverId);

    if (serverId) {
      await this.remoteExec.execRemote(serverId, ['rm', '-f', configPath]);
      return;
    }

    fs.rmSync(configPath, { force: true });
  }

  /**
   * Writes the PEM pair into the certificate's own directory under the certs
   * dir, then its `tls.certificates` fragment at
   * {@link certificateConfigPath}, the top of `dynamic/`, so the fragment's
   * write is the event Traefik's watch reloads on. The order is the
   * point: the pair is in place before the rename that makes Traefik read it,
   * and an edit, whose fragment is byte-for-byte the one already there, still
   * raises a reload, at which Traefik reads the new material.
   *
   * An earlier version's {@link legacyCertificateConfigPath} is removed
   * **after** the new fragment is in place, the opposite of the gateway route's
   * order, and measured against `traefik:v3.6.7`: removed first, the
   * reload that `mktemp` creating its file in `dynamic/` raises lands between
   * the two, and the certificate is not served (Traefik's default one is) until
   * the rename's reload. Two `tls.certificates` entries naming the same pair
   * are harmless where two routers of one name are not, and the removal in the
   * subdirectory raises no reload of its own, so the duplicate simply drops out
   * at the next one.
   *
   * **All owner-only on both machines.** The key was `0644` in `0755`
   * directories, readable by the console's `cloudgate` user and every local
   * account while the row held it `enc:v1:`. Traefik reads these as root in
   * its container, so `0600` costs it nothing. The pair is `0600` in a `0700`
   * directory; an edit rewrites the files, and the helpers `chmod` what is
   * already there, so a key an earlier version wrote is corrected by the next
   * write on a Server and at boot on this host
   * (`common/files/owner-only-trees.service.ts`). The fragment holds only the
   * two paths, but it is `0600` too, renamed into place from a file created
   * `0600` (`replaceOwnerOnlyFile*`), because `dynamic/` itself stays open.
   */
  async writeCertificate(cert: CertificateFiles): Promise<void> {
    const certDir = certificateDirectory(cert.certificatePath, cert.serverId);
    const crtPath = path.join(certDir, 'chain.crt');
    const keyPath = path.join(certDir, CERTIFICATE_KEY_FILE);
    const configFile = certificateConfigPath(
      cert.certificatePath,
      cert.serverId,
    );
    const legacy = legacyCertificateConfigPath(
      cert.certificatePath,
      cert.serverId,
    );

    const config: FileConfig = {
      tls: { certificates: [{ certFile: crtPath, keyFile: keyPath }] },
    };
    const yamlConfig = stringify(config);

    if (cert.serverId) {
      const command = [
        writeOwnerOnlyFileCommand(crtPath, cert.certificateData),
        writeOwnerOnlyFileCommand(keyPath, cert.privateKey),
        replaceOwnerOnlyFileCommand(configFile, yamlConfig),
        `rm -f ${quote([legacy])}`,
      ].join(' &&\n');
      await this.remoteExec.execAsyncRemote(cert.serverId, command);
      return;
    }

    writeOwnerOnlyFileSync(crtPath, cert.certificateData);
    writeOwnerOnlyFileSync(keyPath, cert.privateKey);
    replaceOwnerOnlyFileSync(configFile, yamlConfig);
    fs.rmSync(legacy, { force: true });
  }

  /**
   * Drops a certificate's fragment, then its directory, which holds the PEM
   * pair and, for a certificate an earlier version wrote, its legacy fragment
   * too. The fragment goes first so Traefik's reload on its removal finds
   * nothing naming the pair.
   *
   * **A legacy fragment's removal raises a reload of its own.** It sits below
   * `dynamic/`, where Traefik's watch does not reach, and a certificate not
   * re-saved since the layout changed has nothing at the top to remove, so
   * Traefik kept serving it after its Delete until an unrelated reload. So when
   * the legacy fragment was there, a file is created at the top and removed
   * again, **after** the directory has gone, so the reloads both events raise
   * read a tree with nothing naming the pair. It is `mktemp`'s `0600` on a
   * Server and a `wx` `0600` create here, beside the fragment as
   * `certificate+<certificatePath>.yml.XXXXXX`, the same name
   * `replaceOwnerOnlyFile*` gives its temporary; that ends in no `.yml`, so a
   * reload that catches it in place skips it rather than parsing an empty file.
   * Only then: a certificate with no legacy fragment leaves the top of
   * `dynamic/` exactly as its own removal does.
   *
   * The Server's branch is one shell program, since the `[ -e ]` and the
   * removal have to run on that machine; every path in it is `quote()`d.
   */
  async removeCertificate(
    certificatePath: string,
    serverId?: string | null,
  ): Promise<void> {
    const certDir = certificateDirectory(certificatePath, serverId);
    const configFile = certificateConfigPath(certificatePath, serverId);
    const legacy = legacyCertificateConfigPath(certificatePath, serverId);

    if (serverId) {
      const remove = `rm -rf ${quote([configFile, certDir])}`;
      await this.remoteExec.execAsyncRemote(
        serverId,
        [
          `if [ -e ${quote([legacy])} ]; then`,
          `  ${remove} && tmp=$(mktemp ${quote([`${configFile}.XXXXXX`])}) && rm -f "$tmp"`,
          'else',
          `  ${remove}`,
          'fi',
        ].join('\n'),
      );
      return;
    }

    const hadLegacy = fs.existsSync(legacy);
    fs.rmSync(configFile, { force: true });
    fs.rmSync(certDir, { recursive: true, force: true });
    if (hadLegacy) {
      const pulse = `${configFile}.${randomBytes(6).toString('hex')}`;
      fs.writeFileSync(pulse, '', { mode: OWNER_ONLY_FILE_MODE, flag: 'wx' });
      fs.rmSync(pulse, { force: true });
    }
  }
}
