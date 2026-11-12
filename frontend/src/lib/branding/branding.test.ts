import { describe, expect, it, vi } from "vitest";

import {
  brandingCss,
  brandingMetadata,
  normalizeBranding,
  UNBRANDED,
} from "./branding";
import { fetchBranding } from "./fetch-branding";

/** What `GET /settings/whitelabeling` answers with every field set. */
const WIRE = {
  appName: "Acme Deploy",
  logoUrl: "https://cdn.example.test/acme.svg",
  faviconUrl: "/acme.ico",
  primaryColor: "#1f6feb",
  accentColor: null,
  customCss: ".masthead { border-bottom: 2px solid red; }",
  errorPages: {
    notFoundMessage: "Nothing at this address.",
    serverErrorMessage: null,
    supportUrl: "https://help.example.test",
  },
};

/**
 * **The stored branding reaches `<head>`**: the sign-in screen's title
 * and favicon are what `getWhitelabelingConfig`'s docblock names as the reason
 * the read is public, and nothing in the console consumed it.
 */
describe("brandingMetadata", () => {
  it("titles every page after the instance and points the favicon at its icon", () => {
    expect(brandingMetadata(normalizeBranding(WIRE))).toEqual({
      title: { default: "Acme Deploy", template: "%s · Acme Deploy" },
      icons: { icon: "/acme.ico" },
    });
  });

  it("declares nothing for an unbranded instance, so the root layout's Cloudgate stands", () => {
    expect(brandingMetadata(UNBRANDED)).toEqual({});
  });
});

/**
 * **A value the backend should have refused is not rendered** — the read is
 * public and lands in `<link href>`, `<img src>` and a `<style>` body on a page
 * that takes a password.
 */
describe("normalizeBranding", () => {
  it("drops a script URL, a colour that is not hex and CSS that would close its style element", () => {
    const branding = normalizeBranding({
      ...WIRE,
      logoUrl: "javascript:alert(1)",
      faviconUrl: "data:image/png;base64,AAAA",
      primaryColor: "red;} body{display:none",
      customCss: "a{}</style><script>alert(1)</script>",
      errorPages: { supportUrl: "javascript:void 0" },
    });

    expect(branding.logoUrl).toBeNull();
    expect(branding.faviconUrl).toBeNull();
    expect(branding.primaryColor).toBeNull();
    expect(branding.customCss).toBeNull();
    expect(branding.errorPages.supportUrl).toBeNull();
    expect(branding.appName).toBe("Acme Deploy");
  });

  it("reads an empty or whitespace name as unset", () => {
    expect(normalizeBranding({ ...WIRE, appName: "  " }).appName).toBeNull();
  });

  it("reads a missing or malformed answer as unbranded", () => {
    expect(normalizeBranding(undefined)).toEqual(UNBRANDED);
    expect(normalizeBranding("nope")).toEqual(UNBRANDED);
  });
});

/**
 * **Custom CSS is the console's, not the door's.** The auth layout asks for the
 * colours only; the console layout asks for both.
 */
describe("brandingCss", () => {
  it("includes the operator's CSS only when the caller asks for it", () => {
    const branding = normalizeBranding(WIRE);

    expect(brandingCss(branding, { customCss: true })).toContain(
      ".masthead { border-bottom: 2px solid red; }",
    );
    expect(brandingCss(branding, { customCss: false })).not.toContain(
      ".masthead",
    );
  });

  it("uses the primary colour for brand text when no accent is set", () => {
    const css = brandingCss(normalizeBranding(WIRE), { customCss: false });

    expect(css).toContain("--brand:#1f6feb;");
    expect(css).toContain("--brand-tx:#1f6feb;");
  });

  it("is empty for an unbranded instance", () => {
    expect(brandingCss(UNBRANDED, { customCss: true })).toBe("");
  });
});

describe("fetchBranding", () => {
  it("returns the backend's branding", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(WIRE));

    const branding = await fetchBranding(fetchImpl);

    expect(branding.appName).toBe("Acme Deploy");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(
      /\/settings\/whitelabeling$/,
    );
  });

  it("draws the unbranded door rather than failing when the backend is down or refuses", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const refused = vi.fn(async () => new Response("", { status: 500 }));

    expect(await fetchBranding(down as typeof fetch)).toEqual(UNBRANDED);
    expect(await fetchBranding(refused as typeof fetch)).toEqual(UNBRANDED);
  });
});
