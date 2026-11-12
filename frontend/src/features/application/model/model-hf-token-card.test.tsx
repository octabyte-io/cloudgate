import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiModel } from "@/lib/api/endpoints/applications";

const usePermission = vi.hoisted(() => vi.fn());

// The caller's effective statements are the boundary; the card is real.
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { ModelHfTokenCard } = await import("./model-hf-token-card");

const VLLM: AiModel = {
  runtime: "vllm",
  model: "Qwen/Qwen2.5-0.5B-Instruct",
  imageTag: "v0.11.0",
  pin: "v0.11.0",
  offPin: false,
  hasHfToken: false,
  endpoint: "https://cloud.example.test/ai/app-1/v1",
};

function mount(hasHfToken: boolean) {
  usePermission.mockReturnValue({ allowed: true, pending: false, role: "owner" });
  const save = vi.fn().mockResolvedValue({});
  render(<ModelHfTokenCard facet={{ ...VLLM, hasHfToken }} save={save} />);
  return save;
}

afterEach(() => {
  cleanup();
  usePermission.mockReset();
});

/**
 * The Model tab's Hugging Face token: write-only, so the card says
 * only whether one is set, opens empty, and replaces it through
 * `PATCH /applications/:id`.
 */
describe("ModelHfTokenCard", () => {
  it("says not set, and opens an empty token field", () => {
    mount(false);

    expect(screen.getByText("Not set")).toBeTruthy();
    const field = screen.getByLabelText(/^Token/) as HTMLInputElement;
    expect(field.value).toBe("");
    // Not the console login a browser would fill into a password box.
    expect(field.getAttribute("autocomplete")).toBe("new-password");
  });

  it("says set, and replaces it with what is typed", async () => {
    const save = mount(true);

    expect(screen.getByText("Set")).toBeTruthy();
    const field = screen.getByLabelText(/^Replace token/) as HTMLInputElement;
    expect(field.value).toBe("");
    fireEvent.change(field, { target: { value: "hf_new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ aiModel: { hfToken: "hf_new" } }),
    );
  });

  it("removes a set token by sending an empty one", async () => {
    const save = mount(true);

    fireEvent.click(screen.getByRole("button", { name: "Remove token" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ aiModel: { hfToken: "" } }),
    );
  });

  it("offers no removal when no token is set", () => {
    mount(false);

    expect(screen.queryByRole("button", { name: "Remove token" })).toBeNull();
  });

  it("refuses an empty token at the field", async () => {
    const save = mount(true);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Paste the token to set.")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });
});
