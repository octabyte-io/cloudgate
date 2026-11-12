import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mutateAsync = vi.fn();

vi.mock("./use-account", () => ({
  useCreateApiKey: () => ({ isPending: false, mutateAsync }),
}));

const { CreateApiKeyModal } = await import("./create-api-key-modal");

const NINETY_DAYS = 90 * 24 * 60 * 60;
const NEVER_WARNING = /never expires/i;

/** Base UI's trigger opens on `mousedown`, so a bare click is what opens it. */
async function chooseExpiry(name: RegExp) {
  fireEvent.click(screen.getByRole("combobox"));
  await waitFor(() =>
    expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
  );
  const option = screen.getByRole("option", { name });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option, { detail: 1 });
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
}

async function submitNamed(name: string) {
  fireEvent.change(screen.getByRole("textbox", { name: /^Name/ }), {
    target: { value: name },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create key" }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({ id: "k1", key: "cg_secret" });
});

afterEach(cleanup);

/**
 * A new personal key defaults to 90 days, and Never — still offered —
 * says what it costs before it is chosen. The request is the assertion, not
 * the trigger's text, because what the dialog *sends* is the expiry the key
 * gets.
 */
describe("CreateApiKeyModal", () => {
  it("sends a 90-day expiry when the expiry is left alone", async () => {
    render(<CreateApiKeyModal open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("combobox").textContent).toMatch(/90 days/);
    expect(screen.queryByText(NEVER_WARNING)).toBeNull();
    await submitNamed("Deploy pipeline");

    expect(mutateAsync).toHaveBeenCalledWith({
      name: "Deploy pipeline",
      prefix: undefined,
      expiresIn: NINETY_DAYS,
    });
  });

  it("warns once Never is chosen, and still sends no expiry", async () => {
    render(<CreateApiKeyModal open onOpenChange={vi.fn()} />);

    await chooseExpiry(/^Never$/);
    expect(screen.getByText(NEVER_WARNING)).toBeDefined();
    await submitNamed("Laptop");

    expect(mutateAsync).toHaveBeenCalledWith({
      name: "Laptop",
      prefix: undefined,
      expiresIn: undefined,
    });
  });

  it("closes the reveal only on I have copied it, not on Escape", async () => {
    const onOpenChange = vi.fn();
    render(<CreateApiKeyModal open onOpenChange={onOpenChange} />);
    await submitNamed("Laptop");
    await waitFor(() => expect(screen.getByText("cg_secret")).toBeDefined());

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("still closes the request form on Escape", () => {
    const onOpenChange = vi.fn();
    render(<CreateApiKeyModal open onOpenChange={onOpenChange} />);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("leaves Create key on and says an empty name needs one, under Name", async () => {
    render(<CreateApiKeyModal open onOpenChange={() => undefined} />);
    const submit = screen.getByRole("button", { name: "Create key" });
    expect(submit.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(submit);
    expect(
      await screen.findByText("Name the key after what will use it."),
    ).toBeDefined();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
