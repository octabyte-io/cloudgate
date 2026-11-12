import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const reader = vi.hoisted(() => ({
  hosted: false,
  operator: false,
  pending: false,
}));
vi.mock("./use-operator", () => ({ useIsOperator: () => ({ ...reader }) }));

const { PlatformHostGate } = await import("./platform-host-gate");

afterEach(() => {
  cleanup();
  reader.hosted = false;
  reader.operator = false;
  reader.pending = false;
});

const SENTENCE =
  "This page is for the owners and admins of the Instance organization.";

/** Stands in for a page's cards; rendering it is what would start their fetches. */
const page = vi.fn(() => <p>the page</p>);
function Page() {
  return page();
}

function mount() {
  page.mockClear();
  return render(
    <PlatformHostGate>
      <Page />
    </PlatformHostGate>,
  );
}

/**
 * A platform host's page opened by its URL. On the Hosted instance a customer
 * gets one plain sentence instead of a screen of disabled cards, and nothing
 * underneath it is mounted, so nothing is fetched (ADR-0053).
 */
describe("PlatformHostGate", () => {
  it("renders the page on a Self-hosted instance", () => {
    mount();
    expect(screen.getByText("the page")).toBeTruthy();
    expect(screen.queryByText(SENTENCE)).toBeNull();
  });

  it("renders the page for an Operator on the Hosted instance", () => {
    reader.hosted = true;
    reader.operator = true;
    mount();
    expect(screen.getByText("the page")).toBeTruthy();
  });

  it("says who the page is for, and mounts none of it, for a customer on the Hosted instance", () => {
    reader.hosted = true;
    mount();
    expect(screen.getByText(SENTENCE)).toBeTruthy();
    expect(page).not.toHaveBeenCalled();
  });

  it("renders neither the page nor the sentence while the answer is on its way", () => {
    reader.pending = true;
    mount();
    expect(page).not.toHaveBeenCalled();
    expect(screen.queryByText(SENTENCE)).toBeNull();
  });
});
