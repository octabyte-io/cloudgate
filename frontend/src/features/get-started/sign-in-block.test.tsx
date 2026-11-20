import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findOne = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org_1", pending: false }),
}));
vi.mock("@/lib/api/endpoints/compose", () => ({
  composeApi: { findOne },
}));

const { SignInBlock } = await import("./sign-in-block");

const FLATNOTES = {
  username: "FLATNOTES_USERNAME",
  password: "FLATNOTES_PASSWORD",
};

function show(signIn: Parameters<typeof SignInBlock>[0]["signIn"]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SignInBlock
        appName="flatnotes"
        signIn={signIn}
        address="https://notes.example.com"
        composeId="cmp_1"
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  findOne.mockResolvedValue({
    composeId: "cmp_1",
    env: "FLATNOTES_USERNAME=admin\nFLATNOTES_PASSWORD=s3cret-Pass\nDB_PASSWORD=dbpass\n",
  });
});

afterEach(() => {
  cleanup();
  findOne.mockReset();
});

describe("SignInBlock (#131)", () => {
  it("shows the account made at setup, its password masked until Show", async () => {
    show(FLATNOTES);

    expect(await screen.findByText("admin")).toBeTruthy();
    expect(findOne).toHaveBeenCalledWith("cmp_1");
    expect(screen.queryByText("s3cret-Pass")).toBeNull();
    expect(screen.getByText("Hidden. Choose Show to read it.")).toBeTruthy();
    // Only the inputs `signIn` names: never another generated password.
    expect(screen.queryByText("dbpass")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Copy the password/i }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByText("s3cret-Pass")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Hide" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("takes a fixed username from the template", async () => {
    show({ username: { value: "owner" }, password: "FLATNOTES_PASSWORD" });

    expect(await screen.findByText("owner")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show" })).toBeTruthy();
  });

  it("shows no password and no Show to a member the stack's read refuses", async () => {
    findOne.mockRejectedValue(new Error("Forbidden"));
    show(FLATNOTES);

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "How to sign in" }),
      ).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Show" })).toBeNull();
    expect(screen.queryByText("admin")).toBeNull();
  });

  it("shows only the password when the template names no username (#140)", async () => {
    show({ password: "FLATNOTES_PASSWORD" });

    expect(await screen.findByRole("button", { name: "Show" })).toBeTruthy();
    expect(screen.getByText("Password")).toBeTruthy();
    expect(screen.queryByText("Username")).toBeNull();
    expect(screen.queryByText("admin")).toBeNull();
  });

  it("points an account made at setup at its sign-in path (#140)", async () => {
    show({ ...FLATNOTES, path: "/admin" });

    expect(await screen.findByText("admin")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open /admin" }).getAttribute("href"),
    ).toBe("https://notes.example.com/admin");
  });

  it("opens the Domain an account made at setup names, at / without a path (#140)", async () => {
    show({ ...FLATNOTES, domain: "admin" });

    expect(await screen.findByText("admin")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open /" }).getAttribute("href"),
    ).toBe("https://notes.example.com/");
  });

  it("gives an account made at setup no Open link with neither a path nor a Domain", async () => {
    show(FLATNOTES);

    expect(await screen.findByText("admin")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("still points a member the stack's read refuses at the sign-in path, with no password (#140)", async () => {
    findOne.mockRejectedValue(new Error("Forbidden"));
    const { container } = show({ ...FLATNOTES, path: "/admin" });

    // After the refusal, not while the read is pending.
    await waitFor(() => expect(findOne).toHaveBeenCalled());
    await waitFor(() =>
      expect(container.querySelector('[data-slot="skeleton"]')).toBeNull(),
    );
    expect(
      (await screen.findByRole("link", { name: "Open /admin" })).getAttribute(
        "href",
      ),
    ).toBe("https://notes.example.com/admin");
    expect(
      screen.getByRole("heading", { name: "How to sign in" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show" })).toBeNull();
    expect(screen.queryByText("admin")).toBeNull();
  });

  it("points a first-visit sign-in at its path, reading no variables", () => {
    show({ firstVisit: { path: "/ghost" } });

    expect(
      screen.getByRole("link", { name: "Open /ghost" }).getAttribute("href"),
    ).toBe("https://notes.example.com/ghost");
    expect(findOne).not.toHaveBeenCalled();
  });
});
