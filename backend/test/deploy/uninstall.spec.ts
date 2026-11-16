import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../src/db/schema';

/**
 * `deploy/uninstall.sh`, which takes Cloudgate off the platform host and keeps
 * the instance (its database, secrets and dumps) unless it is run with
 * `--purge`, driven against a scratch host.
 *
 * The boundaries are shimmed, as `one-command-install.spec.ts` shims them:
 * `systemctl` and `docker` record each call (`docker container inspect` finds
 * `cloudgate-traefik` while the test says it runs, and the host's Swarm
 * services and containers are the ones `SERVICES` and `CONTAINERS` name), `su`
 * runs the command it is handed, `psql` records its arguments and the SQL it
 * reads and answers a query with the names `APP_NAMES` holds, and `id` says
 * the run is root. `INSTALL_ROOT` points every path the script touches into
 * scratch.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const script = path.join(repoRoot, 'deploy/uninstall.sh');

const UNITS = ['cloudgate-backend.service', 'cloudgate-console.service'];
const HOSTED_UNITS = [
  'cloudgate-backup.service',
  'cloudgate-backup.timer',
  'cloudgate-backup-check.service',
  'cloudgate-backup-check.timer',
];

let scratch: string;
let root: string;
let calls: string;
let bin: string;
let traefik: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-'));
  root = path.join(scratch, 'root');
  calls = path.join(scratch, 'calls');
  bin = path.join(scratch, 'bin');
  traefik = path.join(scratch, 'traefik-runs');
  fs.mkdirSync(bin);
  shim(
    'systemctl',
    `echo "systemctl $*" >> "${calls}"
if [ "$1" = is-active ]; then
  for unit in \${ACTIVE_UNITS:-}; do [ "$unit" = "$3" ] && exit 0; done
  exit 3
fi`,
  );
  // SERVICES holds `name|stack namespace` and CONTAINERS `name|Compose
  // project`, space-separated: what `docker service inspect` and `docker ps`
  // print with the uninstall's formats.
  shim(
    'docker',
    `if [ "$1 $2" = "container inspect" ]; then [ -e "${traefik}" ]; exit; fi
echo "docker $*" >> "${calls}"
[ "$1 $2 $3" = "rm -f cloudgate-traefik" ] && rm -f "${traefik}"
case "$1 $2" in
  "service ls") for entry in \${SERVICES:-}; do echo "\${entry%%|*}"; done ;;
  "service inspect") for entry in \${SERVICES:-}; do echo "$entry"; done ;;
  "ps -a") for entry in \${CONTAINERS:-}; do echo "$entry"; done ;;
esac
exit 0`,
  );
  shim('su', `echo "su $1 $2" >> "${calls}"\nexec sh -c "$4"`);
  shim(
    'psql',
    `echo "psql $*" >> "${calls}"
cat >> "${calls}"
case " $* " in *" -tA "*) for name in \${APP_NAMES:-}; do echo "$name"; done ;; esac`,
  );
  // `id -u` says who runs it; `id <user>` finds only the users the test says
  // exist.
  shim(
    'id',
    `if [ "$1" = -u ]; then echo "\${UID_IS:-0}"; exit 0; fi
for user in \${USERS:-}; do [ "$user" = "$1" ] && exit 0; done
exit 1`,
  );
  shim('userdel', `echo "userdel $*" >> "${calls}"`);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function shim(name: string, body: string) {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, {
    mode: 0o755,
  });
}

/** Writes `content` at `file`, a path on the scratch host. */
function put(file: string, content = '') {
  const at = path.join(root, file);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, content);
}

const BACKEND_ENV =
  'NODE_ENV=production\nDATABASE_URL=postgresql://cloudgate:pw@127.0.0.1:5432/cloudgate\n';
const CONSOLE_ENV =
  'NODE_ENV=production\nPORT=3000\nCLOUDGATE_API_URL=http://203.0.113.10:4000\n';

/**
 * A Self-hosted platform host as deploy/install.sh leaves it after an upgrade
 * that stopped before its health check: the version, the one it replaced and
 * a staged one, Cloudgate's own Node, OpenTofu and plugin, both units, the
 * env files, the platform directory, a dump, and Traefik running.
 */
function installed() {
  put('opt/cloudgate/VERSION', '0.10.0\n');
  put('opt/cloudgate/deploy/install.sh');
  put('opt/cloudgate.previous/VERSION', '0.9.0\n');
  put('opt/cloudgate.next/VERSION', '0.11.0\n');
  put('usr/local/share/cloudgate/node/bin/node');
  put('usr/local/share/cloudgate/opentofu/bin/tofu');
  put(
    'usr/local/share/cloudgate/session-manager-plugin/bin/session-manager-plugin',
  );
  // The operator's own, beside Cloudgate's.
  put('usr/local/bin/tofu', 'mine\n');
  put('opt/mine/notes', 'mine\n');
  for (const unit of UNITS) put(`etc/systemd/system/${unit}`, '[Unit]\n');
  put('etc/systemd/system/sshd.service', '[Unit]\n');
  put('etc/default/cloudgate-backend', BACKEND_ENV);
  put('etc/default/cloudgate-console', CONSOLE_ENV);
  put('etc/default/cloudgate-secrets', 'PGPW=pw\n');
  put('etc/default/ufw', 'IPV6=yes\n');
  put('etc/cloudgate/traefik/traefik.yml', 'entryPoints: {}\n');
  put('var/backups/cloudgate/pre-0.10.0-20261114T120000Z.dump', 'dump\n');
  put('var/log/cloudgate/install-20261114T120000Z.log', 'log\n');
  fs.writeFileSync(traefik, '');
}

/**
 * What deploy/hosted-update-access.sh adds on the Hosted instance: the
 * updater, its one sudoers line, and the cloudgate-deploy user whose home
 * holds the key that can run only that updater.
 */
const REMOTE_UPDATER = [
  'usr/local/sbin/cloudgate-update',
  'etc/sudoers.d/cloudgate-deploy',
  'var/lib/cloudgate-deploy/.ssh/authorized_keys',
];
function remoteUpdater() {
  for (const file of REMOTE_UPDATER) put(file, 'hosted\n');
}

/**
 * What the instance deployed on the platform host: an Application and a
 * Database by their Swarm service's name, a Swarm Compose stack by its
 * services' stack namespace, a Docker Compose stack by its containers'
 * project. `my-own` and `my-own-web-1` are the operator's, in no table.
 */
const DEPLOYED = {
  env: {
    APP_NAMES: 'app-r42a2o postgres-k2m9x4 compose-q7w3e1 compose-z8v6b5',
    SERVICES:
      'app-r42a2o| postgres-k2m9x4| compose-q7w3e1_web|compose-q7w3e1 my-own|',
    CONTAINERS: 'compose-z8v6b5-web-1|compose-z8v6b5 my-own-web-1|my-own',
  },
};

/** Runs the script on the scratch host with `args`, `input` on its stdin. */
function uninstall(
  args: string[] = [],
  options: { input?: string; env?: Record<string, string> } = {},
) {
  return spawnSync('bash', [script, ...args], {
    input: options.input ?? '',
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: scratch,
      INSTALL_ROOT: root,
      ...options.env,
    },
  });
}

function called(): string[] {
  return fs.existsSync(calls)
    ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean)
    : [];
}

function exists(file: string): boolean {
  return fs.existsSync(path.join(root, file));
}

/** Every file on the scratch host, with its content, for "changes nothing". */
function snapshot(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else files[path.relative(root, at)] = fs.readFileSync(at, 'utf8');
    }
  };
  walk(root);
  return files;
}

describe('deploy/uninstall.sh', () => {
  describe('the default run, which keeps the instance', () => {
    it('stops and disables both units, removes their unit files and reloads systemd', () => {
      installed();

      const ran = uninstall();

      expect(ran.stderr).toBe('');
      expect(ran.status).toBe(0);
      const systemctl = called().filter((line) =>
        line.startsWith('systemctl '),
      );
      expect(systemctl).toEqual(
        expect.arrayContaining([
          'systemctl disable --now cloudgate-backend.service',
          'systemctl disable --now cloudgate-console.service',
        ]),
      );
      expect(systemctl.at(-1)).toBe('systemctl daemon-reload');
      for (const unit of UNITS) {
        expect(exists(`etc/systemd/system/${unit}`)).toBe(false);
      }
      expect(exists('etc/systemd/system/sshd.service')).toBe(true);
    });

    it('stops, disables and removes the Hosted backup units when they are present', () => {
      installed();
      for (const unit of HOSTED_UNITS) {
        put(`etc/systemd/system/${unit}`, '[Unit]\n');
      }

      const ran = uninstall();

      expect(ran.status).toBe(0);
      for (const unit of HOSTED_UNITS) {
        expect(called()).toContain(`systemctl disable --now ${unit}`);
        expect(exists(`etc/systemd/system/${unit}`)).toBe(false);
      }
      const systemctl = called().filter((line) =>
        line.startsWith('systemctl '),
      );
      expect(systemctl.at(-1)).toBe('systemctl daemon-reload');
    });

    it('stops and disables no Hosted unit on a Self-hosted box', () => {
      installed();

      expect(uninstall().status).toBe(0);

      expect(
        called().filter((line) =>
          /(disable|stop) .*cloudgate-(backup|update)/.test(line),
        ),
      ).toEqual([]);
    });

    // cloudgate-update.service is transient (deploy/hosted-update.sh): it has
    // no unit file, and a run of it left going would install Cloudgate again.
    it('stops a Hosted update that is running before anything else', () => {
      installed();

      const ran = uninstall([], {
        env: { ACTIVE_UNITS: 'cloudgate-update.service' },
      });

      expect(ran.status).toBe(0);
      expect(called()[0]).toBe(
        'systemctl is-active --quiet cloudgate-update.service',
      );
      expect(called()[1]).toBe('systemctl stop cloudgate-update.service');
    });

    // Left in place, the next green tag's deploy would log in with the key and
    // run the updater, which installs Cloudgate again.
    it('removes the Hosted remote updater: cloudgate-update, its sudoers line, and the cloudgate-deploy user with its home', () => {
      installed();
      remoteUpdater();

      const ran = uninstall([], { env: { USERS: 'cloudgate-deploy' } });

      expect(ran.stderr).toBe('');
      expect(ran.status).toBe(0);
      for (const gone of [...REMOTE_UPDATER, 'var/lib/cloudgate-deploy']) {
        expect({ gone, exists: exists(gone) }).toEqual({ gone, exists: false });
      }
      expect(called()).toContain('userdel --remove cloudgate-deploy');
      // Before the units, so no deploy can start while they go.
      expect(
        called().indexOf('userdel --remove cloudgate-deploy'),
      ).toBeLessThan(
        called().indexOf('systemctl disable --now cloudgate-backend.service'),
      );
      expect(ran.stdout).toContain('cloudgate-deploy');
    });

    it('removes no user and no sudoers line on a Self-hosted box', () => {
      installed();
      put('etc/sudoers.d/operator', 'mine\n');

      expect(uninstall().status).toBe(0);

      expect(called().filter((line) => line.startsWith('userdel'))).toEqual([]);
      expect(exists('etc/sudoers.d/operator')).toBe(true);
    });

    // A reinstall on the kept instance manages them again.
    it('lists, asks about and removes nothing the instance deployed', () => {
      installed();

      const ran = uninstall([], DEPLOYED);

      expect(ran.status).toBe(0);
      expect(ran.stdout).not.toContain('app-r42a2o');
      expect(called().join('\n')).not.toMatch(
        /docker (service|ps)|service rm|-tA/,
      );
    });
  });

  describe('what it removes and what it keeps', () => {
    it('removes the cloudgate-traefik container after both units have stopped', () => {
      installed();

      expect(uninstall().status).toBe(0);

      expect(called()).toContain('docker rm -f cloudgate-traefik');
      expect(
        called().indexOf('docker rm -f cloudgate-traefik'),
      ).toBeGreaterThan(
        called().indexOf('systemctl disable --now cloudgate-backend.service'),
      );
      expect(fs.existsSync(traefik)).toBe(false);
    });

    it('removes /opt/cloudgate with its .previous and .next, and /usr/local/share/cloudgate', () => {
      installed();

      expect(uninstall().status).toBe(0);

      for (const gone of [
        'opt/cloudgate',
        'opt/cloudgate.previous',
        'opt/cloudgate.next',
        'usr/local/share/cloudgate',
      ]) {
        expect({ gone, exists: exists(gone) }).toEqual({ gone, exists: false });
      }
      // The operator's own files beside them.
      expect(exists('opt/mine/notes')).toBe(true);
      expect(exists('usr/local/bin/tofu')).toBe(true);
    });

    it('keeps the database, /etc/default/cloudgate-*, /etc/cloudgate, /var/backups/cloudgate and /var/log/cloudgate, naming each', () => {
      installed();

      const ran = uninstall();

      expect(ran.status).toBe(0);
      expect(called().filter((line) => /^(su|psql) /.test(line))).toEqual([]);
      expect(
        fs.readFileSync(
          path.join(root, 'etc/default/cloudgate-backend'),
          'utf8',
        ),
      ).toBe(BACKEND_ENV);
      for (const kept of [
        'etc/default/cloudgate-console',
        'etc/default/cloudgate-secrets',
        'etc/cloudgate/traefik/traefik.yml',
        'var/backups/cloudgate/pre-0.10.0-20261114T120000Z.dump',
        'var/log/cloudgate/install-20261114T120000Z.log',
      ]) {
        expect({ kept, exists: exists(kept) }).toEqual({ kept, exists: true });
      }
      for (const named of [
        'the cloudgate database',
        'cloudgate_state',
        `${root}/etc/default/cloudgate-backend`,
        `${root}/etc/default/cloudgate-console`,
        `${root}/etc/default/cloudgate-secrets`,
        `${root}/etc/cloudgate`,
        `${root}/var/backups/cloudgate`,
        `${root}/var/log/cloudgate`,
      ]) {
        expect(ran.stdout).toContain(named);
      }
    });

    it('names what it leaves in place: Docker, Postgres, the swarm, cloudgate-network, ufw and the cloudgate user', () => {
      installed();

      const ran = uninstall();

      expect(ran.status).toBe(0);
      const closing = ran.stdout.slice(ran.stdout.lastIndexOf('==>'));
      for (const left of [
        'Docker',
        'Postgres',
        'swarm',
        'cloudgate-network',
        'ufw',
        'cloudgate user',
      ]) {
        expect(closing).toContain(left);
      }
      expect(called().join('\n')).not.toMatch(
        /swarm leave|network rm|ufw|userdel|apt-get/,
      );
    });

    it('leaves a git checkout an earlier install moved aside, and names it', () => {
      installed();
      put('opt/cloudgate.checkout-2026-11-01/backend/package.json', '{}\n');

      const ran = uninstall();

      expect(ran.status).toBe(0);
      expect(
        exists('opt/cloudgate.checkout-2026-11-01/backend/package.json'),
      ).toBe(true);
      expect(ran.stdout).toContain(`${root}/opt/cloudgate.checkout-2026-11-01`);
    });

    it('finishes a second run, on a platform host it has already uninstalled', () => {
      installed();
      expect(uninstall().status).toBe(0);
      fs.rmSync(calls);

      const again = uninstall();

      expect(again.stderr).toBe('');
      expect(again.status).toBe(0);
      expect(called()).not.toContain('docker rm -f cloudgate-traefik');
    });
  });

  describe('--purge', () => {
    const INSTANCE = [
      'etc/default/cloudgate-backend',
      'etc/default/cloudgate-console',
      'etc/default/cloudgate-secrets',
      'etc/cloudgate',
      'var/backups/cloudgate',
      'var/log/cloudgate',
    ];

    /** The SQL psql was handed, one statement a line, in order. */
    function sql(): string[] {
      return called().filter((line) => /^DROP /.test(line));
    }

    it('asks for the public host, and on an exact match drops the database and both roles and removes the env files, /etc/cloudgate, the dumps and the install logs', () => {
      installed();

      const ran = uninstall(['--purge'], { input: '203.0.113.10\n' });

      expect(ran.stderr).toBe('');
      expect(ran.status).toBe(0);
      expect(ran.stdout).toContain('203.0.113.10');
      expect(called()).toContain('su - postgres');
      expect(sql()).toEqual([
        'DROP DATABASE IF EXISTS cloudgate WITH (FORCE);',
        'DROP ROLE IF EXISTS cloudgate_state;',
        'DROP ROLE IF EXISTS cloudgate;',
      ]);
      // The units that hold connections to it are gone first.
      expect(
        called().indexOf('DROP DATABASE IF EXISTS cloudgate WITH (FORCE);'),
      ).toBeGreaterThan(
        called().indexOf('systemctl disable --now cloudgate-backend.service'),
      );
      for (const gone of INSTANCE) {
        expect({ gone, exists: exists(gone) }).toEqual({ gone, exists: false });
      }
      expect(exists('opt/cloudgate')).toBe(false);
      expect(exists('etc/default/ufw')).toBe(true);
      expect(exists('opt/mine/notes')).toBe(true);
    });

    // The secrets an install before /etc/default/cloudgate-secrets kept, which
    // the install renamed when it moved them and never read again.
    it('removes the old secrets the install moved aside, and nothing else of that folder', () => {
      installed();
      put('root/cloudgate-live-test/env.migrated', 'PGPW=old\n');
      put('root/cloudgate-live-test/notes', 'mine\n');

      const ran = uninstall(['--purge'], { input: '203.0.113.10\n' });

      expect(ran.status).toBe(0);
      expect(exists('root/cloudgate-live-test/env.migrated')).toBe(false);
      expect(exists('root/cloudgate-live-test/notes')).toBe(true);
      expect(ran.stdout).toContain(
        `${root}/root/cloudgate-live-test/env.migrated`,
      );
    });

    it.each([
      ['another host', '198.51.100.7\n'],
      ['a prefix of it', '203.0.113.1\n'],
      ['it with a space in front', ' 203.0.113.10\n'],
      ['nothing, at the end of its input', ''],
    ])('changes nothing when the answer is %s', (_, input) => {
      installed();
      const before = snapshot();

      const ran = uninstall(['--purge'], { input });

      expect(ran.status).not.toBe(0);
      expect(ran.stderr).toContain('Nothing was changed');
      expect(called()).toEqual([]);
      expect(snapshot()).toEqual(before);
      expect(fs.existsSync(traefik)).toBe(true);
    });

    // The Hosted instance's console is reached at https://<hostname>, which
    // names no address; its backend's env file keeps the one it was given.
    it('reads the Hosted instance’s host from the backend’s CLOUDGATE_PUBLIC_HOST', () => {
      installed();
      put(
        'etc/default/cloudgate-backend',
        `${BACKEND_ENV}CLOUDGATE_PUBLIC_HOST='198.51.100.7'\n`,
      );
      put(
        'etc/default/cloudgate-console',
        'NODE_ENV=production\nCLOUDGATE_API_URL=https://cloudgate.example.app\n',
      );

      const ran = uninstall(['--purge'], { input: '198.51.100.7\n' });

      expect(ran.status).toBe(0);
      expect(sql()).toHaveLength(3);
      expect(exists('etc/default/cloudgate-backend')).toBe(false);
    });

    it('reads an IPv6 host without the brackets its URL carries', () => {
      installed();
      put(
        'etc/default/cloudgate-console',
        'NODE_ENV=production\nCLOUDGATE_API_URL=http://[2001:db8::10]:4000\n',
      );

      const ran = uninstall(['--purge'], { input: '2001:db8::10\n' });

      expect(ran.status).toBe(0);
      expect(sql()).toHaveLength(3);
    });

    it('refuses, changing nothing, when neither env file names a public host', () => {
      installed();
      fs.rmSync(path.join(root, 'etc/default/cloudgate-console'));
      const before = snapshot();

      const ran = uninstall(['--purge'], { input: '203.0.113.10\n' });

      expect(ran.status).not.toBe(0);
      expect(ran.stderr).toContain('Nothing was changed');
      expect(called()).toEqual([]);
      expect(snapshot()).toEqual(before);
    });

    // The secrets are what make the database readable: removed only once it
    // is gone, so a failed drop never leaves a database nothing can decrypt.
    it('keeps the env files, /etc/cloudgate, the dumps and the install logs when the database cannot be dropped', () => {
      installed();
      shim('psql', `echo "psql $*" >> "${calls}"\ncat > /dev/null\nexit 1`);

      const ran = uninstall(['--purge'], { input: '203.0.113.10\n' });

      expect(ran.status).not.toBe(0);
      for (const kept of INSTANCE) {
        expect({ kept, exists: exists(kept) }).toEqual({ kept, exists: true });
      }
    });

    describe('what the instance deployed on this host', () => {
      it('lists its Swarm services and standalone containers before dropping the database, and keeps them running by default', () => {
        installed();

        const ran = uninstall(['--purge'], {
          input: '203.0.113.10\n\n',
          ...DEPLOYED,
        });

        expect(ran.stderr).toBe('');
        expect(ran.status).toBe(0);
        const asked = ran.stdout.slice(0, ran.stdout.indexOf('[y/N]'));
        for (const listed of [
          'app-r42a2o',
          'postgres-k2m9x4',
          'compose-q7w3e1_web',
          'compose-z8v6b5-web-1',
        ]) {
          expect(asked).toContain(listed);
        }
        expect(asked).toContain('keep running');
        expect(asked).not.toContain('my-own');
        // Read from the database while it is still there.
        const read = called().findIndex((line) => line.includes('-tA'));
        expect(read).toBeGreaterThan(-1);
        expect(read).toBeLessThan(
          called().indexOf('DROP DATABASE IF EXISTS cloudgate WITH (FORCE);'),
        );
        expect(
          called().filter((line) => /^docker (service rm|rm -f) /.test(line)),
        ).toEqual(['docker rm -f cloudgate-traefik']);
        expect(sql()).toHaveLength(3);
        // The closing word names what is left running, and how to remove it.
        const after = ran.stdout.slice(ran.stdout.indexOf('[y/N]'));
        expect(after).toContain('app-r42a2o');
        expect(after).toContain('docker service rm');
      });

      it('keeps them running when its input ends at the question', () => {
        installed();

        const ran = uninstall(['--purge'], {
          input: '203.0.113.10\n',
          ...DEPLOYED,
        });

        expect(ran.status).toBe(0);
        expect(called().join('\n')).not.toMatch(/docker service rm/);
        expect(sql()).toHaveLength(3);
      });

      it.each([['y'], ['yes'], ['Y']])(
        'removes them, and only them, once the database is dropped, on %s',
        (answer) => {
          installed();

          const ran = uninstall(['--purge'], {
            input: `203.0.113.10\n${answer}\n`,
            ...DEPLOYED,
          });

          expect(ran.stderr).toBe('');
          expect(ran.status).toBe(0);
          const removed = called().filter((line) =>
            /^docker (service rm|rm -f) /.test(line),
          );
          expect(removed).toEqual([
            'docker rm -f cloudgate-traefik',
            'docker service rm app-r42a2o postgres-k2m9x4 compose-q7w3e1_web',
            'docker rm -f compose-z8v6b5-web-1',
          ]);
          expect(
            called().indexOf(
              'docker service rm app-r42a2o postgres-k2m9x4 compose-q7w3e1_web',
            ),
          ).toBeGreaterThan(
            called().indexOf('DROP DATABASE IF EXISTS cloudgate WITH (FORCE);'),
          );
        },
      );

      // A failed drop keeps the instance, so what it deployed is still its.
      it('removes nothing it deployed when the database cannot be dropped', () => {
        installed();
        shim(
          'psql',
          `echo "psql $*" >> "${calls}"
cat > /dev/null
case " $* " in *" -tA "*) echo app-r42a2o; exit 0 ;; esac
exit 1`,
        );

        const ran = uninstall(['--purge'], {
          input: '203.0.113.10\ny\n',
          ...DEPLOYED,
        });

        expect(ran.status).not.toBe(0);
        expect(called().join('\n')).not.toMatch(/docker service rm/);
      });

      it('asks nothing when it deployed nothing on this host', () => {
        installed();

        const ran = uninstall(['--purge'], {
          input: '203.0.113.10\n',
          env: { APP_NAMES: 'app-r42a2o', SERVICES: 'my-own|' },
        });

        expect(ran.stderr).toBe('');
        expect(ran.status).toBe(0);
        expect(ran.stdout).not.toContain('[y/N]');
        expect(sql()).toHaveLength(3);
      });

      // Every column the instance names a Docker object by: a deployable kind
      // added with an app_name the uninstall does not read would be left
      // running unmanaged again. The GitHub App's name names no Docker object.
      it('reads the name from every table with an app_name column but the GitHub App’s', () => {
        const tables: string[] = [];
        for (const value of Object.values(schema)) {
          if (!is(value, PgTable)) continue;
          const { name, columns } = getTableConfig(value);
          if (name === 'github') continue;
          if (columns.some((column) => column.name === 'app_name')) {
            tables.push(name);
          }
        }
        tables.sort();
        const read = [
          ...fs
            .readFileSync(script, 'utf8')
            .matchAll(/SELECT app_name FROM (\w+)/g),
        ]
          .map(([, table]) => table)
          .sort();

        expect(tables.length).toBeGreaterThan(0);
        expect(read).toEqual(tables);
      });
    });
  });

  it('refuses a run that is not root, changing nothing', () => {
    installed();
    const before = snapshot();

    const ran = uninstall([], { env: { UID_IS: '1000' } });

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('as root');
    expect(called()).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('refuses an argument it does not know, naming --purge, changing nothing', () => {
    installed();
    const before = snapshot();

    const ran = uninstall(['--purge-all']);

    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('--purge-all');
    expect(ran.stderr).toContain('--purge');
    expect(called()).toEqual([]);
    expect(snapshot()).toEqual(before);
  });
});
