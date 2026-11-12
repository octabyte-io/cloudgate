import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GpuCounts } from "@/lib/api/endpoints/settings";

const push = vi.fn();
const create = vi.fn();
const done = vi.fn();
const errorToast = vi.fn();
const useGpuCountsEach = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("@/lib/api/endpoints/applications", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/applications")>()),
  applicationsApi: { create: (...args: unknown[]) => create(...args) },
}));

vi.mock("@/lib/api/use-servers", () => ({
  useServers: () => ({
    data: [
      { serverId: "srv-gpu", name: "gpu-1", ipAddress: "10.0.0.7" },
      { serverId: "srv-cpu", name: "web-1", ipAddress: "10.0.0.8" },
    ],
    isPending: false,
  }),
}));

// The counts-only read per host; what is under test is how the picker
// names each host from it, and that it asks for every host listed.
vi.mock("@/lib/api/use-gpu", () => ({
  useGpuCountsEach: (...args: unknown[]) => useGpuCountsEach(...args),
}));

vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ application: vi.fn() }),
}));

// A Self-hosted instance, so this Cloudgate host is offered: the picker fails
// closed while the mode is unknown.
vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => ({ data: "self-hosted" }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: {
    done: (...args: unknown[]) => done(...args),
    error: (...args: unknown[]) => errorToast(...args),
  },
}));

const { CreateAiModelModal } = await import("./create-ai-model-modal");

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function open(onOpenChange = vi.fn()) {
  render(
    <CreateAiModelModal
      environmentId="env_1"
      environmentName="production"
      deployTarget={{ kind: "platform-host" }}
      open
      onOpenChange={onOpenChange}
    />,
    { wrapper: Wrapper },
  );
  return onOpenChange;
}

const counts = (gpuSetup: GpuCounts["gpuSetup"], cards = 0, free = 0) => ({
  gpuSetup,
  cards,
  free,
});

beforeEach(() => {
  push.mockReset();
  create.mockReset();
  done.mockReset();
  errorToast.mockReset();
  useGpuCountsEach.mockReset().mockReturnValue(
    new Map<string | null, GpuCounts>([
      [null, counts("none")],
      ["srv-gpu", counts("card-id", 2, 1)],
      ["srv-cpu", counts("count", 1, 1)],
    ]),
  );
});

afterEach(cleanup);

/** Base UI's trigger opens on `mousedown`, so a bare `click` opens it. */
async function openServers() {
  fireEvent.click(screen.getAllByRole("combobox")[0]);
  await waitFor(() =>
    expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
  );
}

function choose(name: RegExp) {
  const option = screen.getByRole("option", { name });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option, { detail: 1 });
}

describe("CreateAiModelModal", () => {
  it("names each host in the Server picker with its cards and free count", async () => {
    open();

    expect(useGpuCountsEach).toHaveBeenCalledWith(
      [null, "srv-gpu", "srv-cpu"],
      true,
    );
    await openServers();
    expect(
      screen.getByRole("option", { name: /gpu-1 · 2 GPUs, 1 free/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: /web-1 · GPUs set up the old way/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", {
        name: /This Cloudgate host · no GPUs set up/,
      }),
    ).toBeTruthy();
  });

  it("creates the AI model with its facet on POST /applications and lands on its Model tab", async () => {
    create.mockResolvedValue({ applicationId: "app_9", name: "Assistant" });
    const onOpenChange = open();

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "  Assistant  " },
    });
    fireEvent.change(screen.getByLabelText(/^Model/), {
      target: { value: "smollm2:135m" },
    });
    fireEvent.change(screen.getByLabelText(/^GPUs/), {
      target: { value: "1" },
    });
    await openServers();
    choose(/gpu-1/);
    fireEvent.click(screen.getByRole("button", { name: "Create AI model" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "Assistant",
        environmentId: "env_1",
        serverId: "srv-gpu",
        gpus: 1,
        aiModel: { runtime: "ollama", model: "smollm2:135m" },
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).toHaveBeenCalledWith("/applications/app_9/model");
  });

  it("offers vLLM, and sends a Hugging Face token only with it", async () => {
    create.mockResolvedValue({ applicationId: "app_9", name: "Assistant" });
    open();
    // No token field on Ollama, which reads none.
    expect(screen.queryByLabelText(/^Hugging Face token/)).toBeNull();

    fireEvent.click(screen.getAllByRole("combobox")[1]);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "vLLM" })).toBeTruthy(),
    );
    choose(/^vLLM$/);
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Assistant" },
    });
    fireEvent.change(await screen.findByLabelText(/^Model/), {
      target: { value: "Qwen/Qwen2.5-0.5B-Instruct" },
    });
    const token = screen.getByLabelText(/^Hugging Face token/);
    // Not the console login a browser would fill into a password box.
    expect(token.getAttribute("autocomplete")).toBe("new-password");
    fireEvent.change(token, {
      target: { value: " hf_secret " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create AI model" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "Assistant",
        environmentId: "env_1",
        serverId: null,
        gpus: 0,
        aiModel: {
          runtime: "vllm",
          model: "Qwen/Qwen2.5-0.5B-Instruct",
          hfToken: "hf_secret",
        },
      }),
    );
  });

  it("offers llama.cpp, naming its model as a GGUF repo with a quant, and sends a Hugging Face token with it", async () => {
    create.mockResolvedValue({ applicationId: "app_9", name: "Assistant" });
    open();

    fireEvent.click(screen.getAllByRole("combobox")[1]);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "llama.cpp" })).toBeTruthy(),
    );
    choose(/^llama\.cpp$/);
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Assistant" },
    });
    const model = await screen.findByLabelText(/^Model/);
    expect(model.getAttribute("placeholder")).toBe(
      "ggml-org/gemma-3-1b-it-GGUF:Q4_K_M",
    );
    fireEvent.change(model, {
      target: { value: "ggml-org/gemma-3-1b-it-GGUF:Q4_K_M" },
    });
    fireEvent.change(screen.getByLabelText(/^Hugging Face token/), {
      target: { value: "hf_secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create AI model" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "Assistant",
        environmentId: "env_1",
        serverId: null,
        gpus: 0,
        aiModel: {
          runtime: "llama.cpp",
          model: "ggml-org/gemma-3-1b-it-GGUF:Q4_K_M",
          hfToken: "hf_secret",
        },
      }),
    );
  });

  it("refuses a missing model at the field, without calling the route", async () => {
    open();

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Assistant" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create AI model" }));

    expect(await screen.findByText("Name the model it serves.")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("stays open and toasts when the backend refuses", async () => {
    const refusal = Object.assign(new Error("too many GPUs"), { status: 400 });
    create.mockRejectedValue(refusal);
    const onOpenChange = open();

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Assistant" },
    });
    fireEvent.change(screen.getByLabelText(/^Model/), {
      target: { value: "smollm2:135m" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create AI model" }));

    await waitFor(() => expect(errorToast).toHaveBeenCalledWith(refusal));
    expect(push).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
