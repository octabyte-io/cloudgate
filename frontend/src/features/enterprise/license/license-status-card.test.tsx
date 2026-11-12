import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { useLicenseStatus } from "../use-license";

import { LicenseStatusCard } from "./license-status-card";

afterEach(cleanup);

/**
 * What the card says when it could not find out (H-48).
 *
 * It answered one hand-written sentence for every error and imported no
 * `errorMessage` at all — the milder half of the finding, and the same complaint
 * H-37 made of `domain-gate-switch.tsx`'s non-403 branch: the backend's own
 * account of what happened was discarded, so a **banned** operator, a stopped
 * backend and a 500 were all told "Cloudgate could not read whether this
 * Organization is licensed" and nothing else. That sentence is not *wrong* for
 * any of them, which is why it stays — it answers the card's own question, which
 * `errorMessage()` cannot. What it never says is why, or what to do, and for the
 * ban there is a move to name.
 */

const COULD_NOT_READ =
  "Cloudgate could not read whether this Organization is licensed.";

function said(error: unknown) {
  render(
    <LicenseStatusCard
      status={
        {
          data: undefined,
          error,
          isPending: false,
        } as unknown as ReturnType<typeof useLicenseStatus>
      }
    />,
  );
  return document.body.textContent ?? "";
}

/** The card with a settled `GET /license/status` behind it. */
function reporting(data: {
  licensed: boolean;
  status: string;
  validUntil: string | null;
  features?: string[];
}) {
  return render(
    <LicenseStatusCard
      status={
        {
          data: { features: [], ...data },
          error: null,
          isPending: false,
        } as unknown as ReturnType<typeof useLicenseStatus>
      }
    />,
  );
}

describe("LicenseStatusCard", () => {
  it("keeps its own account of what could not be read, and adds the backend's", () => {
    const text = said(new ApiError(500, "Boom"));

    expect(text).toContain(COULD_NOT_READ);
    expect(text).toContain("The backend hit an error handling that");
    // §3.5 — never `ApiError.message`.
    expect(text).not.toContain("Boom");
  });

  it("names the ban rather than leaving a banned reader with only 'could not read'", () => {
    const text = said(
      new ApiError(403, "This account is banned", { code: "BANNED_USER" }),
    );

    expect(text).toContain("This account has been banned. Ask an owner to lift the ban.");
    // The card's own sentence is still the honest answer to its own heading.
    expect(text).toContain(COULD_NOT_READ);
  });

  it("claims nothing about the license while it cannot read one", () => {
    const text = said(new ApiError(403, "No active organization"));

    // F07's `CountTile` defect: a confident claim made because a read failed.
    expect(text).not.toContain("Licensed");
    expect(text).not.toContain("are refused for this Organization");
  });

  /**
   * The card told the operator the expiry was unknowable — "no route
   * reports the date, so this screen cannot warn you in advance" — while
   * `GET /license/status` was handing it `validUntil` and the card's own
   * docblock recorded the sentence as left behind by an earlier change.
   */
  describe("the expiry date", () => {
    /*
      The rendered stamp is asserted by year and by the machine-readable
      `dateTime`, not by "Jun 1": `timeExact` formats in the reader's zone, so a
      fixed day and month would pass in London and fail in Auckland.
    */
    it("prints the date a license runs until", () => {
      const validUntil = "2030-06-01T09:30:00.000Z";
      const { container } = reporting({
        licensed: true,
        status: "active",
        validUntil,
      });
      const text = container.textContent ?? "";

      expect(text).toContain("This license runs until");
      expect(text).toContain("2030");
      expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
        validUntil,
      );
      // The claim that replaced it must not survive anywhere on the card.
      expect(text).not.toContain("no route reports the date");
    });

    // "This date is the only advance warning there is" stopped being
    // true once the console grew a renewal bar and a daily re-check.
    it("names the renewal bar and the daily re-check as the advance warning", () => {
      const { container } = reporting({
        licensed: true,
        status: "active",
        validUntil: "2030-06-01T09:30:00.000Z",
      });
      const text = container.textContent ?? "";

      expect(text).toContain(
        "Owners and admins see a bar across the console from 14 days before this date",
      );
      expect(text).toContain("re-checks the key each day");
      expect(text).not.toContain("only advance warning");
    });

    it("says a license has lapsed when the date has passed", () => {
      const validUntil = "2020-01-02T00:00:00.000Z";
      const { container } = reporting({
        licensed: false,
        // The stored status stays `active` through a lapse — nothing rewrites
        // the row — so the date is the only thing that says the licence is
        // over, which is why the sentence has to carry it.
        status: "active",
        validUntil,
      });
      const text = container.textContent ?? "";

      expect(text).toContain("This license lapsed on");
      expect(text).toContain("2020");
      expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
        validUntil,
      );
      expect(text).not.toContain("This license runs until");
    });

    it("says no date is recorded rather than that none can be reported", () => {
      reporting({ licensed: false, status: "inactive", validUntil: null });
      const text = document.body.textContent ?? "";

      expect(text).toContain("No expiry date is recorded for this Organization");
      expect(text).not.toContain("no route reports the date");
      expect(text).not.toContain("cannot warn you in advance");
    });
  });

  /**
   * "the five licensed sections below" sat above a list of four for as
   * long as audit log filtering had been out of the list — and the
   * sentence's own opening clause already accounted for its removal.
   */
  it("counts the licensed features it actually lists", () => {
    const { container } = reporting({
      licensed: true,
      status: "active",
      validUntil: null,
    });

    const listed = container.querySelectorAll("li").length;

    // Read out of the sentence rather than compared to a literal: the defect was
    // a number nothing checked against the list.
    const stated = Number(
      /all (\d+) licensed feature/.exec(container.textContent ?? "")?.[1],
    );

    expect(listed).toBeGreaterThan(0);
    expect(stated).toBe(listed);
  });
});
