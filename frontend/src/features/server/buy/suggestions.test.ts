import { describe, expect, it } from "vitest";

import type {
  CatalogueLocation,
  CatalogueSize,
} from "@/lib/api/endpoints/bought-servers";

import { closestAndCheapest, sameSuggestion } from "./suggestions";

const place = (id: string, city: string): CatalogueLocation => ({
  id,
  city,
  country: "XX",
  latitude: 0,
  longitude: 0,
});

const SIN = place("sin", "Singapore");
const HEL = place("hel1", "Helsinki");
const NBG = place("nbg1", "Nuremberg");

/** Nearest first, as `byDistance` orders them for someone in Singapore. */
const ORDERED = [SIN, HEL, NBG].map((location) => ({ location }));

function size(
  id: string,
  family: CatalogueSize["family"],
  memoryGb: number,
  offers: Array<[string, number, boolean?]>,
): CatalogueSize {
  return {
    id,
    family,
    vcpus: 2,
    memoryGb,
    diskGb: 40,
    offers: offers.map(([locationId, monthly, available = true]) => ({
      locationId,
      monthly,
      available,
      backupsMonthly: 1,
    })),
  };
}

describe("closestAndCheapest", () => {
  it("suggests the nearest place that fits and the cheapest place anywhere that fits", () => {
    const sizes = [
      size("small", "shared", 2, [
        ["sin", 7],
        ["hel1", 4],
      ]),
      size("fits", "shared", 4, [
        ["sin", 12],
        ["hel1", 6],
        ["nbg1", 6],
      ]),
    ];

    const { closest, cheapest } = closestAndCheapest(ORDERED, sizes, 4);

    expect(closest).toMatchObject({
      location: SIN,
      size: { id: "fits" },
      monthly: 12,
    });
    // A tie on price goes to the nearer place.
    expect(cheapest).toMatchObject({
      location: HEL,
      size: { id: "fits" },
      monthly: 6,
    });
  });

  it("skips a place where nothing that fits can be bought now", () => {
    const sizes = [
      size("fits", "shared", 4, [
        ["sin", 12, false],
        ["hel1", 6],
      ]),
    ];

    const { closest, cheapest } = closestAndCheapest(ORDERED, sizes, 4);

    expect(closest?.location).toBe(HEL);
    expect(cheapest?.location).toBe(HEL);
  });

  it("never suggests an Arm size, which only runs images built for Arm", () => {
    const sizes = [
      size("arm", "arm", 4, [["sin", 3]]),
      size("standard", "shared", 4, [["sin", 9]]),
    ];

    const { closest, cheapest } = closestAndCheapest(ORDERED, sizes, 4);

    expect(closest?.size.id).toBe("standard");
    expect(cheapest?.size.id).toBe("standard");
  });

  it("picks the cheapest family that fits in a place, not only Standard", () => {
    const sizes = [
      size("standard", "shared", 4, [["sin", 15]]),
      size("performance", "amd", 4, [["sin", 11]]),
    ];

    expect(closestAndCheapest(ORDERED, sizes, 4).closest?.size.id).toBe(
      "performance",
    );
  });

  it("answers the same Server for both when the nearest is also the cheapest", () => {
    const sizes = [
      size("fits", "shared", 4, [
        ["sin", 5],
        ["hel1", 6],
      ]),
    ];

    const { closest, cheapest } = closestAndCheapest(ORDERED, sizes, 4);

    expect(closest && cheapest && sameSuggestion(closest, cheapest)).toBe(
      true,
    );
  });

  it("answers nothing when no size fits anywhere", () => {
    const sizes = [size("small", "shared", 2, [["sin", 4]])];

    expect(closestAndCheapest(ORDERED, sizes, 4)).toEqual({
      closest: null,
      cheapest: null,
    });
  });
});
