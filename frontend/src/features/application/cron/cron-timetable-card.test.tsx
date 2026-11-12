import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { CronService } from "@/lib/api/endpoints/applications";

import { CronTimetableCard } from "./cron-timetable-card";

afterEach(cleanup);

const REPORT: CronService = {
  schedule: "0 3 * * MON-FRI",
  timezone: "Europe/Berlin",
  timeout: "30m",
  timeoutSeconds: 1800,
  // 03:00 in Berlin, summer time and then winter time.
  nextFireTimes: ["2026-10-23T01:00:00.000Z", "2026-10-26T02:00:00.000Z"],
  waitingForFirstBuild: false,
};

function read(cron: CronService) {
  const { container } = render(<CronTimetableCard cron={cron} />);
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

/** A Cron service's timetable on its Service page. */
describe("CronTimetableCard", () => {
  it("shows the schedule, time zone and time limit the config set", () => {
    const text = read(REPORT);

    expect(text).toContain("Schedule0 3 * * MON-FRI");
    expect(text).toContain("Time zoneEurope/Berlin");
    expect(text).toContain("Time limit30m");
  });

  it("writes the next runs in the Cron service's own time zone", () => {
    const { container } = render(<CronTimetableCard cron={REPORT} />);
    const times = [...container.querySelectorAll("time")];

    expect(times.map((time) => time.getAttribute("dateTime"))).toEqual(
      REPORT.nextFireTimes,
    );
    expect(times.map((time) => time.textContent)).toEqual([
      "Fri, 23 Oct 2026, 03:00",
      "Mon, 26 Oct 2026, 03:00",
    ]);
  });

  it("says it is waiting for its first build until one succeeds", () => {
    expect(read({ ...REPORT, waitingForFirstBuild: true })).toContain(
      "Waiting for first build",
    );
    expect(read(REPORT)).not.toContain("Waiting for first build");
  });
});
