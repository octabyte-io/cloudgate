import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { formatDay } from "@/lib/api/endpoints/billing";
import type { Server } from "@/lib/api/endpoints/servers";

import { BoughtServerNotice } from "./bought-server-notice";

afterEach(cleanup);

const DUE = "2026-11-17T10:00:00.000Z";
const GONE = "2026-11-18T05:17:00.000Z";

function bought(
  over: Partial<NonNullable<Server["boughtServer"]>>,
): Pick<Server, "boughtServer"> {
  return {
    boughtServer: {
      stage: "ready",
      deletesOn: null,
      deletedAt: null,
      ...over,
    },
  };
}

describe("BoughtServerNotice", () => {
  it("shows the red deletion bar with the date, and says the Server keeps working", () => {
    render(<BoughtServerNotice server={bought({ deletesOn: DUE })} />);

    const bar = screen.getByRole("status");
    expect(bar.textContent).toContain(`Due for deletion on ${formatDay(DUE)}.`);
    expect(bar.textContent).toContain("It keeps working until then");
    expect(bar.textContent).toContain("data and backups");
    expect(
      screen
        .getByRole("link", { name: "Pay the open invoice" })
        .getAttribute("href"),
    ).toBe("/settings/billing");
  });

  it("marks the Deleted record with the day its machine went, and its Services still listed", () => {
    render(
      <BoughtServerNotice
        server={bought({ stage: "deleted", deletedAt: GONE })}
      />,
    );

    const bar = screen.getByRole("status");
    expect(bar.textContent).toContain(
      `Deleted. Its machine was deleted on ${formatDay(GONE)}, and its data and backups are gone.`,
    );
    expect(bar.textContent).toContain("Its Services are still listed");
  });

  it("shows nothing for a Bought Server with no date, nor for a Server of the customer's own", () => {
    const { container } = render(
      <>
        <BoughtServerNotice server={bought({})} />
        <BoughtServerNotice server={{ boughtServer: null }} />
      </>,
    );

    expect(container.innerHTML).toBe("");
  });

  it("never names the provider", () => {
    const { container } = render(
      <BoughtServerNotice server={bought({ deletesOn: DUE })} />,
    );

    expect(container.textContent).not.toMatch(/hetzner/i);
  });
});
