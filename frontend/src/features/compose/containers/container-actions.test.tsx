import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContainerActions } from "./container-actions";
import type { StackContainer } from "./use-stack-containers";

afterEach(cleanup);

const container = {
  service: "web",
  containerId: "c1",
  name: "invoices-web-1",
  state: "running",
  status: "Up 4 minutes",
  image: "nginx",
  ports: null,
  node: null,
  taskError: null,
} satisfies StackContainer;

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
        onLogs={vi.fn()}
      />,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Actions for web" }));

  return ["View its output", "Start", "Restart", "Stop"].map((name) =>
    screen.getByRole("menuitem", { name }),
  );
}

/**
 * The same pin as the Server's container menu, on the stack's copy of it.
 *
 * Both are asserted rather than one standing in for the other, because they are
 * two files that happened to agree: the bare Stop was found in both, and the
 * fix is the same one-word edit twice. A test of one of them would let the other
 * drift back, and the lint rule alone cannot tell a glyph that renders from an
 * `icon` naming a key that no longer exists.
 */
describe("ContainerActions", () => {
  it("draws a glyph in every row of the stack container's lifecycle group", () => {
    for (const row of lifecycleRows()) {
      expect(row.querySelector("svg")).not.toBe(null);
    }
  });

  it("draws Stop's glyph in the column its siblings use", () => {
    const rows = lifecycleRows();
    const stop = rows[rows.length - 1];

    expect(stop.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  });

  it("offers no per-container control on a Stack VM, pointing at the stack's own Restart", () => {
    render(
      withQuery(
        <ContainerActions
          container={container}
          serverId={null}
          onStackVm
          onLogs={vi.fn()}
        />,
      ),
    );

    expect(screen.queryByRole("button", { name: "Actions for web" })).toBe(
      null,
    );
    expect(screen.getByText("Restart the stack instead")).toBeTruthy();
  });
});
