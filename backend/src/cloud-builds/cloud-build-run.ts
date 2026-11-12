import type { CloudRunControl } from '../deployment-queue/cloud-run-job.types';

/**
 * **A hosted cloud build, cloud by cloud** (ADR-0047). On the Hosted
 * instance a cloud Service's image is built in its cloud's own build service
 * in the customer's account — CodeBuild on AWS (`AwsCloudBuilds`), Cloud
 * Build on Google Cloud — inside its Deployment's Cloud run, where
 * the platform-host build pushed. {@link runCloudBuild} is the part both
 * clouds share; a cloud gives it a {@link CloudBuildHalf}, which is only
 * direct API calls through that cloud's port, never `tofu` (ADR-0030).
 *
 * What it does, in this order, writing each step into the Deployment log:
 *
 * 1. **uploads the source zip** the platform host made of its checkout to
 *    the Environment's source bucket in the customer's account;
 * 2. **starts the build** from the pinned builder image with the buildspec
 *    (or build config) this Deployment's half wrote;
 * 3. **watches it**, copying each line the build writes to its cloud log
 *    into the Deployment log as it comes, so the console shows it live;
 *    while the build service says the build is still **queued** for
 *    capacity, the Cloud run's time limit is held, so the wait never counts
 *    against Cloudgate's deploy timeout (a fresh AWS account runs one build
 *    at a time);
 * 4. **ends with the build**: its exported values on success, its cloud's
 *    words on a failure. Cancel, Stop the run and the time limit
 *    interrupt the run; the build is then stopped in its cloud and the run
 *    fails once the cloud says it has stopped (or at the kill);
 * 5. **removes the zip**, however the build ended, since no lifecycle rule
 *    on the bucket does. A removal that fails is a log line, never
 *    the Deployment's outcome.
 */
export interface CloudBuildHalf {
  /** The build service, as the log names it: `CodeBuild`, `Cloud Build`. */
  readonly service: string;
  /** Where the zip goes, as the log names it: `s3://bucket/key`. */
  readonly sourcePlace: string;
  /** Step 1: the zip's upload. A failure throws its sentence. */
  upload(): Promise<void>;
  /** Step 2: the build's id. A refusal throws its sentence. */
  start(): Promise<string>;
  /** Where the build is now. A refusal throws its sentence. */
  progress(buildId: string): Promise<CloudBuildProgress>;
  /**
   * Lines the build wrote after `from` (the last read's `next`), oldest
   * first. A build whose log is not made yet has none.
   */
  readLog(
    buildId: string,
    from: string | null,
  ): Promise<{ lines: string[]; next: string | null }>;
  /** Asks the cloud to stop the build. A refusal throws its sentence. */
  stop(buildId: string): Promise<void>;
  /** Step 5: the zip removed. A failure throws its sentence. */
  removeSource(): Promise<void>;
  /**
   * How long the log is read on once the build has ended, for a log store
   * that shows a line only some seconds after the build wrote it (Cloud
   * Logging): every `everyMs` until a read made at
   * least `quietAfterMs` after the end finds nothing new, and no read later
   * than `capMs` after it. Omitted, the read that saw the end is the last.
   */
  readonly logSettle?: CloudBuildLogSettle;
}

/** A build log's read after the end, as {@link CloudBuildHalf.logSettle} says. */
export interface CloudBuildLogSettle {
  readonly everyMs: number;
  readonly quietAfterMs: number;
  readonly capMs: number;
}

/** Where a build is, in either cloud's terms. */
export type CloudBuildProgress =
  /** Waiting for capacity in the build service: the time limit is held. */
  | { readonly phase: 'queued' }
  | { readonly phase: 'running' }
  | {
      readonly phase: 'succeeded';
      /** What the build program exported (the built image's facts). */
      readonly exported: Readonly<Record<string, string>>;
    }
  /** Failed, faulted or timed out in the cloud, in its words. */
  | { readonly phase: 'failed'; readonly reason: string }
  | { readonly phase: 'stopped' };

export interface CloudBuildWatch {
  readonly control: CloudRunControl;
  readonly log: (line: string) => Promise<void>;
  /** How often the build is asked where it is. */
  readonly pollIntervalMs: number;
}

/** What a run ended from outside fails with, once its build has stopped. */
export function endedWhileBuilding(service: string): string {
  return `The run was ended while ${service} built the image; the build was stopped`;
}

/** Steps 1 to 5 above: the build's exported values, or a throw saying why not. */
export async function runCloudBuild(
  half: CloudBuildHalf,
  watch: CloudBuildWatch,
): Promise<Readonly<Record<string, string>>> {
  const { control, log } = watch;
  const { service } = half;
  await log(`📤 [Build] Uploading the source to ${half.sourcePlace}`);
  let release: (() => void) | null = null;
  const count = () => {
    release?.();
    release = null;
  };
  try {
    await half.upload();
    if (control.signal.interrupted) {
      throw new Error(`The run was ended before ${service} started the build`);
    }
    const buildId = await half.start();
    await log(
      `🔨 [Build] ${service} build ${buildId} started from the Cloudgate builder image`,
    );
    let from: string | null = null;
    let logRefused = false;
    /** How many lines it copied. */
    const copyLog = async (): Promise<number> => {
      try {
        const read = await half.readLog(buildId, from);
        for (const line of read.lines) await log(line);
        from = read.next;
        return read.lines.length;
      } catch (error) {
        // A log that cannot be read never fails the build; it says so once.
        if (!logRefused) {
          logRefused = true;
          await log(
            `⚠️ [Build] The build log could not be read (${messageOf(error)}); the build goes on`,
          );
        }
        return 0;
      }
    };
    /** The lines the log store shows late, once the build has ended. */
    const settleLog = async () => {
      const settle = half.logSettle;
      if (!settle) return;
      const endedAt = Date.now();
      for (;;) {
        if (control.signal.killed) return;
        if (Date.now() - endedAt + settle.everyMs > settle.capMs) return;
        await pause({ ...watch, pollIntervalMs: settle.everyMs }, false);
        const copied = await copyLog();
        if (copied === 0 && Date.now() - endedAt >= settle.quietAfterMs) {
          return;
        }
      }
    };
    let said: CloudBuildProgress['phase'] | null = null;
    let stopAsked = false;
    for (;;) {
      if (control.signal.killed) throw new Error(endedWhileBuilding(service));
      if (control.signal.interrupted && !stopAsked) {
        stopAsked = true;
        count();
        await log(`⏹️ [Build] Stopping the ${service} build`);
        await half.stop(buildId).catch(async (error: unknown) => {
          await log(
            `⚠️ [Build] ${service} did not take the stop (${messageOf(error)})`,
          );
        });
      }
      const progress = await half.progress(buildId);
      await copyLog();
      if (
        progress.phase === 'succeeded' ||
        progress.phase === 'failed' ||
        progress.phase === 'stopped'
      ) {
        await settleLog();
      }
      switch (progress.phase) {
        case 'queued':
          if (said !== 'queued') {
            await log(
              `⏳ [Build] Queued in ${service}, waiting for capacity in the Cloud account; this wait does not count against the Cloud run time limit`,
            );
          }
          if (!stopAsked && release === null) {
            release = control.holdTimeLimit();
          }
          break;
        case 'running':
          count();
          if (said !== 'running') {
            await log(`🔨 [Build] ${service} is building the image`);
          }
          break;
        case 'succeeded':
          count();
          if (stopAsked) throw new Error(endedWhileBuilding(service));
          await log(`✅ [Build] ${service} built the image`);
          return progress.exported;
        case 'failed':
          count();
          if (stopAsked) throw new Error(endedWhileBuilding(service));
          throw new Error(
            `The ${service} build failed: ${progress.reason}. The lines above say why`,
          );
        case 'stopped':
          count();
          throw new Error(
            stopAsked
              ? endedWhileBuilding(service)
              : `The ${service} build was stopped in the Cloud account before it finished`,
          );
      }
      said = progress.phase;
      // Once the stop is asked, the run waits for the cloud to say so.
      await pause(watch, !stopAsked);
    }
  } finally {
    count();
    await half.removeSource().then(
      () => log(`🧹 [Build] Removed the source zip from ${half.sourcePlace}`),
      (error: unknown) =>
        log(
          `⚠️ [Build] The source zip was not removed from ${half.sourcePlace} (${messageOf(error)}); remove it by hand`,
        ),
    );
  }
}

/** One poll interval, cut short by a kill and, until a stop is asked, an interrupt. */
function pause(
  { control, pollIntervalMs }: CloudBuildWatch,
  wakeOnInterrupt: boolean,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, pollIntervalMs);
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    if (wakeOnInterrupt) control.signal.onInterrupt(wake);
    control.signal.onKill(wake);
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
