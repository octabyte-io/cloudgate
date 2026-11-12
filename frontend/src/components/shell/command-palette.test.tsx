import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaletteKind, PaletteResult } from "./palette-sources";

const push = vi.hoisted(() => vi.fn());
const sources = vi.hoisted(() => ({
  results: [] as PaletteResult[],
  pending: false,
  unavailable: [] as PaletteKind[],
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

// The rows are the boundary: what they came from is `usePaletteSources`'s
// business, and `filterPalette` — the part that decides what is shown — stays
// real.
vi.mock("./palette-sources", async (original) => ({
  ...(await original<typeof import("./palette-sources")>()),
  usePaletteSources: () => sources,
}));

// jsdom lays nothing out, so it has no `scrollIntoView` for ↓ to call.
Element.prototype.scrollIntoView = () => {};

const { CommandPalette } = await import("./command-palette");

const PROJECT: PaletteResult = {
  kind: "proj",
  icon: "folder",
  name: "ui-tags",
  hint: "Project",
  href: "/projects/WCOGIoQAndL4q-xfdBpfU",
};
const ENVIRONMENT: PaletteResult = {
  kind: "env",
  icon: "list",
  name: "ui-main / production",
  hint: "Environment",
  href: "/environments/H5VkKHQTx6G-L383y6lcr",
};
const PAGE: PaletteResult = {
  kind: "go",
  icon: "hdd",
  name: "Servers",
  hint: "page",
  href: "/servers",
};

afterEach(cleanup);
beforeEach(() => {
  push.mockReset();
  sources.results = [PROJECT, ENVIRONMENT, PAGE];
  sources.pending = false;
  sources.unavailable = [];
});

function open() {
  render(<CommandPalette open onOpenChange={() => {}} />);
  return screen.getByRole("combobox", { name: "Search Cloudgate" });
}

function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

/** The one line the list says when it has no rows. */
const emptyMessage = () =>
  screen.getByRole("dialog").querySelector("p")?.textContent ?? "";

/**
 * The empty query shows tips, not results
 * The rows were
 * still there behind them, so Enter took a Project the operator never saw.
 */
describe("CommandPalette with an empty query", () => {
  it("does not navigate on Enter", () => {
    const field = open();

    fireEvent.keyDown(field, { key: "Enter" });

    expect(push).not.toHaveBeenCalled();
  });

  it("does not move an invisible cursor, so ↓ then Enter goes nowhere either", () => {
    const field = open();

    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowUp" });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(push).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(field.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("still takes the highlighted row once something is typed", () => {
    const field = open();
    type(field, "ui-");

    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(push.mock.calls).toEqual([[ENVIRONMENT.href]]);
  });
});

/**
 * What an empty result says
 * it names what
 * was searched, and never sends the operator to a prefix that cannot help.
 */
describe("CommandPalette with nothing to show", () => {
  it("says there are no Servers yet for srv: on an instance with none", () => {
    const field = open();
    type(field, "srv:");

    expect(emptyMessage()).toContain("No Servers yet.");
    expect(emptyMessage()).not.toContain("Try a prefix");
  });

  it("names the kind for a prefixed query that matches nothing", () => {
    sources.results = [
      ...sources.results,
      { kind: "srv", icon: "hdd", name: "edge-1", hint: "10.0.0.1", href: "/servers/a" },
    ];
    const field = open();
    type(field, "srv: ZZZ");

    expect(emptyMessage()).toContain("No Server matches “ZZZ”.");
    expect(emptyMessage()).not.toMatch(/prefix|srv:/);
  });

  it("says what ⌘K covers for a bare query, and that services are not in it", () => {
    const field = open();
    type(field, "ui-whoami");

    const message = emptyMessage();
    expect(message).toContain("Nothing matches “ui-whoami”.");
    expect(message).toContain(
      "searches Projects, Environments, Servers and pages",
    );
    expect(message).not.toContain("Try a prefix");
  });

  it("does not say none yet for a kind whose list could not be read", () => {
    // A role without `server: ['read']` is refused the list, on an instance
    // that may be full of Servers. No rows is not the same as no Servers.
    sources.unavailable = ["srv"];
    const field = open();
    type(field, "srv:");

    expect(emptyMessage()).toBe(
      "Servers could not be loaded, so ⌘K cannot search them right now.",
    );
  });

  it("says which lists are missing from a bare search", () => {
    sources.unavailable = ["proj", "env"];
    const field = open();
    type(field, "ui-whoami");

    expect(emptyMessage()).toContain(
      "Projects and Environments could not be loaded.",
    );
  });

  it("says it is looking while the rows are still on their way", () => {
    sources.pending = true;
    sources.results = [];
    const field = open();
    type(field, "srv:");

    expect(emptyMessage()).toBe("Looking…");
  });
});

/**
 * What a row says it is: the plain noun, never the raw prefix. A bare
 * query mixes kinds, so each row names its own; a prefixed one already did.
 */
describe("CommandPalette rows", () => {
  const SERVER: PaletteResult = {
    kind: "srv",
    icon: "hdd",
    name: "edge-1",
    hint: "10.0.0.1 · docker server",
    href: "/servers/a",
  };

  it("names a Server row's kind in words, not as srv:", () => {
    sources.results = [...sources.results, SERVER];
    const field = open();
    type(field, "edge");

    const row = screen.getByRole("option");
    expect(row.textContent).toContain("Server");
    expect(row.textContent).not.toMatch(/srv:|proj:|env:|go:/);
  });

  it("does not say an Environment twice when its hint is the same word", () => {
    const field = open();
    type(field, "production");

    const row = screen.getByRole("option");
    expect(row.textContent?.match(/Environment/g)).toHaveLength(1);
  });

  it("drops the kind word once a prefix has said it for every row", () => {
    sources.results = [...sources.results, SERVER];
    const field = open();
    type(field, "srv: edge");

    const row = screen.getByRole("option");
    expect(row.textContent).toBe("edge-110.0.0.1 · docker server");
  });
});
