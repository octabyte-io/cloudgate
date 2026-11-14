import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';
import {
  ACCESS_LOG_ROTATION_COMMENT,
  ACCESS_LOG_ROTATION_NOTE,
} from '../../src/common/config/access-log-note';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import {
  REQUEST_METRICS_ADDRESS,
  REQUEST_METRICS_BLOCK_YAML,
  REQUEST_METRICS_ENTRYPOINT_YAML,
  carriesRequestMetrics,
} from '../../src/common/config/request-metrics';
import {
  CONTAINER_LOG_DRIVER,
  DEFAULT_CONTAINER_LOG_MAX_FILE,
  DEFAULT_CONTAINER_LOG_MAX_SIZE,
  containerLogConfig,
  containerLogRunFlags,
  serviceLogDriver,
} from '../../src/common/config/container-logs';
import {
  CLOUDGATE_NETWORK,
  serverAuditCommand,
} from '../../src/servers/server-audit';
import {
  REQUIRED_UTILITIES,
  TRAEFIK_HTTP3_PORT,
  TRAEFIK_PORT,
  TRAEFIK_SSL_PORT,
  TRAEFIK_VERSION,
  serverSetupCommand,
} from '../../src/servers/server-setup';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikFilesService } from '../../src/settings/traefik-files.service';
import * as traefikSetup from '../../src/settings/traefik-setup.service';

/**
 * `serverSetupCommand()` is pure string generation, so the shell it emits — and
 * the YAML inside that shell — is the thing to assert on. Every expectation
 * below is a line of the VPS install run's evidence turned round: what the
 * script wrote there is what these tests say it must write now.
 */
const script = () => serverSetupCommand();

/**
 * The repo root, and a reader for one committed artefact under it. Each of the
 * three `deploy/` describes below had grown its own copy of these two lines;
 * there is one copy now.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const read = (relative: string) =>
  fs.readFileSync(path.join(repoRoot, relative), 'utf8');

/** `deploy/install.sh`, read fresh — both describes under it assert on it. */
const installer = () => read('deploy/install.sh');

/** The body of a quoted heredoc, by its delimiter. */
function heredoc(delimiter: string): string {
  const body = script().match(
    new RegExp(`<<'${delimiter}'\\n([\\s\\S]*?)\\n${delimiter}\\n`),
  );
  if (!body) throw new Error(`no ${delimiter} heredoc in the setup script`);
  return body[1];
}

interface StaticConfig {
  providers?: { file?: { directory?: string } };
  entryPoints?: Record<string, { address?: string }>;
  certificatesResolvers?: {
    letsencrypt?: {
      acme?: {
        email?: string;
        storage?: string;
        httpChallenge?: { entryPoint?: string };
      };
    };
  };
  log?: { level?: string; filePath?: string };
  metrics?: { prometheus?: Record<string, unknown> };
  accessLog?: { filePath?: string; format?: string; bufferingSize?: number };
}

/**
 * The request-metrics half of a static config, which every writer must emit
 * identically (ADR-0027): the entryPoint and `metrics` block, nothing else.
 */
const requestMetricsOf = (config: StaticConfig) => ({
  entryPoint: config.entryPoints?.metrics,
  metrics: config.metrics,
});

/** What {@link requestMetricsOf} must read on every writer, written out. */
const LOOPBACK_REQUEST_METRICS = {
  entryPoint: { address: '127.0.0.1:8082' },
  metrics: {
    prometheus: {
      entryPoint: 'metrics',
      addServicesLabels: true,
      addRoutersLabels: false,
    },
  },
};

interface MiddlewareConfig {
  http?: {
    middlewares?: Record<
      string,
      { redirectScheme?: { scheme?: string; permanent?: boolean } }
    >;
  };
}

const staticConfig = () => parse(heredoc('TRAEFIK_EOF')) as StaticConfig;
const middlewares = () => parse(heredoc('MIDDLEWARES_EOF')) as MiddlewareConfig;

// `serverSetupCommand()` is the unit; the five groups below are five
// behaviour groups over the one script it returns (§1.7).
describe('serverSetupCommand', () => {
  describe('the Traefik static config the setup script writes', () => {
    it('still declares the providers and entry points it always did', () => {
      const config = staticConfig();

      expect(config.providers?.file?.directory).toBe(
        `${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic`,
      );
      expect(config.entryPoints?.web?.address).toBe(`:${TRAEFIK_PORT}`);
      expect(config.entryPoints?.websecure?.address).toBe(
        `:${TRAEFIK_SSL_PORT}`,
      );
    });

    // Every generator emits `tls: { certResolver: 'letsencrypt' }`, and no
    // resolver by that name existed. Traefik does not refuse such a router — it
    // serves the app under a self-signed certificate, so the only statement of
    // the cause was one line in a container log.
    it('defines the letsencrypt resolver the domain generators name', () => {
      const acme = staticConfig().certificatesResolvers?.letsencrypt?.acme;

      expect(acme).toBeDefined();
      expect(acme?.httpChallenge?.entryPoint).toBe('web');
    });

    // The ACME account has to survive TraefikSetupService recreating the
    // container, and only the dynamic directory is bind-mounted into it.
    it('stores the ACME account inside the mounted dynamic directory', () => {
      expect(
        staticConfig().certificatesResolvers?.letsencrypt?.acme?.storage,
      ).toBe(`${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic/acme.json`);
    });

    // updateLetsEncryptEmail patches this key and throws when it is absent, so a
    // placeholder is not cosmetic. Let's Encrypt refuses @example.com outright.
    it('seeds an ACME contact address that Let’s Encrypt will accept', () => {
      const email =
        staticConfig().certificatesResolvers?.letsencrypt?.acme?.email;

      expect(email).toMatch(/^[^@\s]+@[^@\s]+$/);
      expect(email).not.toMatch(/example\.com$/);
    });

    // Traefik 3 defaults its own log to ERROR, so a healthy instance was
    // silent and `docker logs cloudgate-traefik` was 0 bytes since install — "no
    // ACME attempt" and "the attempt succeeded" were the same observation.
    it('turns Traefik’s own log up to the level an ACME attempt is visible at', () => {
      expect(staticConfig().log?.level).toBe('INFO');
    });

    // Stdout, not a file: `docker logs` is the interface the access-log fix assumes,
    // Docker's driver owns retention (capped), and a filePath under
    // dynamic/ would land in the directory the file provider watches.
    it('leaves that log on stdout rather than handing Cloudgate a second file to rotate', () => {
      expect(staticConfig().log?.filePath).toBeUndefined();
    });

    // ADR-0027: nothing on a remote Server reads its access log any more — the
    // request-analytics reader is the platform host's alone — so a new Server
    // is provisioned without one rather than writing ~800 B per request to a
    // file nobody reads or rotates.
    it('provisions a new Server with its access log off', () => {
      expect(staticConfig().accessLog).toBeUndefined();
      expect(heredoc('TRAEFIK_EOF')).not.toContain('accessLog');
      expect(heredoc('TRAEFIK_EOF')).not.toContain(ACCESS_LOG_ROTATION_COMMENT);
    });

    // ADR-0027: a new Server keeps request counters from the start, on a
    // dedicated entryPoint bound to loopback inside the Traefik container.
    it('keeps request metrics on a loopback-only metrics entryPoint', () => {
      expect(requestMetricsOf(staticConfig())).toEqual(
        LOOPBACK_REQUEST_METRICS,
      );
      expect(carriesRequestMetrics(heredoc('TRAEFIK_EOF'))).toBe(true);
    });

    // Loopback is a tenant-isolation requirement: on the dashboard's `traefik`
    // entryPoint (or any published one) every container on the network could
    // read every Service's counters.
    it('never puts request metrics on the dashboard or a published entryPoint', () => {
      const config = staticConfig();

      expect(config.entryPoints?.traefik).toBeUndefined();
      expect(config.metrics?.prometheus?.entryPoint).not.toBe('traefik');
      expect(config.entryPoints?.metrics?.address).toBe(
        REQUEST_METRICS_ADDRESS,
      );
      expect(config.entryPoints?.metrics?.address).toMatch(/^127\.0\.0\.1:/);
    });

    it('writes the file only when it is not already there', () => {
      expect(script()).toContain(
        `if [ -f "${REMOTE_CLOUDGATE_DIRECTORY}/traefik/traefik.yml" ]; then`,
      );
    });
  });

  // Three generators attach `redirect-to-https` to the `web` router of every
  // HTTPS domain and nothing defined it, so Traefik dropped the router and plain
  // HTTP answered 404 instead of redirecting.
  describe('the redirect-to-https middleware', () => {
    it('is defined as a permanent redirectScheme to https', () => {
      expect(middlewares().http?.middlewares?.['redirect-to-https']).toEqual({
        redirectScheme: { scheme: 'https', permanent: true },
      });
    });

    it('goes in its own watched dynamic file, guarded on its own', () => {
      expect(script()).toContain(
        `${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic/middlewares.yml`,
      );
      expect(script()).toContain(
        `if [ -f "${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic/middlewares.yml" ]; then`,
      );
    });
  });

  // `docker network ls | grep -q` matched cloudgate-network-old, and a
  // container name in another column. Traefik then came up unattached.
  describe('the overlay network guard', () => {
    it('asks for the network by exact name', () => {
      expect(script()).toContain(
        `docker network inspect ${CLOUDGATE_NETWORK} >/dev/null 2>&1`,
      );
    });

    it('no longer matches the network listing by substring', () => {
      expect(script()).not.toContain(
        `docker network ls | grep -q '${CLOUDGATE_NETWORK}'`,
      );
    });

    // The readiness probe asked the same question the same wrong way, and its
    // answer is what the console shows as "cloudgate-network is present" — so a
    // false positive there is the reading that rules the network out as the cause.
    it('is the same question the readiness probe asks', () => {
      expect(serverAuditCommand()).toContain(
        `docker network inspect ${CLOUDGATE_NETWORK} >/dev/null 2>&1`,
      );
      expect(serverAuditCommand()).not.toContain(
        `docker network ls | grep -q '${CLOUDGATE_NETWORK}'`,
      );
    });
  });

  // A new Server's Traefik is on `cloudgate-ai` from setup, so its
  // first AI model needs no join; it is connected, never recreated.
  describe('the AI model network', () => {
    it('creates cloudgate-ai as an attachable overlay when it is missing', () => {
      expect(script()).toContain(
        '$SUDO_CMD docker network inspect cloudgate-ai >/dev/null 2>&1',
      );
      expect(script()).toContain(
        '$SUDO_CMD docker network create --driver overlay --attachable cloudgate-ai',
      );
      expect(script()).not.toContain('--internal');
    });

    it('joins Traefik to it after Traefik is set up', () => {
      const traefik = script().indexOf('Setting up Traefik');
      const join = script().indexOf(
        '$SUDO_CMD docker network connect cloudgate-ai cloudgate-traefik',
      );
      expect(traefik).toBeGreaterThan(-1);
      expect(join).toBeGreaterThan(traefik);
    });
  });

  // Step 1 was the only unguarded step, so "running it again is safe" was
  // false — every re-run refreshed the apt index and could upgrade curl, git and
  // openssl on a production Server, silently.
  describe('the required-packages step', () => {
    it('checks for every required binary before it touches apt', () => {
      expect(script()).toContain(
        'for binary in unzip curl wget git jq openssl rclone; do',
      );
      expect(script()).toContain('command_exists "$binary"');
      expect(script()).toContain('command_exists() {');
    });

    // Every backup, prune and restore of a Service on a Server runs rclone on
    // that Server, and nothing installed it there.
    it('installs rclone, which backups run on the Server', () => {
      expect(REQUIRED_UTILITIES).toContain('rclone');
    });

    it('says it found them rather than printing nothing', () => {
      expect(script()).toContain('Required packages are installed ✅');
    });

    it('hands apt only the missing packages, on the branch where something is missing', () => {
      const step = script().match(
        /if \[ -z "\$MISSING_PACKAGES" \][\s\S]*?\n {4}fi\n/,
      )?.[0];

      expect(step).toBeDefined();
      expect(step).toContain('apt-get update -y');
      expect(step).toContain('apt-get install -y $MISSING_PACKAGES');
      expect(step).not.toContain('apt-get install -y unzip');
    });
  });

  describe('a non-root sudo user', () => {
    // Every later command runs plain `docker` as the SSH user.
    it('is added to the docker group', () => {
      expect(script()).toContain(
        '$SUDO_CMD usermod -aG docker "$CURRENT_USER"',
      );
    });

    it('is only added when the script runs through sudo', () => {
      const step = script().match(
        /if \[ -n "\$SUDO_CMD" \]; then\n {4}if id -nG[\s\S]*?\n {2}fi\n/,
      )?.[0];
      expect(step).toBeDefined();
      expect(step).toContain("tr ' ' '\\n' | grep -qx docker");
    });
  });

  // Registering a Server installed 3.5.0 and published 80/443; anything that
  // later went through writeTraefikSetup recreated the same container at 3.6.7
  // with 443/udp as well. Two definitions of one container.
  describe('the Traefik container', () => {
    it('is pinned by the same constant the settings path uses', () => {
      expect(traefikSetup.TRAEFIK_VERSION).toBe(TRAEFIK_VERSION);
      expect(traefikSetup.TRAEFIK_PORT).toBe(TRAEFIK_PORT);
      expect(traefikSetup.TRAEFIK_SSL_PORT).toBe(TRAEFIK_SSL_PORT);
      expect(traefikSetup.TRAEFIK_HTTP3_PORT).toBe(TRAEFIK_HTTP3_PORT);
    });

    it('defaults to the version the runtime path already defaulted to', () => {
      expect(TRAEFIK_VERSION).toBe('3.6.7');
      expect(script()).toContain(`traefik:v${TRAEFIK_VERSION}`);
    });

    it('publishes the HTTP/3 UDP port the settings path publishes', () => {
      expect(script()).toContain(
        `-p ${TRAEFIK_HTTP3_PORT}:${TRAEFIK_HTTP3_PORT}/udp`,
      );
      expect(script()).toContain(`-p ${TRAEFIK_SSL_PORT}:${TRAEFIK_SSL_PORT} `);
      expect(script()).toContain(`-p ${TRAEFIK_PORT}:${TRAEFIK_PORT} `);
    });

    // Nothing set a LogConfig anywhere, so Traefik ran on the stock
    // json-file driver with no max-size and no max-file. The access log makes that log
    // chatty, and an ACME retry loop then writes until the Server's disk is full.
    it('bounds the access log once it is turned on, rather than letting it fill the disk', () => {
      expect(script()).toContain(`--log-driver ${CONTAINER_LOG_DRIVER}`);
      expect(script()).toContain(
        `--log-opt max-size=${DEFAULT_CONTAINER_LOG_MAX_SIZE}`,
      );
      expect(script()).toContain(
        `--log-opt max-file=${DEFAULT_CONTAINER_LOG_MAX_FILE}`,
      );
    });

    it('keeps the driver stock, so docker logs still reads it', () => {
      // The cap must not break the interface the access-log fix depends on, and
      // only json-file is what a bare `docker logs` reads directly.
      expect(containerLogConfig().Type).toBe('json-file');
    });

    it('takes both halves of the ceiling from the environment', () => {
      const flags = containerLogRunFlags({
        CONTAINER_LOG_MAX_SIZE: '256k',
        CONTAINER_LOG_MAX_FILE: '9',
      });

      expect(flags).toContain('--log-opt max-size=256k');
      expect(flags).toContain('--log-opt max-file=9');
    });

    // Swarm spells the same two options Name/Options where a container spells
    // them Type/Config, which is one shape too many to write out twice.
    it('caps a Swarm service with the same numbers as a container', () => {
      expect(serviceLogDriver().Options).toEqual(containerLogConfig().Config);
    });
  });
});

// No export to name: the unit under test is the committed artefact, and its
// path is what a reader has to open (§1.7). Do not “fix” this to a camelCase
// name that nothing exports.
describe('deploy/install.sh', () => {
  // The two files the setup script writes are also written by two other things:
  // deploy/install.sh, which stands up the host this project actually ships on,
  // and the committed examples under deploy/traefik/. All three writers guard on
  // the file already existing, so whichever runs first wins and the rest are
  // skipped — which makes any disagreement between them invisible until a domain
  // misbehaves on a host nobody can reproduce. Nothing in a shell script can pin
  // itself, so it gets pinned from here.
  describe('the deploy artefacts that write the same two files', () => {
    /**
     * An example file is its header — `#` comments, terminated by the one blank
     * line in it — followed by the config itself. Everything after that blank
     * line is the part that has to match byte for byte.
     */
    const exampleBody = (relative: string) => {
      const text = read(relative);
      const split = text.indexOf('\n\n');
      if (split < 0) throw new Error(`${relative} has no header/body split`);
      return text.slice(split + 2);
    };

    /**
     * install.sh writes the same bytes through `$CLOUDGATE_DIR`, which it pins to
     * REMOTE_CLOUDGATE_DIRECTORY at the top of the script. Substituting it back is
     * what makes the comparison a comparison of content rather than of spelling —
     * and the assertion below that the two agree on the value is what makes the
     * substitution honest.
     */
    const installScript = () =>
      installer().split('${CLOUDGATE_DIR}').join(REMOTE_CLOUDGATE_DIRECTORY);

    it('installs into the directory the setup script provisions', () => {
      expect(installer()).toContain(
        `CLOUDGATE_DIR=${REMOTE_CLOUDGATE_DIRECTORY}\n`,
      );
    });

    /**
     * The platform host's traefik.yml is a remote Server's plus this, appended
     * last: the host keeps its access log and its rotation (ADR-0013's reader
     * is untouched), a remote Server is provisioned without one (ADR-0027).
     */
    const platformAccessLogTail = [
      ACCESS_LOG_ROTATION_COMMENT,
      'accessLog:',
      `  filePath: ${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic/access.log`,
      '  format: json',
      '  bufferingSize: 100',
    ].join('\n');

    /** install.sh's traefik.yml heredoc body, with `$CLOUDGATE_DIR` filled in. */
    const installedStaticConfig = () => {
      const body = installScript().match(
        /cat > "\$CLOUDGATE_DIR\/traefik\/traefik\.yml" <<EOF\n([\s\S]*?)\nEOF\n/,
      )?.[1];
      if (!body) throw new Error('no traefik.yml heredoc in install.sh');
      return `${body}\n`;
    };

    it('ships an example static config that is the generated one plus the platform host’s access log', () => {
      expect(exampleBody('deploy/traefik/traefik.yml.example')).toBe(
        `${heredoc('TRAEFIK_EOF')}\n${platformAccessLogTail}\n`,
      );
    });

    it('ships an example middlewares file byte-identical to the generated one', () => {
      expect(
        exampleBody('deploy/traefik/dynamic/middlewares.yml.example'),
      ).toBe(`${heredoc('MIDDLEWARES_EOF')}\n`);
    });

    // Three defects were fixed in the generator first; install.sh writes its
    // own copy of both files and did not get them, so the install this project
    // ships still 404'd on plain HTTP, still had no resolver and still logged no
    // requests.
    it('writes the same static config from install.sh as the example ships', () => {
      expect(installedStaticConfig()).toBe(
        exampleBody('deploy/traefik/traefik.yml.example'),
      );
    });

    // ADR-0027: all three writers emit the one loopback entryPoint and the one
    // `metrics` block, parsed and as text, so none of them can drift onto the
    // dashboard entryPoint or a published address on its own.
    it('emits the same loopback request-metrics block from all three writers', () => {
      const writers = {
        'server-setup.ts': heredoc('TRAEFIK_EOF'),
        'install.sh': installedStaticConfig(),
        'traefik.yml.example': exampleBody(
          'deploy/traefik/traefik.yml.example',
        ),
      };
      for (const [writer, yaml] of Object.entries(writers)) {
        expect({
          writer,
          ...requestMetricsOf(parse(yaml) as StaticConfig),
        }).toEqual({ writer, ...LOOPBACK_REQUEST_METRICS });
        expect({ writer, carries: carriesRequestMetrics(yaml) }).toEqual({
          writer,
          carries: true,
        });
        expect(yaml).toContain(`${REQUEST_METRICS_ENTRYPOINT_YAML}\n`);
        expect(yaml).toContain(REQUEST_METRICS_BLOCK_YAML);
      }
    });

    // The platform host keeps what ADR-0013's reader reads.
    it('keeps the platform host’s access log on in install.sh', () => {
      const config = parse(installedStaticConfig()) as StaticConfig;
      expect(config.accessLog).toEqual({
        filePath: `${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic/access.log`,
        format: 'json',
        bufferingSize: 100,
      });
    });

    /**
     * The toggle wrote its own, longer note above `accessLog:`, so turning
     * request logging off and on again rewrote the file the installer wrote —
     * 1247 → 880 → 1740 bytes — and an operator comparing it with a fresh
     * install saw two versions of the same comment. The toggle is driven for
     * real, over the installer's own bytes, because what has to hold is the
     * file on disk and not any one string inside it.
     */
    it('leaves the installer’s traefik.yml byte-identical after request logging goes off and on', async () => {
      const installed = installedStaticConfig();

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i470-'));
      try {
        const file = path.join(dir, 'traefik.yml');
        fs.writeFileSync(file, installed);
        // The platform-host branch touches no remote machine, so nothing is
        // stubbed beyond the constructor's slot for one.
        const traefikFiles = new TraefikFilesService(
          {} as RemoteExecService,
          () => dir,
        );

        await traefikFiles.toggleRequests(false);
        // The off half is the one that must actually change the file, or the
        // on half below would be comparing the installer's bytes to themselves.
        expect(fs.readFileSync(file, 'utf8')).not.toContain('accessLog:');

        await traefikFiles.toggleRequests(true);
        expect(fs.readFileSync(file, 'utf8')).toBe(installed);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // The pin proper: install.sh is shell and cannot import the note, so it
    // is held to it from here. The heredoc comparison above implies this; this
    // names the note, so a divergence fails on the note rather than on 30 lines
    // of YAML.
    it('writes the toggle’s access-log note from install.sh', () => {
      expect(installScript()).toContain(
        `${ACCESS_LOG_ROTATION_COMMENT}\naccessLog:\n`,
      );
    });

    it('renders the toggle’s note as the comment the installer writes', () => {
      expect(
        ACCESS_LOG_ROTATION_NOTE.split('\n')
          .map((line) => `#${line}`)
          .join('\n'),
      ).toBe(ACCESS_LOG_ROTATION_COMMENT);
    });

    it('writes the same middlewares file from install.sh', () => {
      expect(installScript()).toContain(heredoc('MIDDLEWARES_EOF'));
    });

    // Its own guard, in the installer too: a host installed before middlewares.yml
    // existed has a traefik.yml already, so a guard shared with that file would
    // skip the repair a re-run is supposed to make.
    it('guards each file on its own existence, as the setup script does', () => {
      const script = installScript();

      expect(script).toContain(
        `if [ ! -f "$CLOUDGATE_DIR/traefik/traefik.yml" ]; then`,
      );
      expect(script).toContain(
        `if [ ! -f "$CLOUDGATE_DIR/traefik/dynamic/middlewares.yml" ]; then`,
      );
    });

    // An earlier fix left one constant with one default, and install.sh reaches it by
    // exporting TRAEFIK_VERSION into the backend's environment file.
    it('pins the same Traefik version and passes it to the backend', () => {
      const script = installer();

      expect(script).toContain(`TRAEFIK_VERSION:-${TRAEFIK_VERSION}}`);
      expect(script).toContain('TRAEFIK_VERSION=${TRAEFIK_VERSION}');
    });

    // The same trick for the log ceiling. The installer starts Traefik
    // itself, so its defaults and the backend's have to be the same two values —
    // and it writes them into the env file so a container the backend creates
    // later carries the ceiling the installer's Traefik already has.
    it('caps the installer’s own Traefik at the ceiling the backend defaults to', () => {
      const script = installer();

      expect(script).toContain(
        `CONTAINER_LOG_MAX_SIZE:-${DEFAULT_CONTAINER_LOG_MAX_SIZE}}`,
      );
      expect(script).toContain(
        `CONTAINER_LOG_MAX_FILE:-${DEFAULT_CONTAINER_LOG_MAX_FILE}}`,
      );
      expect(script).toContain(`--log-driver ${CONTAINER_LOG_DRIVER}`);
      expect(script).toContain(
        '--log-opt "max-size=${CONTAINER_LOG_MAX_SIZE}"',
      );
      expect(script).toContain(
        '--log-opt "max-file=${CONTAINER_LOG_MAX_FILE}"',
      );
      expect(script).toContain(
        'CONTAINER_LOG_MAX_SIZE=${CONTAINER_LOG_MAX_SIZE}',
      );
      expect(script).toContain(
        'CONTAINER_LOG_MAX_FILE=${CONTAINER_LOG_MAX_FILE}',
      );
    });

    /**
     * The same three-way agreement, for the key that decides whether a
     * recorded address can be chosen by the caller.
     *
     * `TRUST_PROXY` has three writers now — `env.schema.ts` validates it, the
     * installer writes the env file a real host boots from, and
     * `deploy/env/cloudgate-backend.example` is what anyone configuring by hand
     * copies. The installer is the one that cannot pin itself, and it is also the
     * one whose omission would be invisible: a missing key parses as unset, unset
     * is the safe value, and the file would simply have drifted from the template
     * with nothing failing. `loopback` in both — the console's
     * rewrites are a server-side proxy, so the console *is* a hop in front of the
     * backend, and it forwards the browser's address across it.
     */
    it('writes the same loopback TRUST_PROXY the env template ships', () => {
      expect(installer()).toContain('\nTRUST_PROXY=loopback\n');
      expect(read('deploy/env/cloudgate-backend.example')).toContain(
        '\nTRUST_PROXY=loopback\n',
      );
    });

    /**
     * The bundled proxy's other half, and the one that fails silently: rewrite destinations
     * are resolved from `next.config.ts` into the routes manifest at BUILD time,
     * so exporting the internal origin into the runtime env file alone leaves the
     * built console proxying to the public origin — a console that works, and
     * records the wrong address on every session.
     *
     * The build is the Cloudgate version's now (ADR-0082), made once by
     * `deploy/version-tarball.sh` for port 4000, so the installer writes the
     * same origin into the runtime file and refuses any other API_PORT.
     */
    it('gives the console the internal origin its version was built with, at runtime too', () => {
      const script = installer();

      expect(script).toContain(
        'BACKEND_INTERNAL_ORIGIN=http://127.0.0.1:${API_PORT}',
      );
      expect(script).toContain('if [ "$API_PORT" != 4000 ]; then');
      expect(read('deploy/version-tarball.sh')).toContain(
        '\nBACKEND_INTERNAL_ORIGIN=http://127.0.0.1:4000\n',
      );
    });

    /**
     * The console reads the API's public address when it starts (ADR-0082):
     * one build serves any address, so the env file carries it under the
     * name the backend already advertises, and nothing greps a built bundle
     * for an address that is no longer in it.
     */
    it('gives the console its API address at runtime as CLOUDGATE_API_URL, and checks no bundle for it', () => {
      const script = installer();
      const consoleEnv = script.match(
        /cat > \/etc\/default\/cloudgate-console <<EOF\n([\s\S]*?)\nEOF\n/,
      )?.[1];

      expect(consoleEnv).toContain('\nCLOUDGATE_API_URL=${API_ORIGIN}\n');
      expect(script).not.toContain('NEXT_PUBLIC_API_URL');
      expect(script).not.toContain("grep -rq 'localhost:4000'");
    });

    it('documents the same console env file in deploy/env/cloudgate-console.example', () => {
      const example = read('deploy/env/cloudgate-console.example');

      expect(example).toContain(
        '\nCLOUDGATE_API_URL=http://<public-host>:4000\n',
      );
      expect(example).not.toContain('NEXT_PUBLIC_API_URL');
    });

    /**
     * `next start` cannot forward the browser's address on a rewrite, so the unit
     * has to run the custom server that can. Pinned because reverting the
     * ExecStart is a one-word edit that leaves everything else looking right.
     */
    it('starts the console through the server that forwards the browser', () => {
      expect(read('deploy/systemd/cloudgate-console.service')).toContain(
        'ExecStart=/usr/local/bin/node /opt/cloudgate/frontend/server.mjs',
      );
    });

    // ssh-keygen makes no parent for an explicit -f path, and this script
    // created only traefik/dynamic — so the platform host's own shell closed 4502
    // on every stock install. Mode and owner matter: F-04 means anything readable
    // under this tree is readable by any authenticated caller.
    it('creates the key directory the platform host’s own shell needs', () => {
      expect(installer()).toContain(
        'install -d -m 700 -o root -g root "$CLOUDGATE_DIR/ssh"',
      );
    });

    // The store was /root/cloudgate-live-test/env, a verification run's
    // scratch path, and each secret is written only if absent — so a teardown that
    // left that directory alone handed the "fresh" install the previous instance's
    // PGPW, APP_ENCRYPTION_SECRET and BETTER_AUTH_SECRET.
    it('keeps the generated secrets in a path that dies with the instance', () => {
      const script = installer();

      expect(script).toContain('SECRETS_FILE=/etc/default/cloudgate-secrets\n');
      expect(script).toContain(
        'LEGACY_SECRETS_FILE=/root/cloudgate-live-test/env\n',
      );
      // The scratch path is free to appear in the prose that explains why it is
      // gone; what must never come back is a *second* assignment of it, which is
      // the only shape in which it is a live store again.
      expect(
        script.match(/^[A-Z_]*=\/root\/cloudgate-live-test.*$/gm) ?? [],
      ).toEqual(['LEGACY_SECRETS_FILE=/root/cloudgate-live-test/env']);
    });

    // The same block used to `. "$SECRETS_FILE"` twice, executing an arbitrary
    // file as root after every input at the top of the script was already set.
    it('reads secrets by name rather than sourcing the file', () => {
      const script = installer();

      expect(script).not.toMatch(/^\s*\.\s+"\$SECRETS_FILE"/m);
      expect(script).toContain('read_secret() {');
      for (const key of [
        'PGPW',
        'APP_ENCRYPTION_SECRET',
        'BETTER_AUTH_SECRET',
      ]) {
        expect(script).toContain(`"$(read_secret ${key})"`);
      }
    });

    /**
     * The body of one of install.sh's `cat > <path> <<EOF` heredocs. Unquoted, and
     * it has to be — nine of the backend file's values are interpolated — so the
     * body is a shell context running as root, and anything in it that bash
     * expands is executed at install time.
     */
    const envHeredoc = (target: string) => {
      const body = installer().match(
        new RegExp(`cat > ${target} <<EOF\\n([\\s\\S]*?)\\nEOF\\n`),
      );
      if (!body) throw new Error(`no ${target} heredoc in install.sh`);
      return body[1];
    };

    // An unescaped `true` in the TRUST_PROXY comment ran as a command and
    // was replaced by its empty output, so the installed file's guidance read
    // "never to ." — the forbidden value deleted from the line forbidding it.
    it.each([
      '/etc/default/cloudgate-backend',
      '/etc/default/cloudgate-console',
    ])('writes %s without running anything on the way', (target) => {
      const body = envHeredoc(target);

      expect(body).not.toMatch(/(^|[^\\])`/);
      expect(body).not.toContain('$(');
    });

    // And the guidance itself, since the escape is what keeps it: the value this
    // line forbids is the one the substitution deleted.
    it('keeps the value TRUST_PROXY must never be set to', () => {
      expect(envHeredoc('/etc/default/cloudgate-backend')).toContain(
        'never to \\`true\\`.',
      );
    });
  });

  // The installer twin of the generator's guard. The Packages step was guarded by
  // nothing, so `apt-get install` ran on every invocation and upgraded an already-installed
  // package against the freshly refreshed index — curl 8.5.0-2ubuntu10.11 → .12 on
  // a production host — while line 17 of the script promised a no-op and
  // docs/deploy.md §7 presents re-running it as the upgrade path.
  describe('the installer’s package steps', () => {
    /** The body of `ensure_packages`, from its `() {` to the closing `}`. */
    const guard = () =>
      installer().match(/ensure_packages\(\) \{\n([\s\S]*?)\n\}\n/)?.[1];

    it('hands apt nothing except from inside the guard', () => {
      const helper = guard();

      expect(helper).toBeDefined();
      for (const line of installer().split('\n')) {
        if (!/^\s*apt-get /.test(line)) continue;
        expect(helper).toContain(line.trim());
      }
    });

    // dpkg-query and not the command_exists shape the generator used: ca-certificates ships
    // no binary.
    it('asks dpkg which packages are installed, exactly', () => {
      expect(guard()).toContain("dpkg-query -W -f='${db:Status-Status}\\n'");
      expect(guard()).toContain('grep -qx installed');
    });

    it('says it found them rather than printing nothing', () => {
      expect(guard()).toContain('Required packages are installed ✅');
    });

    it('installs only the subset that is missing', () => {
      expect(guard()).toContain('apt_get install -y -qq $missing');
    });

    it('routes both apt-using steps through the guard', () => {
      const script = installer();

      expect(script).toContain(
        'ensure_packages \\\n  ca-certificates curl wget git jq openssl unzip rclone',
      );
      expect(script).toContain('ensure_packages postgresql');
    });

    // The claim the defect broke, and the reason it is a defect rather than a
    // documented quirk.
    it('can say it is idempotent again', () => {
      expect(installer()).toContain(
        'Idempotent: every step is guarded and re-running is a no-op.',
      );
    });
  });
});

describe('deploy/systemd', () => {
  // An earlier fix changed `Requires=postgresql.service docker.service` to
  // `Wants=`, so that stopping Postgres or restarting Docker degrades the API
  // rather than stopping it — and a second fix closed the other, independent
  // mechanism, the unhandled pool `error` event that exited the process. Two
  // paths to the same outage, two fixes, and neither of them expressible as a
  // unit test: a unit file cannot be exercised from here. It can be pinned, which
  // is what the describe above does for the other artefact under deploy/ that
  // cannot pin itself.
  //
  // The `After=` and console assertions matter more than the `Wants=` one. That fix's
  // entire argument for the change was that boot ordering is untouched, so a later
  // tidy-up of line 4 would take the boot guarantee away with nothing failing; and
  // the consistency claim it rested on — that the console unit never had a
  // `Requires=` either — is prose in a comment unless something reads the file.
  describe('the systemd units the installer ships', () => {
    const unitFile = (name: string) => read(`deploy/systemd/${name}.service`);

    const unit = () => unitFile('cloudgate-backend');
    const consoleUnit = () => unitFile('cloudgate-console');

    it('wants Postgres and Docker rather than requiring them', () => {
      expect(unit()).toContain('\nWants=postgresql.service docker.service\n');
    });

    // Anchored and multiline on purpose: the comment that explains the keyword
    // says the word `Requires=` three times, so an unanchored substring match
    // would fail on the very file it is meant to pass.
    it('requires nothing, so no stop propagates to the API', () => {
      expect(unit()).not.toMatch(/^Requires=/m);
    });

    it('still orders itself after both, which is what `After=` buys', () => {
      expect(unit()).toContain(
        '\nAfter=network-online.target postgresql.service docker.service\n',
      );
    });

    it('keeps the console unit free of `Requires=`, as the Wants= change assumed', () => {
      expect(consoleUnit()).not.toMatch(/^Requires=/m);
      expect(consoleUnit()).toContain(
        '\nAfter=network-online.target cloudgate-backend.service\n',
      );
    });

    // The comment that explains the keyword named the one command that
    // demonstrates nothing on this platform — the instance unit is PartOf the
    // meta unit, so stopping it reaches no dependent of the meta unit. The
    // platform detail lives in docs/deploy.md §10; the unit names only the two
    // commands that work, and this is what keeps the wrong one out.
    it('does not name the command that propagates nothing', () => {
      expect(unit()).not.toContain('postgresql@16-main');
    });
  });
});
