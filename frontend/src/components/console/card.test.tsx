import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Card } from "./card";

afterEach(cleanup);

/**
 * A card header's actions go under its title when the two do not fit side by
 * side. jsdom has no layout, so this pins the flex structure that
 * decides it: a wrapping row, a title block that asks for a width of its own
 * rather than shrinking to nothing, and actions that may wrap among themselves.
 */
describe("Card.Header", () => {
  it("lets its actions wrap under the title instead of squeezing it", () => {
    render(
      <Card>
        <Card.Header
          title="Deployments"
          sub="3 attempts recorded."
          actions={<button type="button">Remove containers</button>}
        />
      </Card>,
    );

    const title = screen.getByRole("heading", { name: "Deployments" });
    const row = title.closest('[data-slot="card-header"]')!;
    expect(row.className).toMatch(/\bflex-wrap\b/);
    expect(title.parentElement!.className).toMatch(/\bbasis-60\b/);
    expect(title.parentElement!.className).not.toMatch(/\bflex-1\b/);

    const actions = screen.getByRole("button", { name: "Remove containers" }).parentElement!;
    expect(actions.className).toMatch(/\bflex-wrap\b/);
    expect(actions.className).not.toMatch(/\bflex-none\b/);
  });
});
