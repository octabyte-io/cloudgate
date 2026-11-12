import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DataTable } from "@/components/console/data-table";

import { serviceColumns, type ServiceRow } from "./service-row";

afterEach(cleanup);

const LONG = "a-very-long-application-name-".repeat(3).slice(0, 100);

const ROW: ServiceRow = {
  id: "app-1",
  kind: "application",
  name: LONG,
  appName: "app-x4k2m9",
  status: "idle",
  href: "/applications/app-1",
};

describe("serviceColumns", () => {
  it("truncates a long Name inside a bounded column and keeps the whole name on its title", () => {
    const name = serviceColumns().find((column) => column.id === "name");
    expect(name?.truncate).toBe(true);

    render(
      <DataTable label="Services" columns={serviceColumns()} rows={[ROW]} getRowId={(row) => row.id} />,
    );
    const link = screen.getByRole("link", { name: LONG });
    expect(link.getAttribute("title")).toBe(LONG);
    expect(link.className).toMatch(/\bmax-w-full\b.*\btruncate\b/);
    expect(link.closest("td > div")?.className).toMatch(/\bmin-w-full\b/);
  });
});
