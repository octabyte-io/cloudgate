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
 *
 * **Here rather than in `features/compose/`** because the expanded editor's
 * status line asks it of a Project config as well (#120). There it is a word
 * on the draft, never a gate: the backend's Project config parser keeps a
 * smaller alias budget (`maxAliasCount: 100`, `parse-config.ts`) and its own
 * refusal is what Save and plan answers.
 */
export type YamlProblem = {
  kind: "syntax" | "aliases";
  message: string;
  line: number | null;
};

export function yamlProblem(content: string): YamlProblem | null {
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
