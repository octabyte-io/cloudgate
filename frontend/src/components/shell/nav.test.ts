import { describe, expect, it } from "vitest";

import { organizationNav, type NavEntry } from "./nav";

function labels(nav: NavEntry[]): string[] {
  return nav.flatMap((entry) =>
    entry.kind === "item" || entry.kind === "group" ? [entry.label] : [],
  );
}

/**
 * Requests reads each Server's own access log, so every reader is offered it,
 * the Hosted instance's customers included.
 */
describe("the Organization rail", () => {
  it("lists Requests under Observe, after Deployments and Monitoring", () => {
    const nav = organizationNav();
    const observe = nav.findIndex(
      (entry) => entry.kind === "label" && entry.label === "Observe",
    );
    expect(labels(nav.slice(observe + 1, observe + 4))).toEqual([
      "Deployments",
      "Monitoring",
      "Requests",
    ]);
  });
});
