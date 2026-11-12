import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  CERTIFICATE_KEY_FILE,
  TraefikWriterService,
} from '../../src/traefik/traefik-writer.service';

/**
 * A custom certificate's private key was written `0644` in `0755`
 * directories, readable by the console's `cloudgate` user and every local
 * account. These read the modes off a real filesystem, on both branches.
 *
 * `traefik-writer.service.spec.ts` mocks `node:fs` for the whole file, which is
 * why this is a file of its own: a mode is a fact about a disk, not about the
 * arguments a mock was called with. The platform host's branch writes under a
 * temporary `CLOUDGATE_DIRECTORY`; the Server's branch captures the program it
 * would send over SSH and runs it under `sh`, with the Server's root rewritten
 * to a temporary one — the same `sh` the transport hands it to.
 *
 * Each case starts from what an earlier version left, `0755` directories and a
 * `0644` key already there, because the write that matters most on an existing
 * install is the one that has to *correct* a mode rather than choose one.
 */
describe('TraefikWriterService', () => {
  const cert = {
    certificatePath: 'certificate-modes',
    certificateData:
      '-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----\n',
    privateKey: '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n',
  };

  let root: string;
  let previousRoot: string | undefined;

  const modeOf = (file: string) => fs.statSync(file).mode & 0o777;

  /** An earlier version's certificate directory, under `base`. */
  const leaveOldCertificate = (base: string): string => {
    const directory = path.join(
      base,
      'traefik/dynamic/certificates',
      cert.certificatePath,
    );
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    fs.chmodSync(directory, 0o755);
    fs.writeFileSync(path.join(directory, CERTIFICATE_KEY_FILE), 'old key', {
      mode: 0o644,
    });
    fs.chmodSync(path.join(directory, CERTIFICATE_KEY_FILE), 0o644);
    return directory;
  };

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-cert-modes-')),
    );
    previousRoot = process.env.CLOUDGATE_DIRECTORY;
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes a certificate on the platform host readable by its owner alone', async () => {
    process.env.CLOUDGATE_DIRECTORY = root;
    const directory = leaveOldCertificate(root);
    const writer = new TraefikWriterService({} as RemoteExecService);

    await writer.writeCertificate({ ...cert, serverId: null });

    expect(modeOf(directory)).toBe(0o700);
    expect(
      fs
        .readdirSync(directory)
        .sort()
        .map((name) => [name, modeOf(path.join(directory, name))]),
    ).toEqual([
      ['chain.crt', 0o600],
      [CERTIFICATE_KEY_FILE, 0o600],
    ]);
    expect(
      fs.readFileSync(path.join(directory, CERTIFICATE_KEY_FILE), 'utf8'),
    ).toBe(cert.privateKey);
    // The fragment sits at the top of dynamic/, owner-only there too.
    expect(
      modeOf(
        path.join(
          root,
          'traefik/dynamic',
          `certificate+${cert.certificatePath}.yml`,
        ),
      ),
    ).toBe(0o600);
  });

  it('writes a certificate on a Server readable by its owner alone', async () => {
    let program = '';
    const writer = new TraefikWriterService({
      execAsyncRemote: (_serverId: string, command: string) => {
        program = command;
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      },
    } as unknown as RemoteExecService);
    const directory = leaveOldCertificate(root);

    await writer.writeCertificate({ ...cert, serverId: 'srv-1' });
    const run = spawnSync(
      'sh',
      ['-c', program.split(REMOTE_CLOUDGATE_DIRECTORY).join(root)],
      { encoding: 'utf8' },
    );

    expect(run.status).toBe(0);
    expect(modeOf(directory)).toBe(0o700);
    expect(
      fs
        .readdirSync(directory)
        .sort()
        .map((name) => [name, modeOf(path.join(directory, name))]),
    ).toEqual([
      ['chain.crt', 0o600],
      [CERTIFICATE_KEY_FILE, 0o600],
    ]);
    expect(
      fs.readFileSync(path.join(directory, CERTIFICATE_KEY_FILE), 'utf8'),
    ).toBe(cert.privateKey);
    // The fragment sits at the top of dynamic/, owner-only there too.
    expect(
      modeOf(
        path.join(
          root,
          'traefik/dynamic',
          `certificate+${cert.certificatePath}.yml`,
        ),
      ),
    ).toBe(0o600);
  });
});
