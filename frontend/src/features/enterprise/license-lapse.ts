import type { LicenseStatusReport } from "@/lib/api/endpoints/license";

/**
 * **When this Organization's license lapsed, or `null` if it has not**.
 *
 * A lapse is not a status: the row still says `active`, and `licensed` turns
 * false only because `validUntil` is compared to the clock on every read. So
 * the three are read together — an active key whose expiry has passed and
 * which no longer licenses anything. A key that was never activated, or one
 * the license server refused, is not a lapse: nothing it unlocked was kept.
 *
 * What it is for: a lapse keeps what was set up (the saved branding, the
 * defined roles) and stops the edits, so a page can show its settings
 * read-only rather than the lock a never-licensed Organization sees.
 */
export function lapsedOn(
  report:
    | Pick<LicenseStatusReport, "licensed" | "status" | "validUntil">
    | undefined,
  now: number = Date.now(),
): string | null {
  if (!report || report.licensed || report.status !== "active") return null;
  if (!report.validUntil) return null;
  return Date.parse(report.validUntil) <= now ? report.validUntil : null;
}
