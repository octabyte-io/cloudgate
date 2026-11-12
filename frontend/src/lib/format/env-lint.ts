import { LINE, parseEnvBlob } from "@/lib/format/env-blob";

/**
 * What is wrong with a variables block, line by line, before it is saved.
 *
 * The block was saved as typed and read the way a deploy reads it
 * (`parseEnvBlob`), so four mistakes went through without a word: a line that
 * is not `KEY=value` was dropped, a key set twice kept its last value, a name
 * no process can read was stored, and a `${{…}}` reference to a key that is
 * not set was accepted, though it fails the deploy (`prepareEnvironmentVariables`
 * in the backend's `docker/docker.utils.ts`). The first three stop the save,
 * since the stored block would not be what was typed. An unresolved reference
 * is only a warning: the key may be set on the Project or Environment next,
 * before the deploy that needs it.
 */
export type EnvIssue = {
  /** 1-based, as the editor counts. */
  line: number;
  message: string;
  /** Whether the save waits for it to be fixed. */
  blocking: boolean;
};

/**
 * What a Service's `${{…}}` references can name: the Project's and the
 * Environment's blobs, and its wired variables beside its own. `undefined` for
 * one not read yet, whose references are then not judged.
 */
export type ReferenceSources = {
  project: string | null | undefined;
  environment: string | null | undefined;
  wired: readonly string[] | undefined;
};

/** A name a process reads: it starts with a letter or `_`. */
const NAME_START = /^[A-Za-z_]/;

const REFERENCE = /\$\{\{(.*?)\}\}/g;

export function envIssues(
  env: string,
  references?: ReferenceSources,
): EnvIssue[] {
  const text = env.replace(/\r\n?/g, "\n");
  const lineOf = (at: number) => text.slice(0, at).split("\n").length;
  const issues: EnvIssue[] = [];
  const covered = new Set<number>();
  const seen = new Map<string, number>();

  for (const match of text.matchAll(LINE)) {
    const key = match[1];
    const keyAt = match.index + match[0].indexOf(key);
    const first = lineOf(keyAt);
    const last = lineOf(match.index + match[0].trimEnd().length - 1);
    for (let line = first; line <= last; line++) covered.add(line);

    if (!NAME_START.test(key)) {
      issues.push({
        line: first,
        message: `${key} is not a name a process can read: a name starts with a letter or _.`,
        blocking: true,
      });
    }
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      issues.push({
        line: earlier,
        message: `${key} is set again on line ${first}, and only that later value is kept.`,
        blocking: true,
      });
    }
    seen.set(key, first);
  }

  text.split("\n").forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#") || covered.has(line)) return;
    issues.push({
      line,
      message: "This is not KEY=value, so it would be dropped.",
      blocking: true,
    });
  });

  if (references) issues.push(...unresolved(text, lineOf, references));
  return issues.sort((a, b) => a.line - b.line);
}

/** The `${{…}}` references a deploy could not fill, as warnings. */
function unresolved(
  text: string,
  lineOf: (at: number) => number,
  references: ReferenceSources,
): EnvIssue[] {
  const own = parseEnvBlob(text);
  const siblings =
    references.wired === undefined
      ? null
      : new Set([...own.map((v) => v.key), ...references.wired]);
  const project = keysOf(references.project);
  const environment = keysOf(references.environment);
  const issues: EnvIssue[] = [];

  for (const variable of own) {
    for (const [reference, name] of variable.value.matchAll(REFERENCE)) {
      const where = whereSet(name, project, environment, siblings);
      if (where === null) continue;
      issues.push({
        line: lineOfReference(text, lineOf, reference, variable.line),
        message: `${reference}: ${where}, so a deploy fails here until it is.`,
        blocking: false,
      });
    }
  }
  return issues;
}

/** Why a reference resolves to nothing, or `null` when it resolves (or cannot be judged). */
function whereSet(
  name: string,
  project: Set<string> | null,
  environment: Set<string> | null,
  siblings: Set<string> | null,
): string | null {
  if (name.startsWith("project.")) {
    const key = name.slice("project.".length);
    return project === null || project.has(key)
      ? null
      : `${key} is not set on the Project`;
  }
  if (name.startsWith("environment.")) {
    const key = name.slice("environment.".length);
    return environment === null || environment.has(key)
      ? null
      : `${key} is not set on the Environment`;
  }
  return siblings === null || siblings.has(name)
    ? null
    : `${name} is not set beside it`;
}

function keysOf(env: string | null | undefined): Set<string> | null {
  if (env === undefined) return null;
  return new Set(parseEnvBlob(env).map((v) => v.key));
}

/** The line the reference is typed on, which a multi-line value may move past its key's. */
function lineOfReference(
  text: string,
  lineOf: (at: number) => number,
  reference: string,
  keyLine: number,
): number {
  const lineStart = text.split("\n").slice(0, keyLine - 1).join("\n").length;
  const at = text.indexOf(reference, lineStart);
  return at === -1 ? keyLine : lineOf(at);
}
