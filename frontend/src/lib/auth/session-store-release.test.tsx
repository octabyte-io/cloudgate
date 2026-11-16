import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * **better-auth's session store lets go of the page before the next test.**
 *
 * `useSession()` mounts a nanostores atom, and unmounting the last reader does
 * not tear it down: nanostores waits a second (`STORE_UNMOUNT_DELAY`) in case
 * something mounts it again, and only then runs better-auth's cleanup, which
 * takes its listeners off `window`. A file whose last test ends inside that
 * second is torn down first, and the cleanup then runs against a `window` jsdom
 * has already removed: `ReferenceError: window is not defined`, an unhandled
 * error that reds the lane with every test green (#81).
 *
 * `vitest.console-setup.ts` releases the store after every test, so the
 * cleanup runs while the page is still there. This file is that setup's gate:
 * the first test leaves the store with no reader, and the second checks that by
 * the time it starts — far inside the second nanostores would have waited —
 * better-auth has already taken its `storage` listener off `window`.
 */

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Before the auth client is imported: `createAuthClient` captures `fetch` as
// the module evaluates (`organizations-section.test.tsx` says why at length).
vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve(
      json({
        session: { id: "session_1", userId: "user_1" },
        user: { id: "user_1", name: "Ursa", email: "ursa@example.test" },
      }),
    ),
  ),
);

const { authClient } = await import("@/lib/auth/client");

function SessionName() {
  const { data } = authClient.useSession();
  return <p data-testid="session-name">{data?.user.name ?? "none"}</p>;
}

const removed = vi.spyOn(window, "removeEventListener");

afterEach(() => {
  cleanup();
});

describe("better-auth's session store", () => {
  it("is read by a mounted component, which then unmounts", async () => {
    render(<SessionName />);
    await waitFor(() =>
      expect(screen.getByTestId("session-name").textContent).toBe("Ursa"),
    );
    expect(removed).not.toHaveBeenCalledWith("storage", expect.anything());
  });

  it("has taken its listener off the window by the next test", () => {
    expect(removed).toHaveBeenCalledWith("storage", expect.any(Function));
  });
});
