import { Injectable } from '@nestjs/common';
import { MonitoringService } from '../monitoring/monitoring.service';
import type { PermissionCtx } from '../rbac/permission.service';
import type { MetricsConfig } from '../servers/server.schema';
import { SettingsService } from '../settings/settings.service';
import type { SanitizedWebServerSettings } from '../settings/settings.service';

/**
 * setupMonitoring's input: everything but the type discriminator, and `token`
 * optional — an omitted one keeps the stored value, which is what replaced the
 * console's read-it-back-and-resubmit. `dto/admin.dto.ts` carries the argument.
 */
export interface WebServerMetricsConfigInput {
  server: Omit<MetricsConfig['server'], 'type' | 'token'> & {
    token?: string;
    thresholds: { cpu: number; memory: number };
  };
  containers: {
    refreshRate: number;
    services: { include?: string[]; exclude?: string[] };
  };
}

/**
 * setupMonitoring persists the local web server's metricsConfig, with the type
 * forced to 'Cloudgate'. Collection runs in this process (phase 41), so there
 * is no agent container to deploy; an external agent reports through
 * POST /notifications/receive.
 *
 * Storing the config used to be *all* this did, which made every field of it a
 * lie: nothing collected against it and no route could read what it never
 * collected, so an operator could set a 70% CPU threshold on the instance and
 * be told nothing however loaded it got. The write now registers
 * the web server's collection jobs, the same way the per-Server setup does.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly settings: SettingsService,
    private readonly monitoring: MonitoringService,
  ) {}

  /**
   * Answers with the sanitized row: this is a controller return, and the
   * singleton carries the metrics agent token this very method writes
   * (`encryptedJson`). It used to carry the instance's SSH private key
   * as well, which rode this answer out until a later change
   * dropped the column. The token does not come back,
   * including to the caller who just set the token: possession of it is the
   * whole of `POST /notifications/receive`'s authentication and this copy fans
   * out to every organization, so there is no caller it is safe to echo it to
   * and no screen that reads anything but `hasToken` off it.
   */
  async setupMonitoring(
    ctx: PermissionCtx,
    input: WebServerMetricsConfigInput,
  ): Promise<SanitizedWebServerSettings> {
    // Instance authority, with the rest of the `web_server_settings` singleton
    // (H-63, ADR-0013). This writes the **platform host's** `metricsConfig` and
    // then re-registers the instance's own collection jobs from it — the
    // retention window and refresh rates every organization's monitoring is
    // stored under, the alert thresholds it is judged against, and the agent
    // token on that row. `requireOwnerOrAdmin` asked the caller's role in
    // whichever organization they were acting in, so an owner of any
    // organization on the instance could set all of it for the shared machine;
    // there is no `serverId` here to fork on, because the per-Server path is
    // `MonitoringService`'s and org-scopes its own row.
    await this.settings.requireInstanceAuthority(ctx);

    // The stored token, for the omitted-means-keep case. Read *after* the
    // authority check and before the write, off the same row the write lands
    // on — `updateWebServerSettings` re-reads the singleton to find its id, so
    // this is the row that is about to be updated.
    const current = await this.settings.getWebServerSettings();

    await this.settings.updateWebServerSettings({
      metricsConfig: {
        server: {
          type: 'Cloudgate',
          refreshRate: input.server.refreshRate,
          port: input.server.port,
          // `??`, not `||`: an explicit `''` is "stop collecting" and must not
          // fall through to the stored value.
          token: input.server.token ?? current.metricsConfig.server.token,
          cronJob: input.server.cronJob,
          urlCallback: input.server.urlCallback,
          retentionDays: input.server.retentionDays,
          thresholds: {
            cpu: input.server.thresholds.cpu,
            memory: input.server.thresholds.memory,
          },
        },
        containers: {
          refreshRate: input.containers.refreshRate,
          services: {
            include: input.containers.services.include || [],
            exclude: input.containers.services.exclude || [],
          },
        },
      },
    });

    // Refresh the jobs from what was just stored — re-posting replaces the
    // intervals rather than duplicating them.
    await this.monitoring.registerWebServer();
    // A breached threshold saved as 0 closes now, as turned off.
    await this.monitoring.closeTurnedOffBreaches(null);

    return this.settings.getSanitizedWebServerSettings();
  }
}
