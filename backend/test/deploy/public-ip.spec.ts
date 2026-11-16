import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * `deploy/public-ip.sh`: the address `deploy/install.sh` hands the backend as
 * `CLOUDGATE_PUBLIC_IP`, which a fresh instance's Settings > Instance public
 * address is filled in from. Driven by sourcing the file, as install.sh does,
 * with a `curl` on PATH that answers from a file per URL instead of the
 * internet.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const library = path.join(repoRoot, 'deploy/public-ip.sh');
const installer = path.join(repoRoot, 'deploy/install.sh');

let bin: string;
let answers: string;

beforeEach(() => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'public-ip-'));
  bin = path.join(scratch, 'bin');
  answers = path.join(scratch, 'answers');
  fs.mkdirSync(bin);
  fs.mkdirSync(answers);
  // The last argument is the URL. A host with no answer file fails, as a
  // service that is down does; every call is recorded.
  fs.writeFileSync(
    path.join(bin, 'curl'),
    [
      '#!/usr/bin/env bash',
      'for url; do :; done',
      'echo "$url" >> "$ANSWERS/calls"',
      'file="$ANSWERS/$(printf %s "$url" | sed "s#^https://##; s#/#_#g")"',
      '[ -f "$file" ] || exit 7',
      'cat "$file"',
    ].join('\n'),
    { mode: 0o755 },
  );
});

/** The lookup at `url` answers `body`. */
function answer(url: string, body: string) {
  const name = url.replace(/^https:\/\//, '').replace(/\//g, '_');
  fs.writeFileSync(path.join(answers, name), body);
}

function calls(): string[] {
  const file = path.join(answers, 'calls');
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n')
    : [];
}

function run(script: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-euc', `. "$LIBRARY"; ${script}`], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      LIBRARY: library,
      ANSWERS: answers,
      ...env,
    },
  });
}

const platformIp = (env: Record<string, string>) =>
  run('platform_public_ip', env);

describe('deploy/public-ip.sh', () => {
  describe('public_ipv4', () => {
    it.each([
      '1.1.1.1',
      '8.8.8.8',
      '100.63.255.1',
      '100.128.0.1',
      '172.15.0.1',
      '172.32.0.1',
      '192.169.0.1',
      '203.0.114.1',
      '223.255.255.255',
    ])('accepts %s', (address) => {
      expect(run(`public_ipv4 ${address}`).status).toBe(0);
    });

    it.each([
      '10.0.0.4',
      '127.0.0.1',
      '0.0.0.0',
      '100.64.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.10',
      '192.0.2.1',
      '198.18.0.1',
      '198.51.100.7',
      '203.0.113.10',
      '224.0.0.1',
      '255.255.255.255',
      '256.1.1.1',
      '1.2.3',
      '1.2.3.4.5',
      'a.b.c.d',
      '',
      '<html>',
    ])('refuses %j', (address) => {
      expect(run(`public_ipv4 '${address}'`).status).not.toBe(0);
    });
  });

  describe('detect_public_ipv4', () => {
    it('answers with the first service that gives a public address', () => {
      answer('https://checkip.amazonaws.com', '93.184.216.34\n');

      const found = run('detect_public_ipv4');

      expect(found.status).toBe(0);
      expect(found.stdout).toBe('93.184.216.34\n');
      expect(calls()).toEqual([
        'https://api.ipify.org',
        'https://checkip.amazonaws.com',
      ]);
    });

    it('skips a service that answers with something other than a public address', () => {
      answer('https://api.ipify.org', '<html>blocked</html>');
      answer('https://checkip.amazonaws.com', '10.0.0.4');
      answer('https://ipv4.icanhazip.com', '93.184.216.34');

      expect(run('detect_public_ipv4').stdout).toBe('93.184.216.34\n');
    });

    it('fails when no service answers', () => {
      const found = run('detect_public_ipv4');

      expect(found.status).not.toBe(0);
      expect(found.stdout).toBe('');
      expect(calls()).toHaveLength(3);
    });

    it('asks each service over IPv4 with a timeout', () => {
      const text = fs.readFileSync(library, 'utf8');

      expect(text).toMatch(/curl -4 -fsS --max-time 5 "\$lookup"/);
    });
  });

  describe('platform_public_ip', () => {
    it('uses a public IP the install was given as its public host, asking nobody', () => {
      expect(
        platformIp({ CLOUDGATE_PUBLIC_HOST: '93.184.216.34' }).stdout,
      ).toBe('93.184.216.34\n');
      expect(calls()).toEqual([]);
    });

    it('gives nothing for a private public host, asking nobody', () => {
      const found = platformIp({ CLOUDGATE_PUBLIC_HOST: '192.168.1.10' });

      expect(found.status).toBe(0);
      expect(found.stdout).toBe('');
      expect(calls()).toEqual([]);
    });

    it('looks the address up when the public host is a hostname', () => {
      answer('https://api.ipify.org', '93.184.216.34');

      expect(
        platformIp({ CLOUDGATE_PUBLIC_HOST: 'cloud.example.com' }).stdout,
      ).toBe('93.184.216.34\n');
    });

    it('gives nothing, and does not fail, when a hostname’s address cannot be found', () => {
      const found = platformIp({ CLOUDGATE_PUBLIC_HOST: 'cloud.example.com' });

      expect(found.status).toBe(0);
      expect(found.stdout).toBe('');
    });

    it('gives nothing for localhost, the SSH-tunnel setup', () => {
      answer('https://api.ipify.org', '93.184.216.34');

      expect(platformIp({ CLOUDGATE_PUBLIC_HOST: 'localhost' }).stdout).toBe(
        '',
      );
      expect(calls()).toEqual([]);
    });

    it('passes an IPv6 public host on, for the backend to judge', () => {
      expect(
        platformIp({ CLOUDGATE_PUBLIC_HOST: '2606:4700::1111' }).stdout,
      ).toBe('2606:4700::1111\n');
    });

    it('prefers CLOUDGATE_PUBLIC_IP over everything, private or not', () => {
      answer('https://api.ipify.org', '93.184.216.34');

      expect(
        platformIp({
          CLOUDGATE_PUBLIC_IP: '10.0.0.4',
          CLOUDGATE_PUBLIC_HOST: 'cloud.example.com',
        }).stdout,
      ).toBe('10.0.0.4\n');
      expect(calls()).toEqual([]);
    });

    it('gives nothing for CLOUDGATE_PUBLIC_IP=none', () => {
      const found = platformIp({
        CLOUDGATE_PUBLIC_IP: 'none',
        CLOUDGATE_PUBLIC_HOST: '93.184.216.34',
      });

      expect(found.status).toBe(0);
      expect(found.stdout).toBe('');
    });

    it('refuses a CLOUDGATE_PUBLIC_IP that is not an address', () => {
      const found = platformIp({ CLOUDGATE_PUBLIC_IP: 'cloud.example.com' });

      expect(found.status).not.toBe(0);
      expect(found.stderr).toContain('CLOUDGATE_PUBLIC_IP is this host');
    });
  });

  describe('deploy/install.sh', () => {
    const text = fs.readFileSync(installer, 'utf8');

    it('sources the library', () => {
      expect(text).toContain('. "$REPO_ROOT/deploy/public-ip.sh"');
    });

    it('hands the address to the backend as CLOUDGATE_PUBLIC_IP', () => {
      expect(text).toContain('CLOUDGATE_PUBLIC_IP=${PLATFORM_PUBLIC_IP}');
    });

    it('checks a named CLOUDGATE_PUBLIC_IP before anything changes the box', () => {
      expect(
        text.indexOf('PLATFORM_PUBLIC_IP="$(platform_public_ip)" || exit 1'),
      ).toBeLessThan(text.indexOf('log "Packages"'));
    });
  });
});
