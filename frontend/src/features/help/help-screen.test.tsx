import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HelpScreen } from "./help-screen";

afterEach(cleanup);

describe("HelpScreen", () => {
  it("names the support address as a mail link", () => {
    render(<HelpScreen />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Help & support" }),
    ).toBeTruthy();
    const email = screen.getByRole("link", { name: "Email support" });
    expect(email.getAttribute("href")).toBe("mailto:support@octabyte.io");
    expect(
      screen
        .getByRole("link", { name: "support@octabyte.io" })
        .getAttribute("href"),
    ).toBe("mailto:support@octabyte.io");
  });

  it("opens the user guide in a new tab", () => {
    render(<HelpScreen />);
    const guides = screen
      .getByRole("heading", { name: "Guides" })
      .closest("section");
    expect(guides).toBeTruthy();
    const guide = within(guides as HTMLElement).getByRole("link", {
      name: /User guide/,
    });
    expect(guide.getAttribute("href")).toBe(
      "https://cloudgate.octabyte.io/docs/guide/get-started",
    );
    expect(guide.getAttribute("target")).toBe("_blank");
    expect(guide.getAttribute("rel")).toContain("noopener");
  });
});
