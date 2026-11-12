import { Injectable } from '@nestjs/common';
import { NotificationDispatcherService } from '../notifications/dispatcher.service';
import type { ServerThresholdEvent } from '../notifications/events/notification-event';
import type { MetricsConfig } from '../servers/server.schema';

/** The two metrics a Server threshold watches, each with its own breach. */
export type ThresholdMetric = 'CPU' | 'Memory';

/**
 * The row slice threshold evaluation needs — a Server's, or the web server's
 *, whose `organizationId` is null because the instance's own
 * machine belongs to no single organization. The dispatcher already reads a
 * null organization as "instance-wide", the way the local docker-cleanup run
 * and the instance-restart notice do.
 *
 * `cpuBreachedSince` and `memoryBreachedSince` are the stored open breach per
 * metric, null while none is open; `saveBreach` writes one of them
 * back to the row they were read from.
 */
export interface ThresholdTarget {
  name: string;
  organizationId: string | null;
  metricsConfig: MetricsConfig;
  cpuBreachedSince: string | null;
  memoryBreachedSince: string | null;
  saveBreach(metric: ThresholdMetric, since: string | null): Promise<void>;
}

/** Where each metric's threshold, sample value and stored breach live. */
const METRICS = [
  {
    metric: 'CPU',
    threshold: (config: MetricsConfig) => config.server.thresholds.cpu,
    value: (sample: ThresholdSample) => sample.cpu,
    since: (target: ThresholdTarget) => target.cpuBreachedSince,
  },
  {
    metric: 'Memory',
    threshold: (config: MetricsConfig) => config.server.thresholds.memory,
    value: (sample: ThresholdSample) => sample.memUsed,
    since: (target: ThresholdTarget) => target.memoryBreachedSince,
  },
] as const;

/** The two readings of a server sample a threshold is compared against. */
export interface ThresholdSample {
  cpu: number;
  memUsed: number;
}

/**
 * A **Server threshold** (CONTEXT.md): each fresh sample is compared
 * against the row's CPU and memory thresholds, and each metric's breach is a
 * stored state transition, announced exactly twice.
 *
 * - **Opens** on the first sample above a non-zero threshold while none is
 *   open: the row's `…BreachedSince` is set to the sample's time and one
 *   `server-threshold` Notification goes out, worded as it always was.
 * - **Stays open**, silently, while samples keep breaching.
 * - **Closes** on the first sample at or under the threshold, with one
 *   `recovered` close naming the value and the threshold.
 * - **Turned off**: a breached metric whose threshold is saved as 0 closes
 *   with one `turned-off` close **when the setting is saved**
 *   ({@link thresholdsSaved}), not on a later sample. Both save paths call it
 *   — a Server's `MonitoringService.setupMonitoring` and the platform host's
 *   `POST /admin/setup-monitoring` — because "stop collecting" is saved in the
 *   same request, and a close left to the next sample would stay open until
 *   collection resumed, then announce a turn-off from long before. The close
 *   carries the latest stored sample as its value (0 when retention has
 *   pruned every one). The save clears the stored breach, so the next sample
 *   finds nothing open and says nothing; {@link check} still closes a
 *   0-threshold breach it finds, for a row whose thresholds were written by
 *   anything but those two paths.
 * - Changing a non-zero threshold closes nothing; the next sample decides
 *   with the new value.
 *
 * The state is written before the Notification is dispatched, so a crash
 * between them loses one message rather than repeating one, and a restart
 * during a breach announces nothing because the breach was read back from
 * the row. A deleted Server takes its breach with it and announces nothing.
 * Not an Incident: it keeps no history.
 *
 * Evaluation is in-process and dispatches straight to the org's channels
 * with the actual server name; the token-authenticated receive endpoint
 * (phase 39), which only knows the token and so names every remote alert
 * "Remote", stays for external agents and reports only openings.
 */
@Injectable()
export class ThresholdService {
  constructor(private readonly dispatcher: NotificationDispatcherService) {}

  async check(
    target: ThresholdTarget,
    sample: ThresholdSample,
    timestamp: string,
  ): Promise<void> {
    for (const spec of METRICS) {
      const threshold = spec.threshold(target.metricsConfig);
      const value = spec.value(sample);
      const since = spec.since(target);

      if (since === null) {
        if (threshold === 0 || value <= threshold) continue;
        await target.saveBreach(spec.metric, timestamp);
        await this.send(target, {
          type: 'server-threshold',
          serverName: target.name,
          metric: spec.metric,
          value,
          threshold,
          message: `${spec.metric} usage (${value.toFixed(2)}%) exceeded threshold (${threshold.toFixed(2)}%)`,
          timestamp,
        });
        continue;
      }

      if (threshold > 0 && value > threshold) continue;
      await this.close(target, spec.metric, value, threshold, since, timestamp);
    }
  }

  /**
   * The save-time half of **Turned off**: every metric with a breach stored
   * open and a threshold now 0 closes with one `turned-off` close, and its
   * stored breach is cleared. Metrics still above 0 are left for the next
   * sample to decide, as any other threshold change is.
   *
   * `lastSample` is the latest sample stored for the target, or null when
   * there is none left, in which case the close reports 0.
   */
  async thresholdsSaved(
    target: ThresholdTarget,
    lastSample: ThresholdSample | null,
    timestamp: string,
  ): Promise<void> {
    for (const spec of METRICS) {
      const since = spec.since(target);
      if (since === null || spec.threshold(target.metricsConfig) !== 0) {
        continue;
      }
      const value = lastSample === null ? 0 : spec.value(lastSample);
      await this.close(target, spec.metric, value, 0, since, timestamp);
    }
  }

  /** Clears one metric's stored breach, then announces why it closed. */
  private async close(
    target: ThresholdTarget,
    metric: ThresholdMetric,
    value: number,
    threshold: number,
    since: string,
    timestamp: string,
  ): Promise<void> {
    await target.saveBreach(metric, null);
    await this.send(target, {
      type: 'server-threshold',
      serverName: target.name,
      metric,
      value,
      threshold,
      timestamp,
      message:
        threshold === 0
          ? `${metric} threshold was turned off while breached; usage is ${value.toFixed(2)}%`
          : `${metric} usage (${value.toFixed(2)}%) is back at or under threshold (${threshold.toFixed(2)}%)`,
      close: {
        reason: threshold === 0 ? 'turned-off' : 'recovered',
        breachedSince: since,
      },
    });
  }

  private send(
    target: ThresholdTarget,
    event: ServerThresholdEvent,
  ): Promise<void> {
    return this.dispatcher.dispatch(target.organizationId, event);
  }
}
