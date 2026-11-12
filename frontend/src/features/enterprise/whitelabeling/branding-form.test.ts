import { describe, expect, it } from "vitest";

import { normalizeBranding } from "@/lib/branding/branding";

import { brandingPatch, brandingValues } from "./branding-form";

const STORED = normalizeBranding({
  appName: "Acme Deploy",
  logoUrl: "https://cdn.example.test/acme.svg",
  faviconUrl: null,
  primaryColor: "#1f6feb",
  accentColor: null,
  customCss: null,
  errorPages: {
    notFoundMessage: "Nothing at this address.",
    serverErrorMessage: null,
    supportUrl: "https://help.example.test",
  },
});

/**
 * **A save sends what changed, and an emptied field clears**.
 * `PATCH /settings/whitelabeling` merges — an absent key is kept, `null`
 * clears — so a card that sent every field would overwrite whatever another
 * card, or another person, had saved in between.
 */
describe("brandingPatch", () => {
  it("sends nothing for fields left as they were", () => {
    expect(
      brandingPatch(STORED, brandingValues(STORED, ["appName", "logoUrl"])),
    ).toEqual({});
  });

  it("sends a changed field, trimmed", () => {
    expect(
      brandingPatch(STORED, { appName: "  Acme Cloud ", logoUrl: STORED.logoUrl! }),
    ).toEqual({ appName: "Acme Cloud" });
  });

  it("sends an emptied field as null, which clears it", () => {
    expect(brandingPatch(STORED, { appName: "", primaryColor: "   " })).toEqual({
      appName: null,
      primaryColor: null,
    });
  });

  it("nests the error-page fields under errorPages, and only the ones that changed", () => {
    expect(
      brandingPatch(STORED, {
        notFoundMessage: "",
        serverErrorMessage: "Something broke.",
        supportUrl: "https://help.example.test",
      }),
    ).toEqual({
      errorPages: { notFoundMessage: null, serverErrorMessage: "Something broke." },
    });
  });

  it("keeps custom CSS as written rather than trimming it", () => {
    expect(brandingPatch(STORED, { customCss: "a { color: red; }\n" })).toEqual({
      customCss: "a { color: red; }\n",
    });
  });
});

describe("brandingValues", () => {
  it("starts an unset field empty and a set one at its stored value", () => {
    expect(
      brandingValues(STORED, ["appName", "faviconUrl", "supportUrl"]),
    ).toEqual({
      appName: "Acme Deploy",
      faviconUrl: "",
      supportUrl: "https://help.example.test",
    });
  });
});
