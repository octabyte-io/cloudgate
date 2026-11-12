import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Avatar } from "./avatar";

afterEach(cleanup);

const URL = "https://avatars.example.com/u/9919?v=4";

/** The avatar's own box: it is `aria-hidden`, so there is no role to find it by. */
function box(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-slot="avatar"]');
  if (!found) throw new Error("no avatar rendered");
  return found;
}

describe("Avatar", () => {
  it("renders the image when the person has an avatar URL", () => {
    const { container } = render(
      <Avatar person={{ name: "Ursa", lastName: "Ownerton", email: "u@example.com", image: URL }} />,
    );

    const img = box(container).querySelector("img");
    expect(img?.getAttribute("src")).toBe(URL);
    // Decoration: the name is always beside it, so it does not say it again.
    expect(img?.getAttribute("alt")).toBe("");
    expect(box(container).getAttribute("aria-hidden")).toBe("true");
  });

  it("falls back to the initials when the image fails to load", () => {
    const { container } = render(
      <Avatar person={{ name: "Ursa", lastName: "Ownerton", email: "u@example.com", image: URL }} />,
    );

    fireEvent.error(box(container).querySelector("img")!);

    expect(box(container).querySelector("img")).toBeNull();
    expect(box(container).textContent).toBe("UO");
  });

  it("tries a new address again after an old one failed", () => {
    const person = { name: "Ursa", lastName: "", email: "u@example.com" };
    const { container, rerender } = render(<Avatar person={{ ...person, image: URL }} />);
    fireEvent.error(box(container).querySelector("img")!);
    expect(box(container).textContent).toBe("U");

    rerender(<Avatar person={{ ...person, image: `${URL}&retry` }} />);

    expect(box(container).querySelector("img")?.getAttribute("src")).toBe(`${URL}&retry`);
  });

  it("shows the person glyph when there is neither an image nor a name", () => {
    const { container } = render(
      <Avatar person={{ name: " ", lastName: null, email: "u@example.com", image: null }} />,
    );

    expect(box(container).querySelector("img")).toBeNull();
    expect(box(container).querySelector("svg")).not.toBeNull();
    // Not a letter of the address: "U" for u@example.com reads as a monogram.
    expect(box(container).textContent).toBe("");
  });
});
