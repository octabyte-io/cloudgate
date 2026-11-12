import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResourceFormModal } from "@/components/console/resource-form-modal";
import {
  destinationsApi,
  type Destination,
} from "@/lib/api/endpoints/destinations";
import { registriesApi, type Registry } from "@/lib/api/endpoints/registries";
import { destinationSpec } from "@/features/integrations/destinations/destinations-spec";
import { registrySpec } from "@/features/integrations/registries/registries-spec";

import { type ProbeFrom, useProbeServerPicker } from "./probe-server-picker";

const mode = vi.hoisted(() => ({
  data: undefined as "hosted" | "self-hosted" | undefined,
}));
vi.mock("@/lib/api/use-instance-mode", () => ({ useInstanceMode: () => mode }));
vi.mock("@/lib/api/use-servers", () => ({
  useServers: () => ({ data: [], isPending: false }),
}));

vi.mock("@/lib/api/endpoints/registries", () => ({
  registriesApi: {
    list: vi.fn(),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    remove: vi.fn(),
    testConnection: vi.fn(async () => undefined),
    testSavedConnection: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/api/endpoints/destinations", () => ({
  destinationsApi: {
    list: vi.fn(),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    remove: vi.fn(),
    testConnection: vi.fn(async () => undefined),
    testSavedConnection: vi.fn(async () => undefined),
  },
}));

/**
 * **On the Hosted instance a credential test runs from one of your Servers**
 * The API
 * refuses rclone and `docker login` on Cloudgate's own host there, so each
 * dialog asks which Server to test from and sends it; off the Hosted
 * instance (`probeFrom` `null`) it asks nothing and sends no `serverId`.
 */

const HOSTED: ProbeFrom = {
  options: [{ value: "srv-1", label: "worker-1", detail: "203.0.113.5" }],
  pending: false,
};

const registry: Registry = {
  registryId: "reg-1",
  name: "ui-registry",
  imagePrefix: "ui",
  username: "cgui",
  url: "127.0.0.1:5000",
  registryType: "selfHosted",
  createdAt: "2026-09-18T00:00:00Z",
  organizationId: "org-1",
};

const destination = {
  destinationId: "dest-1",
  name: "offsite",
  provider: "AWS",
  accessKey: "AKIAEXAMPLE",
  bucket: "backups",
  region: "us-east-1",
  endpoint: "https://s3.amazonaws.com",
  organizationId: "org-1",
  createdAt: "2026-09-18T00:00:00Z",
} as Destination;

const noop = async () => undefined;

const DIALOGS = [
  {
    name: "registry",
    render: (probeFrom: ProbeFrom | null) =>
      render(
        <ResourceFormModal
          spec={registrySpec(noop, probeFrom)}
          row={registry}
          open
          onOpenChange={() => {}}
        />,
      ),
    tested: () => vi.mocked(registriesApi.testSavedConnection),
    id: "reg-1",
  },
  {
    name: "destination",
    render: (probeFrom: ProbeFrom | null) =>
      render(
        <ResourceFormModal
          spec={destinationSpec(noop, probeFrom)}
          row={destination}
          open
          onOpenChange={() => {}}
        />,
      ),
    tested: () => vi.mocked(destinationsApi.testSavedConnection),
    id: "dest-1",
  },
] as const;

async function chooseServer(name: RegExp) {
  fireEvent.click(screen.getByRole("combobox"));
  await waitFor(() =>
    expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
  );
  const option = screen.getByRole("option", { name });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option, { detail: 1 });
}

const testButton = () =>
  screen.getByRole("button", { name: "Test connection" });

beforeEach(() => {
  vi.mocked(registriesApi.testSavedConnection).mockReset();
  vi.mocked(destinationsApi.testSavedConnection).mockReset();
});

afterEach(cleanup);

describe.each(DIALOGS)("the $name dialog's Test connection", (dialog) => {
  it("offers a Server picker on the Hosted instance, and no host", async () => {
    dialog.render(HOSTED);

    expect(screen.getByText("Test from")).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
        expect.stringContaining("worker-1"),
      ]),
    );
  });

  it("is off on the Hosted instance until a Server is chosen, and says why", () => {
    dialog.render(HOSTED);

    expect(testButton().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/Choose a Server to test from/)).toBeTruthy();
  });

  it("tests from the Server chosen", async () => {
    dialog.render(HOSTED);
    await chooseServer(/worker-1/);
    await waitFor(() =>
      expect(testButton().getAttribute("aria-disabled")).not.toBe("true"),
    );
    fireEvent.click(testButton());

    await waitFor(() =>
      expect(dialog.tested()).toHaveBeenCalledWith(dialog.id, "srv-1"),
    );
  });

  it("asks nothing and sends no Server off the Hosted instance", async () => {
    dialog.render(null);

    expect(screen.queryByText("Test from")).toBeNull();
    fireEvent.click(testButton());

    await waitFor(() =>
      expect(dialog.tested()).toHaveBeenCalledWith(dialog.id),
    );
  });
});

/**
 * The hook fails closed: until the instance mode is known the probe asks for a
 * Server rather than running on this host, which on the Hosted instance would
 * be `docker login` / rclone with the customer's credentials on the shared box.
 */
describe("useProbeServerPicker", () => {
  it("asks for a Server while the instance mode is still loading", () => {
    mode.data = undefined;
    expect(
      renderHook(() => useProbeServerPicker()).result.current,
    ).not.toBeNull();
  });

  it("asks for a Server on the Hosted instance", () => {
    mode.data = "hosted";
    expect(
      renderHook(() => useProbeServerPicker()).result.current,
    ).not.toBeNull();
  });

  it("asks nothing once the instance is known to be Self-hosted (counterpart)", () => {
    mode.data = "self-hosted";
    expect(renderHook(() => useProbeServerPicker()).result.current).toBeNull();
  });
});
