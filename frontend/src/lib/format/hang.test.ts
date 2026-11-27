import { describe, expect, it } from "vitest";

import { hangColumns, MAX_HANG } from "./hang";

describe("hangColumns", () => {
  it("counts leading spaces as columns", () => {
    expect(hangColumns("key: value")).toBe(0);
    expect(hangColumns("    image: nginx")).toBe(4);
    expect(hangColumns("   ")).toBe(3);
    expect(hangColumns("")).toBe(0);
  });

  it("takes a tab to the next tab stop", () => {
    expect(hangColumns("\tx")).toBe(8);
    expect(hangColumns("  \tx")).toBe(8);
    expect(hangColumns("\tx", 4)).toBe(4);
    expect(hangColumns("  \t\tx", 4)).toBe(8);
  });

  it("stops at the first character that is not indentation", () => {
    expect(hangColumns("  a  b")).toBe(2);
  });

  it("caps a deep indent so a wrapped line has room to wrap into", () => {
    expect(hangColumns(" ".repeat(60) + "x")).toBe(MAX_HANG);
  });
});
