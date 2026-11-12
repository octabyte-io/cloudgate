import { describe, expect, it } from "vitest";

import { unsetInterpolations } from "./interpolation-check";

describe("unsetInterpolations", () => {
  it("names a ${NAME} the stack does not set, at its first line", () => {
    const file = [
      "services:",
      "  web:",
      "    image: nginx",
      "    environment:",
      "      API_KEY: ${API_KEY}",
      "      AGAIN: ${API_KEY}",
      "      HOME_DIR: $HOME_DIR",
    ].join("\n");
    expect(unsetInterpolations(file, "")).toEqual([
      { name: "API_KEY", line: 5 },
      { name: "HOME_DIR", line: 7 },
    ]);
  });

  it("says nothing of a name the stack or Cloudgate sets, a default, or an escaped dollar", () => {
    const file = [
      "x: ${SET}",
      "y: ${WITH_DEFAULT:-1}",
      "z: ${OTHER-1}",
      "a: ${ALT:+on}",
      "b: $${NOT_INTERPOLATED}",
      "c: ${APP_NAME}",
    ].join("\n");
    expect(unsetInterpolations(file, "SET=1")).toEqual([]);
  });

  it("still names one whose unset is an error", () => {
    expect(unsetInterpolations("x: ${REQUIRED:?set it}", null)).toEqual([
      { name: "REQUIRED", line: 1 },
    ]);
  });
});
