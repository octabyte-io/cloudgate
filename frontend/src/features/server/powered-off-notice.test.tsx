import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Server } from "@/lib/api/endpoints/servers";

import { PoweredOffNotice } from "./powered-off-notice";

afterEach(cleanup);

const serverWith = (boughtServer: Server["boughtServer"]) =>
  ({ serverId: "bs-web", name: "web-1", boughtServer }) as Server;

describe("PoweredOffNotice", () => {
  it("says a Bought Server was powered off by an operator, why, and where to ask", () => {
    render(
      <PoweredOffNotice
        server={serverWith({
          stage: "ready",
          poweredOff: { at: "2026-11-10T09:00:00.000Z", reason: "Port scan" },
          deletesOn: null,
          deletedAt: null,
        })}
      />,
    );

    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("Powered off by an operator");
    expect(notice.textContent).toContain("Reason: Port scan");
    expect(notice.textContent).toContain(
      "Only an operator can power it back on.",
    );
    expect(
      screen
        .getByRole("link", { name: "support@octabyte.io" })
        .getAttribute("href"),
    ).toBe("mailto:support@octabyte.io");
    // Spaced from the cards below it, as the notices beside it are.
    expect(notice.className).toContain("mb-4");
  });

  it("says nothing for one that is running, or for a Server of the customer's own", () => {
    const { container } = render(
      <>
        <PoweredOffNotice
          server={serverWith({
            stage: "ready",
            poweredOff: null,
            deletesOn: null,
            deletedAt: null,
          })}
        />
        <PoweredOffNotice server={serverWith(null)} />
      </>,
    );
    expect(container.textContent).toBe("");
  });
});
