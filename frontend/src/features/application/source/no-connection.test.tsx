import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { NoConnection } from "./no-connection";
import { GIT_PROVIDERS } from "./providers";

afterEach(cleanup);

/**
 * The note for a provider with no connection leads to the screen where one is
 * made.
 *
 * It said "Connect GitHub under Settings" as plain text, on an Application page
 * whose rail has no Settings entry. The census in
 * `features/settings-pointer-links.test.ts` keeps every such sentence linked;
 * this proves where this one goes, for each of the four providers.
 */
describe.each(Object.values(GIT_PROVIDERS))("NoConnection for $label", (spec) => {
  it("links Settings → Git providers to /settings/git-providers", () => {
    render(<NoConnection spec={spec} />);

    const link = screen.getByRole("link", { name: "Settings → Git providers" });
    expect(link.getAttribute("href")).toBe("/settings/git-providers");
    expect(link.closest("p")?.textContent).toContain(`Connect ${spec.label}`);
  });
});
