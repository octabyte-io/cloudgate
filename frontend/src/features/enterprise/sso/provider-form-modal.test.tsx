import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const redirectUri = vi.hoisted(() => vi.fn());
const register = vi.hoisted(() => vi.fn());
const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// Two system boundaries, both replaced rather than driven: the HTTP client, and
// better-auth's session store, which `useInvalidate` reads at render.
vi.mock("@/lib/api/endpoints/sso", async (original) => {
  const actual = await original<typeof import("@/lib/api/endpoints/sso")>();
  return {
    ...actual,
    ssoApi: { ...actual.ssoApi, redirectUri, register },
  };
});

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { ProviderFormModal } = await import("./provider-form-modal");

afterEach(() => {
  cleanup();
  redirectUri.mockReset();
  register.mockReset();
  useActiveOrganizationId.mockReset();
});

/**
 * The two things the Add dialog owes an operator before they press the button.
 *
 * **The redirect URI**.
 * The template deliberately names a host jsdom is not on: `window.location` here
 * is `localhost:3000`, so a URI built from it would be wrong on every install
 * reached through a domain — which is exactly the failure this pins. The path
 * half is pinned where it can drift, in
 * `backend/test/enterprise/sso/sso.e2e-spec.ts`, against the `redirect_uri` the
 * plugin actually hands the identity provider.
 *
 * **The trusted-origins gate**.
 * Registering consults the list, and saying so only in the refusal is what made
 * the first provider on a fresh install unaddable; the dialog now says it next
 * to the Issuer URL and offers to make the entry itself.
 */
const TEMPLATE = "https://console.example.com/api/auth/sso/callback/{providerId}";

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function addDialog(): Promise<HTMLInputElement> {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  redirectUri.mockResolvedValue(TEMPLATE);
  render(withQuery(<ProviderFormModal onClose={() => {}} />));
  return (await screen.findByLabelText("Provider id")) as HTMLInputElement;
}

/** Types a provider id and waits for the derived URI to appear. */
async function withProviderId(id: string): Promise<void> {
  const field = await addDialog();
  fireEvent.change(field, { target: { value: id } });
  await screen.findByText(`https://console.example.com/api/auth/sso/callback/${id}`);
}

describe("ProviderFormModal", () => {
  it("shows the backend's redirect URI as soon as an id is typed, with a way to copy it", async () => {
    await withProviderId("ui-dex");

    expect(window.location.origin).toBe("http://localhost:3000");
    expect(
      screen.getByRole("button", { name: "Copy the redirect URI" }),
    ).toBeTruthy();
    expect(document.body.textContent).toContain(
      "Add the redirect URI above to your identity provider’s allowed list, or the sign-in it sends people through will be refused at the last step.",
    );
  });

  it("follows the id as it is retyped, so a half-typed one is never left standing", async () => {
    await withProviderId("ui-dex");
    fireEvent.change(screen.getByLabelText("Provider id"), {
      target: { value: "ui-okta" },
    });

    await screen.findByText(
      "https://console.example.com/api/auth/sso/callback/ui-okta",
    );
    expect(document.body.textContent).not.toContain("callback/ui-dex");
  });

  it("says registration needs the issuer trusted, before the submit", async () => {
    await addDialog();

    expect(document.body.textContent).toContain(
      "Cloudgate reads its discovery document, which it will only fetch from a trusted origin.",
    );
    expect(
      (screen.getByRole("checkbox", { name: /trust this issuer/i }) as HTMLElement)
        .dataset.checked,
    ).toBe("");
  });

  it("registers with the issuer trusted in the same step, or without it when that is turned off", async () => {
    register.mockResolvedValue({ success: true });
    await withProviderId("ui-dex");

    const fill = () => {
      fireEvent.change(screen.getByLabelText("Issuer URL"), {
        target: { value: "https://dex.example.com" },
      });
      fireEvent.change(screen.getByLabelText("Email domains"), {
        target: { value: "example.com" },
      });
      fireEvent.change(screen.getByLabelText("Client id"), {
        target: { value: "cloudgate" },
      });
      fireEvent.change(screen.getByLabelText("Client secret"), {
        target: { value: "s3cret" },
      });
    };

    fill();
    fireEvent.click(screen.getByRole("button", { name: "Add the provider" }));
    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register.mock.calls[0][0]).toMatchObject({
      providerId: "ui-dex",
      issuer: "https://dex.example.com",
      trustIssuer: true,
    });

    fireEvent.click(screen.getByRole("checkbox", { name: /trust this issuer/i }));
    fireEvent.click(screen.getByRole("button", { name: "Add the provider" }));
    await waitFor(() => expect(register).toHaveBeenCalledTimes(2));
    expect(register.mock.calls[1][0].trustIssuer).toBeUndefined();
  });
});
