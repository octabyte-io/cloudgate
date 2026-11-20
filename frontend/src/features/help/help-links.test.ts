import { describe, expect, it } from "vitest";

import { organizationNav } from "@/components/shell/nav";

import { ALL_DOCS, ANSWERS, DOCS_HOST, GUIDES } from "./help-links";

describe("the Help & support links", () => {
  it("all point at the public docs site over https", () => {
    for (const link of [...GUIDES, ...ANSWERS]) {
      expect(link.href.startsWith(`${DOCS_HOST}/`)).toBe(true);
    }
    expect(ALL_DOCS).toBe("https://cloudgate.octabyte.io/docs");
  });

  it("names each page once", () => {
    const hrefs = [...GUIDES, ...ANSWERS].map((link) => link.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("is the last row of the Organization rail, under Settings", () => {
    const nav = organizationNav();
    const last = nav.at(-1);
    const beforeLast = nav.at(-2);
    expect(last).toMatchObject({ label: "Help & support", tab: "/help" });
    expect(beforeLast).toMatchObject({ label: "Settings" });
  });
});
