import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { TemplateSummary } from "@/lib/api/endpoints/templates";

import { TemplateCard } from "./template-card";
import { TemplateIntro } from "./template-intro";

afterEach(cleanup);

const LOGO = "data:image/svg+xml;base64,PHN2Zy8+";

const KUMA: TemplateSummary = {
  id: "uptime-kuma",
  revision: "c0ffee1",
  name: "Uptime Kuma",
  description: "A self-hosted monitoring tool.",
  version: "1.23",
  tags: ["monitoring"],
  links: {
    website: "https://uptime.kuma.pet",
    docs: "https://github.com/louislam/uptime-kuma/wiki",
    source: "https://github.com/louislam/uptime-kuma",
  },
  logo: LOGO,
  runsOn: ["server", "aws", "gcp"],
  page: null,
};

const PAGE =
  "https://octabyte-io.github.io/cg-templates/templates/uptime-kuma/";

const withLinks = (links: TemplateSummary["links"]): TemplateSummary => ({
  ...KUMA,
  links,
});

/** The link the name is, by its accessible name. */
const nameLink = (scope: HTMLElement, what: string) =>
  within(scope).getByRole("link", {
    name: `Uptime Kuma (${what}, opens in a new tab)`,
  });

/** The logo's link: the anchor around the `<img>`, hidden from the tree. */
const logoLink = (scope: HTMLElement) =>
  scope.querySelector("img")?.closest("a") ?? null;

const surfaces = {
  card: (template: TemplateSummary) => {
    render(<TemplateCard template={template} />);
    return screen.getByRole("article", { name: "Uptime Kuma" });
  },
  intro: (template: TemplateSummary) => {
    render(
      <TemplateIntro
        template={template}
        fallbackName="uptime-kuma"
        pending={false}
      />,
    );
    return screen.getByRole("banner");
  },
};

describe.each(Object.entries(surfaces))(
  "A Template's name and logo on its %s",
  (_, show) => {
    it("open its cg-templates page in a new tab, the logo out of the tab order", () => {
      const scope = show({ ...KUMA, page: PAGE });

      const link = nameLink(scope, "template page");
      expect(link.getAttribute("href")).toBe(PAGE);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");

      const logo = logoLink(scope);
      expect(logo?.getAttribute("href")).toBe(PAGE);
      expect(logo?.getAttribute("target")).toBe("_blank");
      expect(logo?.getAttribute("rel")).toContain("noopener");
      expect(logo?.getAttribute("tabindex")).toBe("-1");
      expect(logo?.getAttribute("aria-hidden")).toBe("true");
    });

    it("open its website when the catalogue gives no page (a mirror's)", () => {
      const scope = show(KUMA);

      const link = nameLink(scope, "website");
      expect(link.getAttribute("href")).toBe("https://uptime.kuma.pet");
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");

      const logo = logoLink(scope);
      expect(logo?.getAttribute("href")).toBe("https://uptime.kuma.pet");
      expect(logo?.getAttribute("target")).toBe("_blank");
      expect(logo?.getAttribute("rel")).toContain("noopener");
      expect(logo?.getAttribute("tabindex")).toBe("-1");
      expect(logo?.getAttribute("aria-hidden")).toBe("true");
    });

    it("open its docs when it has no website", () => {
      const scope = show(withLinks({ docs: KUMA.links.docs }));

      expect(nameLink(scope, "docs").getAttribute("href")).toBe(
        KUMA.links.docs,
      );
      expect(logoLink(scope)?.getAttribute("href")).toBe(KUMA.links.docs);
    });

    it("open its source when it has neither", () => {
      const scope = show(withLinks({ source: KUMA.links.source }));

      expect(nameLink(scope, "source code").getAttribute("href")).toBe(
        KUMA.links.source,
      );
      expect(logoLink(scope)?.getAttribute("href")).toBe(KUMA.links.source);
    });

    it("are plain when it has no links at all", () => {
      const scope = show(withLinks({}));

      expect(within(scope).getByText("Uptime Kuma").closest("a")).toBeNull();
      expect(logoLink(scope)).toBeNull();
      expect(
        within(scope)
          .queryAllByRole("link")
          .filter((link) => link.getAttribute("target") === "_blank"),
      ).toEqual([]);
    });
  },
);
