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
import { usersApi, type UserProfile } from "@/lib/api/endpoints/users";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());
const instanceMode = vi.hoisted(() => ({
  data: "self-hosted" as "hosted" | "self-hosted",
}));

vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => instanceMode,
}));

// better-auth's session store, which `useInvalidate` reads at render for this
// card's mutation — replaced rather than driven.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { ProfileCard } = await import("./profile-card");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useActiveOrganizationId.mockReset();
  instanceMode.data = "self-hosted";
});

const profile = {
  id: "u1",
  firstName: "Ada",
  lastName: "",
  email: "ada@example.com",
  image: null,
} as UserProfile;

function mount(stored: UserProfile = profile) {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProfileCard profile={stored} />
    </QueryClientProvider>,
  );
  vi.spyOn(toast, "done").mockImplementation(() => "");
  vi.spyOn(toast, "error").mockImplementation(() => "");
  return vi.spyOn(usersApi, "updateMe").mockResolvedValue(stored);
}

const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

/**
 * The sign-in email is account security: changing it takes the current
 * password, which the card asks for only once the address has changed, and a
 * name edit neither asks for it nor sends the address at all.
 */
describe("ProfileCard", () => {
  it("asks for no password, and sends no email, for a name edit", async () => {
    const update = mount();

    expect(screen.queryByLabelText("Current password")).toBeNull();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Ada Lovelace" },
    });
    save();

    await waitFor(() => expect(update).toHaveBeenCalled());
    const sent = update.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ firstName: "Ada Lovelace" });
    expect(sent).not.toHaveProperty("email");
    expect(sent).not.toHaveProperty("currentPassword");
  });

  it("asks for the current password once the email changes, and refuses to save without it", async () => {
    const update = mount();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "Ada.King@Example.com" },
    });
    // The one spec password field that really is the sign-in password, so the
    // one that keeps the token that asks for it.
    expect(
      screen.getByLabelText("Current password").getAttribute("autocomplete"),
    ).toBe("current-password");
    save();

    expect(
      await screen.findByText("Enter your current password to change your email."),
    ).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it("sends the new email with the current password", async () => {
    const update = mount();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "Ada.King@Example.com" },
    });
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "the-password" },
    });
    save();

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      email: "Ada.King@Example.com",
      currentPassword: "the-password",
    });
  });

  it("does not treat a change of case alone as a new address", () => {
    mount();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "ADA@example.com" },
    });

    expect(screen.queryByLabelText("Current password")).toBeNull();
  });
});

/**
 * On the Hosted instance a new address applies only once the link sent to it
 * is opened, and the card says so instead of "changes immediately".
 */
describe("ProfileCard on the Hosted instance", () => {
  it("says where the confirmation link went, and that the old address still signs in", async () => {
    instanceMode.data = "hosted";
    const update = mount();
    update.mockResolvedValue({
      ...profile,
      pendingEmail: "ada.king@example.com",
    });

    expect(
      screen.getByText(/you keep signing in with this one until you open it/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "Ada.King@Example.com" },
    });
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "the-password" },
    });
    save();

    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith(
        "Your profile is saved. Open the link we sent to ada.king@example.com to start signing in with it.",
      ),
    );
  });

  it("keeps the Self-hosted wording when the instance is not hosted", () => {
    mount();

    expect(
      screen.getByText(/changes what\s+you sign in with immediately/),
    ).toBeTruthy();
  });
});
