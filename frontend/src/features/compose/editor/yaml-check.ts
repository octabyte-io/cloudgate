import { parse } from "yaml";

/**
 * Is this YAML at all, and if not, where is it wrong?
 *
 * The same parser the backend uses (`yaml`, in `compose.utils.ts`), which is the
 * only reason to say anything: a check written against a *different* parser would
 * refuse files the platform accepts and accept files it refuses, which is worse
 * than not checking. Docker's own complaint about the file would be the same
 * complaint.
 *
 * It answers `null` for valid YAML and says nothing at all about whether the
 * document is a valid *compose* file — no service list, no schema. That check
 * belongs to `docker compose` and it is the deploy's to make: a compose file with
 * an unknown key is something Docker sometimes accepts, and a screen that refused
 * it would be inventing a rule.
 *
 * `maxAliasCount` matches the backend's, so a file with heavy anchor reuse is not
 * rejected here and then accepted there.
 *
 * **Two kinds, because the parser raises two classes and only one of them is a
 * syntax problem**.
 * `yaml` reports an unset anchor and an exceeded `maxAliasCount` as a plain
 * `ReferenceError` out of `Alias.resolve`, not as a `YAMLParseError` — and an
 * alias bomb is *valid* YAML that `yamllint` passes, refused for what it expands
 * to. Calling that "not valid YAML" sends an operator hunting a typo that is not
 * there, so the kind comes back and the copy says which. The backend answers the
 * same split (`composeFileParseRefusal`), which is what keeps the screen and the
 * API from describing one file two ways.
 */
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

export function yamlProblem(content: string): {
  kind: "syntax" | "aliases";
  message: string;
  line: number | null;
} | null {
  if (content.trim() === "") return null;
  try {
    parse(content, { maxAliasCount: 10_000 });
    return null;
  } catch (error) {
    // Not a `YAMLParseError` check: the alias failures are the ones that are not
    // one, so the narrower class is what identifies them.
    const kind = error instanceof ReferenceError ? "aliases" : "syntax";
    const yamlError = error as {
      message?: string;
      linePos?: [{ line: number; col: number }, ...unknown[]];
    };
    const line = yamlError.linePos?.[0]?.line ?? null;
    // The library's message repeats the line and column and then quotes the
    // source, which is a paragraph inside a sentence — the first line of it is
    // the reason. **That line ends in a colon**, because what followed it was the
    // quoted source we are dropping, and leaving it there rendered
    // "…at line 11, column 1:." on screen. Found by driving it.
    const message = (yamlError.message ?? "The parser could not read it.")
      .split("\n")[0]
      .trim()
      .replace(/:$/, "");
    return {
      kind,
      message: message.endsWith(".") ? message : `${message}.`,
      line,
    };
  }
}
