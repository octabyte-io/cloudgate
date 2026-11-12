import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const trustedOrigins = vi.hoisted(() => vi.fn());
const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// Two system boundaries, both replaced rather than driven: the HTTP client, and
// better-auth's session store. Nothing of this component's own is doubled.
vi.mock("@/lib/api/endpoints/sso", async (original) => {
  const actual = await original<typeof import("@/lib/api/endpoints/sso")>();
  return { ...actual, ssoApi: { ...actual.ssoApi, trustedOrigins } };
});

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { TrustedOriginsCard } = await import("./trusted-origins-card");

afterEach(() => {
  cleanup();
  trustedOrigins.mockReset();
  useActiveOrganizationId.mockReset();
});

/**
 * The mirror of `local-shell-card.test.tsx`'s layout pin.
 *
 * These two are the only `items-end` wrap rows in the tree that held a hint
 * inside the row, and one fix covered both — here the bottom-aligned item was
 * the submit button rather than a second field, so *Trust it* sat a line below
 * the control it submits at every width. That fix's triage claimed this row was
 * hint-free, which is what later made a reviewer read the second file as scope
 * creep; the row does carry a hint, and that was settled later. Nothing
 * asserted the classes on either card until then.
 */

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function card(): Promise<HTMLElement> {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  trustedOrigins.mockResolvedValue(["https://login.example.com"]);
  render(withQuery(<TrustedOriginsCard />));
  // The card holds a skeleton until the list answers, so the form is awaited
  // rather than queried — `SectionPending` renders no fields at all.
  return await screen.findByLabelText("Add an origin");
}

describe("TrustedOriginsCard", () => {
  it("starts the origin field at the top of its row and keeps the submit button out of it", async () => {
    const input = await card();
    // The `Field` root carries its own `className`, and the row is its parent —
    // the same shape `local-shell-card.test.tsx` asserts, without guessing at a
    // depth with `closest`.
    const field = input.closest('[class*="min-w-56"]');
    const row = field?.parentElement;

    expect(field).not.toBeNull();
    expect(row?.className).toContain("items-start");
    expect(row?.className).not.toContain("items-end");
    expect(
      row?.contains(screen.getByRole("button", { name: "Trust it" })),
    ).toBe(false);
  });

  it("keeps the hint inside the row, which is what makes the alignment matter", async () => {
    // The fix's triage listed this row among the "hint-free" ones and concluded the
    // local-shell card was the only row of this shape. It was not, and the hint
    // is the whole reason `items-end` misaligned the button: without it both
    // items are the same height and the bug does not exist.
    await card();

    expect(document.body.textContent).toContain(
      "An origin — scheme and host, e.g. https://login.example.com.",
    );
  });
});
