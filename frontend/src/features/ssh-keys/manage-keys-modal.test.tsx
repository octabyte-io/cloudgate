import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/console/toast";
import { ApiError } from "@/lib/api/api-error";

/**
 * **A pasted key the backend cannot use is refused on its field**.
 *
 * `POST /ssh-keys` now parses both halves and checks they are one pair, and
 * answers a 400 whose issues name `publicKey` or `privateKey`. What is pinned
 * here is the other half of that: the sentence lands beside the textarea the
 * operator has to fix, and is not a toast that disappears with the reason.
 * The issue messages are `backend/test/ssh-keys/ssh-key-pair.spec.ts`'s.
 */

const mutateAsync = vi.fn();

// Two boundaries: the key list and the create, which are HTTP, and the toast,
// which renders through a portal nothing here reads.
/**
 * `usePermission`'s verdict, held by statement. Everything is held
 * unless a case takes it away; the decision itself is pinned in
 * `use-permission.test.ts`.
 */
const refused = vi.hoisted(() => ({ current: new Set<string>() }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: (required: Record<string, string[]>) => ({
    allowed: Object.entries(required).every(([resource, actions]) =>
      actions.every((action) => !refused.current.has(`${resource}:${action}`)),
    ),
    pending: false,
    role: "member",
  }),
}));

vi.mock("./use-ssh-keys", () => ({
  useSshKeys: () => ({ data: [], isPending: false, error: null }),
  useCreateSshKey: () => ({ mutateAsync }),
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { ManageKeysModal } = await import("./manage-keys-modal");

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
  vi.mocked(toast.done).mockClear();
  vi.mocked(toast.error).mockClear();
});

function paste(publicKey: string, privateKey: string) {
  render(<ManageKeysModal open onOpenChange={() => {}} servers={[]} />);
  fireEvent.change(screen.getByLabelText(/^Name/), {
    target: { value: "ui-garbage" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Paste one I have" }));
  fireEvent.change(screen.getByLabelText(/^Public key/), {
    target: { value: publicKey },
  });
  fireEvent.change(screen.getByLabelText(/^Private key/), {
    target: { value: privateKey },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add key" }));
}

describe("ManageKeysModal — Paste one I have", () => {
  it.each([
    [
      "publicKey",
      /^Public key/,
      "This is not an SSH public key. Paste the one line that starts ssh-ed25519 or ssh-rsa",
    ],
    [
      "privateKey",
      /^Private key/,
      "This private key does not belong to that public key",
    ],
  ])(
    "marks the backend's refusal of %s on that field, not in a toast",
    async (path, label, message) => {
      mutateAsync.mockRejectedValue(
        new ApiError(400, "Validation failed", { issues: [{ path, message }] }),
      );

      paste("hello this is not a key", "garbage-private-half");

      await waitFor(() =>
        expect(screen.getByLabelText(label).getAttribute("aria-invalid")).toBe(
          "true",
        ),
      );
      expect(document.body.textContent).toContain(`${message}.`);
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.done).not.toHaveBeenCalled();
    },
  );
});
