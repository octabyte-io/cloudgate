import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every curl the install scripts run that fetches something from the
 * internet (a Cloudgate version and the list of them, Node, OpenTofu, a
 * provider, the Session Manager plugin, nixpacks, Docker's installer) takes
 * `--retry 3 --retry-connrefused --connect-timeout 15`. Without them one
 * dropped connection, on a flaky network or a VPS still bringing its own up,
 * fails the install minutes into its downloads.
 *
 * The sites are every curl in command position in either script (comments
 * left out, a command continued with `\` read as one line; a curl quoted in a
 * message is not one). Two kinds are not downloads and are left out: a curl
 * of the install's own services on 127.0.0.1, and the curls EXEMPT names, each
 * with its reason. An exemption that names no site,
 * or more than one, fails too, so the list cannot outlive what it excuses.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const SCRIPTS = ['install.sh', 'deploy/install.sh'];
const RETRY = ['--retry 3', '--retry-connrefused', '--connect-timeout 15'];

const EXEMPT: { file: string; site: RegExp; why: string }[] = [
  {
    file: 'install.sh',
    site: /curl -4 -fsS --max-time 10 "\$lookup"/,
    why: 'the public address lookup: it tries a second service when the first does not answer',
  },
];

/** Each curl command in `file`, as one line. */
function curls(file: string): string[] {
  return fs
    .readFileSync(path.join(repoRoot, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /(^|\$\(|[;&|(]\s*)curl\s+-/.test(line));
}

describe('deploy/install.sh and install.sh, on every download curl retrying', () => {
  it.each(SCRIPTS)('every download curl in %s retries', (file) => {
    const downloads = curls(file).filter(
      (line) =>
        !line.includes('127.0.0.1') &&
        !EXEMPT.some((exempt) => exempt.file === file && exempt.site.test(line)),
    );
    expect(downloads.length).toBeGreaterThan(0);

    const missing = downloads.filter(
      (line) => !RETRY.every((flag) => line.includes(flag)),
    );
    expect(missing).toEqual([]);
  });

  it.each(EXEMPT.map((exempt) => [exempt.why, exempt]))(
    'names exactly one curl as %s',
    (_why, exempt) => {
      const sites = curls(exempt.file).filter((line) => exempt.site.test(line));

      expect(sites).toHaveLength(1);
    },
  );
});
