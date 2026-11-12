import { BadGatewayException } from '@nestjs/common';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { AuditLogService } from '../../src/enterprise/audit-logs/audit-log.service';
import type { DockerResourceService } from '../../src/settings/docker-resource.service';
import { RequestLoggingService } from '../../src/settings/request-logging.service';
import type { TraefikFilesService } from '../../src/settings/traefik-files.service';

/**
 * On a Server, turning Request logging on or off is the write and the
 * restart in one request. A restart that fails leaves `traefik.yml`
 * saying one thing and the running Traefik doing the other — logging "on",
 * recording nothing — so the caller has to hear about it: the answer is the
 * restart's, not an unconditional `restartRequired: false` sent before the
 * restart had run.
 */
describe('RequestLoggingService.toggle on a Server', () => {
  const ctx = {
    user: { id: 'user-1' },
    session: { activeOrganizationId: 'org-1' },
  };

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ name: 'eu-web-1' }]) }),
      }),
    }),
  } as unknown as DrizzleDB;

  const serviceWith = (restart: () => Promise<void>) =>
    new RequestLoggingService(
      db,
      {
        toggleRequests: () =>
          Promise.resolve({ written: true, restartRequired: true }),
      } as unknown as TraefikFilesService,
      { reloadDockerResource: restart } as unknown as DockerResourceService,
      { audit: () => Promise.resolve() } as unknown as AuditLogService,
    );

  it('answers once Traefik has restarted, with no restart owed', async () => {
    let restarted = false;
    const service = serviceWith(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      restarted = true;
    });

    const answer = await service.toggle(ctx, true, 'srv-1');

    expect(restarted).toBe(true);
    expect(answer).toEqual({ written: true, restartRequired: false });
  });

  it('fails, saying logging is on but Traefik did not restart, when the restart fails', async () => {
    const service = serviceWith(() =>
      Promise.reject(new Error('Cannot connect to the Docker daemon')),
    );

    const pending = service.toggle(ctx, true, 'srv-1');

    await expect(pending).rejects.toBeInstanceOf(BadGatewayException);
    await expect(service.toggle(ctx, true, 'srv-1')).rejects.toThrow(
      'Request logging is on in traefik.yml on eu-web-1, but Traefik did not restart',
    );
  });
});
