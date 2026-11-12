import { describe, expect, it } from "vitest";

import { countVariables, parseEnvBlob } from "./env-blob";
import fixtures from "./env-blob.fixtures.json";

/**
 * The console's reading of a variable block has to be the deploy's reading of
 * it, or the table shows an operator a value their container never gets
 * (a multi-line
 * quoted value listed as its first line with the quote left on).
 *
 * The frontend cannot import the backend's `dotenv`, so the agreement is held
 * by one table both sides read: `env-blob.fixtures.json`. This file pins
 * `parseEnvBlob` to it, and `backend/test/docker/env-blob-parity.spec.ts` pins
 * `dotenv.parse` to the same rows — so a row that one side reads differently
 * reds on that side, and a `dotenv` upgrade that changes the grammar reds in the
 * backend before the console quietly disagrees with it.
 */

describe("parseEnvBlob agrees with the deploy's dotenv.parse", () => {
  it.each(fixtures)("$name", ({ blob, vars }) => {
    const parsed = parseEnvBlob(blob);
    expect(Object.fromEntries(parsed.map((v) => [v.key, v.value]))).toEqual(vars);
    expect(parsed.map((v) => v.key)).toEqual(Object.keys(vars));
    expect(countVariables(blob)).toBe(Object.keys(vars).length);
  });
});

describe("parseEnvBlob", () => {
  it("reads a quoted value across lines as one variable, not two", () => {
    const parsed = parseEnvBlob('A=1\nB="x\ny=z"\nC=3');
    expect(parsed.map((v) => v.key)).toEqual(["A", "B", "C"]);
    expect(parsed.find((v) => v.key === "B")?.value).toBe("x\ny=z");
    expect(parsed.some((v) => v.key === "y")).toBe(false);
  });

  it("numbers each variable by the line its key is on", () => {
    const parsed = parseEnvBlob('# head\n\nA="one\ntwo"\nB=3');
    expect(parsed.map((v) => [v.key, v.line])).toEqual([
      ["A", 3],
      ["B", 5],
    ]);
  });

  it("guesses secrets from the key, multi-line values included", () => {
    const parsed = parseEnvBlob("PRIVATE_KEY='-----BEGIN-----\nabc\n-----END-----'\nPORT=80");
    expect(parsed.map((v) => [v.key, v.secret])).toEqual([
      ["PRIVATE_KEY", true],
      ["PORT", false],
    ]);
  });

  it("reads nothing from nothing", () => {
    expect(parseEnvBlob(null)).toEqual([]);
    expect(parseEnvBlob("")).toEqual([]);
  });
});
