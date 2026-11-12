import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FIRST_WARNING_DAYS,
  LAST_WARNING_DAYS,
  licenseExpiry,
  STOPPED_BY_LAPSE,
} from "./license-expiry";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2027-03-01T10:00:00.000Z");
const inDays = (n: number) => new Date(NOW + n * DAY).toISOString();

const active = (validUntil: string | null) => ({
  status: "active" as const,
  validUntil,
  enableEnterpriseFeatures: true,
});

describe("licenseExpiry", () => {
  it("says nothing more than 14 days out", () => {
    expect(licenseExpiry(active(inDays(15)), NOW)).toEqual({ stage: "none" });
    expect(licenseExpiry(active(inDays(14.01)), NOW).stage).toBe("none");
  });

  it("warns, hideably, from exactly 14 days until 3 days are left", () => {
    expect(licenseExpiry(active(inDays(14)), NOW)).toEqual({
      stage: "early",
      validUntil: inDays(14),
      daysLeft: 14,
    });
    expect(licenseExpiry(active(inDays(4)), NOW)).toMatchObject({
      stage: "early",
      daysLeft: 4,
    });
  });

  it("warns, unhideably, from 3 days, rounding a part day up", () => {
    expect(licenseExpiry(active(inDays(3)), NOW)).toMatchObject({
      stage: "late",
      daysLeft: 3,
    });
    expect(licenseExpiry(active(inDays(0.5)), NOW)).toMatchObject({
      stage: "late",
      daysLeft: 1,
    });
  });

  it("has ended from validUntil itself on", () => {
    expect(licenseExpiry(active(inDays(0)), NOW)).toEqual({
      stage: "ended",
      validUntil: inDays(0),
    });
    expect(licenseExpiry(active(inDays(-1)), NOW).stage).toBe("ended");
  });

  it("says nothing with no date, a refused or missing key, or Enterprise features off", () => {
    expect(licenseExpiry(active(null), NOW).stage).toBe("none");
    expect(
      licenseExpiry({ ...active(inDays(-1)), status: "invalid" }, NOW).stage,
    ).toBe("none");
    expect(
      licenseExpiry({ ...active(inDays(-1)), status: "inactive" }, NOW).stage,
    ).toBe("none");
    expect(
      licenseExpiry(
        { ...active(inDays(2)), enableEnterpriseFeatures: false },
        NOW,
      ).stage,
    ).toBe("none");
  });
});

/**
 * The thresholds are mirrored from the backend, which counts the daily
 * re-check and the `license-expiring` notices from the same two numbers. This
 * reads them back so the bar never appears on a different day from the email.
 */
describe("FIRST_WARNING_DAYS and LAST_WARNING_DAYS", () => {
  it("are the backend's license-expiry.ts numbers", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "../backend/src/enterprise/license/license-expiry.ts",
      ),
      "utf8",
    );
    const read = (name: string) =>
      Number(
        new RegExp(`export const ${name} = (\\d+);`).exec(source)?.[1],
      );

    expect(read("FIRST_WARNING_DAYS")).toBe(FIRST_WARNING_DAYS);
    expect(read("LAST_WARNING_DAYS")).toBe(LAST_WARNING_DAYS);
  });
});

describe("STOPPED_BY_LAPSE", () => {
  it("is the backend's paid-features.ts list, in its order", () => {
    const source = readFileSync(
      join(process.cwd(), "../backend/src/enterprise/license/paid-features.ts"),
      "utf8",
    );
    const body =
      /export const STOPPED_BY_LAPSE[^=]*=\s*\[([\s\S]*?)\];/.exec(source);
    expect(body).not.toBeNull();
    const backend = [...body![1].matchAll(/'([^']*)'/g)].map(([, item]) => item);

    expect(backend.length).toBeGreaterThan(0);
    expect([...STOPPED_BY_LAPSE]).toEqual(backend);
  });
});
