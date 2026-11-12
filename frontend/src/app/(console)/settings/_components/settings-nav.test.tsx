import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SETTINGS_SECTIONS } from "@/lib/settings/sections";

const path = vi.hoisted(() => ({ current: "/settings/cloud-accounts" }));
vi.mock("next/navigation", () => ({ usePathname: () => path.current }));
const reader = vi.hoisted(() => ({
  operator: false,
  hosted: false,
  pending: false,
}));
vi.mock("@/features/operator/use-operator", () => ({
  useIsOperator: () => ({
    operator: reader.operator,
    hosted: reader.hosted,
    pending: reader.pending,
  }),
}));

const { SettingsNav } = await import("./settings-nav");
const { default: SettingsIndex } = await import("../page");

afterEach(() => {
  cleanup();
  reader.operator = false;
  reader.hosted = false;
  reader.pending = false;
  path.current = "/settings/cloud-accounts";
});

/** Every section but the Operator's, which only an Operator is offered. */
const EVERYONES = SETTINGS_SECTIONS.filter((section) => !section.operatorOnly);

/**
 * Settings has one navigation: a vertical list beside each screen, with
 * every section in it and the current one marked, and a link back to the index
 * for the widths with no room for a column. The index draws only its cards.
 */
describe("SettingsNav", () => {
  it("lists every section, in its groups, and marks the current one", () => {
    render(<SettingsNav />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });

    expect(within(nav).getAllByRole("link")).toHaveLength(EVERYONES.length);
    const current = within(nav).getByRole("link", { name: "Cloud accounts" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(
      within(nav)
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "page"),
    ).toHaveLength(1);
    // Grouped: each run of sections is a list named by its label.
    expect(within(nav).getByRole("list", { name: "You" })).toBeTruthy();
  });

  it("links back to the index for a screen too narrow for the column", () => {
    render(<SettingsNav />);
    const back = screen
      .getAllByRole("link", { name: "Settings" })
      .find((link) => link.closest("nav") === null);
    expect(back?.getAttribute("href")).toBe("/settings");
  });

  it("is not drawn over the index, whose cards are the navigation", () => {
    path.current = "/settings";
    render(<SettingsIndex />);
    expect(
      screen.queryByRole("navigation", { name: "Settings sections" }),
    ).toBeNull();
  });
});

/**
 * The Operator page (ADR-0050) is listed only for an Operator on the
 * Hosted instance; `useIsOperator` answers no when self-hosted without asking.
 */
describe("the Operator section", () => {
  it("is not listed for anybody who is not an Operator, beside a screen or on the index", () => {
    render(<SettingsNav />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).queryByRole("link", { name: "Operator" })).toBeNull();
    cleanup();

    path.current = "/settings";
    render(<SettingsIndex />);
    expect(screen.queryByRole("link", { name: /^Operator/ })).toBeNull();
  });

  it("is listed for an Operator, under Platform, beside a screen and on the index", () => {
    reader.operator = true;
    render(<SettingsNav />);
    const platform = screen.getByRole("list", { name: "Platform" });
    expect(
      within(platform).getByRole("link", { name: "Operator" }).getAttribute("href"),
    ).toBe("/settings/operator");
    cleanup();

    path.current = "/settings";
    render(<SettingsIndex />);
    expect(
      screen.getByRole("link", { name: /^Operator/ }).getAttribute("href"),
    ).toBe("/settings/operator");
  });
});

/**
 * The platform host's pages — Traefik, Instance, Maintenance and Branding —
 * configure the box an Instance runs on, which on the Hosted instance is
 * Octabyte's: only an Operator is shown them there (ADR-0053). Self-hosted,
 * everybody is, as before.
 */
describe("the platform host's sections", () => {
  const PLATFORM_HOST = ["Traefik", "Instance", "Maintenance", "Branding"];

  function listed(): string[] {
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    return within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent ?? "");
  }

  it("are listed for everybody on a Self-hosted instance", () => {
    render(<SettingsNav />);
    expect(listed()).toEqual(expect.arrayContaining(PLATFORM_HOST));
  });

  it("are not listed for a customer on the Hosted instance, beside a screen or on the index", () => {
    reader.hosted = true;
    render(<SettingsNav />);
    for (const label of PLATFORM_HOST) expect(listed()).not.toContain(label);
    cleanup();

    path.current = "/settings";
    render(<SettingsIndex />);
    for (const label of PLATFORM_HOST) {
      expect(
        screen.queryByRole("link", { name: new RegExp(`^${label}`) }),
      ).toBeNull();
    }
    // Branding was the Enterprise group's last; the group itself stays.
    expect(screen.getByRole("heading", { name: "Enterprise" })).toBeTruthy();
  });

  it("are listed for an Operator on the Hosted instance", () => {
    reader.hosted = true;
    reader.operator = true;
    render(<SettingsNav />);
    expect(listed()).toEqual(expect.arrayContaining(PLATFORM_HOST));
  });

  it("are not listed while the mode or the Operator answer is still on its way, so they never flash in and out", () => {
    reader.pending = true;
    render(<SettingsNav />);
    for (const label of PLATFORM_HOST) expect(listed()).not.toContain(label);
  });
});
