import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { domainColumns } from "@/features/application/domains/domain-columns";

import { DataTable, type Column } from "./data-table";

afterEach(cleanup);

type Row = { id: string; host: string; port: number };

const ROWS: Row[] = [{ id: "d1", host: "app-8pe8l2-b2ea75.sslip.io", port: 3000 }];

const COLUMNS: Column<Row>[] = [
  { id: "host", head: "Host", truncate: true, cell: (row) => row.host },
  {
    id: "port",
    head: "Port",
    tone: "num",
    compare: (a, b) => a.port - b.port,
    cell: (row) => row.port,
  },
  { id: "gate", head: "Sign-in", cell: () => "on" },
  { id: "actions", head: <span className="sr-only">Actions</span>, cell: () => "Remove" },
];

/**
 * What keeps a row's Actions inside its card at desktop width.
 *
 * jsdom has no layout, so these pin the structure the widths come from rather
 * than the widths: which columns take the slack, and what may not set a
 * column's minimum. The widths themselves were measured in Chrome — the
 * Application Domains table at 1470px was 845 wide in a 783 box while its host
 * sat at its floor, because "Container port" and "Sign-in required" could not
 * wrap and held their columns at 151px and 124px. Now a header is one
 * line again, and those columns are "Port" and "Sign-in".
 */
describe("DataTable", () => {
  it("keeps every header on one line, in sans, whatever its column's cells carry", () => {
    const columns: Column<Row>[] = [
      { ...COLUMNS[0], className: "font-mono" },
      { ...COLUMNS[1], className: "font-mono whitespace-normal wrap-anywhere" },
      COLUMNS[2],
    ];
    render(<DataTable label="Domains" columns={columns} rows={ROWS} getRowId={(row) => row.id} />);

    for (const header of screen.getAllByRole("columnheader")) {
      expect(header.className).toMatch(/\bwhitespace-nowrap\b/);
      expect(header.className).not.toMatch(/\bwhitespace-normal\b/);
      expect(header.className).toMatch(/\bfont-sans\b/);
      expect(header.className).not.toMatch(/\bfont-mono\b/);
    }
    // The mono stays on the values, where it belongs.
    expect(screen.getByText(ROWS[0].host).closest("td")?.className).toMatch(/\bfont-mono\b/);
  });

  it("right-aligns a numeric column's head over its values, sortable or not", () => {
    const columns: Column<Row>[] = [
      COLUMNS[1],
      { id: "plain", head: "Plain", tone: "num", cell: (row) => row.port },
    ];
    render(<DataTable label="Domains" columns={columns} rows={ROWS} getRowId={(row) => row.id} />);

    // A sort button fills its cell, so it is the button that has to push its
    // label to the end — `text-right` on the cell moved nothing.
    const sort = screen.getByRole("button", { name: /Port/ });
    expect(sort.className).toMatch(/\bjustify-end\b/);
    expect(sort.className).toMatch(/\bmin-h-thead\b/);
    const plain = screen.getByRole("columnheader", { name: "Plain" });
    expect(plain.className).toMatch(/\btext-right\b/);
    expect(plain.firstElementChild?.className).toMatch(/\bjustify-end\b/);
  });

  it("names the Domains table's columns in single words, so one-line heads do not widen it past its card", () => {
    const heads = domainColumns({
      action: () => null,
      gate: () => null,
      service: () => null,
    })
      .map((column) => column.head)
      .filter((head): head is string => typeof head === "string");

    expect(heads.length).toBeGreaterThanOrEqual(6);
    expect(heads.filter((head) => /\s/.test(head))).toEqual([]);
  });

  it("gives a truncating column the slack and clips its content to it", () => {
    render(<DataTable label="Domains" columns={COLUMNS} rows={ROWS} getRowId={(row) => row.id} />);

    const host = screen.getByRole("columnheader", { name: "Host" });
    expect(host.style.width).toBe("100%");
    expect(host.className).toMatch(/\bmin-w-32\b/);
    expect(screen.getByRole("columnheader", { name: /Port/ }).style.width).toBe("");

    const clip = screen.getByText(ROWS[0].host);
    expect(clip.tagName).toBe("DIV");
    // A fixed width is the column's floor; `w-0` let Sessions' Device column
    // collapse to nothing at phone width.
    expect(clip.className).toMatch(/\bw-32\b.*\bmin-w-full\b.*\btruncate\b/);
  });

  it("splits the slack evenly between several truncating columns", () => {
    const columns: Column<Row>[] = [
      COLUMNS[0],
      { id: "other", head: "Other", truncate: true, cell: (row) => row.host },
    ];
    render(<DataTable label="Domains" columns={columns} rows={ROWS} getRowId={(row) => row.id} />);

    expect(screen.getByRole("columnheader", { name: "Host" }).style.width).toBe("50%");
    expect(screen.getByRole("columnheader", { name: "Other" }).style.width).toBe("50%");
  });
});

/**
 * What a table does at phone width: it says it scrolls, keeps the row's
 * actions on screen, and puts its empty state where the card can show it.
 */
describe("DataTable at phone width", () => {
  /** jsdom lays nothing out, so the scroller's sizes are stated. */
  function overflow(scroller: HTMLElement, scrollLeft: number) {
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 900 });
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 358 });
    scroller.scrollLeft = scrollLeft;
    fireEvent.scroll(scroller);
  }

  it("renders the empty state under the scroller, not in a cell of the table", () => {
    render(
      <DataTable
        label="Domains"
        columns={COLUMNS}
        rows={[]}
        getRowId={(row) => row.id}
        empty={<p>No host points into this Environment yet</p>}
      />,
    );

    const empty = screen.getByText(/No host points/);
    expect(empty.closest("table")).toBeNull();
    expect(empty.closest('[data-slot="table-container"]')).toBeNull();
    // The head stays: the columns are the promise of what will be here.
    expect(screen.getAllByRole("columnheader")).toHaveLength(COLUMNS.length);
    expect(screen.queryAllByRole("cell")).toHaveLength(0);
  });

  it("pins a last column whose head is for screen readers only, the row's actions, to the right edge", () => {
    render(<DataTable label="Domains" columns={COLUMNS} rows={ROWS} getRowId={(row) => row.id} />);

    const action = screen.getByText("Remove").closest("td")!;
    expect(action.className).toMatch(/\bsticky\b.*\bright-0\b/);
    expect(action.className).toMatch(/\bbg-panel\b/);
    expect(screen.getByRole("columnheader", { name: "Actions" }).className).toMatch(/\bsticky\b/);
    expect(screen.getByText("on").closest("td")!.className).not.toMatch(/\bsticky\b/);
  });

  it("pins nothing when the last column has a visible head", () => {
    render(
      <DataTable label="Domains" columns={COLUMNS.slice(0, 3)} rows={ROWS} getRowId={(row) => row.id} />,
    );
    for (const cell of screen.getAllByRole("cell")) {
      expect(cell.className).not.toMatch(/\bsticky\b/);
    }
  });

  it("fades the side that has more table beyond it", () => {
    const { container } = render(
      <DataTable label="Domains" columns={COLUMNS} rows={ROWS} getRowId={(row) => row.id} />,
    );
    const scroller = container.querySelector<HTMLElement>('[data-slot="table-container"]')!;
    const action = () => screen.getByText("Remove").closest("td")!;

    // Nothing to scroll: no cue.
    expect(action().className).not.toMatch(/before:/);

    // At the start of a wide table: more to the right, which the pinned
    // Actions column's left edge says.
    overflow(scroller, 0);
    expect(action().className).toMatch(/\bbefore:bg-linear-to-l\b/);
    expect(container.querySelector(".bg-linear-to-r")).toBeNull();

    // Scrolled to the end: more to the left only.
    overflow(scroller, 900 - 358);
    expect(action().className).not.toMatch(/before:/);
    expect(container.querySelector(".bg-linear-to-r")).not.toBeNull();
  });

  it("fades the scroller's own right edge when no column is pinned", () => {
    const { container } = render(
      <DataTable label="Domains" columns={COLUMNS.slice(0, 3)} rows={ROWS} getRowId={(row) => row.id} />,
    );
    overflow(container.querySelector<HTMLElement>('[data-slot="table-container"]')!, 0);
    expect(container.querySelector(".bg-linear-to-l")).not.toBeNull();
  });
});
