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

import {
  applicationsApi,
  type ApplicationDetail,
  type CloudDelete,
} from "@/lib/api/endpoints/applications";

const push = vi.hoisted(() => vi.fn());
const permission = vi.hoisted(() => ({ allowed: true, pending: false }));
const toast = vi.hoisted(() => ({ done: vi.fn(), error: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/auth/use-permission", () => ({
  usePermission: () => ({ ...permission, role: "owner" }),
}));
vi.mock("@/components/console/toast", () => ({ toast }));

const { CloudDeleteCard, FORGET_WARNING, GOOGLE_FORGET_WARNING } =
  await import("./cloud-delete-card");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  push.mockReset();
  permission.allowed = true;
});

const LEFT = [
  {
    type: "ec2:security-group",
    awsId: "arn:aws:ec2:eu-central-1:123456789012:security-group/sg-0123abcd",
    region: "eu-central-1",
    tag: "cloudgate:state=st-1",
  },
  {
    type: "ec2:network-interface",
    awsId: "eni-0aa11bb22",
    region: "eu-central-1",
    tag: null,
  },
];

function mount(cloudDelete: CloudDelete) {
  const application = {
    applicationId: "app-1",
    environmentId: "env-1",
    name: "web",
    cloudPlace: {
      cloudAccountId: "cloud-1",
      cloudAccountName: "Production AWS",
      region: "eu-central-1",
    },
    cloudDelete,
  } as unknown as ApplicationDetail;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CloudDeleteCard application={application} />
    </QueryClientProvider>,
  );
}

const incomplete: CloudDelete = {
  status: "incomplete",
  deploymentId: "dep-1",
  retrying: false,
  kept: [],
  left: LEFT,
  unfinished: null,
};

/**
 * A cloud Service's Delete as the console shows it — Deleting while
 * its run goes, and Delete incomplete with each leftover, Retry and Forget.
 */
describe("CloudDeleteCard", () => {
  it("says the Service is being deleted, with nothing to press", () => {
    mount({ ...incomplete, status: "deleting", left: [] });

    expect(screen.getByText("Deleting web")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lists each leftover by type, AWS id, region and Cloudgate tag", () => {
    mount(incomplete);

    expect(screen.getByText("Delete incomplete")).toBeTruthy();
    expect(
      screen.getByText("2 resources are still in AWS, and may still bill."),
    ).toBeTruthy();
    const table = screen.getByRole("table");
    expect(within(table).getByText("ec2:security-group")).toBeTruthy();
    expect(within(table).getByText(LEFT[0].awsId)).toBeTruthy();
    expect(within(table).getByText("cloudgate:state=st-1")).toBeTruthy();
    expect(within(table).getByText("None: AWS made it")).toBeTruthy();
  });

  it("retries the Delete from the kept state", async () => {
    const retry = vi
      .spyOn(applicationsApi, "retryCloudDelete")
      .mockResolvedValue({} as never);
    mount(incomplete);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(retry).toHaveBeenCalledWith("app-1"));
  });

  it("forgets only after warning that what is left may still bill", async () => {
    const forget = vi
      .spyOn(applicationsApi, "forgetCloudDelete")
      .mockResolvedValue({ applicationId: "app-1", forgotten: LEFT });
    mount(incomplete);

    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(FORGET_WARNING)).toBeTruthy();
    expect(forget).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Forget" }));

    await waitFor(() => expect(forget).toHaveBeenCalledWith("app-1"));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/environments/env-1"),
    );
  });

  it("offers Retry and Forget only to a role that may delete the Service", () => {
    permission.allowed = false;
    mount(incomplete);

    expect(
      (screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement)
        .disabled ||
        screen
          .getByRole("button", { name: "Retry" })
          .getAttribute("aria-disabled") === "true",
    ).toBe(true);
  });
});

/**
 * A Cloud Run Service's Delete incomplete lists each leftover by
 * type, Google name, region and Cloudgate's label, and Forget warns of
 * Google Cloud's bill.
 */
describe("CloudDeleteCard on Google Cloud", () => {
  const GOOGLE_LEFT = [
    {
      type: "run.googleapis.com/Service",
      googleName: "cloudgate-abcdefghijkl",
      region: "europe-west1",
      label: "cloudgate-state=mnopqrstuvwx",
    },
    {
      type: "compute.googleapis.com/UrlMap host rule",
      googleName: "cloudgate-urls shop.acme.dev",
      region: "global",
      label: null,
    },
  ];

  function mountGoogle(cloudDelete: CloudDelete) {
    const application = {
      applicationId: "app-1",
      environmentId: "env-1",
      name: "web",
      cloudPlace: {
        cloudAccountId: "cloud-2",
        cloudAccountName: "Production Google",
        cloud: "gcp",
        region: "europe-west1",
      },
      cloudDelete,
    } as unknown as ApplicationDetail;
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    return render(
      <QueryClientProvider client={client}>
        <CloudDeleteCard application={application} />
      </QueryClientProvider>,
    );
  }

  it("lists each leftover by type, Google name, region and label, and says Retry starts at the network step", () => {
    mountGoogle({ ...incomplete, left: GOOGLE_LEFT });

    expect(
      screen.getByText(
        "2 resources are still in Google Cloud, and may still bill.",
      ),
    ).toBeTruthy();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Google name")).toBeTruthy();
    expect(within(table).getByText("run.googleapis.com/Service")).toBeTruthy();
    expect(within(table).getByText("cloudgate-abcdefghijkl")).toBeTruthy();
    expect(
      within(table).getByText("cloudgate-state=mnopqrstuvwx"),
    ).toBeTruthy();
    expect(within(table).getByText("None: found by its name")).toBeTruthy();
    expect(
      screen.getByText(/Retry starts again from the network step/),
    ).toBeTruthy();
  });

  it("warns that what is left may still bill in Google Cloud before Forget", async () => {
    mountGoogle({ ...incomplete, left: GOOGLE_LEFT });

    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText(GOOGLE_FORGET_WARNING)).toBeTruthy();
    expect(
      within(dialog).getByText(
        "run.googleapis.com/Service cloudgate-abcdefghijkl (europe-west1)",
      ),
    ).toBeTruthy();
  });

  it("says a static site's bucket was left partly emptied, and that Retry empties it again", () => {
    mountGoogle({
      ...incomplete,
      left: [
        {
          type: "storage.googleapis.com/Bucket",
          googleName: "cloudgate-abcdefghijkl-p4x8m2rt",
          region: "europe-west1",
          label: "cloudgate-state=mnopqrstuvwx",
          because: "partly-emptied",
        },
      ],
    });

    const table = screen.getByRole("table");
    expect(
      within(table).getByText("cloudgate-abcdefghijkl-p4x8m2rt"),
    ).toBeTruthy();
    expect(
      within(table).getByText("Partly emptied: it still holds files"),
    ).toBeTruthy();
    expect(
      screen.getByText(/empties its bucket again, then destroys it/),
    ).toBeTruthy();
  });

  it("names no reason for a Google leftover that should simply have gone", () => {
    mountGoogle({ ...incomplete, left: GOOGLE_LEFT });

    expect(screen.queryByText(/Partly emptied/)).toBeNull();
    expect(screen.queryByText(/empties its bucket again/)).toBeNull();
  });
});

/**
 * A static site whose bucket's emptying stopped partway is Delete
 * incomplete with the bucket left "partly emptied", and Retry empties it
 * again.
 */
describe("CloudDeleteCard on a partly emptied static site", () => {
  const bucketArn = "arn:aws:s3:::docs-p4x8m2rt-123456789012-eu-central-1-an";

  it("says the bucket was partly emptied and still holds files, and that Retry empties it again", () => {
    mount({
      ...incomplete,
      left: [
        {
          type: "s3",
          awsId: bucketArn,
          region: "eu-central-1",
          tag: "cloudgate:state=st-1",
          because: "partly-emptied",
        },
      ],
    });

    const table = screen.getByRole("table");
    expect(within(table).getByText(bucketArn)).toBeTruthy();
    expect(
      within(table).getByText("Partly emptied: it still holds files"),
    ).toBeTruthy();
    expect(
      screen.getByText(/Retry empties its bucket again, then destroys it/),
    ).toBeTruthy();
  });

  it("names no reason for a leftover that should simply have gone", () => {
    mount(incomplete);

    expect(screen.queryByText(/Partly emptied/)).toBeNull();
    expect(screen.queryByText(/Retry empties its bucket/)).toBeNull();
  });
});
