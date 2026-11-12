import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "@/lib/api/endpoints/databases";

import { ConnectionCard } from "./connection-card";

afterEach(cleanup);

/**
 * `pgdemo` as the L06 run left it: created from the modal's default, so
 * `serverId` is null, there is no `server` row, and a port is published.
 */
function database(server: Database["server"]): Database {
  return {
    appName: "postgres-nz59mm",
    databaseName: "pgdemo",
    databaseUser: "pgdemo",
    databasePassword: "s3cret",
    databaseRootPassword: undefined,
    externalPort: 5433,
    server,
  } as unknown as Database;
}

function reveal() {
  fireEvent.click(screen.getByRole("button", { name: "Show secrets" }));
}

describe("ConnectionCard, from outside the Server", () => {
  it("offers no connection string for a database on the platform's own host", () => {
    render(<ConnectionCard database={database(null)} kind="postgres" />);
    reveal();

    // The row used to be built with the literal `"<this host>"` and rendered
    // with a copy button, so revealing the secrets produced something that read
    // as a working URI and put the password on the clipboard for a string that
    // cannot connect.
    expect(document.body.textContent).not.toContain("<this host>");
    expect(
      screen.queryByRole("button", {
        name: /external connection string/i,
      }),
    ).toBe(null);
  });

  it("says why there is none, rather than leaving a gap", () => {
    render(<ConnectionCard database={database(null)} kind="postgres" />);

    expect(document.body.textContent).toContain(
      "no connection string to copy",
    );
    // The Host row's own honesty, which this now matches.
    expect(document.body.textContent).toContain(
      "the address of this Cloudgate host",
    );
  });

  it("still builds and offers one for a database on a Server with an address", () => {
    render(
      <ConnectionCard
        database={
          database({ ipAddress: "203.0.113.42" } as Database["server"])
        }
        kind="postgres"
      />,
    );
    reveal();

    expect(document.body.textContent).toContain(
      "postgresql://pgdemo:s3cret@203.0.113.42:5433/pgdemo",
    );
    expect(
      screen.getByRole("button", { name: /external connection string/i }),
    ).toBeDefined();
  });
});
