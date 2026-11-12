import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { quote } from 'shell-quote';
import { parse } from 'yaml';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  CERTIFICATE_KEY_FILE,
  certificateConfigPath,
  dynamicTraefikDirectory,
  legacyCertificateConfigPath,
  TraefikWriterService,
} from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';

/**
 * Whether the legacy fragment still existed at the moment the platform host's
 * new fragment was renamed into place (`replaceOwnerOnlyFileSync`), which is
 * what a reload raised by that rename reads.
 */
const mockWatch: { legacy: string; legacyAtRename: boolean[] } = {
  legacy: '',
  legacyAtRename: [],
};
jest.mock('../../src/common/files/owner-only', () => {
  const actual = jest.requireActual<
    typeof import('../../src/common/files/owner-only')
  >('../../src/common/files/owner-only');
  return {
    ...actual,
    replaceOwnerOnlyFileSync: (
      ...args: Parameters<typeof actual.replaceOwnerOnlyFileSync>
    ) => {
      if (mockWatch.legacy) {
        mockWatch.legacyAtRename.push(
          jest
            .requireActual<typeof import('node:fs')>('node:fs')
            .existsSync(mockWatch.legacy),
        );
      }
      return actual.replaceOwnerOnlyFileSync(...args);
    },
  };
});

/**
 * Where a custom certificate's `tls.certificates` fragment lands: at the
 * top of `dynamic/`, the one level `traefik:v3.6.7`'s file provider watches, so
 * the save is itself what reloads Traefik. It was
 * `dynamic/certificates/<certificatePath>/certificate.yml`, which Traefik loaded
 * only when something else raised a reload; the PEM pair stays in that
 * directory, and a certificate an earlier version wrote there is moved by its
 * next save and removed whole by its Delete.
 *
 * Real filesystem on both machines, as `certificate-file-modes.spec.ts` does:
 * the Server's branch runs the program it would send over SSH under `sh`, with
 * the Server's root rewritten to a temporary one.
 */
describe('TraefikWriterService certificate layout', () => {
  const cert = {
    certificatePath: 'certificate-layout',
    certificateData:
      '-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----\n',
    privateKey: '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n',
  };

  let root: string;
  let previousRoot: string | undefined;
  /** Every program the writer handed the transport, in order. */
  let programs: string[];

  const modeOf = (file: string) => fs.statSync(file).mode & 0o777;

  const remoteExec = withArgvExec({
    execAsyncRemote: jest.fn((_serverId: string, command: string) => {
      programs.push(command);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    }),
  }) as unknown as RemoteExecService;

  /** Runs what the writer sent a Server, against the temporary root. */
  const runOnServer = () => {
    for (const program of programs.splice(0)) {
      const run = spawnSync(
        'sh',
        ['-c', program.split(REMOTE_CLOUDGATE_DIRECTORY).join(root)],
        { encoding: 'utf8' },
      );
      expect([run.status, run.stderr]).toEqual([0, '']);
    }
  };

  /** A path on `serverId`'s machine, as it sits under the temporary root. */
  const onDisk = (file: string, serverId: string | null) =>
    serverId ? file.split(REMOTE_CLOUDGATE_DIRECTORY).join(root) : file;

  /** What an earlier version left: the fragment inside the certificate's own directory. */
  const leaveLegacyCertificate = (serverId: string | null) => {
    const legacy = onDisk(
      legacyCertificateConfigPath(cert.certificatePath, serverId),
      serverId,
    );
    fs.mkdirSync(path.dirname(legacy), { recursive: true, mode: 0o700 });
    fs.writeFileSync(legacy, 'tls: {}\n', { mode: 0o600 });
    fs.writeFileSync(
      path.join(path.dirname(legacy), CERTIFICATE_KEY_FILE),
      'old key',
      { mode: 0o600 },
    );
    return legacy;
  };

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-cert-layout-')),
    );
    previousRoot = process.env.CLOUDGATE_DIRECTORY;
    process.env.CLOUDGATE_DIRECTORY = root;
    programs = [];
    mockWatch.legacy = '';
    mockWatch.legacyAtRename = [];
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('names a file at the top of the watched dynamic directory, outside APP_NAME_REGEX', () => {
    const file = certificateConfigPath('certificate-abc', 'server-1');

    expect(file).toBe(
      '/etc/cloudgate/traefik/dynamic/certificate+certificate-abc.yml',
    );
    expect(path.dirname(file)).toBe(dynamicTraefikDirectory('server-1'));
    expect(legacyCertificateConfigPath('certificate-abc', 'server-1')).toBe(
      '/etc/cloudgate/traefik/dynamic/certificates/certificate-abc/certificate.yml',
    );
  });

  describe.each([
    ['the platform host', null],
    ['a Server', 'srv-1'],
  ] as const)('on %s', (_machine, serverId) => {
    const save = async () => {
      await new TraefikWriterService(remoteExec).writeCertificate({
        ...cert,
        serverId,
      });
      runOnServer();
    };

    it('writes the fragment at the top of dynamic/, pointing at the PEM pair in the certificate directory', async () => {
      await save();

      const dynamic = onDisk(dynamicTraefikDirectory(serverId), serverId);
      const file = onDisk(
        certificateConfigPath(cert.certificatePath, serverId),
        serverId,
      );
      const directory = path.join(
        dynamic,
        'certificates',
        cert.certificatePath,
      );
      expect(modeOf(file)).toBe(0o600);
      // The paths are the ones Traefik is handed, on the machine's own root.
      const pemDirectory = path.join(
        dynamicTraefikDirectory(serverId),
        'certificates',
        cert.certificatePath,
      );
      expect(parse(fs.readFileSync(file, 'utf8'))).toEqual({
        tls: {
          certificates: [
            {
              certFile: path.join(pemDirectory, 'chain.crt'),
              keyFile: path.join(pemDirectory, CERTIFICATE_KEY_FILE),
            },
          ],
        },
      });
      expect(fs.readdirSync(directory).sort()).toEqual(
        ['chain.crt', CERTIFICATE_KEY_FILE].sort(),
      );
      // Only the fragment itself sits at the top: no temporary sibling is left.
      expect(fs.readdirSync(dynamic).sort()).toEqual(
        ['certificates', path.basename(file)].sort(),
      );
    });

    it('moves an earlier version’s fragment out of the certificate directory at the next save', async () => {
      const legacy = leaveLegacyCertificate(serverId);

      await save();

      expect(fs.existsSync(legacy)).toBe(false);
      expect(
        fs.existsSync(
          onDisk(
            certificateConfigPath(cert.certificatePath, serverId),
            serverId,
          ),
        ),
      ).toBe(true);
      expect(
        fs.readFileSync(
          path.join(path.dirname(legacy), CERTIFICATE_KEY_FILE),
          'utf8',
        ),
      ).toBe(cert.privateKey);
    });

    it('keeps a legacy certificate served throughout its move: the new fragment lands before the old one goes', async () => {
      const legacy = leaveLegacyCertificate(serverId);
      const file = onDisk(
        certificateConfigPath(cert.certificatePath, serverId),
        serverId,
      );
      mockWatch.legacy = legacy;
      mockWatch.legacyAtRename = [];
      await new TraefikWriterService(remoteExec).writeCertificate({
        ...cert,
        serverId,
      });
      const [program] = programs;
      runOnServer();

      if (serverId) {
        // The Server's program: the rename comes before the legacy removal.
        const removal = `rm -f ${quote([legacyCertificateConfigPath(cert.certificatePath, serverId)])}`;
        expect(program.indexOf('mv -f')).toBeGreaterThan(-1);
        expect(program.indexOf(removal)).toBeGreaterThan(
          program.indexOf('mv -f'),
        );
      } else {
        // The platform host's: the legacy fragment was still there when the
        // new one was renamed into place.
        expect(mockWatch.legacyAtRename).toEqual([true]);
      }
      expect(fs.existsSync(legacy)).toBe(false);
      expect(fs.existsSync(file)).toBe(true);
    });

    it('removes the fragment and the certificate directory on Delete', async () => {
      await save();
      const writer = new TraefikWriterService(remoteExec);

      await writer.removeCertificate(cert.certificatePath, serverId);
      runOnServer();

      expect(
        fs.readdirSync(onDisk(dynamicTraefikDirectory(serverId), serverId)),
      ).toEqual(['certificates']);
      expect(
        fs.readdirSync(
          onDisk(
            path.join(dynamicTraefikDirectory(serverId), 'certificates'),
            serverId,
          ),
        ),
      ).toEqual([]);
    });

    it('removes an earlier version’s certificate directory on Delete', async () => {
      const legacy = leaveLegacyCertificate(serverId);

      await new TraefikWriterService(remoteExec).removeCertificate(
        cert.certificatePath,
        serverId,
      );
      runOnServer();

      expect(fs.existsSync(path.dirname(legacy))).toBe(false);
    });

    /**
     * The watch Traefik puts on `dynamic/` fires on an entry created, removed
     * or renamed there, which is exactly what moves the directory's own mtime,
     * so the mtime is what stands in for the watch here. A legacy-only
     * certificate has nothing at the top to remove, and removing its
     * subdirectory alone left it served until an unrelated reload.
     */
    const dynamicMtime = (serverId: string | null) =>
      fs.statSync(onDisk(dynamicTraefikDirectory(serverId), serverId)).mtimeMs;
    const ageDynamic = (serverId: string | null) => {
      const dynamic = onDisk(dynamicTraefikDirectory(serverId), serverId);
      fs.utimesSync(dynamic, 0, 0);
      return fs.statSync(dynamic).mtimeMs;
    };

    it('changes the top of dynamic/ when a Delete removes an earlier version’s fragment, leaving nothing behind there', async () => {
      leaveLegacyCertificate(serverId);
      const aged = ageDynamic(serverId);

      await new TraefikWriterService(remoteExec).removeCertificate(
        cert.certificatePath,
        serverId,
      );
      runOnServer();

      expect(dynamicMtime(serverId)).not.toBe(aged);
      expect(
        fs.readdirSync(onDisk(dynamicTraefikDirectory(serverId), serverId)),
      ).toEqual(['certificates']);
    });

    it('leaves the top of dynamic/ alone when a Delete finds no fragment at all', async () => {
      fs.mkdirSync(
        onDisk(
          path.join(dynamicTraefikDirectory(serverId), 'certificates'),
          serverId,
        ),
        { recursive: true },
      );
      const aged = ageDynamic(serverId);

      await new TraefikWriterService(remoteExec).removeCertificate(
        cert.certificatePath,
        serverId,
      );
      runOnServer();

      expect(dynamicMtime(serverId)).toBe(aged);
    });
  });
});
