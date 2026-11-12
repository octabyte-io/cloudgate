import { describe, expect, it } from "vitest";

import { splitLogText, toBuildLines, toneOf } from "./log-tones";

/**
 * Terminal control sequences are not part of the log's text.
 *
 * BuildKit colours its closing warning even with `2>&1` into a file, so the ESC
 * byte reached the well, stayed invisible, and left its parameters printed —
 * `[33m1 warning found` — while the `[0m` that closes the colour landed on the
 * warning itself and kept it from being toned.
 */
describe("toBuildLines — terminal escapes", () => {
  it("strips BuildKit's colour codes and puts the warning tone on the warning", () => {
    const [header, warning] = toBuildLines([
      "\x1b[33m1 warning found (use docker --debug to expand):",
      "\x1b[0m - UndefinedVar: Usage of undefined variable '$NIXPACKS_PATH' (line 18)",
    ]);

    expect(header).toEqual({
      text: "1 warning found (use docker --debug to expand):",
      tone: "warn",
    });
    expect(warning).toEqual({
      text: " - UndefinedVar: Usage of undefined variable '$NIXPACKS_PATH' (line 18)",
      tone: "warn",
    });
  });

  it("strips the same codes from a finished log read over HTTP", () => {
    const text =
      "#7 [build 3/6] RUN npm ci\n\x1b[33m1 warning found (use docker --debug to expand):\n\x1b[0m - UndefinedVar: x\n";

    expect(toBuildLines(splitLogText(text)).map((line) => line.text)).toEqual([
      "#7 [build 3/6] RUN npm ci",
      "1 warning found (use docker --debug to expand):",
      " - UndefinedVar: x",
    ]);
  });

  it("strips the other CSI sequences a terminal tool writes — erase, cursor moves, bold-and-colour", () => {
    expect(
      toBuildLines([
        "\x1b[2K\x1b[1Aresolving \x1b[1;31merror\x1b[39;49m done\x1b[K",
      ])[0].text,
    ).toBe("resolving error done");
  });

  it("keeps the backend's own markers and a literal bracket that no ESC introduces", () => {
    expect(toBuildLines(["✅ Image Pushed [0m literal"])[0]).toEqual({
      text: "✅ Image Pushed [0m literal",
      tone: "ok",
    });
  });
});

/**
 * BuildKit's warning items name a check rule and a Dockerfile line, and carry no
 * form of the word "warning" — the header above them does. The item is the line
 * that says what is wrong, so it is the one the tone has to be on.
 */
describe("toneOf — BuildKit warning items", () => {
  it.each([
    " - UndefinedVar: Usage of undefined variable '$NIXPACKS_PATH' (line 18)",
    " - SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data (ENV \"API_TOKEN\") (line 7)",
    " - JSONArgsRecommended: JSON arguments recommended for CMD to prevent unintended behavior related to OS signals (line 12)",
  ])("tones %s as a warning", (line) => {
    expect(toneOf(line)).toBe("warn");
  });

  it.each([
    // Ordinary list items in other tools' output: no rule name, or no line.
    " - Installing dependencies (line 18)",
    " - express: 4.18.2",
    " - UndefinedVar: no Dockerfile line named",
    "   - Nested: item (line 3)",
  ])("leaves %s untoned", (line) => {
    expect(toneOf(line)).toBeUndefined();
  });
});
