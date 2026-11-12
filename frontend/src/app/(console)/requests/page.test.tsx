import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const reader = vi.hoisted(() => ({ hosted: false, operator: false }));
vi.mock("@/features/operator/use-operator", () => ({
  useIsOperator: () => ({ ...reader, pending: false }),
}));
// The screen's own reads are its tests' business; here it only has to mount.
vi.mock("@/features/requests/requests-screen", () => ({
  RequestsScreen: () => <p>the Requests screen</p>,
}));

const { default: Page } = await import("./page");

afterEach(() => {
  cleanup();
  reader.hosted = false;
  reader.operator = false;
});

/**
 * Requests reads each Server's own access log, so its address loads for every
 * reader, the Hosted instance's customers included.
 */
describe("the Requests route", () => {
  it("loads on a Self-hosted instance", () => {
    render(<Page />);
    expect(screen.getByText("the Requests screen")).toBeTruthy();
  });

  it("loads for a customer on the Hosted instance", () => {
    reader.hosted = true;
    render(<Page />);
    expect(screen.getByText("the Requests screen")).toBeTruthy();
    expect(
      screen.queryByText(
        "This page is for the owners and admins of the Instance organization.",
      ),
    ).toBeNull();
  });
});
