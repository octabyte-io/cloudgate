import { describe, expect, it } from "vitest";

import { usd } from "./money";

describe("usd", () => {
  it("writes a dollar amount to the cent", () => {
    expect(usd(19.4)).toBe("$19.40");
    expect(usd(0)).toBe("$0.00");
    expect(usd(1234.567)).toBe("$1234.57");
  });

  it("writes a price under a cent as a cent, never as nothing", () => {
    expect(usd(0.004)).toBe("$0.01");
  });
});
