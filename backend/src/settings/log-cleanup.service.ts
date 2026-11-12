import { Injectable, Logger } from '@nestjs/common';
import { SchedulingService } from '../scheduling/scheduling.service';
import { SettingsService } from './settings.service';
import { TraefikFilesService } from './traefik-files.service';
import type { AccessLogRotation } from './traefik-files.service';

const LOG_CLEANUP_JOB_NAME = 'access-log-cleanup';

/**
 * The cron that keeps the platform host's Traefik access log from growing
 * without limit. A Server's is `ServerAccessLogUpkeepService`'s (ADR-0057).
 *
 * It used to do that by *truncating* — `tail -n 1000 > tmp && mv` — which bounded
 * the file at the cost of throwing away every request older than the last
 * thousand, silently, once a day. A request-analytics screen asking for "last 7
 * days" then got an honest-looking answer computed from whatever had survived
 * this morning. It now rotates instead: the log is renamed aside past
 * `ACCESS_LOG_MAX_BYTES` and Traefik is asked to reopen, so the file the reader
 * walks is still bounded but the history is kept next to it rather than deleted.
 */
@Injectable()
export class LogCleanupService {
  private readonly logger = new Logger(LogCleanupService.name);

  constructor(
    private readonly scheduling: SchedulingService,
    private readonly settings: SettingsService,
    private readonly traefikFiles: TraefikFilesService,
  ) {}

  /** Register the rotation cron (daily by default) and store its expression. */
  async start(cronExpression = '0 0 * * *'): Promise<boolean> {
    try {
      this.scheduling.register(LOG_CLEANUP_JOB_NAME, cronExpression, null, () =>
        this.runCleanup(),
      );
      await this.settings.updateWebServerSettings({
        logCleanupCron: cronExpression,
      });
      return true;
    } catch (error) {
      console.error('Error starting log cleanup:', error);
      return false;
    }
  }

  /** Unregister the rotation cron and clear its stored expression. */
  async stop(): Promise<boolean> {
    try {
      this.scheduling.unregister(LOG_CLEANUP_JOB_NAME);
      await this.settings.updateWebServerSettings({ logCleanupCron: null });
      return true;
    } catch (error) {
      console.error('Error stopping log cleanup:', error);
      return false;
    }
  }

  /** The stored rotation schedule; enabled whenever one is set. */
  async getStatus(): Promise<{
    enabled: boolean;
    cronExpression: string | null;
  }> {
    const settings = await this.settings.getWebServerSettings();
    const cronExpression = settings.logCleanupCron ?? null;
    return { enabled: cronExpression !== null, cronExpression };
  }

  /**
   * The cron body: rotate the platform host's access log if it has outgrown
   * its limit.
   *
   * The size gate is checked when the cron fires, so what actually bounds the
   * file is `ACCESS_LOG_MAX_BYTES` *or* one cron interval of traffic, whichever
   * is larger — on an ingress busy enough to write 100 MiB between two runs of a
   * daily job, the answer is to tighten `logCleanupCron`, and there is no way for
   * this service to know that without polling.
   *
   * **The platform host only.** This cron used to walk every Server after the
   * host, which put a customer's disk under `logCleanupCron` and the
   * Maintenance switch — settings the Instance organization owns, which on the
   * Hosted instance could let every customer Server fill. Servers have their
   * own hourly job with no off switch, `ServerAccessLogUpkeepService`
   * (ADR-0057).
   */
  async runCleanup(): Promise<void> {
    try {
      this.report(await this.traefikFiles.rotateAccessLog());
    } catch (error) {
      this.logger.error(
        `Error during access-log rotation on the platform host: ${String(error)}`,
      );
    }
  }

  /**
   * A rotation that moved the log and could not signal Traefik is the one
   * outcome worth a line: Traefik is still appending to the backup, and the
   * console shows nothing new until it restarts.
   */
  private report(result: AccessLogRotation): void {
    if (!result.rotated || result.reopened) return;
    this.logger.error(
      `Rotated the access log on the platform host at ${result.bytes} bytes but could not signal Traefik; it is still writing to ${result.backup}`,
    );
  }
}
