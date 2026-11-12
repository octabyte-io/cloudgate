import type { PlanRefusal } from './plan.types';

/**
 * A Template part's Domain whose host is taken (ADR-0065 "Failures"): the
 * same refusal when the plan is made and when its Apply checks again,
 * before anything is written. The host was picked at setup, so the way on
 * is another setup, not an edit to the config.
 */
export function templateHostTaken(
  configName: string,
  host: string,
  why: string,
): PlanRefusal {
  return {
    at: configName,
    message: `${configName}: its Domain ${host} is taken (${why}); cancel this setup and set the template up again with another host`,
  };
}
