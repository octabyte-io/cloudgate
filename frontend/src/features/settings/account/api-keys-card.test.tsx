import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const keys = vi.hoisted(() => ({ data: [] as unknown[] }));

vi.mock("./use-account", () => ({
  useApiKeys: () => ({ data: keys.data, isPending: false, error: null }),
  useCreateApiKey: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useDeleteApiKey: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

const { ApiKeysCard } = await import("./api-keys-card");

afterEach(cleanup);

/**
 * The card names the credential by what it is — a personal key — and
 * says, before anyone creates one, how much it carries.
 */
describe("ApiKeysCard", () => {
  it("is titled Personal keys and says a key acts as you", () => {
    render(<ApiKeysCard />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Personal keys" }),
    ).toBeDefined();
    expect(
      screen.getByText(
        "For scripts and CI. A personal key acts as you: everything you can do, in your default Organization.",
      ),
    ).toBeDefined();
  });

  it("says Never used for a key nothing has used, as an Agent key does", () => {
    keys.data = [
      {
        id: "k1",
        name: "CI",
        start: "cg_ab",
        prefix: null,
        userId: "u1",
        enabled: true,
        expiresAt: null,
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        lastRequest: null,
        requestCount: 0,
        metadata: null,
      },
    ];
    render(<ApiKeysCard />);
    expect(screen.getByText("Never used")).toBeDefined();
    keys.data = [];
  });
});
