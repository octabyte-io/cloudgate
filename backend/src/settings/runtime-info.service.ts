import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  localCloudgateDirectory,
  REMOTE_CLOUDGATE_DIRECTORY,
} from '../common/config/cloudgate-directory';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { execByServer } from '../docker-ops/server-access';
import { RemoteExecService } from '../remote/remote-exec.service';
import { DOCKER_VERSION, TRAEFIK_VERSION } from '../servers/server-setup';
import { getCloudgateImageTag } from './docker-resource.service';
import { runtimeProbeCommand } from './runtime-probe';
import type { RuntimeProbeRaw } from './runtime-probe';
import { CLOUDGATE_VERSION } from './version';

/**
 * One reading of one thing, with what configuration *declares* beside what the
 * host *reports* — the gap between the two is the whole point.
 *
 * `declared` is null where nothing declares the value (Postgres, the kernel,
 * Swarm's state); `observed` is null where the host could not be asked, and
 * `reason` then says why. Both are independently nullable on purpose: an
 * inventory that 500s because one binary is missing is worse during an incident
 * than not having one at all.
 */
export interface Probe<T> {
  /** What Cloudgate's own configuration pins, or null if nothing pins it. */
  declared: T | null;
  /** What the host answered, or null — see `reason`. */
  observed: T | null;
  /**
   * The host's unparsed answer, where `observed` is a reading of it — the
   * Traefik image reference behind a version, Postgres's full banner. Absent
   * where the answer needed no reading.
   */
  raw?: string | null;
  /** Why `observed` is null. Absent when it is not. */
  reason?: string;
  /**
   * Which machine this reading is a fact about. `'host'` is the host the
   * request named — the Server, or the platform host when it named none.
   * `'process'` is the Cloudgate process answering the request, and it is the
   * same value whatever `serverId` names.
   *
   * It is on every probe rather than only on the process-scoped ones, so a
   * consumer never needs a hardcoded list of which keys are the exceptions,
   * and an absent `scope` can never quietly mean `'host'`. It exists because
   * a Server whose every shell probe timed out still answered a confident
   * `postgres.observed`, in a payload that was otherwise uniformly *could not
   * reach this host* — a positive signal pointing at the wrong machine, which
   * is worse than a missing one.
   */
  scope: 'host' | 'process';
  /**
   * Both values are known and they disagree. False whenever either side is
   * unknown, so `drift` is never a guess: an install pinning Traefik 3.6.7
   * while the running container is still 3.5.0 reads true here, and one that
   * cannot be reached reads false with a `reason` on `observed`.
   */
  drift: boolean;
}

/** What `GET /settings/runtime-info` answers for one host. */
export interface RuntimeInfo {
  /** The Server described, or null for the platform host (ADR-0008). */
  serverId: string | null;
  /** When the probe actually ran — an answer is reused for up to the TTL. */
  observedAt: string;
  /**
   * The Cloudgate process itself. Declared-only, and the *same values whatever
   * `serverId` names* — which is what `scope: 'process'` states in the payload
   * rather than only here. `postgres` below is the same: Cloudgate
   * connects to one database over `DATABASE_URL` and a Server has no database
   * of its own.
   */
  cloudgate: {
    /** Always `'process'`. Present so the block says what it is on the wire. */
    scope: 'process';
    /** `CLOUDGATE_VERSION`, out of backend/package.json. */
    version: string;
    /** `RELEASE_TAG`, the image tag this instance believes it runs. */
    releaseTag: string;
    /** `process.version`. */
    node: string;
    /** `process.uptime()`, whole seconds. */
    uptimeSeconds: number;
  };
  /** `SELECT version()` on the injected pool — always `scope: 'process'`. Declared by nothing. */
  postgres: Probe<string>;
  /** `TRAEFIK_VERSION` against the running container's own image tag. */
  traefik: Probe<string>;
  /** `DOCKER_VERSION` — what setup installs — against the daemon's version. */
  docker: Probe<string>;
  /** `{{.Swarm.LocalNodeState}}`: `active`, `inactive`, `pending`, `locked`. */
  swarm: Probe<string>;
  /** `PRETTY_NAME` out of `/etc/os-release`. */
  operatingSystem: Probe<string>;
  /** `uname -sr`. */
  kernel: Probe<string>;
  /** The probed host's own uptime, whole seconds. */
  uptimeSeconds: Probe<number>;
  /** Whether `cloudgate-network` exists on the probed host. */
  cloudgateNetwork: Probe<boolean>;
  /** Space on the platform directory, which is not the same path on a Server. */
  directory: {
    /** Measured path: this instance's own root, or the Server's. */
    path: string;
    freeBytes: number | null;
    totalBytes: number | null;
    /** Why the two figures are null. Absent when they are not. */
    reason?: string;
  };
}

/**
 * How long one host's answer is reused. Inside the 30–60s the issue asked for:
 * the route shells out once and queries Postgres once per call and is meant to
 * sit behind a page someone leaves open, while a version that changed two
 * versions ago is still the same version 45 seconds later.
 */
export const RUNTIME_INFO_CACHE_MS = 45_000;

/** How much of a failure's own words survive into a `reason`. */
const MAX_REASON_LENGTH = 200;

/**
 * Everything a host is actually running, declared beside observed.
 *
 * **Which of the five overlapping routes to reach for**, because there are now
 * five and only this one answers the question by name:
 *
 * | Route | Answers |
 * |---|---|
 * | `GET /settings/runtime-info` | declared *and observed* versions, per host — **start here** |
 * | `GET /settings/version` | `CLOUDGATE_VERSION` alone, any authenticated caller |
 * | `GET /settings/release-tag` | `RELEASE_TAG` alone, any authenticated caller |
 * | `GET /settings/infrastructure-health` | up/down for Postgres and Traefik, not versions |
 * | `GET /settings/health` | a public liveness ping |
 *
 * The three narrow ones are deliberately left exactly as they are — the console
 * and API clients call them and a fifth route is not a reason to break a
 * fourth. What they cannot do is state a version the host confirmed: every one
 * of them re-serves a constant this process was compiled with, which is why the
 * console's Traefik version was a hardcoded `v3.5.0` for as long as it was and
 * nobody could tell. This service reports both sides so drift is a diff
 * rather than a guess.
 *
 * Every probe carries `scope`: `'host'` for a reading off the machine the
 * request named, `'process'` for one about the Cloudgate process answering it.
 * `directory` is not a `Probe` and scopes itself by publishing its `path`.
 *
 * Not `@Public()`, unlike `/settings/health`: a precise version inventory of
 * someone's fleet is a targeting aid, so the route is owner/admin only, the
 * same gate `infrastructure-health` carries.
 */
@Injectable()
export class RuntimeInfoService {
  private readonly logger = new Logger(RuntimeInfoService.name);

  /**
   * One in-flight-or-fresh answer per host, keyed by `serverId` with the empty
   * string standing for the platform host.
   *
   * The *promise* is cached rather than the value, which also collapses two
   * concurrent requests into one round trip — the case a page with two panels
   * open produces on every mount. A rejection is evicted immediately so a
   * transient failure cannot be served for the rest of the window; in practice
   * `probe` catches everything, and this is the belt for the day it does not.
   */
  private readonly cache = new Map<
    string,
    { expiresAt: number; answer: Promise<RuntimeInfo> }
  >();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly remoteExec: RemoteExecService,
  ) {}

  /**
   * The inventory for one host. `serverId` absent or null is the platform host
   * (ADR-0008); the caller's entitlement to a named Server is checked before
   * this is reached, in the controller, through `checkServerAccess`.
   */
  getRuntimeInfo(serverId?: string | null): Promise<RuntimeInfo> {
    const key = serverId ?? '';
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.answer;

    const answer = this.collect(serverId ?? null);
    this.cache.set(key, { expiresAt: now + RUNTIME_INFO_CACHE_MS, answer });
    answer.catch(() => this.cache.delete(key));
    this.prune(now);
    return answer;
  }

  /** Drops expired entries so a long-lived fleet does not accumulate keys. */
  private prune(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }

  private async collect(serverId: string | null): Promise<RuntimeInfo> {
    const directory = serverId
      ? REMOTE_CLOUDGATE_DIRECTORY
      : localCloudgateDirectory();

    const [probe, postgres] = await Promise.all([
      this.probe(serverId, directory),
      this.probePostgres(),
    ]);

    return {
      serverId,
      observedAt: new Date().toISOString(),
      cloudgate: {
        scope: 'process',
        version: CLOUDGATE_VERSION,
        releaseTag: getCloudgateImageTag(),
        node: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
      },
      postgres,
      traefik: this.traefikProbe(probe),
      docker: probeString(
        DOCKER_VERSION,
        probe.raw?.docker,
        probe.reason ?? 'the Docker daemon did not report a version',
      ),
      swarm: probeString(
        null,
        probe.raw?.swarm,
        probe.reason ?? 'the Docker daemon did not report a Swarm state',
      ),
      operatingSystem: probeString(
        null,
        probe.raw?.os,
        probe.reason ?? '/etc/os-release has no PRETTY_NAME on this host',
      ),
      kernel: probeString(
        null,
        probe.raw?.kernel,
        probe.reason ?? 'uname did not answer on this host',
      ),
      uptimeSeconds: probeNumber(
        probe.raw?.uptimeSeconds,
        probe.reason ?? '/proc/uptime is not readable on this host',
      ),
      cloudgateNetwork: probeBoolean(
        probe.raw?.network,
        probe.reason ?? 'the Docker daemon did not answer',
      ),
      directory: this.directoryProbe(directory, probe),
    };
  }

  /**
   * The single round trip. Its failure — no SSH route to the Server, a key that
   * refuses, a host with no shell — is the one failure that takes every
   * shell-derived field down at once, so it is reported once as a `reason` each
   * of those fields carries, and never thrown.
   */
  private async probe(
    serverId: string | null,
    directory: string,
  ): Promise<{ raw?: RuntimeProbeRaw; reason?: string }> {
    try {
      const { stdout } = await execByServer(
        this.remoteExec,
        serverId,
        runtimeProbeCommand(directory),
      );
      // The last line, not the whole of stdout: a login shell's motd or an
      // sshd banner lands ahead of the document on a remote host.
      const document = stdout.trim().split('\n').pop() ?? '';
      return { raw: JSON.parse(document) as RuntimeProbeRaw };
    } catch (error) {
      // The operator asking this question is an owner or admin during an
      // incident, so the failure's own words are what they need; §2.5's "never
      // an internal detail" governs an HttpException message, which this is
      // deliberately not — the response is still 200 with the rest populated.
      const reason = shortReason(error, 'the host could not be probed');
      this.logger.warn(
        `Runtime probe failed for ${serverId ?? 'the platform host'}: ${reason}`,
      );
      return { reason };
    }
  }

  /** `SELECT version()` — the database this process is connected to. */
  private async probePostgres(): Promise<Probe<string>> {
    try {
      const result = await this.db.execute<{ version: string }>(
        sql`select version()`,
      );
      const banner = result.rows[0]?.version ?? '';
      const observed = postgresVersionFromBanner(banner);
      return {
        declared: null,
        observed,
        raw: banner || null,
        ...(observed
          ? {}
          : { reason: 'Postgres did not report a recognisable version' }),
        scope: 'process',
        drift: false,
      };
    } catch (error) {
      // A database that did not answer is still a fact about this process and
      // not about the named host, so the catch carries the marker too.
      return {
        declared: null,
        observed: null,
        raw: null,
        reason: shortReason(error, 'the database did not answer'),
        scope: 'process',
        drift: false,
      };
    }
  }

  /**
   * Traefik's declared version against the tag of the image its container is
   * actually running. The comparison has to go through the image reference —
   * `TRAEFIK_VERSION` is `3.6.7` and the container reports `traefik:v3.6.7`, so
   * comparing the two raw would report drift on every healthy install.
   */
  private traefikProbe(probe: {
    raw?: RuntimeProbeRaw;
    reason?: string;
  }): Probe<string> {
    const image = probe.raw?.traefik?.trim() || null;
    if (!image) {
      return {
        declared: TRAEFIK_VERSION,
        observed: null,
        raw: null,
        reason: probe.reason ?? 'cloudgate-traefik is not present on this host',
        scope: 'host',
        drift: false,
      };
    }
    const observed = traefikVersionFromImage(image);
    return {
      declared: TRAEFIK_VERSION,
      observed,
      raw: image,
      ...(observed
        ? {}
        : { reason: 'the running Traefik image carries no version tag' }),
      scope: 'host',
      drift: observed !== null && observed !== TRAEFIK_VERSION,
    };
  }

  private directoryProbe(
    directory: string,
    probe: { raw?: RuntimeProbeRaw; reason?: string },
  ): RuntimeInfo['directory'] {
    const free = kibToBytes(probe.raw?.diskFreeKib);
    const total = kibToBytes(probe.raw?.diskTotalKib);
    return {
      path: directory,
      freeBytes: free,
      totalBytes: total,
      ...(free !== null && total !== null
        ? {}
        : {
            reason: probe.reason ?? `${directory} is not present on this host`,
          }),
    };
  }
}

/** A trimmed, single-line reason, so one long stack cannot fill the payload. */
function shortReason(error: unknown, fallback: string): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const line = message.split('\n')[0].trim();
  if (!line) return fallback;
  return line.length > MAX_REASON_LENGTH
    ? `${line.slice(0, MAX_REASON_LENGTH)}…`
    : line;
}

/**
 * The version out of a Postgres banner — `PostgreSQL 16.4 (Debian …) on x86_64`
 * is the whole of what `version()` answers, and the first token after the
 * product name is the only part anyone compares.
 */
export function postgresVersionFromBanner(banner: string): string | null {
  return /^PostgreSQL\s+(\S+)/.exec(banner.trim())?.[1] ?? null;
}

/**
 * The version an image reference names: `traefik:v3.5.0` → `3.5.0`, and the
 * same through a registry with a port (`registry:5000/traefik:v3.5.0`) or a
 * digest suffix. Null where the reference carries no tag at all, because
 * `traefik` and `traefik@sha256:…` say nothing about which version is running
 * and reporting `latest`-shaped drift off them would be an invention.
 */
export function traefikVersionFromImage(image: string): string | null {
  const withoutDigest = image.split('@')[0];
  const colon = withoutDigest.indexOf(':', withoutDigest.lastIndexOf('/') + 1);
  if (colon === -1) return null;
  return withoutDigest.slice(colon + 1).replace(/^v/, '') || null;
}

/** An empty probe value means "the host could not answer this one". */
function probeString(
  declared: string | null,
  value: string | undefined,
  reason: string,
): Probe<string> {
  const observed = value?.trim() || null;
  return {
    declared,
    observed,
    ...(observed ? {} : { reason }),
    scope: 'host',
    drift: declared !== null && observed !== null && declared !== observed,
  };
}

function probeNumber(value: string | undefined, reason: string): Probe<number> {
  const parsed = Number.parseInt(value?.trim() ?? '', 10);
  const observed = Number.isFinite(parsed) ? parsed : null;
  return {
    declared: null,
    observed,
    ...(observed === null ? { reason } : {}),
    scope: 'host',
    drift: false,
  };
}

function probeBoolean(
  value: string | undefined,
  reason: string,
): Probe<boolean> {
  const text = value?.trim();
  const observed = text === 'true' ? true : text === 'false' ? false : null;
  return {
    declared: null,
    observed,
    ...(observed === null ? { reason } : {}),
    scope: 'host',
    drift: false,
  };
}

/** `df -Pk` counts 1 KiB blocks; the payload is bytes. */
function kibToBytes(value: string | undefined): number | null {
  const parsed = Number.parseInt(value?.trim() ?? '', 10);
  return Number.isFinite(parsed) ? parsed * 1024 : null;
}
