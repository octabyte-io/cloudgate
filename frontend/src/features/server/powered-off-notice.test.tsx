import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Server } from "@/lib/api/endpoints/servers";

import { PoweredOffNotice } from "./powered-off-notice";

afterEach(cleanup);

const serverWith = (boughtServer: Server["boughtServer"]) =>
  ({ serverId: "bs-web", name: "web-1", boughtServer }) as Server;

describe("PoweredOffNotice", () => {
  it("says a Bought Server was powered off by Cloudgate, and why", () => {
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

    expect(screen.getByRole("status").textContent).toContain(
      "Powered off by Cloudgate: Port scan",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Only Cloudgate can power it back on.",
    );
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
