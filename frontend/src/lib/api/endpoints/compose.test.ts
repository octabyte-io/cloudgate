import { describe, expect, it } from "vitest";

import { runsOnStackVm } from "./compose";

describe("runsOnStackVm", () => {
  it("answers yes for a stack in a Cloud account, whose place is its own Stack VM", () => {
    expect(runsOnStackVm({ cloudAccountId: "ca_1" })).toBe(true);
  });

  it("answers no for a stack on a Server or this Cloudgate host", () => {
    expect(runsOnStackVm({ cloudAccountId: null })).toBe(false);
  });
});
