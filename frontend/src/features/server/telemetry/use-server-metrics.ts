/**
 * Moved to `@/lib/api/use-server-metrics` by F14.
 *
 * F14's Monitoring screen is the second feature to read a Server's samples, and
 * `design-system.md`'s rule is that a read several features share belongs to
 * none of them — so it sits beside `use-servers.ts` now. This re-export is here
 * so F13's own call sites did not have to change; new code should import from
 * `@/lib/api/use-server-metrics`.
 */
export {
  isCollecting,
  latest,
  series,
  uptimeReading,
  useServerMetrics,
} from "@/lib/api/use-server-metrics";
