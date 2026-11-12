import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCommandShortcut } from "./palette-keys";

afterEach(cleanup);

/**
 * Collects anything a `window` listener throws.
 *
 * A listener that throws does not fail `dispatchEvent` — the DOM reports the
 * exception to the window and carries on — so the only way to see the throw
 * from the outside is to listen for the report.
 */
function collectListenerErrors(): string[] {
  const errors: string[] = [];
  const onError = (event: ErrorEvent) => {
    event.preventDefault();
    errors.push(event.error instanceof Error ? event.error.message : event.message);
  };
  window.addEventListener("error", onError);
  afterEach(() => window.removeEventListener("error", onError));
  return errors;
}

describe("useCommandShortcut", () => {
  it("survives a keydown that carries no key", () => {
    const errors = collectListenerErrors();
    const onOpenChange = vi.fn();
    renderHook(() => useCommandShortcut(onOpenChange));

    // Not a `KeyboardEvent`, on purpose: autofill, password managers, extensions
    // and automation all dispatch keydowns that carry no `key`.
    window.dispatchEvent(new Event("keydown", { bubbles: true, cancelable: true }));

    expect(errors).toEqual([]);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
