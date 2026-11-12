import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AiModel,
  ApplicationDetail,
} from "@/lib/api/endpoints/applications";

const usePermission = vi.hoisted(() => vi.fn());

// The caller's effective statements are the boundary; the card is real.
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { APPLICATION_SETTINGS_REFUSAL } = await import("../use-application");
const { ModelSettingsCard } = await import("./model-settings-card");

const ON_PIN: AiModel = {
  runtime: "ollama",
  model: "smollm2:135m",
  imageTag: "0.12.6",
  pin: "0.12.6",
  offPin: false,
  hasHfToken: false,
  endpoint: "https://cloud.example.test/ai/app-1/v1",
};

const application = (gpus = 1) =>
  ({ applicationId: "app-1", gpus }) as unknown as ApplicationDetail;

function mount(facet: AiModel = ON_PIN, allowed = true, gpus = 1) {
  usePermission.mockReturnValue({ allowed, pending: false, role: "owner" });
  const save = vi.fn().mockResolvedValue({});
  render(
    <ModelSettingsCard application={application(gpus)} facet={facet} save={save} />,
  );
  return save;
}

afterEach(() => {
  cleanup();
  usePermission.mockReset();
});

/**
 * The Model tab's settings: runtime read-only, model and image tag
 * editable through `PATCH /applications/:id`, the pin shown and an off-pin tag
 * marked, GPUs shown as reserved. Nothing the API locks on an AI model
 * is offered as a field.
 */
describe("ModelSettingsCard", () => {
  it("offers the model and the image tag, and nothing the platform owns", () => {
    mount();

    const fields = screen
      .getAllByRole("textbox")
      .map((input) => input.getAttribute("name"));
    expect(fields).toEqual(["model", "imageTag"]);
    // The runtime is a read-out, never a control.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Inference runtime")).toBeTruthy();
    expect(screen.getByText("Ollama")).toBeTruthy();
    expect(screen.getByText("1 per copy")).toBeTruthy();
  });

  it("says the model takes effect on the next deploy", () => {
    mount();
    expect(screen.getByText(/Takes effect on the next deploy/)).toBeTruthy();
  });

  it("shows the pin, and opens on it with an empty tag", () => {
    mount();

    expect(
      (screen.getByLabelText(/^Image tag/) as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByText("On the pin, 0.12.6")).toBeTruthy();
    expect(screen.queryByText("Off the pin")).toBeNull();
  });

  it("marks a tag off the pin, and still shows the pin", () => {
    mount({ ...ON_PIN, imageTag: "0.13.0", offPin: true });

    expect(
      (screen.getByLabelText(/^Image tag/) as HTMLInputElement).value,
    ).toBe("0.13.0");
    expect(screen.getAllByText("Off the pin").length).toBeGreaterThan(0);
    expect(screen.getByText(/tested with 0\.12\.6/)).toBeTruthy();
  });

  it("saves the model and the tag through the update route", async () => {
    const save = mount();

    fireEvent.change(screen.getByLabelText(/^Model/), {
      target: { value: "all-minilm" },
    });
    fireEvent.change(screen.getByLabelText(/^Image tag/), {
      target: { value: "0.13.0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        aiModel: { model: "all-minilm", imageTag: "0.13.0" },
      }),
    );
  });

  it("returns to the pin when the tag is emptied", async () => {
    const save = mount({ ...ON_PIN, imageTag: "0.13.0", offPin: true });

    fireEvent.change(screen.getByLabelText(/^Image tag/), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        aiModel: { model: "smollm2:135m", imageTag: null },
      }),
    );
  });

  it("turns Save off, with the reason, for a role without service update", () => {
    mount(ON_PIN, false);

    const button = screen.getByRole("button", { name: "Save changes" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(APPLICATION_SETTINGS_REFUSAL);
  });
});
