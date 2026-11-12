import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { useValidateLicense } from "../use-license";

const done = vi.fn();
const warn = vi.fn();
const error = vi.fn();

vi.mock("@/components/console/toast", () => ({
  toast: { done, warn, error },
}));

const { CheckKeyModal } = await import("./check-key-modal");

/**
 * That a check which **failed** never reads like a check which **refused**.
 *
 * The dialog has just told the operator that a refusal takes effect immediately
 * and costs them custom roles, single sign-on, SCIM and forward auth. So the one
 * thing these toasts must never do is leave "did my Organization just go dark?"
 * unanswered.
 *
 * `LicenseService.validate` runs its `update` after `callRemote` returns, so a
 * rejection of any class leaves the row untouched and only `200 {"valid":
 * false}` revokes. The case that matters most below is the third: a rejection
 * whose *message* is the licence server's own refusal, which is the one shape
 * where "refused" and "unchanged" are both true at once and the wording has to
 * carry the difference.
 */

const REVOKED = "This Organization is now unlicensed.";

/** `useValidateLicense`, with `mutateAsync` doing whatever the case needs. */
function validateThat(
  mutateAsync: () => Promise<boolean>,
): ReturnType<typeof useValidateLicense> {
  return { isPending: false, mutateAsync } as unknown as ReturnType<
    typeof useValidateLicense
  >;
}

/** Presses **Check the key** and waits for whichever toast it produced. */
async function check(mutateAsync: () => Promise<boolean>) {
  const onClose = vi.fn();
  render(<CheckKeyModal validate={validateThat(mutateAsync)} onClose={onClose} />);

  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent === "Check the key",
  );
  expect(button).toBeDefined();
  fireEvent.click(button!);

  await waitFor(() => {
    expect(done.mock.calls.length + warn.mock.calls.length + error.mock.calls.length).toBe(1);
  });
  return { onClose };
}

beforeEach(() => {
  done.mockClear();
  warn.mockClear();
  error.mockClear();
});

afterEach(cleanup);

describe("CheckKeyModal", () => {
  it("says the Organization is now unlicensed when a completed check comes back negative", async () => {
    await check(() => Promise.resolve(false));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(REVOKED));
    expect(error).not.toHaveBeenCalled();
  });

  it("confirms the key without claiming anything changed when the check passes", async () => {
    const { onClose } = await check(() => Promise.resolve(true));

    expect(done).toHaveBeenCalledWith("The license server confirmed this key.");
    expect(onClose).toHaveBeenCalled();
  });

  it("says a failed check recorded nothing rather than that the license was refused", async () => {
    await check(() =>
      Promise.reject(
        new ApiError(
          400,
          "Could not reach the license server. Check your connection or try again later.",
        ),
      ),
    );

    const [, options] = error.mock.calls[0] as [unknown, { description: string }];
    expect(options.description).toContain("nothing was recorded");
    // The sentence the dialog spent a warning box threatening must not appear.
    expect(options.description).not.toContain(REVOKED);
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * The case a reviewer caught: `LicenseApiClient`'s refusal class puts the word
   * *refused* into a **rejection**, beside a description saying the licence is
   * unchanged. Both are true — the write is downstream of the throw — and read
   * together they are a contradiction unless the description names the
   * mechanism. It does: the check did not complete.
   */
  it("does not let a refusal that arrived as an error read as a revocation", async () => {
    await check(() =>
      Promise.reject(
        new ApiError(
          400,
          "The license server refused this license key: Invalid license key.",
        ),
      ),
    );

    const [, options] = error.mock.calls[0] as [unknown, { description: string }];
    expect(options.description).toContain("The check did not complete");
    expect(options.description).not.toContain(REVOKED);
    // Nothing on this path went down the branch that actually revokes.
    expect(warn).not.toHaveBeenCalled();
  });

  it("words the refused-and-revoked outcome differently from the failed one", async () => {
    await check(() => Promise.resolve(false));
    const revoked = String(warn.mock.calls[0][0]);

    cleanup();
    warn.mockClear();

    await check(() =>
      Promise.reject(
        new ApiError(
          400,
          "The license server refused this license key: Invalid license key.",
        ),
      ),
    );
    const [, options] = error.mock.calls[0] as [unknown, { description: string }];

    expect(revoked).toContain(REVOKED);
    expect(options.description).not.toContain(REVOKED);
    expect(revoked).not.toEqual(options.description);
  });
});
