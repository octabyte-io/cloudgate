import { describe, expect, it } from "vitest";

import { toLogLines } from "./log-well";
import { stripTerminalEscapes } from "./terminal-escapes";

/**
 * Terminal control sequences are not part of a log's text
 * The ESC byte is
 * invisible and its parameters are not, so an unstripped `\x1b[33m` reads as
 * `[33m` in the well.
 */
describe("stripTerminalEscapes", () => {
  it("removes colour, erase and cursor sequences and keeps the text between them", () => {
    expect(
      stripTerminalEscapes(
        "\x1b[2K\x1b[1Aresolving \x1b[1;31merror\x1b[39;49m done\x1b[K",
      ),
    ).toBe("resolving error done");
  });

  it("leaves a bracket that no ESC introduces", () => {
    expect(stripTerminalEscapes("✅ Image Pushed [0m literal")).toBe(
      "✅ Image Pushed [0m literal",
    );
  });
});

describe("toLogLines — container output", () => {
  it("strips the colour a process writes to its own stdout", () => {
    // What a Node or Go service's logger prints into `docker logs`.
    expect(
      toLogLines([
        "\x1b[32minfo\x1b[39m: listening on :3000",
        "\x1b[31merror\x1b[39m: ECONNREFUSED",
      ]),
    ).toEqual([
      { text: "info: listening on :3000" },
      { text: "error: ECONNREFUSED" },
    ]);
  });
});
