import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import {
  deploymentsApi,
  type Deployment,
  type DeploymentStatus,
} from "@/lib/api/endpoints/deployments";

const toast = vi.hoisted(() => ({
  done: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/components/console/toast", () => ({ toast }));

const { CancelBuildButton } = await import("./cancel-build-button");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toast.done.mockReset();
  toast.warn.mockReset();
  toast.error.mockReset();
});

function mount(status: DeploymentStatus, extra: Partial<Deployment> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const deployment = { deploymentId: "dep-1", status, ...extra } as Deployment;
  return render(
    <QueryClientProvider client={client}>
      <CancelBuildButton deployment={deployment} applicationId="app-1" />
    </QueryClientProvider>,
  );
}

const cancelButton = () => screen.queryByRole("button", { name: "Cancel" });

/**
 * A running build
 * can be stopped, so Cancel is offered for `running` as well as `pending` — on
 * the Overview's Build output card and on each Deployments row, which both
 * render this component.
 */
describe("CancelBuildButton", () => {
  it.each<DeploymentStatus>(["pending", "running", "held"])(
    "is offered for a %s build",
    (status) => {
      mount(status);
      expect(cancelButton()).not.toBe(null);
    },
  );

  it.each<DeploymentStatus>(["done", "error", "cancelled"])(
    "is not offered for a %s one",
    (status) => {
      mount(status);
      expect(cancelButton()).toBe(null);
    },
  );

  it("stops a running build and says so", async () => {
    const cancel = vi
      .spyOn(deploymentsApi, "cancelDeployment")
      .mockResolvedValue({
        deploymentId: "dep-1",
        status: "cancelled",
      } as Deployment);
    mount("running");

    fireEvent.click(cancelButton()!);

    await waitFor(() => expect(toast.done).toHaveBeenCalled());
    expect(cancel).toHaveBeenCalledWith("dep-1");
    expect(toast.done).toHaveBeenCalledWith("The build was stopped.");
  });

  it("cancels a Cron service's running run, whose timetable keeps going", async () => {
    const cancel = vi
      .spyOn(deploymentsApi, "cancelDeployment")
      .mockResolvedValue({
        deploymentId: "dep-1",
        status: "cancelled",
      } as Deployment);
    mount("running", {
      cronRun: {
        job: "app-x-run-abc",
        image: "app-x:latest",
        startedBy: { kind: "timetable" },
      },
    } as Partial<Deployment>);

    fireEvent.click(cancelButton()!);

    await waitFor(() => expect(toast.done).toHaveBeenCalled());
    expect(cancel).toHaveBeenCalledWith("dep-1");
    expect(toast.done).toHaveBeenCalledWith(
      "The run was cancelled. Its timetable keeps going.",
    );
  });

  it("shows the backend's refusal for a build that is already releasing", async () => {
    const refusal =
      "This deployment has finished building and is releasing the image, which cannot be stopped part-way. It finishes on its own.";
    vi.spyOn(deploymentsApi, "cancelDeployment").mockRejectedValue(
      new ApiError(409, refusal),
    );
    mount("running");

    fireEvent.click(cancelButton()!);

    await waitFor(() => expect(toast.warn).toHaveBeenCalled());
    expect(toast.warn).toHaveBeenCalledWith(refusal);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
