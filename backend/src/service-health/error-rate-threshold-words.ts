import type { ErrorRateThreshold } from './error-rate-threshold.schema';

// How a threshold Incident's Notification words its figures. The
// console words them the same way (`frontend/.../health-words.ts`).

/** A fraction as a percentage with at most one decimal: `0.125` → `12.5 %`. */
export function rateWords(rate: number): string {
  const percent = Math.round(rate * 1000) / 10;
  return `${percent} %`;
}

/** The threshold as a sentence fragment: `5 % over 5 minutes`. */
export function thresholdWords(
  threshold: Pick<ErrorRateThreshold, 'percentage' | 'windowMinutes'>,
): string {
  const minutes =
    threshold.windowMinutes === 1
      ? '1 minute'
      : `${threshold.windowMinutes} minutes`;
  return `${threshold.percentage} % over ${minutes}`;
}

/** The window that opened an Incident: `12.5 % of 40 requests`. */
export function openingRateWords(rate: number, requests: number): string {
  return `${rateWords(rate)} of ${requests} ${requests === 1 ? 'request' : 'requests'}`;
}
