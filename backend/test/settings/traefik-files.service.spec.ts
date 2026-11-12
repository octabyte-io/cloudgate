import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { hash } from 'bcryptjs';
import { parse, stringify } from 'yaml';
import { carriesRequestMetrics } from '../../src/common/config/request-metrics';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { TraefikFilesService } from '../../src/settings/traefik-files.service';
import { createBasicAuthMiddleware } from '../../src/traefik/config/security';
import { withArgvExec } from '../utils/exec-double';

/**
 * What the console's Traefik file surface refuses and redacts, and the
 * YAML it refuses to write.
 *
 * The filesystem is a real temp directory injected as `MAIN_TRAEFIK_DIR`, and a
 * Server is the exec layer's double: both are the boundaries this service
 * reaches. Every refusal is asserted twice — the answer, and that the file on
 * disk (or the Server) was left alone, because a refusal that wrote first is
 * the defect with a better error message.
 */
describe('TraefikFilesService', () => {
  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });

  let root: string;
  let service: TraefikFilesService;
  /** Files on the Server, by absolute path, as its `cat` answers them. */
  let serverFiles: Record<string, string>;
  const execAsyncRemote = jest.fn<Promise<ExecResult>, [string, string]>();
  const remoteExec = withArgvExec({
    execAsyncRemote,
  }) as unknown as RemoteExecService;

  const SERVER_ROOT = '/srv/traefik';
  const onDisk = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const put = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };

  const VALID_STATIC = 'entryPoints:\n  web:\n    address: ":80"\n';
  const BROKEN = 'providers: [unclosed\n';

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-traefik-files-')),
    );
    serverFiles = {};
    execAsyncRemote.mockReset();
    execAsyncRemote.mockImplementation((_id, command) => {
      const cat = /^cat (\S+)$/.exec(command);
      return Promise.resolve(ok(cat ? (serverFiles[cat[1]] ?? '') : ''));
    });
    service = new TraefikFilesService(remoteExec, (serverId) =>
      serverId ? SERVER_ROOT : root,
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A refusal's status and sentence, from whatever the promise threw. */
  async function refusalOf(
    attempt: Promise<unknown> | (() => unknown),
  ): Promise<{ status: number; message: string }> {
    try {
      await (typeof attempt === 'function' ? attempt() : attempt);
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        return { status: error.getStatus(), message: error.message };
      }
      throw error;
    }
    throw new Error('expected a refusal, and the call succeeded');
  }

  describe('YAML Traefik could not load', () => {
    it('refuses invalid YAML for traefik.yml with the parser’s line, and leaves the file as it was', async () => {
      put('traefik.yml', VALID_STATIC);

      const refused = await refusalOf(() => service.writeMainConfig(BROKEN));

      expect(refused.status).toBe(400);
      expect(refused.message).toMatch(/^traefik\.yml is not valid YAML: /);
      expect(refused.message).toContain('at line 2, column 1');
      expect(refused.message).not.toMatch(/\.$/);
      // Nothing was written on the way to being refused.
      expect(onDisk('traefik.yml')).toBe(VALID_STATIC);
    });

    it('refuses the same YAML written to traefik.yml by path', async () => {
      put('traefik.yml', VALID_STATIC);

      const refused = await refusalOf(
        service.writeFileFromConsole(path.join(root, 'traefik.yml'), BROKEN),
      );

      expect(refused.status).toBe(400);
      expect(refused.message).toContain('traefik.yml is not valid YAML');
      expect(onDisk('traefik.yml')).toBe(VALID_STATIC);
    });

    it('refuses invalid YAML for a dynamic file by path, on the platform and on a Server', async () => {
      put('dynamic/custom.yml', 'http: {}\n');

      const onHost = await refusalOf(
        service.writeFileFromConsole(
          path.join(root, 'dynamic/custom.yml'),
          'http:\n  routers: [\n',
        ),
      );
      const onServer = await refusalOf(
        service.writeFileFromConsole(
          `${SERVER_ROOT}/dynamic/custom.yml`,
          'http:\n  routers: [\n',
          'srv-1',
        ),
      );

      expect(onHost.status).toBe(400);
      expect(onServer.status).toBe(400);
      expect(onDisk('dynamic/custom.yml')).toBe('http: {}\n');
      // Nothing was sent to the Server at all.
      expect(execAsyncRemote).not.toHaveBeenCalled();
    });

    it('refuses a traefik.yml that is not a mapping, or whose entryPoints is not one', async () => {
      expect(
        (await refusalOf(() => service.writeMainConfig('- web\n- websecure\n')))
          .status,
      ).toBe(400);
      expect(
        (await refusalOf(() => service.writeMainConfig('entryPoints: web\n')))
          .message,
      ).toBe('traefik.yml: entryPoints must be a mapping of names to settings');
      expect(
        (await refusalOf(() => service.writeMainConfig('# only a comment\n')))
          .message,
      ).toBe('traefik.yml holds no configuration');
    });

    it('refuses invalid YAML for the two named dynamic files', async () => {
      const refused = await refusalOf(() =>
        service.writeConfig('middlewares', 'http: {a: 1\n'),
      );

      expect(refused.status).toBe(400);
      expect(refused.message).toMatch(/^middlewares\.yml is not valid YAML/);
      expect(fs.existsSync(path.join(root, 'dynamic/middlewares.yml'))).toBe(
        false,
      );
    });

    it('writes valid YAML, and a file that is not YAML, unchanged', async () => {
      service.writeMainConfig(VALID_STATIC);
      put('dynamic/certificates/c/chain.crt', 'old');
      await service.writeFileFromConsole(
        path.join(root, 'dynamic/certificates/c/chain.crt'),
        'not: [yaml',
      );

      expect(onDisk('traefik.yml')).toBe(VALID_STATIC);
      expect(onDisk('dynamic/certificates/c/chain.crt')).toBe('not: [yaml');
    });
  });

  describe('private-key material', () => {
    const KEY =
      '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIO\n-----END PRIVATE KEY-----\n';
    const KEY_FILE = 'dynamic/certificates/certificate-nu7bdt/privkey.key';
    const ACME = 'dynamic/acme.json';

    beforeEach(() => {
      put(KEY_FILE, KEY);
      put(ACME, '{"letsencrypt":{"Account":{"PrivateKey":"MIIE"}}}');
      put('dynamic/certificates/certificate-nu7bdt/chain.crt', 'CERT');
    });

    it.each([KEY_FILE, ACME])(
      'refuses to read %s on the platform, naming why',
      async (rel) => {
        const refused = await refusalOf(
          service.readFileForConsole(path.join(root, rel)),
        );

        expect(refused.status).toBe(403);
        expect(refused.message).toBe(
          `${path.basename(rel)} holds private key material, which the console neither shows nor overwrites`,
        );
      },
    );

    it.each([KEY_FILE, ACME])(
      'refuses to read %s on a Server without asking the Server for it',
      async (rel) => {
        serverFiles[`${SERVER_ROOT}/${rel}`] = KEY;

        const refused = await refusalOf(
          service.readFileForConsole(`${SERVER_ROOT}/${rel}`, 'srv-1'),
        );

        expect(refused.status).toBe(403);
        // The key never crossed the SSH connection.
        expect(execAsyncRemote).not.toHaveBeenCalled();
      },
    );

    it.each([KEY_FILE, ACME])(
      'refuses to write %s, on the platform and on a Server',
      async (rel) => {
        const before = onDisk(rel);

        const onHost = await refusalOf(
          service.writeFileFromConsole(path.join(root, rel), 'overwritten'),
        );
        const onServer = await refusalOf(
          service.writeFileFromConsole(
            `${SERVER_ROOT}/${rel}`,
            'overwritten',
            'srv-1',
          ),
        );

        expect(onHost.status).toBe(403);
        expect(onServer.status).toBe(403);
        expect(onDisk(rel)).toBe(before);
        expect(execAsyncRemote).not.toHaveBeenCalled();
      },
    );

    it('refuses a file whose name did not say it holds a PEM private key', async () => {
      put('dynamic/notes.yml', `# pasted by hand\n${KEY}`);

      const refused = await refusalOf(
        service.readFileForConsole(path.join(root, 'dynamic/notes.yml')),
      );

      expect(refused.status).toBe(403);
    });

    it('still opens the certificate itself', async () => {
      await expect(
        service.readFileForConsole(
          path.join(root, 'dynamic/certificates/certificate-nu7bdt/chain.crt'),
        ),
      ).resolves.toBe('CERT');
    });

    it('marks the key files as withheld in the platform walk, and nothing else', async () => {
      const tree = await service.readDirectory(root);
      const files = new Map<string, string | undefined>();
      const walk = (nodes: typeof tree) => {
        for (const node of nodes) {
          if (node.type === 'directory') walk(node.children ?? []);
          else files.set(path.relative(root, node.id), node.withheld);
        }
      };
      walk(tree);

      expect(files.get(KEY_FILE)).toContain('holds private key material');
      expect(files.get(ACME)).toContain('holds private key material');
      expect(
        files.get('dynamic/certificates/certificate-nu7bdt/chain.crt'),
      ).toBeUndefined();
    });

    it('marks the key files as withheld in a Server’s walk', async () => {
      execAsyncRemote.mockResolvedValueOnce(
        ok(
          JSON.stringify([
            {
              id: `${SERVER_ROOT}/dynamic`,
              name: 'dynamic',
              type: 'directory',
              children: [
                {
                  id: `${SERVER_ROOT}/${ACME}`,
                  name: 'acme.json',
                  type: 'file',
                },
                {
                  id: `${SERVER_ROOT}/dynamic/a.yml`,
                  name: 'a.yml',
                  type: 'file',
                },
              ],
            },
          ]),
        ),
      );

      const [dynamic] = await service.readDirectory(SERVER_ROOT, 'srv-1');

      expect(dynamic.children?.[0].withheld).toContain(
        'holds private key material',
      );
      expect(dynamic.children?.[1]).not.toHaveProperty('withheld');
    });
  });

  describe('a tree setup has not created yet', () => {
    // ENOENT used to escape as a 500, which `/requests` cannot tell from a
    // broken backend; an empty tree is what the console reads as "no Traefik
    // here", and what a Server's walk already answers for a missing directory.
    it('answers an empty tree for a directory that does not exist', async () => {
      await expect(
        service.readDirectory(path.join(root, 'not-created-yet')),
      ).resolves.toEqual([]);
    });

    it('still refuses a path that exists but is not a directory', async () => {
      put('traefik.yml', VALID_STATIC);
      await expect(
        service.readDirectory(path.join(root, 'traefik.yml')),
      ).rejects.toMatchObject({ code: 'ENOTDIR' });
    });
  });

  describe('basic-auth password hashes', () => {
    const APP_FILE = 'dynamic/app-nk3zbo.yml';
    const BCRYPT = /\$2[aby]?\$\d\d\$/;
    let entry: string;

    /** The file `TraefikAppConfigService.regenerate` writes for one user. */
    async function appFile(): Promise<string> {
      entry = `ui:${await hash('throwaway-password', 4)}`;
      return stringify({
        http: {
          routers: {
            'app-nk3zbo-router-1': {
              rule: 'Host(`ui.example.com`)',
              service: 'app-nk3zbo-service-1',
              middlewares: ['auth-app-nk3zbo'],
            },
          },
          middlewares: createBasicAuthMiddleware('app-nk3zbo', [entry]),
        },
      });
    }

    it('serves an Application’s file with no bcrypt hash in it, on the platform and on a Server', async () => {
      const content = await appFile();
      put(APP_FILE, content);
      serverFiles[`${SERVER_ROOT}/${APP_FILE}`] = content;

      const onHost = await service.readFileForConsole(
        path.join(root, APP_FILE),
      );
      const onServer = await service.readFileForConsole(
        `${SERVER_ROOT}/${APP_FILE}`,
        'srv-1',
      );

      for (const served of [onHost, onServer]) {
        expect(served).not.toMatch(BCRYPT);
        expect(served).toContain('ui:<redacted>');
        expect(served).toContain('Host(`ui.example.com`)');
      }
    });

    it('serves a file with no htpasswd entry byte for byte', async () => {
      const content = '# kept\nhttp:\n  routers: {}   # also kept\n';
      put('dynamic/custom.yml', content);

      await expect(
        service.readFileForConsole(path.join(root, 'dynamic/custom.yml')),
      ).resolves.toBe(content);
    });

    it('redacts a hash in a file that does not parse', async () => {
      await appFile();
      put('dynamic/broken.yml', `users: [${entry}\n`);

      const served = await service.readFileForConsole(
        path.join(root, 'dynamic/broken.yml'),
      );

      expect(served).not.toMatch(BCRYPT);
    });

    it('keeps the stored hash when the file it served is saved back with an edit', async () => {
      put(APP_FILE, await appFile());
      const served = (await service.readFileForConsole(
        path.join(root, APP_FILE),
      )) as string;

      await service.writeFileFromConsole(
        path.join(root, APP_FILE),
        served.replace('ui.example.com', 'ui2.example.com'),
      );

      const saved = onDisk(APP_FILE);
      expect(saved).toContain(entry);
      expect(saved).toContain('ui2.example.com');
      expect(saved).not.toContain('<redacted>');
    });

    it('keeps the stored hash on a Server too', async () => {
      const content = await appFile();
      serverFiles[`${SERVER_ROOT}/${APP_FILE}`] = content;
      const served = (await service.readFileForConsole(
        `${SERVER_ROOT}/${APP_FILE}`,
        'srv-1',
      )) as string;

      await service.writeFileFromConsole(
        `${SERVER_ROOT}/${APP_FILE}`,
        served,
        'srv-1',
      );

      const write = execAsyncRemote.mock.calls
        .map(([, command]) => command)
        .find((command) => command.includes('base64 -d >'));
      const payload = Buffer.from(
        /echo "([^"]+)"/.exec(write ?? '')?.[1] ?? '',
        'base64',
      ).toString('utf8');
      expect(payload).toContain(entry);
      expect(payload).not.toContain('<redacted>');
    });

    it('changes nothing but the entries when it redacts, and an unchanged save writes the file back byte for byte', async () => {
      await appFile();
      const handWritten = [
        '# written by hand; keep this comment',
        'http:',
        '  middlewares:',
        '    auth-app-nk3zbo:',
        '      basicAuth:',
        '        removeHeader: true   # trailing comment',
        '        users:',
        `          - "${entry}"`,
        `          - 'other:${entry.slice(3)}'`,
        '',
        '  routers: {}',
        '',
      ].join('\n');
      put(APP_FILE, handWritten);

      const served = (await service.readFileForConsole(
        path.join(root, APP_FILE),
      )) as string;
      await service.writeFileFromConsole(path.join(root, APP_FILE), served);

      expect(served).toBe(
        handWritten
          .replace(entry, 'ui:<redacted>')
          .replace(`other:${entry.slice(3)}`, 'other:<redacted>'),
      );
      expect(onDisk(APP_FILE)).toBe(handWritten);
    });

    it('refuses a redacted entry the file on disk holds no hash for, and writes nothing', async () => {
      const content = await appFile();
      put(APP_FILE, content);

      const refused = await refusalOf(
        service.writeFileFromConsole(
          path.join(root, APP_FILE),
          content.replace(entry, 'someone-else:<redacted>'),
        ),
      );

      expect(refused.status).toBe(400);
      expect(refused.message).toBe(
        'Basic-auth user someone-else in app-nk3zbo.yml has no stored password to keep; write its htpasswd entry in full',
      );
      expect(onDisk(APP_FILE)).toBe(content);
    });
  });

  // ADR-0027: Enable request metrics writes the same loopback block the three
  // provisioning writers emit, into whatever traefik.yml the machine has.
  describe('Enable request metrics', () => {
    const OPERATOR_STATIC = [
      '# the operator wrote this',
      'entryPoints:',
      '  web:',
      "    address: ':80'",
      '  traefik:',
      "    address: ':8080'",
      'metrics:',
      '  prometheus:',
      '    entryPoint: traefik',
      '    addRoutersLabels: true',
      '',
    ].join('\n');

    it('writes the loopback entryPoint, moves prometheus off the dashboard, and keeps the rest', async () => {
      put('traefik.yml', OPERATOR_STATIC);

      await service.enableRequestMetrics(null);

      const written = onDisk('traefik.yml');
      expect(carriesRequestMetrics(written)).toBe(true);
      expect(parse(written)).toEqual({
        entryPoints: {
          web: { address: ':80' },
          traefik: { address: ':8080' },
          metrics: { address: '127.0.0.1:8082' },
        },
        metrics: {
          prometheus: {
            entryPoint: 'metrics',
            addServicesLabels: true,
            addRoutersLabels: false,
          },
        },
      });
      expect(written).toContain('# the operator wrote this');
      expect(service.platformCarriesRequestMetrics()).toBe(true);
    });

    it('writes the same bytes when enabled twice', async () => {
      put('traefik.yml', VALID_STATIC);

      await service.enableRequestMetrics(null);
      const once = onDisk('traefik.yml');
      await service.enableRequestMetrics(null);

      expect(onDisk('traefik.yml')).toBe(once);
      expect(once).toContain('# Request metrics (ADR-0027)');
    });

    it('refuses a machine with no traefik.yml, and writes nothing', async () => {
      await expect(service.enableRequestMetrics(null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(fs.existsSync(path.join(root, 'traefik.yml'))).toBe(false);
      expect(service.platformCarriesRequestMetrics()).toBe(false);
    });

    it.each([
      [
        'a published address',
        "entryPoints:\n  metrics:\n    address: ':8082'\nmetrics:\n  prometheus:\n    entryPoint: metrics\n    addServicesLabels: true\n",
      ],
      [
        'the dashboard entryPoint',
        "entryPoints:\n  metrics:\n    address: '127.0.0.1:8082'\nmetrics:\n  prometheus:\n    entryPoint: traefik\n    addServicesLabels: true\n",
      ],
      [
        'no service labels',
        "entryPoints:\n  metrics:\n    address: '127.0.0.1:8082'\nmetrics:\n  prometheus:\n    entryPoint: metrics\n",
      ],
      ['YAML that does not parse', BROKEN],
    ])('does not count request metrics on %s as enabled', (_case, yaml) => {
      expect(carriesRequestMetrics(yaml)).toBe(false);
    });
  });

  /**
   * The Access log's headers (ADR-0055): on a Server, Traefik is told to
   * drop every request header but User-Agent, so the log keeps the visitor's
   * browser and nothing else a request carried. The platform host's switch is
   * out of that change and writes the block it always wrote.
   */
  describe('request logging', () => {
    /** The YAML the Server's last `base64 -d >` write carried. */
    const writtenToServer = (): Record<string, unknown> => {
      const write = execAsyncRemote.mock.calls
        .map(([, command]) => command)
        .filter((command) => command.includes('base64 -d >'))
        .at(-1);
      const payload = /echo "([^"]*)"/.exec(write ?? '')?.[1] ?? '';
      return parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<
        string,
        unknown
      >;
    };

    it('keeps only the User-Agent header on a Server', async () => {
      serverFiles[`${SERVER_ROOT}/traefik.yml`] = VALID_STATIC;

      await service.toggleRequests(true, 'srv-1');

      expect(writtenToServer().accessLog).toMatchObject({
        format: 'json',
        fields: {
          headers: { defaultMode: 'drop', names: { 'User-Agent': 'keep' } },
        },
      });
    });

    it('removes the whole block, headers and all, when a Server turns it off', async () => {
      serverFiles[`${SERVER_ROOT}/traefik.yml`] = VALID_STATIC;
      await service.toggleRequests(true, 'srv-1');
      serverFiles[`${SERVER_ROOT}/traefik.yml`] = stringify(writtenToServer());

      await service.toggleRequests(false, 'srv-1');

      expect(writtenToServer().accessLog).toBeUndefined();
      expect(writtenToServer().entryPoints).toBeDefined();
    });

    it('writes the platform host the block it always wrote', async () => {
      put('traefik.yml', VALID_STATIC);

      await service.toggleRequests(true, null);

      const { accessLog } = parse(onDisk('traefik.yml')) as {
        accessLog: Record<string, unknown>;
      };
      expect(accessLog.fields).toBeUndefined();
      expect(accessLog).toMatchObject({ format: 'json', bufferingSize: 100 });
    });
  });
});
