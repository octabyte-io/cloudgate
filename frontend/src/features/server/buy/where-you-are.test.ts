import { describe, expect, it } from "vitest";

import {
  byDistance,
  distanceKm,
  guessFromTimeZone,
  roughKm,
} from "./where-you-are";

const FALKENSTEIN = { id: "fsn1", latitude: 50.47612, longitude: 12.370071 };
const ASHBURN = { id: "ash", latitude: 39.045821, longitude: -77.487073 };
const SINGAPORE = { id: "sin", latitude: 1.283333, longitude: 103.833333 };

describe("guessFromTimeZone", () => {
  it("places a known time zone at its city", () => {
    expect(guessFromTimeZone("Europe/Berlin")).toEqual({
      latitude: 52.5,
      longitude: 13.4,
      near: "Berlin",
    });
  });

  it("places an unknown zone by its region and the UTC offset given", () => {
    // UTC+9 → 135° east; Asia → 30° north.
    expect(guessFromTimeZone("Asia/Nowhere", 9 * 60)).toEqual({
      latitude: 30,
      longitude: 135,
      near: null,
    });
  });
});

describe("distanceKm", () => {
  it("measures London to Paris along the great circle", () => {
    // About 344 km, the figure every atlas gives.
    const km = distanceKm(
      { latitude: 51.5074, longitude: -0.1278 },
      { latitude: 48.8566, longitude: 2.3522 },
    );
    expect(km).toBeGreaterThan(335);
    expect(km).toBeLessThan(350);
  });
});

describe("roughKm", () => {
  it("rounds to 50 km under 500, and to 100 km above", () => {
    expect(roughKm(262)).toBe(250);
    expect(roughKm(1234)).toBe(1200);
  });
});

describe("byDistance", () => {
  it("sorts nearest first from New York", () => {
    const me = guessFromTimeZone("America/New_York");
    expect(
      byDistance([SINGAPORE, FALKENSTEIN, ASHBURN], me).map(
        (entry) => entry.location.id,
      ),
    ).toEqual(["ash", "fsn1", "sin"]);
  });

  it("keeps the given order with no position", () => {
    expect(
      byDistance([SINGAPORE, FALKENSTEIN], null).map((entry) => [
        entry.location.id,
        entry.km,
      ]),
    ).toEqual([
      ["sin", null],
      ["fsn1", null],
    ]);
  });
});
