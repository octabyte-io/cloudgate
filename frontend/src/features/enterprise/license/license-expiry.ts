import type { LicenseStatusReport } from "@/lib/api/endpoints/license";

/**
 * Where a Self-hosted license stands against its `validUntil`, for the
 * console's renewal bar: a pure function of the status report and the
 * moment, so a test can set the moment.
 *
 * **The two thresholds are the backend's** (`FIRST_WARNING_DAYS` and
 * `LAST_WARNING_DAYS` in `backend/src/enterprise/license/license-expiry.ts`,
 * which the daily re-check and the `license-expiring` notices count from). The
 * console cannot import a backend file, so they are mirrored here and
 * `license-expiry.test.ts` reads them back out of that file: a change on
 * either side fails it until both agree, and the bar never appears on a
 * different day from the email.
 *
 * Only `validUntil` is named. Whatever grace the license server allows after
 * it is not the console's to promise (ADR-0054).
 */

/** The bar appears this many days before `validUntil`. */
export const FIRST_WARNING_DAYS = 14;

/** From this many days before `validUntil`, the bar can no longer be hidden. */
export const LAST_WARNING_DAYS = 3;

/**
 * What stops when the license lapses, for the bar's ended wording: the
 * backend's `STOPPED_BY_LAPSE` (`backend/src/enterprise/license/paid-features.ts`),
 * the list the `license-lapse` report and every channel give. Mirrored
 * for the same reason as the thresholds, and read back by the same test, so
 * the bar and the report never list different things.
 */
export const STOPPED_BY_LAPSE: readonly string[] = [
  "SSO sign-in",
  "Adding members through SCIM",
  "Changes to forward auth",
  "Custom roles",
  "Editing white-labelling (the saved branding stays)",
  "Parallel builds and Cloud runs (back to one at a time)",
  "Creating more Organizations",
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * - `none`: nothing to say — no license in force with a date, Enterprise
 *   features off, or more than {@link FIRST_WARNING_DAYS} days out;
 * - `early`: inside the first warning, and the bar may be hidden;
 * - `late`: {@link LAST_WARNING_DAYS} days or fewer left, and it may not;
 * - `ended`: `validUntil` has passed. It may not be hidden either.
 */
export type LicenseExpiry =
  | { stage: "none" }
  | { stage: "early" | "late"; validUntil: string; daysLeft: number }
  | { stage: "ended"; validUntil: string };

export function licenseExpiry(
  report: Pick<
    LicenseStatusReport,
    "status" | "validUntil" | "enableEnterpriseFeatures"
  >,
  now: number,
): LicenseExpiry {
  const { validUntil } = report;
  // A refused key (`invalid`) or none (`inactive`) is not an expiry, and with
  // the opt-in off there is nothing left to renew.
  if (
    !report.enableEnterpriseFeatures ||
    report.status !== "active" ||
    validUntil === null
  ) {
    return { stage: "none" };
  }

  const left = Date.parse(validUntil) - now;
  // The backend's `isLapsed`: lapsed from the instant itself on.
  if (left <= 0) return { stage: "ended", validUntil };
  if (left > FIRST_WARNING_DAYS * DAY_MS) return { stage: "none" };

  // Rounded up: with half a day left the license ends "in 1 day", not 0.
  const daysLeft = Math.ceil(left / DAY_MS);
  return {
    stage: left <= LAST_WARNING_DAYS * DAY_MS ? "late" : "early",
    validUntil,
    daysLeft,
  };
}
