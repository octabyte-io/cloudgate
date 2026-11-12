import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContainerListItem } from "@/lib/api/endpoints/docker";

import { ContainerActions } from "./container-actions";

afterEach(cleanup);

const container = {
  containerId: "c1",
  name: "invoices-web",
  image: "nginx",
  ports: "",
  state: "running",
  status: "Up 4 minutes",
  serverId: "srv-1",
} satisfies ContainerListItem;

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The open menu's lifecycle group, as rows. */
function lifecycleRows() {
  render(
    withQuery(
      <ContainerActions
        container={container}
        serverId="srv-1"
        onInspect={vi.fn()}
        onShell={vi.fn()}
      />,
    ),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for invoices-web" }),
  );

  return ["Open a shell", "Inspect it", "Start", "Restart", "Stop"].map(
    (name) => screen.getByRole("menuitem", { name }),
  );
}

/**
 * That the lifecycle rows line up — the half the lint rule cannot see.
 *
 * `cloudgate/menu-group-icon-parity` proves the five rows *agree*; it is a
 * static rule and an `icon` naming a glyph that did not exist would satisfy it
 * just as well. These assert what the browser gets: a glyph in each of the five
 * rows, Stop's among them. Stop is named on its own because it is the row the
 * issue is about and the only one whose glyph had to be added to the map — a
 * regression that dropped `stop` from the map would take `icon="stop"` with it
 * and leave the group consistently bare, which the rule would accept.
 */
describe("Open a shell with the Dock full", () => {
  it("is off, and says why", () => {
    const onShell = vi.fn();
    render(
      withQuery(
        <ContainerActions
          container={container}
          serverId="srv-1"
          onInspect={vi.fn()}
          onShell={onShell}
          dockFull
        />,
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for invoices-web" }),
    );

    const row = screen.getByRole("menuitem", {
      name: "Open a shell (the Dock is full)",
    });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("title")).toBe(
      "The Dock holds four shells. Close one to open another.",
    );
    fireEvent.click(row);
    expect(onShell).not.toHaveBeenCalled();
  });
});

describe("ContainerActions", () => {
  it("draws a glyph in every row of the container's lifecycle group", () => {
    for (const row of lifecycleRows()) {
      expect(row.querySelector("svg")).not.toBe(null);
    }
  });

  it("draws Stop's glyph in the column its siblings use", () => {
    const rows = lifecycleRows();
    const stop = rows[rows.length - 1];

    // The glyph is the row's *first* child, which is what makes the label start
    // at the same offset as every other row's. An icon anywhere else in the row
    // would pass the loop above and still leave the label out of line.
    expect(stop.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  });
});
