import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import {
  acmeCertificatesCommand,
  acmeCertificatesRead,
  acmeStoragePath,
  dnsResolverCertificatesIn,
  dnsResolverCertificatesOn,
} from '../../src/preview-deployments/dns-resolver-certificates';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  EXACT_PREVIEW_HOST_PEM,
  WILDCARD_PREVIEW_EXAMPLE_COM_PEM,
} from './fixtures/preview-certificates';

const KEY_SENTINEL = 'a2V5LXNlbnRpbmVsLW5ldmVyLXJlYWQ=';
const ACCOUNT_KEY_SENTINEL = 'YWNjb3VudC1rZXktc2VudGluZWw=';
const b64 = (pem: string) => Buffer.from(pem, 'utf8').toString('base64');

/**
 * An `acme.json` in the shape Traefik writes it — Go's `json.MarshalIndent`,
 * two-space indent — with an HTTP-01 section and a DNS-01 section, each
 * certificate carrying a sentinel `key` and each account a sentinel
 * `PrivateKey`.
 */
const ACME_JSON = JSON.stringify(
  {
    letsencrypt: {
      Account: {
        Email: 'ops@example.com',
        PrivateKey: ACCOUNT_KEY_SENTINEL,
        KeyType: '4096',
      },
      Certificates: [
        {
          domain: { main: 'preview-web-app-abc123.preview.example.com' },
          certificate: b64(EXACT_PREVIEW_HOST_PEM),
          key: KEY_SENTINEL,
          Store: 'default',
        },
      ],
    },
    'letsencrypt-dns': {
      Account: {
        Email: 'ops@example.com',
        PrivateKey: ACCOUNT_KEY_SENTINEL,
        KeyType: '4096',
      },
      Certificates: [
        {
          domain: { main: '*.preview.example.com' },
          certificate: b64(WILDCARD_PREVIEW_EXAMPLE_COM_PEM),
          key: KEY_SENTINEL,
          Store: 'default',
        },
      ],
    },
  },
  null,
  2,
);

describe('dnsResolverCertificatesIn', () => {
  it("decodes the DNS-01 resolver's certificates and no other resolver's", () => {
    expect(dnsResolverCertificatesIn(ACME_JSON)).toEqual([
      WILDCARD_PREVIEW_EXAMPLE_COM_PEM,
    ]);
  });

  it('never answers a key, even when the file still carries one', () => {
    const answered = JSON.stringify(dnsResolverCertificatesIn(ACME_JSON));
    expect(answered).not.toContain(KEY_SENTINEL);
    expect(answered).not.toContain(ACCOUNT_KEY_SENTINEL);
    expect(answered).not.toContain(
      Buffer.from(KEY_SENTINEL, 'base64').toString('utf8'),
    );
  });

  it.each([
    ['text that is not JSON', 'not json {'],
    ['an empty file', ''],
    ['JSON null', 'null'],
    ['a file with no DNS-01 section', JSON.stringify({ letsencrypt: {} })],
    [
      'a DNS-01 section with no certificates yet',
      JSON.stringify({ 'letsencrypt-dns': { Certificates: null } }),
    ],
    [
      'entries that are not objects',
      JSON.stringify({ 'letsencrypt-dns': { Certificates: [null, 7] } }),
    ],
  ])('gives none for %s', (_label, text) => {
    expect(dnsResolverCertificatesIn(text)).toEqual([]);
  });
});

describe('acmeCertificatesCommand', () => {
  it('reads the acme.json under the dynamic directory of the machine it names', () => {
    expect(acmeStoragePath('srv-1')).toBe(
      '/etc/cloudgate/traefik/dynamic/acme.json',
    );
    expect(acmeCertificatesCommand('srv-1')).toEqual([
      'sed',
      '-E',
      expect.any(String),
      '/etc/cloudgate/traefik/dynamic/acme.json',
    ]);
  });

  /**
   * The program is run for real, against a file on disk, so what is asserted
   * is what leaves the machine rather than what the argv looks like.
   */
  it('blanks every private key on the machine and leaves the certificates parseable', () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-acme-'));
    const file = nodePath.join(dir, 'acme.json');
    fs.writeFileSync(file, ACME_JSON);
    try {
      const [program, ...args] = acmeCertificatesCommand(null);
      const printed = execFileSync(program, [...args.slice(0, -1), file], {
        encoding: 'utf8',
      });
      expect(printed).not.toContain(KEY_SENTINEL);
      expect(printed).not.toContain(ACCOUNT_KEY_SENTINEL);
      // Nothing but the key values moved.
      expect(printed).toContain('"key": ""');
      expect(printed).toContain('"PrivateKey": ""');
      expect(dnsResolverCertificatesIn(printed)).toEqual([
        WILDCARD_PREVIEW_EXAMPLE_COM_PEM,
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('acmeCertificatesRead', () => {
  it('is the sed argv itself on the platform host, where the backend is root', () => {
    expect(acmeCertificatesRead(null)).toEqual(acmeCertificatesCommand(null));
  });

  /**
   * On a Server `acme.json` is root's, `0600` — Traefik creates it — while the
   * SSH user may be anyone `server-setup.ts` accepted, so the read is root's
   * too: directly for root, `sudo -n` for anyone else, as `SUDO_CMD` decides.
   */
  it('runs the sed as root on a Server: directly for root, through sudo -n otherwise', () => {
    const words =
      'sed -E \'s/"(key|PrivateKey)"[[:space:]]*:[[:space:]]*"[^"]*"/"\\1": ""/g\' /etc/cloudgate/traefik/dynamic/acme.json';
    expect(acmeCertificatesRead('srv-1')).toBe(
      `if [ "$(id -u)" -eq 0 ]; then ${words}; else sudo -n ${words}; fi`,
    );
  });

  /**
   * The program run for real under `sh`, with a `sudo` on PATH that records
   * its argv and then runs the rest, so what is asserted is that the words
   * survive the shell and the keys are still blanked.
   */
  it('reads the file through sudo -n, keys blanked, when the user is not root', () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-acme-'));
    const file = nodePath.join(dir, 'acme.json');
    const log = nodePath.join(dir, 'sudo.log');
    fs.writeFileSync(file, ACME_JSON);
    fs.writeFileSync(
      nodePath.join(dir, 'sudo'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nshift\nexec "$@"\n`,
      { mode: 0o755 },
    );
    try {
      const program = (acmeCertificatesRead('srv-1') as string)
        .split(acmeStoragePath('srv-1'))
        .join(file);
      const printed = execFileSync('sh', ['-c', program], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      });
      expect(printed).not.toContain(KEY_SENTINEL);
      expect(printed).not.toContain(ACCOUNT_KEY_SENTINEL);
      expect(dnsResolverCertificatesIn(printed)).toEqual([
        WILDCARD_PREVIEW_EXAMPLE_COM_PEM,
      ]);
      if (process.getuid?.() === 0) {
        // Root reads it directly; sudo is never asked.
        expect(fs.existsSync(log)).toBe(false);
      } else {
        expect(fs.readFileSync(log, 'utf8').split('\n').slice(0, 2)).toEqual([
          '-n',
          'sed',
        ]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dnsResolverCertificatesOn', () => {
  const setup = { dnsChallengeId: 'dns-1', provider: 'cloudflare' };

  const dbWith = (row: object | undefined) => {
    const limit = jest.fn().mockResolvedValue(row ? [row] : []);
    const chain = { from: () => chain, where: () => chain, limit };
    return { db: { select: () => chain } as unknown as DrizzleDB, limit };
  };
  const execWith = (answer: () => Promise<unknown>) => {
    const exec = {
      execFileAsync: jest.fn(answer),
      execRemote: jest.fn(answer),
      execAsyncRemote: jest.fn(answer),
    };
    return { exec, remoteExec: exec as unknown as RemoteExecService };
  };

  it('reads nothing on a machine with no DNS-01 setup, and answers none', async () => {
    const { db } = dbWith(undefined);
    const { exec, remoteExec } = execWith(() =>
      Promise.resolve({ stdout: ACME_JSON, stderr: '' }),
    );
    await expect(
      dnsResolverCertificatesOn(db, remoteExec, 'srv-1'),
    ).resolves.toEqual([]);
    // The DNS-01 row is gone, so its certificates no longer count, and the
    // machine is not asked.
    expect(exec.execRemote).not.toHaveBeenCalled();
    expect(exec.execAsyncRemote).not.toHaveBeenCalled();
    expect(exec.execFileAsync).not.toHaveBeenCalled();
  });

  it("answers a Server's certificates with that Server, read over SSH", async () => {
    const { db } = dbWith(setup);
    const { exec, remoteExec } = execWith(() =>
      Promise.resolve({ stdout: ACME_JSON, stderr: '' }),
    );
    await expect(
      dnsResolverCertificatesOn(db, remoteExec, 'srv-1'),
    ).resolves.toEqual([
      { serverId: 'srv-1', certificateData: WILDCARD_PREVIEW_EXAMPLE_COM_PEM },
    ]);
    // A program, not argv: it runs as root on a Server (acmeCertificatesRead).
    expect(exec.execAsyncRemote).toHaveBeenCalledWith(
      'srv-1',
      acmeCertificatesRead('srv-1'),
    );
    expect(exec.execRemote).not.toHaveBeenCalled();
  });

  it("answers the platform host's certificates with null, read locally", async () => {
    const { db } = dbWith(setup);
    const { exec, remoteExec } = execWith(() =>
      Promise.resolve({ stdout: ACME_JSON, stderr: '' }),
    );
    await expect(
      dnsResolverCertificatesOn(db, remoteExec, null),
    ).resolves.toEqual([
      { serverId: null, certificateData: WILDCARD_PREVIEW_EXAMPLE_COM_PEM },
    ]);
    const [program, ...args] = acmeCertificatesCommand(null);
    expect(exec.execFileAsync).toHaveBeenCalledWith(program, args);
    expect(exec.execRemote).not.toHaveBeenCalled();
    expect(exec.execAsyncRemote).not.toHaveBeenCalled();
  });

  it('answers none rather than failing when the file cannot be read', async () => {
    const { db } = dbWith(setup);
    const { remoteExec } = execWith(() =>
      Promise.reject(new Error("sed: can't read acme.json: No such file")),
    );
    await expect(
      dnsResolverCertificatesOn(db, remoteExec, 'srv-1'),
    ).resolves.toEqual([]);
  });
});
