/**
 * A jest reporter that says what the run is doing *while* it is doing it, and
 * leaves the same fact on disk for {@link armStallWatchdog} to read.
 *
 * **What broke first.** A full e2e run went silent for 21 minutes with both
 * workers resident at 0.0% CPU and was killed at 26:51. Nothing distinguished
 * that from slow progress, and the only signal the issue's author found was
 * `stat`-ing the log's mtime — which works by accident, because the log advances
 * when the *application* logs through pino, so a suite that happens not to serve
 * a request looks like a wedged one.
 *
 * **The default reporter is not the problem it was first taken to be, and
 * saying so is the point of this paragraph.** Measured rather than assumed: a
 * 114-suite run off a TTY emitted all 116 of its `PASS`/`FAIL` lines *during*
 * the run, spread through the log. What a `PASS` line cannot do is name the file
 * that is still running — it reports what **finished**, and during a hang the
 * interesting file is the one with no line at all, out of 114 candidates. It
 * also arrives at a signal-to-noise ratio of 116 lines in **287,858**, because
 * every suite's pino output is in there too.
 *
 * So this reporter exists for three things the default one does not give: the
 * set of files **in flight**, a `done/total` counter and elapsed seconds on
 * every line so "slow" and "stopped" are one `grep '^\[e2e '` apart, and a
 * machine-readable heartbeat {@link armStallWatchdog} can poll.
 *
 * **What was rejected.** `--verbose` prints per-*test* lines but still says
 * nothing about which files are in flight, which is the fact a hang needs.
 * `--logHeapUsage` alone adds a number to those same lines. Neither leaves
 * anything a watchdog — or a human in another shell — can read.
 *
 * The heartbeat file is deliberately a file and not a shared module-level
 * value, even though this reporter and `global-setup.ts` run in the same jest
 * process: `globalSetup` is loaded through `createScriptTransformer`'s own
 * module registry, so sharing state through `globalThis` is a bet on an
 * implementation detail. A file also makes the diagnosis available from outside
 * the run, which is what `docs/testing.md` now tells a reader to do.
 */
const { writeFileSync, utimesSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

/**
 * The lane a heartbeat belongs to, and why there is more than one.
 *
 * The path used to be a single `$TMPDIR/cloudgate-e2e-heartbeat.json`, which was
 * right while only the Docker configs carried this reporter. A later change armed the
 * watchdog for the lock-free `npx jest` config too, and one fixed path is
 * exactly what that cannot share: the unit run is *designed* to run while an
 * e2e run holds the machine-wide lock, so both reporters would write the same
 * file, and the loser's watchdog would then read a heartbeat whose `pid` is not
 * its own — {@link armStallWatchdog}'s `readOwnHeartbeat` returns nothing,
 * `lastAdvanceAt` stops advancing, and the **healthy** run fails STALLED five
 * minutes later. `stall-watchdog.spec.ts` had already written that hazard down
 * ("writing the real `$TMPDIR/cloudgate-e2e-heartbeat.json` from a unit run
 * would corrupt the state of any e2e run in flight") as a reason to redirect
 * `os.tmpdir` in a spec; that change is the same hazard arriving for real.
 *
 * So the lane is part of the filename. `e2e` is the default, which keeps the
 * Docker configs' path byte for byte what `docs/testing.md` tells a
 * reader to `cat` — the two Docker configs share one lane on purpose, because
 * they also share the one lock and so can never be in flight together.
 *
 * **Rejected: keying the file on the jest main process's pid**, which needs no
 * lane and no agreement between the reporter and `globalSetup` at all. It would
 * make the path unguessable from another shell, and reading it from another
 * shell is the whole reason this is a file rather than a module-level value.
 */
const DEFAULT_LANE = 'e2e';

/**
 * Next to `cloudgate-e2e-postgres.lock` on purpose — the two facts a wedged run
 * needs are then one directory listing apart.
 */
const heartbeatPathFor = (lane = DEFAULT_LANE) =>
  join(tmpdir(), `cloudgate-${lane}-heartbeat.json`);

/** The `e2e` lane's path, unchanged: what `global-teardown.ts` removes. */
const HEARTBEAT_PATH = heartbeatPathFor();

const relative = (path) => path.replace(/^.*\/backend\/test\//, '');

class HeartbeatReporter {
  #started = Date.now();
  #inFlight = new Map();
  #done = 0;
  #total = 0;
  #lane;
  #path;
  #progressLines;

  /**
   * Jest constructs a reporter as `new Reporter(globalConfig, options)`, where
   * `options` is the second element of the `reporters` entry — the only channel
   * a jest config has into a reporter, and therefore how a lane is chosen.
   * Both defaults reproduce the `e2e` behaviour exactly, so the Docker
   * configs' entry stays a bare path.
   *
   * **`progressLines: false` is the unit lane's, and it is a measurement rather
   * than a taste.** The per-suite `[<lane> <elapsed>s] …` lines exist so that
   * *slow* and *stopped* are one `grep` apart across a 298 s, 115-suite run. The
   * lock-free config gets through its whole lane in well under a minute — a
   * *dated* figure for it is `docs/testing.md`' job, and this
   * comment spelling one is how it came to say 205 for a lane that had moved
   * — where nothing is plausibly "stopped" for long enough to need a
   * progress line. And it is the config every agent invokes most often, so the
   * cost is paid on every red-green loop against a default reporter that is
   * already printing a `PASS` line per file: **two extra stderr lines per
   * suite**, which is the number that cannot rot, since `#progress` is called
   * once from `onTestFileStart` and once from `onTestFileResult` and nowhere
   * else. What the watchdog actually needs is the heartbeat
   * *file*, which is written either way; `onRunStart` and `onRunComplete` still
   * speak, so a reader can always see that the reporter is loaded and where its
   * heartbeat is. Suppressing the file altogether was never an option: a
   * silently disarmed watchdog is the failure mode this whole pair exists to
   * avoid.
   */
  constructor(_globalConfig, options = {}) {
    this.#lane = options.lane ?? DEFAULT_LANE;
    this.#path = heartbeatPathFor(this.#lane);
    this.#progressLines = options.progressLines ?? true;
  }

  /**
   * `writeFileSync` on a suite boundary, `utimesSync` between: the boundary
   * changes *what* is in flight and has to be recorded, whereas a finished test
   * only proves the run is alive, and touching the mtime says that for the cost
   * of one syscall. 2138 tests in a 520s run is not a budget worth spending on
   * JSON.
   */
  #write() {
    const payload = {
      pid: process.pid,
      at: Date.now(),
      elapsedS: Math.round((Date.now() - this.#started) / 1000),
      done: this.#done,
      total: this.#total,
      inFlight: [...this.#inFlight.entries()].map(([path, startedAt]) => ({
        suite: relative(path),
        forS: Math.round((Date.now() - startedAt) / 1000),
      })),
    };
    try {
      writeFileSync(this.#path, `${JSON.stringify(payload, null, 2)}\n`);
    } catch {
      // A heartbeat that cannot be written must not fail a run that is
      // otherwise healthy. The watchdog reads a missing file as "not armed".
    }
  }

  /**
   * The mtime is **all** this moves, which has one consequence worth stating
   * here rather than leaving for a reader of the JSON to discover: `at` and
   * every `forS` beside it are as of the last suite boundary, and a wedged run
   * produces no more of those. `armStallWatchdog`'s per-suite predicate
   * therefore derives a suite's real age as `forS + (now - at)` rather than
   * trusting `forS`.
   *
   * Writing the whole payload here instead — which would keep `forS` honest and
   * costs little, ~2200 half-kilobyte writes across a 300 s run — was rejected
   * because it fixes nothing: the frozen-worker shape is a worker that produces no test
   * case results at all, so `forS` freezes under any reporter and the watchdog
   * needs the derivation regardless.
   */
  #touch() {
    try {
      const now = new Date();
      utimesSync(this.#path, now, now);
    } catch {
      // The file may not exist yet on the very first test case.
      this.#write();
    }
  }

  #say(line) {
    const elapsed = Math.round((Date.now() - this.#started) / 1000);
    process.stderr.write(`[${this.#lane} ${elapsed}s] ${line}\n`);
  }

  /** A per-suite line, which the lock-free lane turns off — see the constructor. */
  #progress(line) {
    if (this.#progressLines) this.#say(line);
  }

  onRunStart(aggregated, options) {
    this.#total = aggregated.numTotalTestSuites;
    this.#say(
      `run start: ${this.#total} suites, ${options.estimatedTime ? `~${options.estimatedTime}s estimated, ` : ''}heartbeat at ${this.#path}`,
    );
    this.#write();
  }

  onTestFileStart(test) {
    this.#inFlight.set(test.path, Date.now());
    this.#progress(`start ${relative(test.path)}`);
    this.#write();
  }

  onTestCaseResult() {
    this.#touch();
  }

  onTestFileResult(test, result) {
    this.#inFlight.delete(test.path);
    this.#done += 1;
    const duration = result.perfStats
      ? `${((result.perfStats.end - result.perfStats.start) / 1000).toFixed(1)}s`
      : '?';
    // `memoryUsage` is the worker's `heapUsed` at the moment the file finished,
    // populated only under `logHeapUsage`, which the two **Docker** configs set
    // for this reason and the lock-free one does not — so this field is absent
    // on the unit lane and the `heap=` below is simply not printed there. This
    // said "both configs" while three exist, the drift a later fix corrected on
    // `docs/testing.md` and left here. It is printed rather than derived
    // because it is the **same number** `workerIdleMemoryLimit` is compared
    // against — jest-worker's `PARENT_MESSAGE_MEM_USAGE` carries
    // `process.memoryUsage().heapUsed` — so a threshold can be chosen from
    // these lines instead of from RSS, which is roughly 3x larger here.
    const heap = result.memoryUsage
      ? ` heap=${Math.round(result.memoryUsage / 1024 / 1024)}MB`
      : '';
    const verdict = result.testExecError
      ? 'ERRORED'
      : result.numFailingTests > 0
        ? 'FAILED'
        : 'ok';
    this.#progress(
      `${verdict} ${relative(test.path)} ${duration}${heap} (${this.#done}/${this.#total})`,
    );
    this.#write();
  }

  onRunComplete() {
    this.#inFlight.clear();
    this.#say(
      `all ${this.#done} suites reported; jest is now in globalTeardown and exit`,
    );
    this.#write();
  }

  /** Required by the reporter interface; this one never fails a run. */
  getLastError() {
    return undefined;
  }
}

module.exports = HeartbeatReporter;
module.exports.HEARTBEAT_PATH = HEARTBEAT_PATH;
module.exports.heartbeatPathFor = heartbeatPathFor;
module.exports.DEFAULT_LANE = DEFAULT_LANE;
