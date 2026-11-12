import { describe, expect, it } from "vitest";

import {
  heldSince,
  heldUpTo,
  lineTime,
  reconnectedLine,
  sinceFor,
} from "./log-resume";

const at = (iso: string) => Date.parse(iso);

/** Whatever of `incoming` the skip lets through, in order. */
const admitted = (
  skip: { held(line: string): boolean; readonly done: boolean },
  incoming: readonly string[],
) => incoming.filter((line) => !skip.held(line));

describe("lineTime", () => {
  it("reads Docker's --timestamps stamp, nanoseconds and all", () => {
    expect(lineTime("2026-11-06T10:00:05.123456789Z listening on :80")).toBe(
      at("2026-11-06T10:00:05.123Z"),
    );
  });

  it("reads the stamp ahead of a Swarm service's task prefix, which names the line's copy", () => {
    // `docker service logs --timestamps` writes the stamp first, then the
    // copy: `<stamp> web.2@node-1    | <line>`.
    expect(
      lineTime("2026-11-06T10:00:05.123456789Z web.2@node-1    | listening"),
    ).toBe(at("2026-11-06T10:00:05.123Z"));
  });

  it("is null for a line whose stamp is not first", () => {
    expect(
      lineTime("web.2@node-1    | 2026-11-06T10:00:05.123456789Z listening"),
    ).toBeNull();
  });

  it("is null for a line Docker did not stamp", () => {
    expect(lineTime("SSH error: connection reset")).toBeNull();
    expect(lineTime("")).toBeNull();
  });
});

describe("sinceFor", () => {
  const held = [
    "2026-11-06T10:00:00.000000000Z booting",
    "2026-11-06T10:00:05.500000000Z listening on :80\r",
    "↻ Reconnected at 10:00:06",
  ];

  it("asks from the last stamped line held, rounded up to whole seconds with slack", () => {
    // 10:01:00 is 54.5 s after the last stamped line: 55 s, plus the slack
    // that covers a browser clock behind the host's.
    expect(sinceFor(held, at("2026-11-06T10:01:00.000Z"))).toBe("60s");
  });

  it("never asks for less than the slack, whatever the browser's clock says", () => {
    expect(sinceFor(held, at("2026-11-06T09:59:00.000Z"))).toBe("6s");
  });

  it("is null when no line held carries a stamp", () => {
    expect(sinceFor(["SSH error: refused"], Date.now())).toBeNull();
    expect(sinceFor([], Date.now())).toBeNull();
  });
});

describe("heldUpTo — a replay from the start", () => {
  it("skips as many lines as were held, and lets every one after through", () => {
    const skip = heldUpTo(2);
    expect(admitted(skip, ["one", "two", "three", "four"])).toEqual([
      "three",
      "four",
    ]);
    expect(skip.done).toBe(true);
  });

  it("is done at once when nothing was held", () => {
    const skip = heldUpTo(0);
    expect(skip.done).toBe(true);
    expect(admitted(skip, ["one"])).toEqual(["one"]);
  });

  it("skips a held line repeated in the build's own output only where it was held", () => {
    expect(admitted(heldUpTo(1), ["Step 1", "Step 1"])).toEqual(["Step 1"]);
  });
});

describe("heldSince — a container redial from the last held line", () => {
  const held = [
    "2026-11-06T10:00:00.000000000Z booting",
    "2026-11-06T10:00:05.000000000Z listening on :80",
  ];

  it("skips the lines held and keeps what was written during the drop", () => {
    const skip = heldSince(held);
    expect(
      admitted(skip, [
        "2026-11-06T10:00:00.000000000Z booting",
        "2026-11-06T10:00:05.000000000Z listening on :80",
        "2026-11-06T10:00:30.000000000Z GET / 200",
      ]),
    ).toEqual(["2026-11-06T10:00:30.000000000Z GET / 200"]);
    expect(skip.done).toBe(true);
  });

  it("keeps a line from another replica written before the last held one but never held", () => {
    const skip = heldSince(held);
    expect(
      admitted(skip, [
        "2026-11-06T10:00:04.000000000Z replica 2 ready",
        "2026-11-06T10:00:05.000000000Z listening on :80",
      ]),
    ).toEqual(["2026-11-06T10:00:04.000000000Z replica 2 ready"]);
  });

  it("stops skipping once a line newer than everything held has arrived", () => {
    const skip = heldSince(held);
    expect(
      admitted(skip, [
        "2026-11-06T10:00:30.000000000Z restart",
        "2026-11-06T10:00:05.000000000Z listening on :80",
      ]),
    ).toHaveLength(2);
  });

  it("knows a prefixed line held again when Docker pads its copy's name to a new width", () => {
    // A copy added since the drop can lengthen the longest slot number, and
    // Docker pads every copy's context to it, after the node name.
    const skip = heldSince([
      "2026-11-06T10:00:05.000000000Z web.1@node-1    | listening on :80",
    ]);
    expect(
      admitted(skip, [
        "2026-11-06T10:00:05.000000000Z web.1@node-1     | listening on :80",
        "2026-11-06T10:00:06.000000000Z web.10@node-1    | listening on :80",
      ]),
    ).toEqual([
      "2026-11-06T10:00:06.000000000Z web.10@node-1    | listening on :80",
    ]);
  });

  it("still tells apart prefixed lines whose messages differ only in spacing", () => {
    const skip = heldSince([
      "2026-11-06T10:00:05.000000000Z web.1@node-1    | a  b",
    ]);
    expect(
      admitted(skip, ["2026-11-06T10:00:05.000000000Z web.1@node-1     | a b"]),
    ).toEqual(["2026-11-06T10:00:05.000000000Z web.1@node-1     | a b"]);
  });

  it("with no stamp to go by, skips the lines held until one that was not", () => {
    const skip = heldSince(["No such service: shop_web"]);
    expect(
      admitted(skip, ["No such service: shop_web", "next", "next"]),
    ).toEqual(["next", "next"]);
  });
});

describe("reconnectedLine", () => {
  it("says where the log reconnected, by the local clock", () => {
    const when = new Date(2026, 10, 6, 9, 4, 7);
    expect(reconnectedLine(when)).toBe("↻ Reconnected at 09:04:07");
  });
});
