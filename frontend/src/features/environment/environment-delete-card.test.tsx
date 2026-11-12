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

import { cloudAccountsApi } from "@/lib/api/endpoints/cloud-accounts";
import {
  environmentsApi,
  type Environment,
  type EnvironmentDelete,
} from "@/lib/api/endpoints/environments";

const push = vi.hoisted(() => vi.fn());
const permission = vi.hoisted(() => ({ allowed: true, pending: false }));
const toast = vi.hoisted(() => ({ done: vi.fn(), error: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ ...permission, role: "owner" }),
}));
vi.mock("@/components/console/toast", () => ({ toast }));
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

const {
  EnvironmentDeleteCard,
  ENVIRONMENT_FORGET_WARNING,
  GOOGLE_ENVIRONMENT_FORGET_WARNING,
} = await import("./environment-delete-card");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  push.mockReset();
  permission.allowed = true;
});

const LEFT = [
  {
    type: "elasticloadbalancing:loadbalancer",
    awsId:
      "arn:aws:elasticloadbalancing:eu-central-1:123456789012:loadbalancer/app/cg/50dc",
    region: "eu-central-1",
    tag: "cloudgate:state=st-1",
    of: "Environment network (eu-central-1)",
  },
  {
    type: "ec2:network-interface",
    awsId: "eni-0cc33dd44",
    region: "eu-central-1",
    tag: null,
    of: "Environment network (eu-central-1)",
  },
];

const incomplete: EnvironmentDelete = {
  status: "incomplete",
  retrying: false,
  force: false,
  left: LEFT,
  dnsRecordsLeft: [
    { name: "shop.example.com", type: "CNAME", value: "cg-1.elb.amazonaws.com" },
  ],
  unfinished: null,
};

function mount(
  cloudDelete: EnvironmentDelete | null,
  deployTarget: Environment["deployTarget"] = {
    kind: "cloud",
    cloudAccountId: "ca-aws",
    region: "eu-central-1",
  },
) {
  const environment = {
    environmentId: "env-1",
    projectId: "proj-1",
    name: "production",
    deployTarget,
    cloudDelete,
  } as unknown as Environment;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <EnvironmentDeleteCard environment={environment} />
    </QueryClientProvider>,
  );
}

/**
 * An Environment's Delete in a Cloud account as the console shows it
 * — Deleting while its runs go, and Delete incomplete with each leftover
 * and whose it was, Retry and Forget, and the DNS records its Domains left.
 */
describe("EnvironmentDeleteCard", () => {
  it("renders nothing on an Environment with no cloud Delete", () => {
    const { container } = mount(null);

    expect(container.textContent).toBe("");
  });

  it("says the Environment is being deleted, naming the DNS records, with nothing to press", () => {
    mount({ ...incomplete, status: "deleting", left: [] });

    expect(screen.getByText("Deleting production")).toBeTruthy();
    expect(
      screen.getByText("CNAME shop.example.com → cg-1.elb.amazonaws.com"),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lists each leftover with whose it was", () => {
    mount(incomplete);

    expect(screen.getByText("Delete incomplete")).toBeTruthy();
    const table = screen.getByRole("table");
    expect(
      within(table).getAllByText("Environment network (eu-central-1)"),
    ).toHaveLength(2);
    expect(within(table).getByText("eni-0cc33dd44")).toBeTruthy();
    expect(within(table).getByText("None: AWS made it")).toBeTruthy();
  });

  it("retries the Delete", async () => {
    const retry = vi
      .spyOn(environmentsApi, "retryCloudDelete")
      .mockResolvedValue({} as never);
    mount(incomplete);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(retry).toHaveBeenCalledWith("env-1"));
  });

  it("forgets only after warning that what is left may still bill", async () => {
    const forget = vi
      .spyOn(environmentsApi, "forgetCloudDelete")
      .mockResolvedValue({ environmentId: "env-1", forgotten: LEFT });
    mount(incomplete);

    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(ENVIRONMENT_FORGET_WARNING)).toBeTruthy();
    expect(forget).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Forget" }));

    await waitFor(() => expect(forget).toHaveBeenCalledWith("env-1"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects/proj-1"));
  });

  describe("on Google Cloud", () => {
    const HOLD =
      "Environment network (europe-west1): Google Cloud still holds subnet cloudgate-abc-subnet and network cloudgate-abc-net. Google releases this 1–2 hours after the services are gone; Cloudgate will try again at 16:07 UTC";
    const held: EnvironmentDelete = {
      ...incomplete,
      left: [
        {
          type: "compute.googleapis.com/Subnetwork",
          googleName: "cloudgate-abc-subnet",
          region: "europe-west1",
          label: null,
          of: "Environment network (europe-west1)",
        },
        {
          type: "compute.googleapis.com/Network",
          googleName: "cloudgate-abc-net",
          region: "global",
          label: null,
          of: "Environment network (europe-west1)",
        },
      ],
      dnsRecordsLeft: [],
      unfinished: HOLD,
    };

    it("names Google's subnet hold and lists each leftover by type, Google name, region and label", () => {
      mount(held);

      expect(
        screen.getByText(
          "2 resources are still in Google Cloud, and may still bill.",
        ),
      ).toBeTruthy();
      expect(screen.getByText(HOLD)).toBeTruthy();
      const table = screen.getByRole("table");
      expect(within(table).getByText("cloudgate-abc-subnet")).toBeTruthy();
      expect(within(table).getByText("global")).toBeTruthy();
      expect(within(table).getAllByText("None: found by its name")).toHaveLength(
        2,
      );
    });

    it("names Google Cloud from the Deploy target's Cloud account when nothing was found left", async () => {
      vi.spyOn(cloudAccountsApi, "list").mockResolvedValue([
        { cloudAccountId: "ca-gcp", cloud: "gcp" },
      ] as never);
      mount(
        { ...held, left: [], unfinished: "The run did not finish." },
        { kind: "cloud", cloudAccountId: "ca-gcp", region: "europe-west1" },
      );

      fireEvent.click(screen.getByRole("button", { name: "Forget" }));
      const dialog = await screen.findByRole("dialog");

      await waitFor(() =>
        expect(
          within(dialog).getByText(GOOGLE_ENVIRONMENT_FORGET_WARNING),
        ).toBeTruthy(),
      );
      expect(
        within(dialog).getByText(
          "Cloudgate stops tracking what its Delete left in Google Cloud.",
        ),
      ).toBeTruthy();
    });

    it("warns that what is left may still bill in Google Cloud before Forget", async () => {
      mount(held);

      fireEvent.click(screen.getByRole("button", { name: "Forget" }));
      const dialog = await screen.findByRole("dialog");

      expect(
        within(dialog).getByText(GOOGLE_ENVIRONMENT_FORGET_WARNING),
      ).toBeTruthy();
      expect(
        within(dialog).getByText(
          "Environment network (europe-west1): compute.googleapis.com/Subnetwork cloudgate-abc-subnet (europe-west1)",
        ),
      ).toBeTruthy();
    });
  });
});
