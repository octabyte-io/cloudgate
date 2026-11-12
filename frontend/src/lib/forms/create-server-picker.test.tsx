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

import type { DeployTarget } from "@/lib/api/endpoints/environments";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => new Proxy({}, { get: () => vi.fn() }),
}));
const WEB_1 = {
  serverId: "srv_1",
  name: "web-1",
  ipAddress: "10.0.0.7",
  serverType: "deploy",
  boughtServer: null,
};
/** A Bought Server whose first Setup run is going (spec #1387). */
const BOUGHT_SETTING_UP = {
  serverId: "srv_2",
  name: "bought-1",
  ipAddress: "203.0.113.20",
  serverType: "deploy",
  boughtServer: { stage: "setting_up", deletesOn: null, deletedAt: null },
};
const servers = vi.hoisted(() => ({ data: [] as unknown[] }));
vi.mock("@/lib/api/use-servers", () => ({
  useServers: () => ({ data: servers.data, isPending: false }),
}));
const gpuCountsEach = vi.hoisted(() => vi.fn(() => new Map()));
vi.mock("@/lib/api/use-gpu", () => ({
  useGpuCountsEach: (...args: unknown[]) => gpuCountsEach(...(args as [])),
}));
const mode = vi.hoisted(() => ({
  data: "self-hosted" as "hosted" | "self-hosted" | undefined,
}));
vi.mock("@/lib/api/use-instance-mode", () => ({ useInstanceMode: () => mode }));

const { Modal } = await import("@/components/console/modal");
const { CreateApplicationModal } =
  await import("@/features/application/create/create-application-modal");
const { CreateAiModelModal } =
  await import("@/features/application/create/create-ai-model-modal");
const { CreateComposeModal } =
  await import("@/features/compose/create/create-compose-modal");
const { Details: DatabaseDetails } =
  await import("@/features/database/create/create-database-details");
const { CLOUD_TARGET_HINT } = await import("@/lib/forms/create-server-picker");

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const shared = {
  environmentId: "env_1",
  environmentName: "production",
  open: true,
  onOpenChange: vi.fn(),
};

const ON_HOST: DeployTarget = { kind: "platform-host" };
const IN_CLOUD: DeployTarget = {
  kind: "cloud",
  cloudAccountId: "ca_1",
  region: "eu-west-1",
};

/** Each Service create form with a Server picker, in an Environment. */
const FORMS: [string, (deployTarget: DeployTarget) => ReactNode][] = [
  [
    "Application",
    (deployTarget) => (
      <CreateApplicationModal {...shared} deployTarget={deployTarget} />
    ),
  ],
  [
    "AI model",
    (deployTarget) => (
      <CreateAiModelModal {...shared} deployTarget={deployTarget} />
    ),
  ],
  [
    "Compose stack",
    (deployTarget) => (
      <CreateComposeModal {...shared} deployTarget={deployTarget} />
    ),
  ],
  [
    "database",
    (deployTarget) => (
      <Modal open onOpenChange={vi.fn()}>
        <DatabaseDetails
          kind="postgres"
          environmentId="env_1"
          deployTarget={deployTarget}
          onBack={vi.fn()}
          onDone={vi.fn()}
        />
      </Modal>
    ),
  ],
];

/** The Server picker's options, opened the way a person opens it. */
async function serverOptions(placeholder: string): Promise<string[]> {
  const picker = screen
    .getAllByRole("combobox")
    .find((box) => box.textContent?.includes(placeholder));
  expect(picker).toBeDefined();
  fireEvent.click(picker!);
  await waitFor(() =>
    expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
  );
  return screen
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

beforeEach(() => {
  mode.data = "self-hosted";
  servers.data = [WEB_1];
  gpuCountsEach.mockClear();
});

afterEach(cleanup);

/**
 * Whether a form still asks for a Server in a cloud Environment. A Compose
 * stack there runs on its own Stack VM and asks for none (#1372, ADR-0070);
 * `create-compose-modal.test.tsx` holds that it shows no Server picker.
 */
function asksInCloud(name: string): boolean {
  return name !== "Compose stack";
}

/**
 * On the Hosted instance a create form offers only the Organization's own
 * Servers (ADR-0053): "This Cloudgate host" is left out, not greyed,
 * since the API refuses a Service there.
 */
describe.each(FORMS)("the %s create form", (name, form) => {
  it.each(
    (
      [
        ["a platform-host", ON_HOST],
        ["a cloud", IN_CLOUD],
      ] as const
    ).filter(([, target]) => target.kind !== "cloud" || asksInCloud(name)),
  )(
    "offers the Servers and no Cloudgate host on the Hosted instance, in %s Environment",
    async (_target, deployTarget) => {
      mode.data = "hosted";
      render(form(deployTarget), { wrapper: Wrapper });

      const options = await serverOptions("Choose a Server");

      expect(options.some((option) => option.includes("web-1"))).toBe(true);
      expect(
        options.some((option) => option.includes("This Cloudgate host")),
      ).toBe(false);
      expect(document.body.textContent).not.toContain("Cloudgate host");
    },
  );

  if (asksInCloud(name))
    it("asks for a Server or this Cloudgate host in a cloud Environment when self-hosted, rather than opening on the host", async () => {
      render(form(IN_CLOUD), { wrapper: Wrapper });

      const options = await serverOptions("Choose a Server");

      expect(options).toEqual(
        expect.arrayContaining([
          expect.stringContaining("This Cloudgate host"),
          expect.stringContaining("web-1"),
        ]),
      );
      expect(document.body.textContent).toContain(CLOUD_TARGET_HINT);
    });

  it("greys out a Bought Server that is still Setting up, saying so, and keeps the others choosable", async () => {
    mode.data = "hosted";
    servers.data = [WEB_1, BOUGHT_SETTING_UP];
    render(form(ON_HOST), { wrapper: Wrapper });

    await serverOptions("Choose a Server");

    const bought = screen.getByRole("option", { name: /bought-1/ });
    expect(bought.textContent).toContain("Setting up");
    expect(bought.getAttribute("aria-disabled")).toBe("true");
    // Not the address: the word is what says why it cannot be chosen.
    expect(bought.textContent).not.toContain("203.0.113.20");
    const own = screen.getByRole("option", { name: /web-1/ });
    expect(own.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("offers no Cloudgate host while the instance mode is still loading", async () => {
    mode.data = undefined;
    render(form(ON_HOST), { wrapper: Wrapper });

    const options = await serverOptions("Choose a Server");

    expect(
      options.some((option) => option.includes("This Cloudgate host")),
    ).toBe(false);
  });

  it("keeps offering this Cloudgate host when self-hosted (counterpart)", async () => {
    render(form(ON_HOST), { wrapper: Wrapper });

    const options = await serverOptions("This Cloudgate host");

    expect(options).toEqual(
      expect.arrayContaining([
        expect.stringContaining("This Cloudgate host"),
        expect.stringContaining("web-1"),
      ]),
    );
  });
});

it("reads no GPU counts for the platform host on the Hosted instance", () => {
  mode.data = "hosted";
  render(<CreateAiModelModal {...shared} deployTarget={ON_HOST} />, {
    wrapper: Wrapper,
  });

  expect(gpuCountsEach).toHaveBeenCalledWith(["srv_1"], true);
  expect(gpuCountsEach).not.toHaveBeenCalledWith(
    expect.arrayContaining([null]),
    true,
  );
});
