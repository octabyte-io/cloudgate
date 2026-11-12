import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { RequestsRead } from "@/lib/api/endpoints/monitoring";

import { RequestsChart } from "./requests-chart";

afterEach(cleanup);

const BOUNDS = {
  start: "2026-08-28T09:00:00.000Z",
  end: "2026-08-28T11:00:00.000Z",
};

function read(
  hours: RequestsRead["hours"],
  retainedFrom?: string,
): RequestsRead {
  return {
    ...(retainedFrom === undefined ? {} : { retainedFrom }),
    state: "ok",
    target: { serverId: "srv-1", name: "eu-web-1" },
    canSwitchLogging: true,
    readAt: "2026-08-28T11:00:00.000Z",
    data: [],
    totalCount: hours.reduce((sum, hour) => sum + hour.count, 0),
    hours,
    services: [],
    noService: true,
    wholeServer: true,
    covers: "server",
    withheldShared: 0,
  };
}

function shown(props: Parameters<typeof RequestsChart>[0]["read"]) {
  render(<RequestsChart range="1h" bounds={BOUNDS} read={props} />);
  return document.body.textContent ?? "";
}

describe("RequestsChart", () => {
  it("counts the hours of the read it is handed, gaps filled at zero", () => {
    const text = shown({
      data: read([
        { hour: "2026-08-28T09:00:00Z", count: 3 },
        { hour: "2026-08-28T11:00:00Z", count: 4 },
      ]),
      error: null,
      isPending: false,
    });

    expect(text).toContain("across 3 hours · peak 4 in one hour");
    // The one hour with no traffic is a quiet hour, not a missing one.
    expect(text).toMatch(/Quiet hours1/);
  });

  it("names the ban rather than reading a refusal as no traffic", () => {
    const text = shown({
      data: undefined,
      error: new ApiError(403, "This account is banned", {
        path: "/monitoring/requests",
        code: "BANNED_USER",
      }),
      isPending: false,
    });

    expect(text).toContain(
      "This account has been banned. Ask an owner to lift the ban.",
    );
    expect(text).not.toContain("Nothing was recorded");
  });

  describe("when one read did not reach the start of the range", () => {
    const RETAINED = "2026-08-28T10:20:00.002Z";
    /** The time as the page writes it: the reader's own zone, HH:MM. */
    const at = new Date(RETAINED);
    const HHMM = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

    function shownWith(retainedFrom?: string) {
      render(
        <RequestsChart
          range="1h"
          bounds={BOUNDS}
          read={{
            data: read(
              [
                { hour: "2026-08-28T10:00:00Z", count: 2 },
                { hour: "2026-08-28T11:00:00Z", count: 4 },
              ],
              retainedFrom,
            ),
            error: null,
            isPending: false,
          }}
        />,
      );
      return document.body.textContent ?? "";
    }

    it("says how far back it shows, and suggests a shorter range", () => {
      shownWith(RETAINED);

      const note = screen.getByRole("note");
      expect(note.textContent).toContain(`Showing back to ${HHMM} only.`);
      expect(note.textContent).toContain("Pick a shorter range");
    });

    it("stripes the start of the chart as not read, not as no traffic", () => {
      const text = shownWith(RETAINED);

      expect(
        screen.getByRole("img", {
          name: new RegExp(`Not read before ${HHMM}`),
        }),
      ).toBeTruthy();
      expect(text).toContain(`Not read before ${HHMM}`);
      // 09:00 and 10:00 began before the read reached back: unread, not quiet.
      expect(text).toMatch(/Quiet hours0/);
    });

    it("shows neither when the read reached back past the range", () => {
      const text = shownWith();

      expect(screen.queryByRole("note")).toBeNull();
      expect(text).not.toContain("Not read before");
      expect(text).toMatch(/Quiet hours1/);
    });

    it("shows neither when the time it names is before the range began", () => {
      const text = shownWith("2026-08-28T08:40:00.000Z");

      expect(screen.queryByRole("note")).toBeNull();
      expect(text).not.toContain("Not read before");
    });
  });
});
