import { toast as sonner } from "sonner";

import { isApiError } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";

export { Toaster } from "@/components/ui/sonner";

type ToastOptions = {
  /** A second, quieter line. Say what changed, not that something changed. */
  description?: string;
  /** One control. Anything that needs two controls needs a Modal. */
  action?: { label: string; onClick: () => void };
};

/**
 * A refusal a repository-kept Project config made (US56) links to the
 * file it points at, unless the caller gave the toast its own control. The
 * sentence already names the file and the branch.
 */
function withPointer(
  error: unknown,
  options: ToastOptions | undefined,
): ToastOptions | undefined {
  const fileUrl = isApiError(error) ? error.pointer?.fileUrl : null;
  if (!fileUrl || options?.action) return options;
  return {
    ...options,
    action: {
      label: "Open the file",
      onClick: () => window.open(fileUrl, "_blank", "noopener,noreferrer"),
    },
  };
}

/**
 * What the console says after it did something.
 *
 * The only reason this wraps sonner: **`toast.error` takes the error, not a
 * string.** `errorMessage()` is the one place a failure becomes a sentence a
 * person can act on, and routing every failure through here is what stops
 * `error.message` — written for whoever reads the logs — reaching a screen.
 *
 * A toast is for something that already happened and needs no answer. If the
 * person has to decide something, that is a Modal; if it is a field they got
 * wrong, that belongs beside the field.
 */
export const toast = {
  /** It worked. Name the thing that changed. */
  done(message: string, options?: ToastOptions) {
    return sonner.success(message, options);
  },

  /** Worth knowing, nothing went wrong. */
  info(message: string, options?: ToastOptions) {
    return sonner(message, options);
  },

  /** It worked, with a caveat someone should see. */
  warn(message: string, options?: ToastOptions) {
    return sonner.warning(message, options);
  },

  /**
   * It failed. Pass the thrown value straight in — an `ApiError`, a `TypeError`
   * from a backend that is not running, anything. Never pre-format it.
   */
  error(error: unknown, options?: ToastOptions) {
    return sonner.error(errorMessage(error), withPointer(error, options));
  },

  dismiss: sonner.dismiss,
};
