import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DisableTwoFactorModal } from "./disable-two-factor-modal";

afterEach(cleanup);

/**
 * What the dialog says is deleted.
 *
 * It said "all ten backup codes", and each code works once — after the first
 * backup-code sign-in there are nine, and the console does not know how many
 * are left. The sentence has to be true whatever has been spent, so it names
 * no count at all.
 */
describe("DisableTwoFactorModal", () => {
  it("says the remaining backup codes are deleted, and states no count", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DisableTwoFactorModal open onOpenChange={() => {}} />
      </QueryClientProvider>,
    );

    const warning = screen.getByText(/backup codes are/);
    expect(warning.textContent).toContain(
      "The authenticator secret and your remaining backup codes are deleted.",
    );
    expect(warning.textContent).not.toMatch(/\bten\b|\b10\b/);
  });
});
