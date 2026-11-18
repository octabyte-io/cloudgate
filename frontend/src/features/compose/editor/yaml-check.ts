import { parse } from "yaml";

/**
 * Nothing has been written yet — which is not the same as "parses to nothing".
 *
 * The state a stack is in for its whole first visit, and the one the platform
 * refuses everywhere.
 * `parseComposeFile("")` answers `null`, so `addDomainsToComposeSpec` throws
 * `Compose file is empty` and both `GET /compose/:id/converted` and the deploy
 * stop there. The one route that does *not* is `GET /compose/:id/services`,
 * which answers `[]` — and that `[]` is what made the strip under the editor
 * call an untouched file healthy, and the Deploy button offer to apply it.
 *
 * `raw` only. A git-sourced stack has an empty `composeFile` column by
 * definition; its file lives in the repository and is read out of the clone.
 */
export function composeFileIsEmpty(content: string): boolean {
  return content.trim() === "";
}

/**
 * The file parses, and names nothing for the deploy to bring up.
 *
 * The other half of `composeFileIsEmpty`, and it was the expensive half. A file
 * of `volumes: {}` parses, so it saved and it deployed: the clone replaced the
 * project file the running containers had come from, Docker answered
 * `no service selected`, and the stack went `error` over two containers that
 * were still up. `parseComposeFileOrThrow` refuses it now, in front of that
 * write — this is the same question asked here so the button says so instead of
 * offering the failure, which is exactly what it once did for the empty file.
 *
 * **It mirrors the backend rule and may not grow past it.** Services, or an
 * `include:` whose file Compose resolves for itself; anything else is the
 * deploy's to judge. Two answers are deliberately `false` rather than a second
 * opinion: an empty file, which `composeFileIsEmpty` owns and words differently,
 * and one that does not parse, which `yamlProblem` already has its own banner
 * for. A document that parses to a scalar or to nothing at all — `just a string`,
 * or a file of only comments — answers `true`: it declares no services either,
 * and the backend refuses both.
 *
 * `raw` only, for `composeFileIsEmpty`'s reason: a git-sourced stack's column is
 * empty by definition and its file is read out of the clone.
 */
export function composeDeclaresNoServices(content: string): boolean {
  if (content.trim() === "") return false;
  let document: unknown;
  try {
    document = parse(content, { maxAliasCount: 10_000 });
  } catch {
    return false;
  }
  if (typeof document !== "object" || document === null) return true;
  const { services, include } = document as {
    services?: unknown;
    include?: unknown;
  };
  if (include != null) return false;
  if (typeof services !== "object" || services === null) return true;
  return Object.keys(services).length === 0;
}
