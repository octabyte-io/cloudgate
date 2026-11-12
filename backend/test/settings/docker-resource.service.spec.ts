import { ConflictException } from '@nestjs/common';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DockerResourceService } from '../../src/settings/docker-resource.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  expectValueIsInert,
  INERT_VALUE,
  SEPARATOR_PAYLOAD,
} from '../utils/shell-safety';

/**
 * H-92, the third module of the six `docker service inspect` sites: every
 * command this service builds is a shell *string*, so every interpolation in it
 * is the builder's to `quote()` (§2.9).
 *
 * **No payload reaches `resourceName` today, and this is not filed as if one
 * did.** All twelve call sites pass a literal — `settings.controller.ts` passes
 * `'cloudgate'` or `'cloudgate-traefik'`, `traefik-setup.service.ts` passes its
 * module-level `CONTAINER_NAME` — and there is no DTO field, column or query
 * parameter behind any of them. That is a *stronger* constraint than the
 * `appName` sites' charset-at-a-distance, not a weaker one.
 *
 * It is quoted anyway for the reason the register gives, and one this file adds:
 * of the six sites, this file's `RESOURCE_NAME="${resourceName}"` was the one
 * that would not merely word-split. Inside `"…"` a `$(…)` still substitutes, so
 * that assignment *executed*; the `"$RESOURCE_NAME"` uses below it, which read
 * as the safe construction, were only ever as safe as the line that filled the
 * variable. The executed arm below is aimed at exactly that, because a
 * `shell-quote`-`parse` assertion cannot see it: `parse` reports a `$(` inside
 * double quotes as an ordinary character, so a string-syntax test would have
 * passed on the defect it is supposed to catch.
 */
describe('DockerResourceService', () => {
  const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });

  const serviceWith = (...stdouts: string[]) => {
    const execAsync = jest.fn();
    for (const stdout of stdouts) execAsync.mockResolvedValueOnce(ok(stdout));
    execAsync.mockResolvedValue(ok(''));
    const remoteExec = { execAsync } as unknown as RemoteExecService;
    return { execAsync, service: new DockerResourceService(remoteExec) };
  };

  const commands = (execAsync: jest.Mock): string[] =>
    execAsync.mock.calls.map(([command]) => command as string);

  describe('the resource-type probe', () => {
    const typeProbeFor = async (resourceName: string) => {
      const { execAsync, service } = serviceWith('unknown\n');
      await service.getDockerResourceType(resourceName);
      return commands(execAsync)[0];
    };

    it('names the resource once, in a variable the two inspects share', async () => {
      // Byte-for-byte, because the quoting changed exactly one word of this
      // script: the assignment is no longer inside `"…"`. Every name
      // the product can pass needs no quoting, so `quote()` returns it
      // unchanged and nothing else about the emitted script moved.
      expect(await typeProbeFor('cloudgate-traefik')).toBe(`
RESOURCE_NAME=cloudgate-traefik
if docker service inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "service"
elif docker inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "standalone"
else
	echo "unknown"
fi`);
    });

    it('runs the payload as no command of its own under a real shell', async () => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-h92-resource-')),
      );
      try {
        // `touch` is reachable and `docker` is not: the script has to answer
        // `unknown` while the payload still has everything it needs to fire.
        // A PATH without `touch` on it would leave the directory empty on the
        // bare interpolation too, and prove nothing.
        const binDir = path.join(root, 'bin');
        fs.mkdirSync(binDir);
        const touch = spawnSync('/bin/sh', ['-c', 'command -v touch'], {
          encoding: 'utf8',
        }).stdout.trim();
        if (!touch) throw new Error('the executed shell needs touch');
        fs.symlinkSync(touch, path.join(binDir, 'touch'));

        const script = await typeProbeFor('a$(touch pwned); touch pwned #');
        const ran = spawnSync('/bin/sh', ['-c', script], {
          cwd: root,
          encoding: 'utf8',
          env: { PATH: binDir },
        });

        expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);
        // And the script still answers rather than falling apart: a name the
        // daemon has never heard of — here, no daemon at all — is `unknown`.
        expect(ran.stdout.trim()).toBe('unknown');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('the env and port reads', () => {
    /** The type probe answers first, then the read this returns. */
    const readCommandFor = async (
      read: 'env' | 'ports',
      resourceType: 'service' | 'standalone',
      resourceName: string,
    ) => {
      const { execAsync, service } = serviceWith(`${resourceType}\n`, 'null\n');
      if (read === 'env') await service.readEnvironmentVariables(resourceName);
      else await service.readPorts(resourceName);
      return commands(execAsync)[1];
    };

    it.each([
      ['env', 'service'],
      ['env', 'standalone'],
      ['ports', 'service'],
      ['ports', 'standalone'],
    ] as const)(
      'introduces no syntax in the %s read of a %s for a name carrying a separator and a substitution',
      async (read, resourceType) => {
        expectValueIsInert(
          await readCommandFor(read, resourceType, SEPARATOR_PAYLOAD),
          await readCommandFor(read, resourceType, INERT_VALUE),
        );
      },
    );

    it('leaves the inspect format strings and the resource name they read untouched', async () => {
      expect(await readCommandFor('env', 'service', 'cloudgate-traefik')).toBe(
        "docker service inspect cloudgate-traefik --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}'",
      );
      expect(
        await readCommandFor('ports', 'service', 'cloudgate-traefik'),
      ).toBe(
        "docker service inspect cloudgate-traefik --format '{{json .Spec.EndpointSpec.Ports}}'",
      );
    });
  });

  describe('the reload', () => {
    const reloadCommandFor = async (
      resourceType: 'service' | 'standalone',
      resourceName: string,
    ) => {
      const { execAsync, service } = serviceWith(`${resourceType}\n`);
      await service.reloadDockerResource(resourceName);
      return commands(execAsync)[1];
    };

    it.each(['service', 'standalone'] as const)(
      'introduces no syntax in the %s reload for a name carrying a separator and a substitution',
      async (resourceType) => {
        expectValueIsInert(
          await reloadCommandFor(resourceType, SEPARATOR_PAYLOAD),
          await reloadCommandFor(resourceType, INERT_VALUE),
        );
      },
    );

    it('still force-updates the swarm service and restarts the container by name', async () => {
      expect(await reloadCommandFor('service', 'cloudgate-traefik')).toBe(
        'docker service update --force cloudgate-traefik',
      );
      expect(await reloadCommandFor('standalone', 'cloudgate-traefik')).toBe(
        'docker restart cloudgate-traefik',
      );
    });

    /**
     * What `POST /settings/reload-server` answers on an install that has no
     * Docker service and no container to restart.
     *
     * The route is `reloadDockerResource('cloudgate', undefined, version)` and
     * nothing else, so this *is* the route's answer: an `HttpException` carries
     * its own status out through the exception filter, and a bare `Error` is
     * the 500 the native install got.
     */
    it('refuses the instance restart with the install kind rather than a 500', async () => {
      const { execAsync, service } = serviceWith('unknown\n');

      const refusal = await service
        .reloadDockerResource('cloudgate', undefined, 'v1.2.3')
        .catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(ConflictException);
      const conflict = refusal as ConflictException;
      expect(conflict.getStatus()).toBe(409);
      expect(conflict.getStatus()).toBeLessThan(500);
      expect(conflict.message).toContain(
        'systemctl restart cloudgate-backend cloudgate-console',
      );
      expect(conflict.message).toContain('docs/deploy.md');
      expect(conflict.message).not.toContain('Try again');
      // The probe, and nothing after it: a refusal that had also shelled out
      // would be the 500 with extra steps.
      expect(commands(execAsync)).toHaveLength(1);
    });

    it('leaves every other resource on the original error', async () => {
      const { service } = serviceWith('unknown\n');
      await expect(service.reloadDockerResource('ghost')).rejects.toThrow(
        'Resource type not found',
      );
    });
  });
});
