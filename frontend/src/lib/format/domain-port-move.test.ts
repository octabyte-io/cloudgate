import { describe, expect, it } from "vitest";

import { domainPortMoveSentence } from "./domain-port-move";

describe("domainPortMoveSentence", () => {
  it("counts the Domains moved and names the one left on its port", () => {
    expect(
      domainPortMoveSentence({
        from: 3000,
        to: 3900,
        moved: [
          { domainId: "d1", host: "shop.example.com" },
          { domainId: "d2", host: "www.example.com" },
        ],
        left: [{ domainId: "d3", host: "api.example.com", port: 8080 }],
      }),
    ).toBe("2 Domains moved to port 3900; api.example.com stays on 8080.");
  });

  it("agrees with one Domain moved and several left", () => {
    expect(
      domainPortMoveSentence({
        from: 3000,
        to: 3900,
        moved: [{ domainId: "d1", host: "www.example.com" }],
        left: [
          { domainId: "d2", host: "api.example.com", port: 8080 },
          { domainId: "d3", host: "admin.example.com", port: null },
        ],
      }),
    ).toBe(
      "1 Domain moved to port 3900; api.example.com stays on 8080, admin.example.com on no port.",
    );
  });

  it("says no Domain was on the old port when none moved", () => {
    expect(
      domainPortMoveSentence({
        from: 3000,
        to: 3900,
        moved: [],
        left: [{ domainId: "d1", host: "api.example.com", port: 8080 }],
      }),
    ).toBe("No Domain was on port 3000; api.example.com stays on 8080.");
    expect(
      domainPortMoveSentence({ from: 3000, to: 3900, moved: [], left: [] }),
    ).toBe("No Domain was on port 3000.");
  });
});
