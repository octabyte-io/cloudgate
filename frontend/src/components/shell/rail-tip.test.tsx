import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RailLink } from "./rail-item";

/**
 * The icon strip names its rows on hover and focus.
 *
 * Collapsed, a row's label is `sr-only`, so a screen reader was always fine
 * and a sighted operator had a rocket, a globe and a book to tell apart. The
 * tooltip is for the second one only: it must not become part of the link's
 * name, or the first one hears "Deployments Deployments".
 */

function collapse(collapsed: boolean) {
  if (collapsed) document.documentElement.setAttribute("data-rail", "collapsed");
  else document.documentElement.removeAttribute("data-rail");
}

function renderDeployments() {
  render(
    <RailLink
      href="/deployments"
      icon="rocket"
      label="Deployments"
      current={false}
    />,
  );
  return screen.getByRole("link");
}

afterEach(() => {
  cleanup();
  collapse(false);
});

describe("a rail row on the icon strip", () => {
  it("shows its label in a tooltip when it takes focus", async () => {
    collapse(true);
    const link = renderDeployments();

    fireEvent.focus(link);

    expect((await screen.findByRole("tooltip")).textContent).toBe("Deployments");
  });

  it("keeps exactly one label as its accessible name", async () => {
    collapse(true);
    const link = renderDeployments();

    fireEvent.focus(link);
    await screen.findByRole("tooltip");

    expect(screen.getByRole("link", { name: "Deployments" })).toBe(link);
    expect(link.textContent).toBe("Deployments");
  });
});

describe("a rail row in the expanded rail", () => {
  it("shows no tooltip — its label is already on screen", async () => {
    collapse(false);
    const link = renderDeployments();

    fireEvent.focus(link);
    // Past the point where the collapsed case has already opened.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
