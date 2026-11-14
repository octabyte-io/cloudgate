import { code, installScripts } from './install-scripts';

/**
 * Every apt-get the install scripts run goes through their `apt_get`, which
 * waits out the lock cloud-init and unattended-upgrades hold on a VPS's first
 * boot. A bare `apt-get` there fails the install with "Could not get lock".
 *
 * The scripts are every tracked one that is part of installing or upgrading
 * (`installScripts`, read from git). The sites are every line of each that
 * runs `apt-get` (comments left out). A script with a site declares its own
 * `apt_get`, every site is inside it, and the script calls it; a script with
 * no site complies as it is. A script that may not comply is in EXEMPT with
 * its reason, and an exemption whose script runs no bare apt-get fails, so
 * the list cannot outlive what it excuses.
 */
const EXEMPT: { file: string; why: string }[] = [];

const APT_GET = /(^|[\s;|&(])apt-get\s/;

function aptGet(file: string): string | undefined {
  return code(file).match(/^apt_get\(\) \{\n[\s\S]*?\n\}\n/m)?.[0];
}

/** The lines of `file` that run apt-get outside its own apt_get. */
function bare(file: string): { line: number; text: string }[] {
  return code(file)
    .replace(aptGet(file) ?? '', '')
    .split('\n')
    .map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter(({ text }) => APT_GET.test(text));
}

describe('install.sh and every deploy/*.sh, on every apt-get going through apt_get', () => {
  const scripts = installScripts();

  it('reads the install scripts from git, the one-command install and deploy/install.sh among them', () => {
    expect(scripts).toEqual(
      expect.arrayContaining(['install.sh', 'deploy/install.sh']),
    );
  });

  it.each(
    scripts.filter((file) => !EXEMPT.some((exempt) => exempt.file === file)),
  )('runs apt-get in %s only through its apt_get', (file) => {
    expect({ file, bare: bare(file) }).toEqual({ file, bare: [] });
  });

  it.each(scripts.filter((file) => aptGet(file)))(
    'calls the apt_get %s declares',
    (file) => {
      const outside = code(file).replace(aptGet(file) ?? '', '');
      expect(outside).toMatch(/(^|\s)apt_get (update|install)/m);
    },
  );

  it('exempts only scripts that are install scripts and run a bare apt-get', () => {
    const stale = EXEMPT.filter(
      (exempt) =>
        !scripts.includes(exempt.file) || bare(exempt.file).length === 0,
    );

    expect(stale).toEqual([]);
  });
});
