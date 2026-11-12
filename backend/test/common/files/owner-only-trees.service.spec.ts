import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OwnerOnlyTreesService } from '../../../src/common/files/owner-only-trees.service';

/**
 * The owner-only fix's second criterion — *existing installs are corrected* — for the
 * platform host, where the correction is a sweep at boot rather than the next
 * write, because a file mount or a certificate nobody edits is never written
 * again. Run against a real temporary root laid out the way an earlier version
 * left one: every directory `0755` and every file `0644`.
 */
describe('OwnerOnlyTreesService', () => {
  let root: string;
  let previousRoot: string | undefined;

  const modeOf = (relative: string) =>
    fs.statSync(path.join(root, relative)).mode & 0o777;

  /** A directory or file at `relative`, with the mode an earlier version gave it. */
  const leave = (relative: string, content?: string) => {
    const full = path.join(root, relative);
    if (content === undefined) {
      fs.mkdirSync(full, { recursive: true });
      fs.chmodSync(full, 0o755);
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      fs.chmodSync(full, 0o644);
    }
  };

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-owner-only-trees-')),
    );
    previousRoot = process.env.CLOUDGATE_DIRECTORY;
    process.env.CLOUDGATE_DIRECTORY = root;
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('closes every Service, log, schedule and certificate directory an earlier version left open', () => {
    leave('applications/app-one/code/.env', 'SECRET=1');
    leave('applications/app-one/files/app.conf', 'ui=1');
    leave('compose/stack-one/code/.env', 'REDIS_PASSWORD=x');
    leave('logs/app-one/dep-1.log', 'Cloning repo');
    leave('schedules/app-one/script.sh', 'curl -H "Authorization: x"');
    leave('traefik/dynamic/certificates/cert-one/privkey.key', 'key');
    leave('traefik/dynamic/certificates/cert-one/chain.crt', 'chain');

    new OwnerOnlyTreesService().onApplicationBootstrap();

    expect({
      application: modeOf('applications/app-one'),
      stack: modeOf('compose/stack-one'),
      log: modeOf('logs/app-one'),
      schedule: modeOf('schedules/app-one'),
      certificate: modeOf('traefik/dynamic/certificates/cert-one'),
      key: modeOf('traefik/dynamic/certificates/cert-one/privkey.key'),
      chain: modeOf('traefik/dynamic/certificates/cert-one/chain.crt'),
    }).toEqual({
      application: 0o700,
      stack: 0o700,
      log: 0o700,
      schedule: 0o700,
      certificate: 0o700,
      key: 0o600,
      chain: 0o600,
    });
  });

  /**
   * The modes a reader other than root depends on. A file mount is read by
   * the container's own user through its bind mount, and a `.env` in the build
   * context is copied into an image with its mode, so the sweep closes the
   * directory above them and leaves them as they were.
   */
  it('leaves the files a workload reads with the mode it reads them with', () => {
    leave('applications/app-one/code/.env', 'SECRET=1');
    leave('applications/app-one/files/app.conf', 'ui=1');

    new OwnerOnlyTreesService().onApplicationBootstrap();

    expect({
      code: modeOf('applications/app-one/code'),
      env: modeOf('applications/app-one/code/.env'),
      mount: modeOf('applications/app-one/files/app.conf'),
    }).toEqual({ code: 0o755, env: 0o644, mount: 0o644 });
  });

  it('boots on a root that has none of the trees yet', () => {
    expect(() =>
      new OwnerOnlyTreesService().onApplicationBootstrap(),
    ).not.toThrow();
  });
});
