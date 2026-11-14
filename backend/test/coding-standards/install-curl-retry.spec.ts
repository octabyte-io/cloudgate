import { code, installScripts } from './install-scripts';

/**
 * Every curl the install scripts run that fetches something from the
 * internet (a Cloudgate version and the list of them, the tag's own
 * install.sh, Node, OpenTofu, a provider, the Session Manager plugin,
 * nixpacks, Docker's installer) takes
 * `--retry 3 --retry-connrefused --connect-timeout 15`. Without them one
 * dropped connection, on a flaky network or a VPS still bringing its own up,
 * fails the install minutes into its downloads.
 *
 * The scripts are every tracked one that is part of installing or upgrading
 * (`installScripts`, read from git). The sites are every curl in command
 * position (comments left out, a command continued with `\` read as one
 * line), whatever its first argument is, a flag, a quoted URL or a bare one;
 * a curl named in a message is not one. A curl of the platform host's own
 * services on 127.0.0.1 is not a download and is left out. Every other site
 * retries or is in EXEMPT with its reason, and an exemption that names no
 * site, or more than one, fails too, so the list cannot outlive what it
 * excuses.
 */
const RETRY = ['--retry 3', '--retry-connrefused', '--connect-timeout 15'];

const EXEMPT: { file: string; site: RegExp; why: string }[] = [
  {
    file: 'install.sh',
    site: /curl -4 -fsS --max-time 10 "\$lookup"/,
    why: 'the public address lookup: it tries a second service when the first does not answer',
  },
  {
    file: 'install.sh',
    site: /curl -s -o \/dev\/null --max-time 5 "https:\/\/\$host\/"/,
    why: 'the preflight probe: it asks once whether a host answers within 5 seconds',
  },
  {
    file: 'deploy/hosted-backup.sh',
    site: /curl -fsS -o \/dev\/null -X POST https:\/\/api\.resend\.com\/emails/,
    why: 'the staleness alert: a POST of one email, not a download, which says so on stderr when it fails',
  },
  {
    file: 'deploy/version-smoke.sh',
    site: /curl -s -o "\$into\/answer" -w '%\{http_code\}' --max-time 5 "\$url"/,
    why: 'the smoke check’s poll of the version it booted on the runner, which asks again every second for two minutes',
  },
];

const COMMAND =
  /(^|\$\(|[;&|(!]\s*|\b(if|then|else|do|while|until)\s+)curl\s+(-|"|'|\$|https?:)/;

/** Each curl command in `text`, as one line. */
function curlsIn(text: string): string[] {
  return text
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => COMMAND.test(line));
}

const curls = (file: string) => curlsIn(code(file));

function exempt(file: string, line: string): boolean {
  return EXEMPT.some((e) => e.file === file && e.site.test(line));
}

describe('the install scripts, on every download curl retrying', () => {
  const scripts = installScripts();

  it('reads the install scripts from git, the one-command install and deploy/install.sh among them', () => {
    expect(scripts).toEqual(
      expect.arrayContaining(['install.sh', 'deploy/install.sh']),
    );
  });

  it('counts a curl whose first argument is a flag, a quoted URL or a bare one, and not one named in a message', () => {
    const sites = curlsIn(
      [
        'curl -fsSL "$url"',
        'curl "$url" -o out',
        "curl 'https://example.com/a'",
        'curl https://example.com/b | sh',
        'x="$(curl $url)"',
        'command -v curl >/dev/null',
        'fail "Could not ask GitHub (curl exit $status)"',
        'echo "    curl -fsSL https://example.com/install.sh | sudo sh"',
      ].join('\n'),
    );

    expect(sites).toEqual([
      'curl -fsSL "$url"',
      'curl "$url" -o out',
      "curl 'https://example.com/a'",
      'curl https://example.com/b | sh',
      'x="$(curl $url)"',
    ]);
  });

  it.each(scripts)('every download curl in %s retries', (file) => {
    const missing = curls(file).filter(
      (line) =>
        !line.includes('127.0.0.1') &&
        !exempt(file, line) &&
        !RETRY.every((flag) => line.includes(flag)),
    );

    expect({ file, missing }).toEqual({ file, missing: [] });
  });

  it.each(EXEMPT.map((e) => [e.why, e]))(
    'names exactly one curl as %s',
    (_why, e) => {
      expect(scripts).toContain(e.file);
      const sites = curls(e.file).filter((line) => e.site.test(line));

      expect(sites).toHaveLength(1);
    },
  );
});
