import {
  getRedirectStatusCodeFromError,
  getURLFromRedirectError,
} from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { describe, expect, it } from "vitest";

import Page from "./page";

/**
 * `/account`, typed or bookmarked, is Settings → Account.
 *
 * It rendered a "This screen is built in phase F16" placeholder long after F16
 * had built the screen somewhere else. The address is kept rather than removed
 * because the avatar menu handed it out for sixteen phases, so it is in
 * bookmarks and history.
 */
describe("/account", () => {
  it("redirects to /settings/account", () => {
    let thrown: unknown;
    try {
      Page();
    } catch (error) {
      thrown = error;
    }

    expect(isRedirectError(thrown)).toBe(true);
    if (!isRedirectError(thrown)) return;
    expect(getURLFromRedirectError(thrown)).toBe("/settings/account");
    expect(getRedirectStatusCodeFromError(thrown)).toBe(308);
  });
});
