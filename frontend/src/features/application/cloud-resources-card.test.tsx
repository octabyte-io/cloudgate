import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import {
  cloudResourcesApi,
  type CloudResourceList,
} from "@/lib/api/endpoints/cloud-resources";

const permission = vi.hoisted(() => ({ allowed: true, pending: false }));
const toast = vi.hoisted(() => ({ done: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ ...permission, role: "owner" }),
}));
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));
vi.mock("@/components/console/toast", () => ({ toast }));

const { CloudResourcesCard } = await import("./cloud-resources-card");
const { NOT_FINDABLE, NOT_FINDABLE_BY_MARK } =
  await import("@/components/console/cloud-resource-list");
const { SERVICE_REBUILD_REFUSAL } =
  await import("@/lib/api/use-cloud-resources");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  permission.allowed = true;
});

const LIST: CloudResourceList = {
  stateId: "st-1",
  readable: true,
  failure: null,
  networkCardsUnread: null,
  resources: [
    {
      type: "aws_ecr_repository",
      awsId: "cloudgate-svc_1",
      region: "eu-central-1",
      tags: { "cloudgate:state": "st-1", Name: "web" },
      findableByTag: true,
    },
    {
      type: "aws_iam_role",
      awsId: "cloudgate-task-svc_1",
      region: "global",
      tags: {},
      findableByTag: false,
    },
    {
      type: "aws_network_interface",
      awsId: "eni-0task",
      region: "eu-central-1",
      tags: {},
      findableByTag: false,
    },
  ],
};

const UNREADABLE: CloudResourceList = {
  stateId: "st-1",
  readable: false,
  failure:
    "Cloudgate cannot read Infrastructure state st-1. Nothing was changed; Rebuild from the cloud discards it and adopts what Cloudgate's tags find.",
  networkCardsUnread: null,
  resources: [],
};

const GOOGLE_LIST: CloudResourceList = {
  cloud: "gcp",
  stateId: "st-g",
  readable: true,
  failure: null,
  networkCardsUnread: null,
  resources: [
    {
      type: "google_cloud_run_v2_service",
      googleName: "cloudgate-plb3nv2t74e6",
      region: "europe-west1",
      labels: { "cloudgate-state": "7rhuqxy3gm43" },
      labelled: true,
    },
    {
      type: "google_compute_backend_service",
      googleName: "cloudgate-plb3nv2t74e6-backend",
      region: "global",
      labels: {},
      labelled: false,
    },
  ],
};

/** A disabled button, however the Button primitive says so. */
function isDisabled(button: HTMLElement): boolean {
  return (
    (button as HTMLButtonElement).disabled ||
    button.getAttribute("aria-disabled") === "true"
  );
}

function mount(cloud: boolean | "gcp" = true) {
  const application = {
    applicationId: "app-1",
    environmentId: "env-1",
    name: "web",
    cloudPlace:
      cloud === "gcp"
        ? {
            cloudAccountId: "cloud-2",
            cloudAccountName: "Production Google",
            cloud: "gcp",
            region: "europe-west1",
          }
        : cloud
          ? {
              cloudAccountId: "cloud-1",
              cloudAccountName: "Production AWS",
              region: "eu-central-1",
            }
          : null,
  } as unknown as ApplicationDetail;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CloudResourcesCard application={application} />
    </QueryClientProvider>,
  );
}

/**
 * What Cloudgate made for a cloud Service, from its state, and an
 * unreadable state's banner and Rebuild from the cloud.
 */
describe("CloudResourcesCard", () => {
  it("lists each resource by type, AWS id, region and tags, marking what a tag search cannot find", async () => {
    vi.spyOn(cloudResourcesApi, "ofService").mockResolvedValue(LIST);
    mount();

    const table = await screen.findByRole("table");
    expect(within(table).getByText("aws_ecr_repository")).toBeTruthy();
    expect(within(table).getByText("cloudgate-svc_1")).toBeTruthy();
    expect(within(table).getByText("cloudgate:state=st-1")).toBeTruthy();
    expect(within(table).getByText("global")).toBeTruthy();
    expect(
      within(table).getByText("aws_network_interface (made by AWS)"),
    ).toBeTruthy();
    expect(within(table).getAllByText(NOT_FINDABLE)).toHaveLength(2);
    expect(screen.queryByText("Rebuild from the cloud")).toBeNull();
  });

  it("lists a Google state's resources by type, Google name, region and labels, marking what carries none of Cloudgate's", async () => {
    vi.spyOn(cloudResourcesApi, "ofService").mockResolvedValue(GOOGLE_LIST);
    mount("gcp");

    expect(await screen.findByText("Made in Google Cloud")).toBeTruthy();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Google name")).toBeTruthy();
    expect(within(table).getByText("cloudgate-plb3nv2t74e6")).toBeTruthy();
    expect(
      within(table).getByText("cloudgate-state=7rhuqxy3gm43"),
    ).toBeTruthy();
    expect(within(table).getByText("carries them")).toBeTruthy();
    expect(within(table).getAllByText(NOT_FINDABLE_BY_MARK)).toHaveLength(1);
    expect(within(table).queryByText("AWS id")).toBeNull();
  });

  it("offers Rebuild of an unreadable Google state as taking back by name", async () => {
    vi.spyOn(cloudResourcesApi, "ofService").mockResolvedValue({
      ...UNREADABLE,
      cloud: "gcp",
    });
    mount("gcp");

    expect(
      await screen.findByText(
        "Rebuild from the cloud discards the state and plans to take back, by the names Cloudgate gave it, what is still in Google Cloud.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Rebuild from the cloud" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/a search by the names/)).toBeTruthy();
  });

  it("reads nothing for a Service on a Server", () => {
    const read = vi.spyOn(cloudResourcesApi, "ofService");
    const { container } = mount(false);

    expect(container.textContent).toBe("");
    expect(read).not.toHaveBeenCalled();
  });

  it("says when the state cannot be read, and rebuilds it only once the Service's name is typed", async () => {
    vi.spyOn(cloudResourcesApi, "ofService").mockResolvedValue(UNREADABLE);
    const rebuild = vi
      .spyOn(cloudResourcesApi, "rebuildService")
      .mockResolvedValue({ planId: "plan-1" } as never);
    mount();

    expect(
      await screen.findByText(
        "Cloudgate cannot read this Infrastructure state.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(UNREADABLE.failure!)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Rebuild from the cloud" }),
    );
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Rebuild from the cloud",
    });
    expect(isDisabled(confirm)).toBe(true);

    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "web" },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(rebuild).toHaveBeenCalledWith("app-1", "web"));
    await waitFor(() => expect(toast.done).toHaveBeenCalled());
  });

  it("offers Rebuild only to a role that may update the Service", async () => {
    permission.allowed = false;
    vi.spyOn(cloudResourcesApi, "ofService").mockResolvedValue(UNREADABLE);
    mount();

    const button = await screen.findByRole("button", {
      name: "Rebuild from the cloud",
    });
    expect(isDisabled(button)).toBe(true);
    expect(button.getAttribute("title")).toBe(SERVICE_REBUILD_REFUSAL);
  });
});
