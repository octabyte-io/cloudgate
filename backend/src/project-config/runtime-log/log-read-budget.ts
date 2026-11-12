/**
 * The share of a Google project's log reads Cloudgate takes:
 * Cloud Logging allows 60 `entries.list` a minute per project, and about
 * half is left to the operator's own tools.
 */
export const GOOGLE_LOG_READS_PER_MINUTE = 30;

const MINUTE = 60_000;

/** A Service is watched while one of its tabs asked within this long. */
export const LOG_WATCH_MS = 30_000;

/** The first wait after a quota refusal; each refusal after it doubles it. */
export const LOG_BACKOFF_MS = 30_000;

/** No wait after a quota refusal is longer than this. */
export const LOG_BACKOFF_MAX_MS = 5 * MINUTE;

interface ProjectReads {
  /** When each watched Service's tab last asked. */
  readonly watched: Map<string, number>;
  /** When each Service last read. */
  readonly lastRead: Map<string, number>;
  /** When the reads of the last minute went. */
  reads: number[];
  /** No read goes before this, after a quota refusal. */
  backoffUntil: number;
  /** The next refusal's wait. */
  backoffMs: number;
}

/**
 * **The Runtime log's read budget on Google Cloud** (S19b):
 * about {@link GOOGLE_LOG_READS_PER_MINUTE} reads a minute **per Google
 * project id across the whole install**, since Google's allowance is the
 * project's and two Organizations could connect one project.
 *
 * Each watched Service reads at most once an interval, the minute shared
 * evenly among the Services of that project being watched, so the interval
 * stretches as more are watched; a count of the last minute's reads holds
 * the line while Services come and go. A quota refusal backs the whole
 * project off, longer each time, until a read works.
 *
 * Time is handed in, so the arithmetic is the caller's clock's.
 */
export class LogReadBudget {
  private readonly projects = new Map<string, ProjectReads>();

  /** A tab asked for `service`'s log: it is watched for {@link LOG_WATCH_MS} more. */
  watch(projectId: string, service: string, now: number): void {
    this.project(projectId, now).watched.set(service, now);
  }

  /** How long each watched Service of the project waits between reads now. */
  intervalMs(projectId: string, now: number): number {
    const watched = Math.max(1, this.project(projectId, now).watched.size);
    return (MINUTE * watched) / GOOGLE_LOG_READS_PER_MINUTE;
  }

  /** Whether `service` may read now; if it may, the read is counted. */
  take(projectId: string, service: string, now: number): boolean {
    const project = this.project(projectId, now);
    if (now < project.backoffUntil) return false;
    const last = project.lastRead.get(service);
    if (last !== undefined && now - last < this.intervalMs(projectId, now)) {
      return false;
    }
    if (project.reads.length >= GOOGLE_LOG_READS_PER_MINUTE) return false;
    project.reads.push(now);
    project.lastRead.set(service, now);
    return true;
  }

  /** Google refused a read over the project's quota: no read until the wait is over. */
  refused(projectId: string, now: number): void {
    const project = this.project(projectId, now);
    project.backoffUntil = now + project.backoffMs;
    project.backoffMs = Math.min(project.backoffMs * 2, LOG_BACKOFF_MAX_MS);
  }

  /** A read worked: the project is no longer delayed, and the next wait starts short. */
  answered(projectId: string): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    project.backoffUntil = 0;
    project.backoffMs = LOG_BACKOFF_MS;
  }

  /** Whether the project is waiting out a quota refusal: its tabs say "logs delayed". */
  delayed(projectId: string, now: number): boolean {
    return now < (this.projects.get(projectId)?.backoffUntil ?? 0);
  }

  /** The project's reads, with what is too old to count let go. */
  private project(projectId: string, now: number): ProjectReads {
    let project = this.projects.get(projectId);
    if (!project) {
      project = {
        watched: new Map(),
        lastRead: new Map(),
        reads: [],
        backoffUntil: 0,
        backoffMs: LOG_BACKOFF_MS,
      };
      this.projects.set(projectId, project);
    }
    for (const [service, at] of project.watched) {
      if (now - at >= LOG_WATCH_MS) project.watched.delete(service);
    }
    for (const [service, at] of project.lastRead) {
      if (now - at >= LOG_BACKOFF_MAX_MS) project.lastRead.delete(service);
    }
    project.reads = project.reads.filter((at) => now - at < MINUTE);
    return project;
  }
}
