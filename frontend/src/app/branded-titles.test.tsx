import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two pages the branding's title template cannot reach.
 *
 * `(console)/layout.tsx` sets `"%s · <app name>"`, and a template applies to
 * the segments *under* its layout — not to a page in its own segment, which is
 * where `/` sits, and not to the root `not-found`, which sits under no layout
 * but the root's. Both were titled `… · Cloudgate` on a rebranded instance.
 */

// Outside a request there is nothing for `connection()` to wait on.
vi.mock("next/server", () => ({ connection: async () => {} }));

const BRANDED = {
  appName: "Acme Deploy",
  logoUrl: "https://cdn.example.test/acme.svg",
  faviconUrl: null,
  primaryColor: null,
  accentColor: null,
  customCss: ".door { display: none; }",
  errorPages: {
    notFoundMessage: "Nothing lives at this address.",
    serverErrorMessage: null,
    supportUrl: "https://help.example.test",
  },
};

/** `GET /settings/whitelabeling` at the network, the one boundary here. */
function answer(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.head.querySelectorAll("title").forEach((node) => node.remove());
});

describe("Organization home's generateMetadata", () => {
  it("titles / with the instance's name", async () => {
    answer(BRANDED);
    const { generateMetadata } = await import("./(console)/page");

    expect((await generateMetadata()).title).toEqual({
      absolute: "Organization home · Acme Deploy",
    });
  });

  it("titles / with Cloudgate's name on an unbranded instance", async () => {
    answer({});
    const { generateMetadata } = await import("./(console)/page");

    expect((await generateMetadata()).title).toEqual({
      absolute: "Organization home · Cloudgate",
    });
  });
});

describe("the root NotFound", () => {
  async function renderNotFound() {
    const { default: NotFound } = await import("./not-found");
    const element = await NotFound();
    render(
      <QueryClientProvider client={new QueryClient()}>
        {element}
      </QueryClientProvider>,
    );
  }

  it("takes the instance's name, marks and error-page copy, and not its custom CSS", async () => {
    answer(BRANDED);
    await renderNotFound();

    expect(document.title).toBe("Not found · Acme Deploy");
    expect(screen.getByText("Acme Deploy")).toBeTruthy();
    expect(
      document.querySelector('img[src="https://cdn.example.test/acme.svg"]'),
    ).not.toBeNull();
    expect(screen.getByText(/Nothing lives at this address\./)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "contact support" }).getAttribute("href"),
    ).toBe("https://help.example.test");
    expect(
      screen.getByRole("link", { name: "Go to Acme Deploy" }).getAttribute("href"),
    ).toBe("/");
    // No session is known here, so this is a door: the operator's stylesheet
    // does not load on it.
    const styles = [...document.querySelectorAll("style")].map(
      (node) => node.textContent,
    );
    expect(styles.join("")).not.toContain(".door");
  });

  it("reads as it always did on an unbranded instance", async () => {
    answer({});
    await renderNotFound();

    expect(document.title).toBe("Not found · Cloudgate");
    expect(screen.getByText("cloudgate")).toBeTruthy();
    expect(
      screen.getByText(/The address may be mistyped, or the page may have moved\./),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "contact support" })).toBeNull();
    expect(screen.getByRole("link", { name: "Go to Cloudgate" })).toBeTruthy();
  });
});
