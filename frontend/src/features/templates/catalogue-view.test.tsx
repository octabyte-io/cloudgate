import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type {
  CatalogueCopy,
  TemplateSummary,
} from "@/lib/api/endpoints/templates";

import { CatalogueView } from "./catalogue-view";

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
};

const GHOST: TemplateSummary = {
  id: "ghost",
  revision: "beef",
  name: "Ghost",
  description: "A publishing platform for blogs and newsletters.",
  version: null,
  tags: ["blog", "cms"],
  links: {},
  logo: LOGO,
  runsOn: ["server"],
};

const FRESH: CatalogueCopy = {
  fetchedAt: new Date().toISOString(),
  checkedAt: new Date().toISOString(),
  problem: null,
};

/** The view with its search, tags and page held as the screen holds them. */
function Harness({
  templates,
  copy = FRESH,
  error = null,
}: {
  templates: TemplateSummary[];
  copy?: CatalogueCopy;
  error?: unknown;
}) {
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  return (
    <CatalogueView
      templates={templates}
      copy={copy}
      pending={false}
      error={error}
      onRetry={() => {}}
      query={query}
      onQuery={setQuery}
      tags={tags}
      onTags={setTags}
      page={page}
      onPage={setPage}
    />
  );
}

const search = () =>
  screen.getByRole("searchbox", { name: "Search templates" });
const tagsButton = () => screen.getByRole("button", { name: /Filter by tag/ });
const cards = () =>
  within(screen.getByRole("group", { name: "Templates" })).getAllByRole(
    "article",
  );

describe("CatalogueView", () => {
  it("shows each Template's logo, name, version, description, where it runs, tags, links and its setup", () => {
    render(<Harness templates={[KUMA]} />);

    const card = screen.getByRole("article", { name: "Uptime Kuma" });
    expect(card.querySelector("img")?.getAttribute("src")).toBe(LOGO);
    expect(within(card).getByText("1.23")).toBeTruthy();
    expect(
      within(card).getByText("A self-hosted monitoring tool."),
    ).toBeTruthy();
    expect(
      within(card).getByText("Runs on a Server or in a cloud"),
    ).toBeTruthy();
    expect(within(card).getByText("monitoring")).toBeTruthy();
    const links = Object.fromEntries(
      within(card)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    );
    expect(links).toEqual({
      "Set up": "/templates?template=uptime-kuma",
      Website: "https://uptime.kuma.pet",
      Docs: "https://github.com/louislam/uptime-kuma/wiki",
      Source: "https://github.com/louislam/uptime-kuma",
    });
  });

  it("marks a Template no cloud can make as running on a Server", () => {
    render(<Harness templates={[GHOST]} />);

    const card = screen.getByRole("article", { name: "Ghost" });
    expect(within(card).getByText("Runs on a Server")).toBeTruthy();
    // Its setup form, and no links of its own.
    expect(
      within(card)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/templates?template=ghost"]);
  });

  it("searches by name", () => {
    render(<Harness templates={[KUMA, GHOST]} />);

    fireEvent.change(search(), { target: { value: "ghost" } });

    expect(cards().map((card) => card.getAttribute("aria-label"))).toEqual([
      "Ghost",
    ]);
  });

  it("filters by tag", async () => {
    render(<Harness templates={[KUMA, GHOST]} />);

    fireEvent.click(tagsButton());
    fireEvent.click(await screen.findByRole("checkbox", { name: /blog/ }));

    expect(cards().map((card) => card.getAttribute("aria-label"))).toEqual([
      "Ghost",
    ]);
  });

  it("says when the copy shown is an older one, why, and how old", () => {
    const fetchedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    render(
      <Harness
        templates={[KUMA]}
        copy={{
          fetchedAt,
          checkedAt: new Date().toISOString(),
          problem:
            "The template catalogue at github.com could not be reached: fetch failed",
        }}
      />,
    );

    const note = screen.getByRole("status");
    expect(note.textContent).toContain(
      "The template catalogue at github.com could not be reached",
    );
    expect(note.textContent).toContain("3 hours ago");
  });

  it("says nothing about the copy when the last check was fine", () => {
    render(<Harness templates={[KUMA]} />);

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says templates are off in the backend's own words", () => {
    const sentence =
      "Templates are turned off on this instance: CLOUDGATE_TEMPLATES_URL is off.";
    render(
      <Harness
        templates={[]}
        error={
          new ApiError(503, sentence, {
            code: "TEMPLATES_CATALOGUE_NOT_CONFIGURED",
          })
        }
      />,
    );

    expect(screen.getByText("Templates are off")).toBeTruthy();
    expect(screen.getByText(sentence)).toBeTruthy();
  });

  it("turns search and Tags off when the catalogue holds nothing", () => {
    render(<Harness templates={[]} />);
    expect(search().hasAttribute("disabled")).toBe(true);
    expect(tagsButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("turns them off when the catalogue could not be read", () => {
    render(<Harness templates={[]} error={new Error("unreachable")} />);
    expect(search().hasAttribute("disabled")).toBe(true);
    expect(tagsButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("leaves them live over a catalogue with templates in it", () => {
    render(<Harness templates={[KUMA]} />);
    expect(search().hasAttribute("disabled")).toBe(false);
    expect(tagsButton().getAttribute("aria-disabled")).not.toBe("true");
  });
});
