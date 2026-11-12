import { parseEnvBlob } from "@/lib/format/env-blob";

/**
 * The names Cloudgate writes into the stack's `.env` itself, before its own
 * variables (`composeEnvFileContent` in the backend's `compose.utils.ts`).
 */
const WRITTEN_BY_CLOUDGATE = ["APP_NAME", "COMPOSE_PROJECT_NAME", "DOCKER_CONFIG"];

/**
 * `$$` (an escaped dollar), `${NAME}` with what follows the name, or `$NAME`.
 * The grammar `docker compose` interpolates.
 */
const INTERPOLATION =
  /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

export type UnsetInterpolation = { name: string; line: number };

/**
 * The names a compose file interpolates that nothing in the stack sets
 * Docker
 * reported `${API_KEY}` with no such variable only in the deploy log
 * ("variable is not set. Defaulting to a blank string"), so the editor says
 * it first, as a warning: the deploy still runs, with the blank.
 *
 * A name with a default (`${NAME:-x}`, `${NAME-x}`) or an alternative
 * (`${NAME:+x}`) is never blank by surprise and is not named. One the
 * stack sets through its variables, or that Cloudgate writes, is set. Each
 * name is said once, at its first line.
 */
export function unsetInterpolations(
  file: string,
  env: string | null,
): UnsetInterpolation[] {
  const set = new Set([
    ...WRITTEN_BY_CLOUDGATE,
    ...parseEnvBlob(env).map((variable) => variable.key),
  ]);
  const found = new Map<string, number>();
  for (const match of file.matchAll(INTERPOLATION)) {
    const name = match[1] ?? match[3];
    if (name === undefined) continue;
    const modifier = match[2] ?? "";
    if (/^:?[-+]/.test(modifier)) continue;
    if (set.has(name) || found.has(name)) continue;
    found.set(name, file.slice(0, match.index).split("\n").length);
  }
  return [...found].map(([name, line]) => ({ name, line }));
}
