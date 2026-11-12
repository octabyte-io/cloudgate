import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { RoleVocabulary } from "@/lib/api/endpoints/roles";

import {
  GATED_CALLERS,
  GATED_CONTROLS,
  GATED_SPECS,
  GATED_SPECS_MULTI,
  type GatedControl,
} from "./gated-controls";
import { permissionVerdict, type RequiredPermissions } from "./use-permission";

/**
 * **A create or destructive control is off before it is pressed, with the
 * reason, when the caller cannot take it**
 * — the rule
 * beside `usePermission`, held here from both ends.
 *
 * **The census.** Every `Button`, `SubmitButton` and `Menu.Item` in `src`, and
 * every `DangerZone` row, is read off the parsed source (not grepped — labels
 * wrap across lines and sit in ternaries). A control whose words open with a
 * create or destructive verb is either in the register
 * (`gated-controls.ts`), or in {@link EXEMPT} with the ADR that says so, or in
 * {@link BASELINE}. A registered control must *consult a verdict*: its
 * `disabled`, `aria-disabled` or `unavailable` reads `.allowed` / `grants`, or
 * a local bound to `usePermission`, `useInstanceGate` or `readGate`. A new
 * screen that opens a form a role cannot submit therefore fails here until
 * somebody decides, in one of three lists, what it does. A `SettingsCard` or
 * `VariablesCard` is found by its tag instead ({@link GATED_CARDS}), because
 * its button says "Save" and its `gate` is optional. Every other Save is found
 * by its words ({@link SAVE}) and decided in the same three lists.
 *
 * Exempt without a list: a control inside a `Modal` (or a `*-modal.tsx`
 * file) is a step behind its opener, and the opener is what carries the gate —
 * unless the register names it, as it does the two manager dialogs whose own
 * form is the create.
 *
 * **The mapping.** A census proves the sites agree, not what they agree on. So
 * the statements in the register are also held to the backend: to the route's
 * `@RequirePermission` where it has one, to the statement vocabulary
 * (`rbac/access-control.ts`, parsed — a misspelt resource would fail *open*
 * and turn nothing off), and to the roles: an owner and an admin hold every
 * one (nothing here may turn a control off for them), the built-in member
 * holds none of the ones the table reported, and the `ui-deployer`
 * custom role keeps the lifecycle and loses the definition writes.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BACKEND = join(SRC, "..", "..", "backend", "src");

// ── the census ──────────────────────────────────────────────────────────

/** The words a create or destructive control opens with. */
const VERB =
  /^(Add|New|Create|Invite|Connect|Generate|Delete|Remove|Revoke|Rename|Rotate|Restart|Stop|Start|Deploy|Redeploy|Rebuild|Restore|Roll back|Prune|Empty|Kill|Run|Change|Edit)\b/;

/**
 * Live for everyone, and the reason: an ADR says so (the host shell, the rule's
 * case 3), or no role in this Organization is what the route asks about.
 */
const EXEMPT: Record<string, string> = {
  "features/operator/orphan-machines-section.tsx::Delete":
    "ADR-0050: mounted only on the Operator page, which is the not-found screen for anyone who is not an Operator (useIsOperator); no role statement can say instance authority.",
  "features/server/local/local-shell-card.tsx::Change the user or port":
    "ADR-0010: the host shell form is rendered for everyone and its refusal is the gateway's.",
  "app/(auth)/_components/invitation-doors.tsx::Create an account":
    "Signing up: there is no Organization, so no role, yet.",
  "app/(auth)/_components/sign-up-form.tsx::Create account":
    "Signing up: there is no Organization, so no role, yet.",
  "app/(auth)/_components/sign-up-form.tsx::Create account and join":
    "Signing up: there is no Organization, so no role, yet.",
  "app/(auth)/_components/sign-up-form.tsx::Create owner account":
    "Signing up: there is no Organization, so no role, yet.",
  "components/console/terminal-status.tsx::Connect again":
    "Reopens a socket the caller already opened; the gateway authorizes it (ADR-0008, ADR-0012).",
  "features/agents/agent-row.tsx::Connect":
    "Shows client configuration built from the console’s own origin; it calls no route and holds no key.",
  "features/application/source/repository-picker.tsx::Change":
    "A picker inside the source form, reached only through Change source, which is gated.",
  "features/database/create/create-database-details.tsx::Create":
    "The submit of CreateDatabaseModal, reached only through Add a database, which is gated.",
  "features/integrations/ai/draft-footer.tsx::Create this stack":
    "The submit of DraftServiceModal, reached only through Draft one with AI, which is gated.",
  "features/settings/account/api-keys-card.tsx::Create a key":
    "The caller’s own account: no statement is asked (access-control.ts, the note where `api` is not).",
  "features/settings/account/api-keys-card.tsx::Revoke":
    "The caller’s own account: no statement is asked.",
  "features/settings/account/password-card.tsx::Change password":
    "The caller’s own account: no statement is asked.",
  "features/settings/account/session-columns.tsx::Revoke":
    "The caller’s own sessions (ADR-0009): no statement is asked.",
  "features/enterprise/sso/proven-domains-card.tsx::Add domain":
    "Rendered only once GET /sso/proven-domains has answered, and that read admits an owner or admin alone (SsoService.ensureEnterprise) — the role check the add asks, not a statement; anyone else gets the card's refusal and no form.",
  "features/settings/organization/organizations-section.tsx::Create an Organization":
    "Any signed-in user makes their own Organization; no role in this one enters into it.",
  "features/billing/starter-checklist.tsx::Delete":
    "Rendered only for an Attached Organization the reader owns (`ownedByYou`, from GET /billing/attached-organizations), which is the owner check DELETE /organizations/:id asks; no role in the open Organization enters into it.",
};

/**
 * Controls that open with one of those verbs, were live before the rule, and are
 * outside what it was applied to. **Frozen: the only correct edit to this
 * list is a deletion** — the census fails on an entry that has since been
 * gated or removed, and on any control not in it. A control whose route checks
 * no statement at all (the caller's own account, an operation the member role
 * holds anyway) belongs here with that reason rather than behind a gate that
 * would claim one.
 */
const BASELINE: string[] = [
  "features/application/domains/domain-host-field.tsx::Generate one for me",
  "features/application/domains/domains-card.tsx::Add a domain",
  "features/application/domains/domains-card.tsx::Edit",
  "features/application/domains/domains-card.tsx::Remove",
  "features/application/panels/domains.tsx::Add a domain",
  "features/application/panels/rollbacks.tsx::Delete",
  "features/application/panels/rollbacks.tsx::Roll back",
  "features/application/panels/schedules.tsx::Run now",
  "features/application/panels/volume-backups.tsx::Restore",
  "features/application/panels/volume-backups.tsx::Restore a volume",
  "features/application/panels/volume-backups.tsx::Run now",
  "features/compose/containers/container-actions.tsx::Kill",
  "features/compose/containers/container-actions.tsx::Restart",
  "features/compose/containers/container-actions.tsx::Start",
  "features/compose/containers/container-actions.tsx::Stop",
  "features/compose/lifecycle/compose-actions.tsx::Deploy",
  "features/compose/lifecycle/compose-actions.tsx::Remove containers",
  "features/compose/lifecycle/compose-actions.tsx::Start",
  "features/compose/lifecycle/compose-actions.tsx::Stop",
  "features/compose/panels/domains.tsx::Add a domain",
  "features/compose/panels/domains.tsx::Edit",
  "features/compose/panels/domains.tsx::Remove",
  "features/database/backups/backup-file-columns.tsx::Restore",
  "features/database/backups/backup-schedules-card.tsx::Run now",
  "features/database/lifecycle/database-actions.tsx::Deploy",
  "features/database/lifecycle/database-actions.tsx::Rebuild",
  "features/database/lifecycle/database-actions.tsx::Start",
  "features/database/lifecycle/database-actions.tsx::Stop",
  "features/enterprise/forward-auth/target-actions.tsx::Change the domain",
  "features/enterprise/forward-auth/target-actions.tsx::Deploy the proxy",
  "features/enterprise/forward-auth/target-actions.tsx::Remove the proxy",
  "features/enterprise/roles/role-columns.tsx::Delete",
  "features/enterprise/roles/role-columns.tsx::Edit",
  "features/enterprise/roles/roles-section.tsx::Create a role",
  "features/enterprise/sso/providers-card.tsx::Add a provider",
  "features/enterprise/sso/providers-card.tsx::Edit",
  "features/enterprise/sso/providers-card.tsx::Remove",
  "features/enterprise/sso/scim-card.tsx::Add a provider",
  "features/enterprise/sso/scim-card.tsx::Remove",
  "features/monitoring/live/host-history.tsx::Start keeping a history again",
  "features/monitoring/server-card.tsx::Start collecting again",
  "features/requests/logging-card.tsx::Restart Traefik",
  "features/server/access/key-card.tsx::Change the key",
  "features/server/docker/container-actions.tsx::Kill",
  "features/server/docker/container-actions.tsx::Remove",
  "features/server/docker/container-actions.tsx::Restart",
  "features/server/docker/container-actions.tsx::Start",
  "features/server/docker/container-actions.tsx::Stop",
  "features/server/docker/swarm-nodes-card.tsx::Remove",
  "features/settings/organization/organization-columns.tsx::Rename",
  "features/settings/organization/organization-danger-zone.tsx::Delete Organization",
  "features/settings/platform/traefik-section.tsx::Restart Traefik",
];

/**
 * The shared cards whose save button is theirs and whose verdict is the
 * caller's, handed down as `gate`. `gate` is optional on both, and a card
 * rendered without one falls back to allowed — and their button says "Save",
 * which {@link VERB} does not match — so every usage is found here instead, by
 * the tag, and each one either passes a `gate` that consults a verdict (and
 * whose file is in `GATED_CALLERS`, so its statement is held to the backend
 * below) or is named in {@link CARD_EXEMPT} or {@link CARD_BASELINE}. A card
 * rendered with `canEdit={false}` has no save to gate.
 */
const GATED_CARDS = ["SettingsCard", "VariablesCard"];

/** Card usages that are live for everyone, and the reason. */
const CARD_EXEMPT: Record<string, string> = {
  'features/settings/account/profile-card.tsx::<SettingsCard "Profile">':
    "PATCH /users/me: the caller’s own account, no statement is asked.",
};

/**
 * Card usages that save without a `gate`, each with the route its save goes
 * to (held to a backend route below). **Frozen like {@link BASELINE}: the only
 * correct edit is a deletion**, and the census fails on an entry that has since
 * been gated or removed. A `:kind` database route is written as Postgres's.
 */
const CARD_BASELINE: Record<string, string> = {
};

/**
 * A save opens with this word, and {@link VERB} does not match it: it changes
 * what is already there rather than making or ending something. A `SettingsCard`
 * or `VariablesCard` owns its own (found by the tag, above); every other one is
 * found here by its words.
 */
const SAVE = /^Save\b/;

/**
 * Save buttons that are live for everyone, and the reason. Most are the submit
 * of a form mounted only once its opener is pressed — the rule's "a step
 * behind its opener", for a form that is inline rather than in a `Modal` — so
 * the opener is what carries the gate, or what the baseline names.
 */
const SAVE_EXEMPT: Record<string, string> = {
  "components/console/variables-form.tsx::Save variables":
    "Mounted only while editing, through VariablesCard's Edit or Add variables, which its caller gates.",
  "features/application/source/build-form.tsx::Save build settings":
    "Reached only through the build card's Edit, which is gated.",
  "features/application/source/docker-source-form.tsx::Save source":
    "Reached only through an Application's Change source, which is gated.",
  "features/application/source/git-source-form.tsx::Save source":
    "Reached only through Change source, which is gated on an Application and on a Compose stack.",
  "features/application/source/custom-git-form.tsx::Save source":
    "Reached only through Change source, which is gated on an Application and on a Compose stack.",
  "features/compose/source/compose-source-card.tsx::Save source":
    "Reached only through the Compose stack's Change source, which is gated.",
  "features/server/access/key-card.tsx::Save":
    "Reached only through Change the key, which is in BASELINE.",
  "features/ssh-keys/ssh-key-row.tsx::Save":
    "Reached only through the row's Rename, which is gated.",
  "features/tags/tag-row.tsx::Save":
    "Reached only through the row's Rename, which is gated.",
  "components/console/wired-link-form.tsx::Save link":
    "Mounted only through the Wired variables card's Link a variable, which reads its caller's gate.",
  "features/operator/bought-servers-section.tsx::Save changes":
    "Mounted only on the Operator page, which is the not-found screen for anyone who is not an Operator (useIsOperator); no role statement can say instance authority (ADR-0050).",
};

/**
 * Save buttons outside the two cards that were live before, each with the
 * route it saves to (held to a backend route below). **Frozen like
 * {@link BASELINE}: the only correct edit is a deletion**, and the census fails
 * on an entry that has since been gated or removed. A `:kind` database route is
 * written as Postgres's.
 */
const SAVE_BASELINE: Record<string, string> = {
};

type Control = {
  file: string;
  labels: string[];
  /** The source of the attribute that turns it off, if it has one. */
  gateExpr: ts.Node | null;
  inModal: boolean;
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path === join(SRC, "app", "dev") || path === join(SRC, "components", "ui")) {
        return [];
      }
      return sourceFiles(path);
    }
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function literals(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }
  const found: string[] = [];
  node.forEachChild((child) => {
    // A template's head is words too: "Re-authorize at ${label}".
    if (ts.isTemplateExpression(child)) found.push(child.head.text.trim());
    found.push(...literals(child));
  });
  return found;
}

function labelsOf(element: ts.JsxElement): string[] {
  let text = "";
  const found: string[] = [];
  for (const child of element.children) {
    if (ts.isJsxText(child)) text += child.text;
    else if (ts.isJsxExpression(child) && child.expression) {
      const words = literals(child.expression);
      found.push(...(words.length > 0 ? words : [`{${child.expression.getText()}}`]));
    }
  }
  const joined = text.replace(/\s+/g, " ").trim();
  return [...(joined ? [joined] : []), ...found].filter(Boolean);
}

function attribute(element: ts.JsxElement, names: string[]): ts.Node | null {
  for (const property of element.openingElement.attributes.properties) {
    if (
      ts.isJsxAttribute(property) &&
      names.includes(property.name.getText()) &&
      property.initializer
    ) {
      return property.initializer;
    }
  }
  return null;
}

function controlsIn(path: string): Control[] {
  const source = parse(path);
  const file = relative(SRC, path).split(sep).join("/");
  const modalFile = basename(path).endsWith("-modal.tsx");
  const found: Control[] = [];

  function visit(node: ts.Node, inModal: boolean) {
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText();
      if (tag === "Button" || tag === "SubmitButton" || tag === "Menu.Item") {
        found.push({
          file,
          labels: labelsOf(node),
          gateExpr: attribute(node, ["disabled", "aria-disabled"]),
          inModal: inModal || modalFile,
        });
      }
      if (tag === "Modal") inModal = true;
    }
    // A `DangerZone` row: `{ button: "…", run: … }` in an `actions={[…]}`.
    if (ts.isObjectLiteralExpression(node) && inActions(node)) {
      const names = new Map(
        node.properties.flatMap((property) =>
          property.name ? [[property.name.getText(), property] as const] : [],
        ),
      );
      const button = names.get("button");
      if (button && names.has("run") && ts.isPropertyAssignment(button)) {
        const unavailable = names.get("unavailable");
        found.push({
          file,
          labels: literals(button.initializer),
          gateExpr: unavailable
            ? ts.isShorthandPropertyAssignment(unavailable)
              ? unavailable.name
              : (unavailable as ts.PropertyAssignment).initializer
            : null,
          inModal: modalFile,
        });
      }
    }
    node.forEachChild((child) => visit(child, inModal));
  }
  visit(source, false);
  return found;
}

function inActions(node: ts.Node): boolean {
  const list = node.parent;
  const attribute = list?.parent?.parent;
  return (
    list !== undefined &&
    ts.isArrayLiteralExpression(list) &&
    attribute !== undefined &&
    ts.isJsxAttribute(attribute) &&
    attribute.name.getText() === "actions"
  );
}

/** Does `file` render `<component … gate={…}>` anywhere? */
function rendersWithGate(source: ts.SourceFile, component: string): boolean {
  let found = false;
  source.forEachChild(function visit(node): void {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (
      opening &&
      opening.tagName.getText() === component &&
      opening.attributes.properties.some(
        (property) => ts.isJsxAttribute(property) && property.name.getText() === "gate",
      )
    ) {
      found = true;
    }
    node.forEachChild(visit);
  });
  return found;
}

type CardSite = {
  id: string;
  file: string;
  component: string;
  gateExpr: ts.Node | null;
  readOnly: boolean;
  source: ts.SourceFile;
};

/**
 * Every {@link GATED_CARDS} usage in a file, named by its `title` literal, or
 * by its ordinal among that component's usages in the file when it has none.
 */
function cardsIn(path: string): CardSite[] {
  const source = parse(path);
  const file = relative(SRC, path).split(sep).join("/");
  const found: CardSite[] = [];
  const seen = new Map<string, number>();
  source.forEachChild(function visit(node): void {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    const component = opening?.tagName.getText();
    if (opening && component && GATED_CARDS.includes(component)) {
      const ordinal = (seen.get(component) ?? 0) + 1;
      seen.set(component, ordinal);
      const attr = (name: string) =>
        opening.attributes.properties.find(
          (property): property is ts.JsxAttribute =>
            ts.isJsxAttribute(property) && property.name.getText() === name,
        );
      const title = attr("title")?.initializer;
      const name =
        title && ts.isStringLiteral(title) ? `"${title.text}"` : `#${ordinal}`;
      found.push({
        id: `${file}::<${component} ${name}>`,
        file,
        component,
        gateExpr: attr("gate")?.initializer ?? null,
        readOnly: attr("canEdit")?.initializer?.getText() === "{false}",
        source,
      });
    }
    node.forEachChild(visit);
  });
  return found;
}

/** `const x = …` in a file, by name. */
function bindings(source: ts.SourceFile): Map<string, ts.Node> {
  const found = new Map<string, ts.Node>();
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) found.set(node.name.text, node.initializer);
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          found.set(element.name.getText(), node.initializer);
        }
      }
    }
    node.forEachChild(visit);
  }
  visit(source);
  return found;
}

const VERDICT = /\ballowed\b|\bgrants\b|\busePermission\(|\buseInstanceGate\(|\breadGate\(/;

/** Does this expression read a verdict, directly or through up to three locals? */
function consults(expr: ts.Node, scope: Map<string, ts.Node>, depth = 0): boolean {
  if (VERDICT.test(expr.getText())) return true;
  if (depth > 3) return false;
  const names = new Set<string>();
  (function collect(node: ts.Node) {
    if (ts.isIdentifier(node)) names.add(node.text);
    node.forEachChild(collect);
  })(expr);
  return [...names].some((name) => {
    const bound = scope.get(name);
    return bound !== undefined && consults(bound, scope, depth + 1);
  });
}

const key = (file: string, label: string) => `${file}::${label}`;
const registered = new Set(GATED_CONTROLS.map((entry) => key(entry.file, entry.label)));

function everyControl(): Control[] {
  return sourceFiles(SRC).flatMap(controlsIn);
}

/** Every `usePermission({ … })` argument in a file, as plain objects. */
function permissionCalls(source: ts.SourceFile): RequiredPermissions[] {
  const found: RequiredPermissions[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === "usePermission" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      found.push(objectOf(node.arguments[0]));
    }
    node.forEachChild(visit);
  }
  visit(source);
  return found;
}

function objectOf(node: ts.ObjectLiteralExpression): RequiredPermissions {
  return Object.fromEntries(
    node.properties.flatMap((property) =>
      ts.isPropertyAssignment(property) &&
      ts.isArrayLiteralExpression(property.initializer)
        ? [[property.name.getText().replace(/['"]/g, ""), property.initializer.elements.map((element) => (element as ts.StringLiteral).text)]]
        : [],
    ),
  );
}

describe("GATED_CONTROLS", () => {
  const controls = everyControl();

  it.each(GATED_CONTROLS.map((entry) => [key(entry.file, entry.label), entry] as const))(
    "%s consults the verdict at every place it is rendered",
    (_, entry: GatedControl) => {
      const path = join(SRC, entry.file);
      const source = parse(path);
      const scope = bindings(source);
      const sites = controls.filter(
        (control) => control.file === entry.file && control.labels.includes(entry.label),
      );
      expect(sites.length, `no control reads "${entry.label}" in ${entry.file}`).toBeGreaterThan(0);
      for (const site of sites) {
        expect(
          site.gateExpr !== null && consults(site.gateExpr, scope),
          `"${entry.label}" in ${entry.file} renders without consulting a verdict`,
        ).toBe(true);
      }

      const text = source.getText();
      if (entry.requires === "instance") {
        expect(text).toMatch(/useInstanceGate\(\)/);
      } else if (entry.requires === "answer") {
        expect(entry.route, `"${entry.label}" names no read to answer it`).toMatch(/^GET \//);
      } else if (entry.requires !== "caller") {
        expect(permissionCalls(source)).toContainEqual(entry.requires);
      }
    },
  );

  it.each(GATED_CALLERS.map((entry) => [entry.file, entry] as const))(
    "%s hands its card a gate it read",
    (_, entry) => {
      const source = parse(join(SRC, entry.file));
      const text = source.getText();
      expect(rendersWithGate(source, entry.component)).toBe(true);
      if (entry.requires === "instance") expect(text).toMatch(/useInstanceGate\(\)/);
      else expect(permissionCalls(source)).toContainEqual(entry.requires);
    },
  );

  it("leaves no create or destructive control undecided", () => {
    const baseline = new Set(BASELINE);
    const undecided = controls
      .filter((control) => !control.inModal)
      .flatMap((control) =>
        control.labels
          .filter((label) => VERB.test(label))
          .map((label) => key(control.file, label)),
      )
      .filter((id) => !registered.has(id) && !(id in EXEMPT) && !baseline.has(id));
    expect(
      [...new Set(undecided)].sort(),
      "gate these by usePermission's rule and add them to gated-controls.ts, or name the ADR that exempts one",
    ).toEqual([]);
  });

  it("has a baseline that only shrinks", () => {
    const live = new Set(
      controls
        .filter((control) => !control.inModal)
        .flatMap((control) =>
          control.labels
            .filter((label) => VERB.test(label))
            .map((label) => key(control.file, label)),
        ),
    );
    const stale = BASELINE.filter((id) => !live.has(id) || registered.has(id));
    expect(stale, "delete these from BASELINE: gone, or gated now").toEqual([]);
  });

  const saves = controls
    .filter((control) => !control.inModal)
    .flatMap((control) =>
      control.labels
        .filter((label) => SAVE.test(label))
        .map((label) => ({ id: key(control.file, label), control })),
    );

  it("leaves no Save outside the shared cards undecided", () => {
    const undecided = saves.flatMap(({ id, control }) => {
      if (id in SAVE_EXEMPT || id in SAVE_BASELINE) return [];
      if (!registered.has(id)) {
        return [
          control.gateExpr !== null &&
          consults(control.gateExpr, bindings(parse(join(SRC, control.file))))
            ? `${id}: gated, but not in GATED_CONTROLS`
            : `${id}: no gate`,
        ];
      }
      return [];
    });
    expect(
      [...new Set(undecided)].sort(),
      "gate these by usePermission's rule and add them to gated-controls.ts, or name the route (SAVE_BASELINE) or the reason (SAVE_EXEMPT)",
    ).toEqual([]);
  });

  it("has a Save baseline that only shrinks", () => {
    const live = new Set(saves.map(({ id }) => id));
    const stale = [...Object.keys(SAVE_BASELINE), ...Object.keys(SAVE_EXEMPT)].filter(
      (id) => !live.has(id) || registered.has(id),
    );
    expect(stale, "delete these from SAVE_BASELINE or SAVE_EXEMPT: gone, or gated now").toEqual([]);
  });

  const cards = sourceFiles(SRC).flatMap(cardsIn);

  it("hands every card that saves a gate it read, or says why not", () => {
    const callers = new Set(GATED_CALLERS.map((entry) => `${entry.file}::${entry.component}`));
    const undecided = cards
      .filter((card) => !card.readOnly)
      .flatMap((card) => {
        if (card.gateExpr === null) {
          return card.id in CARD_EXEMPT || card.id in CARD_BASELINE
            ? []
            : [`${card.id}: no gate`];
        }
        const problems: string[] = [];
        if (!consults(card.gateExpr, bindings(card.source))) {
          problems.push(`${card.id}: its gate consults no verdict`);
        }
        if (!callers.has(`${card.file}::${card.component}`)) {
          problems.push(`${card.id}: gated, but not in GATED_CALLERS`);
        }
        return problems;
      });
    expect(
      undecided,
      "hand these a gate by usePermission's rule and add the file to GATED_CALLERS, or name why one is exempt",
    ).toEqual([]);
  });

  it("has a card baseline that only shrinks", () => {
    const ungated = new Set(
      cards.filter((card) => card.gateExpr === null && !card.readOnly).map((card) => card.id),
    );
    const stale = [...Object.keys(CARD_BASELINE), ...Object.keys(CARD_EXEMPT)].filter(
      (id) => !ungated.has(id),
    );
    expect(stale, "delete these from CARD_BASELINE or CARD_EXEMPT: gone, or gated now").toEqual([]);
  });
});

// ── the mapping ─────────────────────────────────────────────────────────

type Route = { permissions: RequiredPermissions | null };

const normalize = (route: string) =>
  route.replace(/:[A-Za-z]+/g, ":p").replace(/\/+/g, "/").replace(/\/$/, "");

function backendFiles(dir: string, suffix: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return backendFiles(path, suffix);
    return entry.name.endsWith(suffix) ? [path] : [];
  });
}

/** Every backend route, `VERB /path` → its `@RequirePermission`s, if any. */
function backendRoutes(): Map<string, Route> {
  const constants = new Map<string, string>();
  for (const path of backendFiles(BACKEND, ".ts")) {
    for (const match of readFileSync(path, "utf8").matchAll(
      /export const ([A-Z_]+) = '([^']+)'/g,
    )) {
      constants.set(match[1], match[2]);
    }
  }
  const routes = new Map<string, Route>();
  for (const path of backendFiles(BACKEND, ".controller.ts")) {
    const source = parse(path);
    source.forEachChild(function visit(node): void {
      if (!ts.isClassDeclaration(node)) {
        node.forEachChild(visit);
        return;
      }
      const controller = ts
        .getDecorators(node)
        ?.map((decorator) => decorator.expression)
        .find(
          (expression): expression is ts.CallExpression =>
            ts.isCallExpression(expression) &&
            expression.expression.getText() === "Controller",
        );
      if (!controller) return;
      const argument = controller.arguments[0];
      const prefix = !argument
        ? ""
        : ts.isStringLiteral(argument)
          ? argument.text
          : (constants.get(argument.getText()) ?? `?${argument.getText()}`);
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const calls = (ts.getDecorators(member) ?? [])
          .map((decorator) => decorator.expression)
          .filter(ts.isCallExpression);
        const verb = calls.find((call) =>
          /^(Get|Post|Patch|Put|Delete)$/.test(call.expression.getText()),
        );
        if (!verb) continue;
        const sub = verb.arguments[0] && ts.isStringLiteral(verb.arguments[0]) ? verb.arguments[0].text : "";
        const permissions: RequiredPermissions = {};
        for (const call of calls.filter((c) => c.expression.getText() === "RequirePermission")) {
          const [resource, action] = call.arguments.map((a) => (a as ts.StringLiteral).text);
          (permissions[resource] ??= []).push(action);
        }
        routes.set(
          normalize(`${verb.expression.getText().toUpperCase()} /${prefix}/${sub}`),
          { permissions: Object.keys(permissions).length > 0 ? permissions : null },
        );
      }
    });
  }
  return routes;
}

/** `ownerRole = ac.newRole({ … })` and friends, and `statements`, parsed. */
function accessControl(): Record<string, RequiredPermissions> {
  const source = parse(join(BACKEND, "rbac", "access-control.ts"));
  const found: Record<string, RequiredPermissions> = {};
  source.forEachChild(function visit(node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let init: ts.Node = node.initializer;
      if (ts.isAsExpression(init)) init = init.expression;
      if (ts.isCallExpression(init) && init.arguments[0] && ts.isObjectLiteralExpression(init.arguments[0])) {
        init = init.arguments[0];
      }
      if (ts.isObjectLiteralExpression(init)) found[node.name.text] = objectOf(init);
    }
    node.forEachChild(visit);
  });
  return found;
}

function specPermissions(file: string): (RequiredPermissions[] | "same-as-list")[] {
  const source = parse(join(SRC, file));
  const found: (RequiredPermissions[] | "same-as-list")[] = [];
  source.forEachChild(function visit(node): void {
    if (ts.isPropertyAssignment(node) && node.name.getText() === "permissions") {
      const value = node.initializer;
      if (ts.isStringLiteral(value)) found.push("same-as-list");
      else if (ts.isObjectLiteralExpression(value)) {
        const writes = objectOfObjects(value);
        found.push([writes.create, writes.update, writes.remove]);
      }
    }
    node.forEachChild(visit);
  });
  return found;
}

function objectOfObjects(node: ts.ObjectLiteralExpression): Record<string, RequiredPermissions> {
  return Object.fromEntries(
    node.properties.flatMap((property) =>
      ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)
        ? [[property.name.getText(), objectOf(property.initializer)]]
        : [],
    ),
  );
}

type Mapped = { where: string; requires: RequiredPermissions; route?: string; checkedIn?: string };

function mapped(): Mapped[] {
  const direct = [...GATED_CONTROLS, ...GATED_CALLERS].flatMap((entry) =>
    typeof entry.requires === "object"
      ? [{ where: `${entry.file}::${"label" in entry ? entry.label : entry.component}`, requires: entry.requires, route: entry.route, checkedIn: entry.checkedIn }]
      : [],
  );
  const specs = [
    ...GATED_SPECS.map((spec) => ({ file: spec.file, routes: [spec.routes] })),
    GATED_SPECS_MULTI,
  ].flatMap(({ file, routes }) => {
    const permissions = specPermissions(file);
    expect(permissions.length, `${file}: one permissions per spec`).toBe(routes.length);
    return routes.flatMap((route, index) => {
      const declared = permissions[index];
      if (route === "same-as-list" || declared === "same-as-list") {
        expect(declared).toBe(route);
        return [];
      }
      return (["create", "update", "remove"] as const).map((write, at) => ({
        where: `${file}::${write}`,
        requires: declared[at],
        route: route[write],
      }));
    });
  });
  return [...direct, ...specs];
}

describe("GATED_CONTROLS' statements", () => {
  const routes = backendRoutes();
  const roles = accessControl();
  const all = mapped();

  it.each(all.map((entry) => [entry.where, entry] as const))(
    "%s asks what its route asks",
    (_, entry) => {
      for (const [resource, actions] of Object.entries(entry.requires)) {
        for (const action of actions) {
          expect(roles.statements[resource] ?? [], `${resource}:${action} is not a statement`).toContain(action);
        }
      }
      if (!entry.route) return;
      const route = routes.get(normalize(entry.route));
      expect(route, `${entry.route} is not a backend route`).toBeDefined();
      if (route?.permissions) {
        expect(entry.requires).toEqual(route.permissions);
        expect(entry.checkedIn, "the route is decorated now; drop checkedIn").toBeUndefined();
      } else {
        expect(entry.checkedIn, `${entry.route} has no decorator: say where it is checked`).toBeTruthy();
      }
    },
  );

  const vocabulary = (): RoleVocabulary =>
    ({
      statements: roles.statements,
      staticRoles: { owner: roles.ownerRole, admin: roles.adminRole, member: roles.memberRole },
      enterpriseOnlyResources: [],
      internalResources: [],
    }) as RoleVocabulary;

  const verdict = (role: string, requires: RequiredPermissions, customRoles?: { role: string; permissions: RequiredPermissions }[]) =>
    permissionVerdict(
      { role, pending: false, vocabulary: vocabulary(), customRoles: customRoles as never },
      requires,
    ).allowed;

  it("turns nothing off for an owner or an admin", () => {
    const refused = all.filter(
      (entry) => !verdict("owner", entry.requires) || !verdict("admin", entry.requires),
    );
    expect(refused.map((entry) => entry.where)).toEqual([]);
  });

  /** The table: every one of these was refused for the built-in member. */
  const MEMBER_REFUSED = [
    "features/members/members-card.tsx::Invite someone",
    "features/members/members-card.tsx::Change role",
    "features/members/members-card.tsx::Manage access",
    "features/members/members-card.tsx::Remove",
    "features/members/invitations-card.tsx::Delete",
    "features/members/teams-card.tsx::Create a team",
    "features/members/team-row.tsx::Rename",
    "features/members/team-row.tsx::Delete",
    "features/project/projects-screen.tsx::New Project",
    "features/tags/manage-tags-modal.tsx::Add tag",
    "features/tags/tag-row.tsx::Rename",
    "features/tags/tag-row.tsx::Delete",
    "features/server/fleet/fleet-screen.tsx::Add a Server",
    "features/ssh-keys/manage-keys-modal.tsx::Add key",
    "features/environment/panels/services.tsx::Add an Application",
    "features/environment/panels/services.tsx::Add a database",
    "features/environment/panels/services.tsx::Add a Compose stack",
    "features/environment/panels/services.tsx::Draft one with AI",
    "features/integrations/notifications/notifications-section.tsx::Add a channel",
    "features/integrations/git-providers/connect-github-app.tsx::Create the app on GitHub",
    "features/integrations/destinations/destinations-spec.tsx::create",
    "features/integrations/registries/registries-spec.tsx::create",
    "features/certificates/certificates-spec.tsx::create",
    "features/integrations/git-providers/provider-spec.tsx::create",
  ];

  it("refuses the built-in member every control the table reported", () => {
    const byWhere = new Map(all.map((entry) => [entry.where, entry]));
    for (const where of MEMBER_REFUSED) {
      const entry = byWhere.get(where);
      expect(entry, `${where} is not in the register`).toBeDefined();
      expect(verdict("member", entry!.requires), where).toBe(false);
    }
  });

  it("keeps Deploy and the lifecycle live for a role made to deploy, and turns its definition writes off", () => {
    // The second report: `ui-deployer` — `read` on everything that offers
    // it, plus `deployment: ['create']`; no `service: ['update']`.
    const permissions: RequiredPermissions = Object.fromEntries(
      Object.entries(roles.statements).map(([resource, actions]) => [
        resource,
        actions.filter((action) => action === "read"),
      ]),
    );
    permissions.deployment = ["read", "create"];
    const deployer = [{ role: "ui-deployer", permissions }];
    const byWhere = new Map(all.map((entry) => [entry.where, entry]));
    const check = (where: string) => verdict("ui-deployer", byWhere.get(where)!.requires, deployer);

    for (const where of [
      "features/application/deploy/deploy-button.tsx::Deploy",
      "features/application/lifecycle/redeploy-button.tsx::Redeploy",
      "features/application/lifecycle/application-actions.tsx::Restart",
      "features/application/lifecycle/application-actions.tsx::Stop",
      "features/application/lifecycle/application-actions.tsx::Start",
      "features/application/panels/previews-list-card.tsx::Redeploy",
      "features/application/panels/requested-previews-card.tsx::Extend",
      "features/application/panels/requested-previews-card.tsx::Redeploy",
    ]) {
      expect(check(where), where).toBe(true);
    }
    for (const where of [
      // Deploying is not cancelling: a role made to deploy cannot
      // expire a preview or tear one down.
      "features/application/panels/previews-list-card.tsx::Tear down",
      "features/application/panels/requested-previews-card.tsx::Expire now",
      "features/application/source/source-card.tsx::Change source",
      "features/application/source/build-card.tsx::Edit",
      "features/application/panels/variables.tsx::VariablesCard",
    ]) {
      expect(check(where), where).toBe(false);
    }
  });

  it("reads a backend route for every control decided by the route's answer", () => {
    const missing = GATED_CONTROLS.filter(
      (entry) => entry.requires === "answer" && !routes.has(normalize(entry.route ?? "")),
    ).map((entry) => `${entry.file}::${entry.label}: ${entry.route}`);
    expect(missing).toEqual([]);
  });

  it("names a backend route for every card and Save in the baselines", () => {
    const missing = Object.entries({ ...CARD_BASELINE, ...SAVE_BASELINE }).filter(
      ([, route]) => !routes.has(normalize(route)),
    );
    expect(missing).toEqual([]);
  });

  it("reads the backend it checks against", () => {
    expect(existsSync(join(BACKEND, "rbac", "access-control.ts"))).toBe(true);
    expect(routes.size).toBeGreaterThan(100);
  });
});
