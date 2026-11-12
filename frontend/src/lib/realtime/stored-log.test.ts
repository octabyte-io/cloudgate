import { describe, expect, it, vi } from "vitest";

import { LiveLog, type LogEnding } from "./live-log";
import { StoredLog, type StoredRead } from "./stored-log";

/**
 * A finished log's stored record as a Live log's source (#1340): ended from
 * its first snapshot, never dialled, changed only by a re-read.
 */
const SUCCEEDED: LogEnding = {
  mark: "finished",
  words: "Succeeded",
  sentence: "The build succeeded.",
};

function record(read: () => Promise<StoredRead>) {
  return new LiveLog("deployment:dep-1", "page", {
    source: new StoredLog(read, ["one", "two"], SUCCEEDED),
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a stored record's Live log", () => {
  it("holds its lines and its ending from the start, and is not live", () => {
    const log = record(async () => ({ lines: [] }));

    const snapshot = log.getSnapshot();
    expect(snapshot.lines).toEqual(["one", "two"]);
    expect(snapshot.ending).toBe(SUCCEEDED);
    expect(snapshot.live).toBe(false);
    expect(log.reloadable).toBe(true);
  });

  it("dials nothing when opened or redialled", () => {
    const read = vi.fn(async () => ({ lines: [] }));
    const log = record(read);
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);

    log.open("ws://example/listen-deployment");
    log.redial();
    log.reconnect();

    expect(socket).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("Reload replaces the lines with the record read again", async () => {
    const log = record(async () => ({ lines: ["three"] }));

    log.reload();
    expect(log.getSnapshot().reading).toBe(true);
    await settle();

    expect(log.getSnapshot().lines).toEqual(["three"]);
    expect(log.getSnapshot().ending).toBe(SUCCEEDED);
    expect(log.getSnapshot().reading).toBe(false);
  });

  it("a read that ends it keeps the lines and takes its ending; a refusal offers no Reload after", async () => {
    const refused: LogEnding = {
      mark: "stopped",
      words: "Could not connect",
      sentence: "Gone.",
      refused: true,
    };
    const log = record(async () => ({ ending: refused }));

    log.reload();
    await settle();

    expect(log.getSnapshot().lines).toEqual(["one", "two"]);
    expect(log.getSnapshot().ending).toBe(refused);
    expect(log.reloadable).toBe(false);
  });

  it("a failed read keeps everything and says so after the ending, until a read works", async () => {
    let next: StoredRead = { failed: "Reading it again failed: offline." };
    const log = record(async () => next);

    log.reload();
    await settle();
    expect(log.getSnapshot().ending?.sentence).toBe(
      "The build succeeded. Reading it again failed: offline.",
    );
    expect(log.getSnapshot().lines).toEqual(["one", "two"]);

    next = { lines: ["one", "two", "three"] };
    log.reload();
    await settle();
    expect(log.getSnapshot().ending).toEqual(SUCCEEDED);
  });

  it("drops a read that lands after the log is disposed", async () => {
    const log = record(async () => ({ lines: ["late"] }));

    log.reload();
    log.dispose();
    await settle();

    expect(log.getSnapshot().lines).toEqual(["one", "two"]);
  });
});
