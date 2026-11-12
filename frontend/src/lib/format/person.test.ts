import { describe, expect, it } from "vitest";

import { fullName, personInitials, personName } from "./person";

describe("personName", () => {
  it("puts the last name after the first", () => {
    expect(personName({ name: "Ursa", lastName: "Ownerton", email: "u@example.com" })).toBe(
      "Ursa Ownerton",
    );
  });

  it("reads firstName where the API spells it that way", () => {
    expect(
      personName({ firstName: "Ursa", lastName: "Ownerton", email: "u@example.com" }),
    ).toBe("Ursa Ownerton");
  });

  it("falls back to the address when no name is set, blank included", () => {
    expect(personName({ name: "  ", lastName: "", email: "u@example.com" })).toBe(
      "u@example.com",
    );
    expect(personName({ email: "u@example.com" })).toBe("u@example.com");
  });

  it("uses a last name alone when that is all there is", () => {
    expect(personName({ name: "", lastName: "Ownerton", email: "u@example.com" })).toBe(
      "Ownerton",
    );
  });
});

describe("fullName", () => {
  it("is null rather than the address when there is no name", () => {
    expect(fullName({ firstName: "", lastName: "", email: "u@example.com" })).toBeNull();
  });
});

describe("personInitials", () => {
  it("takes the first letter of each name", () => {
    expect(personInitials({ name: "ursa", lastName: "Ownerton", email: "u@example.com" })).toBe(
      "UO",
    );
  });

  it("is null with no name, so the caller shows the glyph", () => {
    expect(personInitials({ name: null, email: "u@example.com" })).toBeNull();
  });
});
