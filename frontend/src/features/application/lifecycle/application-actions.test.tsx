import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import {
  applicationsApi,
  type ApplicationDetail,
  type ApplicationStatus,
  type CloudPlace,
} from "@/lib/api/endpoints/applications";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({
  done: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));
vi.mock("@/components/console/toast", () => ({ toast }));

const {
  ApplicationActions,
  CLOUD_RELOAD_WHILE_STOPPED,
  CLOUD_STOP_WARNING,
  CLOUD_WORKER_STOP_WARNING,
  GOOGLE_STOP_WARNING,
} = await import("./application-actions");

beforeEach(() => {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toast.done.mockReset();
  toast.warn.mockReset();
  toast.error.mockReset();
});

const application = {
  applicationId: "app-1",
  environmentId: "env-1",
  name: "hello",
  applicationStatus: "error",
  replicas: 3,
  cloudPlace: null,
} as unknown as ApplicationDetail;

const CLOUD: CloudPlace = {
  cloudAccountId: "cloud-1",
  cloudAccountName: "Production AWS",
  region: "eu-central-1",
};

function mount(
  hasBuilt: boolean,
  applicationStatus: ApplicationStatus = application.applicationStatus,
  cloudPlace: CloudPlace | null = null,
  extra: Partial<ApplicationDetail> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    wrap(
      <ApplicationActions
        application={{
          ...application,
          ...extra,
          applicationStatus,
          cloudPlace,
        }}
        hasBuilt={hasBuilt}
      />,
    ),
  );
}

const named = (name: string) => screen.queryByRole("button", { name });

/**
 * Restart and Stop on an Application no Deployment ever released
 * There is no
 * Swarm service to scale, so the backend refuses with a 409 naming it — and
 * the console says that, rather than "the request did not come back", which
 * stays for the case it was written for.
 */
describe("ApplicationActions", () => {
  it("offers Deploy only before any Deployment has released", () => {
    mount(false);

    expect(named("Deploy")).not.toBe(null);
    expect(named("Restart")).toBe(null);
    expect(named("Stop")).toBe(null);
    expect(named("Start")).toBe(null);
  });

  /**
   * Stop writes `stopped` now, and the one control that is Stop or Start
   * reads the row to pick. Reading only `idle` offered **Stop** to an
   * Application an operator had just stopped — a no-op dressed as the next
   * step, and no way back but Restart. `idle` stays on the Start side: a row
   * stopped by an older version still wears it, and with a released Deployment
   * behind it `idle` can only be that.
   */
  it.each(["stopped", "idle"] as const)(
    "offers Start, not Stop, to a released Application that is %s",
    (status) => {
      mount(true, status);

      expect(named("Start")).not.toBe(null);
      expect(named("Stop")).toBe(null);
    },
  );

  it("offers Stop, not Start, to one that is serving", () => {
    mount(true, "done");

    expect(named("Stop")).not.toBe(null);
    expect(named("Start")).toBe(null);
  });

  it("shows the backend's refusal when there is no service to stop", async () => {
    const refusal = new ApiError(
      409,
      "Swarm has no service named hello-a1b2c3 to stop",
    );
    vi.spyOn(applicationsApi, "stop").mockRejectedValue(refusal);
    mount(true);

    fireEvent.click(named("Stop")!);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(refusal));
    expect(toast.warn).not.toHaveBeenCalled();
  });

  it("keeps the did-not-come-back warning for a dropped connection", async () => {
    vi.spyOn(applicationsApi, "reload").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    mount(true);

    fireEvent.click(named("Restart")!);

    await waitFor(() =>
      expect(toast.warn).toHaveBeenCalledWith(
        "The request did not come back.",
        expect.anything(),
      ),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });
});

/**
 * A Service in a Cloud account: Stop warns what still bills before it runs, the
 * restart is Reload and is off with the reason while stopped, and there is no
 * Remove containers.
 */
describe("ApplicationActions on a cloud Service", () => {
  it("offers Reload, Stop and Deploy, and no Remove containers", () => {
    mount(true, "done", CLOUD);

    expect(named("Reload")).not.toBe(null);
    expect(named("Restart")).toBe(null);
    expect(named("Stop")).not.toBe(null);
    expect(named("Remove containers")).toBe(null);
  });

  it("warns what still bills before it stops, and stops only once confirmed", async () => {
    const stop = vi
      .spyOn(applicationsApi, "stop")
      .mockResolvedValue({} as never);
    mount(true, "done", CLOUD);

    fireEvent.click(named("Stop")!);

    expect(await screen.findByText(CLOUD_STOP_WARNING)).toBeTruthy();
    expect(CLOUD_STOP_WARNING).toContain(
      "Environment network this Service shares (about $24/month)",
    );
    expect(CLOUD_STOP_WARNING).toContain(
      "stored images and its stored logs still bill",
    );
    expect(CLOUD_STOP_WARNING).toContain(
      "Domains answer 503 until you start it again",
    );
    expect(stop).not.toHaveBeenCalled();

    const buttons = screen.getAllByRole("button", { name: "Stop" });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith(
        "hello is stopping. Its Domains answer 503 until you start it again.",
      ),
    );
  });

  it.each(["worker", "web-private"] as const)(
    "warns a %s what still bills without promising Domains it never has",
    async (configKind) => {
      const stop = vi
        .spyOn(applicationsApi, "stop")
        .mockResolvedValue({} as never);
      mount(true, "done", CLOUD, { configKind });

      fireEvent.click(named("Stop")!);

      expect(await screen.findByText(CLOUD_WORKER_STOP_WARNING)).toBeTruthy();
      expect(CLOUD_WORKER_STOP_WARNING).toContain(
        "Environment network this Service shares (about $24/month), its stored images and its stored logs still bill",
      );
      expect(CLOUD_WORKER_STOP_WARNING).not.toContain("Domain");

      const buttons = screen.getAllByRole("button", { name: "Stop" });
      fireEvent.click(buttons[buttons.length - 1]);
      await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(toast.done).toHaveBeenCalledWith(
          "hello is stopping. None of its copies runs until you start it again.",
        ),
      );
    },
  );

  it("pauses a Cron service on AWS at once, with no cloud Stop warning, and offers no Reload", async () => {
    const stop = vi
      .spyOn(applicationsApi, "stop")
      .mockResolvedValue({} as never);
    mount(true, "done", CLOUD, { configKind: "cron" });

    expect(named("Reload")).toBeNull();
    fireEvent.click(named("Stop")!);

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(CLOUD_STOP_WARNING)).toBeNull();
    expect(screen.queryByText(CLOUD_WORKER_STOP_WARNING)).toBeNull();
    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith(
        "hello is paused: its timetable starts no run until you start it again, and a run in flight was stopped.",
      ),
    );
  });

  it("shows Reload off, with the reason, while the Service is stopped", () => {
    const reload = vi.spyOn(applicationsApi, "reload");
    mount(true, "stopped", CLOUD);

    const button = named("Reload")!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(CLOUD_RELOAD_WHILE_STOPPED);
    fireEvent.click(button);
    expect(reload).not.toHaveBeenCalled();
    expect(named("Start")).not.toBe(null);
  });

  it("reloads a running one, in the cloud's words", async () => {
    const reload = vi
      .spyOn(applicationsApi, "reload")
      .mockResolvedValue({} as never);
    mount(true, "done", CLOUD);

    fireEvent.click(named("Reload")!);

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith(
        "hello is replacing every running copy with a fresh one of the same version.",
      ),
    );
  });

  it("starts its usual number of copies", async () => {
    const start = vi
      .spyOn(applicationsApi, "start")
      .mockResolvedValue({} as never);
    mount(true, "stopped", CLOUD);

    fireEvent.click(named("Start")!);

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith(
        "hello is starting 3 copies of its last deployed image.",
      ),
    );
  });
});

/**
 * The same three on Cloud Run, in Google's
 * words. Stop names the shared load balancer, the stored image and logs,
 * and the error the Domains answer until Start.
 */
describe("ApplicationActions on a Cloud Run Service", () => {
  const GOOGLE: CloudPlace = {
    cloudAccountId: "cloud-2",
    cloudAccountName: "Production Google",
    cloud: "gcp",
    region: "europe-west1",
  };
  const RANGE = { minCopies: 1, maxCopies: 3 };

  it("offers Reload, Stop and Deploy, and no Remove containers", () => {
    mount(true, "done", GOOGLE, RANGE);

    expect(named("Reload")).not.toBe(null);
    expect(named("Stop")).not.toBe(null);
    expect(named("Remove containers")).toBe(null);
  });

  it("warns what still bills on Google Cloud before it stops, and stops only once confirmed", async () => {
    const stop = vi
      .spyOn(applicationsApi, "stop")
      .mockResolvedValue({} as never);
    mount(true, "done", GOOGLE, RANGE);

    fireEvent.click(named("Stop")!);

    expect(await screen.findByText(GOOGLE_STOP_WARNING)).toBeTruthy();
    expect(screen.queryByText(CLOUD_STOP_WARNING)).toBe(null);
    expect(GOOGLE_STOP_WARNING).toContain("lowers the bill without ending it");
    expect(GOOGLE_STOP_WARNING).toContain(
      "load balancer of the Environment network this Service shares",
    );
    expect(GOOGLE_STOP_WARNING).toContain(
      "its stored image and its stored logs still bill",
    );
    expect(GOOGLE_STOP_WARNING).toContain(
      "Domains answer an error until you start it again",
    );
    expect(stop).not.toHaveBeenCalled();

    const buttons = screen.getAllByRole("button", { name: "Stop" });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith(
        "hello is stopping. Its Domains answer an error until you start it again.",
      ),
    );
  });

  it("stops a Worker's worker pool at once, with no still-bills warning, since a stopped one bills nothing", async () => {
    const stop = vi
      .spyOn(applicationsApi, "stop")
      .mockResolvedValue({} as never);
    mount(true, "done", GOOGLE, { configKind: "worker" });

    fireEvent.click(named("Stop")!);

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(GOOGLE_STOP_WARNING)).toBe(null);
    expect(screen.queryByText(/still bill/)).toBe(null);
    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith(
        "hello is stopping. None of its instances runs until you start it again.",
      ),
    );
  });

  it("shows Reload off, with the reason, while the Service is stopped", () => {
    const reload = vi.spyOn(applicationsApi, "reload");
    mount(true, "stopped", GOOGLE, RANGE);

    const button = named("Reload")!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(CLOUD_RELOAD_WHILE_STOPPED);
    fireEvent.click(button);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads as a fresh revision of the same image", async () => {
    const reload = vi
      .spyOn(applicationsApi, "reload")
      .mockResolvedValue({} as never);
    mount(true, "done", GOOGLE, RANGE);

    fireEvent.click(named("Reload")!);

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith(
        "hello is starting a fresh revision of the same image.",
      ),
    );
  });

  it("starts it again in its copy range", async () => {
    const start = vi
      .spyOn(applicationsApi, "start")
      .mockResolvedValue({} as never);
    mount(true, "stopped", GOOGLE, RANGE);

    fireEvent.click(named("Start")!);

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith(
        "hello is starting again on its last deployed image, between 1 and 3 copies.",
      ),
    );
  });

  it("names Google Cloud when the request did not come back", async () => {
    vi.spyOn(applicationsApi, "start").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    mount(true, "stopped", GOOGLE, RANGE);

    fireEvent.click(named("Start")!);

    await waitFor(() =>
      expect(toast.warn).toHaveBeenCalledWith(
        "The request did not come back.",
        {
          description:
            "Google Cloud may still have taken it. Watch the status beside the name rather than this.",
        },
      ),
    );
  });
});

/**
 * A Cron
 * service's Stop and Start are its pause, with no Restart and no Remove
 * containers.
 */
describe("ApplicationActions on a Cron service", () => {
  function mountCron(applicationStatus: ApplicationStatus, hasBuilt = true) {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    return render(
      <QueryClientProvider client={client}>
        <ApplicationActions
          application={
            {
              ...application,
              applicationStatus,
              configKind: "cron",
            } as ApplicationDetail
          }
          hasBuilt={hasBuilt}
        />
      </QueryClientProvider>,
    );
  }

  it("offers Stop, and no Restart or Remove containers", () => {
    mountCron("done");

    expect(named("Stop")).not.toBe(null);
    expect(named("Restart")).toBe(null);
    expect(named("Reload")).toBe(null);
    expect(named("Remove containers")).toBe(null);
  });

  it("offers Stop while still waiting for its first build", () => {
    mountCron("idle", false);

    expect(named("Stop")).not.toBe(null);
    expect(named("Start")).toBe(null);
  });

  it("pauses it, in its own words", async () => {
    const stop = vi
      .spyOn(applicationsApi, "stop")
      .mockResolvedValue({} as never);
    mountCron("done");

    fireEvent.click(named("Stop")!);

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith(
        "hello is paused: its timetable starts no run until you start it again, and a run in flight was stopped.",
      ),
    );
  });

  it("resumes a paused one with Start", async () => {
    const start = vi
      .spyOn(applicationsApi, "start")
      .mockResolvedValue({} as never);
    mountCron("stopped");

    fireEvent.click(named("Start")!);

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith(
        "hello's timetable is running again from its next fire time.",
      ),
    );
  });
});

/**
 * With no source chosen the backend refuses a Deployment with a 409, so
 * Deploy is off with the reason beside it rather than live and answered by a
 * toast.
 */
describe("ApplicationActions with no source chosen", () => {
  it("turns Deploy off and says why beside it", () => {
    // What create leaves: the column default `github`, and no repository.
    mount(false, "idle", null, { sourceType: "github", repository: null });

    const deploy = screen.getByRole("button", { name: "Deploy" });
    expect(deploy.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/No source is chosen yet/).id).toBe(
      deploy.getAttribute("aria-describedby"),
    );
  });

  it("leaves Deploy live once an image is set", () => {
    mount(false, "idle", null, { sourceType: "docker", dockerImage: "nginx:1.27" });

    const deploy = screen.getByRole("button", { name: "Deploy" });
    expect(deploy.getAttribute("aria-disabled")).not.toBe("true");
    expect(screen.queryByText(/No source is chosen yet/)).toBeNull();
  });
});
