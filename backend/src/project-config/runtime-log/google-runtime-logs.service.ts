import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
} from '@nestjs/common';

import type { GcpCloudAccount } from '../../cloud-accounts/cloud-provider';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import { googleRefusalReason } from '../../cloud-accounts/gcp/api-off';
import { serviceName } from '../../cloud-accounts/gcp/definitions/names';
import type { CloudRunResource } from '../../cloud-accounts/gcp/definitions/cloud-run-definition';
import {
  GOOGLE_CLOUD_PORT,
  PERMISSION_DENIED,
  RESOURCE_EXHAUSTED,
} from '../../cloud-accounts/google-cloud.port';
import type {
  GoogleAccessToken,
  GoogleCloudPort,
  LogEntry,
} from '../../cloud-accounts/google-cloud.port';
import { describeError } from '../../common/describe-error';
import { googleRuntimeLines, runtimeLogFilter } from './google-runtime-log';
import type {
  GoogleRuntimeLog,
  GoogleRuntimeLogLine,
} from './google-runtime-log';
import { LOG_WATCH_MS, LogReadBudget } from './log-read-budget';
import {
  RUNTIME_LOG_LATE_MS,
  RUNTIME_LOG_LINES,
  RUNTIME_LOG_LOOKBACK_MS,
  RUNTIME_LOG_WINDOW_MS,
  startOf,
} from './runtime-log';

/** The deploy service account's access token is asked again after this long (it lasts an hour). */
const SESSION_REFRESH_MS = 30 * 60_000;

/** How many lines one Service's reader holds for the tabs that ask. */
const HELD_LINES = 2 * RUNTIME_LOG_LINES;

/** The Service whose log is read: its id, its name in refusals, its region. */
export interface GoogleLogService {
  readonly applicationId: string;
  readonly name: string;
  readonly region: string;
  /** What it runs as: a Worker's log is its worker pool's. */
  readonly resource: CloudRunResource;
}

/** One Service's reader, shared by every tab open on it. */
interface Reader {
  /** What it has read, merged by time, within the lookback. */
  lines: GoogleRuntimeLogLine[];
  /** Everything up to here has been read; `null` before the first read. */
  through: number | null;
  /** The read under way, which every tab asking meanwhile waits on. */
  reading: Promise<void> | null;
  /** The last read's failure, every tab's answer until a read works. */
  failure: Error | null;
  /** When a tab last asked. */
  askedAt: number;
}

/**
 * **The Runtime log of a Cloud Run Service** (S19b): read
 * from the Google project's own `_Default` log store, filtered to the
 * service, with the deploy service account's access token, so the cloud's
 * login never reaches the browser. Cloudgate makes no log store and never
 * touches the project's log settings.
 *
 * Unlike AWS, where each poll is one read, Google allows only 60 reads a
 * minute per project, so **one reader per Service is shared by every open
 * tab**: a tab's poll reads only when the {@link LogReadBudget} lets that
 * Service read (about 30 a minute per project id across the install, the
 * interval stretching as more Services there are watched), and is
 * otherwise answered from what the reader holds. A quota refusal is not a
 * failure: the project backs off and every tab says "logs delayed".
 *
 * `CloudRuntimeLogs` hands a Google Cloud account's Service here once it
 * has checked `service: read` and found the Service.
 */
@Injectable()
export class GoogleRuntimeLogs {
  private readonly budget = new LogReadBudget();
  private readonly readers = new Map<string, Reader>();
  /** Access tokens by Cloud account and its key, reused across reads. */
  private readonly sessions = new Map<
    string,
    { token: GoogleAccessToken; at: number }
  >();

  constructor(
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
    private readonly cloudAccounts: CloudAccountsService,
  ) {}

  async read(
    account: GcpCloudAccount,
    service: GoogleLogService,
    since: number | undefined,
  ): Promise<GoogleRuntimeLog> {
    const projectId = account.cloudId;
    const reader = this.readerOf(service.applicationId);
    this.budget.watch(projectId, service.applicationId, Date.now());
    if (reader.reading) {
      await reader.reading;
    } else if (this.budget.take(projectId, service.applicationId, Date.now())) {
      reader.reading = this.readOnce(account, service, reader)
        .then(
          () => {
            reader.failure = null;
          },
          (error: unknown) => {
            reader.failure =
              error instanceof Error ? error : new Error(describeError(error));
          },
        )
        .finally(() => {
          reader.reading = null;
        });
      await reader.reading;
    }
    if (reader.failure) throw reader.failure;

    const now = Date.now();
    const startTime = startOf(since, now);
    return {
      lines: reader.lines.filter((line) => line.at >= startTime),
      next: Math.max(
        startTime,
        (reader.through ?? startTime) - RUNTIME_LOG_LATE_MS,
      ),
      more: false,
      delayed: this.budget.delayed(projectId, now),
    };
  }

  /** One read of the project's log store into the Service's reader. */
  private async readOnce(
    account: GcpCloudAccount,
    service: GoogleLogService,
    reader: Reader,
  ): Promise<void> {
    const projectId = account.cloudId;
    const token = await this.session(account);
    const now = Date.now();
    const from =
      reader.through === null
        ? now - RUNTIME_LOG_WINDOW_MS
        : Math.max(
            reader.through - RUNTIME_LOG_LATE_MS,
            now - RUNTIME_LOG_LOOKBACK_MS,
          );
    const answer = await this.google
      .listLogEntries(token, {
        projectId,
        filter: runtimeLogFilter(
          {
            serviceName: serviceName(service.applicationId),
            region: service.region,
            resource: service.resource,
          },
          from,
        ),
        limit: RUNTIME_LOG_LINES,
        oldestFirst: true,
      })
      .catch((error: unknown) => {
        throw new BadGatewayException(
          `Google Cloud could not be reached for Cloud account ${account.name}: ${describeError(error)}`,
        );
      });
    if (!answer.ok) {
      if (answer.code === RESOURCE_EXHAUSTED) {
        this.budget.refused(projectId, Date.now());
        return;
      }
      const words = `${answer.code}: ${googleRefusalReason(answer.message, projectId)}`;
      if (answer.code === PERMISSION_DENIED) {
        await this.cloudAccounts.recordUseFailure(
          account.cloudAccountId,
          words,
        );
      }
      throw new BadRequestException(
        `Cloud account ${account.name} could not read the Runtime log of ${service.name}: Google Cloud answered ${words}`,
      );
    }
    this.budget.answered(projectId);
    this.take(reader, answer.value, now);
  }

  /**
   * A read's entries into the reader: kept once by id, merged by time,
   * within the lookback and {@link HELD_LINES}; read through to the last
   * line when the page was full, else to a few seconds ago.
   */
  private take(
    reader: Reader,
    entries: readonly LogEntry[],
    now: number,
  ): void {
    const fresh = googleRuntimeLines(entries);
    const seen = new Set(reader.lines.map((line) => line.id));
    const merged = [
      ...reader.lines,
      ...fresh.filter((line) => !seen.has(line.id)),
    ]
      .filter((line) => line.at >= now - RUNTIME_LOG_LOOKBACK_MS)
      .sort(
        (a, b) =>
          a.at - b.at ||
          a.task.localeCompare(b.task) ||
          a.id.localeCompare(b.id),
      );
    reader.lines = merged.slice(Math.max(0, merged.length - HELD_LINES));
    const last = fresh.at(-1);
    reader.through =
      entries.length >= RUNTIME_LOG_LINES && last ? last.at : now;
  }

  /** The Service's reader; readers no tab asked for in a while are let go. */
  private readerOf(applicationId: string): Reader {
    const now = Date.now();
    for (const [other, reader] of this.readers) {
      if (!reader.reading && now - reader.askedAt >= 2 * LOG_WATCH_MS) {
        this.readers.delete(other);
      }
    }
    let reader = this.readers.get(applicationId);
    if (!reader) {
      reader = {
        lines: [],
        through: null,
        reading: null,
        failure: null,
        askedAt: now,
      };
      this.readers.set(applicationId, reader);
    }
    reader.askedAt = now;
    return reader;
  }

  /** The deploy service account's access token, asked once and again when near its end. */
  private async session(account: GcpCloudAccount): Promise<GoogleAccessToken> {
    const key = [
      account.cloudAccountId,
      account.signingKeyId,
      account.deployServiceAccount,
      account.workloadIdentityProvider,
    ].join('\0');
    const held = this.sessions.get(key);
    if (held && Date.now() - held.at < SESSION_REFRESH_MS) return held.token;
    this.sessions.delete(key);
    const signed = await this.cloudAccounts.googleRunSession(account);
    if (!signed.ok) throw new BadRequestException(signed.refusal);
    for (const [other, entry] of this.sessions) {
      if (Date.now() - entry.at >= SESSION_REFRESH_MS)
        this.sessions.delete(other);
    }
    this.sessions.set(key, { token: signed.token, at: Date.now() });
    return signed.token;
  }
}
