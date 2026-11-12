import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import type { CloneSource } from '../../src/git-providers/source-clone.service';
import { SourceCloneService } from '../../src/git-providers/source-clone.service';
import type { GiteaService } from '../../src/git-providers/strategies/gitea/gitea.service';
import type { GithubService } from '../../src/git-providers/strategies/github/github.service';
import type { GitlabService } from '../../src/git-providers/strategies/gitlab/gitlab.service';
import { outboundAddressRefused } from '../../src/outbound/outbound-address-guard';
import type {
  OutboundAddressGuard,
  OutboundScope,
} from '../../src/outbound/outbound-address-guard';

/**
 * A clone on the platform host, run by the real `git` against listeners on
 * this machine: what a reviewer measured getting past the address check, run
 * again. An "internal" listener on `127.0.0.1` stands for whatever the
 * platform host can reach and a customer must not, and records every request
 * that lands on it — the clone's output is the Deployment log, so a request
 * that lands is an answer the customer reads.
 *
 * The guard here vouches for one name, `public.example.test`, at `127.0.0.2`,
 * where a listener stands in for a public git server that redirects. The name
 * is in no DNS, so a clone that reaches that listener at all dialled the
 * address the guard handed back rather than looking the name up itself.
 */
const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
const withGit = git.status === 0 ? describe : describe.skip;

withGit(
  'SourceCloneService.cloneProgram, run by git on the platform host',
  () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-pinned-clone-')),
    );
    const outputPath = path.join(root, 'code');

    /** Every request each listener answered, as `host path`. */
    const internalHits: string[] = [];
    const redirectHits: string[] = [];
    let internal: Server;
    let redirector: Server;
    let internalPort = 0;
    let redirectPort = 0;

    const listen = (server: Server, host: string): Promise<number> =>
      new Promise((resolve) => {
        server.listen(0, host, () =>
          resolve((server.address() as AddressInfo).port),
        );
      });

    beforeAll(async () => {
      internal = createServer((request, response) => {
        internalHits.push(`${request.headers.host} ${request.url}`);
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('internal service answered\n');
      });
      redirector = createServer((request, response) => {
        redirectHits.push(`${request.headers.host} ${request.url}`);
        response.writeHead(302, {
          location: `http://127.0.0.1:${internalPort}/metadata${request.url}`,
        });
        response.end();
      });
      internalPort = await listen(internal, '127.0.0.1');
      redirectPort = await listen(redirector, '127.0.0.2');
    });

    afterAll(async () => {
      await new Promise((resolve) => internal.close(resolve));
      await new Promise((resolve) => redirector.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    });

    beforeEach(() => {
      internalHits.length = 0;
      redirectHits.length = 0;
    });

    const guard = {
      addressToDial: (host: string, scope: OutboundScope) =>
        host === 'public.example.test'
          ? Promise.resolve('127.0.0.2')
          : Promise.reject(outboundAddressRefused(scope.field)),
      actsForInstance: () => Promise.resolve(false),
    } as unknown as OutboundAddressGuard;

    const clones = new SourceCloneService(
      {} as GithubService,
      {} as GitlabService,
      {} as GiteaService,
      guard,
    );

    const source = (customGitUrl: string): CloneSource =>
      ({
        appName: 'web-app',
        sourceType: 'git',
        enableSubmodules: false,
        customGitUrl,
        customGitBranch: 'main',
      }) as unknown as CloneSource;

    const onPlatformHost = { serverId: null, serviceId: 'svc_customer' };

    /**
     * Runs a clone program the way the engine does, without this sandbox's
     * proxy (a proxy resolves the name itself, so nothing here would be
     * measured) or anyone's git configuration. Asynchronous, because the
     * listeners answer on this process's event loop.
     */
    const run = (
      command: string,
    ): Promise<{ status: number; output: string }> =>
      new Promise((resolve, reject) => {
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !/proxy/i.test(key)),
        );
        const child = spawn('sh', ['-c', `(${command}) 2>&1`], {
          env: {
            ...env,
            HOME: root,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
          },
        });
        let output = '';
        child.stdout.on(
          'data',
          (chunk: Buffer) => (output += chunk.toString()),
        );
        child.on('error', reject);
        child.on('close', (code) => resolve({ status: code ?? -1, output }));
      });

    it('dials the checked address and follows no redirect to an unchecked one', async () => {
      const { command } = await clones.cloneProgram(
        source(`http://public.example.test:${redirectPort}/acme/web.git`),
        outputPath,
        { on: onPlatformHost },
      );

      const { status } = await run(command);

      expect(status).not.toBe(0);
      // git reached the address the guard checked, for a name no DNS knows.
      expect(redirectHits).toEqual([
        `public.example.test:${redirectPort} /acme/web.git/info/refs?service=git-upload-pack`,
      ]);
      // Nothing reached the internal listener the redirect pointed at.
      expect(internalHits).toEqual([]);
    });

    /**
     * The control: the same redirect, cloned where nothing pins it — a
     * customer's own Server — is followed, which is the request the confined
     * clone above did not make.
     */
    it('follows the redirect on a clone that is not held to a checked address', async () => {
      const { command } = await clones.cloneProgram(
        source(`http://127.0.0.2:${redirectPort}/acme/web.git`),
        outputPath,
        { on: { serverId: 'srv_customer', serviceId: 'svc_customer' } },
      );

      await run(command);

      expect(internalHits).toEqual([
        `127.0.0.1:${internalPort} /metadata/acme/web.git/info/refs?service=git-upload-pack`,
      ]);
    });

    /**
     * `example.com` to WHATWG, which reads the backslash as the end of the
     * authority, and `127.0.0.1` to curl, which reads it as userinfo: measured
     * with git 2.43, it dials `127.0.0.1` even beside a pin for the public
     * name. So it is refused before any program exists.
     */
    it('refuses a URL WHATWG and curl read different hosts out of, and runs nothing', async () => {
      const promise = clones.cloneProgram(
        source(`http://public.example.test\\@127.0.0.1:${internalPort}/x.git`),
        outputPath,
        { on: onPlatformHost },
      );

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      expect(internalHits).toEqual([]);
    });
  },
);
