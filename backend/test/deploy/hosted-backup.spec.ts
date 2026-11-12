import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The Hosted instance's hourly backup: `deploy/hosted-backup.sh` run
 * as its systemd units run it, with `runuser`, `pg_dump`, `age`, `rclone` and
 * `curl` stubbed on PATH. The rclone stub keeps the "B2 bucket" as a directory
 * and refuses to list a folder that does not exist, as B2 does; the age stub
 * writes a header naming the recipient ahead of what it was given, so a test
 * can both see what was encrypted to whom and read it back.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const script = path.join(repoRoot, 'deploy/hosted-backup.sh');
const units = path.join(repoRoot, 'deploy/systemd');

const RECIPIENT =
  'age197feh04jwuq47j0j0jd2fj606jw9947pecg993n53s85s4nzf36s90cs0w';

/** What install.sh keeps in /etc/default/cloudgate-hosted, the backup's part. */
const KEPT_INPUTS: Record<string, string> = {
  CLOUDGATE_HOSTNAME: 'cloudgate.octabyte.app',
  MAIL_FROM_ADDRESS: 'Cloudgate <hello@cloudgate.octabyte.app>',
  RESEND_API_KEY: 're_cloudgate',
  BACKUP_B2_KEY_ID: '0051a2b3c4d5e6f0000000001',
  BACKUP_B2_APPLICATION_KEY: 'K005cloudgatebackupkey',
  BACKUP_B2_BUCKET: 'octabyte-cloudgate-backups',
  BACKUP_B2_FOLDER: 'live',
  BACKUP_AGE_RECIPIENT: RECIPIENT,
  BACKUP_ALERT_EMAIL: 'ops@octabyte.app',
};

const STUBS: Record<string, string> = {
  runuser: `#!/usr/bin/env bash
[ "$1" = -u ] && [ "$3" = -- ] || { echo "runuser stub: $*" >&2; exit 2; }
echo "$2" > "$STUB_LOG/runuser-user"
shift 3
exec "$@"
`,
  pg_dump: `#!/usr/bin/env bash
echo "$*" > "$STUB_LOG/pg_dump-args"
[ -z "\${PG_DUMP_FAILS:-}" ] || { echo "pg_dump: connection refused" >&2; exit 1; }
printf 'PGDMP custom-format dump of %s\\n' "$*"
`,
  age: `#!/usr/bin/env bash
[ "$1" = --encrypt ] && [ "$2" = --recipient ] && [ "$4" = --output ] || { echo "age stub: $*" >&2; exit 2; }
{ printf 'age-stub recipient=%s\\n' "$3"; cat; } > "$5"
`,
  // cloudgateb2:<bucket>/<path> is $FAKE_B2/<bucket>/<path>.
  rclone: `#!/usr/bin/env bash
set -euo pipefail
local_path() { case "$1" in cloudgateb2:*) echo "$FAKE_B2/\${1#cloudgateb2:}" ;; *) echo "$1" ;; esac; }
printf '%s hard_delete=%s account=%s key=%s\\n' "$*" "\${RCLONE_CONFIG_CLOUDGATEB2_HARD_DELETE:-}" \\
  "\${RCLONE_CONFIG_CLOUDGATEB2_ACCOUNT:-}" "\${RCLONE_CONFIG_CLOUDGATEB2_KEY:-}" >> "$STUB_LOG/rclone"
case "$1" in
  copy)
    [ -z "\${RCLONE_FAILS:-}" ] || { echo "rclone: 401 unauthorized" >&2; exit 1; }
    src="$(local_path "$2")"; dst="$(local_path "$3")"
    mkdir -p "$dst"; cp -R "$src"/. "$dst"/ ;;
  lsf)
    [ "$2" = --dirs-only ] || exit 2
    dir="$(local_path "$3")"
    [ -d "$dir" ] || { echo "directory not found" >&2; exit 3; }
    for d in "$dir"/*/; do [ -d "$d" ] && basename "$d" | sed 's:$:/:'; done; true ;;
  purge)
    dir="$(local_path "$2")"; [ -d "$dir" ] || exit 3; rm -rf "$dir" ;;
  *) echo "rclone stub: $*" >&2; exit 2 ;;
esac
`,
  curl: `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$STUB_LOG/curl-args"
while [ $# -gt 0 ]; do
  [ "$1" = --config ] && cat "$2" > "$STUB_LOG/curl-config"
  shift
done
cat > "$STUB_LOG/curl-body"
`,
  // \`date -u +%s\` answers FAKE_NOW when it is set; everything else is date.
  date: `#!/usr/bin/env bash
if [ -n "\${FAKE_NOW:-}" ] && [ "$*" = "-u +%s" ]; then echo "$FAKE_NOW"; exit 0; fi
exec /usr/bin/date "$@"
`,
};

let scratch: string;
let bin: string;
let box: string; // the fake filesystem root the config tarball is taken from
let b2: string;
let stubLog: string;
let state: string;
let inputsFile: string;

/** 2026-11-04T13:00:00Z */
const NOW = 1793797200;
const NOW_NAME = '2026-11-04T13-00-00Z';
const live = () => path.join(b2, 'octabyte-cloudgate-backups', 'live');

function writeInputs(inputs: Record<string, string>) {
  fs.writeFileSync(
    inputsFile,
    '# kept by install.sh\n' +
      Object.entries(inputs)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(''),
    { mode: 0o600 },
  );
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-backup-'));
  bin = path.join(scratch, 'bin');
  box = path.join(scratch, 'box');
  b2 = path.join(scratch, 'b2');
  stubLog = path.join(scratch, 'log');
  state = path.join(scratch, 'state');
  inputsFile = path.join(box, 'etc/default/cloudgate-hosted');
  for (const dir of [bin, b2, stubLog, path.join(box, 'etc/default')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  fs.mkdirSync(path.join(box, 'etc/cloudgate/traefik/dynamic'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(box, 'etc/cloudgate/traefik/dynamic/hosted.yml'),
    'http: {}\n',
  );
  for (const name of ['backend', 'console', 'secrets']) {
    fs.writeFileSync(
      path.join(box, `etc/default/cloudgate-${name}`),
      `${name}=1\n`,
    );
  }
  writeInputs(KEPT_INPUTS);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function backup(command: string, extra: Record<string, string> = {}) {
  return spawnSync('bash', [script, command], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: scratch,
      TMPDIR: scratch,
      STUB_LOG: stubLog,
      FAKE_B2: b2,
      FAKE_NOW: String(NOW),
      BACKUP_INPUTS_FILE: inputsFile,
      BACKUP_STATE_DIR: state,
      BACKUP_FS_ROOT: box,
      ...extra,
    },
    encoding: 'utf8',
  });
}

/** Run folders under live/<kind>, oldest first. */
function runs(kind: 'hourly' | 'daily'): string[] {
  const dir = path.join(live(), kind);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

/** A run folder already in the bucket, as an earlier run left it. */
function seed(kind: 'hourly' | 'daily', name: string) {
  const dir = path.join(live(), kind, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cloudgate.dump.age'), 'old');
  fs.writeFileSync(path.join(dir, 'cloudgate-config.tar.gz.age'), 'old');
}

/** The age stub's header off, what was encrypted. */
function decrypt(file: string): { recipient: string; plain: Buffer } {
  const content = fs.readFileSync(file);
  const newline = content.indexOf(0x0a);
  return {
    recipient: content
      .subarray(0, newline)
      .toString()
      .replace('age-stub recipient=', ''),
    plain: content.subarray(newline + 1),
  };
}

/** What the check posted to Resend. */
function alertBody(): Record<string, unknown> & { text: string } {
  return JSON.parse(
    fs.readFileSync(path.join(stubLog, 'curl-body'), 'utf8'),
  ) as Record<string, unknown> & { text: string };
}

function stamp(epoch: number, name: string) {
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'last-success'), `${epoch} ${name}\n`);
}

describe('deploy/hosted-backup.sh run', () => {
  it('uploads two age-encrypted files, the database dump and the config tarball, to the instance’s B2 folder', () => {
    const run = backup('run');
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);

    expect(runs('hourly')).toEqual([NOW_NAME]);
    const folder = path.join(live(), 'hourly', NOW_NAME);
    expect(fs.readdirSync(folder).sort()).toEqual([
      'cloudgate-config.tar.gz.age',
      'cloudgate.dump.age',
    ]);

    const dump = decrypt(path.join(folder, 'cloudgate.dump.age'));
    expect(dump.recipient).toBe(RECIPIENT);
    expect(dump.plain.toString()).toBe(
      'PGDMP custom-format dump of -Fc cloudgate\n',
    );
    expect(fs.readFileSync(path.join(stubLog, 'runuser-user'), 'utf8')).toBe(
      'postgres\n',
    );

    const config = decrypt(path.join(folder, 'cloudgate-config.tar.gz.age'));
    expect(config.recipient).toBe(RECIPIENT);
    const tarball = path.join(scratch, 'config.tar.gz');
    fs.writeFileSync(tarball, config.plain);
    const listing = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    expect(listing.stdout.split('\n')).toEqual(
      expect.arrayContaining([
        'etc/cloudgate/traefik/dynamic/hosted.yml',
        'etc/default/cloudgate-backend',
        'etc/default/cloudgate-console',
        'etc/default/cloudgate-secrets',
        'etc/default/cloudgate-hosted',
      ]),
    );

    // Nothing is left on the box but the success it records.
    expect(
      fs.readdirSync(scratch).filter((f) => f.startsWith('cloudgate-backup.')),
    ).toEqual([]);
    expect(fs.readFileSync(path.join(state, 'last-success'), 'utf8')).toBe(
      `${NOW} ${NOW_NAME}\n`,
    );
  });

  it('hands rclone the B2 key in its environment, with hard deletes, and never on the command line', () => {
    expect(backup('run').status).toBe(0);
    const calls = fs
      .readFileSync(path.join(stubLog, 'rclone'), 'utf8')
      .trim()
      .split('\n');

    for (const call of calls) {
      const [argv] = call.split(' hard_delete=');
      expect(argv).not.toContain(KEPT_INPUTS.BACKUP_B2_APPLICATION_KEY);
      expect(call).toContain(
        ` hard_delete=true account=${KEPT_INPUTS.BACKUP_B2_KEY_ID} key=${KEPT_INPUTS.BACKUP_B2_APPLICATION_KEY}`,
      );
    }
  });

  it('keeps the first run of each UTC day as that day’s daily copy, and only the first', () => {
    seed('daily', '2026-11-03T23-00-00Z');

    expect(backup('run').status).toBe(0);
    expect(runs('daily')).toEqual(['2026-11-03T23-00-00Z', NOW_NAME]);
    expect(fs.readdirSync(path.join(live(), 'daily', NOW_NAME)).sort()).toEqual(
      ['cloudgate-config.tar.gz.age', 'cloudgate.dump.age'],
    );

    // An hour later the day already has its copy.
    expect(backup('run', { FAKE_NOW: String(NOW + 3600) }).status).toBe(0);
    expect(runs('hourly')).toEqual([NOW_NAME, '2026-11-04T14-00-00Z']);
    expect(runs('daily')).toEqual(['2026-11-03T23-00-00Z', NOW_NAME]);
  });

  it('keeps the newest 48 hourly and 30 daily copies and removes the rest', () => {
    const hour = (n: number) =>
      new Date((NOW - n * 3600) * 1000)
        .toISOString()
        .replace(/\.\d+Z$/, 'Z')
        .replace(/:/g, '-');
    const day = (n: number) =>
      new Date((NOW - n * 86400 - 3600) * 1000)
        .toISOString()
        .replace(/\.\d+Z$/, 'Z')
        .replace(/:/g, '-');
    for (let n = 1; n <= 60; n++) seed('hourly', hour(n));
    for (let n = 1; n <= 40; n++) seed('daily', day(n));
    // Not a run: never listed, never removed.
    fs.mkdirSync(path.join(live(), 'hourly', 'restore-drill'));

    const run = backup('run');
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);

    const hourly = runs('hourly').filter((name) => name !== 'restore-drill');
    expect(hourly).toHaveLength(48);
    expect(hourly[hourly.length - 1]).toBe(NOW_NAME);
    expect(hourly[0]).toBe(hour(47));
    expect(fs.existsSync(path.join(live(), 'hourly', 'restore-drill'))).toBe(
      true,
    );

    const daily = runs('daily');
    expect(daily).toHaveLength(30);
    expect(daily[daily.length - 1]).toBe(NOW_NAME);
    expect(daily[0]).toBe(day(29));
  });

  it('records no success and uploads nothing when the dump fails', () => {
    const run = backup('run', { PG_DUMP_FAILS: '1' });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('pg_dump: connection refused');
    expect(runs('hourly')).toEqual([]);
    expect(fs.existsSync(path.join(state, 'last-success'))).toBe(false);
  });

  it('records no success when the upload fails', () => {
    stamp(NOW - 7200, '2026-11-04T11-00-00Z');
    const run = backup('run', { RCLONE_FAILS: '1' });

    expect(run.status).not.toBe(0);
    expect(fs.readFileSync(path.join(state, 'last-success'), 'utf8')).toBe(
      `${NOW - 7200} 2026-11-04T11-00-00Z\n`,
    );
  });

  it('refuses, naming it, while a backup input is not kept', () => {
    const { BACKUP_AGE_RECIPIENT, ...rest } = KEPT_INPUTS;
    void BACKUP_AGE_RECIPIENT;
    writeInputs(rest);

    const run = backup('run');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      `BACKUP_AGE_RECIPIENT is not set in ${inputsFile}`,
    );
    expect(fs.existsSync(path.join(stubLog, 'rclone'))).toBe(false);
  });
});

describe('deploy/hosted-backup.sh check', () => {
  it('is quiet while the last success is no more than 3 hours old', () => {
    stamp(NOW - 3 * 3600, '2026-11-04T10-00-00Z');

    const run = backup('check');

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      '2026-11-04T10-00-00Z succeeded 180 minutes ago',
    );
    expect(fs.existsSync(path.join(stubLog, 'curl-args'))).toBe(false);
  });

  it('mails ops through Resend, and fails, once the last success is more than 3 hours old', () => {
    stamp(NOW - 3 * 3600 - 60, '2026-11-04T09-59-00Z');

    const run = backup('check');

    expect(run.status).toBe(1);
    const args = fs.readFileSync(path.join(stubLog, 'curl-args'), 'utf8');
    expect(args).toContain('https://api.resend.com/emails');
    // The key reaches curl in its config, not its argv.
    expect(args).not.toContain(KEPT_INPUTS.RESEND_API_KEY);
    expect(fs.readFileSync(path.join(stubLog, 'curl-config'), 'utf8')).toBe(
      `header = "Authorization: Bearer ${KEPT_INPUTS.RESEND_API_KEY}"\n`,
    );
    const body = alertBody();
    expect(body).toMatchObject({
      from: KEPT_INPUTS.MAIL_FROM_ADDRESS,
      to: [KEPT_INPUTS.BACKUP_ALERT_EMAIL],
      subject: 'Cloudgate backups are stale on cloudgate.octabyte.app',
    });
    expect(body.text).toContain(
      'No Cloudgate backup has succeeded for 3 hours. The last one that did is 2026-11-04T09-59-00Z.',
    );
  });

  it('alerts when no backup has ever succeeded', () => {
    const run = backup('check');

    expect(run.status).toBe(1);
    const body = alertBody();
    expect(body.text).toContain(
      'No Cloudgate backup has ever succeeded on this box.',
    );
  });

  it('is satisfied by the success a run records', () => {
    expect(backup('run').status).toBe(0);
    expect(backup('check', { FAKE_NOW: String(NOW + 3600) }).status).toBe(0);
  });
});

describe('deploy/systemd backup units', () => {
  const unit = (name: string) =>
    fs.readFileSync(path.join(units, name), 'utf8');

  it('run the backup hourly and the staleness check hourly, from the script in the checkout', () => {
    expect(unit('cloudgate-backup.timer')).toMatch(/^OnCalendar=hourly$/m);
    expect(unit('cloudgate-backup.timer')).toMatch(/^Persistent=true$/m);
    expect(unit('cloudgate-backup-check.timer')).toMatch(
      /^OnCalendar=\*-\*-\* \*:30:00$/m,
    );
    expect(unit('cloudgate-backup.service')).toMatch(
      /^ExecStart=\/bin\/bash \/opt\/cloudgate\/deploy\/hosted-backup\.sh run$/m,
    );
    expect(unit('cloudgate-backup-check.service')).toMatch(
      /^ExecStart=\/bin\/bash \/opt\/cloudgate\/deploy\/hosted-backup\.sh check$/m,
    );
    // The state directory both read is the script's default.
    for (const name of [
      'cloudgate-backup.service',
      'cloudgate-backup-check.service',
    ]) {
      expect(unit(name)).toMatch(/^StateDirectory=cloudgate-backup$/m);
    }
    expect(fs.readFileSync(script, 'utf8')).toContain(
      'BACKUP_STATE_DIR="${BACKUP_STATE_DIR:-/var/lib/cloudgate-backup}"',
    );
  });

  it('are every unit file install.sh installs, and install.sh enables both timers', () => {
    const installer = fs.readFileSync(
      path.join(repoRoot, 'deploy/install.sh'),
      'utf8',
    );
    for (const name of fs.readdirSync(units)) {
      expect(installer).toContain(name);
    }
    expect(installer).toContain(
      'systemctl enable --now cloudgate-backup.timer cloudgate-backup-check.timer',
    );
    expect(installer).toContain('systemctl start cloudgate-backup.service');
  });
});
