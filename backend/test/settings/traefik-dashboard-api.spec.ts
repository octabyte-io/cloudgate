import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikFilesService } from '../../src/settings/traefik-files.service';

/**
 * "Publish the dashboard on 8080" recreated Traefik with 8080 published
 * and nothing behind it: the generated `traefik.yml` has no `api` block, so
 * traefik listens on :80 and :443 only and the new port answers a connection
 * reset. The port is half of the switch; this is the other half.
 *
 * `insecure: true` is what the dashboard on a published port *is* — the switch's
 * own warning already says the routing table goes "on a port anyone who can
 * reach this machine can open" — so writing it is not a wider exposure than the
 * port the operator just asked for. Turning the switch off takes it away again,
 * which matters: without the removal the dashboard would keep listening inside
 * the container, reachable from every container on the Cloudgate network.
 */
const BASE_CONFIG = `# hand-edited: keep this comment
entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
`;

let dir: string;

const traefikFiles = () =>
  new TraefikFilesService(
    {
      execAsync: jest.fn(() => Promise.resolve({ stdout: '', stderr: '' })),
    } as unknown as RemoteExecService,
    () => dir,
  );

const mainConfig = (service: TraefikFilesService) =>
  parse(service.readMainConfig() as string) as { api?: unknown };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-traefik-dashboard-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('TraefikFilesService.toggleDashboardApi, the static half of the dashboard switch', () => {
  it('writes an api block when the dashboard is turned on', async () => {
    const service = traefikFiles();
    service.writeMainConfig(BASE_CONFIG);

    await service.toggleDashboardApi(true);

    expect(mainConfig(service).api).toEqual({
      dashboard: true,
      insecure: true,
    });
  });

  it('takes the api block away again when it is turned off', async () => {
    const service = traefikFiles();
    service.writeMainConfig(BASE_CONFIG);

    await service.toggleDashboardApi(true);
    await service.toggleDashboardApi(false);

    expect(mainConfig(service)).not.toHaveProperty('api');
  });

  it('leaves the rest of the file, comments and all, as the operator wrote it', async () => {
    const service = traefikFiles();
    service.writeMainConfig(BASE_CONFIG);

    await service.toggleDashboardApi(true);

    const written = service.readMainConfig() as string;
    expect(written).toContain('# hand-edited: keep this comment');
    expect(parse(written)).toMatchObject({
      entryPoints: { web: { address: ':80' }, websecure: { address: ':443' } },
    });
  });

  it('refuses to turn on a host with no traefik.yml, rather than publishing a port for nothing', async () => {
    await expect(traefikFiles().toggleDashboardApi(true)).rejects.toThrow(
      'No Traefik configuration on this server',
    );
  });

  it('still turns off on a host with no traefik.yml, which is already the state asked for', async () => {
    // The refusal above is about *publishing* a port with nothing behind it.
    // Turning the switch off has the opposite problem: refuse it and 8080 stays
    // published on a host that cannot be edited to answer on it, with no way
    // back. There is no `api` block to remove here, so off is simply done.
    const service = traefikFiles();

    await expect(service.toggleDashboardApi(false)).resolves.toBeUndefined();
    expect(service.readMainConfig()).toBeNull();
  });
});
