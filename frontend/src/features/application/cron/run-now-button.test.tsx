import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Deployment } from "@/lib/api/endpoints/deployments";
import { APPLICATION_DEPLOY_REFUSAL } from "@/lib/auth/application-refusals";

let allowed = true;
const mutateAsync = vi.fn();

vi.mock("@/lib/auth/use-permission", () => ({
  usePermission: () => ({ allowed }),
}));
vi.mock("./use-run-cron-service", () => ({
  useRunCronService: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn() },
}));

const { RunNowButton, WAITING_FOR_FIRST_BUILD } = await import(
  "./run-now-button"
);

afterEach(cleanup);
beforeEach(() => {
  allowed = true;
  mutateAsync.mockReset();
});

const button = () => screen.getByRole("button", { name: "Run now" });

/** Run now on a Cron service's Timetable card. */
describe("RunNowButton", () => {
  it("starts a run and hands back its Run record", async () => {
    const run = { deploymentId: "run-1" } as Deployment;
    mutateAsync.mockResolvedValue(run);
    const onStarted = vi.fn();
    render(
      <RunNowButton
        applicationId="app-1"
        waitingForFirstBuild={false}
        onStarted={onStarted}
      />,
    );

    fireEvent.click(button());

    await vi.waitFor(() => expect(onStarted).toHaveBeenCalledWith(run));
  });

  it("is off, saying why, while the Cron service waits for its first build", () => {
    render(<RunNowButton applicationId="app-1" waitingForFirstBuild />);

    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect(button().getAttribute("title")).toBe(WAITING_FOR_FIRST_BUILD);
    fireEvent.click(button());
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("is off for a role without deployment: create", () => {
    allowed = false;
    render(<RunNowButton applicationId="app-1" waitingForFirstBuild={false} />);

    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect(button().getAttribute("title")).toBe(APPLICATION_DEPLOY_REFUSAL);
  });
});
