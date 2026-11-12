import { describe, expect, it } from "vitest";

import { toSetupLines } from "./setup-log-tones";

/**
 * The setup script's output carries whatever `apt-get` and `curl | sh` colour
 * and a coloured line must still be toned on its words.
 */
describe("toSetupLines — terminal escapes", () => {
  it("strips colour codes before toning, so the tone lands on the line's words", () => {
    expect(
      toSetupLines([
        "\x1b[1m1. Installing required packages\x1b[0m",
        "\x1b[33mSkipping Docker, already installed\x1b[0m",
      ]),
    ).toEqual([
      { text: "1. Installing required packages", tone: "hl" },
      { text: "Skipping Docker, already installed", tone: "warn" },
    ]);
  });
});
