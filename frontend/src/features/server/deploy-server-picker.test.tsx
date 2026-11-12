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

import type { AiSuggestion, EnabledAiProvider } from "@/lib/api/endpoints/ai";
import type { DeployTarget } from "@/lib/api/endpoints/environments";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => new Proxy({}, { get: () => vi.fn() }),
}));
vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org_1", pending: false }),
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/lib/api/use-servers", () => ({
  useServers: () => ({
    data: [
      {
        serverId: "srv_1",
        name: "web-1",
        ipAddress: "203.0.113.7",
        serverType: "deploy",
      },
    ],
    isPending: false,
  }),
}));
vi.mock("@/lib/api/use-projects", () => ({
  useProjects: () => ({ data: [], isPending: false }),
}));
vi.mock("@/features/environment/use-environments", () => ({
  useEnvironments: () => ({ data: [], isPending: false }),
}));
const mode = vi.hoisted(() => ({
  data: "self-hosted" as "hosted" | "self-hosted",
}));
vi.mock("@/lib/api/use-instance-mode", () => ({ useInstanceMode: () => mode }));

const ai = vi.hoisted(() => ({
  enabled: vi.fn(),
  list: vi.fn(),
  suggest: vi.fn(),
  deploy: vi.fn(),
}));
vi.mock("@/lib/api/endpoints/ai", async (original) => {
  const actual = await original<typeof import("@/lib/api/endpoints/ai")>();
  return { ...actual, aiApi: { ...actual.aiApi, ...ai } };
});

const { DraftServiceModal } =
  await import("@/features/integrations/ai/draft-service-modal");

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const SUGGESTION: AiSuggestion = {
  id: "whoami",
  name: "Whoami",
  shortDescription: "Answers with its own request",
  description: "A container that answers with its own request.",
  dockerCompose: "services:\n  app:\n    image: traefik/whoami:v1.10\n",
  envVariables: [],
  domains: [],
};

/** The AI draft dialog, driven to its last step: the file and where it goes. */
async function aiDeployStep(
  deployTarget: DeployTarget = { kind: "platform-host" },
) {
  ai.enabled.mockResolvedValue([
    { aiId: "ai_1", name: "ui-ai" },
  ] as unknown as EnabledAiProvider[]);
  ai.list.mockResolvedValue([]);
  ai.suggest.mockResolvedValue([SUGGESTION]);
  ai.deploy.mockResolvedValue({ composeId: "cmp_1" });
  render(
    <DraftServiceModal
      environmentId="env_1"
      environmentName="production"
      deployTarget={deployTarget}
      open
      onOpenChange={vi.fn()}
    />,
    { wrapper: Wrapper },
  );
  const prompt = await screen.findByRole("textbox");
  fireEvent.change(prompt, { target: { value: "a whoami container" } });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Ask for suggestions" }),
    ).not.toHaveProperty("disabled", true),
  );
  fireEvent.click(screen.getByRole("button", { name: "Ask for suggestions" }));
  fireEvent.click(await screen.findByText("Whoami"));
  await screen.findByRole("button", { name: "Create this stack" });
}

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

/** Each deploy form that reaches `compose.createByTemplate`. */
const FORMS: [string, () => Promise<void>][] = [
  ["AI deploy", aiDeployStep],
];

beforeEach(() => {
  mode.data = "self-hosted";
  for (const call of Object.values(ai)) call.mockReset();
});

afterEach(cleanup);

/**
 * On the Hosted instance the AI deploy form offers only the
 * Organization's own Servers (ADR-0053 seam 4), as the Service create
 * forms do: "This Cloudgate host" is left out, not greyed.
 */
describe.each(FORMS)("the %s form", (_name, open) => {
  it("offers the Servers and no Cloudgate host on the Hosted instance", async () => {
    mode.data = "hosted";
    await open();

    const options = await serverOptions("Choose a Server");

    expect(options.some((option) => option.includes("web-1"))).toBe(true);
    expect(
      options.some((option) => option.includes("This Cloudgate host")),
    ).toBe(false);
  });

  it("keeps offering this Cloudgate host when self-hosted (counterpart)", async () => {
    await open();

    const options = await serverOptions("This Cloudgate host");

    expect(options).toEqual(
      expect.arrayContaining([
        expect.stringContaining("This Cloudgate host"),
        expect.stringContaining("web-1"),
      ]),
    );
  });
});

describe("the AI deploy form's create", () => {
  it("sends the chosen Server", async () => {
    mode.data = "hosted";
    await aiDeployStep();
    await serverOptions("Choose a Server");
    fireEvent.click(
      screen
        .getAllByRole("option")
        .find((option) => option.textContent?.includes("web-1"))!,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create this stack" }));

    await waitFor(() =>
      expect(ai.deploy).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: "srv_1" }),
      ),
    );
  });

  it("sends this Cloudgate host as null when self-hosted", async () => {
    await aiDeployStep();

    fireEvent.click(screen.getByRole("button", { name: "Create this stack" }));

    await waitFor(() =>
      expect(ai.deploy).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: null }),
      ),
    );
  });

  describe("in a cloud Environment", () => {
    const inCloud: DeployTarget = {
      kind: "cloud",
      cloudAccountId: "ca_1",
      region: "eu-west-1",
    };

    it("opens on nothing chosen and sends no Server, which the API asks for", async () => {
      await aiDeployStep(inCloud);
      expect(
        screen
          .getAllByRole("combobox")
          .some((box) => box.textContent?.includes("Choose a Server")),
      ).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Create this stack" }));

      await waitFor(() => expect(ai.deploy).toHaveBeenCalled());
      expect(ai.deploy.mock.calls[0][0]).not.toHaveProperty("serverId");
    });

    it("offers this Cloudgate host, and sends it as null when picked on purpose", async () => {
      await aiDeployStep(inCloud);
      await serverOptions("Choose a Server");
      fireEvent.click(
        screen
          .getAllByRole("option")
          .find((option) =>
            option.textContent?.includes("This Cloudgate host"),
          )!,
      );

      fireEvent.click(screen.getByRole("button", { name: "Create this stack" }));

      await waitFor(() =>
        expect(ai.deploy).toHaveBeenCalledWith(
          expect.objectContaining({ serverId: null }),
        ),
      );
    });
  });
});
