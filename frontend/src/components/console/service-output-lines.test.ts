import { describe, expect, it } from "vitest";

import { clockTime } from "@/lib/format/time";

import { toCopyLines } from "./service-output-lines";

const at = (iso: string) => clockTime(Date.parse(iso));

/**
 * A Swarm service's output read with Docker's task prefix — an
 * Application's Logs tab on a Server or the platform host (#1341): every
 * running copy merged by time, each line naming its copy.
 */
describe("toCopyLines", () => {
  it("names each line's copy by its task name, without the node, and stamps it with the time", () => {
    expect(
      toCopyLines([
        "2026-11-10T09:00:00.000000001Z web.1@node-1    | listening on :80\r",
      ]),
    ).toEqual([
      { ts: at("2026-11-10T09:00:00.000Z"), text: "[web.1] listening on :80" },
    ]);
  });

  it("merges two copies' lines by time, keeping the order of lines written at the same moment", () => {
    // Docker reads each copy's tail on its own, so a first read comes one
    // copy after the other rather than by time.
    const lines = toCopyLines([
      "2026-11-10T09:00:00Z web.1@node-1    | one: a",
      "2026-11-10T09:00:02Z web.1@node-1    | one: c",
      "2026-11-10T09:00:01Z web.2@node-1    | two: b",
      "2026-11-10T09:00:02Z web.2@node-1    | two: d",
    ]);
    expect(lines.map((line) => line.text)).toEqual([
      "[web.1] one: a",
      "[web.2] two: b",
      "[web.1] one: c",
      "[web.2] two: d",
    ]);
  });

  it("leaves a line Docker did not stamp where it was, and merges no line across it", () => {
    // A reconnect mark is a line of the log's own, counted by its position.
    const lines = toCopyLines([
      "2026-11-10T09:00:05Z web.2@node-1    | late",
      "↻ Reconnected at 09:00:06",
      "2026-11-10T09:00:01Z web.1@node-1    | before the drop, read again",
    ]);
    expect(lines).toEqual([
      { ts: at("2026-11-10T09:00:05Z"), text: "[web.2] late" },
      { text: "↻ Reconnected at 09:00:06" },
      {
        ts: at("2026-11-10T09:00:01Z"),
        text: "[web.1] before the drop, read again",
      },
    ]);
  });

  it("names the copy whatever width Docker padded its prefix to", () => {
    // Docker pads every copy's context to the longest slot number, after the
    // node name: `web.1@node-1 ` beside `web.10@node-1`.
    expect(
      toCopyLines([
        "2026-11-10T09:00:00Z web.1@node-1     | a",
        "2026-11-10T09:00:01Z web.10@node-1    | b",
      ]).map((line) => line.text),
    ).toEqual(["[web.1] a", "[web.10] b"]);
  });

  it("keeps a message's own leading spaces and its own bars", () => {
    expect(
      toCopyLines(["2026-11-10T09:00:00Z web.1@node-1    |   x | y"]).map(
        (line) => line.text,
      ),
    ).toEqual(["[web.1]   x | y"]);
  });

  it("names the copy of an empty line, its trailing space trimmed or not", () => {
    expect(
      toCopyLines([
        "2026-11-10T09:00:00Z web.1@node-1    | ",
        "2026-11-10T09:00:01Z web.1@node-1    |",
      ]).map((line) => line.text),
    ).toEqual(["[web.1] ", "[web.1] "]);
  });

  it("draws a stamped line without a task prefix as its message alone", () => {
    expect(
      toCopyLines(["2026-11-10T09:00:00Z plain | line"]).map(
        (line) => line.text,
      ),
    ).toEqual(["plain | line"]);
  });

  it("draws a line the daemon wrote without a prefix as it came, its escapes taken out", () => {
    expect(
      toCopyLines([
        "\x1b[31mError response from daemon: No such service\x1b[0m",
      ]),
    ).toEqual([{ text: "Error response from daemon: No such service" }]);
  });
});
