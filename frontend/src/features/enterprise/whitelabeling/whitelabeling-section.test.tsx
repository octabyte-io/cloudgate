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
import { settingsApi } from "@/lib/api/endpoints/settings";
import { whitelabelingApi } from "@/lib/api/endpoints/whitelabeling";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());
const useLicenseStatus = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

// better-auth's session store, which `useInvalidate` reads for the save.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

// `GET /license/status`, at the hook `LicenseGate` reads it through.
vi.mock("@/features/enterprise/use-license", () => ({ useLicenseStatus }));

// A Self-hosted instance, where the lock points at a license.
vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => ({ data: "self-hosted", isPending: false }),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const { WhitelabelingSection } = await import("./whitelabeling-section");

const STORED = {
  appName: "Acme Deploy",
  logoUrl: null,
  faviconUrl: "https://cdn.example.test/acme.ico",
  primaryColor: null,
  accentColor: null,
  customCss: null,
  errorPages: {
    notFoundMessage: null,
    serverErrorMessage: null,
    supportUrl: null,
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useActiveOrganizationId.mockReset();
  useLicenseStatus.mockReset();
  refresh.mockReset();
});

/**
 * `GET /settings/infrastructure-health` — the instance-authority read the
 * Save buttons take their gate from. Answered by default, as it is for an
 * owner or admin of the instance organization.
 */
function mount(
  licensed: boolean,
  health: () => Promise<never> = () => Promise.resolve({} as never),
  report: { status?: string; validUntil?: string | null } = {},
) {
  vi.spyOn(settingsApi, "infrastructureHealth").mockImplementation(health);
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  useLicenseStatus.mockReturnValue({
    data: { licensed, ...report },
    isPending: false,
    error: null,
  });
  const get = vi.spyOn(whitelabelingApi, "get").mockResolvedValue(STORED);

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <WhitelabelingSection />
    </QueryClientProvider>,
  );
  return { get };
}

/**
 * **The Branding screen**: white-labeling was licence-gated in the
 * backend and reachable from nowhere in the console.
 */
describe("WhitelabelingSection", () => {
  it("shows an unlicensed Organization the lock every licensed section shows, and none of the form", () => {
    const { get } = mount(false);

    const text = document.body.textContent ?? "";
    expect(text).toContain("White-labeling puts your own name");
    // `LicenseLocked`'s own sentence — the one Single sign-on, Forward auth
    // and Roles carry word for word.
    expect(text).toContain("Your enterprise license does not cover it.");
    expect(
      screen.getByRole("link", { name: "Go to License" }).getAttribute("href"),
    ).toBe("/settings/license");
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    // The gate renders nothing of the feature, so it asks nothing of it either.
    expect(get).not.toHaveBeenCalled();
  });

  // A lapse refuses the edit but keeps the row, and every page still
  // renders it — so the lock's "nothing of the feature" would be untrue.
  it("shows a lapsed license's saved branding read-only, with every Save off and why", async () => {
    const { get } = mount(false, undefined, {
      status: "active",
      validUntil: "2026-08-01T00:00:00.000Z",
    });
    const update = vi.spyOn(whitelabelingApi, "update");

    const name = await screen.findByLabelText(/^Name/);
    expect((name as HTMLInputElement).value).toBe("Acme Deploy");
    expect(get).toHaveBeenCalled();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Branding is read-only");
    expect(text).toContain("The branding stays as last saved");
    expect(text).not.toContain("Your enterprise license does not cover it.");
    const saves = screen.getAllByRole("button", { name: "Save changes" });
    expect(saves).toHaveLength(4);
    for (const save of saves) {
      expect(save.getAttribute("aria-disabled")).toBe("true");
      expect(save.getAttribute("title")).toContain("The license lapsed on");
    }
    fireEvent.submit(name.closest("form")!);
    expect(
      await screen.findAllByText("The branding stays as last saved", {
        exact: false,
      }),
    ).not.toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps the lock for a key the license server refused, which is not a lapse", () => {
    mount(false, undefined, {
      status: "invalid",
      validUntil: "2026-08-01T00:00:00.000Z",
    });

    expect(document.body.textContent).toContain(
      "Your enterprise license does not cover it.",
    );
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("opens every field at its stored value once the license covers it", async () => {
    mount(true);

    const name = await screen.findByLabelText(/^Name/);
    expect((name as HTMLInputElement).value).toBe("Acme Deploy");
    expect(
      (screen.getByLabelText(/^Favicon URL/) as HTMLInputElement).value,
    ).toBe("https://cdn.example.test/acme.ico");
    for (const label of [
      /^Logo URL/,
      /^Primary/,
      /^Accent/,
      /^CSS/,
      /^Page not found/,
      /^Page failed/,
      /^Support URL/,
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });

  it("clears an emptied field with null and sends nothing it did not change", async () => {
    mount(true);
    const update = vi
      .spyOn(whitelabelingApi, "update")
      .mockResolvedValue({ ...STORED, appName: null });
    vi.spyOn(toast, "done").mockImplementation(() => "");

    fireEvent.change(await screen.findByLabelText(/^Name/), {
      target: { value: "" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save changes" })[0]!,
    );

    await waitFor(() => expect(update).toHaveBeenCalledWith({ appName: null }));
    // The title and favicon are server-resolved metadata; the refresh is what
    // re-resolves them.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("refuses a color that is not hex before sending it", async () => {
    mount(true);
    const update = vi.spyOn(whitelabelingApi, "update");

    fireEvent.change(await screen.findByLabelText(/^Primary/), {
      target: { value: "blue" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save changes" })[1]!,
    );

    expect(
      await screen.findByText("A hex color: # and three or six digits."),
    ).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it("turns every Save off, with the refusal's sentence, for a caller refused instance authority", async () => {
    // `errorMessage`'s words for an uncoded 403, which is what the read says.
    const refusal = "does not allow this";
    mount(true, () =>
      Promise.reject(
        new ApiError(403, "Forbidden resource", {
          path: "/settings/infrastructure-health",
        }),
      ),
    );
    const update = vi.spyOn(whitelabelingApi, "update");

    await screen.findByLabelText(/^Name/);
    await waitFor(() => {
      const saves = screen.getAllByRole("button", { name: "Save changes" });
      expect(saves).toHaveLength(4);
      for (const save of saves) {
        expect(save.getAttribute("aria-disabled")).toBe("true");
        expect(save.getAttribute("title")).toContain(refusal);
      }
    });
    // The fields stay readable and editable; only the save is not theirs.
    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    expect(name.disabled).toBe(false);
    fireEvent.change(name, { target: { value: "Other" } });
    fireEvent.submit(name.closest("form")!);
    expect(await screen.findByText(refusal, { exact: false })).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it("leaves every Save live for a caller the instance-authority read answered", async () => {
    mount(true);

    await screen.findByLabelText(/^Name/);
    await waitFor(() =>
      expect(settingsApi.infrastructureHealth).toHaveBeenCalled(),
    );
    for (const save of screen.getAllByRole("button", {
      name: "Save changes",
    })) {
      expect(save.getAttribute("aria-disabled")).not.toBe("true");
    }
  });
});
