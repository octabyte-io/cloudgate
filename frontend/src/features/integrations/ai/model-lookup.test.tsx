import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResourceFormModal } from "@/components/console/resource-form-modal";
import type { AiModel, AiProvider } from "@/lib/api/endpoints/ai";

const models = vi.hoisted(() => vi.fn());

// The HTTP client is the boundary; the dialog, the spec and the form all run.
vi.mock("@/lib/api/endpoints/ai", async (original) => {
  const actual = await original<typeof import("@/lib/api/endpoints/ai")>();
  return { ...actual, aiApi: { ...actual.aiApi, models } };
});

const { aiSpec } = await import("./ai-spec");

/**
 * **The Add a provider dialog lists the endpoint's models itself, and what was
 * typed survives it**.
 *
 * The Model field's hint sent people to a "List models" card *below* the
 * dialog, behind its backdrop, and the only way there was Cancel — which
 * mounts a fresh form, so the name, the URL and the pasted key were all typed
 * again. These drive the real dialog from the real spec with `POST /ai/models`
 * stubbed, and assert the form still holds all three after the listing.
 */

const URL_ = "https://openrouter.ai/api/v1";
const KEY = "sk-or-v1-typed-once";

function model(id: string): AiModel {
  return { id, object: "model", created: 0, owned_by: "openrouter" };
}

function openDialog(row: AiProvider | null = null) {
  render(
    <ResourceFormModal
      spec={aiSpec(async () => undefined)}
      row={row}
      open
      onOpenChange={() => {}}
    />,
  );
}

function input(label: string): HTMLInputElement {
  return screen.getByLabelText(label, { selector: "input" });
}

/** What a screen reader reads as the input's description. */
function description(label: string): string {
  return (input(label).getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

function type(label: string, value: string) {
  fireEvent.change(input(label), { target: { value } });
}

afterEach(() => {
  cleanup();
  models.mockReset();
});

describe("ModelLookup", () => {
  it("lists the endpoint's models from inside the dialog, and the name, URL and key are still there afterwards", async () => {
    models.mockResolvedValue([
      model("nex-agi/nex-n2.5-mini:free"),
      model("google/gemma-4-31b-it:free"),
    ]);
    openDialog();
    type("Name", "ui-ai");
    type("API URL", URL_);
    type("API key", KEY);

    fireEvent.click(screen.getByRole("button", { name: "List models" }));
    const choice = await screen.findByRole("button", {
      name: "nex-agi/nex-n2.5-mini:free",
    });

    // Asked with what the dialog holds — nothing pasted a second time.
    expect(models).toHaveBeenCalledWith({ apiUrl: URL_, apiKey: KEY });
    expect(input("Name").value).toBe("ui-ai");
    expect(input("API URL").value).toBe(URL_);
    expect(input("API key").value).toBe(KEY);

    // The lookup sits under the field, not in its description: the model
    // names are not read out as part of what the Model box is.
    expect(description("Model")).not.toContain("nex-agi/nex-n2.5-mini:free");
    expect(description("Model")).not.toContain("google/gemma-4-31b-it:free");
    expect(choice.closest("[data-slot=field-description]")).toBeNull();

    fireEvent.click(choice);

    expect(input("Model").value).toBe("nex-agi/nex-n2.5-mini:free");
    expect(choice.getAttribute("aria-pressed")).toBe("true");
    // Picking a model changed the model and nothing else.
    expect(input("Name").value).toBe("ui-ai");
    expect(input("API key").value).toBe(KEY);
  });

  it("does not point at a control outside the dialog", () => {
    openDialog();

    const text = description("Model");

    expect(text).toContain("List models");
    expect(text).not.toMatch(/\bbelow\b/);
    // The control it names is in this dialog, beside the field it fills.
    const dialog = screen.getByRole("dialog");
    expect(
      dialog.contains(screen.getByRole("button", { name: "List models" })),
    ).toBe(true);
  });

  it("asks for the key on an edit rather than listing with nothing, and says why", () => {
    openDialog({
      aiId: "ai_1",
      name: "ui-ai",
      apiUrl: URL_,
      model: "nex-agi/nex-n2.5-mini:free",
      isEnabled: true,
      createdAt: "2026-09-18T00:00:00.000Z",
      organizationId: "org_1",
    });

    const button = screen.getByRole("button", { name: "List models" });
    fireEvent.click(button);

    expect(models).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/type its API key into the box above/)).toBeTruthy();
  });

  it("says what the endpoint refused, in the dialog, and keeps the form", async () => {
    const { ApiError } = await import("@/lib/api/api-error");
    models.mockRejectedValue(
      new ApiError(400, "Failed to fetch models: User not found", {
        path: "/ai/models",
      }),
    );
    openDialog();
    type("Name", "ui-ai");
    type("API URL", URL_);
    type("API key", KEY);

    fireEvent.click(screen.getByRole("button", { name: "List models" }));

    expect(
      await screen.findByText("Failed to fetch models: User not found."),
    ).toBeTruthy();
    expect(input("API key").value).toBe(KEY);
  });

  it("narrows a long list with a filter, and Enter in it does not submit the dialog", async () => {
    models.mockResolvedValue(
      Array.from({ length: 40 }, (_, index) => model(`vendor/model-${index}`)),
    );
    openDialog();
    type("Name", "ui-ai");
    type("API URL", URL_);
    type("API key", KEY);

    fireEvent.click(screen.getByRole("button", { name: "List models" }));
    const filter = await screen.findByRole("textbox", {
      name: "Filter models",
    });
    expect(screen.getByText(/And 16 more/)).toBeTruthy();

    fireEvent.change(filter, { target: { value: "model-37" } });
    // `fireEvent` answers false when a handler prevented the default — here,
    // the implicit submit of the provider form around the box.
    const defaultPrevented = !fireEvent.keyDown(filter, { key: "Enter" });

    expect(defaultPrevented).toBe(true);
    expect(
      screen.getByRole("button", { name: "vendor/model-37" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "vendor/model-1" })).toBeNull();
  });
});
