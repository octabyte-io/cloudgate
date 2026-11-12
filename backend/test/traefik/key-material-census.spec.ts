import * as fs from 'node:fs';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withheldReason } from '../../src/settings/traefik-file.utils';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';

// The filesystem and SSH are the boundaries the writer reaches; both are
// recorded rather than performed, so every file it writes is on the record.
jest.mock('node:fs');

const mockedFs = jest.mocked(fs);

/**
 * The census the ticket asked for: **every file `TraefikWriterService` writes
 * private-key material into is one the console's Traefik file surface
 * withholds** (`settings/traefik-file.utils.ts`).
 *
 * Measured from the writes rather than from a list of names, so it cannot be
 * satisfied by a list agreeing with itself: each write method is driven on both
 * machines with a sentinel key, and every path whose bytes carry that sentinel
 * must be withheld. A key file renamed in the writer, or written a second time
 * somewhere new, fails here without anyone having to remember the deny rule.
 *
 * `acme.json` is not in this census because Cloudgate never writes it —
 * Traefik does, at the `storage` path — and `traefik-files.service.spec.ts` pins it.
 */
describe('withheldReason', () => {
  const SENTINEL_KEY =
    '-----BEGIN PRIVATE KEY-----\ncensus-sentinel\n-----END PRIVATE KEY-----\n';

  const execAsyncRemote = jest.fn();
  const remoteExec = withArgvExec({
    execAsyncRemote,
  }) as unknown as RemoteExecService;

  /**
   * Every method the writer has. A new one fails this list until its author
   * says here whether it writes key material — which is the census's question,
   * asked at the moment it can still be answered cheaply.
   */
  const KEY_WRITERS = ['writeCertificate'];
  const OTHER_METHODS = [
    'constructor',
    'configPath',
    'loadOrCreateConfig',
    'writeConfig',
    'removeConfig',
    'removeCertificate',
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    execAsyncRemote.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('knows every method the writer has', () => {
    expect(
      Object.getOwnPropertyNames(TraefikWriterService.prototype).sort(),
    ).toEqual([...KEY_WRITERS, ...OTHER_METHODS].sort());
  });

  /** Each path a write put the sentinel into, on the platform and a Server. */
  async function keyPaths(): Promise<string[]> {
    const writer = new TraefikWriterService(remoteExec);
    const cert = {
      certificatePath: 'certificate-census',
      certificateData:
        '-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----\n',
      privateKey: SENTINEL_KEY,
    };
    await writer.writeCertificate({ ...cert, serverId: null });
    await writer.writeCertificate({ ...cert, serverId: 'srv-1' });

    const local = mockedFs.writeFileSync.mock.calls
      .filter(
        ([, data]) =>
          typeof data === 'string' && data.includes('census-sentinel'),
      )
      .map(([file]) => String(file));

    // A remote write is `echo "<base64>" | base64 -d > '<path>'`, one per line.
    const remote = execAsyncRemote.mock.calls.flatMap(([, command]) =>
      [
        ...String(command).matchAll(/echo "([^"]+)" \| base64 -d > ([^\s;]+)/g),
      ].flatMap(([, payload, target]) =>
        Buffer.from(payload, 'base64')
          .toString('utf8')
          .includes('census-sentinel')
          ? [target.replace(/^'|'$/g, '')]
          : [],
      ),
    );
    return [...local, ...remote];
  }

  it('withholds every file the writer puts a private key into, on both machines', async () => {
    const paths = await keyPaths();

    // Not vacuous: one key file on each machine was found and checked.
    expect(paths).toHaveLength(2);
    // The path rides along in the assertion so a failure names the file.
    for (const file of paths) {
      expect([file, withheldReason(file)]).toEqual([
        file,
        `privkey.key holds private key material, which the console neither shows nor overwrites`,
      ]);
    }
  });
});
