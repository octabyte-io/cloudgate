import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import { traefikApi, type DnsChallengeSetup } from "@/lib/api/endpoints/traefik";
import type { Gate } from "@/lib/auth/use-permission";

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { DnsChallengeCard } = await import("./dns-challenge-card");

const ALLOWED: Gate = { allowed: true, refusal: "" };
const REFUSAL = "Only an administrator of this Cloudgate instance can do this.";
const SECRET = "cf-token-that-must-never-render";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The route is the boundary: `traefikApi`'s three DNS-01 calls are spied, the
 * card, its query and its form are real.
 */
async function mount({
  setup,
  serverId = null,
  gate = ALLOWED,
}: {
  setup: DnsChallengeSetup | null;
  serverId?: string | null;
  gate?: Gate;
}) {
  const read = vi.spyOn(traefikApi, "dnsChallenge").mockResolvedValue(setup);
  const write = vi
    .spyOn(traefikApi, "writeDnsChallenge")
    .mockResolvedValue({ provider: "cloudflare", credentialKeys: ["CF_DNS_API_TOKEN"] });
  const remove = vi.spyOn(traefikApi, "removeDnsChallenge").mockResolvedValue(undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DnsChallengeCard serverId={serverId} gate={gate} />
    </QueryClientProvider>,
  );
  await screen.findByLabelText("DNS provider");
  return { read, write, remove, save: screen.getByRole("button", { name: "Save DNS-01 setup" }) };
}

const STORED: DnsChallengeSetup = {
  provider: "cloudflare",
  credentialKeys: ["CF_DNS_API_TOKEN", "CF_ZONE_API_TOKEN"],
};

describe("DnsChallengeCard — a stored setup", () => {
  it("shows each stored key as set, with no value input and no value", async () => {
    await mount({ setup: STORED });

    const stored = screen.getByRole("list", { name: "Stored credentials" });
    expect(stored.textContent).toContain("CF_DNS_API_TOKEN");
    expect(stored.textContent).toContain("CF_ZONE_API_TOKEN");
    expect(stored.textContent).toContain("set");
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect((screen.getByLabelText("DNS provider") as HTMLInputElement).value).toBe("cloudflare");
  });

  it("opens replacement rows with the stored keys and empty password values", async () => {
    await mount({ setup: STORED });
    fireEvent.click(screen.getByRole("button", { name: "Replace credentials" }));

    expect((screen.getByLabelText("Key 1") as HTMLInputElement).value).toBe("CF_DNS_API_TOKEN");
    expect((screen.getByLabelText("Key 2") as HTMLInputElement).value).toBe("CF_ZONE_API_TOKEN");
    for (const label of ["Value 1", "Value 2"]) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect(input.type).toBe("password");
      expect(input.value).toBe("");
    }
  });

  it("omits credentials on a save that left them untouched, so the stored ones stay", async () => {
    const { write, save } = await mount({ setup: STORED, serverId: "srv-1" });
    fireEvent.change(screen.getByLabelText("DNS provider"), { target: { value: "route53" } });
    fireEvent.click(save);

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const [body] = write.mock.calls[0];
    expect(body).toEqual({ provider: "route53", serverId: "srv-1" });
    expect("credentials" in body).toBe(false);
  });

  it("sends the whole new map once the credentials are replaced, and never renders a value", async () => {
    const { write, save } = await mount({ setup: STORED });
    fireEvent.click(screen.getByRole("button", { name: "Replace credentials" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove credential 2" }));
    fireEvent.change(screen.getByLabelText("Value 1"), { target: { value: SECRET } });
    fireEvent.click(save);

    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({
        provider: "cloudflare",
        serverId: null,
        credentials: { CF_DNS_API_TOKEN: SECRET },
      }),
    );
    // Back to the stored keys, and the value typed went nowhere visible.
    await screen.findByRole("list", { name: "Stored credentials" });
    expect(document.body.textContent).not.toContain(SECRET);
    for (const input of document.querySelectorAll("input")) {
      expect(input.value).not.toBe(SECRET);
    }
  });

  it("refuses a replacement row with no value rather than sending an empty one", async () => {
    const { write, save } = await mount({ setup: STORED });
    fireEvent.click(screen.getByRole("button", { name: "Replace credentials" }));
    fireEvent.click(save);

    expect(await screen.findAllByText("Enter the value. Stored ones are not shown.")).toHaveLength(2);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("DnsChallengeCard — no setup yet", () => {
  it("sends the credentials it was given with the provider", async () => {
    const { write, save } = await mount({ setup: null });
    fireEvent.change(screen.getByLabelText("DNS provider"), { target: { value: "cloudflare" } });
    fireEvent.change(screen.getByLabelText("Key 1"), { target: { value: "CF_DNS_API_TOKEN" } });
    fireEvent.change(screen.getByLabelText("Value 1"), { target: { value: SECRET } });
    fireEvent.click(save);

    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({
        provider: "cloudflare",
        serverId: null,
        credentials: { CF_DNS_API_TOKEN: SECRET },
      }),
    );
  });

  it("offers no Remove when there is nothing to remove", async () => {
    await mount({ setup: null });
    expect(screen.queryByRole("button", { name: "Remove DNS-01 setup" })).toBeNull();
  });

  it("says the provider's rule before the backend does", async () => {
    const { write, save } = await mount({ setup: null });
    fireEvent.change(screen.getByLabelText("DNS provider"), { target: { value: "Cloud Flare" } });
    fireEvent.click(save);

    await screen.findByText(/A provider code is lowercase letters/);
    expect(write).not.toHaveBeenCalled();
  });
});

/**
 * `PutDnsChallengeDto`'s rules, each refused in the form rather than
 * round-tripped to a 400. A newline is not among the cases because an
 * `<input>` strips one from its own value before any rule sees it; a NUL it
 * keeps, and the rule refusing both is one test.
 */
describe("DnsChallengeCard — the backend's credential rules", () => {
  async function saveWith(key: string, value: string) {
    const { write, save } = await mount({ setup: null });
    fireEvent.change(screen.getByLabelText("DNS provider"), { target: { value: "cloudflare" } });
    fireEvent.change(screen.getByLabelText("Key 1"), { target: { value: key } });
    fireEvent.change(screen.getByLabelText("Value 1"), { target: { value } });
    fireEvent.click(save);
    return write;
  }

  it("refuses a key longer than 128 characters", async () => {
    const write = await saveWith(`A${"B".repeat(128)}`, SECRET);
    await screen.findByText(/at most 128 characters/);
    expect(write).not.toHaveBeenCalled();
  });

  it("admits a key of exactly 128 characters", async () => {
    const key = `A${"B".repeat(127)}`;
    const write = await saveWith(key, SECRET);
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith(
        expect.objectContaining({ credentials: { [key]: SECRET } }),
      ),
    );
  });

  it("refuses a value longer than 4096 characters", async () => {
    const write = await saveWith("CF_DNS_API_TOKEN", "x".repeat(4097));
    await screen.findByText("A value is at most 4096 characters.");
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a value carrying a NUL", async () => {
    const write = await saveWith("CF_DNS_API_TOKEN", "a\u0000b");
    await screen.findByText("A value is one line, with no line break or NUL.");
    expect(write).not.toHaveBeenCalled();
  });
});

describe("DnsChallengeCard — Remove", () => {
  it("confirms in the app's dialog, and shows the 409 naming the Applications in it", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const { remove } = await mount({ setup: STORED, serverId: "srv-1" });
    const message =
      "The DNS-01 setup is in use: turn off the Previews DNS-01 switch on web-app and docs first.";
    remove.mockRejectedValue(new ApiError(409, message));

    fireEvent.click(screen.getByRole("button", { name: "Remove DNS-01 setup" }));
    const dialog = await screen.findByRole("dialog");
    expect(remove).not.toHaveBeenCalled();
    const buttons = dialog.querySelectorAll("button");
    fireEvent.click(
      [...buttons].find((button) => button.textContent === "Remove DNS-01 setup") as HTMLElement,
    );

    await waitFor(() => expect(remove).toHaveBeenCalledWith("srv-1"));
    expect((await screen.findByRole("alert")).textContent).toContain("web-app and docs");
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("DnsChallengeCard — gate", () => {
  it("holds Save, Replace and Remove off with the reason, and a forced submit sends nothing", async () => {
    const { write, save } = await mount({
      setup: STORED,
      gate: { allowed: false, refusal: REFUSAL },
    });

    for (const button of [
      save,
      screen.getByRole("button", { name: "Replace credentials" }),
      screen.getByRole("button", { name: "Remove DNS-01 setup" }),
    ]) {
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toBe(REFUSAL);
    }

    fireEvent.submit(save.closest("form") as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(REFUSAL));
    expect(write).not.toHaveBeenCalled();
  });

  it("says a refused read in words instead of a form", async () => {
    vi.spyOn(traefikApi, "dnsChallenge").mockRejectedValue(new ApiError(403, "Forbidden"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <DnsChallengeCard serverId="srv-1" gate={ALLOWED} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByLabelText("DNS provider")).toBeNull();
  });
});
