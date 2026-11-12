import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Environment network's card, with `fetch` as the boundary: the
 * networks read is a real request through the real API client and hook.
 */

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, pending: false, role: "owner" }),
}));

const { EnvironmentNetworkCard } = await import("./environment-network-card");

/** What `GET /environments/env-1/networks` answers. */
const networks = vi.hoisted(() => ({ rows: [] as unknown[] }));

/** What `GET /environments/env-1/networks/net-1/resources` answers. */
const RESOURCES = {
  stateId: "st-net",
  readable: true,
  failure: null,
  networkCardsUnread: null,
  resources: [
    {
      type: "aws_vpc",
      awsId: "vpc-0f00ba11",
      region: "eu-central-1",
      tags: { "cloudgate:state": "st-net" },
      findableByTag: true,
    },
  ],
};

function json(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function answer(input: RequestInfo | URL): Promise<Response> {
  const path = new URL(String(input), "http://console.test").pathname;
  if (path.endsWith("/environments/env-1/networks")) return json(networks.rows);
  if (path.endsWith("/environments/env-1/networks/net-1/resources")) {
    return json(RESOURCES);
  }
  if (path.endsWith("/environments/env-1")) {
    return json({ environmentId: "env-1", name: "production" });
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

const network = {
  environmentNetworkId: "net-1",
  cloudAccountId: "ca-1",
  cloudAccountName: "Production AWS",
  cloud: "aws",
  region: "eu-central-1",
  status: "ready",
  albDnsName: "cg-1234567890.eu-central-1.elb.amazonaws.com",
  ipAddress: null,
  vpcId: "vpc-0f00ba11",
  leftovers: [],
  subnetHold: null,
  holdNextTryAt: null,
  idleCost: "about $24/month while idle",
  serviceCount: 0,
  lastRun: null,
  stateReadable: true,
  createdAt: "2026-10-17T10:00:00.000Z",
};

beforeEach(() => {
  networks.rows = [];
  vi.stubGlobal("fetch", vi.fn(answer));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <EnvironmentNetworkCard environmentId="env-1" />
    </QueryClientProvider>,
  );
}

describe("EnvironmentNetworkCard", () => {
  it("shows an empty network's idle cost, saying it still bills", async () => {
    networks.rows = [network];
    mount();

    expect(await screen.findByText("about $24/month while idle")).toBeTruthy();
    expect(screen.getByText("None — it still bills")).toBeTruthy();
    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.getByText("Production AWS, eu-central-1")).toBeTruthy();
    expect(screen.getByText(network.albDnsName)).toBeTruthy();
  });

  it("names what a Google network's removal left, and Google's subnet hold with Cloudgate's next try", async () => {
    const hold =
      "Google Cloud still holds subnet cloudgate-abc-subnet and network cloudgate-abc-net. Google releases this 1–2 hours after the services are gone; Cloudgate will try again at 16:07 UTC";
    networks.rows = [
      {
        ...network,
        cloud: "gcp",
        region: "europe-west1",
        status: "delete-incomplete",
        albDnsName: null,
        leftovers: [
          {
            type: "compute.googleapis.com/Subnetwork",
            googleName: "cloudgate-abc-subnet",
            region: "europe-west1",
            label: null,
          },
        ],
        subnetHold: hold,
        holdNextTryAt: "2026-10-20T16:07:00.000Z",
      },
    ];
    mount();

    expect(await screen.findByText(hold)).toBeTruthy();
    expect(
      screen.getByText(
        "compute.googleapis.com/Subnetwork cloudgate-abc-subnet (europe-west1, found by its name)",
      ),
    ).toBeTruthy();
  });

  it("shows a network being made, with no address yet", async () => {
    networks.rows = [
      { ...network, status: "creating", albDnsName: null, vpcId: null },
    ];
    mount();

    expect(await screen.findByText("being made")).toBeTruthy();
    expect(screen.getByText("Not made yet")).toBeTruthy();
  });

  it("shows a Google network's fixed IP, with no load balancer DNS name", async () => {
    networks.rows = [
      {
        ...network,
        cloudAccountName: "Production Google",
        cloud: "gcp",
        region: "europe-west1",
        albDnsName: null,
        ipAddress: "34.117.42.7",
        vpcId: null,
        idleCost:
          "$0/month for the network, about $18/month while idle for the load balancer",
      },
    ];
    mount();

    expect(await screen.findByText("34.117.42.7")).toBeTruthy();
    expect(screen.getByText("Fixed IP")).toBeTruthy();
    expect(screen.queryByText("Load balancer")).toBeNull();
    expect(
      screen.getByText(
        "$0/month for the network, about $18/month while idle for the load balancer",
      ),
    ).toBeTruthy();
  });

  it("shows a Google network being made, with no fixed IP yet", async () => {
    networks.rows = [
      {
        ...network,
        cloud: "gcp",
        status: "creating",
        albDnsName: null,
        ipAddress: null,
        vpcId: null,
      },
    ];
    mount();

    expect(await screen.findByText("being made")).toBeTruthy();
    expect(screen.getByText("Fixed IP")).toBeTruthy();
    expect(screen.getByText("Not made yet")).toBeTruthy();
  });

  it("lists what the network holds only when asked", async () => {
    networks.rows = [network];
    mount();

    fireEvent.click(
      await screen.findByRole("button", { name: "What it made" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("vpc-0f00ba11")).toBeTruthy();
    expect(within(dialog).getByText("aws_vpc")).toBeTruthy();
    expect(
      screen.queryByText("Cloudgate cannot read this Infrastructure state."),
    ).toBeNull();
  });

  it("says when its state cannot be read, with Rebuild confirmed by the Environment's name", async () => {
    networks.rows = [{ ...network, stateReadable: false }];
    mount();

    expect(
      await screen.findByText(
        "Cloudgate cannot read this Infrastructure state.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: "Rebuild from the cloud" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Type production to confirm")).toBeTruthy();
  });

  it("renders nothing for an Environment with no network", async () => {
    const { container } = mount();

    await vi.waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(0),
    );
    expect(container.textContent).toBe("");
  });
});
