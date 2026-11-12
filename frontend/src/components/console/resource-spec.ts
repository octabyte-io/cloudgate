import type { FieldValues } from "react-hook-form";
import type { ZodType } from "zod";

import type { Column } from "@/components/console/data-table";
import type { FieldSpec } from "@/components/console/form-spec";
import type { SortState } from "@/components/console/head-cell";
import type { RequiredPermissions } from "@/lib/auth/use-permission";
import type { IconName } from "@/lib/design/icons";

export type { FieldSpec, RowColumn } from "@/components/console/form-spec";

/**
 * **The one description of "a table of child records with add / edit / delete".**
 *
 * Built by F10 inside `application/advanced/resource-spec.ts`; **promoted here by
 * F15**, which is the fifth, sixth, seventh and eighth consumer — registries,
 * destinations, AI providers and every one of the twelve notification channels
 * are this shape, and none of them belongs to an Application. `resource-spec.ts`
 * in F10's folder re-exports all of it, so no F10 call site changed.
 *
 * F10's brief is blunt about why this exists: mounts, schedules, volume backups
 * and patches are the same screen four times over — a list keyed by the owning
 * service, a `POST /` that creates one, a `PATCH /:id` that edits one and a
 * `DELETE /:id` that removes it. Written by hand that is four tables, four
 * dialogs, four confirmations and four sets of empty states that drift apart
 * within a phase. Ports, redirects and security became three more the moment
 * they got a list route, and they cost three configuration files and not one component
 * — which is the argument for this type, made in hindsight.
 *
 * So a list is a **configuration file**: this type in, `ResourceList` out. The
 * parts a caller genuinely owns are the columns, the fields and the four calls;
 * everything a person can see about *how* the pattern behaves — where the
 * actions sit, what the confirmation asks, which dialog is keyed and why — is
 * decided once, here and in `resource-list.tsx`.
 *
 * Two things are deliberately not parameters:
 *
 * 1. **The actions column.** `ResourceList` appends it, so Edit and Remove are
 *    in the same place, in the same order, at the same size, on every list.
 * 2. **Whether the dialogs are keyed.** They always are. `useApiForm` reads
 *    `defaultValues` exactly once, so a dialog that outlives a close keeps what
 *    was typed into it — the defect F09 found on the add-a-domain dialog. It is
 *    not a per-list choice.
 */

export type ResourceSpec<Row, Values extends FieldValues> = {
  /** Singular, sentence case: "mount", "schedule", "registry". */
  noun: string;
  /**
   * Spelled out, never `${noun}s`.
   *
   * F09 printed **"repositorys"** on a real screen deriving this. Two words in
   * a config file beat a rule with an exception in it.
   */
  plural: string;
  /** The card's heading. */
  title: string;
  /** One sentence under it, saying what these do at deploy time. */
  lede?: React.ReactNode;
  icon: IconName;
  /** "Add a mount" — the same words on the button, the dialog and its submit. */
  addLabel: string;
  /** The empty state's heading and its one sentence. An invitation, not a report. */
  emptyTitle: string;
  emptyBody: React.ReactNode;

  columns: Column<Row>[];
  getRowId: (row: Row) => string;
  /** What the delete confirmation calls this row. */
  rowName: (row: Row) => string;
  defaultSort?: SortState;

  schema: ZodType<Values>;
  fields: FieldSpec<Values>[];
  /** `null` is the add dialog; a row is the edit dialog. */
  toDefaults: (row: Row | null) => Values;

  create: (values: Values) => Promise<unknown>;
  update: (row: Row, values: Values) => Promise<unknown>;
  remove: (row: Row) => Promise<unknown>;

  /**
   * What each of the three calls above takes, so `ResourceList` can
   * turn Add, Edit and Remove off for a role that cannot use them rather than
   * open a form that ends in a 403. `usePermission`'s rule applies: the
   * statement the route's `@RequirePermission` names, which is not always the
   * one its verb suggests — `PATCH /registries/:id` asks for `create`.
   *
   * **Required, not optional**, because this field is the census for every
   * list built on this type: a new spec that says nothing about who may write
   * it does not compile. `"same-as-list"` is for a surface no statement names —
   * AI providers, which `AiService.ensureOwnerOrAdmin` gates read and write
   * alike — where a refused list is the answer for all three.
   */
  permissions: ResourcePermissions | "same-as-list";

  /** What deleting this row costs, beyond the row. Named before it happens. */
  deleteNote?: (row: Row) => React.ReactNode;
  /**
   * The confirmation's one-line description, for a row whose delete takes more
   * than the row. Defaults to "This removes the <noun> and nothing else." —
   * untrue of an Uptime check, whose Probes and Incidents go with it.
   */
  deleteDescription?: string;
  /**
   * What stands in for Add while something it needs does not exist yet
   * a backup schedule with no destination connected opened a form
   * that could never be submitted. Usually a link to where that thing is made.
   * Shown where Add would be, once; `emptyBody` should say why.
   */
  addInstead?: React.ReactNode;
  /** Controls that belong to a row and are not Edit or Remove — "Run now". */
  rowExtras?: (row: Row) => React.ReactNode;

  /**
   * The table's accessible name, when the heading is not enough on its own.
   *
   * **F15's addition.** F10 hard-coded `"${title} of this Application"`, which
   * is F11's `emptyBody` defect waiting to happen: an Organization's registries
   * are not an Application's anything. Defaults to `title`.
   */
  tableLabel?: string;

  /**
   * The credentials this form takes, and which of them the row cannot be made
   * without. On an **add**, a required one left empty is refused under
   * its box alongside every other empty field, rather than by the backend one
   * submit later; on an edit an empty box means "keep the stored one". Defaults
   * to `test.secrets`, which is the same list on every spec that has both.
   */
  secrets?: TestSecret[];

  /**
   * **A connection test that runs from inside the form.**
   *
   * F15's addition. There are **two routes behind the one button**, and which
   * one runs is decided by whether the credential boxes have anything in them:
   *
   * - **Filled in** — the credential-taking route probes the values on screen:
   *   `POST /notifications/<channel>/test`, `POST /destinations/test-connection`,
   *   `POST /ai/test-connection`. This is the only thing that can work before the
   *   row exists, and testing before saving is the right way round — a webhook
   *   you have not proved works is a webhook that fails silently at 3am.
   * - **Empty, on an edit** — the id-taking route names the saved row and the
   *   server reads its own decrypted credential:
   *   `POST /notifications/:id/test` and its two siblings. That
   *   answers the operational question — *is the alerting I set up three months ago
   *   still working?* — which the credential-taking route never could, because these
   *   modules (correctly) never send a stored secret back to the browser.
   *
   * So the test stays a control **in the dialog** rather than a button on the
   * row: a form is the only place the first of those two can happen at all, and
   * one button that picks between them beats asking the same question twice.
   */
  test?: {
    /** "Send test" / "Test connection". The same words in the result sentence. */
    label: string;
    /**
     * The credentials this test sends, and which of them it cannot run without.
     *
     * `ResourceFormModal` reads it, so no spec has to work out for itself
     * whether a box is filled in; what an empty box *means* is the spec's to say,
     * in `blocked` and in `run`.
     *
     * **`required: false` is why this is declared rather than a list of names**
     * ntfy's access
     * token is only for a server with authentication turned on, and a public
     * topic needs none — but named flat alongside the genuine credentials, an
     * absent optional one looked exactly like a missing one, so the button was
     * off on every *add* of a public topic and the topic could not be proved
     * before it was saved. An optional credential nobody typed is an answer, not
     * a gap.
     */
    secrets?: TestSecret[];
    /** Why it cannot run yet, as a sentence. `null` when it can. */
    blocked?: (values: Values, credentials: TestCredentials) => string | null;
    /** Runs it. Resolves with what happened; throws to show the refusal. */
    run: (values: Values, credentials: TestCredentials) => Promise<string>;
    /**
     * Last chance to take a credential out of a refusal before it is rendered.
     *
     * Applied to the sentence `errorMessage()` produced, not to the thrown
     * value, so the refusal keeps the words that make it useful. It exists
     * because **a refusal really can contain the secret**:
     * `POST /destinations/test-connection` rethrows the shell's failure and the
     * shell's failure is an `rclone ls --s3-secret-access-key="…"` command line
     * Found by
     * driving a deliberately wrong secret and reading what came back.
     *
     * It belongs on the spec rather than in `errorMessage()` because the spec is
     * the only thing that knows which of the values it just sent were secrets.
     */
    redact?: (message: string, values: Values) => string;
  };
};

/** The statement each of a list's three writes needs — see `ResourceSpec.permissions`. */
export type ResourcePermissions = {
  create: RequiredPermissions;
  update: RequiredPermissions;
  remove: RequiredPermissions;
};

/**
 * One credential a `test` sends.
 *
 * Every one of these is `encryptedText` at rest and none is ever rendered back,
 * so its box starts empty on an edit and empty means "keep the stored one". What
 * differs, and what this type exists to say, is whether the service works at all
 * without it.
 */
export type TestSecret = {
  /** The box it is typed into — a `FieldSpec.name` on the same spec. */
  name: string;
  /**
   * How a sentence names it, article included: "the webhook URL", "the bot
   * token". These end up in the reason the button is off, and a field name
   * ("botToken") in the middle of a sentence is a leaked variable, not copy.
   */
  label: string;
  /**
   * `false` when the service genuinely works without it — a public ntfy topic
   * takes no access token.
   * A test on an *add* is refused only for a required one.
   */
  required: boolean;
};

/** Which of `test.secrets` are still empty. Worked out by the dialog, read by the spec. */
export type TestCredentials = {
  /** Every declared secret whose box is empty. On an edit, each means "keep the stored one". */
  blank: TestSecret[];
  /** The subset the test cannot run without: blank **and** `required`. */
  needed: TestSecret[];
};
