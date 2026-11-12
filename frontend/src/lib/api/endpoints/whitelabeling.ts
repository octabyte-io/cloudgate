import { api } from "../client";

/**
 * `settings/settings.controller.ts` — the instance's branding, and the
 * console's only reader and writer of it.
 *
 * **Two routes with two different audiences, on purpose.** `GET` is `@Public()`:
 * the sign-in screen is the first page a white-labelled instance has to get
 * right, and nobody reading it has a session. `PATCH` asks two separate
 * questions, in order: does the caller hold *instance* authority — an
 * owner or admin of the instance organization — and does *the instance
 * organization* hold a licence. Neither is about the caller's active
 * Organization, which is why a licensed owner of a second Organization is
 * shown the form and refused on save, with the backend's sentence.
 *
 * **A merge, not a replace.** An omitted key keeps its stored value and an
 * explicit `null` clears it; `errorPages` merges key by key. The screen leans
 * on that: it sends only the fields that changed, so two people editing two
 * cards do not wipe each other's work.
 */

/** Every field nullable, and null means "unbranded" — Cloudgate's own. */
export interface WhitelabelingConfig {
  /** Product name in the browser title and on the sign-in screen. */
  appName: string | null;
  /** Logo in the masthead and above the sign-in panel. */
  logoUrl: string | null;
  faviconUrl: string | null;
  /** CSS hex colours. */
  primaryColor: string | null;
  accentColor: string | null;
  /** Operator-authored CSS for the signed-in console. */
  customCss: string | null;
  errorPages: {
    notFoundMessage: string | null;
    serverErrorMessage: string | null;
    supportUrl: string | null;
  };
}

/** A partial write: absent keys are kept, `null` clears. */
export type WhitelabelingPatch = Partial<
  Omit<WhitelabelingConfig, "errorPages">
> & { errorPages?: Partial<WhitelabelingConfig["errorPages"]> };

export const whitelabelingApi = {
  get: (signal?: AbortSignal) =>
    api.get<WhitelabelingConfig>("/settings/whitelabeling", { signal }),
  update: (patch: WhitelabelingPatch) =>
    api.patch<WhitelabelingConfig>("/settings/whitelabeling", patch),
};
