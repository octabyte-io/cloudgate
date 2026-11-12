import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Server } from "@/lib/api/endpoints/servers";

import { MaintenanceNotice } from "./maintenance-notice";

afterEach(cleanup);

const serverWith = (maintenanceSince: string | null) =>
  ({
    serverId: "srv-1",
    name: "edge-1",
    maintenanceSince,
    maintenanceStartedBy: maintenanceSince ? "user-1" : null,
  }) as Server;

describe("MaintenanceNotice", () => {
  it("says since when a Server is in maintenance, and that nothing new will start", () => {
    render(<MaintenanceNotice server={serverWith("2026-11-12T15:00:00.000Z")} />);

    const notice = screen.getByRole("status");
    expect(notice.textContent).toMatch(/^In maintenance since .+\. Nothing new will start on this Server\.$/);
    expect(notice.querySelector("time")?.getAttribute("dateTime")).toBe(
      "2026-11-12T15:00:00.000Z",
    );
  });

  it("says nothing for a Server that is not in maintenance", () => {
    const { container } = render(<MaintenanceNotice server={serverWith(null)} />);
    expect(container.textContent).toBe("");
  });
});
