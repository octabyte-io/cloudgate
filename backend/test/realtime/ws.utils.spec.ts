import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import {
  buildContainerLogsCommand,
  isValidContainerId,
  isValidSearch,
  isValidShell,
  isValidSince,
  isValidTail,
  readValidDirectory,
} from '../../src/realtime/ws.utils';

describe('ws.utils validators', () => {
  it('accepts docker ids and names, rejects shell metacharacters', () => {
    expect(isValidContainerId('a1b2c3d4e5f6')).toBe(true); // short hex id
    expect(isValidContainerId('my-app_1.web')).toBe(true);
    expect(isValidContainerId('web; rm -rf /')).toBe(false);
    expect(isValidContainerId('$(whoami)')).toBe(false);
    expect(isValidContainerId('-leading-dash')).toBe(false);
  });

  it('bounds tail to plain digits up to 10000', () => {
    expect(isValidTail('100')).toBe(true);
    expect(isValidTail('10000')).toBe(true);
    expect(isValidTail('10001')).toBe(false);
    expect(isValidTail('50; id')).toBe(false);
    expect(isValidTail('-1')).toBe(false);
  });

  it('accepts "all" or fixed-unit durations for since', () => {
    expect(isValidSince('all')).toBe(true);
    expect(isValidSince('15m')).toBe(true);
    expect(isValidSince('2d')).toBe(true);
    expect(isValidSince('1 hour')).toBe(false);
    expect(isValidSince('$(date)')).toBe(false);
  });

  it('restricts search to text that cannot break out of quotes', () => {
    expect(isValidSearch('error 500')).toBe(true);
    expect(isValidSearch("o'brien")).toBe(false);
    expect(isValidSearch('a"b')).toBe(false);
    expect(isValidSearch('line\nbreak')).toBe(false);
  });

  it('allows only the known shells', () => {
    expect(isValidShell('bash')).toBe(true);
    expect(isValidShell('/bin/ash')).toBe(true);
    expect(isValidShell('python3')).toBe(false);
  });

  it('confines log paths to the platform directory', () => {
    // No serverId, so the platform host's root: this process's own, taken from
    // the machine rather than spelled. With CLOUDGATE_DIRECTORY unset it is
    // `/etc/cloudgate`, and a spelled literal passed only for as long as the
    // lane left it unset.
    const platformRoot = cloudgateDirectoryOn(null);
    expect(readValidDirectory(`${platformRoot}/logs/app/x.log`)).toBe(true);
    expect(readValidDirectory(platformRoot)).toBe(true);
    expect(readValidDirectory(`${platformRoot}/../shadow`)).toBe(false);
    expect(readValidDirectory('/var/log/syslog')).toBe(false);
    expect(readValidDirectory(`${platformRoot}evil/x.log`)).toBe(false);
  });
});

/**
 * The platform directory is CLOUDGATE_DIRECTORY now, so this containment
 * check has to hold wherever the root has been pointed. Entitlement to the
 * deployment is the boundary since ADR-0007 and this is the backstop behind it,
 * but a backstop that silently stops confining once an operator relocates the
 * root is worth no more than one that was never written.
 */
describe('readValidDirectory under a custom CLOUDGATE_DIRECTORY', () => {
  // realpathSync because the OS temp dir is itself a symlink on macOS, and a
  // boundary that only compares lexically would refuse its own log files.
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-ws-')),
  );
  const outside = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-elsewhere-')),
  );
  const original = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(() => {
    process.env.CLOUDGATE_DIRECTORY = root;
    fs.mkdirSync(`${root}/logs`, { recursive: true });
    fs.writeFileSync(`${outside}/secrets.log`, 'not yours');
  });

  afterAll(() => {
    if (original === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = original;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('streams a log under the configured root', () => {
    expect(readValidDirectory(`${root}/logs/app-x/deploy.log`)).toBe(true);
    expect(readValidDirectory(root)).toBe(true);
  });

  it('refuses the old default once the root has moved', () => {
    expect(readValidDirectory('/etc/cloudgate/logs/app/x.log')).toBe(false);
  });

  it('refuses a traversal out of the configured root', () => {
    expect(readValidDirectory(`${root}/logs/../../../../etc/passwd`)).toBe(
      false,
    );
    expect(readValidDirectory(`${outside}/secrets.log`)).toBe(false);
    expect(readValidDirectory(`${root}-evil/x.log`)).toBe(false);
  });

  it('refuses a symlink inside the root that points out of it', () => {
    fs.symlinkSync(outside, `${root}/logs/escape`);
    expect(readValidDirectory(`${root}/logs/escape/secrets.log`)).toBe(false);
  });
});

describe('buildContainerLogsCommand', () => {
  it('builds the default follow command (empty conditionals leave double spaces)', () => {
    expect(
      buildContainerLogsCommand({
        containerId: 'web-app',
        tail: '100',
        since: 'all',
        search: '',
        runType: null,
      }),
    ).toBe('docker container logs --timestamps  --tail 100  --follow web-app');
  });

  it('switches to service logs with --raw for swarm and inlines since', () => {
    expect(
      buildContainerLogsCommand({
        containerId: 'web-app',
        tail: '200',
        since: '1h',
        search: '',
        runType: 'swarm',
      }),
    ).toBe(
      'docker service logs --timestamps --raw --tail 200 --since 1h --follow web-app',
    );
  });

  it('leaves out --follow when asked not to follow, so the read ends after the tail', () => {
    expect(
      buildContainerLogsCommand({
        containerId: 'web-app',
        tail: '20',
        since: 'all',
        search: '',
        runType: 'swarm',
        follow: false,
      }),
    ).toBe('docker service logs --timestamps --raw --tail 20   web-app');
  });

  it("keeps Docker's task prefix for a Swarm service when asked, so each line names its copy", () => {
    expect(
      buildContainerLogsCommand({
        containerId: 'web-app',
        tail: '200',
        since: 'all',
        search: '',
        runType: 'swarm',
        taskPrefix: true,
      }),
    ).toBe(
      'docker service logs --timestamps --no-task-ids --tail 200  --follow web-app',
    );
  });

  it('strips the task prefix for a Swarm service unless asked, as the database and Compose views read it', () => {
    const params = {
      containerId: 'primary-db',
      tail: '200',
      since: 'all',
      search: '',
      runType: 'swarm',
    };
    const stripped =
      'docker service logs --timestamps --raw --tail 200  --follow primary-db';
    expect(buildContainerLogsCommand(params)).toBe(stripped);
    expect(buildContainerLogsCommand({ ...params, taskPrefix: false })).toBe(
      stripped,
    );
  });

  it('filters with one grep wherever the container runs, the search double-quoted and line-buffered', () => {
    expect(
      buildContainerLogsCommand({
        containerId: 'web-app',
        tail: '100',
        since: 'all',
        search: 'error 500',
        runType: null,
      }),
    ).toBe(
      'docker container logs --timestamps  --tail 100  --follow web-app 2>&1 | grep --line-buffered -iF "error 500"',
    );
  });
});

/**
 * ADR-0007: the containment check survives as defense-in-depth, and it needs to
 * know which tree the file it is confining actually lives in. A remote build's
 * log is rooted on REMOTE_CLOUDGATE_DIRECTORY — the literal `/etc/cloudgate`,
 * whatever this instance's own root has been moved to — so the build server is
 * what picks the root.
 */
describe('readValidDirectory for a remote build server', () => {
  const localRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-local-')),
  );
  const original = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(() => {
    process.env.CLOUDGATE_DIRECTORY = localRoot;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = original;
    fs.rmSync(localRoot, { recursive: true, force: true });
  });

  it('confines a remote log to the remote root, not to this instance’s', () => {
    expect(
      readValidDirectory('/etc/cloudgate/logs/app-x/deploy.log', 'srv_1'),
    ).toBe(true);
    expect(
      readValidDirectory(`${localRoot}/logs/app-x/deploy.log`, 'srv_1'),
    ).toBe(false);
  });

  it('confines a local log to this instance’s root, as before', () => {
    expect(readValidDirectory(`${localRoot}/logs/app-x/deploy.log`)).toBe(true);
    expect(readValidDirectory('/etc/cloudgate/logs/app-x/deploy.log')).toBe(
      false,
    );
  });

  it('refuses a traversal out of the remote root', () => {
    expect(
      readValidDirectory('/etc/cloudgate/logs/../../root/.ssh/id_rsa', 'srv_1'),
    ).toBe(false);
  });
});
