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
import { traefikApi } from "@/lib/api/endpoints/traefik";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// One system boundary, replaced rather than driven: better-auth's session
// store, which `useInvalidate` and the presence read both consult. The routes
// themselves are replaced at `traefikApi` below.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { LoggingCard } = await import("./logging-card");
const { useRequestLogging } = await import("../monitoring/use-monitoring");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useActiveOrganizationId.mockReset();
});

/** What `RequestsScreen` does with the read: the card is told `enabled`. */
function Screen() {
  const logging = useRequestLogging();
  return <LoggingCard logging={logging.data?.enabled === true} />;
}

/**
 * The card on a host with a traefik.yml, answering `enabled` per read — or,
 * given `listing`, whatever the directory walk answers instead.
 */
function mount(
  enabled: () => boolean,
  listing: () => Promise<Awaited<ReturnType<typeof traefikApi.directories>>> = () =>
    Promise.resolve([
      { id: "/etc/cloudgate/traefik/traefik.yml", name: "traefik.yml", type: "file" },
    ]),
) {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  vi.spyOn(traefikApi, "directories").mockImplementation(listing);
  vi.spyOn(traefikApi, "haveActivateRequests").mockImplementation(() =>
    Promise.resolve({ present: true, enabled: enabled() }),
  );
  const toggle = vi
    .spyOn(traefikApi, "toggleRequests")
    .mockResolvedValue({ written: true, restartRequired: true });

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Screen />
    </QueryClientProvider>,
  );
  return { toggle };
}

const text = () => document.body.textContent ?? "";

/**
 * The off state after **Turn off**.
 *
 * `accessLog` is Traefik's static configuration, so removing it changes nothing
 * until Traefik restarts — the toast already said so, and the card that
 * replaced the on state said "Traefik is running and is not recording
 * requests" while every request kept landing in the log. It also had no
 * Restart control; the on state did. The reverse direction of the presence fix.
 */
describe("LoggingCard", () => {
  it("does not claim Traefik has stopped recording straight after Turn off, and offers the restart", async () => {
    let enabled = true;
    const { toggle } = mount(() => enabled);

    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    enabled = false;
    await waitFor(() => expect(toggle).toHaveBeenCalledWith(false));
    await screen.findByText("Request logging is off");

    expect(text()).not.toContain("is not recording requests");
    expect(text()).toContain("still recording every request");
    expect(
      screen.getAllByRole("button", { name: "Restart Traefik" }).length,
    ).toBeGreaterThan(0);
  });

  it("stops saying Traefik is still recording once this card has restarted it", async () => {
    // The warning is keyed on this card's own Turn off, so the restart that
    // answers it has to clear it too — or the card goes on telling the operator
    // to do what they have just done, until the page is reloaded.
    let enabled = true;
    mount(() => enabled);
    const reload = vi.spyOn(traefikApi, "reloadTraefik").mockResolvedValue(true);

    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    enabled = false;
    await screen.findByText(/still recording every request/);

    fireEvent.click(screen.getAllByRole("button", { name: "Restart Traefik" })[0]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent === "Restart Traefik",
      )!,
    );

    await waitFor(() => expect(reload).toHaveBeenCalled());
    await waitFor(() =>
      expect(text()).not.toContain("still recording every request"),
    );
  });

  it("makes no claim about recording on an off state it did not just switch, and still offers the restart", async () => {
    mount(() => false);

    await screen.findByText("Request logging is off");

    // The console cannot see whether Traefik has restarted since somebody
    // else switched it off, so the steady state says what the file says.
    expect(text()).not.toContain("is not recording requests");
    expect(text()).not.toContain("still recording every request");
    expect(
      screen.getByRole("button", { name: "Restart Traefik" }),
    ).toBeDefined();
  });

  it("opens the same confirmation the on state uses before restarting anything", async () => {
    mount(() => false);
    const reload = vi.spyOn(traefikApi, "reloadTraefik").mockResolvedValue(true);

    fireEvent.click(
      await screen.findByRole("button", { name: "Restart Traefik" }),
    );

    await screen.findByText("Restart Traefik?");
    // Nothing was restarted on the way to being asked.
    expect(reload).not.toHaveBeenCalled();
  });

  it("names the reader's role, not the host, when listing the Traefik directory is refused", async () => {
    // The built-in member: `GET /settings/traefik/directories` answers 403 on
    // an install whose traefik.yml is right there.
    mount(
      () => true,
      () => Promise.reject(new ApiError(403, "Forbidden resource")),
    );

    const heading = await screen.findByRole("heading", { level: 2 });
    expect(heading.textContent).toBe(
      "Your role in this Organization does not allow this. Ask an owner or an admin to do it, or to change your role.",
    );
    expect(text()).not.toContain("There is no Traefik configuration");
    expect(text()).not.toContain("traefik.yml");
    expect(text()).not.toContain("setup");
  });

  it("says there is no Traefik configuration on a host whose directory is empty", async () => {
    mount(
      () => false,
      () => Promise.resolve([]),
    );

    expect(
      await screen.findByText("There is no Traefik configuration on this host"),
    ).toBeDefined();
  });

  it("says there is no Traefik configuration on a host whose directory is missing", async () => {
    mount(
      () => false,
      () => Promise.reject(new ApiError(404, "Not Found")),
    );

    expect(
      await screen.findByText("There is no Traefik configuration on this host"),
    ).toBeDefined();
  });

  it("claims neither absence nor a role when the directory walk fails for another reason", async () => {
    mount(
      () => true,
      () => Promise.reject(new ApiError(500, "Internal server error")),
    );

    expect(
      await screen.findByText(
        "Cloudgate could not tell whether this host has Traefik",
      ),
    ).toBeDefined();
    expect(text()).toContain("The backend hit an error handling that");
    expect(text()).not.toContain("There is no Traefik configuration");
    expect(text()).not.toContain("Your role");
    // And it does not offer a switch it cannot vouch for.
    expect(screen.queryByRole("button", { name: "Turn off" })).toBe(null);
  });
});
