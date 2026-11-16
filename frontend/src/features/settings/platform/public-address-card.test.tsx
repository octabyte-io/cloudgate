import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/console/toast";
import { ApiError } from "@/lib/api/api-error";
import {
  PUBLIC_ADDRESS_UNVERIFIED_CODE,
  settingsApi,
} from "@/lib/api/endpoints/settings";

// better-auth's session store, which `useInvalidate` reads for the mutation.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

// The instance gate is read off the health query; an owner here.
vi.mock("./use-platform", async (original) => ({
  ...(await original<typeof import("./use-platform")>()),
  useInstanceGate: () => ({ allowed: true }),
}));

const { PublicAddressCard } = await import("./public-address-card");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(value: string | null = null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PublicAddressCard value={value} />
    </QueryClientProvider>,
  );
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText(/IP address/), { target: { value } });
}

const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

/**
 * Settings > Instance's public address: an IP and nothing else, and one this
 * server does not know as its own saved only once the operator says so.
 */
describe("PublicAddressCard", () => {
  it("saves an IP address", async () => {
    mount();
    const update = vi
      .spyOn(settingsApi, "updateIp")
      .mockResolvedValue({} as never);
    vi.spyOn(toast, "done").mockImplementation(() => "");

    type("93.184.216.34");
    save();

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("93.184.216.34", false),
    );
  });

  it("refuses a hostname before asking the backend, pointing at Console domain", async () => {
    mount();
    const update = vi.spyOn(settingsApi, "updateIp");

    type("cloud.example.com");
    save();

    await waitFor(() =>
      expect(document.body.textContent ?? "").toContain(
        "An IP address, such as 203.0.113.10. For a hostname, use Console domain below.",
      ),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("offers Save it anyway for an address the server does not know, and sends it confirmed", async () => {
    mount();
    vi.spyOn(toast, "error").mockImplementation(() => "");
    vi.spyOn(toast, "done").mockImplementation(() => "");
    const update = vi
      .spyOn(settingsApi, "updateIp")
      .mockRejectedValueOnce(
        new ApiError(409, "192.0.2.99 is not an address this server knows", {
          code: PUBLIC_ADDRESS_UNVERIFIED_CODE,
        }),
      )
      .mockResolvedValueOnce({} as never);

    expect(screen.queryByRole("switch", { name: /Save it anyway/ })).toBeNull();
    type("192.0.2.99");
    save();

    const anyway = await screen.findByRole("switch", {
      name: /Save it anyway/,
    });
    fireEvent.click(anyway);
    save();

    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenLastCalledWith("192.0.2.99", true);
  });

  it("takes the switch away when a different address is typed", async () => {
    mount();
    vi.spyOn(toast, "error").mockImplementation(() => "");
    vi.spyOn(settingsApi, "updateIp").mockRejectedValue(
      new ApiError(409, "not this server's", {
        code: PUBLIC_ADDRESS_UNVERIFIED_CODE,
      }),
    );

    type("192.0.2.99");
    save();
    await screen.findByRole("switch", { name: /Save it anyway/ });

    type("192.0.2.100");

    expect(screen.queryByRole("switch", { name: /Save it anyway/ })).toBeNull();
  });
});
