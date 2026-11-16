import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `deploy/finish-banner.sh`: the mark, the next step beside it and the
 * logotype under it, which `deploy/install.sh` ends a successful run with.
 * Driven by sourcing the file, as install.sh does.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const library = path.join(repoRoot, 'deploy/finish-banner.sh');
const installer = path.join(repoRoot, 'deploy/install.sh');

/** Runs `script` in bash with the library sourced; stdout is a pipe here. */
function run(
  script: string,
  env: Record<string, string> = {},
  args: string[] = [],
) {
  return spawnSync(
    'bash',
    ['-euc', `. "$LIBRARY"; ${script}`, 'bash', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LIBRARY: library,
        ...env,
      },
    },
  );
}

const SELF_HOSTED = [
  'Cloudgate 0.3.4 is installed.',
  '',
  'Open http://203.0.113.7:3000/sign-up',
  'The first account owns the instance.',
];

describe('deploy/finish-banner.sh', () => {
  it('sets the lines beside the mark and the logotype under it', () => {
    const banner = run('finish_banner "$@"', {}, SELF_HOSTED);

    expect(banner.status).toBe(0);
    expect(banner.stdout).toBe(
      [
        '',
        '      ▄████▄        Cloudgate 0.3.4 is installed.',
        '  ▄▄█ ███████▄',
        ' ▄███▄█▀██ ████     Open http://203.0.113.7:3000/sign-up',
        '██████████▄█████    The first account owns the instance.',
        '▀██████████████▀',
        '',
        '      _                 _             _',
        '  ___| | ___  _   _  __| | __ _  __ _| |_ ___',
        ' / __| |/ _ \\| | | |/ _` |/ _` |/ _` | __/ _ \\',
        '| (__| | (_) | |_| | (_| | (_| | (_| | ||  __/',
        ' \\___|_|\\___/ \\__,_|\\__,_|\\__, |\\__,_|\\__\\___|',
        '                          |___/',
        '',
      ].join('\n'),
    );
  });

  it('fits an 80-column terminal with the longest IPv4 address', () => {
    // A longer hostname or an IPv6 address wraps its own line, never the art.
    const banner = run('finish_banner "$@"', {}, [
      'Cloudgate 10.10.10 is installed.',
      '',
      'Open http://255.255.255.255:3000/sign-up',
      'The first account owns the instance.',
    ]);

    for (const line of banner.stdout.split('\n')) {
      expect([...line].length).toBeLessThanOrEqual(80);
    }
  });

  it('draws in no colour when stdout is not a terminal, whatever the terminal says', () => {
    const banner = run(
      'finish_banner_colour; finish_banner "$@"',
      {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
      SELF_HOSTED,
    );

    expect(banner.stdout).not.toContain('\u001b[');
  });

  it('draws the mark and the logotype in the brand colour and the lines beside it plain', () => {
    const banner = run(
      `FINISH_BANNER_COLOUR=$'\\033[38;5;62m'; finish_banner "$@"`,
      {},
      SELF_HOSTED,
    );
    const lines = banner.stdout.split('\n');

    expect(lines[1]).toBe(
      '\u001b[38;5;62m      ▄████▄    \u001b[0m    Cloudgate 0.3.4 is installed.',
    );
    expect(lines[2]).toBe('\u001b[38;5;62m  ▄▄█ ███████▄\u001b[0m');
    expect(lines[8]).toBe(
      '\u001b[38;5;62m  ___| | ___  _   _  __| | __ _  __ _| |_ ___\u001b[0m',
    );
  });

  it.each([
    [
      'a terminal that takes 24-bit colour',
      { COLORTERM: 'truecolor' },
      '\u001b[38;2;109;87;224m',
    ],
    ['a 256-colour terminal', {}, '\u001b[38;5;62m'],
    ['NO_COLOR', { NO_COLOR: '1' }, ''],
    ['a dumb terminal', { TERM: 'dumb' }, ''],
  ])('picks the colour for %s', (_, env, colour) => {
    // `script` gives the run a terminal for its stdout, as `curl | sudo sh` has.
    const picked = spawnSync(
      'script',
      [
        '-qec',
        'bash -c \'. "$LIBRARY"; finish_banner_colour; printf "<%s>" "$FINISH_BANNER_COLOUR"\'',
        '/dev/null',
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          LIBRARY: library,
          TERM: 'xterm-256color',
          ...env,
        },
      },
    );
    if (picked.error) return; // no util-linux `script` on this machine

    expect(picked.stdout).toContain(`<${colour}>`);
  });

  it('is decided before install.sh copies its output into the log, and drawn last', () => {
    const source = fs.readFileSync(installer, 'utf8');

    expect(source).toContain('. "$REPO_ROOT/deploy/finish-banner.sh"');
    expect(source).toMatch(/\nfinish_banner_colour\nstart_install_log\n/);
    expect(source.trimEnd().split('\n').at(-1)).toBe(
      'finish_banner "${finish[@]}"',
    );
  });
});
