import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigLock } from "@/components/console/config-lock";
import type { WiredVariablesView } from "@/lib/api/endpoints/wired-variables";

const find = vi.fn();
const save = vi.fn();

vi.mock("@/lib/api/endpoints/wired-variables", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/wired-variables")>()),
  wiredVariablesApi: {
    find: (...args: unknown[]) => find(...args),
    save: (...args: unknown[]) => save(...args),
  },
}));

vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org_1" }),
}));

vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ application: vi.fn(), database: vi.fn() }),
}));

const { WiredVariablesCard } = await import("./wired-variables-card");
const { WiredChangedNotice } = await import("./wired-changed-notice");

const VIEW: WiredVariablesView = {
  serviceType: "application",
  serviceId: "app_1",
  configName: "web",
  keptIn: "cloudgate",
  editable: true,
  links: [{ name: "REDIS_URL", source: "redis", output: "url" }],
  wiredChangedAt: null,
  sources: [
    {
      configName: "pg-1",
      kind: "postgres",
      outputs: ["url", "host", "port", "user", "password", "database"],
    },
    { configName: "redis", kind: "redis", outputs: ["url", "password"] },
  ],
};

const LOCK: ConfigLock = {
  repository: "acme/shop",
  path: "cloudgate.yaml",
  branch: "main",
  fileUrl: "https://git.example/acme/shop/blob/c1/cloudgate.yaml",
  appliedCommit: "abcdef0123",
  stated: new Set(),
  listed: { env: [], build_args: [], build_secrets: [] },
};

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function show(lock: ConfigLock | null = null, allowed = true) {
  render(
    <WiredVariablesCard
      serviceType="application"
      serviceId="app_1"
      environmentId="env_1"
      typedNames={["NODE_ENV", "DATABASE_URL"]}
      lock={lock}
      gate={{ allowed, refusal: "Your role does not allow this." }}
    />,
    { wrapper: Wrapper },
  );
}

async function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  await waitFor(() =>
    expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
  );
  fireEvent.click(screen.getByRole("option", { name: new RegExp(option) }));
}

beforeEach(() => {
  find.mockReset().mockResolvedValue(VIEW);
  save.mockReset().mockResolvedValue(VIEW);
});

afterEach(cleanup);

describe("WiredVariablesCard", () => {
  it("reads a link as NAME ← source.output, with no value and nothing to type into", async () => {
    show();
    const row = await screen.findByText("REDIS_URL");
    const item = row.closest("li")!;
    expect(item.textContent).toContain("redis.url");
    expect(item.textContent).toContain("←");
    expect(item.querySelector("input, textarea")).toBeNull();
  });

  it("offers only the sources the API gives, and only the chosen kind's Outputs", async () => {
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: /Link a variable/ }),
    );
    await choose("From Service", "pg-1");
    fireEvent.click(screen.getByRole("combobox", { name: "Output" }));
    await waitFor(() =>
      expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "url",
      "host",
      "port",
      "user",
      "password",
      "database",
    ]);
  });

  it("switches a typed name to a link, saying the typed value goes, and saves the whole set", async () => {
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: /Link a variable/ }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Variable" }), {
      target: { value: "DATABASE_URL" },
    });
    await choose("From Service", "pg-1");
    await choose("Output", "^url$");

    expect(screen.getByRole("status").textContent).toContain(
      "typed value → pg-1.url",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Replace typed value with link" }),
    );
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith("application", "app_1", [
      { name: "REDIS_URL", source: "redis", output: "url" },
      { name: "DATABASE_URL", source: "pg-1", output: "url" },
    ]);
  });

  it("unlinks a variable as a Save of the rest", async () => {
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Unlink REDIS_URL" }),
    );
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith("application", "app_1", []),
    );
  });

  it("is read-only on a repository-kept config, naming the file", async () => {
    find.mockResolvedValue({
      ...VIEW,
      keptIn: "repository",
      editable: false,
      sources: [],
    });
    show(LOCK);
    await screen.findByText("REDIS_URL");
    expect(screen.queryByRole("button", { name: /Link a variable/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Unlink/ })).toBeNull();
    expect(screen.getByText("Set in cloudgate.yaml")).toBeDefined();
    expect(
      document.querySelector('[data-slot="config-lock"]')?.textContent,
    ).toContain("acme/shop");
  });

  it("keeps Link off, with the reason, for a role that cannot save", async () => {
    show(null, false);
    const link = await screen.findByRole("button", { name: /Link a variable/ });
    expect(link.getAttribute("aria-disabled")).toBe("true");
    expect(link.getAttribute("title")).toBe("Your role does not allow this.");
  });

  it("shows nothing for a Service with no links and nothing to link", async () => {
    find.mockResolvedValue({
      ...VIEW,
      keptIn: null,
      editable: false,
      links: [],
      sources: [],
    });
    show();
    await waitFor(() => expect(find).toHaveBeenCalled());
    expect(screen.queryByText("Wired variables")).toBeNull();
  });
});

describe("WiredChangedNotice", () => {
  it("says deploy to pick up the new value while a linked Output is marked changed", () => {
    render(<WiredChangedNotice wiredChangedAt="2026-10-17T00:00:00Z" />);
    expect(screen.getByText("Deploy to pick up the new value.")).toBeDefined();
  });

  it("says nothing once a deploy cleared it", () => {
    render(<WiredChangedNotice wiredChangedAt={null} />);
    expect(screen.queryByText("Deploy to pick up the new value.")).toBeNull();
  });
});
