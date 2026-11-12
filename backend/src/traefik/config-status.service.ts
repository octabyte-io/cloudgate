import { Injectable, Logger } from '@nestjs/common';
import { execOnServer } from '../remote/exec-dispatch';
import { RemoteExecService } from '../remote/remote-exec.service';
// The platform's own Traefik, by the one name three services now resolve it
// under. Imported rather than restated (§1.4): a second literal is how
// the rotation, the cleanup and this check would come to disagree about which
// container they are talking to. `traefik-files.service.ts` reaches nothing in
// this directory, so the import direction opens no cycle.
import { TRAEFIK_CONTAINER_NAME } from '../settings/traefik-files.service';
import type {
  TraefikConfigSubject,
  TraefikConsoleSource,
  TraefikRouterSubjects,
} from './config/names';
import {
  buildConsoleRouterIndex,
  MIDDLEWARES_CONFIG_NAME,
} from './config/names';
import { CONSOLE_CONFIG_NAME } from './config/web-server';
import type { TraefikRouterError } from './traefik-log';
import { parseTraefikRouterErrors } from './traefik-log';
import { TraefikWriterService } from './traefik-writer.service';

/** One router Traefik refused to build, in Cloudgate's vocabulary. */
export interface TraefikConfigRejection {
  /** The Traefik router name, kept so the log line can be matched by hand. */
  routerName: string;
  /** Traefik's own sentence, with emitted secrets removed. */
  message: string;
  /** The Domain whose routers these are. It is dark until this is fixed. */
  domain: { domainId: string; host: string };
  /** Every Cloudgate row the dropped router's chain names, Domain included. */
  subjects: TraefikConfigSubject[];
  /** Docker's timestamp for the line, so a reader can see how fresh it is. */
  observedAt: string;
}

/**
 * What the last look at Traefik said about one application's config.
 *
 * `state` is three-valued on purpose. `checked` means Traefik's log was read
 * and `rejections` is what it said; **it is not a claim that the config is
 * healthy**, because a reload Traefik accepted logs nothing at all and is
 * therefore indistinguishable from a reload that has not happened yet.
 * `unavailable` means the log could not be read — no Traefik container on that
 * server, a daemon that would not answer — and is deliberately not an error:
 * this surface never fails a write.
 */
export interface TraefikConfigStatus {
  applicationId: string;
  appName: string;
  state: 'checked' | 'unavailable';
  /** Why the log could not be read, when `state` is `unavailable`. */
  reason?: string;
  /** When Cloudgate looked, by this instance's clock. */
  checkedAt: string;
  rejections: TraefikConfigRejection[];
}

/**
 * One router Traefik refused that no Application owns (H-61).
 *
 * Deliberately not a `TraefikConfigRejection`: that type leads with a Domain,
 * and there is none here. What replaces it is the operator surface that wrote
 * the router — the file provider watches two files nobody's Application owns —
 * because that is what a person can go and correct.
 */
export interface TraefikConsoleRejection {
  routerName: string;
  /** Traefik's own sentence, carried verbatim. */
  message: string;
  /** Which of the two operator surfaces wrote this router. */
  source: TraefikConsoleSource;
  /** The middlewares the router names; any one of them can be the failure. */
  middlewares: string[];
  observedAt: string;
}

/**
 * What the last look at Traefik said about the console's own routers.
 *
 * `state` carries the same two values as {@link TraefikConfigStatus} and means
 * exactly the same things by them — `checked` is "this is what the log said",
 * never "the console is being served".
 */
export interface TraefikConsoleStatus {
  state: 'checked' | 'unavailable';
  reason?: string;
  checkedAt: string;
  rejections: TraefikConsoleRejection[];
}

/** The one look's inputs: what was written, and what its names mean. */
export interface TraefikVerifyInput {
  applicationId: string;
  appName: string;
  serverId: string | null;
  /** `buildRouterSubjectIndex`'s output for the config just written. */
  routers: Map<string, TraefikRouterSubjects>;
  /**
   * Values the emitted config carries that must not leave the server — today
   * the `username:bcrypt-hash` entries of the basicAuth middleware. Traefik
   * quotes the offending entry back in its own error text, and
   * `SecurityService` is explicit that the password never leaves the server, so
   * any of these appearing in a message is cut out of it before the message is
   * stored or served.
   */
  secrets?: string[];
}

/**
 * How long to wait after the write before reading Traefik's log.
 *
 * The file provider is fsnotify-driven and re-reads the whole watched directory
 * on any event; against traefik:v3.6.7 the error line for a freshly written bad
 * config was on stdout inside a second. Two seconds is that with headroom for a
 * loaded host and an SSH round trip. Waiting too little cannot invent a
 * rejection — it can only miss one, and `state: 'checked'` is worded so that
 * missing one is not read as health.
 */
const RELOAD_GRACE_MS = 2_000;

/** Lines of Traefik's log to ask for. A reload burst is one line per router. */
const LOG_TAIL = 500;

/**
 * Traefik's own verdict on the configuration Cloudgate wrote, reported against
 * the Cloudgate row that caused it (H-38).
 *
 * **The hole this fills.** Everything upstream of here validates what Cloudgate
 * *stores*. Nothing checked whether Traefik would *accept* it. Traefik's
 * `router.go` builds a router's middleware chain and, when any link fails to
 * construct, does `AddError(); logger.Error(); continue` — the route is never
 * added to the muxer. Every router naming that middleware disappears and the
 * Application answers 404 through the catch-all. H-22 was that shape with a `:`
 * in a basic-auth username; H-24's residual is that shape with a
 * `redirect.regex` that `regexp.Compile` refuses, stored through a 201. Both
 * were fixed at the input, and the class was not: Traefik can refuse any field
 * this repo writes and says so only to its own log, so the operator learns from
 * an outage.
 *
 * **A DTO-side compile check was rejected and is still rejected.** `new RegExp`
 * in V8 disagrees with Go's RE2 in both directions — `(?i)` and `(?P<name>…)`
 * are valid RE2 and throw in V8, `(?=…)` passes V8 and RE2 refuses it — which
 * is H-12's mistake in a new costume. More to the point it would close one
 * field, and the next rejection will be a different one. The only thing that
 * knows whether Traefik accepts a config is Traefik.
 *
 * **Where the verdict comes from, and what was rejected.**
 *
 * - **Traefik's HTTP API** (`/api/http/routers`, `/api/http/middlewares`) is
 *   the ideal source: `status: "disabled"` plus a typed `error` array, per
 *   router *and* per middleware, which would name the failing link rather than
 *   the set. It is **not reachable**. The `traefik.yml` written by
 *   `deploy/install.sh` and `servers/server-setup.ts` — the same file, pinned
 *   byte-for-byte against each other — has no `api` key, so traefik:v3.6.7
 *   listens on :80 and :443 and nothing else; a connect to :8080 is refused.
 *   `api` is *static* configuration, so turning it on means rewriting
 *   `traefik.yml` and restarting Traefik, dropping every connection on 80 and
 *   443 — which this product already declines to do on the operator's behalf
 *   for the access-log toggle, and which an observability feature has no
 *   business doing. `api.insecure` additionally publishes an unauthenticated
 *   dashboard. Rejected on the reachability, not on taste.
 * - **A probe through Traefik** — send a request with the Domain's `Host`
 *   header and see whether a router matched — was rejected because it cannot
 *   tell a dropped router from a stopped container, an unresolved DNS name or a
 *   backend that 404s on `/`, and every one of those is a false alarm.
 * - **Traefik's application log**, which is this. It carries the same sentence
 *   the API's `error` array carries, keyed by router name; it is already on and
 *   already at INFO; and it is reachable on the built-in server and
 *   on a Server over SSH through the Docker layer this repo already owns. Its
 *   cost is that it names the *router* and not the failing middleware, which is
 *   why a rejection carries the set of rows in that router's chain — see
 *   `TraefikRouterSubjects`.
 *
 * **When it is read.** A file-provider reload is asynchronous, so an immediate
 * read races the watcher. Two properties make the race harmless rather than
 * merely unlikely:
 *
 * 1. *Nothing is inferred from silence.* A rejection is only ever reported from
 *    a line that exists. A watcher that has not fired yet, a Traefik that is
 *    not running, an unreadable daemon — all of them produce no rejection, and
 *    `state: 'checked'` is documented as "this is what the log said", never as
 *    "the config is good". A transient delay therefore cannot become a false
 *    alarm; it can only postpone a true one to the next regeneration.
 * 2. *Only lines newer than the write are read.* The anchor is the timestamp of
 *    the last line already in Traefik's log, taken immediately before the
 *    write, and it is Docker's own timestamp — the daemon's clock, on the host
 *    Traefik runs on — so no clock skew between this instance and a Server can
 *    shift the window. Because the file provider re-reads the whole watched
 *    directory on any event, every burst after the write reflects the file we
 *    just wrote, which is what makes an old error impossible to re-attribute.
 *
 * The residual, stated rather than papered over: the anchor is taken one exec
 * round trip before the write completes, so an unrelated reload landing inside
 * that window could re-emit an error this write has just fixed. Taking the
 * anchor *after* the write closes that and opens a worse one — over SSH the
 * anchor read is a fresh round trip, and Traefik can easily have reloaded and
 * logged inside it, which would lose the signal on Servers routinely rather
 * than reporting a stale one rarely. The chosen direction is a report that the
 * next regeneration corrects, never a refused write.
 *
 * **What it must not do**, and does not: it runs after the write, it returns a
 * value nobody branches on, and every failure inside it is caught. No write
 * Traefik would have accepted is blocked by anything in this file.
 */
@Injectable()
export class TraefikConfigStatusService {
  private readonly logger = new Logger(TraefikConfigStatusService.name);

  /**
   * The last verdict per application, so the read route can answer without
   * poking Traefik. In memory rather than a table: it is an observation with a
   * timestamp on it, it is refreshed on every regeneration, and a row that
   * survives a restart would be a claim about a Traefik nobody has looked at
   * since. `checkedAt` is what tells a reader how much to trust it.
   */
  private readonly latest = new Map<string, TraefikConfigStatus>();

  /**
   * The check in flight per application. `regenerate` does not await the check
   * — a redirect edit must not wait two seconds on Traefik's watcher — so this
   * is how a test, or a later caller that wants the verdict, waits for it.
   */
  private readonly inFlight = new Map<string, Promise<TraefikConfigStatus>>();

  /**
   * The last verdict on the console's own routers, and the check in flight for
   * them (H-61). One of each rather than a map: there is one console, and
   * its routers live on the platform host only.
   */
  private latestConsole: TraefikConsoleStatus | undefined;
  private inFlightConsole: Promise<TraefikConsoleStatus> | undefined;

  constructor(
    private readonly remoteExec: RemoteExecService,
    private readonly writer: TraefikWriterService,
  ) {}

  /**
   * The timestamp of the last line already in Traefik's log, or `null` when it
   * has none and when there is no Traefik to ask. Read immediately before the
   * config is written; everything at or before it is another write's business.
   */
  async anchor(serverId: string | null): Promise<string | null> {
    try {
      const containerId = await this.findTraefik(serverId);
      if (!containerId) return null;
      const { stdout } = await execOnServer(this.remoteExec, serverId, [
        'docker',
        'logs',
        '--timestamps',
        '--tail',
        '1',
        containerId,
      ]);
      const [line] = parseDockerTimestamps(stdout);
      return line ?? null;
    } catch {
      // Reading the anchor is best effort by construction: without one the
      // check reads the whole tail and reports nothing it cannot date, which is
      // the same safe direction as every other failure here.
      return null;
    }
  }

  /** Runs `verify` without making the caller wait for it, and never throws. */
  verifyInBackground(
    input: TraefikVerifyInput,
    anchor: string | null,
    graceMs?: number,
  ): void {
    const running = this.verify(input, anchor, graceMs).catch((error) => {
      this.logger.warn(
        `Could not read Traefik's verdict on the config written for ${input.appName}: ${String(error)}`,
      );
      const status: TraefikConfigStatus = {
        applicationId: input.applicationId,
        appName: input.appName,
        state: 'unavailable',
        reason: String(error),
        checkedAt: new Date().toISOString(),
        rejections: [],
      };
      this.latest.set(input.applicationId, status);
      return status;
    });
    // Held rather than dropped so `settled` has something to await. The
    // rejection handler above is what makes leaving it unawaited safe: this
    // promise is already settled to a value in every direction.
    this.inFlight.set(input.applicationId, running);
  }

  /** The last verdict, if this instance has one for that application. */
  lastStatus(applicationId: string): TraefikConfigStatus | undefined {
    return this.latest.get(applicationId);
  }

  /** Resolves once the check started for that application has settled. */
  async settled(applicationId: string): Promise<void> {
    await this.inFlight.get(applicationId);
  }

  /**
   * Waits out the watcher, reads the log past the anchor, and reports every
   * rejection naming a router this application owns.
   *
   * `graceMs` is a parameter rather than a constant read here so a spec can run
   * the real code at zero delay; nothing in `src` passes it.
   */
  async verify(
    input: TraefikVerifyInput,
    anchor: string | null,
    graceMs: number = RELOAD_GRACE_MS,
  ): Promise<TraefikConfigStatus> {
    const base = {
      applicationId: input.applicationId,
      appName: input.appName,
      checkedAt: new Date().toISOString(),
    };

    const read = await this.readErrors(input.serverId, anchor, graceMs);
    if (!read.ok) {
      // The console's routers are on the platform host, so a read that failed
      // there failed for them too — and saying nothing about them would be the
      // silence this whole surface exists to remove.
      if (input.serverId === null) {
        this.recordConsole({
          state: 'unavailable',
          reason: read.reason,
          checkedAt: base.checkedAt,
          rejections: [],
        });
      }
      return this.record({
        ...base,
        state: 'unavailable',
        reason: read.reason,
        rejections: [],
      });
    }

    const seen = new Set<string>();
    const rejections: TraefikConfigRejection[] = [];

    for (const error of read.errors) {
      const subjects = input.routers.get(error.routerName);
      // A router this application did not write. Another Application's, or
      // `middlewares.yml`'s — either way this instance is not holding the rows
      // that would name it, and guessing from the string is what
      // `config/names.ts` exists to avoid.
      if (!subjects) continue;

      const message = redact(error.message, input.secrets ?? []);
      const key = `${error.routerName} ${message}`;
      if (seen.has(key)) continue;
      seen.add(key);

      rejections.push({
        routerName: error.routerName,
        message,
        domain: subjects.domain,
        subjects: subjects.subjects,
        observedAt: error.at,
      });
    }

    for (const rejection of rejections) {
      this.logger.error(
        `Traefik refused the configuration written for ${input.appName}: Domain ${rejection.domain.host} (${rejection.domain.domainId}) is not being routed, so every request to it falls through to Traefik's catch-all. Traefik reported against router ${rejection.routerName}: ${rejection.message}. Rows in that router's chain: ${describeSubjects(rejection.subjects)}. Correct one of them and save again.`,
      );
    }

    // The same lines, read a second time against the console's own routers
    // (H-61). Free, and the only thing that notices a console router
    // nobody has rewritten since it broke — see {@link verifyConsole}.
    if (input.serverId === null) {
      await this.reportConsole(read.errors, base.checkedAt);
    }

    return this.record({ ...base, state: 'checked', rejections });
  }

  /**
   * Traefik's verdict on the routers that put **this console** on a hostname
   * (H-61).
   *
   * **Why this is separate from `verify` rather than a subject kind in it.**
   * H-38 reports a rejection against the Cloudgate rows in the dropped router's
   * chain, and every one of those rows belongs to an Application: a Domain, a
   * Redirect, a basic-auth user, each with a screen that owns it. The console's
   * routers have none of that. `dynamic/cloudgate.yml` is written by the
   * **Console domain** form and by `POST /settings/traefik/web-server-config`;
   * `dynamic/middlewares.yml` by `POST /settings/traefik/middlewares-config`.
   * Both are instance-wide, one file and one operator each, so folding them
   * into an Application's `rejections` would attribute the console's outage to
   * whichever Application happened to be saved last.
   *
   * **Where the report goes, and why it goes to a screen at all.** A refused
   * console router is the one failure an operator cannot diagnose from the
   * console, because the console is what goes dark — which reads at first like
   * an argument that only the log can carry it. It is not: Traefik serves the
   * console *on a hostname*, and `deploy/install.sh` also leaves it listening
   * on `CONSOLE_PORT` on the host itself. A router Traefik dropped takes the
   * hostname away and leaves `http://<host>:3000` answering, so the operator
   * who has just lost `console.example.com` still has a console to read this
   * on — and it is the first place they will look. The `logger.error` below
   * stays for the case where neither is reachable.
   *
   * **The platform host only.** `updateServerTraefik` writes
   * `dynamic/cloudgate.yml` on this host, and neither settings route takes a
   * `serverId`, so a Server has no console router to ask about; asking would be
   * an SSH round trip for a file that is never there.
   */
  async verifyConsole(
    anchor: string | null,
    graceMs: number = RELOAD_GRACE_MS,
  ): Promise<TraefikConsoleStatus> {
    const checkedAt = new Date().toISOString();
    const read = await this.readErrors(null, anchor, graceMs);
    if (!read.ok) {
      return this.recordConsole({
        state: 'unavailable',
        reason: read.reason,
        checkedAt,
        rejections: [],
      });
    }
    return this.reportConsole(read.errors, checkedAt);
  }

  /**
   * Anchor, write, look, and answer once the verdict is in — the protocol
   * `TraefikAppConfigService.regenerate` follows, packaged for the console's own
   * writers.
   *
   * A method rather than four lines at each call site because the *order* is
   * the whole design and it is easy to get subtly wrong: the anchor has to be
   * older than the write for an error from the previous config to be
   * unattributable to this one. The write's own result and its failures pass
   * straight through — this observes a write, it never gates one — and nothing
   * after the write can throw, because {@link verifyConsoleInBackground}
   * settles its promise to a value in every direction. `graceMs` is a parameter
   * for the reason {@link verify}'s is: so a spec can run the real code at zero
   * delay. Nothing in `src` passes it.
   *
   * The writers it is for are `SettingsService.updateServerTraefik` and the two
   * raw-YAML routes on `settings.controller.ts`, all of which live outside this
   * module. `test/coding-standards/around-write-callers.spec.ts` is
   * what keeps that true: this protocol was written, documented and **never
   * invoked** for a whole release, so the console's card only ever refreshed on
   * the back of an unrelated Application regeneration — the fallback this
   * paragraph described as what it was meant to improve on, presented as an
   * observation of a write it had never seen.
   *
   * **The check is awaited, and it was not before.** The reason it was
   * not is real and is priced here rather than dropped: the caller waits out
   * `RELOAD_GRACE_MS` on Traefik's file watcher, so a console-domain save takes
   * about two seconds longer than the write. What that buys is the only thing
   * that makes the card correct *when it is read*. The console's card is
   * refreshed by the same save that wrote the file — the console invalidates
   * the whole `instance` query root on a settings write — so a check still in
   * flight when that refetch lands answers with the **previous** observation,
   * and the card then states the age and exact time of an unrelated
   * Application's write as its report on this one. A two-second save is cheaper
   * than a card that is confidently wrong, on a screen whose entire job is to
   * say what Traefik made of the file just written. A host with no Traefik
   * container pays nothing: {@link readErrors} looks for the container before
   * it waits.
   */
  async aroundConsoleWrite<T>(
    write: () => Promise<T>,
    graceMs?: number,
  ): Promise<T> {
    const anchor = await this.anchor(null);
    const written = await write();
    this.verifyConsoleInBackground(anchor, graceMs);
    await this.consoleSettled();
    return written;
  }

  /** Runs {@link verifyConsole} without making the caller wait, and never throws. */
  verifyConsoleInBackground(anchor: string | null, graceMs?: number): void {
    this.inFlightConsole = this.verifyConsole(anchor, graceMs).catch(
      (error) => {
        this.logger.warn(
          `Could not read Traefik's verdict on the console's own routers: ${String(error)}`,
        );
        return this.recordConsole({
          state: 'unavailable',
          reason: String(error),
          checkedAt: new Date().toISOString(),
          rejections: [],
        });
      },
    );
  }

  /** The last verdict on the console's routers, if this instance has one. */
  consoleStatus(): TraefikConsoleStatus | undefined {
    return this.latestConsole;
  }

  /** Resolves once the console check started has settled. */
  async consoleSettled(): Promise<void> {
    await this.inFlightConsole;
  }

  /**
   * Classifies one already-read set of lines against the console's routers.
   *
   * The two files are read here rather than passed in, because unlike an
   * Application's config this instance did not just write them and is not
   * holding their contents — and unlike an Application's rows they are not in
   * the database at all. Both reads are local `fs` on the platform host and
   * both answer an empty config rather than throwing, so a missing or
   * unreadable file degrades to the two seeded router names.
   */
  private async reportConsole(
    errors: TraefikRouterError[],
    checkedAt: string,
  ): Promise<TraefikConsoleStatus> {
    const index = buildConsoleRouterIndex(
      await this.loadWatchedFile(CONSOLE_CONFIG_NAME),
      await this.loadWatchedFile(MIDDLEWARES_CONFIG_NAME),
    );

    const seen = new Set<string>();
    const rejections: TraefikConsoleRejection[] = [];
    for (const error of errors) {
      const router = index.get(error.routerName);
      // An Application's router, or another instance's. Either way it is not
      // this surface's to interpret — `buildRouterSubjectIndex` answers for the
      // first and nothing answers for the second, which is the correct answer.
      if (!router) continue;
      const key = `${error.routerName} ${error.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rejections.push({
        routerName: error.routerName,
        message: error.message,
        source: router.source,
        middlewares: router.middlewares,
        observedAt: error.at,
      });
    }

    for (const rejection of rejections) {
      this.logger.error(
        `Traefik refused a router that serves this console: ${rejection.routerName} was dropped, so every request to the host it answers on falls through to Traefik's catch-all — the console itself is not being served on its domain. Traefik reported: ${rejection.message}. ${describeConsoleSource(rejection)} The console is still reachable on this host's own address and port.`,
      );
    }

    return this.recordConsole({ state: 'checked', checkedAt, rejections });
  }

  /** One watched file's config, or `null` when it could not be read. */
  private async loadWatchedFile(name: string) {
    try {
      return await this.writer.loadOrCreateConfig(name, null);
    } catch {
      return null;
    }
  }

  /**
   * Waits out the watcher and returns the rejection lines newer than the
   * anchor, or why the log could not be read.
   *
   * Extracted so the Application pass and the console pass read the log
   * **once** (§1.4): the file provider re-emits the complete current error set
   * on any event, so the one window holds both answers, and a second
   * `docker logs` would be a second round trip that could only disagree with
   * the first.
   */
  private async readErrors(
    serverId: string | null,
    anchor: string | null,
    graceMs: number,
  ): Promise<
    { ok: true; errors: TraefikRouterError[] } | { ok: false; reason: string }
  > {
    const containerId = await this.findTraefik(serverId);
    if (!containerId) {
      return {
        ok: false,
        reason: `No running ${TRAEFIK_CONTAINER_NAME} container on ${serverId ? `server ${serverId}` : 'the platform host'}`,
      };
    }

    if (graceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, graceMs));
    }

    const since = anchor ? ['--since', anchor] : [];
    const { stdout } = await execOnServer(this.remoteExec, serverId, [
      'docker',
      'logs',
      '--timestamps',
      '--tail',
      String(LOG_TAIL),
      ...since,
      containerId,
    ]);

    // `docker logs --since <ts>` is inclusive of a line at exactly that stamp,
    // so the anchor line itself comes back and is dropped here. Comparison is
    // by parsed instant rather than by string: Docker writes RFC3339Nano, which
    // trims trailing zeros, so `…16.21207Z` and `…16.212070635Z` do not sort
    // lexicographically. Millisecond resolution is enough — the anchor read and
    // the write are two round trips apart — and a tie resolves to "older", the
    // direction that drops a line rather than inventing one.
    const anchoredAt = anchor ? Date.parse(anchor) : Number.NEGATIVE_INFINITY;
    return {
      ok: true,
      errors: parseTraefikRouterErrors(stdout).filter(
        (error) => Date.parse(error.at) > anchoredAt,
      ),
    };
  }

  private record(status: TraefikConfigStatus): TraefikConfigStatus {
    this.latest.set(status.applicationId, status);
    return status;
  }

  private recordConsole(status: TraefikConsoleStatus): TraefikConsoleStatus {
    this.latestConsole = status;
    return status;
  }

  /**
   * The running Traefik's container id on that server, or null.
   *
   * By name filter rather than by addressing `cloudgate-traefik` directly,
   * because Traefik runs standalone under that name or as a swarm task named
   * `cloudgate-traefik.1.<task-id>` — `TraefikFilesService.reopenLogs` and
   * `LogCleanupService` resolve it the same way, and this is the third caller
   * of the same question rather than a fourth spelling of it. A pipeline has no
   * argv, so it travels as a string; there is nothing interpolated into it but
   * a module constant.
   */
  private async findTraefik(serverId: string | null): Promise<string | null> {
    const { stdout } = await execOnServer(
      this.remoteExec,
      serverId,
      `docker ps -q --filter "name=${TRAEFIK_CONTAINER_NAME}" --filter "status=running" | head -n 1`,
    );
    return stdout.trim() || null;
  }
}

/** Docker's `--timestamps` prefixes, newest last, for the anchor read. */
const parseDockerTimestamps = (stdout: string): string[] =>
  stdout
    .split('\n')
    // The anchor read sees the same coloured output the parser does.
    // eslint-disable-next-line no-control-regex
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .map((line) => /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s/.exec(line)?.[1])
    .filter((stamp): stamp is string => Boolean(stamp))
    .reverse();

/**
 * Removes emitted secrets from Traefik's sentence.
 *
 * By identity against values this instance just wrote, never by a pattern over
 * the sentence: Traefik quotes the offending `username:bcrypt-hash` entry back
 * verbatim when `basicUserParser` refuses it (H-22's shape), and
 * `SecurityService` is explicit that a basic-auth password never leaves the
 * server. Matching a *shape* of hash would be one more grammar to keep in step
 * with a Go project's log strings; matching the exact strings we handed Traefik
 * cannot be wrong about what it removed.
 */
const redact = (message: string, secrets: string[]): string =>
  secrets.reduce(
    (text, secret) => (secret ? text.split(secret).join('[redacted]') : text),
    message,
  );

/**
 * Where to go and correct a console router, in the nouns of the screens that
 * write it.
 *
 * The middlewares are named as a set for the same reason an Application's
 * chain is: Traefik drops the router and says which router, not which link.
 */
const describeConsoleSource = (rejection: TraefikConsoleRejection): string => {
  const chain =
    rejection.middlewares.length > 0
      ? ` The middlewares that router names are ${rejection.middlewares.join(', ')}, and any one of them can be what failed to build.`
      : '';
  return rejection.source === 'console-domain'
    ? `It was written by the Console domain settings, in dynamic/cloudgate.yml.${chain}`
    : `It was written by the Traefik middlewares configuration, in dynamic/middlewares.yml.${chain}`;
};

/** The chain, in the nouns the console uses for those screens. */
const describeSubjects = (subjects: TraefikConfigSubject[]): string =>
  subjects
    .map((subject) => {
      switch (subject.kind) {
        case 'domain':
          return `Domain ${subject.domainId}`;
        case 'redirect':
          return `Redirect ${subject.redirectId}`;
        case 'security':
          return `Basic-auth user ${subject.securityId}`;
        case 'forwardAuth':
          return `the forward-auth gate of Domain ${subject.domainId}`;
      }
    })
    .join(', ');
