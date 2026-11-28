import { describe, expect, it } from "vitest";

import { organizationNav, scopeNav, type NavEntry } from "./nav";
import type { ScopeRoute } from "./scope";

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
    const nav = organizationNav({ boughtServerOffered: false });
    const observe = nav.findIndex(
      (entry) => entry.kind === "label" && entry.label === "Observe",
    );
    expect(labels(nav.slice(observe + 1, observe + 4))).toEqual([
      "Deployments",
      "Monitoring",
      "Requests",
    ]);
  });

  it("puts Build above Observe", () => {
    const nav = organizationNav({ boughtServerOffered: false });
    const sections = nav.flatMap((entry) =>
      entry.kind === "label" ? [entry.label] : [],
    );
    expect(sections).toEqual(["Build", "Observe"]);
    const build = nav.findIndex(
      (entry) => entry.kind === "label" && entry.label === "Build",
    );
    expect(labels(nav.slice(build + 1, build + 3))).toEqual([
      "Projects",
      "Templates",
    ]);
  });
});

describe("organizationNav", () => {
  /**
   * A row with a condition is left out of the rail and ⌘K's `go:` pages while
   * the condition does not hold. Bought Servers holds when buying a Server is
   * offered here: the Hosted instance with the provider set up, even before
   * anything is bought.
   */
  describe("the Organization rail's Bought Servers row", () => {
    const organization: ScopeRoute = {
      kind: "organization",
      id: null,
      variant: null,
      tab: "/",
    };
    // The rail as it stood before the row, written out rather than read off
    // the table, so a row the condition moved or dropped shows.
    const everyOtherRow = [
      "Organization home",
      "Recents",
      "Starred",
      "Servers",
      "Projects",
      "Templates",
      "Deployments",
      "Monitoring",
      "Requests",
      "Settings",
      "Help & support",
    ];

    it("is absent from the rail and the pages when buying is not offered", () => {
      const facts = { boughtServerOffered: false };
      expect(labels(scopeNav(organization, undefined, facts))).toEqual(
        everyOtherRow,
      );
      expect(labels(organizationNav(facts))).toEqual(everyOtherRow);
    });

    it("sits directly under Servers when buying is offered", () => {
      const facts = { boughtServerOffered: true };
      const expected = [
        ...everyOtherRow.slice(0, 4),
        "Bought Servers",
        ...everyOtherRow.slice(4),
      ];
      expect(labels(scopeNav(organization, undefined, facts))).toEqual(
        expected,
      );
      expect(labels(organizationNav(facts))).toEqual(expected);
    });

    it("opens the Bought Servers page", () => {
      const row = organizationNav({ boughtServerOffered: true }).find(
        (entry) => entry.kind === "item" && entry.label === "Bought Servers",
      );
      expect(row).toMatchObject({ tab: "/bought-servers" });
    });

    it("leaves every other row as it was", () => {
      const without = organizationNav({ boughtServerOffered: false });
      const withRow = organizationNav({ boughtServerOffered: true }).filter(
        (entry) => !(entry.kind === "item" && entry.label === "Bought Servers"),
      );
      expect(withRow).toEqual(without);
    });
  });
});
